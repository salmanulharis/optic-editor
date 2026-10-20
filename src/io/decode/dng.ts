/** DNG tag extraction: colour profile, main image IFD, levels. */
import type { Mat3, Vec3 } from '../../color/matrices';
import { type RawColorProfile, illuminantToTemperature, xyToNeutral } from '../../color/whiteBalance';
import { type Ifd, TiffReader } from '../metadata/tiffReader';

export const TAG = {
  NewSubFileType: 254,
  Width: 256,
  Height: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  DNGVersion: 50706,
  LinearizationTable: 50712,
  BlackLevelRepeatDim: 50713,
  BlackLevel: 50714,
  WhiteLevel: 50717,
  DefaultCropOrigin: 50719,
  DefaultCropSize: 50720,
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  CameraCalibration1: 50723,
  CameraCalibration2: 50724,
  AnalogBalance: 50727,
  AsShotNeutral: 50728,
  AsShotWhiteXY: 50729,
  BaselineExposure: 50730,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
} as const;

export const COMPRESSION_JXL = 52546;

export function isTiffLike(b: Uint8Array) {
  return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42);
}

export function isDng(r: TiffReader): boolean {
  return !!r.ifds[0]?.entries.has(TAG.DNGVersion);
}

/** The full-resolution raw image IFD: NewSubFileType 0 with the largest width. */
export function mainImageIfd(r: TiffReader): Ifd | null {
  let best: Ifd | null = null, bestW = 0;
  for (const ifd of r.allIfds()) {
    const type = r.get(ifd, TAG.NewSubFileType)?.[0] ?? 0;
    const w = r.get(ifd, TAG.Width)?.[0] ?? 0;
    if (type === 0 && w > bestW) { best = ifd; bestW = w; }
  }
  return best;
}

function mat3x3(v: number[] | undefined): Mat3 | undefined {
  if (!v || v.length < 9) return undefined;
  return v.slice(0, 9);
}

/** Read the camera colour profile from IFD0 (where DNG stores it). */
export function dngColorProfile(r: TiffReader): RawColorProfile {
  const ifd0 = r.ifds[0];
  const g = (t: number) => r.get(ifd0, t);
  const cm1 = mat3x3(g(TAG.ColorMatrix1));
  if (!cm1) throw new Error('DNG has no ColorMatrix1');
  const neutral = g(TAG.AsShotNeutral);
  const ab = g(TAG.AnalogBalance);
  const asShotNeutral: Vec3 = neutral && neutral.length >= 3 ? [neutral[0], neutral[1], neutral[2]] : [1, 1, 1];
  const profile: RawColorProfile = {
    colorMatrix1: cm1,
    colorMatrix2: mat3x3(g(TAG.ColorMatrix2)),
    forwardMatrix1: mat3x3(g(TAG.ForwardMatrix1)),
    forwardMatrix2: mat3x3(g(TAG.ForwardMatrix2)),
    cameraCalibration1: mat3x3(g(TAG.CameraCalibration1)),
    cameraCalibration2: mat3x3(g(TAG.CameraCalibration2)),
    analogBalance: ab && ab.length >= 3 ? [ab[0], ab[1], ab[2]] : undefined,
    illuminantTemp1: illuminantToTemperature(g(TAG.CalibrationIlluminant1)?.[0] ?? 21) || 6500,
    illuminantTemp2: illuminantToTemperature(g(TAG.CalibrationIlluminant2)?.[0] ?? 21) || 6500,
    asShotNeutral,
    baselineExposure: g(TAG.BaselineExposure)?.[0] ?? 0,
  };
  // Some DNGs specify the as-shot white as a chromaticity instead of a camera neutral.
  const wxy = g(TAG.AsShotWhiteXY);
  if (!neutral && wxy && wxy.length >= 2) profile.asShotNeutral = xyToNeutral(profile, [wxy[0], wxy[1]]);
  return profile;
}

/** LibRaw's 4×3 cam_xyz (XYZ(D65) → camera, one illuminant) as a single-matrix profile. */
export function libRawColorProfile(camXyz: number[][], camMul: number[], preMul: number[]): RawColorProfile {
  const cm: Mat3 = [0, 1, 2].flatMap((i) => [camXyz[i][0], camXyz[i][1], camXyz[i][2]]);
  const mul = camMul && camMul[0] > 0 && camMul[1] > 0 ? camMul : preMul;
  const n: Vec3 = mul && mul[0] > 0 ? [mul[1] / mul[0], 1, mul[1] / mul[2]] : [1, 1, 1];
  return {
    colorMatrix1: cm,
    illuminantTemp1: 6500,
    illuminantTemp2: 6500,
    asShotNeutral: n,
    baselineExposure: 0,
  };
}
