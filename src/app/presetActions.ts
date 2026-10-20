/**
 * Preset, LUT, point-colour and copy/paste actions. Like every edit, they only change the recipe.
 */
import { workingToOklab } from '../color/oklab';
import type { OutputTarget } from '../pipeline/types';
import { applyPreset, removePreset, setPresetAmount } from '../presets/apply';
import type { Preset } from '../presets/types';
import {
  HSL_BANDS,
  MAX_COLOR_POINTS,
  effectiveRecipe,
  getGroup,
  setGroup,
  type ColorPoint,
  type PresetGroup,
  type Recipe,
} from '../recipe/schema';
import { useEdit } from '../state/editStore';
import { defaultRecipeFor, useImage } from '../state/imageStore';
import { usePresets } from '../state/presetStore';
import { useUi } from '../state/uiStore';
import { getRenderer } from './actions';

const isRaw = () => !!useImage.getState().image?.isRaw;

export function presetPreviewRecipe(p: Preset, amount = 100): Recipe {
  return applyPreset(useEdit.getState().recipe, p, isRaw(), amount);
}

/** Show a preset on the canvas without committing it (hover / arrow-key browsing). */
export function previewPreset(p: Preset | null) {
  useUi.getState().set({ previewRecipe: p ? presetPreviewRecipe(p) : null });
}

export function applyPresetToEdit(p: Preset, amount = 100) {
  useUi.getState().set({ previewRecipe: null });
  useEdit.getState().apply((r) => applyPreset(r, p, isRaw(), amount), `Preset: ${p.name} (${Math.round(amount)}%)`);
  usePresets.getState().pushRecent(p.id);
}

/** Live amount change (slider drag); the slider commits on release. */
export function setAmountLive(amount: number) {
  useEdit.getState().update((r) => setPresetAmount(r, amount));
}

/** Commit an amount change as "Preset: Name (80%)" (rapid changes collapse into one step). */
export function commitAmount() {
  const a = useEdit.getState().recipe.appliedPreset;
  useEdit.getState().commit(a ? `Preset: ${a.name} (${Math.round(a.amount)}%)` : undefined, 'preset-amount');
}

export function resetToPreset() {
  useEdit.getState().apply((r) => (r.appliedPreset ? setPresetAmount(r, r.appliedPreset.amount) : r), 'Reset to preset');
}

export function removeAppliedPreset() {
  useEdit.getState().apply(removePreset, 'Remove preset');
}

// ---------------------------------------------------------------------------
// User presets from the current edit
// ---------------------------------------------------------------------------

export function presetFromRecipe(
  r: Recipe,
  opts: { name: string; group: string; groups: PresetGroup[]; nonRawVariant: boolean; description?: string },
): Preset {
  let settings: Record<string, unknown> = {};
  for (const g of opts.groups) settings = { ...settings, ...structuredClone(getGroup(r, g)) };
  // Never bake the "enabled" eye toggles into a preset.
  for (const v of Object.values(settings)) if (v && typeof v === 'object' && 'enabled' in v) (v as { enabled?: boolean }).enabled = true;
  return {
    id: `user-${crypto.randomUUID().slice(0, 8)}`,
    name: opts.name,
    group: opts.group || 'My Presets',
    version: 3,
    description: opts.description,
    tags: [],
    includes: opts.groups,
    settings,
    // A separate non-RAW variant stores the same values explicitly, so no automatic scaling.
    nonRaw: opts.nonRawVariant ? structuredClone(settings) : undefined,
    lut: opts.groups.includes('lut') && r.lut.id ? r.lut.id : undefined,
  };
}

// ---------------------------------------------------------------------------
// Copy / paste settings and reset
// ---------------------------------------------------------------------------

export function copySettings(groups: PresetGroup[]) {
  const recipe = structuredClone(useEdit.getState().recipe);
  useUi.getState().set({ clipboard: { groups, recipe } });
  try {
    void navigator.clipboard?.writeText(JSON.stringify({ optic: 'settings', groups, recipe }));
  } catch { /* clipboard permission denied: the in-app clipboard still works */ }
}

export function pasteSettings(groups: PresetGroup[]) {
  const clip = useUi.getState().clipboard;
  if (!clip) return;
  useEdit.getState().apply((r) => {
    let out = r;
    for (const g of groups) if (clip.groups.includes(g)) out = setGroup(out, g, getGroup(clip.recipe, g));
    return out;
  }, 'Paste settings');
}

export function resetAll() {
  const img = useImage.getState().image;
  useEdit.getState().apply((r) => ({ ...defaultRecipeFor(img), output: r.output }), 'Reset all');
}

// ---------------------------------------------------------------------------
// Point colour
// ---------------------------------------------------------------------------

const LINEAR: OutputTarget = { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false };

let nextPointIsSkin = false;
/** The next point-colour pick configures a skin-uniformity point (narrow hue, wide lightness). */
export function armSkinPick() {
  nextPointIsSkin = true;
  useUi.getState().set({ tool: 'pointColor' });
}

/** Sample the image just before the point-colour stage and add a point targeting that colour. */
export function addColorPointAt(x: number, y: number) {
  const img = useImage.getState().image;
  const renderer = getRenderer();
  if (!img || !renderer) return;
  const recipe = effectiveRecipe(useEdit.getState().recipe, img.asShot);
  // Average a 3×3 neighbourhood for a stable target.
  let acc = [0, 0, 0];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const v = renderer.readPixel(recipe, x + dx * 2, y + dy * 2, LINEAR, 'hsl');
    if (v) acc = [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]];
  }
  const [L, a, b] = workingToOklab([acc[0] / 9, acc[1] / 9, acc[2] / 9]);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  const point: ColorPoint = {
    target: { L: +L.toFixed(4), C: +Math.hypot(a, b).toFixed(4), h: +h.toFixed(2) },
    hue: 0, sat: 0, lum: 0, hueRange: 40, satRange: 50, lumRange: 60, smoothness: 50, uniformity: 0,
    ...(nextPointIsSkin ? { hueRange: 22, satRange: 55, lumRange: 75, smoothness: 70, uniformity: 40 } : {}),
  };
  nextPointIsSkin = false;
  useEdit.getState().apply((r) =>
    r.pointColor.points.length >= MAX_COLOR_POINTS
      ? r
      : { ...r, pointColor: { enabled: true, points: [...r.pointColor.points, point] } },
    'Add color point',
  );
}

// ---------------------------------------------------------------------------
// B&W auto mix
// ---------------------------------------------------------------------------

/**
 * Auto mix: keep colours apart in grey. Converted naively, a red jumper and a green lawn of similar
 * luminance merge into one grey. For each colour band with enough coverage we look at the band's
 * mean grey (luminance) against the image's mean grey and push it further away from it, in
 * proportion to the band's mean chroma (strongly coloured areas get the most separation).
 * Results stay within ±40, and bands with little coverage are left at 0.
 */
export function autoBwMix() {
  const img = useImage.getState().image;
  const renderer = getRenderer();
  if (!img || !renderer) return;
  const base = { ...effectiveRecipe(useEdit.getState().recipe, img.asShot), treatment: 'color' as const };
  const res = renderer.renderSmall(base, LINEAR, 192, 'curve');
  if (!res) return;
  const sums = HSL_BANDS.map(() => ({ logY: 0, C: 0, n: 0 }));
  const centers = [29, 60, 105, 142, 195, 262, 295, 330];
  let allLogY = 0, all = 0;
  for (let i = 0; i < res.data.length; i += 4) {
    const rgb: [number, number, number] = [res.data[i], res.data[i + 1], res.data[i + 2]];
    const Y = Math.max(1e-4, 0.2627 * rgb[0] + 0.678 * rgb[1] + 0.0593 * rgb[2]);
    allLogY += Math.log2(Y);
    all++;
    const [, a, b] = workingToOklab(rgb);
    const C = Math.hypot(a, b);
    if (C < 0.035) continue;
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    let best = 0, bd = 999;
    centers.forEach((c, k) => { const d = Math.min(Math.abs(h - c), 360 - Math.abs(h - c)); if (d < bd) { bd = d; best = k; } });
    sums[best].logY += Math.log2(Y);
    sums[best].C += C;
    sums[best].n++;
  }
  const meanLog = allLogY / Math.max(1, all);
  useEdit.getState().apply((r) => {
    const mix = { ...r.bwMixer };
    HSL_BANDS.forEach((band, k) => {
      const s = sums[k];
      if (s.n < all * 0.01) { mix[band] = 0; return; }
      const dir = s.logY / s.n - meanLog; // EV above / below the image's mean grey
      const strength = Math.min(1, (s.C / s.n) / 0.12);
      mix[band] = Math.round(Math.max(-40, Math.min(40, Math.sign(dir) * Math.min(1, Math.abs(dir)) * strength * 40)));
    });
    return { ...r, treatment: 'monochrome', bwMixer: mix };
  }, 'Auto B&W mix');
}

