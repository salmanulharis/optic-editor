/**
 * View geometry shared by the canvas renderer and the overlays (crop, guides, grid, compare): the
 * view state for a canvas and output size, and image ↔ screen (CSS pixel) conversions.
 */
import type { ViewState } from './viewRenderer';

export const FIT_MARGIN = 16; // CSS px

export interface ViewBox {
  /** Canvas size in device pixels and the device-pixel ratio. */
  W: number;
  H: number;
  dpr: number;
}

/** Fit scale and the view for a zoom / centre (side by side: each half shows the same view). */
export function viewFor(box: ViewBox, out: { width: number; height: number }, zoom: 'fit' | number, center: { x: number; y: number }, side = false) {
  const W = side ? Math.floor(box.W / 2) : box.W;
  const fit = Math.min((W - FIT_MARGIN * 2 * box.dpr) / out.width, (box.H - FIT_MARGIN * 2 * box.dpr) / out.height);
  const v: ViewState = zoom === 'fit' ? { scale: fit, cx: out.width / 2, cy: out.height / 2 } : { scale: zoom, cx: center.x, cy: center.y };
  return { v, fit, areaW: W };
}

/** Output pixel → CSS pixel within the (half-)area that starts at CSS x = `offsetCss`. */
export function toScreen(v: ViewState, box: ViewBox, areaW: number, x: number, y: number, offsetCss = 0): [number, number] {
  return [offsetCss + ((x - v.cx) * v.scale + areaW / 2) / box.dpr, ((y - v.cy) * v.scale + box.H / 2) / box.dpr];
}

/** CSS pixel (relative to the area) → output pixel. */
export function toImage(v: ViewState, box: ViewBox, areaW: number, cssX: number, cssY: number): [number, number] {
  return [v.cx + (cssX * box.dpr - areaW / 2) / v.scale, v.cy + (cssY * box.dpr - box.H / 2) / v.scale];
}
