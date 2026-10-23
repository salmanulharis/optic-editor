/**
 * CPU reference of the output stage's soft gamut compression (stages/90_output.ts): in OKLCH, the
 * largest in-gamut chroma at the colour's lightness and hue is found by bisection; chroma up to
 * 0.9 × that boundary is untouched, 0.9…1.6 × is compressed smoothly into 0.9…1.0, beyond lands on
 * the boundary. Lightness and hue are kept. Used by tests and CPU-side checks; keep in step with
 * the GLSL.
 */
import { type Mat3, type Vec3, mulVec } from './matrices';
import { oklabToWorking, workingToOklab } from './oklab';

type V3 = [number, number, number];

const toLch = (w: Vec3): V3 => {
  const [L, a, b] = workingToOklab(w as V3);
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
};
const fromLch = ([L, C, h]: V3): V3 => oklabToWorking([L, C * Math.cos(h), C * Math.sin(h)]);
const min3 = (v: Vec3) => Math.min(v[0], v[1], v[2]);

/** Working-space linear RGB → destination linear RGB with soft gamut compression. */
export function gamutMap(w: Vec3, workingToDest: Mat3): V3 {
  const t = mulVec(workingToDest, w);
  const lch = toLch(w);
  if (lch[1] < 1e-5 || lch[0] <= 0) return [Math.max(t[0], 0), Math.max(t[1], 0), Math.max(t[2], 0)];
  const inside = (s: number) => min3(mulVec(workingToDest, fromLch([lch[0], lch[1] * s, lch[2]]))) >= 0;
  let lo = 0, hi = 4;
  if (inside(hi)) return t;
  for (let i = 0; i < 10; i++) {
    const mid = 0.5 * (lo + hi);
    if (inside(mid)) lo = mid; else hi = mid;
  }
  const r = 1 / Math.max(lo, 1e-4);
  const thr = 0.9, lim = 1.6;
  if (r <= thr) return t;
  const X = (lim - thr) / (1 - thr);
  const a = (X - 1) / X;
  const x = Math.min((r - thr) / (1 - thr), X);
  const r2 = thr + ((1 - thr) * x) / (1 + a * x);
  const out = mulVec(workingToDest, fromLch([lch[0], lch[1] * (r2 / r), lch[2]]));
  return [Math.max(out[0], 0), Math.max(out[1], 0), Math.max(out[2], 0)];
}

export { toLch as workingToOklch };
