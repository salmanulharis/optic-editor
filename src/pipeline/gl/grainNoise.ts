/**
 * Tileable film-grain noise, generated deterministically (same texture in the preview and in the
 * export worker). 512² RGBA float:
 *  - r, g, b: three independent grain fields. Gaussian white noise, high-passed with a wrap-around
 *    Gaussian (blue-noise character: no low-frequency mottle, grains evenly spread), then very
 *    lightly softened so a grain is a small blob rather than a single texel. Unit variance.
 *  - a: a low-frequency field (σ = 6 texels) used to clump grain (roughness).
 * The stage samples several rotated, incommensurately scaled octaves of it, so the 512 px period
 * never shows as a repeating pattern.
 */

const SIZE = 512;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wrap-around separable Gaussian of one channel (stride 4). */
function blurWrap(src: Float32Array, ch: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(SIZE * SIZE);
  const out = new Float32Array(SIZE * SIZE);
  const m = SIZE - 1;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += src[(y * SIZE + ((x + i) & m)) * 4 + ch] * k[i + r];
      tmp[y * SIZE + x] = a / ks;
    }
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += tmp[((y + i) & m) * SIZE + x] * k[i + r];
      out[y * SIZE + x] = a / ks;
    }
  return out;
}

let cached: { size: number; data: Float32Array } | null = null;

export function grainTexture(): { size: number; data: Float32Array } {
  if (cached) return cached;
  const rnd = mulberry32(0x0971c);
  const n = SIZE * SIZE;
  const white = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i += 2) {
    // Box–Muller: two Gaussian samples per pair of uniforms.
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const rr = Math.sqrt(-2 * Math.log(u1));
    white[i] = rr * Math.cos(2 * Math.PI * u2);
    white[i + 1] = rr * Math.sin(2 * Math.PI * u2);
  }
  const data = new Float32Array(n * 4);
  for (let ch = 0; ch < 4; ch++) {
    let f: Float32Array;
    if (ch < 3) {
      const low = blurWrap(white, ch, 2.5);
      const hp = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) hp[i * 4] = white[i * 4 + ch] - low[i];
      f = blurWrap(hp, 0, 0.55);
    } else {
      f = blurWrap(white, 3, 6);
    }
    let s2 = 0;
    for (let i = 0; i < n; i++) s2 += f[i] * f[i];
    const k = 1 / Math.sqrt(s2 / n);
    for (let i = 0; i < n; i++) data[i * 4 + ch] = f[i] * k;
  }
  cached = { size: SIZE, data };
  return cached;
}
