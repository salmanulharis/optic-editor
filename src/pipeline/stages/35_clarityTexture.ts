/**
 * Stage 35 — texture and clarity: local contrast in log luminance (hue and saturation kept).
 *
 * Both split log2(Y) into an edge-aware base and detail with a guided filter (self-guided, so the
 * base keeps strong edges and the detail holds texture, not halos), then scale the detail.
 *
 *  - Texture (`tex`, spatial, small radius ≈ 0.25 % of the long edge): the filter runs on the
 *    render itself, with its coefficients computed at up to 1/4 resolution (fast guided filter)
 *    and applied to the full-resolution guide. Negative values smooth fine texture (skin) without
 *    blurring edges, which stay in the base.
 *  - Clarity (`cl`, point, medium-large radius ≈ 1.2 % of the long edge): the coefficients come from
 *    an image-wide 1024 px map of the image after stage 30, applied per pixel to the
 *    full-resolution log luminance: edge-aware at any zoom, identical in preview and every export
 *    tile. Deep shadows and highlights are protected; the midtones get the punch.
 */
import { GF_COEF_FS, guidedCoefficients } from '../gl/guidedFilter';
import type { MapSpec, Stage, StageContext, StageTextures } from '../types';
import { u } from '../types';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
const vec3 LUMA = vec3(0.2627, 0.6780, 0.0593);
float lg(vec3 c) { return log2(max(dot(c, LUMA), 1e-5)); }
`;

/** Self-guided stats of log luminance, box-averaged over factor × factor blocks. */
const STATS_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform int u_factor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * u_factor, s = textureSize(u_src, 0) - 1;
  vec2 acc = vec2(0.0);
  for (int j = 0; j < u_factor; j++) for (int i = 0; i < u_factor; i++) {
    float g = lg(texelFetch(u_src, min(p + ivec2(i, j), s), 0).rgb);
    acc += vec2(g, g * g);
  }
  acc /= float(u_factor * u_factor);
  o = vec4(acc.x, acc.y, acc.x, acc.y);
}`;

const CLARITY_EDGE = 1024;
const CLARITY_RADIUS = 0.012;
const TEXTURE_RADIUS = 0.0025;

const texGlsl = /* glsl */ `
uniform sampler2D tex_coef;
uniform float tex_amt;
uniform float tex_s;

vec4 tex_apply(sampler2D prev, ivec2 fc) {
  vec4 c = texelFetch(prev, fc, 0);
  float g = log2(max(luma(c.rgb), 1e-5));
  vec2 uv = (vec2(fc) + 0.5) / (vec2(textureSize(tex_coef, 0)) * tex_s);
  vec2 ab = texture(tex_coef, uv).xy;
  float d = clamp(g - (ab.x * g + ab.y), -1.5, 1.5);
  // Don't amplify the noise floor in the deepest shadows.
  float w = tex_amt > 0.0 ? smoothstep(-11.0, -7.0, g) : 1.0;
  c.rgb *= exp2(d * tex_amt * w);
  return c;
}
`;

const clGlsl = /* glsl */ `
uniform sampler2D cl_coef;
uniform float cl_amt;

vec4 cl_apply(vec4 c) {
  float g = log2(max(luma(c.rgb), 1e-5));
  vec2 ab = texture(cl_coef, g_px / u_fullSize).xy;
  float base = ab.x * g + ab.y;
  float d = clamp(g - base, -2.0, 2.0);
  // Midtones only (base in log2 of display-referred luminance; 0 = white).
  float w = smoothstep(-8.5, -5.0, base) * (1.0 - smoothstep(-1.1, 0.1, base));
  c.rgb *= exp2(d * cl_amt * mix(1.0, w, cl_amt > 0.0 ? 1.0 : 0.5));
  return c;
}
`;

/**
 * Filter radius (in coefficient texels) and the coefficient downsampling factor. The factor is
 * 1, 2 or 4: with tile sizes and padding multiples of 4, the block grid then lines up with output
 * pixels in every export tile, so tiles join without seams.
 */
function texPlan(ctx: StageContext) {
  const r = (TEXTURE_RADIUS * ctx.longEdge) / ctx.pxScale; // target pixels
  const s = r >= 8 ? 4 : r >= 2.5 ? 2 : 1;
  return { r: Math.max(1, Math.round(r / s)), s };
}

export const textureStage: Stage = {
  id: 'tex',
  label: 'Texture',
  kind: 'spatial',
  glsl: texGlsl,
  skipInMaps: true,
  helpers: [STATS_FS, GF_COEF_FS],
  active: (ctx) => ctx.recipe.effects.texture !== 0,
  reach(ctx) {
    const p = texPlan(ctx);
    return 2 * Math.ceil(p.r) * p.s + 2 * p.s + 2;
  },
  uniforms(ctx) {
    const t = ctx.recipe.effects.texture / 100;
    return { tex_amt: u.f(t > 0 ? t * 0.9 : t * 0.85), tex_s: u.f(texPlan(ctx).s) };
  },
  prepare(ctx, input, kit): StageTextures {
    const p = texPlan(ctx);
    const stats = kit.rt('tex:stats', Math.ceil(input.width / p.s), Math.ceil(input.height / p.s), 'rg32f');
    kit.draw(STATS_FS, stats, { u_factor: u.i(p.s) }, { u_src: input.tex });
    const coef = guidedCoefficients(kit, stats, p.r, 0.03, 'tex:gf', true);
    return { tex_coef: coef.tex };
  },
};

export const clarityStage: Stage = {
  id: 'cl',
  label: 'Clarity',
  kind: 'point',
  glsl: clGlsl,
  active: (ctx) => ctx.recipe.effects.clarity !== 0,
  uniforms(ctx) {
    const c = ctx.recipe.effects.clarity / 100;
    return { cl_amt: u.f(c > 0 ? c * 0.9 : c * 0.75) };
  },
  maps: (ctx): MapSpec[] =>
    ctx.recipe.effects.clarity === 0
      ? []
      : [{
          id: 'clarity',
          until: 'tone',
          edge: CLARITY_EDGE,
          key: '',
          draftable: true,
          helpers: [STATS_FS, GF_COEF_FS],
          build(kit, src, mctx) {
            const stats = kit.rt('stats', src.width, src.height, 'rg32f');
            kit.draw(STATS_FS, stats, { u_factor: u.i(1) }, { u_src: src.tex });
            const coef = guidedCoefficients(kit, stats, (CLARITY_RADIUS * mctx.longEdge) / mctx.pxScale, 0.1, 'gf', true);
            return { cl_coef: coef.tex };
          },
        }],
  textures: (_ctx, res): StageTextures => ({ cl_coef: res.map('clarity')?.cl_coef ?? res.dummy }),
};
