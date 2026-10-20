/**
 * Stage 10 — white balance, camera → working and calibration in ONE matrix multiply.
 * The three matrices are pre-multiplied on the CPU (`derive.fused`); stages 20 and 25 keep their
 * files for documentation and for the parts that are not matrices (25: shadow tint).
 *
 * White balance itself: RAW uses per-channel camera multipliers from the DNG colour model,
 * non-RAW a Bradford adaptation in the source's linear RGB (identity at As Shot).
 *
 * Clipped highlights (source mask in alpha):
 *  - RAW: channels saturate at different levels after WB, which turns blown areas magenta.
 *    Blend toward a neutral at the lowest WB-scaled channel level, min3(mul ⊙ src).
 *  - Non-RAW: the mask only covers clipped *near-white* pixels (stage 00); they are kept neutral
 *    at their luminance so that removing a cast doesn't paint them the complementary colour.
 * A neutral of level m lands at m · neutralOut after the fused matrix, so no second multiply.
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform mat3 wb_fused;
uniform int wb_raw;
uniform vec3 wb_mul;
uniform vec3 wb_lumaVec;
uniform vec3 wb_neutralOut;
vec4 wb_apply(vec4 c) {
  vec3 w = wb_fused * c.rgb;
  if (c.a > 0.0) {
    float m = wb_raw == 1 ? min3(wb_mul * c.rgb) : dot(c.rgb, wb_lumaVec);
    w = mix(w, m * wb_neutralOut, c.a);
  }
  return vec4(w, c.a);
}
`;

export const whiteBalanceStage: Stage = {
  id: 'wb',
  label: 'White balance · camera matrix · calibration',
  kind: 'point',
  glsl,
  active: () => true,
  uniforms: (ctx) => ({
    wb_fused: u.m3(ctx.derived.fused),
    wb_raw: u.i(ctx.image.isRaw),
    wb_mul: u.v3(ctx.derived.wbMul),
    wb_lumaVec: u.v3(ctx.derived.lumaVec),
    wb_neutralOut: u.v3(ctx.derived.neutralOut),
  }),
};
