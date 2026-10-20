/**
 * CPU-side helpers on top of the output → source transform: where an output pixel comes from,
 * which source area a region of the output needs (detail textures, export tiles), and whether a
 * crop rectangle stays inside the image.
 */
import type { Recipe } from '../recipe/schema';
import type { ImageModel } from '../pipeline/types';
import { type LensModel, lensModel, uToS } from './lens';
import { type Geo, type Vec2, bbox, computeGeo, project, rectSamples } from './transform';

export function lensFor(img: ImageModel, r: Pick<Recipe, 'lens'>): LensModel {
  return lensModel({ width: img.width, height: img.height, profile: img.lens, caEstimate: img.analysis.ca }, r.lens);
}

export function geoFor(img: ImageModel, r: Pick<Recipe, 'geometry' | 'crop'>): Geo {
  return computeGeo(img, r);
}

/** Output pixel → source pixel (green channel). */
export function outputToSource(img: ImageModel, r: Pick<Recipe, 'geometry' | 'crop' | 'lens'>, x: number, y: number): Vec2 {
  const g = geoFor(img, r);
  const u = g.identity ? ([x, y] as Vec2) : project(g.oToU, x, y);
  const l = lensFor(img, r);
  return l.active ? uToS(l, u) : u;
}

/**
 * Source rectangle (clamped to the image, integer pixels) that covers an output rectangle plus
 * `margin` source pixels for neighbourhood filters and lens CA shifts.
 */
export function sourceRegion(
  img: ImageModel,
  r: Pick<Recipe, 'geometry' | 'crop' | 'lens'>,
  x: number, y: number, w: number, h: number,
  margin: number,
) {
  const g = geoFor(img, r);
  const l = lensFor(img, r);
  let pts: Vec2[];
  if (g.identity && !l.active) pts = [[x, y], [x + w, y + h]];
  else {
    const n = Math.max(4, Math.ceil(Math.max(w, h) / 128));
    pts = rectSamples(x, y, w, h, n).flatMap(([px, py]) => {
      const u = project(g.oToU, px, py);
      return l.active ? [uToS(l, u, 0), uToS(l, u, 1), uToS(l, u, 2)] : [u];
    });
  }
  const b = bbox(pts);
  const x0 = Math.max(0, Math.floor(b.x - margin)), y0 = Math.max(0, Math.floor(b.y - margin));
  const x1 = Math.min(img.width, Math.ceil(b.x + b.w + margin)), y1 = Math.min(img.height, Math.ceil(b.y + b.h + margin));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** True when every sample of the output rectangle (R-normalised crop) maps inside the source. */
export function cropInside(img: ImageModel, r: Pick<Recipe, 'geometry' | 'crop' | 'lens'>, crop: Recipe['crop']): boolean {
  const g = geoFor(img, { geometry: r.geometry, crop });
  const l = lensFor(img, r);
  const eps = 0.75;
  return rectSamples(0, 0, g.outW, g.outH, 12).every(([x, y]) => {
    const u = project(g.oToU, x, y);
    const s = l.active ? uToS(l, u) : u;
    return s[0] >= -eps && s[1] >= -eps && s[0] <= img.width + eps && s[1] <= img.height + eps;
  });
}

/**
 * Shrink a crop rectangle about its centre (keeping its aspect) until it lies inside the image.
 * Used when straightening and for "Constrain crop".
 */
export function constrainCrop(img: ImageModel, r: Pick<Recipe, 'geometry' | 'crop' | 'lens'>, crop: Recipe['crop']): Recipe['crop'] {
  if (cropInside(img, r, crop)) return crop;
  const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
  const at = (s: number) => ({ ...crop, x: cx - (crop.w * s) / 2, y: cy - (crop.h * s) / 2, w: crop.w * s, h: crop.h * s });
  let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (cropInside(img, r, at(mid))) lo = mid; else hi = mid;
  }
  if (lo > 0.02) return at(lo);
  // The centre itself is outside the image (extreme transforms): fall back to the frame centre.
  const centred = { ...crop, x: 0.5 - crop.w / 2, y: 0.5 - crop.h / 2 };
  return centred.x === crop.x && centred.y === crop.y ? at(0.02) : constrainCrop(img, r, centred);
}
