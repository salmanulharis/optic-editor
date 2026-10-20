/**
 * Deterministic synthetic test image (linear RGB float): a sky gradient, building-like blocks with
 * hard edges and windows, fine sinusoidal texture, small bright lights (for glow / halation) and
 * noise (for noise reduction). Every Phase 3 effect has something to act on. Linear in the pixel
 * count (a 48 MP image takes a few seconds).
 */
import { allocFloat, downsample } from '../io/decode/imageOps';
import type { FloatImage } from '../io/decode/types';

function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function syntheticImage(W: number, H: number, noise = 0.012): FloatImage {
  const data = allocFloat(W * H * 3);
  const s = Math.max(W, H);
  // Sky and ground.
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (v > 0.9) {
        const t = 0.2 + 0.05 * Math.sin((x / W) * 2400) * Math.cos(v * 1800);
        data[i] = t; data[i + 1] = t * 0.9; data[i + 2] = t * 0.7;
      } else {
        data[i] = 0.55 + 0.35 * (1 - v); data[i + 1] = 0.62 + 0.3 * (1 - v); data[i + 2] = 0.75 + 0.25 * (1 - v);
      }
    }
  }
  // Buildings: hard edges, a window pattern and fine texture.
  for (let k = 0; k < 9; k++) {
    const x0 = Math.round((0.05 + k * 0.105) * W), x1 = Math.round((0.05 + k * 0.105 + 0.08) * W);
    const top = Math.round((0.25 + 0.3 * hash(k, 1, 7)) * H), bottom = Math.round(0.9 * H);
    const col = [0.12 + 0.3 * hash(k, 2, 7), 0.1 + 0.25 * hash(k, 3, 7), 0.08 + 0.2 * hash(k, 4, 7)];
    const cw = s * 0.012, ch = s * 0.016;
    for (let y = top; y < bottom; y++) {
      for (let x = x0; x < x1; x++) {
        const tex = 0.04 * Math.sin((x / s) * 900) * Math.sin((y / s) * 700);
        const win = ((Math.floor((x - x0) / cw) + Math.floor((y - top) / ch)) & 1) ? 0.8 : 1.2;
        const i = (y * W + x) * 3;
        data[i] = col[0] * win + tex; data[i + 1] = col[1] * win + tex; data[i + 2] = col[2] * win + tex;
      }
    }
  }
  // Bright lights.
  for (let k = 0; k < 24; k++) {
    const cx = hash(k, 5, 9) * W, cy = (0.55 + 0.4 * hash(k, 6, 9)) * H, r = (0.002 + 0.006 * hash(k, 7, 9)) * s;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
        if (Math.hypot(x - cx, y - cy) >= r) continue;
        const i = (y * W + x) * 3;
        data[i] = 3; data[i + 1] = 2.6; data[i + 2] = 2;
      }
    }
  }
  // Noise, stronger in the shadows like photon noise.
  for (let p = 0, n = W * H; p < n; p++) {
    const x = p % W, y = (p / W) | 0, i = p * 3;
    const z = (hash(x, y, 1) + hash(x, y, 2) + hash(x, y, 3) - 1.5) * noise * 2;
    const k = Math.sqrt(Math.max(0.02, (data[i] + data[i + 1] + data[i + 2]) / 3));
    data[i] = Math.max(0, data[i] + z * k);
    data[i + 1] = Math.max(0, data[i + 1] + z * k * 0.8);
    data[i + 2] = Math.max(0, data[i + 2] + z * k * 1.1);
  }
  return { width: W, height: H, data };
}

export function proxyOf(full: FloatImage, edge = 2560): FloatImage {
  return downsample(full, edge, true);
}
