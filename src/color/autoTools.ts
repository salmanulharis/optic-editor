/**
 * Automatic tools. Each one analyses pixels and returns *recipe values* (sliders move visibly);
 * nothing is applied behind the user's back.
 */
import type { Vec3 } from './matrices';
import { workingToOklab } from './oklab';
import { WORKING_LUMA } from './matrices';
import type { CastEstimate } from '../recipe/schema';

/**
 * Auto white balance: a gray-world / white-patch hybrid on source-space linear pixels (camera RGB
 * for RAW). Clipped, very dark and strongly coloured pixels are excluded, and the estimate is
 * refined twice so the "strongly coloured" test is made relative to the current guess.
 * Returns the source-space colour of neutral (a camera neutral for RAW).
 */
export function estimateNeutral(rgb: Float32Array, start: Vec3 = [1, 1, 1]): Vec3 {
  let est: Vec3 = start;
  const n = rgb.length / 3;
  for (let iter = 0; iter < 3; iter++) {
    const maxChroma = iter === 0 ? 0.8 : 0.45;
    let sr = 0, sg = 0, sb = 0, count = 0;
    const bright: Array<[number, number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      const mx = Math.max(r, g, b);
      if (mx >= 0.95 || mx < 0.01) continue; // clipped or noise
      const wr = r / est[0], wg = g / est[1], wb = b / est[2];
      const wmax = Math.max(wr, wg, wb), wmin = Math.min(wr, wg, wb);
      if (wmax <= 0 || (wmax - wmin) / wmax > maxChroma) continue; // saturated object colour
      sr += r; sg += g; sb += b; count++;
      bright.push([wr + wg + wb, r, g, b]);
    }
    if (count < 50) break;
    // White patch: mean of the brightest 3 % of the remaining pixels.
    bright.sort((a, b) => b[0] - a[0]);
    const k = Math.max(10, Math.floor(bright.length * 0.03));
    let wr = 0, wg = 0, wb = 0;
    for (let i = 0; i < k; i++) { wr += bright[i][1]; wg += bright[i][2]; wb += bright[i][3]; }
    const gw: Vec3 = [sr / count, sg / count, sb / count];
    const wp: Vec3 = [wr / k, wg / k, wb / k];
    // Weighted geometric blend (normalised so green = 1). White patch gets more weight: bright
    // near-neutral surfaces are what viewers judge neutrality by, and in rendered (non-RAW) images
    // the highlight roll-off often carries a weaker cast than the midtones.
    const g0 = gw[1], w0 = wp[1];
    const blend = (a: number, b: number) => Math.pow(a, 0.35) * Math.pow(b, 0.65);
    est = [blend(gw[0] / g0, wp[0] / w0), 1, blend(gw[2] / g0, wp[2] / w0)];
  }
  return est;
}

function percentile(sorted: Float32Array, p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Auto tone from the histogram of working-space luminance (before the tone stage). Conservative:
 * exposure moves the median toward mid grey at 70 % strength, whites/blacks only stretch toward
 * the range ends (never crush), highlights recover only real overflow.
 */
export function autoTone(rgba: Float32Array, isRaw: boolean) {
  const n = rgba.length / 4;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Y[i] = Math.max(0, rgba[i * 4] * WORKING_LUMA[0] + rgba[i * 4 + 1] * WORKING_LUMA[1] + rgba[i * 4 + 2] * WORKING_LUMA[2]);
  }
  Y.sort();
  const med = Math.max(1e-4, percentile(Y, 0.5));
  const target = isRaw ? 0.15 : 0.18;
  const exposure = clamp(Math.log2(target / med) * 0.7, -2, 2);
  const g = Math.pow(2, exposure);
  const hi = percentile(Y, 0.995) * g;
  const lo = percentile(Y, 0.005) * g;
  const p5 = Math.max(1e-5, percentile(Y, 0.05) * g), p95 = Math.max(1e-5, percentile(Y, 0.95) * g);
  const spread = Math.log2(p95 / p5);
  let whites = 0, highlights = 0, blacks = 0, shadows = 0;
  if (hi < 0.85) whites = clamp((Math.log2(0.95 / hi) / 1.25) * 100 * 0.6, 0, 35);
  if (hi > 1.5) highlights = -clamp((Math.log2(hi) - 0.5) * 35, 0, 60);
  if (lo > 0.012) blacks = -clamp(((lo - 0.006) / 0.05) * 50, 0, 35);
  if (percentile(Y, 0.1) * g < 0.015) shadows = clamp((Math.log2(0.015 / Math.max(1e-5, percentile(Y, 0.1) * g))) * 12, 0, 35);
  const contrast = clamp((6.5 - spread) * 7, -20, 25);
  return {
    exposure: Math.round(exposure * 100) / 100,
    contrast: Math.round(contrast),
    highlights: Math.round(highlights),
    shadows: Math.round(shadows),
    whites: Math.round(whites),
    blacks: Math.round(blacks),
  };
}

/**
 * Colour-cast estimate per tonal zone, from white-balanced working-space pixels. Strongly
 * coloured pixels (real object colours) are excluded; each zone's mean OKLab (a, b) is the cast.
 */
export function estimateCast(rgba: Float32Array): CastEstimate {
  const zones = [
    { a: 0, b: 0, w: 0 },
    { a: 0, b: 0, w: 0 },
    { a: 0, b: 0, w: 0 },
  ];
  const all = { a: 0, b: 0, w: 0 };
  const smooth = (e0: number, e1: number, x: number) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < rgba.length; i += 4) {
    const lab = workingToOklab([rgba[i], rgba[i + 1], rgba[i + 2]]);
    const L = clamp(lab[0], 0, 1);
    const C = Math.hypot(lab[1], lab[2]);
    if (L < 0.06 || L > 0.98 || C > 0.07) continue;
    const ws = 1 - smooth(0.15, 0.5, L), wh = smooth(0.5, 0.85, L), wm = Math.max(0, 1 - ws - wh);
    [ws, wm, wh].forEach((w, z) => { zones[z].a += lab[1] * w; zones[z].b += lab[2] * w; zones[z].w += w; });
    all.a += lab[1]; all.b += lab[2]; all.w += 1;
  }
  const mean = (z: { a: number; b: number; w: number }): [number, number] =>
    z.w > 20 ? [z.a / z.w, z.b / z.w] : all.w ? [all.a / all.w, all.b / all.w] : [0, 0];
  const r = (v: [number, number]): [number, number] => [Math.round(v[0] * 1e4) / 1e4, Math.round(v[1] * 1e4) / 1e4];
  return { shadows: r(mean(zones[0])), midtones: r(mean(zones[1])), highlights: r(mean(zones[2])) };
}

export function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}
