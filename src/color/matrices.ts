/**
 * 3×3 matrix helpers and the colour-space definitions used throughout the app.
 * Matrices are row-major `number[9]` and act on column vectors: out = M · rgb.
 */

export type Mat3 = readonly number[]; // length 9, row-major
export type Vec3 = readonly [number, number, number];
export type XY = readonly [number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function mulVec(m: Mat3, v: Vec3): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function inv(m: Mat3): Mat3 {
  const d = det(m);
  if (Math.abs(d) < 1e-12) throw new Error('Singular matrix');
  const id = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * id,
    (m[2] * m[7] - m[1] * m[8]) * id,
    (m[1] * m[5] - m[2] * m[4]) * id,
    (m[5] * m[6] - m[3] * m[8]) * id,
    (m[0] * m[8] - m[2] * m[6]) * id,
    (m[2] * m[3] - m[0] * m[5]) * id,
    (m[3] * m[7] - m[4] * m[6]) * id,
    (m[1] * m[6] - m[0] * m[7]) * id,
    (m[0] * m[4] - m[1] * m[3]) * id,
  ];
}

export function diag(v: Vec3): Mat3 {
  return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
}

export function scale(m: Mat3, s: number): Mat3 {
  return m.map((x) => x * s);
}

export function lerp(a: Mat3, b: Mat3, t: number): Mat3 {
  return a.map((x, i) => x * t + b[i] * (1 - t));
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function isIdentity(m: Mat3, eps = 1e-6): boolean {
  return m.every((x, i) => Math.abs(x - IDENTITY[i]) < eps);
}

/** Column-major Float32Array for gl.uniformMatrix3fv(…, false, …). */
export function toGL(m: Mat3): Float32Array {
  return new Float32Array(transpose(m));
}

export function xyToXYZ(xy: XY, Y = 1): [number, number, number] {
  return [(xy[0] * Y) / xy[1], Y, ((1 - xy[0] - xy[1]) * Y) / xy[1]];
}

export function XYZtoXY(v: Vec3): [number, number] {
  const s = v[0] + v[1] + v[2];
  return s > 0 ? [v[0] / s, v[1] / s] : [0.3127, 0.329];
}

// ---------------------------------------------------------------------------
// White points & chromatic adaptation
// ---------------------------------------------------------------------------

export const D65_XY: XY = [0.3127, 0.329];
export const D50_XY: XY = [0.3457, 0.3585];
/** ICC PCS white (D50) as written into profiles. */
export const D50_XYZ: Vec3 = [0.9642, 1.0, 0.8249];
export const D65_XYZ: Vec3 = [0.95047, 1.0, 1.08883];

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = inv(BRADFORD);

/** Bradford chromatic adaptation matrix (XYZ → XYZ) taking `src` white to `dst` white. */
export function bradford(srcWhite: Vec3, dstWhite: Vec3): Mat3 {
  const s = mulVec(BRADFORD, srcWhite);
  const d = mulVec(BRADFORD, dstWhite);
  return mul(BRADFORD_INV, mul(diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), BRADFORD));
}

export const D50_TO_D65 = bradford(D50_XYZ, D65_XYZ);
export const D65_TO_D50 = bradford(D65_XYZ, D50_XYZ);

// ---------------------------------------------------------------------------
// RGB colour spaces
// ---------------------------------------------------------------------------

export type ColorSpaceId = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto' | 'rec2020';
export type TransferId = 'srgb' | 'gamma' | 'linear' | 'prophoto';

export interface ColorSpaceDef {
  id: ColorSpaceId;
  label: string;
  primaries: [XY, XY, XY];
  white: XY;
  transfer: TransferId;
  gamma?: number;
}

export const COLOR_SPACES: Record<ColorSpaceId, ColorSpaceDef> = {
  srgb: {
    id: 'srgb',
    label: 'sRGB',
    primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]],
    white: D65_XY,
    transfer: 'srgb',
  },
  'display-p3': {
    id: 'display-p3',
    label: 'Display P3',
    primaries: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
    white: D65_XY,
    transfer: 'srgb',
  },
  'adobe-rgb': {
    id: 'adobe-rgb',
    label: 'Adobe RGB (1998)',
    primaries: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]],
    white: D65_XY,
    transfer: 'gamma',
    gamma: 563 / 256,
  },
  prophoto: {
    id: 'prophoto',
    label: 'ProPhoto RGB',
    primaries: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]],
    white: D50_XY,
    transfer: 'gamma',
    gamma: 1.8,
  },
  rec2020: {
    id: 'rec2020',
    label: 'Rec.2020',
    primaries: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]],
    white: D65_XY,
    transfer: 'srgb',
  },
};

/** RGB → XYZ for the given primaries, normalised so RGB (1,1,1) → white with Y = 1. */
export function rgbToXYZ(primaries: [XY, XY, XY], white: XY): Mat3 {
  const P = [xyToXYZ(primaries[0]), xyToXYZ(primaries[1]), xyToXYZ(primaries[2])];
  const M: Mat3 = [P[0][0], P[1][0], P[2][0], P[0][1], P[1][1], P[2][1], P[0][2], P[1][2], P[2][2]];
  const S = mulVec(inv(M), xyToXYZ(white));
  return mul(M, diag(S));
}

/**
 * RGB → XYZ referenced to D65. Spaces with another native white (ProPhoto, D50) are
 * Bradford-adapted so that every space shares one XYZ(D65) connection space.
 */
export function toXYZ_D65(id: ColorSpaceId): Mat3 {
  const cs = COLOR_SPACES[id];
  const m = rgbToXYZ(cs.primaries, cs.white);
  if (cs.white === D65_XY) return m;
  return mul(bradford(xyToXYZ(cs.white), D65_XYZ), m);
}

/** The working space: scene-linear Rec.2020, D65. */
export const WORKING_TO_XYZ = toXYZ_D65('rec2020');
export const XYZ_TO_WORKING = inv(WORKING_TO_XYZ);
/** Rec.2020 luminance coefficients (Y row of WORKING_TO_XYZ). */
export const WORKING_LUMA: Vec3 = [WORKING_TO_XYZ[3], WORKING_TO_XYZ[4], WORKING_TO_XYZ[5]];

export function workingTo(id: ColorSpaceId): Mat3 {
  return mul(inv(toXYZ_D65(id)), WORKING_TO_XYZ);
}

/** Identify a matrix-shaper space from its RGB→XYZ(D65) matrix (e.g. one parsed from ICC). */
export function identifySpace(m: Mat3, eps = 0.004): ColorSpaceId | null {
  for (const id of Object.keys(COLOR_SPACES) as ColorSpaceId[]) {
    const ref = toXYZ_D65(id);
    if (ref.every((x, i) => Math.abs(x - m[i]) < eps)) return id;
  }
  return null;
}
