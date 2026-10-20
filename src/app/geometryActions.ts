/**
 * Crop, straighten, orientation and upright actions. Like every edit they only change the recipe
 * (crop rectangle, angle, quarter turns, flips, geometry sliders), each as one named history step.
 */
import { constrainCrop } from '../geometry/mapping';
import { type GeoImage, aspectValue, computeGeo, cropFrame } from '../geometry/transform';
import { type Segment, detectSegments, solveUpright } from '../geometry/upright';
import { IDENTITY_CROP, type GuideLine, type Recipe, type UprightMode, effectiveRecipe } from '../recipe/schema';
import { useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { getRenderer } from './actions';

const img = () => useImage.getState().image;

/** Aspect as a short label for history ("4:5", "Original", "Freeform"). */
export function aspectLabel(a: string) {
  return a === 'original' ? 'Original' : a === 'free' ? 'Freeform' : a.replace(/^custom:/, '');
}

/** Keep the crop inside the image (always while straightening; for transforms when asked). */
function fit(r: Recipe, crop: Recipe['crop']): Recipe['crop'] {
  const i = img();
  return i ? constrainCrop(i.model, r, crop) : crop;
}

/**
 * A crop rectangle with aspect `a` (width : height in pixels), centred on `around`, as large as the
 * frame allows.
 */
function rectWithAspect(r: Recipe, a: number | null, around = r.crop): Recipe['crop'] {
  const i = img();
  if (!i || a === null) return around;
  const { Wr, Hr } = cropFrame(around, i.width, i.height);
  const cx = around.x + around.w / 2, cy = around.y + around.h / 2;
  // In R pixels: the largest rectangle of aspect a inside the frame, centred where possible.
  let w = Wr, h = Wr / a;
  if (h > Hr) { h = Hr; w = Hr * a; }
  const nw = w / Wr, nh = h / Hr;
  const x = Math.min(1 - nw, Math.max(0, cx - nw / 2)), y = Math.min(1 - nh, Math.max(0, cy - nh / 2));
  return { ...around, x, y, w: nw, h: nh };
}

export function setCropAspect(label: string) {
  const i = img();
  if (!i) return;
  useEdit.getState().apply((r) => {
    const a = aspectValue(label, i.model as GeoImage);
    const crop = { ...rectWithAspect(r, a), aspect: label };
    return { ...r, crop: fit(r, crop) };
  }, `Crop ${aspectLabel(label)}`);
}

/** X: swap the aspect's orientation (4:5 ↔ 5:4). */
export function swapCropAspect() {
  const i = img();
  if (!i) return;
  const r = useEdit.getState().recipe;
  const a = aspectValue(r.crop.aspect, i.model);
  if (a === null || Math.abs(a - 1) < 1e-6) return;
  let label: string;
  if (r.crop.aspect === 'original') label = `custom:${i.height}:${i.width}`;
  else {
    const [p, q] = r.crop.aspect.replace(/^custom:/, '').split(':');
    label = `${r.crop.aspect.startsWith('custom:') ? 'custom:' : ''}${q}:${p}`;
  }
  setCropAspect(label);
}

/** Rotate the frame by a quarter turn (dir = 1 clockwise, −1 counter-clockwise). */
export function rotate90(dir: 1 | -1) {
  useEdit.getState().apply((r) => {
    const c = r.crop;
    // The crop rectangle turns with the frame.
    const rect = dir === 1 ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
    return { ...r, crop: { ...c, ...rect, rotate90: (((c.rotate90 + dir) % 4) + 4) % 4 as 0 | 1 | 2 | 3 } };
  }, dir === 1 ? 'Rotate 90° right' : 'Rotate 90° left');
}

export function flip(axis: 'h' | 'v') {
  useEdit.getState().apply((r) => {
    const c = r.crop;
    return { ...r, crop: axis === 'h' ? { ...c, flipH: !c.flipH, x: 1 - (c.x + c.w) } : { ...c, flipV: !c.flipV, y: 1 - (c.y + c.h) } };
  }, axis === 'h' ? 'Flip horizontal' : 'Flip vertical');
}

/** Straighten angle (live while dragging; `commit` on release). The crop stays inside the image. */
export function setStraighten(angle: number, commit = false) {
  const a = Math.max(-45, Math.min(45, Math.round(angle * 100) / 100));
  useEdit.getState().update((r) => {
    const next = { ...r, crop: { ...r.crop, angle: a } };
    return { ...next, crop: fit(next, next.crop) };
  });
  if (commit) useEdit.getState().commit(`Straighten ${a > 0 ? '+' : ''}${a.toFixed(2)}°`);
}

export function resetCrop() {
  useEdit.getState().apply((r) => ({ ...r, crop: { ...IDENTITY_CROP } }), 'Reset crop');
}

/** After a transform change: shrink the crop to the image when "Constrain crop" is on. */
export function constrainIfAsked(r: Recipe): Recipe {
  return r.geometry.constrainCrop ? { ...r, crop: fit(r, r.crop) } : r;
}

/** Output size of the current crop: "6048 × 6048 · 36.6 MP". */
export function cropSizeLabel(r: Recipe): string {
  const i = img();
  if (!i) return '';
  const g = computeGeo(i.model, r);
  return `${g.outW} × ${g.outH} · ${((g.outW * g.outH) / 1e6).toFixed(1)} MP`;
}

// ---------------------------------------------------------------------------
// Upright
// ---------------------------------------------------------------------------

let segCache: { key: string; segs: Segment[]; scale: number } | null = null;

/** Lines of the lens-corrected (but untransformed) image, in undistorted source pixels. */
function detectedLines(): Segment[] | null {
  const i = img(), renderer = getRenderer();
  if (!i || !renderer) return null;
  const r = useEdit.getState().recipe;
  const plain = effectiveRecipe({ ...r, geometry: { ...r.geometry, vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 }, crop: { ...IDENTITY_CROP } }, i.asShot);
  const key = `${i.id}|${JSON.stringify(plain.lens)}`;
  if (segCache?.key === key) return segCache.segs;
  const t0 = performance.now();
  const e = renderer.edgeMap(plain, 1024);
  if (!e) return null;
  const k = i.width / e.width;
  const segs = detectSegments(e.data, e.width, e.height).map((s) => ({ a: [s.a[0] * k, s.a[1] * k] as [number, number], b: [s.b[0] * k, s.b[1] * k] as [number, number], w: s.w }));
  console.info(`[optic] upright: ${segs.length} line segments (${Math.round(performance.now() - t0)} ms)`);
  segCache = { key, segs, scale: k };
  return segs;
}

const MODE_LABEL: Record<UprightMode, string> = { off: 'Off', auto: 'Auto', level: 'Level', vertical: 'Vertical', full: 'Full', guided: 'Guided' };

export function applyUpright(mode: UprightMode) {
  const i = img();
  if (!i) return;
  if (mode === 'off') {
    useEdit.getState().apply((r) => constrainIfAsked({ ...r, geometry: { ...r.geometry, upright: 'off', guides: [], rotate: 0, vertical: 0, horizontal: 0 } }), 'Upright off');
    return;
  }
  if (mode === 'guided') {
    useEdit.getState().apply((r) => ({ ...r, geometry: { ...r.geometry, upright: 'guided' } }), 'Guided upright');
    return;
  }
  const segs = detectedLines();
  if (!segs) return;
  useEdit.getState().apply((r) => {
    const p = solveUpright(mode, segs, i.model, r.geometry);
    return constrainIfAsked({ ...r, geometry: { ...r.geometry, upright: mode, guides: [], ...p } });
  }, `Upright: ${MODE_LABEL[mode]}`);
}

/** Add a guided-upright line (undistorted source coordinates, normalised) and re-solve. */
export function addGuide(line: GuideLine) {
  const i = img();
  if (!i) return;
  useEdit.getState().apply((r) => {
    const guides = [...r.geometry.guides, line].slice(-4);
    const segs = guides.map((g) => ({ a: [g.x1 * i.width, g.y1 * i.height] as [number, number], b: [g.x2 * i.width, g.y2 * i.height] as [number, number], w: 10 }));
    const p = guides.length >= 1 ? solveUpright('guided', segs, i.model, r.geometry) : {};
    return constrainIfAsked({ ...r, geometry: { ...r.geometry, upright: 'guided', guides, ...p } });
  }, 'Guided upright line');
}

export function clearGuides() {
  useEdit.getState().apply((r) => ({ ...r, geometry: { ...r.geometry, guides: [], rotate: 0, vertical: 0, horizontal: 0 } }), 'Clear guides');
}
