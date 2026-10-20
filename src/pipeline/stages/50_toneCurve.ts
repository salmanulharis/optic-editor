/**
 * Stage 50 — tone curve. The four curves (RGB master, R, G, B) are baked into a 4096-entry float
 * LUT texture and applied on a gamma-2.2 encoding of the linear values (perceptually even, so
 * points on the curve editor correspond to what you see). Values above 1.0 continue with slope 1.
 */
import { isIdentityCurve } from '../../recipe/schema';
import { CURVE_LUT_SIZE } from '../gl/curveLut';
import type { Stage } from '../types';

const N = CURVE_LUT_SIZE.toFixed(1);
const glsl = /* glsl */ `
uniform sampler2D curve_lut;
vec4 curve_tap(float x) { return texture(curve_lut, vec2(clamp(x, 0.0, 1.0) * ((${N} - 1.0) / ${N}) + 0.5 / ${N}, 0.5)); }
vec4 curve_apply(vec4 c) {
  vec3 e = pow(max(c.rgb, 0.0), vec3(1.0 / 2.2));
  vec3 over = max(e - 1.0, 0.0);
  vec3 m = vec3(curve_tap(e.r).r, curve_tap(e.g).r, curve_tap(e.b).r) + over;
  vec3 o = vec3(curve_tap(m.r).g, curve_tap(m.g).b, curve_tap(m.b).a) + max(m - 1.0, 0.0);
  return vec4(pow(o, vec3(2.2)), c.a);
}
`;

export const toneCurveStage: Stage = {
  id: 'curve',
  label: 'Tone curve',
  kind: 'point',
  glsl,
  active: (ctx) => {
    const c = ctx.recipe.curve;
    return !(isIdentityCurve(c.rgb) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b));
  },
  uniforms: () => ({}),
  textures: (ctx, res) => ({ curve_lut: res.curves.get(ctx.recipe.curve) }),
};
