/**
 * Camera-calibration-style primary adjustments as a single white-preserving 3×3 matrix.
 *
 * Each working-space primary (pure R, G, B of linear Rec.2020) is moved in OKLab: its hue is
 * rotated and its chroma scaled, at constant OKLab lightness. The three moved primaries become the
 * columns of a matrix M_raw (so a pixel's RGB weights now mix the *new* primaries). To keep white
 * white, the columns are rescaled by s = M_raw⁻¹ · (1,1,1), i.e. M·(1,1,1) = (1,1,1).
 * An optional user matrix (rows normalised to sum to 1, which also preserves white) is applied after.
 */
import { type Mat3, IDENTITY, diag, inv, mul, mulVec } from './matrices';
import { oklabToWorking, workingToOklab } from './oklab';
import type { Recipe } from '../recipe/schema';

/** Maximum primary hue rotation at ±100. */
const MAX_HUE_DEG = 30;
/** Chroma scale at saturation ±100 is 1 ± this. */
const SAT_SCALE = 0.55;

function movePrimary(e: [number, number, number], hue: number, sat: number): [number, number, number] {
  if (!hue && !sat) return e;
  const [L, a, b] = workingToOklab(e);
  const ang = (hue / 100) * (MAX_HUE_DEG * Math.PI) / 180;
  const k = 1 + (sat / 100) * SAT_SCALE;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return oklabToWorking([L, (a * ca - b * sa) * k, (a * sa + b * ca) * k]);
}

/** Normalise rows to sum 1 (white-preserving); rows summing to ~0 are left as-is. */
export function normalizeRows(m: readonly number[]): Mat3 {
  const out = m.slice();
  for (let r = 0; r < 3; r++) {
    const s = out[r * 3] + out[r * 3 + 1] + out[r * 3 + 2];
    if (Math.abs(s) > 1e-6) for (let c = 0; c < 3; c++) out[r * 3 + c] /= s;
  }
  return out;
}

export function calibrationMatrix(c: Recipe['calibration']): Mat3 {
  let m: Mat3 = IDENTITY;
  if (c.red.hue || c.red.sat || c.green.hue || c.green.sat || c.blue.hue || c.blue.sat) {
    const R = movePrimary([1, 0, 0], c.red.hue, c.red.sat);
    const G = movePrimary([0, 1, 0], c.green.hue, c.green.sat);
    const B = movePrimary([0, 0, 1], c.blue.hue, c.blue.sat);
    const raw: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
    const s = mulVec(inv(raw), [1, 1, 1]);
    m = mul(raw, diag([s[0], s[1], s[2]]));
  }
  if (c.matrix) m = mul(normalizeRows(c.matrix), m);
  return m;
}
