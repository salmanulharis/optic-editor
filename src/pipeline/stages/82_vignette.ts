/**
 * Stage 82 — post-crop vignette, always relative to the output (cropped) frame.
 *
 * Shape: a superellipse in frame-normalised coordinates. Roundness 0 follows the frame's aspect,
 * +100 is a circle, −100 tends to a rounded rectangle. Midpoint sets where the falloff starts,
 * feather its width.
 * Styles:
 *  - Highlight priority (default): an exposure change in linear light, with bright areas protected
 *    when darkening (so a lamp in the corner keeps its highlight), like a real lens vignette.
 *  - Color priority: the change is applied to OKLab lightness only, so hue and chroma hold.
 *  - Paint overlay: a blend toward black or white in the display (gamma) domain.
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform float vig_amt;     // −1…+1
uniform float vig_start;
uniform float vig_width;
uniform float vig_circle;  // 0 … 1: aspect correction toward a circle
uniform float vig_power;   // superellipse exponent
uniform float vig_protect;
uniform int vig_style;

float vig_mask() {
  vec2 d = (g_px / u_fullSize - 0.5) * 2.0;
  float aspect = u_fullSize.x / u_fullSize.y;
  // Toward a circle: compress the long axis.
  if (aspect > 1.0) d.x *= mix(1.0, aspect, vig_circle); else d.y *= mix(1.0, 1.0 / aspect, vig_circle);
  vec2 a = abs(d);
  float r = pow(pow(a.x, vig_power) + pow(a.y, vig_power), 1.0 / vig_power) / pow(2.0, 1.0 / vig_power) * 1.41421356;
  return smoothstep(vig_start, vig_start + vig_width, r);
}

vec4 vig_apply(vec4 c) {
  float m = vig_mask();
  if (m <= 0.0) return c;
  if (vig_style == 2) {
    vec3 e = pow(max(c.rgb, 0.0), vec3(1.0 / 2.2));
    e = mix(e, vec3(vig_amt < 0.0 ? 0.0 : 1.0), abs(vig_amt) * m);
    return vec4(pow(e, vec3(2.2)), c.a);
  }
  float ev = vig_amt * 2.0 * m;
  if (ev < 0.0) ev *= 1.0 - vig_protect * smoothstep(0.35, 1.0, luma(c.rgb));
  if (vig_style == 1) {
    vec3 lab = toOklab(c.rgb);
    lab.x *= exp2(ev / 3.0);
    return vec4(fromOklab(lab), c.a);
  }
  return vec4(c.rgb * exp2(ev), c.a);
}
`;

export const vignetteStage: Stage = {
  id: 'vig',
  label: 'Vignette',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.effects.vignette.amount !== 0,
  uniforms(ctx) {
    const v = ctx.recipe.effects.vignette;
    const round = v.roundness / 100;
    return {
      vig_amt: u.f(v.amount / 100),
      vig_start: u.f(0.15 + 0.9 * (v.midpoint / 100)),
      vig_width: u.f(0.05 + 1.1 * (v.feather / 100)),
      vig_circle: u.f(Math.max(0, round)),
      vig_power: u.f(2 + 4 * Math.max(0, -round)),
      vig_protect: u.f(v.highlights / 100),
      vig_style: u.i(v.style === 'paint' ? 2 : v.style === 'color' ? 1 : 0),
    };
  },
};
