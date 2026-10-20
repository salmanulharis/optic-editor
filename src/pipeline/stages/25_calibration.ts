/**
 * Stage 25 — calibration.
 * The R/G/B primary hue/saturation adjustments and the optional colour matrix are a single
 * white-preserving 3×3 matrix (src/color/calibration.ts) that is pre-multiplied into stage 10's
 * fused matrix: zero per-pixel cost. What remains here is the shadows tint, a green ↔ magenta
 * shift on OKLab a, weighted to shadows only (fading out by mid-grey and at pure black).
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform float cal_shadowTint;
vec4 cal_apply(vec4 c) {
  vec3 lab = toOklab(c.rgb);
  float w = (1.0 - smoothstep(0.12, 0.55, lab.x)) * smoothstep(0.0, 0.05, lab.x);
  lab.y += cal_shadowTint * w;
  return vec4(fromOklab(lab), c.a);
}
`;

export const calibrationStage: Stage = {
  id: 'cal',
  label: 'Calibration (shadows tint)',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.calibration.shadowTint !== 0,
  uniforms: (ctx) => ({ cal_shadowTint: u.f((ctx.recipe.calibration.shadowTint / 100) * 0.03) }),
};
