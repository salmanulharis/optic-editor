/**
 * Stage 40 — HSL colour mixer in OKLCH.
 * Eight bands with centres at the OKLCH hues of the named colours. For a pixel hue between two
 * adjacent centres we blend their adjustments with a raised-cosine weight; the weights of the two
 * neighbours always sum to 1, so there is no banding or seam between colours.
 * Adjustments fade out for near-neutral pixels (low chroma) so greys stay grey.
 */
import { HSL_BANDS } from '../../recipe/schema';
import type { Stage } from '../types';
import { u } from '../types';

/** OKLCH hue (degrees) of each band centre: red, orange, yellow, green, aqua, blue, purple, magenta. */
export const HSL_CENTERS_DEG = [29, 60, 105, 142, 195, 262, 295, 330];

const glsl = /* glsl */ `
uniform float hsl_centers[8];
uniform vec3 hsl_adj[8];     // hue shift (rad), saturation delta, luminance delta
uniform int hsl_protectSkin;
vec4 hsl_apply(vec4 c) {
  vec3 lch = toOklch(c.rgb);
  if (lch.y < 1e-5) return c;
  float h = lch.z;
  int i0 = 7;
  for (int i = 0; i < 8; i++) if (h >= hsl_centers[i]) i0 = i;
  int i1 = (i0 + 1) % 8;
  float span = hsl_centers[i1] - hsl_centers[i0];
  if (span <= 0.0) span += TAU;
  float d = h - hsl_centers[i0];
  if (d < 0.0) d += TAU;
  float w = 0.5 - 0.5 * cos(PI * clamp(d / span, 0.0, 1.0));
  vec3 adj = mix(hsl_adj[i0], hsl_adj[i1], w);
  float cw = smoothstep(0.0, 0.05, lch.y);
  if (hsl_protectSkin == 1) cw *= 1.0 - 0.85 * skinMask(h, lch.y);
  lch.z += adj.x * cw;
  lch.y *= max(0.0, 1.0 + adj.y * cw);
  lch.x *= 1.0 + adj.z * 0.35 * cw;
  return vec4(fromOklch(lch), c.a);
}
`;

export const hslStage: Stage = {
  id: 'hsl',
  label: 'Colour mixer',
  kind: 'point',
  glsl,
  active: (ctx) => HSL_BANDS.some((b) => {
    const a = ctx.recipe.hsl.bands[b];
    return a.hue !== 0 || a.sat !== 0 || a.lum !== 0;
  }),
  uniforms(ctx) {
    const adj = new Float32Array(24);
    HSL_BANDS.forEach((b, i) => {
      const a = ctx.recipe.hsl.bands[b];
      adj[i * 3] = ((a.hue / 100) * 30 * Math.PI) / 180;
      adj[i * 3 + 1] = a.sat / 100;
      adj[i * 3 + 2] = a.lum / 100;
    });
    return {
      hsl_centers: { t: 'fa', v: Float32Array.from(HSL_CENTERS_DEG, (d) => (d * Math.PI) / 180) },
      hsl_adj: { t: 'v3a', v: adj },
      hsl_protectSkin: u.i(ctx.recipe.presence.protectSkin),
    };
  },
};
