/**
 * Geometry: the single coordinate transform from an output pixel to a source pixel.
 *
 * Spaces (all in pixels):
 *   S  source       the decoded, upright image (W × H).
 *   U  undistorted  S with the lens distortion removed (same size). U → S is the lens model
 *                   (geometry/lens.ts), evaluated per pixel on the GPU.
 *   T  transformed  U after the geometry homography: perspective (vertical / horizontal), rotate,
 *                   aspect, scale and offset, all about the image centre.
 *   R  crop frame   T straightened by the crop angle (about its centre), turned by rotate90 and
 *                   flipped. W × H, or H × W after an odd number of quarter turns.
 *   O  output       the crop rectangle of R. One output pixel is one R pixel, so a crop of a 48 MP
 *                   image exports at its exact pixel count, never resampled in scale.
 *
 * O → U is one projective 3×3 matrix (`oToU`); together with the lens model the GPU samples the
 * source exactly once per output pixel, whatever combination of crop, straighten, upright and lens
 * correction is active.
 */
import { type Mat3, IDENTITY, inv, mul } from '../color/matrices';
import type { Recipe } from '../recipe/schema';

export interface GeoImage {
  width: number;
  height: number;
  /** 35 mm-equivalent focal length, for the perspective model (default 28 mm). */
  focal35?: number;
}

export interface Geo {
  W: number;
  H: number;
  /** Crop-frame (R) size. */
  Wr: number;
  Hr: number;
  /** Output (O) size in pixels. */
  outW: number;
  outH: number;
  oToU: Mat3;
  uToO: Mat3;
  /** U → T (geometry homography) and T → R (straighten, quarter turns, flips). */
  uToT: Mat3;
  tToR: Mat3;
  /** True when O is exactly S (no crop, no geometry): the shader can skip the transform. */
  identity: boolean;
}

export type Vec2 = [number, number];

/** Apply a projective 3×3 (row-major) to a point. */
export function project(m: Mat3, x: number, y: number): Vec2 {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const scale2 = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];
/** Clockwise on screen (image y points down) for positive angles. */
const rot = (deg: number): Mat3 => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

/** Perspective / rotation ranges of the geometry sliders. */
export const PITCH_RANGE_DEG = 30;
export const YAW_RANGE_DEG = 30;

/** Focal length in pixels for the perspective model (35 mm equivalent: 36 mm = long edge). */
export function focalPx(img: GeoImage): number {
  const f35 = img.focal35 && img.focal35 > 4 ? img.focal35 : 28;
  return (f35 / 36) * Math.max(img.width, img.height);
}

/**
 * U → T. Perspective is a camera rotation about the optical centre (pitch for Vertical, yaw for
 * Horizontal, roll for Rotate) through K·R·K⁻¹, re-centred and re-scaled so the image centre stays
 * put at unit magnification; then aspect, scale and offset.
 * Sign conventions follow Lightroom: Vertical < 0 widens the top (a building shot from below),
 * Rotate > 0 turns the image clockwise, Offset Y > 0 moves the image up.
 */
export function geometryHomography(g: Recipe['geometry'], img: GeoImage): Mat3 {
  const { width: W, height: H } = img;
  const identity = !g.vertical && !g.horizontal && !g.rotate && !g.aspect && g.scale === 100 && !g.offsetX && !g.offsetY;
  if (identity) return IDENTITY;
  const f = focalPx(img);
  const pitch = ((-g.vertical / 100) * PITCH_RANGE_DEG * Math.PI) / 180;
  const yaw = ((g.horizontal / 100) * YAW_RANGE_DEG * Math.PI) / 180;
  const cx = Math.cos(pitch), sx = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const Rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const K: Mat3 = [f, 0, 0, 0, f, 0, 0, 0, 1];
  const Ki: Mat3 = [1 / f, 0, 0, 0, 1 / f, 0, 0, 0, 1];
  // Perspective in centred coordinates, then roll as a plain 2-D rotation.
  let P = mul(K, mul(mul(Rx, Ry), Ki));
  // Re-centre: the centre must map to the centre.
  const c0 = project(P, 0, 0);
  P = mul(translate(-c0[0], -c0[1]), P);
  // Unit magnification at the centre (geometric mean of the local scales).
  const e = 1;
  const px = project(P, e, 0), py = project(P, 0, e);
  const jac = Math.abs(px[0] * py[1] - px[1] * py[0]) / (e * e);
  const m = 1 / Math.sqrt(Math.max(jac, 1e-9));
  P = mul(scale2(m, m), P);
  P = mul(rot(g.rotate), P);
  const a = Math.pow(2, (g.aspect / 100) * 0.5);
  const s = g.scale / 100;
  P = mul(scale2(s * Math.sqrt(a), s / Math.sqrt(a)), P);
  const off = translate((g.offsetX / 100) * (W / 2), (-g.offsetY / 100) * (H / 2));
  return mul(mul(translate(W / 2, H / 2), mul(off, P)), translate(-W / 2, -H / 2));
}

/** T → R: straighten about the centre, quarter turns (clockwise), then flips. */
export function cropFrame(c: Recipe['crop'], W: number, H: number): { tToR: Mat3; Wr: number; Hr: number } {
  const odd = (c.rotate90 & 1) === 1;
  const Wr = odd ? H : W, Hr = odd ? W : H;
  // Straighten and quarter turns, both about the centre, landing in the Wr × Hr frame.
  let m = mul(translate(Wr / 2, Hr / 2), mul(rot(90 * c.rotate90 + c.angle), translate(-W / 2, -H / 2)));
  if (c.flipH) m = mul([-1, 0, Wr, 0, 1, 0, 0, 0, 1], m);
  if (c.flipV) m = mul([1, 0, 0, 0, -1, Hr, 0, 0, 1], m);
  return { tToR: m, Wr, Hr };
}

/** Output size of a crop rectangle in R pixels. */
export function cropPixels(c: Pick<Recipe['crop'], 'w' | 'h'>, Wr: number, Hr: number) {
  return { outW: Math.max(1, Math.round(c.w * Wr)), outH: Math.max(1, Math.round(c.h * Hr)) };
}

const isIdentityCrop = (c: Recipe['crop']) =>
  c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1 && !c.angle && !c.flipH && !c.flipV && !c.rotate90;

let memo: { img: GeoImage; key: string; geo: Geo } | null = null;

/** The full output geometry for (image, recipe). Memoised on the inputs. */
export function computeGeo(img: GeoImage, r: Pick<Recipe, 'geometry' | 'crop'>): Geo {
  const key = JSON.stringify([img.width, img.height, img.focal35, r.geometry, r.crop]);
  if (memo && memo.img === img && memo.key === key) return memo.geo;
  const { width: W, height: H } = img;
  const uToT = geometryHomography(r.geometry, img);
  const { tToR, Wr, Hr } = cropFrame(r.crop, W, H);
  const { outW, outH } = cropPixels(r.crop, Wr, Hr);
  const oToR = translate(r.crop.x * Wr, r.crop.y * Hr);
  const uToO = mul(inv(oToR), mul(tToR, uToT));
  const identity = uToT === IDENTITY && isIdentityCrop(r.crop);
  const geo: Geo = {
    W, H, Wr, Hr, outW, outH,
    oToU: identity ? IDENTITY : inv(uToO),
    uToO: identity ? IDENTITY : uToO,
    uToT,
    tToR,
    identity,
  };
  memo = { img, key, geo };
  return geo;
}

/** Bounding box of a set of points. */
export function bbox(pts: Vec2[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `n` samples along each edge of a rectangle (corners included). */
export function rectSamples(x: number, y: number, w: number, h: number, n = 8): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([x + w * t, y], [x + w * t, y + h], [x, y + h * t], [x + w, y + h * t]);
  }
  return out;
}

/**
 * The crop rectangle (R-normalised) that shows the whole straightened frame while the crop tool is
 * open: the bounding box of the transformed image content, so rotated corners stay visible.
 */
export function cropToolFrame(img: GeoImage, r: Pick<Recipe, 'geometry' | 'crop'>): Recipe['crop'] {
  const full = { ...r.crop, x: 0, y: 0, w: 1, h: 1 };
  const g = computeGeo(img, { geometry: r.geometry, crop: full });
  const m = mul(g.tToR, g.uToT);
  const content = rectSamples(0, 0, img.width, img.height, 4).map(([x, y]) => project(m, x, y));
  const b = bbox([...content, [0, 0], [g.Wr, g.Hr]]);
  return { ...full, x: b.x / g.Wr, y: b.y / g.Hr, w: b.w / g.Wr, h: b.h / g.Hr };
}

/** Width : height of an aspect label ('original', 'free', '4:5', '2.39:1', 'custom:3:2'). */
export function aspectValue(label: string, img: GeoImage): number | null {
  if (label === 'free') return null;
  if (label === 'original') return img.width / img.height;
  const parts = label.replace(/^custom:/, '').split(':').map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) return parts[0] / parts[1];
  return null;
}
