/**
 * Stage 28 — dehaze (dark channel prior, He et al.), on linear scene data before tone.
 *
 * An image-wide map (512 px long edge, from the pipeline up to stage 27) estimates the haze:
 *  1. dark channel: min over R, G, B, then a min filter over a patch (1.5 % of the long edge);
 *  2. atmospheric light A: the colour of the haziest pixels, as a weighted mean with weights
 *     exp(12 · dark) — computed by GPU reduction passes into a 1×1 texture (no CPU readback);
 *  3. haze density h = min-filtered min_c(I_c / A_c), refined with a guided filter whose guide is
 *     the image's lightness, so the transmission follows edges.
 * The guided-filter coefficients are applied per pixel to the full-resolution lightness, so the
 * result is edge-aware at any zoom and identical in preview and export.
 *
 * Applying, with amount ω: transmission t = 1 − 0.85·ω·h, scene J = (I − A)/t + A. Bright,
 * sky-like areas close to A are protected (the classic dark-channel sky artefact). Negative amounts
 * add haze instead: a blend toward a softened A, stronger where the scene is already hazy.
 */
import { GF_COEF_FS, guidedCoefficients } from '../gl/guidedFilter';
import type { MapSpec, Stage, StageTextures } from '../types';
import { u } from '../types';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
const vec3 LUMA = vec3(0.2627, 0.6780, 0.0593);
`;

const MAP_EDGE = 512;
const PATCH = 0.015; // fraction of the long edge

/** (min channel, -, -, 1). */
const DARK_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
void main() {
  vec3 c = max(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 0.0);
  o = vec4(min(c.r, min(c.g, c.b)), 0.0, 0.0, 1.0);
}`;

/** Separable min filter of the red channel (other channels from the centre). */
const MIN_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform int u_radius;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), s = textureSize(u_src, 0) - 1, d = ivec2(u_dir);
  vec4 c = texelFetch(u_src, p, 0);
  for (int i = -u_radius; i <= u_radius; i++) c.r = min(c.r, texelFetch(u_src, clamp(p + d * i, ivec2(0), s), 0).r);
  o = c;
}`;

/** 4×4 reduction of (rgb·w, w); the first pass weighs by the dark channel. */
const REDUCE_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform sampler2D u_dark;
uniform int u_first;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 4, s = textureSize(u_src, 0);
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 q = p + ivec2(i, j);
    if (q.x >= s.x || q.y >= s.y) continue;
    vec4 v = texelFetch(u_src, q, 0);
    if (u_first == 1) {
      float w = exp(12.0 * clamp(texelFetch(u_dark, q, 0).r, 0.0, 4.0));
      v = vec4(max(v.rgb, 0.0) * w, w);
    }
    acc += v;
  }
  o = acc;
}`;

/** (min_c(I/A), lightness guide relative to A, -, 1). */
const NORM_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform sampler2D u_A;
void main() {
  vec4 s = texelFetch(u_A, ivec2(0), 0);
  vec3 A = max(s.rgb / max(s.a, 1e-30), vec3(1e-4));
  vec3 c = max(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 0.0);
  vec3 n = c / A;
  o = vec4(min(n.r, min(n.g, n.b)), pow(dot(c, LUMA) / dot(A, LUMA), 1.0 / 2.2), 0.0, 1.0);
}`;

/** Guided-filter stats (I, I², p, I·p) with I = guide, p = haze density. */
const STATS_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
void main() {
  vec4 v = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  float I = v.g, p = clamp(v.r, 0.0, 1.5);
  o = vec4(I, I * I, p, I * p);
}`;

const glsl = /* glsl */ `
uniform sampler2D haze_coef;
uniform sampler2D haze_A;
uniform float haze_amt;

vec4 haze_apply(vec4 c) {
  vec4 s = texelFetch(haze_A, ivec2(0), 0);
  vec3 A = max(s.rgb / max(s.a, 1e-30), vec3(1e-4));
  float lA = max(luma(A), 1e-4);
  float Y = max(luma(c.rgb), 0.0);
  float I = pow(Y / lA, 1.0 / 2.2);
  vec2 ab = texture(haze_coef, g_px / u_fullSize).xy;
  float h = clamp(ab.x * I + ab.y, 0.0, 1.0);
  if (haze_amt > 0.0) {
    float t = 1.0 - haze_amt * 0.85 * h;
    // Sky-like areas (bright, close to the haze colour) would turn dark and noisy: protect them.
    t = mix(t, 1.0, 0.6 * smoothstep(0.75, 1.0, Y / lA));
    t = max(t, 0.12);
    c.rgb = max((c.rgb - A) / t + A, 0.0);
  } else if (haze_amt < 0.0) {
    float k = -haze_amt * 0.7 * (0.3 + 0.7 * h);
    c.rgb = mix(c.rgb, mix(vec3(lA), A, 0.5), k);
  }
  return c;
}
`;

export const dehazeStage: Stage = {
  id: 'haze',
  label: 'Dehaze',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.effects.dehaze !== 0,
  uniforms: (ctx) => ({ haze_amt: u.f(ctx.recipe.effects.dehaze / 100) }),
  maps: (ctx): MapSpec[] =>
    ctx.recipe.effects.dehaze === 0
      ? []
      : [{
          id: 'haze',
          until: 'cast',
          edge: MAP_EDGE,
          key: '',
          draftable: true,
          helpers: [DARK_FS, MIN_FS, REDUCE_FS, NORM_FS, STATS_FS, GF_COEF_FS],
          build(kit, src, mctx) {
            const W = src.width, H = src.height;
            // Patch size in map texels (the map may be a half-density draft).
            const r = Math.max(1, Math.round((PATCH * mctx.longEdge) / mctx.pxScale));
            const minFilter = (from: { tex: WebGLTexture }, tag: string) => {
              const a = kit.rt(`${tag}:h`, W, H, 'rgba32f'), b = kit.rt(tag, W, H, 'rgba32f');
              kit.draw(MIN_FS, a, { u_dir: u.v2(1, 0), u_radius: u.i(r) }, { u_src: from.tex });
              kit.draw(MIN_FS, b, { u_dir: u.v2(0, 1), u_radius: u.i(r) }, { u_src: a.tex });
              return b;
            };
            const dark = kit.rt('dark', W, H, 'rgba32f');
            kit.draw(DARK_FS, dark, {}, { u_src: src.tex });
            const darkMin = minFilter(dark, 'darkMin');
            // Atmospheric light: reduce to 1×1.
            let cur = { tex: src.tex, width: W, height: H };
            let level = 0;
            do {
              const w = Math.ceil(cur.width / 4), h = Math.ceil(cur.height / 4);
              const out = kit.rt(`red${level}`, w, h, 'rgba32f');
              kit.draw(REDUCE_FS, out, { u_first: u.i(level === 0) }, { u_src: cur.tex, u_dark: darkMin.tex });
              cur = out;
              level++;
            } while (cur.width > 1 || cur.height > 1);
            const norm = kit.rt('norm', W, H, 'rgba32f');
            kit.draw(NORM_FS, norm, {}, { u_src: src.tex, u_A: cur.tex });
            const normMin = minFilter(norm, 'normMin');
            const stats = kit.rt('stats', W, H, 'rgba32f');
            kit.draw(STATS_FS, stats, {}, { u_src: normMin.tex });
            const coef = guidedCoefficients(kit, stats, r * 2.5, 2e-3, 'gf');
            return { haze_coef: coef.tex, haze_A: cur.tex };
          },
        }],
  textures: (_ctx, res): StageTextures => {
    const m = res.map('haze');
    return { haze_coef: m?.haze_coef ?? res.dummy, haze_A: m?.haze_A ?? res.dummy };
  },
};
