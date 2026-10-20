/**
 * Stage 22 — noise reduction (spatial), on scene-linear data before contrast amplifies the noise.
 *
 * Algorithm: an edge-avoiding à-trous wavelet transform in OKLab, with soft thresholding.
 *  - Each level smooths the previous one with a dilated 3×3 B-spline kernel whose weights fall off
 *    with the difference to the centre (bilateral range weight), so edges are not smoothed across.
 *    Level j uses dilation 2^j full-resolution pixels.
 *  - The detail removed at each level (current − smoothed) is soft-thresholded: amplitudes below τ
 *    (noise) go, larger ones (texture, edges) keep their shape. Reconstruction = coarsest level +
 *    thresholded details; with τ = 0 that is exactly the input.
 *  - τ follows the image's measured noise model σ²(Y) = S·Y + O (ImageAnalysis.noise), converted
 *    to OKLab L per pixel, so the same slider value treats bright and dark areas consistently.
 *  - A few percent of the original noise is put back: denoised but not plastic.
 * Luminance works on L at dilations 1…16 px; colour on a, b at 1…32 (64) px with the luminance as
 * the edge guide, since chroma noise is coarse and blotchy.
 *
 * Resolution independence: scales are full-resolution pixels. At a zoom below 100 % the target has
 * fewer pixels: levels finer than a target pixel are skipped (the downscale already averaged that
 * noise) and the noise level is reduced accordingly, so the preview approximates the full-res result.
 * The final result is applied as a difference in OKLab on top of the full-precision input.
 */
import { OKLAB_GLSL } from '../../color/oklab';
import type { Stage, StageContext, StageTextures } from '../types';
import { u } from '../types';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
`;

/** Working RGB → OKLab (alpha kept). */
const PREP_FS = /* glsl */ `${HEAD}${OKLAB_GLSL}
uniform sampler2D u_src;
void main() {
  vec4 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  o = vec4(toOklab(c.rgb), c.a);
}`;

const NOISE_GLSL = /* glsl */ `
uniform vec3 u_noise; // S, O, target-pixel noise scale
// Noise std of OKLab L at lightness L (render resolution): σ_Y / (dY/dL), Y ≈ L³.
float sigmaL(float L) {
  float Lc = max(L, 0.06);
  float Y = Lc * Lc * Lc;
  return sqrt(u_noise.x * Y + u_noise.y) * u_noise.z / (3.0 * Lc * Lc);
}
const float K3[3] = float[3](0.25, 0.5, 0.25);
`;

/** One luminance level: state (L_j, Σ thresholded detail). */
const LUM_FS = /* glsl */ `${HEAD}
uniform sampler2D u_cur;
uniform sampler2D u_guide;
uniform int u_first;
uniform int u_step;
uniform float u_tau;
uniform float u_range;
uniform float u_impulse;
${NOISE_GLSL}
float lAt(ivec2 q) { return u_first == 1 ? texelFetch(u_guide, q, 0).x : texelFetch(u_cur, q, 0).x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), s = textureSize(u_guide, 0) - 1;
  float L0 = texelFetch(u_guide, p, 0).x;
  float sig = sigmaL(L0);
  vec2 cur = u_first == 1 ? vec2(L0, 0.0) : texelFetch(u_cur, p, 0).xy;
  float sr = max(u_range * sig, 1e-5), k = -0.5 / (sr * sr);
  float v[9];
  float mean = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float Lq = lAt(clamp(p + ivec2(i, j) * u_step, ivec2(0), s));
    v[(j + 1) * 3 + i + 1] = Lq;
    mean += Lq;
  }
  // Range weights against a robust reference: an impulse (a pixel unlike all its neighbours)
  // would otherwise look like an edge and survive.
  float ref = mix(cur.x, mean / 9.0, 0.75);
  float acc = 0.0, ws = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float Lq = v[(j + 1) * 3 + i + 1];
    float d = Lq - ref;
    // Floor: when every neighbour is far (an impulse), fall back to the plain B-spline average.
    float w = K3[i + 1] * K3[j + 1] * (exp(d * d * k) + 1e-4);
    acc += Lq * w; ws += w;
  }
  float Ln = acc / ws;
  float det = cur.x - Ln, t = u_tau * sig;
  float kept = det - clamp(det, -t, t);
  // Finest level: a strict local extremum is a noise impulse, not detail (soft thresholding would
  // keep its tail as a dot). Only bright points far beyond the noise (lights, stars) are kept;
  // a dark pixel among brighter neighbours never is.
  if (u_impulse > 0.0) {
    float lo = 1e9, hi = -1e9;
    for (int n = 0; n < 9; n++) if (n != 4) { lo = min(lo, v[n]); hi = max(hi, v[n]); }
    bool extremum = cur.x < lo || cur.x > hi;
    float point = det > 0.0 ? smoothstep(6.0, 10.0, det / max(sig, 1e-6)) : 0.0;
    if (extremum) kept *= 1.0 - u_impulse * (1.0 - point);
  }
  o = vec4(Ln, cur.y + kept, 0.0, 1.0);
}`;

/** One chroma level: state (a_j, b_j, Σ thresholded a, b detail); luminance guides the edges. */
const CHROMA_FS = /* glsl */ `${HEAD}
uniform sampler2D u_cur;
uniform sampler2D u_guide;
uniform int u_first;
uniform int u_step;
uniform float u_tau;
uniform float u_range;
uniform float u_keep;
uniform float u_impulse;
${NOISE_GLSL}
vec2 abAt(ivec2 q) { return u_first == 1 ? texelFetch(u_guide, q, 0).yz : texelFetch(u_cur, q, 0).xy; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), s = textureSize(u_guide, 0) - 1;
  vec3 g0 = texelFetch(u_guide, p, 0).xyz;
  float sig = sigmaL(g0.x);
  vec4 cur = u_first == 1 ? vec4(g0.yz, 0.0, 0.0) : texelFetch(u_cur, p, 0);
  float srL = max(3.0 * sig, 1e-5), srC = max(u_range * sig, 1e-5);
  float kL = -0.5 / (srL * srL), kC = -0.5 / (srC * srC);
  vec2 abv[9];
  float lv[9];
  vec2 mean = vec2(0.0);
  float lmean = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = clamp(p + ivec2(i, j) * u_step, ivec2(0), s);
    int n = (j + 1) * 3 + i + 1;
    abv[n] = abAt(q);
    lv[n] = texelFetch(u_guide, q, 0).x;
    mean += abv[n];
    lmean += lv[n];
  }
  // Robust references (see the luminance pass): chroma impulses must not shield themselves.
  vec2 refC = mix(cur.xy, mean / 9.0, 0.75);
  float refL = mix(g0.x, lmean / 9.0, 0.75);
  vec2 acc = vec2(0.0);
  float ws = 0.0;
  for (int n = 0; n < 9; n++) {
    float dL = lv[n] - refL;
    vec2 dC = abv[n] - refC;
    float w = K3[n % 3] * K3[n / 3] * (exp(dL * dL * kL + dot(dC, dC) * kC) + 1e-4);
    acc += abv[n] * w; ws += w;
  }
  vec2 n = acc / ws, det = cur.xy - n;
  float m = length(det), t = u_tau * sig;
  vec2 kept = det * (max(m - t, 0.0) / max(m, 1e-7)) * u_keep;
  // Finest level: a pixel whose chroma stands out far more than any neighbour's is an impulse.
  if (u_impulse > 0.0) {
    vec2 mN = (mean - abv[4]) / 8.0;
    float dmax = 0.0;
    for (int n = 0; n < 9; n++) if (n != 4) dmax = max(dmax, length(abv[n] - mN));
    if (length(abv[4] - mN) > 1.5 * dmax) kept *= 1.0 - u_impulse;
  }
  o = vec4(n, cur.zw + kept);
}`;

const glsl = /* glsl */ `
uniform sampler2D nr_prep;
uniform sampler2D nr_lum;
uniform sampler2D nr_chroma;
uniform int nr_lumOn;
uniform int nr_colOn;
uniform float nr_keep;
uniform float nr_keepC;

vec4 nr_apply(sampler2D prev, ivec2 fc) {
  vec4 src = texelFetch(prev, fc, 0);
  vec3 lab0 = texelFetch(nr_prep, fc, 0).xyz;
  vec3 lab = lab0;
  if (nr_lumOn == 1) {
    vec2 l = texelFetch(nr_lum, fc, 0).xy;
    lab.x = mix(l.x + l.y, lab0.x, nr_keep);
  }
  if (nr_colOn == 1) {
    vec4 c = texelFetch(nr_chroma, fc, 0);
    lab.yz = mix(c.xy + c.zw, lab0.yz, nr_keepC);
  }
  // Applied as a difference so untouched areas keep the input's full precision.
  return vec4(src.rgb + fromOklab(lab) - fromOklab(lab0), src.a);
}
`;

/** Detail-coefficient noise of successive à-trous levels, relative to the input noise. */
const LEVEL_NOISE = [0.8, 0.3, 0.11, 0.045, 0.02, 0.009, 0.004];
const LUM_SCALES = [1, 2, 4, 8, 16];
const CHROMA_SCALES = [1, 2, 4, 8, 16, 32];

interface Level { step: number; tau: number; range: number; keep: number; impulse?: number }

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Levels for this render: full-res scales finer than a target pixel are already averaged away. */
function plan(ctx: StageContext) {
  const nr = ctx.recipe.detail.nr;
  const ps = ctx.pxScale;
  const levels = (scales: number[]) => scales.filter((s) => s / ps >= 0.75).map((s) => Math.max(1, Math.round(s / ps)));
  const lumSteps = nr.lum > 0 ? levels(LUM_SCALES) : [];
  const chromaScales = [...CHROMA_SCALES, ...(nr.colorSmooth > 40 ? [64] : []), ...(nr.colorSmooth > 75 ? [128] : [])];
  const colSteps = nr.color > 0 ? levels(chromaScales) : [];
  // Chroma noise in OKLab a, b runs ~1.6× the lightness noise (independent channel noise).
  const sL = (nr.lum / 100) * 3.8, sC = (nr.color / 100) * 6.4 * 1.6;
  const lum: Level[] = lumSteps.map((step, j) => ({
    step,
    tau: sL * LEVEL_NOISE[Math.min(j, 6)] * (j < 2 ? mix(1.25, 0.55, nr.lumDetail / 100) : mix(1, 0.35, nr.lumContrast / 100)),
    range: mix(3.5, 2, nr.lumDetail / 100) * Math.pow(2, -j * 0.5),
    keep: 1,
    impulse: j === 0 ? Math.min(1, Math.max(0, (nr.lum - 10) / 30)) * mix(1, 0.6, nr.lumDetail / 100) : 0,
  }));
  const col: Level[] = colSteps.map((step, j) => ({
    step,
    tau: sC * LEVEL_NOISE[Math.min(j, 6)] * (j < 2 ? mix(1.4, 0.4, nr.colorDetail / 100) : mix(0.7, 1.4, nr.colorSmooth / 100)) * 0.8,
    range: 2.5 * Math.pow(2, -j * 0.35),
    // Fine chroma detail is mostly noise (and impulses survive thresholding): fade it with strength.
    keep: j < 2 ? Math.min(1, mix(1, 0.06, Math.min(1, nr.color / 25)) * mix(0.5, 2, nr.colorDetail / 100)) : 1,
    impulse: j === 0 ? Math.min(1, Math.max(0, (nr.color - 5) / 20)) : 0,
  }));
  return { lum, col };
}

function noiseUniform(ctx: StageContext) {
  const n = ctx.image.analysis.noise ?? { S: 1.5e-4, O: 4e-6 };
  // White noise averaged over pxScale² full-res pixels; demosaicing correlates neighbours a little.
  const scale = 1 / Math.pow(Math.max(1, ctx.pxScale), 0.85);
  return { u_noise: u.v3([n.S, n.O, scale]) };
}

export const noiseReductionStage: Stage = {
  id: 'nr',
  label: 'Noise reduction',
  kind: 'spatial',
  glsl,
  skipInMaps: true,
  helpers: [PREP_FS, LUM_FS, CHROMA_FS],
  active: (ctx) => {
    const p = plan(ctx);
    return p.lum.length > 0 || p.col.length > 0;
  },
  reach(ctx) {
    const p = plan(ctx);
    const sum = (l: Level[]) => l.reduce((a, v) => a + v.step, 0);
    return Math.max(sum(p.lum), sum(p.col)) + 1;
  },
  uniforms(ctx) {
    const p = plan(ctx);
    return {
      nr_lumOn: u.i(p.lum.length > 0),
      nr_colOn: u.i(p.col.length > 0),
      nr_keep: u.f(0.06),
      nr_keepC: u.f(0.03),
    };
  },
  prepare(ctx, input, kit, res): StageTextures {
    const p = plan(ctx);
    const W = input.width, H = input.height;
    const prep = kit.rt('nr:prep', W, H);
    kit.draw(PREP_FS, prep, {}, { u_src: input.tex });
    const noise = noiseUniform(ctx);
    const chain = (fs: string, levels: Level[], tag: string, fmt: 'rgba16f' | 'rg16f') => {
      let cur = prep;
      levels.forEach((l, j) => {
        const out = kit.rt(`${tag}${j % 2}`, W, H, fmt);
        kit.draw(fs, out, {
          ...noise,
          u_first: u.i(j === 0),
          u_step: u.i(l.step),
          u_tau: u.f(l.tau),
          u_range: u.f(l.range),
          u_keep: u.f(l.keep),
          u_impulse: u.f(l.impulse ?? 0),
        }, { u_cur: cur.tex, u_guide: prep.tex });
        cur = out;
      });
      return levels.length ? cur.tex : res.dummy;
    };
    return {
      nr_prep: prep.tex,
      // Luminance state is two values (level, detail sum): half the memory of RGBA.
      nr_lum: chain(LUM_FS, p.lum, 'nr:l', 'rg16f'),
      nr_chroma: chain(CHROMA_FS, p.col, 'nr:c', 'rgba16f'),
    };
  },
};
