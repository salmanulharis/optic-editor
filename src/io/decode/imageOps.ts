/** CPU image operations used by the decode workers. All work on interleaved RGB Float32. */
import type { FloatImage } from './types';

/** Allocate a Float32Array, shared between threads when the page is cross-origin isolated. */
export function allocFloat(length: number): Float32Array {
  if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated) {
    return new Float32Array(new SharedArrayBuffer(length * 4));
  }
  return new Float32Array(length);
}

/** Precomputed area-average weights for resampling one axis from `src` to `dst` samples. */
function axisWeights(src: number, dst: number) {
  const scale = src / dst;
  const starts = new Int32Array(dst);
  const counts = new Int32Array(dst);
  const weights: number[] = [];
  const offsets = new Int32Array(dst);
  for (let i = 0; i < dst; i++) {
    const a = i * scale, b = (i + 1) * scale;
    const s = Math.floor(a), e = Math.min(src, Math.ceil(b));
    starts[i] = s;
    counts[i] = e - s;
    offsets[i] = weights.length;
    for (let k = s; k < e; k++) weights.push((Math.min(b, k + 1) - Math.max(a, k)) / scale);
  }
  return { starts, counts, offsets, weights: Float32Array.from(weights) };
}

/** Exact box/area downsample (each output pixel = mean of the input area it covers). */
export function downsample(img: FloatImage, maxLongEdge: number, shared = false): FloatImage {
  const s = Math.min(1, maxLongEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  if (w === img.width && h === img.height) {
    const copy = shared ? allocFloat(img.data.length) : new Float32Array(img.data.length);
    copy.set(img.data);
    return { width: w, height: h, data: copy };
  }
  const hx = axisWeights(img.width, w);
  const hy = axisWeights(img.height, h);
  // Horizontal pass: H × w
  const tmp = new Float32Array(img.height * w * 3);
  const src = img.data;
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 3;
    const orow = y * w * 3;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      const st = hx.starts[x], n = hx.counts[x], o = hx.offsets[x];
      for (let k = 0; k < n; k++) {
        const wt = hx.weights[o + k];
        const i = row + (st + k) * 3;
        r += src[i] * wt; g += src[i + 1] * wt; b += src[i + 2] * wt;
      }
      const oi = orow + x * 3;
      tmp[oi] = r; tmp[oi + 1] = g; tmp[oi + 2] = b;
    }
  }
  // Vertical pass
  const out = shared ? allocFloat(w * h * 3) : new Float32Array(w * h * 3);
  const rowLen = w * 3;
  for (let y = 0; y < h; y++) {
    const st = hy.starts[y], n = hy.counts[y], o = hy.offsets[y];
    const orow = y * rowLen;
    for (let k = 0; k < n; k++) {
      const wt = hy.weights[o + k];
      const irow = (st + k) * rowLen;
      for (let i = 0; i < rowLen; i++) out[orow + i] += tmp[irow + i] * wt;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Apply an EXIF orientation (1–8) so that the returned image is upright.
 * Returns the input unchanged for orientation 1.
 */
export function applyOrientation(img: FloatImage, orientation: number): FloatImage {
  if (!orientation || orientation === 1) return img;
  const { width: W, height: H, data } = img;
  const swap = orientation >= 5;
  const w = swap ? H : W, h = swap ? W : H;
  const out = allocFloat(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // (x, y) in output → (sx, sy) in source
      let sx: number, sy: number;
      switch (orientation) {
        case 2: sx = W - 1 - x; sy = y; break;
        case 3: sx = W - 1 - x; sy = H - 1 - y; break;
        case 4: sx = x; sy = H - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = H - 1 - x; break;
        case 7: sx = W - 1 - y; sy = H - 1 - x; break;
        case 8: sx = W - 1 - y; sy = x; break;
        default: sx = x; sy = y;
      }
      const si = (sy * W + sx) * 3, di = (y * w + x) * 3;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2];
    }
  }
  return { width: w, height: h, data: out };
}

/** Crop a rectangle out of an RGB float image. */
export function crop(img: FloatImage, x: number, y: number, w: number, h: number): FloatImage {
  x = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  w = Math.max(1, Math.min(img.width - x, Math.round(w)));
  h = Math.max(1, Math.min(img.height - y, Math.round(h)));
  if (x === 0 && y === 0 && w === img.width && h === img.height) return img;
  const out = allocFloat(w * h * 3);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.width + x) * 3;
    out.set(img.data.subarray(s, s + w * 3), r * w * 3);
  }
  return { width: w, height: h, data: out };
}

/** Build proxy + thumbnail from the full-resolution image. */
export function makeDerivatives(full: FloatImage, proxyLongEdge: number) {
  // Shared so the export worker can build image-wide maps (micro-contrast) from it without a copy.
  const proxy = downsample(full, Math.min(4096, proxyLongEdge), true);
  const thumb = downsample(proxy, 384);
  return { proxy, thumb };
}
