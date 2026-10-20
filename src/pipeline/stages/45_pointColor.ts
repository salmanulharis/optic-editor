/**
 * Stage 45 — point colour. Up to 8 sampled colours (OKLCH targets). Each point's mask is the
 * product of three smooth window functions — hue distance, chroma distance, lightness distance —
 * whose widths come from the range sliders and whose edge softness comes from "smoothness".
 * Near-neutral pixels (no defined hue) are excluded. Inside the mask the point shifts hue, chroma
 * and lightness, and "uniformity" pulls hues toward the target hue (evens out blotchy skin).
 *
 * Branchless over a fixed loop of 8; unused slots have zero weight. "Visualize range" outputs the
 * combined mask as grey instead (the viewer neutralises the later stages while it is on).
 */
import { MAX_COLOR_POINTS } from '../../recipe/schema';
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform vec3 pc_target[8];   // L, C, h (rad)
uniform vec3 pc_shift[8];    // hue (rad), chroma factor delta, lightness factor delta
uniform vec4 pc_range[8];    // hue half-width (rad), chroma half-width, L half-width, softness
uniform float pc_uniform[8];
uniform float pc_on[8];
uniform int pc_visualize;

float pc_window(float d, float r, float soft) {
  return 1.0 - smoothstep(r * (1.0 - soft), r * (1.0 + soft) + 1e-5, d);
}

vec4 pc_apply(vec4 c) {
  vec3 lch = toOklch(c.rgb);
  float defined = smoothstep(0.004, 0.02, lch.y);
  float maskMax = 0.0;
  for (int i = 0; i < 8; i++) {
    vec3 t = pc_target[i];
    vec4 r = pc_range[i];
    float dh = lch.z - t.z;
    dh = dh - TAU * floor((dh + PI) / TAU);       // wrap to [-π, π)
    float m = pc_on[i] * defined
      * pc_window(abs(dh), r.x, r.w)
      * pc_window(abs(lch.y - t.y), r.y, r.w)
      * pc_window(abs(lch.x - t.x), r.z, r.w);
    maskMax = max(maskMax, m);
    vec3 s = pc_shift[i];
    lch.z += m * (s.x - pc_uniform[i] * dh);
    lch.y *= max(0.0, 1.0 + m * s.y);
    lch.x *= 1.0 + m * s.z;
  }
  if (pc_visualize == 1) return vec4(vec3(pow(maskMax, 2.2)), c.a);
  return vec4(fromOklch(lch), c.a);
}
`;

export const pointColorStage: Stage = {
  id: 'pc',
  label: 'Point color',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.pointColor.points.length > 0 || !!ctx.target.visualizePointColor,
  uniforms(ctx) {
    const N = MAX_COLOR_POINTS;
    const target = new Float32Array(N * 3), shift = new Float32Array(N * 3), range = new Float32Array(N * 4);
    const uni = new Float32Array(N), on = new Float32Array(N);
    ctx.recipe.pointColor.points.slice(0, N).forEach((p, i) => {
      target.set([p.target.L, p.target.C, (p.target.h * Math.PI) / 180], i * 3);
      shift.set([((p.hue / 100) * 30 * Math.PI) / 180, p.sat / 100, (p.lum / 100) * 0.3], i * 3);
      range.set([
        ((4 + (p.hueRange / 100) * 86) * Math.PI) / 180, // 4°…90° half-width
        0.01 + (p.satRange / 100) * 0.2,
        0.03 + (p.lumRange / 100) * 0.6,
        0.1 + (p.smoothness / 100) * 0.8,
      ], i * 4);
      uni[i] = (p.uniformity / 100) * 0.85;
      on[i] = 1;
    });
    return {
      pc_target: { t: 'v3a', v: target },
      pc_shift: { t: 'v3a', v: shift },
      pc_range: { t: 'v4a', v: range },
      pc_uniform: { t: 'fa', v: uni },
      pc_on: { t: 'fa', v: on },
      pc_visualize: u.i(!!ctx.target.visualizePointColor),
    };
  },
};
