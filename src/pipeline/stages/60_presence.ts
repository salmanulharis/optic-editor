/**
 * Stage 60 — presence: vibrance and saturation in OKLCH (chroma scaling at constant L and hue).
 * Vibrance weights the boost toward low-chroma colours and always protects skin hues
 * (≈ 20°–70°); saturation is uniform unless "protect skin tones" is on.
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform float pres_vibrance;
uniform float pres_saturation;
uniform int pres_protectSkin;
vec4 pres_apply(vec4 c) {
  vec3 lch = toOklch(c.rgb);
  if (lch.y < 1e-6) return c;
  float skin = skinMask(lch.z, lch.y);
  float lowC = 1.0 - smoothstep(0.02, 0.22, lch.y);
  float vib = pres_vibrance * lowC * (pres_vibrance > 0.0 ? 1.0 - 0.75 * skin : 1.0);
  float sat = pres_saturation * (pres_protectSkin == 1 ? 1.0 - 0.8 * skin : 1.0);
  lch.y *= max(0.0, 1.0 + vib) * max(0.0, 1.0 + sat);
  return vec4(fromOklch(lch), c.a);
}
`;

export const presenceStage: Stage = {
  id: 'pres',
  label: 'Presence',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.presence.vibrance !== 0 || ctx.recipe.presence.saturation !== 0,
  uniforms: (ctx) => ({
    pres_vibrance: u.f(ctx.recipe.presence.vibrance / 100),
    pres_saturation: u.f(ctx.recipe.presence.saturation / 100),
    pres_protectSkin: u.i(ctx.recipe.presence.protectSkin),
  }),
};
