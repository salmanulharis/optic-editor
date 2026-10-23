/**
 * The ordered stage list. Order matters and mirrors the file prefixes.
 * To add a stage: create `NN_name.ts` exporting a `Stage`, then insert it here at its position.
 */
import { inputStage } from './00_input';
import { lensStage } from './05_lensCorrection';
import { whiteBalanceStage } from './10_whiteBalance';
import { cameraToWorkingStage } from './20_cameraToWorking';
import { noiseReductionStage } from './22_noiseReduction';
import { calibrationStage } from './25_calibration';
import { colorCastStage } from './27_colorCast';
import { dehazeStage } from './28_dehaze';
import { exposureToneStage } from './30_exposureTone';
import { clarityStage, textureStage } from './35_clarityTexture';
import { hslStage } from './40_hsl';
import { pointColorStage } from './45_pointColor';
import { toneCurveStage } from './50_toneCurve';
import { bwMixerStage } from './52_bwMixer';
import { colorGradingStage } from './55_colorGrading';
import { presenceStage } from './60_presence';
import { lutStage } from './70_lut';
import { lookStage } from './75_look';
import { localStage } from './78_localAdjustments';
import { glowStage } from './80_halationBloom';
import { vignetteStage } from './82_vignette';
import { grainStage } from './84_grain';
import { sharpenStage } from './86_sharpening';
import { outputStage } from './90_output';
import type { Stage } from '../types';

export const STAGES: readonly Stage[] = [
  inputStage,
  lensStage, // compiled into the first pass: output → source mapping, lens model
  whiteBalanceStage, // + camera→working + calibration matrix, pre-multiplied
  cameraToWorkingStage,
  noiseReductionStage, // spatial: linear data, before contrast amplifies noise
  calibrationStage,
  colorCastStage,
  dehazeStage,
  exposureToneStage,
  textureStage, // spatial
  clarityStage,
  hslStage,
  pointColorStage,
  toneCurveStage,
  bwMixerStage, // before grading on purpose: split-tones need grading after the grey conversion
  colorGradingStage,
  presenceStage,
  lutStage,
  lookStage,
  localStage, // spatial: masks (local adjustments)
  glowStage,
  vignetteStage, // post-crop
  grainStage, // late, so the grain is not colour-graded
  sharpenStage, // spatial: output sharpening after all tone and colour
  outputStage,
];
