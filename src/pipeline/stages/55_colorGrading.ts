/**
 * Stage 55 — colour grading: shadows / midtones / highlights / global wheels.
 *
 * Works in OKLab (perceptual): each wheel adds a chroma offset in the direction of its hue (OKLCH
 * hue, the same hue the wheel displays) proportional to its saturation, and scales lightness by its
 * luminance slider. Zone masks are smooth functions of OKLab L whose overlap is set by Blending and
 * whose boundaries move with Balance. Offsets are additive, so with all saturations at 0 neutrals
 * stay exactly neutral; on a monochrome image the offsets create the split tone.
 */
import type { Recipe, Wheel } from '../../recipe/schema';
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform vec2 cg_s;
uniform vec2 cg_m;
uniform vec2 cg_h;
uniform vec2 cg_g;
uniform vec4 cg_lum;   // shadows, midtones, highlights, global (lightness factor deltas)
uniform vec3 cg_zone;  // low boundary, high boundary, half-width
vec4 cg_apply(vec4 c) {
  vec3 lab = toOklab(c.rgb);
  float t = clamp(lab.x, 0.0, 1.0);
  float ws = 1.0 - smoothstep(cg_zone.x - cg_zone.z, cg_zone.x + cg_zone.z, t);
  float wh = smoothstep(cg_zone.y - cg_zone.z, cg_zone.y + cg_zone.z, t);
  float wm = max(0.0, 1.0 - ws - wh);
  float fade = smoothstep(0.0, 0.06, t);
  lab.yz += (ws * cg_s + wm * cg_m + wh * cg_h + cg_g) * fade;
  lab.x *= max(0.0, 1.0 + ws * cg_lum.x + wm * cg_lum.y + wh * cg_lum.z + cg_lum.w);
  return vec4(fromOklab(lab), c.a);
}
`;

/** Wheel → OKLab (a, b) offset; saturation 100 ≈ 0.06 chroma. */
export function wheelOffset(w: Wheel): [number, number] {
  const k = (w.sat / 100) * 0.06;
  const h = (w.hue * Math.PI) / 180;
  return [k * Math.cos(h), k * Math.sin(h)];
}

const isZero = (w: Wheel) => w.sat === 0 && w.lum === 0;

export function gradingActive(g: Recipe['colorGrading']) {
  return !(isZero(g.shadows) && isZero(g.midtones) && isZero(g.highlights) && isZero(g.global));
}

export const colorGradingStage: Stage = {
  id: 'cg',
  label: 'Color grading',
  kind: 'point',
  glsl,
  active: (ctx) => gradingActive(ctx.recipe.colorGrading),
  uniforms(ctx) {
    const g = ctx.recipe.colorGrading;
    const shift = (-g.balance / 100) * 0.15;
    return {
      cg_s: u.v2(...wheelOffset(g.shadows)),
      cg_m: u.v2(...wheelOffset(g.midtones)),
      cg_h: u.v2(...wheelOffset(g.highlights)),
      cg_g: u.v2(...wheelOffset(g.global)),
      cg_lum: u.v4(g.shadows.lum / 400, g.midtones.lum / 400, g.highlights.lum / 400, g.global.lum / 400),
      cg_zone: u.v3([0.3 + shift, 0.7 + shift, 0.04 + (g.blending / 100) * 0.26]),
    };
  },
};
