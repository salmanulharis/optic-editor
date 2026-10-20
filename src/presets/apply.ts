/**
 * Applying presets to a recipe.
 *
 * A preset owns only the groups in its `includes`. Applying it records the user's values for those
 * groups (`base`) and the preset's values (`target`) in `recipe.appliedPreset`, and writes
 * interpolate(base, target, amount) into the recipe. Everything else in the recipe is untouched.
 *
 * Interpolation rules (amount 0…200 %; 0 % is exactly the base, 100 % exactly the target, above
 * 100 % extrapolates and the schema parser clamps every value to its range):
 *  - numbers: linear;
 *  - curves: both resampled to 32 points with the same monotone cubic the renderer uses, then
 *    point-wise linear;
 *  - colour wheels: in (sat·cos h, sat·sin h) vector space, so hues never spin the long way;
 *  - point colours: matched by index (a missing base point = the same target with no shifts);
 *  - LUT: the preset's LUT, with amount interpolated from 0 when the base had none;
 *  - treatment: a monochrome preset at < 100 % keeps the treatment and blends via bwMixer.mix.
 *
 * Non-RAW photos already carry a camera look, so the preset's saturation / contrast / calibration
 * changes are scaled by NON_RAW_SCALE (relative to neutral defaults) before the optional explicit
 * `nonRaw` overrides are applied.
 */
import { monotoneCubic } from '../recipe/curve';
import {
  HSL_BANDS,
  IDENTITY_MATRIX,
  defaultRecipe,
  getGroup,
  setGroup,
  type AppliedPreset,
  type ColorPoint,
  type Point,
  type PresetGroup,
  type Recipe,
  type Wheel,
} from '../recipe/schema';
import { parseGroups } from '../recipe/serialize';
import type { Preset } from './types';

export const NON_RAW_SCALE = 0.75;

type J = Record<string, unknown>;

/** The preset's own values for its groups, on this kind of image. */
export function presetTarget(preset: Preset, base: Recipe, isRaw: boolean): Recipe {
  // Groups are parsed onto defaults: a preset fully defines each group it includes.
  let t = parseGroups(preset.settings as J, defaultRecipe());
  if (!isRaw) {
    t = scaleForNonRaw(t, preset.includes);
    if (preset.nonRaw) t = parseGroups(preset.nonRaw as J, t);
  }
  if (preset.includes.includes('lut') || preset.lut) {
    const s = (preset.settings.lut ?? {}) as J;
    t.lut = {
      enabled: true,
      id: preset.lut ?? (typeof s.id === 'string' ? s.id : null),
      inputSpace: t.lut.inputSpace,
      amount: typeof s.amount === 'number' ? s.amount : 100,
    };
  }
  let out = base;
  for (const g of groupsOf(preset)) out = setGroup(out, g, getGroup(t, g));
  return out;
}

export function groupsOf(p: Preset): PresetGroup[] {
  const g = [...p.includes];
  if (p.lut && !g.includes('lut')) g.push('lut');
  return g;
}

function scaleForNonRaw(r: Recipe, groups: PresetGroup[]): Recipe {
  const k = NON_RAW_SCALE;
  const out = structuredClone(r);
  if (groups.includes('calibration')) {
    for (const p of ['red', 'green', 'blue'] as const) {
      out.calibration[p].hue *= k;
      out.calibration[p].sat *= k;
    }
    out.calibration.shadowTint *= k;
    if (out.calibration.matrix) out.calibration.matrix = out.calibration.matrix.map((v, i) => IDENTITY_MATRIX[i] + (v - IDENTITY_MATRIX[i]) * k);
  }
  if (groups.includes('presence')) {
    out.presence.vibrance *= k;
    out.presence.saturation *= k;
  }
  if (groups.includes('hsl')) for (const b of HSL_BANDS) out.hsl.bands[b].sat *= k;
  if (groups.includes('light')) out.light.contrast *= k;
  if (groups.includes('curve')) {
    for (const c of ['rgb', 'r', 'g', 'b'] as const) out.curve[c] = out.curve[c].map((p) => ({ x: p.x, y: p.x + (p.y - p.x) * k }));
  }
  if (groups.includes('colorGrading')) {
    for (const w of ['shadows', 'midtones', 'highlights', 'global'] as const) out.colorGrading[w].sat *= k;
  }
  if (groups.includes('look')) out.look.colorDensity *= k;
  return out;
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function resample(pts: Point[], n = 32): Point[] {
  const f = monotoneCubic(pts);
  return Array.from({ length: n }, (_, i) => ({ x: i / (n - 1), y: f(i / (n - 1)) }));
}

function lerpCurve(a: Point[], b: Point[], t: number): Point[] {
  const ra = resample(a), rb = resample(b);
  return ra.map((p, i) => ({ x: p.x, y: lerp(p.y, rb[i].y, t) }));
}

function lerpWheel(a: Wheel, b: Wheel, t: number): Wheel {
  const ah = (a.hue * Math.PI) / 180, bh = (b.hue * Math.PI) / 180;
  const x = lerp(a.sat * Math.cos(ah), b.sat * Math.cos(bh), t);
  const y = lerp(a.sat * Math.sin(ah), b.sat * Math.sin(bh), t);
  const sat = Math.hypot(x, y);
  let hue = sat > 1e-6 ? (Math.atan2(y, x) * 180) / Math.PI : b.sat > 0 ? b.hue : a.hue;
  if (hue < 0) hue += 360;
  return { hue, sat, lum: lerp(a.lum, b.lum, t) };
}

function isWheel(v: unknown): v is Wheel {
  return !!v && typeof v === 'object' && 'hue' in v && 'sat' in v && 'lum' in v && Object.keys(v).length === 3;
}

/** Generic structural interpolation of two values of the same recipe shape. */
function lerpAny(a: unknown, b: unknown, t: number, key = ''): unknown {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (key === 'matrix') {
    const ma = (a as number[] | null) ?? IDENTITY_MATRIX, mb = (b as number[] | null) ?? IDENTITY_MATRIX;
    return ma.map((v, i) => lerp(v, mb[i], t));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (key === 'rgb' || key === 'r' || key === 'g' || key === 'b') return lerpCurve(a as Point[], b as Point[], t);
    return b; // other arrays are handled by their parent
  }
  if (isWheel(a) && isWheel(b)) return lerpWheel(a, b, t);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: J = {};
    for (const k of Object.keys(b as J)) out[k] = lerpAny((a as J)[k], (b as J)[k], t, k);
    return out;
  }
  return t > 0 ? b : a;
}

function lerpPoints(a: ColorPoint[], b: ColorPoint[], t: number): ColorPoint[] {
  const n = Math.max(a.length, b.length);
  const zero = (p: ColorPoint): ColorPoint => ({ ...p, hue: 0, sat: 0, lum: 0, uniformity: 0 });
  const out: ColorPoint[] = [];
  for (let i = 0; i < n; i++) {
    const pa = a[i] ?? zero(b[i]);
    const pb = b[i] ?? zero(a[i]);
    out.push(lerpAny(pa, { ...pb, target: t > 0.5 ? pb.target : pa.target }, t) as ColorPoint);
  }
  return out;
}

/** Interpolate the preset's groups between `base` and `target` (both full recipes) by t. */
export function interpolate(recipe: Recipe, base: Partial<Recipe>, target: Partial<Recipe>, groups: PresetGroup[], amount: number): Recipe {
  const t = amount / 100;
  let out = recipe;
  const b = setGroupsOnto(defaultRecipe(), base, groups);
  const g = setGroupsOnto(defaultRecipe(), target, groups);
  for (const grp of groups) {
    if (t === 0) { out = setGroup(out, grp, getGroup(b, grp)); continue; }
    if (t === 1) { out = setGroup(out, grp, getGroup(g, grp)); continue; }
    let mixed: Partial<Recipe>;
    if (grp === 'pointColor') {
      mixed = { pointColor: { enabled: g.pointColor.enabled, points: lerpPoints(b.pointColor.points, g.pointColor.points, t) } };
    } else if (grp === 'bw') {
      const monoTarget = g.treatment === 'monochrome', monoBase = b.treatment === 'monochrome';
      const baseMix = monoBase ? b.bwMixer.mix : 0, tgtMix = monoTarget ? g.bwMixer.mix : 0;
      const bands = lerpAny(b.bwMixer, g.bwMixer, t) as Recipe['bwMixer'];
      const mix = lerp(baseMix, tgtMix, t);
      mixed = { treatment: monoTarget || monoBase ? 'monochrome' : 'color', bwMixer: { ...bands, mix } };
    } else if (grp === 'lut') {
      const baseAmt = b.lut.id ? b.lut.amount : 0;
      const sameLut = b.lut.id === g.lut.id || !b.lut.id;
      mixed = {
        lut: sameLut
          ? { ...g.lut, amount: lerp(baseAmt, g.lut.amount, t) }
          : t < 0.5 ? { ...b.lut, amount: lerp(b.lut.amount, 0, t * 2) } : { ...g.lut, amount: lerp(0, g.lut.amount, (t - 0.5) * 2) },
      };
    } else {
      mixed = lerpAny(getGroup(b, grp), getGroup(g, grp), t) as Partial<Recipe>;
    }
    // Round-trip through the parser: clamps extrapolated values (>100 %) to valid ranges.
    out = setGroup(out, grp, getGroup(parseGroups(mixed as J, out), grp));
  }
  return out;
}

function setGroupsOnto(r: Recipe, src: Partial<Recipe>, groups: PresetGroup[]): Recipe {
  let out = r;
  for (const g of groups) out = setGroup(out, g, src);
  return out;
}

function pickGroups(r: Recipe, groups: PresetGroup[]): Partial<Recipe> {
  let out: Partial<Recipe> = {};
  for (const g of groups) out = { ...out, ...structuredClone(getGroup(r, g)) };
  return out;
}

/**
 * Apply a preset. Applying a preset while another is applied first restores the previous preset's
 * base (presets replace, they don't stack). Returns the new recipe.
 */
export function applyPreset(recipe: Recipe, preset: Preset, isRaw: boolean, amount = 100): Recipe {
  const start = recipe.appliedPreset ? removePreset(recipe) : recipe;
  const groups = groupsOf(preset);
  const base = pickGroups(start, groups);
  const target = pickGroups(presetTarget(preset, start, isRaw), groups);
  const applied: AppliedPreset = { id: preset.id, name: preset.name, amount, groups, base, target };
  return { ...interpolate(start, base, target, groups, amount), appliedPreset: applied };
}

export function setPresetAmount(recipe: Recipe, amount: number): Recipe {
  const a = recipe.appliedPreset;
  if (!a) return recipe;
  return { ...interpolate(recipe, a.base, a.target, a.groups, amount), appliedPreset: { ...a, amount } };
}

export function removePreset(recipe: Recipe): Recipe {
  const a = recipe.appliedPreset;
  if (!a) return recipe;
  return { ...interpolate(recipe, a.base, a.target, a.groups, 0), appliedPreset: null };
}

/** True when the preset's groups were edited by hand after applying. */
export function presetEdited(recipe: Recipe): boolean {
  const a = recipe.appliedPreset;
  if (!a) return false;
  const expected = interpolate(recipe, a.base, a.target, a.groups, a.amount);
  return a.groups.some((g) => JSON.stringify(getGroup(expected, g)) !== JSON.stringify(getGroup(recipe, g)));
}
