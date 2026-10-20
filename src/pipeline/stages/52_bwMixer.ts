/**
 * Stage 52 — black & white mixer (only when treatment = monochrome).
 *
 * Placed BEFORE colour grading (55), deliberately: the spec listed it at 65, but then grading
 * would be erased by the conversion and split-tone / selenium / sepia looks would be impossible.
 * The grey is the pixel's luminance, re-weighted per colour band (raised-cosine weights, same band
 * centres as the HSL mixer) by up to ±1.2 EV, scaled by chroma so neutrals are unaffected.
 * `mix` blends with the colour image (used by preset amounts < 100 %).
 */
import { HSL_BANDS } from '../../recipe/schema';
import type { Stage } from '../types';
import { u } from '../types';
import { HSL_CENTERS_DEG } from './40_hsl';

const glsl = /* glsl */ `
uniform float bw_centers[8];
uniform float bw_adj[8];
uniform float bw_mix;
vec4 bw_apply(vec4 c) {
  vec3 lch = toOklch(c.rgb);
  float h = lch.z;
  int i0 = 7;
  for (int i = 0; i < 8; i++) if (h >= bw_centers[i]) i0 = i;
  int i1 = (i0 + 1) % 8;
  float span = bw_centers[i1] - bw_centers[i0];
  if (span <= 0.0) span += TAU;
  float d = h - bw_centers[i0];
  if (d < 0.0) d += TAU;
  float w = 0.5 - 0.5 * cos(PI * clamp(d / span, 0.0, 1.0));
  float adj = mix(bw_adj[i0], bw_adj[i1], w) * smoothstep(0.0, 0.14, lch.y);
  float grey = max(luma(c.rgb), 0.0) * exp2(adj * 1.2);
  return vec4(mix(c.rgb, vec3(grey), bw_mix), c.a);
}
`;

export const bwMixerStage: Stage = {
  id: 'bw',
  label: 'B&W mixer',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.treatment === 'monochrome' && ctx.recipe.bwMixer.mix > 0,
  uniforms: (ctx) => ({
    bw_centers: { t: 'fa', v: Float32Array.from(HSL_CENTERS_DEG, (x) => (x * Math.PI) / 180) },
    bw_adj: { t: 'fa', v: Float32Array.from(HSL_BANDS, (b) => ctx.recipe.bwMixer[b] / 100) },
    bw_mix: u.f(ctx.recipe.bwMixer.mix / 100),
  }),
};
