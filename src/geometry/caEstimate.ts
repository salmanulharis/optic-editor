/**
 * Automatic lateral chromatic aberration estimate.
 *
 * Lateral CA scales the red and blue images radially relative to green, so at an edge whose normal
 * points away from the centre, the red and blue edges sit slightly further out (or in) than green.
 * We sample edges in the outer part of the frame whose gradient is mostly radial, take short
 * profiles of R, G, B across each edge, find the sub-pixel shift that best aligns red (blue) with
 * green, and convert it to a radial scale offset k = shift / radius. The median over all edges is
 * robust to the occasional coloured edge in the scene.
 */
import type { FloatImage } from '../io/decode/types';

const HALF = 6; // profile half-length in pixels
const STEP = 0.5;

export function estimateCA(img: FloatImage, maxEdges = 1200): [number, number] | null {
  const { width: W, height: H, data } = img;
  const cx = W / 2, cy = H / 2, norm = Math.hypot(cx, cy);
  const at = (x: number, y: number, c: number) => {
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
    const fx = x - x0, fy = y - y0;
    const i = (y0 * W + x0) * 3 + c, j = i + W * 3;
    return (data[i] * (1 - fx) + data[i + 3] * fx) * (1 - fy) + (data[j] * (1 - fx) + data[j + 3] * fx) * fy;
  };
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const n = 2 * HALF / STEP + 1;
  const prof = (x: number, y: number, ux: number, uy: number, c: number) => {
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) { const t = -HALF + k * STEP; out[k] = at(x + ux * t, y + uy * t, c); }
    return out;
  };
  const normalise = (p: Float32Array) => {
    let m = 0;
    for (const v of p) m += v;
    m /= p.length;
    let s = 0;
    for (const v of p) s += (v - m) ** 2;
    s = Math.sqrt(s / p.length) || 1;
    return p.map((v) => (v - m) / s);
  };
  /** Shift (pixels) that best aligns channel profile `q` to green `g`. */
  const align = (g: Float32Array, q: Float32Array) => {
    let best = 0, bestErr = Infinity;
    for (let s = -3; s <= 3.0001; s += 0.05) {
      let err = 0, cnt = 0;
      for (let k = 4; k < n - 4; k++) {
        const pos = k + s / STEP;
        const k0 = Math.floor(pos), f = pos - k0;
        if (k0 < 0 || k0 + 1 >= n) continue;
        const v = q[k0] * (1 - f) + q[k0 + 1] * f;
        err += (v - g[k]) ** 2; cnt++;
      }
      err /= cnt;
      if (err < bestErr) { bestErr = err; best = s; }
    }
    return { s: best, err: bestErr };
  };
  const kr: number[] = [], kb: number[] = [];
  for (let tries = 0; tries < maxEdges * 40 && kr.length < maxEdges; tries++) {
    const x = 8 + rnd() * (W - 16), y = 8 + rnd() * (H - 16);
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
    if (r < 0.35 * norm) continue;
    const ux = dx / r, uy = dy / r;
    const gx = at(x + 1, y, 1) - at(x - 1, y, 1), gy = at(x, y + 1, 1) - at(x, y - 1, 1);
    const g = Math.hypot(gx, gy), mean = at(x, y, 1);
    if (g < 0.12 * Math.max(mean, 0.02)) continue;
    const radial = Math.abs(gx * ux + gy * uy);
    if (radial < 0.9 * g) continue;
    const pg = normalise(prof(x, y, ux, uy, 1));
    const a = align(pg, normalise(prof(x, y, ux, uy, 0)));
    const b = align(pg, normalise(prof(x, y, ux, uy, 2)));
    if (a.err > 0.35 || b.err > 0.35) continue;
    kr.push(a.s / r); kb.push(b.s / r);
  }
  if (kr.length < 40) return null;
  const median = (v: number[]) => { const s = [...v].sort((p, q) => p - q); return s[s.length >> 1]; };
  const out: [number, number] = [median(kr), median(kb)];
  // Real lateral CA is a few pixels at most; anything larger is a mis-measurement.
  return out.every((k) => Math.abs(k * norm) < 6) ? out : null;
}
