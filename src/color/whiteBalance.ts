/**
 * White balance math.
 *
 * RAW files follow the DNG specification (chapter 6, "Mapping Camera Color Space to CIE XYZ"):
 *  - A white balance is described either by a camera-space neutral (AsShotNeutral) or by a
 *    correlated colour temperature + tint, which we convert to a CIE xy chromaticity.
 *  - The camera's XYZ→camera matrix depends on the illuminant: DNGs carry ColorMatrix1/2 for
 *    two calibration illuminants (typically Std. A ≈ 2850 K and D65). For a given white xy we
 *    compute its CCT and interpolate the two matrices linearly in *inverse* temperature (mired).
 *  - Because the interpolation weight depends on the white, converting a neutral → xy needs a
 *    fixed-point iteration (`neutralToXY`).
 *
 * Non-RAW images are already white-balanced and output-referred, so their "temperature" and
 * "tint" are relative (−100…+100) and are applied as a Bradford adaptation in XYZ that treats the
 * image's encoded white (D65) as the source.
 */
import {
  type Mat3,
  type Vec3,
  type XY,
  D50_XYZ,
  D65_XYZ,
  XYZ_TO_WORKING,
  XYZtoXY,
  bradford,
  diag,
  inv,
  lerp,
  mul,
  mulVec,
  scale,
  xyToXYZ,
} from './matrices';

// ---------------------------------------------------------------------------
// Temperature/tint ↔ xy (Robertson's isotemperature lines, as used by the DNG SDK)
// ---------------------------------------------------------------------------

// [mired, u, v, slope of isotemperature line]
const ROBERTSON: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0.18006, 0.26352, -0.24341], [10, 0.18066, 0.26589, -0.25479], [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539], [40, 0.18293, 0.27407, -0.3047], [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156], [70, 0.18611, 0.28342, -0.37915], [80, 0.1874, 0.28668, -0.40955],
  [90, 0.1888, 0.28997, -0.44278], [100, 0.19032, 0.29326, -0.47888], [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471], [175, 0.20525, 0.31647, -0.84901], [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168], [250, 0.22511, 0.33439, -1.4512], [275, 0.23247, 0.33904, -1.7298],
  [300, 0.2401, 0.34308, -2.0637], [325, 0.24792, 0.34655, -2.4681], [350, 0.25591, 0.34951, -2.9641],
  [375, 0.264, 0.352, -3.5814], [400, 0.27218, 0.35407, -4.3633], [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262], [475, 0.29685, 0.35823, -8.5955], [500, 0.30505, 0.35907, -11.324],
  [525, 0.3132, 0.35968, -15.628], [550, 0.32129, 0.36011, -23.325], [575, 0.32931, 0.36038, -40.77],
  [600, 0.33724, 0.36051, -116.45],
];
const TINT_SCALE = -3000;

export const TEMP_MIN = 2000;
export const TEMP_MAX = 50000;
export const TINT_MIN = -150;
export const TINT_MAX = 150;

export function tempTintToXY(temperature: number, tint: number): [number, number] {
  const r = 1e6 / temperature;
  const offset = tint / TINT_SCALE;
  for (let i = 0; i < 30; i++) {
    if (r < ROBERTSON[i + 1][0] || i === 29) {
      const f = (ROBERTSON[i + 1][0] - r) / (ROBERTSON[i + 1][0] - ROBERTSON[i][0]);
      let u = ROBERTSON[i][1] * f + ROBERTSON[i + 1][1] * (1 - f);
      let v = ROBERTSON[i][2] * f + ROBERTSON[i + 1][2] * (1 - f);
      let uu1 = 1, vv1 = ROBERTSON[i][3];
      let uu2 = 1, vv2 = ROBERTSON[i + 1][3];
      const l1 = Math.hypot(uu1, vv1), l2 = Math.hypot(uu2, vv2);
      uu1 /= l1; vv1 /= l1; uu2 /= l2; vv2 /= l2;
      let uu3 = uu1 * f + uu2 * (1 - f), vv3 = vv1 * f + vv2 * (1 - f);
      const l3 = Math.hypot(uu3, vv3);
      uu3 /= l3; vv3 /= l3;
      u += uu3 * offset;
      v += vv3 * offset;
      const d = u - 4 * v + 2;
      return [(1.5 * u) / d, v / d];
    }
  }
  return [0.3127, 0.329];
}

export function xyToTempTint(xy: XY): { temperature: number; tint: number } {
  const d = 1.5 - xy[0] + 6 * xy[1];
  const u = (2 * xy[0]) / d;
  const v = (3 * xy[1]) / d;
  let lastDt = 0, lastDu = 0, lastDv = 0;
  for (let i = 1; i <= 30; i++) {
    let du = 1, dv = ROBERTSON[i][3];
    const len = Math.hypot(du, dv);
    du /= len; dv /= len;
    let uu = u - ROBERTSON[i][1];
    let vv = v - ROBERTSON[i][2];
    let dt = -uu * dv + vv * du;
    if (dt <= 0 || i === 30) {
      if (dt > 0) dt = 0;
      dt = -dt;
      const f = i === 1 ? 0 : dt / (lastDt + dt);
      const temperature = 1e6 / (ROBERTSON[i - 1][0] * f + ROBERTSON[i][0] * (1 - f));
      uu = u - (ROBERTSON[i - 1][1] * f + ROBERTSON[i][1] * (1 - f));
      vv = v - (ROBERTSON[i - 1][2] * f + ROBERTSON[i][2] * (1 - f));
      du = du * (1 - f) + lastDu * f;
      dv = dv * (1 - f) + lastDv * f;
      const l = Math.hypot(du, dv);
      du /= l; dv /= l;
      return { temperature, tint: (uu * du + vv * dv) * TINT_SCALE };
    }
    lastDt = dt; lastDu = du; lastDv = dv;
  }
  return { temperature: 6500, tint: 0 };
}

// ---------------------------------------------------------------------------
// RAW (DNG model)
// ---------------------------------------------------------------------------

/** Camera colour description extracted from a DNG / LibRaw. All matrices row-major 3×3. */
export interface RawColorProfile {
  /** XYZ → camera, for illuminant 1 / 2 (includes nothing else; CC and AB are separate). */
  colorMatrix1: Mat3;
  colorMatrix2?: Mat3;
  /** White-balanced camera → XYZ(D50), optional. */
  forwardMatrix1?: Mat3;
  forwardMatrix2?: Mat3;
  cameraCalibration1?: Mat3;
  cameraCalibration2?: Mat3;
  analogBalance?: Vec3;
  /** Correlated colour temperatures of the two calibration illuminants (K). */
  illuminantTemp1: number;
  illuminantTemp2: number;
  /** Camera-space neutral of the as-shot white. */
  asShotNeutral: Vec3;
  /** Exposure offset (EV) from the DNG BaselineExposure tag. */
  baselineExposure: number;
}

/** EXIF LightSource code → colour temperature, following the DNG SDK. */
export function illuminantToTemperature(code: number): number {
  switch (code) {
    case 17: case 3: return 2850; // Std A, Tungsten
    case 24: return 3200; // ISO studio tungsten
    case 23: return 5000; // D50
    case 20: case 1: case 9: case 4: case 18: return 5500; // D55, daylight, fine weather, flash, Std B
    case 21: case 19: case 10: return 6500; // D65, Std C, cloudy
    case 22: case 11: return 7500; // D75, shade
    case 12: return 6400; // daylight fluorescent
    case 13: return 5050; // day white fluorescent
    case 14: case 2: return 4150; // cool white fluorescent, fluorescent
    case 15: return 3525; // white fluorescent
    case 16: return 2925; // warm white fluorescent
    default: return 0;
  }
}

/**
 * Interpolation weight for matrix 1 at the given temperature: linear in mired between the two
 * calibration illuminants, clamped outside them (DNG spec, "Calibration Illuminants").
 */
function weight1(p: RawColorProfile, temperature: number): number {
  if (!p.colorMatrix2 || p.illuminantTemp1 <= 0 || p.illuminantTemp2 <= 0) return 1;
  let t1 = p.illuminantTemp1, t2 = p.illuminantTemp2;
  let swap = false;
  if (t1 > t2) { [t1, t2] = [t2, t1]; swap = true; }
  let g: number;
  if (temperature <= t1) g = 1;
  else if (temperature >= t2) g = 0;
  else g = (1 / temperature - 1 / t2) / (1 / t1 - 1 / t2);
  return swap ? 1 - g : g;
}

function interp(a: Mat3 | undefined, b: Mat3 | undefined, g: number): Mat3 | undefined {
  if (!a) return b;
  if (!b) return a;
  return lerp(a, b, g);
}

/** AB · CC · CM at a given white: XYZ → (non-white-balanced) camera space. */
function xyzToCamera(p: RawColorProfile, xy: XY): Mat3 {
  const { temperature } = xyToTempTint(xy);
  const g = weight1(p, temperature);
  const cm = interp(p.colorMatrix1, p.colorMatrix2, g)!;
  const cc = interp(p.cameraCalibration1, p.cameraCalibration2, g);
  let m = cm;
  if (cc) m = mul(cc, m);
  if (p.analogBalance) m = mul(diag(p.analogBalance), m);
  return m;
}

function normalizeMax(v: Vec3): Vec3 {
  const m = Math.max(v[0], v[1], v[2]);
  return m > 0 ? [v[0] / m, v[1] / m, v[2] / m] : [1, 1, 1];
}

/** Camera neutral → white xy (DNG SDK NeutralToXY): fixed-point iteration. */
export function neutralToXY(p: RawColorProfile, neutral: Vec3): [number, number] {
  let last: [number, number] = [D50_XYZ[0] / 2.7891, 1 / 2.7891]; // D50 xy
  for (let pass = 0; pass < 30; pass++) {
    const xyz = mulVec(inv(xyzToCamera(p, last)), neutral);
    const next = XYZtoXY(xyz);
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 1e-7) return next;
    // Damp oscillation on the last pass by averaging.
    last = pass === 29 ? [(last[0] + next[0]) / 2, (last[1] + next[1]) / 2] : next;
  }
  return last;
}

export function xyToNeutral(p: RawColorProfile, xy: XY): Vec3 {
  return normalizeMax(mulVec(xyzToCamera(p, xy), xyToXYZ(xy)));
}

export function neutralToTempTint(p: RawColorProfile, neutral: Vec3) {
  return xyToTempTint(neutralToXY(p, neutral));
}

export function tempTintToNeutral(p: RawColorProfile, temperature: number, tint: number): Vec3 {
  return xyToNeutral(p, tempTintToXY(temperature, tint));
}

export interface RawWbMatrices {
  /** Stage 10: per-channel camera-space multipliers (min = 1). */
  wbMul: Vec3;
  /** Stage 20: white-balanced camera RGB → linear Rec.2020 (includes BaselineExposure). */
  cameraToWorking: Mat3;
}

/**
 * Build the two matrices for a camera neutral.
 *
 * With a ForwardMatrix (DNG 1.2+): CameraToXYZ_D50 = FM · diag(1/refNeutral) · (AB·CC)⁻¹, where
 * FM already expects white-balanced input, so after our explicit WB step it is simply FM.
 * Without one: CameraToXYZ = (AB·CC·CM)⁻¹, adapted from the white's XYZ to D50 with Bradford, then
 * multiplied by diag(neutral) to undo the explicit WB step.
 * Finally XYZ(D50) → XYZ(D65) → Rec.2020, scaled so the white-balanced neutral (1,1,1) has Y = 1.
 */
export function rawMatrices(p: RawColorProfile, neutralIn: Vec3): RawWbMatrices {
  const neutral = normalizeMax(neutralIn);
  const wbMul: Vec3 = [1 / neutral[0], 1 / neutral[1], 1 / neutral[2]];
  const xy = neutralToXY(p, neutral);
  const { temperature } = xyToTempTint(xy);
  const g = weight1(p, temperature);

  let camToXYZD50: Mat3;
  const fm = interp(p.forwardMatrix1, p.forwardMatrix2, g);
  if (fm) {
    // Normalise so FM · (1,1,1) = D50 exactly (DNG SDK NormalizeForwardMatrix).
    const w = mulVec(fm, [1, 1, 1]);
    camToXYZD50 = mul(diag([D50_XYZ[0] / w[0], D50_XYZ[1] / w[1], D50_XYZ[2] / w[2]]), fm);
    const cc = interp(p.cameraCalibration1, p.cameraCalibration2, g);
    if (cc || p.analogBalance) {
      // Reference neutral in the un-calibrated camera space.
      let abcc = cc ?? diag([1, 1, 1]);
      if (p.analogBalance) abcc = mul(diag(p.analogBalance), abcc);
      const ref = normalizeMax(mulVec(inv(abcc), neutral));
      camToXYZD50 = mul(mul(mul(camToXYZD50, diag([1 / ref[0], 1 / ref[1], 1 / ref[2]])), inv(abcc)), diag(neutral));
    }
  } else {
    const camToXYZ = inv(xyzToCamera(p, xy));
    camToXYZD50 = mul(mul(bradford(xyToXYZ(xy), D50_XYZ), camToXYZ), diag(neutral));
  }

  const toD65 = bradford(D50_XYZ, D65_XYZ);
  let m = mul(XYZ_TO_WORKING, mul(toD65, camToXYZD50));
  const y = mulVec(mul(toD65, camToXYZD50), [1, 1, 1])[1];
  m = scale(m, Math.pow(2, p.baselineExposure) / y);
  return { wbMul, cameraToWorking: m };
}

// ---------------------------------------------------------------------------
// Non-RAW (relative)
// ---------------------------------------------------------------------------

// D65 expressed as temperature/tint (it sits slightly off the Planckian locus, so tint ≠ 0).
const D65_TT = xyToTempTint([0.3127, 0.329]);
const D65_MIRED = 1e6 / D65_TT.temperature;

/**
 * Relative temperature/tint (−100…+100) → the illuminant we assume the image's white really was.
 * Negative temperature says "the image's white is warmer than neutral" and cools the image.
 * The mired range is asymmetric so −100 fully neutralises a tungsten (≈2850 K) cast.
 */
export function relativeToTempTint(tRel: number, tintRel: number) {
  const mired = tRel < 0 ? D65_MIRED + (-tRel / 100) * 200 : D65_MIRED - (tRel / 100) * 100;
  return { temperature: 1e6 / mired, tint: D65_TT.tint + tintRel * 1.5 };
}

export function tempTintToRelative(temperature: number, tint: number) {
  const d = 1e6 / temperature - D65_MIRED;
  const tRel = d > 0 ? -(d / 200) * 100 : (-d / 100) * 100;
  return { temperature: clamp(tRel, -100, 100), tint: clamp((tint - D65_TT.tint) / 1.5, -100, 100) };
}

/**
 * Non-RAW WB as a matrix in the source's linear RGB: RGB→XYZ, Bradford from the assumed
 * illuminant to the encoded white (D65), back to RGB. (0, 0) is exactly the identity.
 */
export function displayWbMatrix(srcToXYZ: Mat3, tRel: number, tintRel: number): Mat3 {
  if (tRel === 0 && tintRel === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const { temperature, tint } = relativeToTempTint(tRel, tintRel);
  const cat = bradford(xyToXYZ(tempTintToXY(temperature, tint)), D65_XYZ);
  return mul(inv(srcToXYZ), mul(cat, srcToXYZ));
}

/** Solve the relative temp/tint that maps the given source-linear RGB sample to neutral. */
export function displayNeutralToRelative(srcToXYZ: Mat3, rgb: Vec3) {
  const tt = xyToTempTint(XYZtoXY(mulVec(srcToXYZ, rgb)));
  return tempTintToRelative(tt.temperature, tt.tint);
}

export function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

export const WB_PRESETS: Record<string, { label: string; temperature: number; tint: number }> = {
  daylight: { label: 'Daylight', temperature: 5500, tint: 10 },
  cloudy: { label: 'Cloudy', temperature: 6500, tint: 10 },
  shade: { label: 'Shade', temperature: 7500, tint: 10 },
  tungsten: { label: 'Tungsten', temperature: 2850, tint: 0 },
  fluorescent: { label: 'Fluorescent', temperature: 3800, tint: 21 },
  flash: { label: 'Flash', temperature: 5500, tint: 0 },
};
