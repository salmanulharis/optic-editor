/**
 * Stage 86 — output sharpening (spatial), after all tone and colour work.
 *
 * Unsharp mask on OKLab lightness only (no colour fringes):
 *   L' = L + amount · (L − blur_σ(L)) · mask
 *  - σ = Radius (0.5–3 px at a 24 MP reference) scaled by the image's long edge, then to target
 *    pixels: the same relative radius in the Fit preview, at 100 % and in the export.
 *  - Halo suppression: L' is clamped to the 3×3 local [min, max] widened by an overshoot that Detail
 *    controls (low Detail = almost no overshoot = no halos; high Detail = crisper fine texture).
 *  - Masking: an edge mask from the gradient of the blurred lightness, measured across the radius,
 *    so flat areas (skin, sky) stay untouched. Alt-dragging Masking shows the mask (white = sharpened).
 * The change is applied as a lightness difference to the full-precision pixel.
 */
import { OKLAB_GLSL } from '../../color/oklab';
import type { Stage, StageContext, StageTextures } from '../types';
import { u } from '../types';

/** OKLab lightness of the previous pass. */
const SH_L_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 o;
uniform sampler2D u_src;
${OKLAB_GLSL}
void main() {
  vec3 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb;
  float L = toOklab(c).x;
  o = vec4(L, L, L, 1.0);
}`;

const glsl = /* glsl */ `
uniform sampler2D sh_L;
uniform sampler2D sh_B;
uniform float sh_amt;
uniform float sh_over;
uniform float sh_thr;
uniform float sh_sigma;
uniform int sh_view;

vec4 sh_apply(sampler2D prev, ivec2 fc) {
  vec4 c = texelFetch(prev, fc, 0);
  ivec2 s = textureSize(sh_L, 0) - 1;
  float L = texelFetch(sh_L, fc, 0).r;
  float B = texelFetch(sh_B, fc, 0).r;
  float lo = L, hi = L;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float v = texelFetch(sh_L, clamp(fc + ivec2(i, j), ivec2(0), s), 0).r;
    lo = min(lo, v); hi = max(hi, v);
  }
  float m = 1.0;
  if (sh_thr > 0.0) {
    float gx = texelFetch(sh_B, clamp(fc + ivec2(1, 0), ivec2(0), s), 0).r - texelFetch(sh_B, clamp(fc - ivec2(1, 0), ivec2(0), s), 0).r;
    float gy = texelFetch(sh_B, clamp(fc + ivec2(0, 1), ivec2(0), s), 0).r - texelFetch(sh_B, clamp(fc - ivec2(0, 1), ivec2(0), s), 0).r;
    // Contrast across the sharpening radius (dimensionless, independent of the zoom).
    float g = 0.5 * length(vec2(gx, gy)) * max(sh_sigma, 1.0);
    m = smoothstep(sh_thr * 0.4, sh_thr * 1.6, g);
  }
  if (sh_view == 1) return vec4(vec3(m * m), 1.0);
  float Ls = L + sh_amt * (L - B) * m;
  float ov = sh_over * (hi - lo) + 0.002;
  Ls = clamp(Ls, lo - ov, hi + ov);
  vec3 lab = toOklab(c.rgb);
  lab.x += Ls - L;
  return vec4(fromOklab(lab), c.a);
}
`;

/** Blur σ in target pixels. */
function sigma(ctx: StageContext) {
  return (ctx.recipe.detail.sharpen.radius * (ctx.longEdge / 6000)) / ctx.pxScale;
}

export const sharpenStage: Stage = {
  id: 'sh',
  label: 'Sharpening',
  kind: 'spatial',
  glsl,
  skipInMaps: true,
  helpers: [SH_L_FS],
  // At strong zoom-out the radius is far below a screen pixel: nothing visible to sharpen.
  active: (ctx) => (ctx.recipe.detail.sharpen.amount > 0 && sigma(ctx) >= 0.25) || (ctx.target.maskView === 'sharpen' && ctx.recipe.detail.sharpen.amount > 0),
  reach: (ctx) => Math.ceil(3 * Math.max(sigma(ctx), 0.3)) + 3,
  uniforms(ctx) {
    const s = ctx.recipe.detail.sharpen;
    return {
      sh_amt: u.f((s.amount / 100) * 1.6),
      sh_over: u.f(0.04 + 0.5 * (s.detail / 100)),
      sh_thr: u.f(Math.pow(s.masking / 100, 2) * 0.12),
      sh_sigma: u.f(sigma(ctx)),
      sh_view: u.i(ctx.target.maskView === 'sharpen'),
    };
  },
  prepare(ctx, input, kit): StageTextures {
    const L = kit.rt('sh:L', input.width, input.height, 'rg16f');
    kit.draw(SH_L_FS, L, {}, { u_src: input.tex });
    const B = kit.gauss(L, Math.max(sigma(ctx), 0.3), 'sh:B', 'rg16f');
    return { sh_L: L.tex, sh_B: B.tex };
  },
};
