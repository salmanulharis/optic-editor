/**
 * Noise model of a decoded image, σ²(Y) = S·Y + O (photon + read noise), measured on the image
 * itself so noise reduction behaves the same on every camera, ISO and format.
 *
 * On a stride grid, each sample's luminance is compared with the mean of its four neighbours. The
 * residual of a flat area is pure noise (variance σ²·(1 + 1/4)); texture and edges only make it
 * larger, so within each brightness bin the lower quartile of |residual| (0.3186 σ for Gaussian
 * noise) is a robust estimate. A weighted least-squares line through (Y, σ²) gives S and O.
 */
import type { FloatImage } from '../io/decode/types';

const BINS = 14;

export function estimateNoise(img: FloatImage, gains: [number, number, number] = [1, 1, 1], maxSamples = 160_000): { S: number; O: number } {
  const { width: W, height: H, data } = img;
  const stride = Math.max(2, Math.ceil(Math.sqrt((W * H) / maxSamples)));
  const lum = (x: number, y: number) => {
    const i = (y * W + x) * 3;
    return (data[i] * gains[0] + 2 * data[i + 1] * gains[1] + data[i + 2] * gains[2]) * 0.25;
  };
  const bins: number[][] = Array.from({ length: BINS }, () => []);
  const lo = Math.log2(1e-4), hi = 0;
  for (let y = 2; y < H - 2; y += stride) {
    for (let x = 2 + ((y / stride) & 1); x < W - 2; x += stride) {
      const c = lum(x, y);
      if (!(c > 1e-4) || c >= 0.97) continue;
      const r = c - (lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1)) * 0.25;
      const b = Math.floor(((Math.log2(c) - lo) / (hi - lo)) * BINS);
      if (b >= 0 && b < BINS) bins[b].push(Math.abs(r));
    }
  }
  // Per bin: robust σ from the lower quartile of |residual|.
  const pts: Array<{ y: number; v: number; n: number }> = [];
  bins.forEach((list, b) => {
    if (list.length < 150) return;
    list.sort((a, c) => a - c);
    const q25 = list[Math.floor(list.length * 0.25)];
    const sigma = q25 / 0.3186 / Math.sqrt(1.25);
    pts.push({ y: Math.pow(2, lo + ((b + 0.5) / BINS) * (hi - lo)), v: sigma * sigma, n: list.length });
  });
  if (pts.length < 2) return { S: 1.5e-4, O: 4e-6 };
  // Weighted least squares for v = S·y + O (weights: sample count / variance², i.e. relative error).
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const w = p.n / Math.max(p.v * p.v, 1e-20);
    sw += w; sx += w * p.y; sy += w * p.v; sxx += w * p.y * p.y; sxy += w * p.y * p.v;
  }
  const den = sw * sxx - sx * sx;
  let S = den > 0 ? (sw * sxy - sx * sy) / den : 0;
  let O = (sy - S * sx) / sw;
  if (S < 0) { S = 0; O = sy / sw; }
  O = Math.max(O, 1e-8);
  S = Math.max(S, 1e-7);
  return { S, O };
}
