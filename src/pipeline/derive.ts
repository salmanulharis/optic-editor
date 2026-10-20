/**
 * Values derived from (image, recipe) once per render rather than per pixel.
 *
 * Phase 2: white balance, camera → working and calibration are pre-multiplied into ONE matrix
 * (`fused`), so all three cost a single mat3 multiply on the GPU. The clipped-highlight handling
 * that sits between WB and the camera matrix is expressed with two precomputed vectors so it
 * still works on the fused path (see stage 10).
 */
import { calibrationMatrix } from '../color/calibration';
import { type Mat3, type Vec3, XYZ_TO_WORKING, diag, mul, mulVec, transpose } from '../color/matrices';
import {
  displayWbMatrix,
  neutralToTempTint,
  rawMatrices,
  tempTintToNeutral,
} from '../color/whiteBalance';
import type { Recipe } from '../recipe/schema';
import type { ImageModel } from './types';

export interface Derived {
  /** Stage 10 matrix (RAW: diagonal multipliers; non-RAW: Bradford adaptation in source RGB). */
  wbMatrix: Mat3;
  /** (White-balanced) source → linear Rec.2020. */
  toWorking: Mat3;
  /** Calibration matrix in working space (identity at default). */
  calibration: Mat3;
  /** calibration · toWorking · wbMatrix — what the GPU actually applies. */
  fused: Mat3;
  /** RAW: per-channel WB multipliers (for the clipped-neutral level min3(mul ⊙ src)). */
  wbMul: Vec3;
  /** Non-RAW: wbMatrixᵀ · luma, so dot(src, lumaVec) = luma of the white-balanced source. */
  lumaVec: Vec3;
  /** calibration · toWorking · (1,1,1): where a white-balanced neutral of level 1 lands. */
  neutralOut: Vec3;
  /** Camera neutral currently in use (RAW only). */
  neutral?: Vec3;
}

export function asShotTempTint(image: ImageModel): { temperature: number; tint: number } {
  if (image.color.kind === 'raw') {
    const tt = neutralToTempTint(image.color.profile, image.color.profile.asShotNeutral);
    return { temperature: Math.round(tt.temperature), tint: Math.round(tt.tint) };
  }
  return { temperature: 0, tint: 0 };
}

let memoKey = '';
let memoImage: ImageModel | null = null;
let memoValue: Derived | null = null;

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

export function derive(image: ImageModel, recipe: Recipe): Derived {
  const wb = recipe.whiteBalance;
  const c = recipe.calibration;
  const key = `${wb.mode}|${wb.temperature}|${wb.tint}|${JSON.stringify([c.red, c.green, c.blue, c.matrix])}`;
  if (memoImage === image && memoKey === key && memoValue) return memoValue;
  let wbMatrix: Mat3, toWorking: Mat3, wbMul: Vec3 = [1, 1, 1], neutral: Vec3 | undefined;
  if (image.color.kind === 'raw') {
    const p = image.color.profile;
    // "As Shot" uses the camera's AsShotNeutral directly (no round trip through temp/tint).
    neutral = wb.mode === 'asShot' ? p.asShotNeutral : tempTintToNeutral(p, wb.temperature, wb.tint);
    const m = rawMatrices(p, neutral);
    wbMul = m.wbMul;
    wbMatrix = diag(m.wbMul);
    toWorking = m.cameraToWorking;
  } else {
    const toXYZ = image.color.toXYZ;
    wbMatrix = displayWbMatrix(toXYZ, wb.temperature, wb.tint);
    toWorking = mul(XYZ_TO_WORKING, toXYZ);
  }
  const calibration = calibrationMatrix(c);
  const post = mul(calibration, toWorking);
  const value: Derived = {
    wbMatrix,
    toWorking,
    calibration,
    fused: mul(post, wbMatrix),
    wbMul,
    lumaVec: mulVec(transpose(wbMatrix), LUMA),
    neutralOut: mulVec(post, [1, 1, 1]),
    neutral,
  };
  memoKey = key;
  memoImage = image;
  memoValue = value;
  return value;
}
