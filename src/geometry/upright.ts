/**
 * Upright: find straight lines in the photo and solve for the transform sliders (rotate, vertical,
 * horizontal) that make them vertical / horizontal. Every mode only writes slider values, so the
 * result stays visible and editable.
 *
 * Line detection (on a ≤ 1024 px render of the lens-corrected image): a GPU Sobel gradient
 * (viewRenderer.edgeMap), then here: thin edges (non-maximum suppression), a Hough transform
 * where each edge pixel votes only near its own gradient direction, peak picking, and splitting
 * each peak's supporting pixels into segments.
 *
 * Solving: segments are classified as near-vertical or near-horizontal; a robust (truncated
 * quadratic) angular error in the transformed image is minimised with Nelder–Mead over the
 * parameters the mode allows. Guided upright uses the user's 2–4 lines instead, with high weight.
 */
import type { Recipe, UprightMode } from '../recipe/schema';
import { type GeoImage, type Vec2, geometryHomography, project } from './transform';

export interface Segment {
  a: Vec2;
  b: Vec2;
  /** Weight (length in pixels for detected lines). */
  w: number;
}

/** Detect line segments from a gradient image (gx, gy interleaved RGBA float, rows top → bottom). */
export function detectSegments(grad: Float32Array, w: number, h: number): Segment[] {
  const n = w * h;
  const mag = new Float32Array(n), ang = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const gx = grad[i * 4], gy = grad[i * 4 + 1];
    mag[i] = Math.hypot(gx, gy);
    ang[i] = Math.atan2(gy, gx);
  }
  // Threshold: the strongest ~7 % of gradients (and a floor for flat images).
  const sample = Array.from({ length: Math.min(n, 40000) }, (_, k) => mag[Math.floor((k / Math.min(n, 40000)) * n)]).sort((p, q) => p - q);
  const thr = Math.max(sample[Math.floor(sample.length * 0.93)], 0.02);
  // Non-maximum suppression along the gradient.
  const edge: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      const dx = Math.round(Math.cos(ang[i])), dy = Math.round(Math.sin(ang[i]));
      if (mag[i] >= mag[i + dy * w + dx] && mag[i] >= mag[i - dy * w - dx]) edge.push(i);
    }
  }
  // Hough (θ = normal direction, 0.5° bins over 180°; ρ = 1 px bins).
  const TB = 360, D = Math.ceil(Math.hypot(w, h)), RB = 2 * D + 1;
  const acc = new Float32Array(TB * RB);
  const cosT = new Float32Array(TB), sinT = new Float32Array(TB);
  for (let t = 0; t < TB; t++) { cosT[t] = Math.cos((t * Math.PI) / TB); sinT[t] = Math.sin((t * Math.PI) / TB); }
  const thetaBin = (a: number) => { let t = a < 0 ? a + Math.PI : a; if (t >= Math.PI) t -= Math.PI; return Math.round((t / Math.PI) * TB) % TB; };
  for (const i of edge) {
    const x = i % w, y = (i / w) | 0;
    const t0 = thetaBin(ang[i]);
    for (let dt = -3; dt <= 3; dt++) {
      const t = (t0 + dt + TB) % TB;
      const r = Math.round(x * cosT[t] + y * sinT[t]) + D;
      acc[t * RB + r] += mag[i];
    }
  }
  // Peaks with non-maximum suppression in (θ, ρ).
  const peaks: Array<{ t: number; r: number; v: number }> = [];
  const minVotes = thr * 30;
  for (let t = 0; t < TB; t++) {
    for (let r = 1; r < RB - 1; r++) {
      const v = acc[t * RB + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -4; dt <= 4 && isMax; dt++) for (let dr = -6; dr <= 6; dr++) {
        const tt = (t + dt + TB) % TB, rr = r + dr;
        if ((dt || dr) && rr >= 0 && rr < RB && acc[tt * RB + rr] > v) { isMax = false; break; }
      }
      if (isMax) peaks.push({ t, r, v });
    }
  }
  peaks.sort((p, q) => q.v - p.v);
  const segs: Segment[] = [];
  for (const p of peaks.slice(0, 80)) {
    const c = cosT[p.t], s = sinT[p.t], rho = p.r - D;
    // Supporting edge pixels: close to the line, gradient along its normal.
    const pts: number[] = [];
    for (const i of edge) {
      const x = i % w, y = (i / w) | 0;
      if (Math.abs(x * c + y * s - rho) > 1.5) continue;
      const da = Math.abs(((thetaBin(ang[i]) - p.t + TB + TB / 2) % TB) - TB / 2);
      if (da > 6) continue;
      pts.push(-x * s + y * c); // position along the line
    }
    pts.sort((a, b) => a - b);
    let start = 0;
    for (let k = 1; k <= pts.length; k++) {
      if (k === pts.length || pts[k] - pts[k - 1] > 6) {
        const len = pts[k - 1] - pts[start];
        if (len >= 40 && k - start >= len * 0.5) {
          const at = (u: number): Vec2 => [rho * c - u * s, rho * s + u * c];
          segs.push({ a: at(pts[start]), b: at(pts[k - 1]), w: len });
        }
        start = k;
      }
    }
  }
  return segs;
}

const deg = (r: number) => (r * 180) / Math.PI;
/** Deviation (degrees) of a direction from vertical / horizontal. */
const fromVertical = (dx: number, dy: number) => Math.abs(deg(Math.atan2(dx, Math.abs(dy) || 1e-9)));
const fromHorizontal = (dx: number, dy: number) => Math.abs(deg(Math.atan2(dy, Math.abs(dx) || 1e-9)));

export type UprightParams = Pick<Recipe['geometry'], 'rotate' | 'vertical' | 'horizontal'>;

/** Nelder–Mead minimisation (small dimension, few hundred evaluations). */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters = 400): number[] {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[j] : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iters; it++) {
    simplex.sort((a, b) => a.f - b.f);
    const best = simplex[0], worst = simplex[n], second = simplex[n - 1];
    const c = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
    const at = (t: number) => c.map((v, j) => v + t * (worst.x[j] - v));
    const r = at(-1), fr = f(r);
    if (fr < best.f) { const e = at(-2), fe = f(e); simplex[n] = fe < fr ? { x: e, f: fe } : { x: r, f: fr }; }
    else if (fr < second.f) simplex[n] = { x: r, f: fr };
    else {
      const k = at(0.5), fk = f(k);
      if (fk < worst.f) simplex[n] = { x: k, f: fk };
      else simplex = simplex.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j])), f: f(p.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j]))) }));
    }
    if (Math.abs(simplex[n].f - simplex[0].f) < 1e-7 && it > 40) break;
  }
  simplex.sort((a, b) => a.f - b.f);
  return simplex[0].x;
}

/**
 * Solve the transform for a mode. Segments are in undistorted source pixels. `guided` lines get a
 * high weight and decide the free parameters by how many there are.
 */
export function solveUpright(mode: UprightMode, segments: Segment[], img: GeoImage, base: Recipe['geometry']): UprightParams {
  const verts = segments.filter((s) => fromVertical(s.b[0] - s.a[0], s.b[1] - s.a[1]) < 30);
  const hors = segments.filter((s) => fromHorizontal(s.b[0] - s.a[0], s.b[1] - s.a[1]) < 25);
  if (!verts.length && !hors.length) return { rotate: base.rotate, vertical: base.vertical, horizontal: base.horizontal };
  let free: Array<keyof UprightParams>;
  let wv = 1, wh = 1, reg = 0;
  switch (mode) {
    case 'level': free = ['rotate']; wv = 0.4; break;
    case 'vertical': free = ['rotate', 'vertical']; wh = 0.35; break;
    case 'full': free = ['rotate', 'vertical', 'horizontal']; break;
    case 'guided':
      free = segments.length <= 1 ? ['rotate'] : segments.length === 2 ? (verts.length >= hors.length ? ['rotate', 'vertical'] : ['rotate', 'horizontal']) : ['rotate', 'vertical', 'horizontal'];
      break;
    default: free = ['rotate', 'vertical', 'horizontal']; wh = 0.6; reg = 0.0015; // auto: balanced
  }
  const params = (x: number[]): Recipe['geometry'] => {
    const g = { ...base, rotate: 0, vertical: 0, horizontal: 0 };
    free.forEach((k, i) => { g[k] = x[i]; });
    return g;
  };
  const cost = (x: number[]) => {
    const H = geometryHomography(params(x), img);
    const err = (s: Segment, vertical: boolean) => {
      const a = project(H, s.a[0], s.a[1]), b = project(H, s.b[0], s.b[1]);
      const d = vertical ? fromVertical(b[0] - a[0], b[1] - a[1]) : fromHorizontal(b[0] - a[0], b[1] - a[1]);
      return Math.min(d * d, 16); // truncated: lines that are not meant to be straight don't pull
    };
    let c = 0;
    for (const s of verts) c += wv * s.w * err(s, true);
    for (const s of hors) c += wh * s.w * err(s, false);
    const total = verts.reduce((a, s) => a + s.w * wv, 0) + hors.reduce((a, s) => a + s.w * wh, 0);
    const out = c / Math.max(total, 1e-6);
    return out + reg * x.reduce((a, v, i) => a + (free[i] === 'rotate' ? 0 : v * v), 0);
  };
  const x = nelderMead(cost, free.map(() => 0), free.map((k) => (k === 'rotate' ? 2 : 8)));
  const out: UprightParams = { rotate: 0, vertical: 0, horizontal: 0 };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  free.forEach((k, i) => { out[k] = k === 'rotate' ? +clamp(x[i], -45, 45).toFixed(2) : Math.round(clamp(x[i], -100, 100)); });
  return out;
}
