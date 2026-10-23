/**
 * Editing actions that need pixels: auto tools and droppers. All of them only write values into
 * the recipe (so the sliders move visibly and the result is undoable).
 */
import { estimateCast, estimateNeutral, autoTone as autoToneCalc } from '../color/autoTools';
import type { Vec3 } from '../color/matrices';
import { outputToSource } from '../geometry/mapping';
import { displayNeutralToRelative, neutralToTempTint } from '../color/whiteBalance';
import type { OutputTarget } from '../pipeline/types';
import { type Recipe, defaultRecipe, effectiveRecipe } from '../recipe/schema';
import { useEdit } from '../state/editStore';
import { type LoadedImage, useImage } from '../state/imageStore';
import type { ViewRenderer } from '../ui/canvas/viewRenderer';

let renderer: ViewRenderer | null = null;
export const setRenderer = (r: ViewRenderer | null) => { renderer = r; };
export const getRenderer = () => renderer;

const LINEAR: OutputTarget = { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false };

function current(): { img: LoadedImage; recipe: Recipe } | null {
  const img = useImage.getState().image;
  if (!img) return null;
  return { img, recipe: effectiveRecipe(useEdit.getState().recipe, img.asShot) };
}

/** Temperature/tint (recipe units) that make the given source-space colour neutral. */
export function wbForNeutral(img: Pick<LoadedImage, 'color'>, rgb: Vec3) {
  if (img.color.kind === 'raw') {
    const tt = neutralToTempTint(img.color.profile, rgb);
    return { temperature: Math.round(Math.min(50000, Math.max(2000, tt.temperature))), tint: Math.round(Math.min(150, Math.max(-150, tt.tint))) };
  }
  const rel = displayNeutralToRelative(img.color.toXYZ, rgb);
  return { temperature: Math.round(rel.temperature), tint: Math.round(rel.tint) };
}

export function autoWhiteBalance() {
  const c = current();
  if (!c) return;
  const start: Vec3 = c.img.color.kind === 'raw' ? c.img.color.profile.asShotNeutral : [1, 1, 1];
  const n = estimateNeutral(c.img.thumb.data, start);
  const wb = wbForNeutral(c.img, n);
  useEdit.getState().apply((r) => ({ ...r, whiteBalance: { ...r.whiteBalance, enabled: true, mode: 'auto', ...wb } }), 'Auto white balance');
}

/**
 * Eyedropper: average a 5×5 full-resolution patch (pre-white-balance) and neutralise it.
 * (x, y) is an output pixel; the patch is read at the source pixel it comes from.
 */
export function whiteBalanceFromPixel(ox: number, oy: number) {
  const c = current();
  if (!c) return;
  const { full } = c.img;
  const [x, y] = outputToSource(c.img.model, c.recipe, ox, oy);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = Math.min(full.width - 1, Math.max(0, Math.floor(x) + dx));
      const py = Math.min(full.height - 1, Math.max(0, Math.floor(y) + dy));
      const i = (py * full.width + px) * 3;
      r += full.data[i]; g += full.data[i + 1]; b += full.data[i + 2]; n++;
    }
  }
  if (Math.max(r, g, b) / n < 1e-4) return;
  const wb = wbForNeutral(c.img, [r / n, g / n, b / n]);
  useEdit.getState().apply((rc) => ({ ...rc, whiteBalance: { ...rc.whiteBalance, enabled: true, mode: 'custom', ...wb } }), 'White balance picker');
}

export function autoTone() {
  const c = current();
  if (!c || !renderer) return;
  const base = { ...c.recipe, light: { ...defaultRecipe().light, deband: c.recipe.light.deband, deblock: c.recipe.light.deblock } };
  const res = renderer.renderSmall(base, LINEAR, 256, 'cast');
  if (!res) return;
  const t = autoToneCalc(res.data, c.img.isRaw);
  useEdit.getState().apply((r) => ({ ...r, light: { ...r.light, enabled: true, ...t } }), 'Auto tone');
}

/** Estimate the colour cast (stored in the recipe) from the white-balanced image. */
export function estimateColorCast() {
  const c = current();
  if (!c || !renderer) return null;
  const res = renderer.renderSmall(c.recipe, LINEAR, 256, 'cw');
  return res ? estimateCast(res.data) : null;
}

/**
 * Black / white point droppers: read the clicked pixel just before the curve stage and move the
 * RGB curve's end point there (visible in the curve editor).
 */
export function pointFromPixel(kind: 'blackPoint' | 'whitePoint', x: number, y: number) {
  const c = current();
  if (!c || !renderer) return;
  const v = renderer.readPixel(c.recipe, x, y, LINEAR, 'hsl');
  if (!v) return;
  const enc = (t: number) => Math.pow(Math.max(0, t), 1 / 2.2);
  useEdit.getState().apply((r) => {
    const pts = r.curve.rgb.map((p) => ({ ...p }));
    const first = pts[0], last = pts[pts.length - 1];
    if (kind === 'whitePoint') {
      last.x = Math.min(1, Math.max(first.x + 0.05, enc(Math.max(v[0], v[1], v[2]))));
      last.y = 1;
    } else {
      first.x = Math.max(0, Math.min(last.x - 0.05, enc(Math.min(v[0], v[1], v[2]))));
      first.y = 0;
    }
    const inner = pts.slice(1, -1).filter((p) => p.x > first.x && p.x < last.x);
    return { ...r, curve: { ...r.curve, enabled: true, rgb: [first, ...inner, last] } };
  }, kind === 'whitePoint' ? 'White point' : 'Black point');
}
