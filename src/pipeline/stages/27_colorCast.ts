/**
 * Stage 27 — remove colour cast (after calibration, before tone). The cast tool estimates an OKLab (a, b) offset separately for
 * shadows, midtones and highlights (mixed lighting) and stores it in the recipe. Here we subtract
 * it with smooth zone weights that sum to 1, scaled by the strength slider.
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform vec2 cast_s;
uniform vec2 cast_m;
uniform vec2 cast_h;
uniform float cast_strength;
vec4 cast_apply(vec4 c) {
  vec3 lab = toOklab(c.rgb);
  float L = clamp(lab.x, 0.0, 1.0);
  float ws = 1.0 - smoothstep(0.15, 0.5, L);
  float wh = smoothstep(0.5, 0.85, L);
  float wm = max(0.0, 1.0 - ws - wh);
  // Fade the correction out towards black so deep shadows don't get tinted the opposite way.
  float fade = smoothstep(0.0, 0.08, L);
  lab.yz -= (ws * cast_s + wm * cast_m + wh * cast_h) * cast_strength * fade;
  return vec4(fromOklab(lab), c.a);
}
`;

export const colorCastStage: Stage = {
  id: 'cast',
  label: 'Remove colour cast',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.whiteBalance.castStrength > 0 && !!ctx.recipe.whiteBalance.castEstimate,
  uniforms(ctx) {
    const e = ctx.recipe.whiteBalance.castEstimate!;
    return {
      cast_s: u.v2(...e.shadows),
      cast_m: u.v2(...e.midtones),
      cast_h: u.v2(...e.highlights),
      cast_strength: u.f(ctx.recipe.whiteBalance.castStrength / 100),
    };
  },
};
