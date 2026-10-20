/**
 * OKLab / OKLCH (Björn Ottosson, 2020) for the linear Rec.2020 working space.
 * The published M1 matrix maps linear sRGB → LMS; we pre-multiply it with
 * sRGB←XYZ←Rec.2020 so the shaders can go straight from working RGB to LMS.
 */
import { type Mat3, WORKING_TO_XYZ, inv, mul, toXYZ_D65, mulVec } from './matrices';

const SRGB_TO_LMS: Mat3 = [
  0.4122214708, 0.5363325363, 0.0514459929,
  0.2119034982, 0.6806995451, 0.1073969566,
  0.0883024619, 0.2817188376, 0.6299787005,
];
const LMS_TO_LAB: Mat3 = [
  0.2104542553, 0.793617785, -0.0040720468,
  1.9779984951, -2.428592205, 0.4505937099,
  0.0259040371, 0.7827717662, -0.808675766,
];
const LAB_TO_LMS: Mat3 = inv(LMS_TO_LAB);

export const WORKING_TO_LMS: Mat3 = mul(SRGB_TO_LMS, mul(inv(toXYZ_D65('srgb')), WORKING_TO_XYZ));
export const LMS_TO_WORKING: Mat3 = inv(WORKING_TO_LMS);

const cbrt = (x: number) => Math.sign(x) * Math.cbrt(Math.abs(x));

export function workingToOklab(rgb: readonly [number, number, number]): [number, number, number] {
  const lms = mulVec(WORKING_TO_LMS, rgb).map(cbrt) as [number, number, number];
  return mulVec(LMS_TO_LAB, lms);
}

export function oklabToWorking(lab: readonly [number, number, number]): [number, number, number] {
  const lms = mulVec(LAB_TO_LMS, lab).map((x) => x * x * x) as [number, number, number];
  return mulVec(LMS_TO_WORKING, lms);
}

const glslMat = (m: Mat3) =>
  // GLSL mat3 constructors are column-major.
  `mat3(${[0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => m[i].toFixed(10)).join(', ')})`;

/** GLSL helpers shared by every stage that works in OKLab/OKLCH. */
export const OKLAB_GLSL = /* glsl */ `
const mat3 OK_W2LMS = ${glslMat(WORKING_TO_LMS)};
const mat3 OK_LMS2W = ${glslMat(LMS_TO_WORKING)};
const mat3 OK_LMS2LAB = ${glslMat(LMS_TO_LAB)};
const mat3 OK_LAB2LMS = ${glslMat(LAB_TO_LMS)};
vec3 ok_cbrt(vec3 x) { return sign(x) * pow(abs(x), vec3(1.0 / 3.0)); }
vec3 toOklab(vec3 rgb) { return OK_LMS2LAB * ok_cbrt(OK_W2LMS * rgb); }
vec3 fromOklab(vec3 lab) { vec3 l = OK_LAB2LMS * lab; return OK_LMS2W * (l * l * l); }
// OKLCH with hue in radians [0, 2π)
vec3 toOklch(vec3 rgb) {
  vec3 lab = toOklab(rgb);
  float h = atan(lab.z, lab.y);
  return vec3(lab.x, length(lab.yz), h < 0.0 ? h + 6.28318530718 : h);
}
vec3 fromOklch(vec3 lch) { return fromOklab(vec3(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z))); }
`;
