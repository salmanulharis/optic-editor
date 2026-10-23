/**
 * Stage 78 — local adjustments (masks), after the look layer and before the glow / vignette /
 * grain effects. Spatial: it reads a neighbourhood for texture, sharpness, noise reduction and the
 * AI-mask edge refinement.
 *
 * Masks (recipe `masks`, see recipe/masks.ts) are evaluated once per frame in helper passes over
 * the padded intermediate frame, four masks per RGBA16F target:
 *  - linear / radial gradients analytically, in undistorted source pixels (output → U through the
 *    geometry matrix), so they follow crop, straighten and transform;
 *  - brush strokes from an image-wide map (`locBrush`, 2048 px per source long edge over the output
 *    frame): vector paths are rasterised on the GPU with soft round tips, flow and density, and
 *    optional auto-mask (strength falls off where the colour differs from the colour under the
 *    stroke). Preview and export use the same map, so strokes look identical in both;
 *  - colour / luminance ranges per pixel in OKLab, from the image entering this stage;
 *  - AI masks from ~1024 px bitmaps (mask registry) in U, refined by a fast guided filter against
 *    the full-resolution lightness of the image (radius ≈ 2 bitmap texels; statistics on a grid 1, 2
 *    or 4 times coarser than the frame, so tiles stay seamless), so hair and branch edges follow the
 *    real image at 100 % and in the export.
 * Components combine left to right (add = union, subtract, intersect).
 *
 * Each mask's adjustment set is applied with weight mask × amount, in order:
 *  - noise reduction (blend toward an edge-aware Gaussian mean, ≤ 7×7 taps in the shader),
 *    sharpness (OKLab lightness detail against a ≤ 5×5 in-shader blur at ≈ 1 px of a 24 MP image)
 *    and texture (against a Gaussian helper pass at ≈ 0.25 % of the long edge);
 *  - temperature / tint as luminance-preserving channel gains and exposure, in linear light;
 *  - contrast, highlights, shadows, whites (log-luminance EV offsets like stage 30), clarity (from an
 *    image-wide guided-filter base, like stage 35), blacks (soft pedestal); any gain above white
 *    rolls off smoothly instead of clipping;
 *  - dehaze (subtracts the local haze level of an image-wide dark-channel map, or adds haze);
 *  - hue rotation, saturation and a colour tint in OKLab.
 * With no masks the stage is not compiled (v3 recipes render bit-identically).
 */
import { WORKING_LUMA } from '../../color/matrices';
import { OKLAB_GLSL } from '../../color/oklab';
import { project } from '../../geometry/transform';
import {
  type Mask,
  type MaskComponent,
  type MaskParams,
  MAX_BRUSH_COMPONENTS,
  MAX_COMPONENTS,
  MAX_MASKS,
  aiChannelFor,
  isAiType,
  maskIsIdentity,
} from '../../recipe/masks';
import { GF_COEF_FS, guidedCoefficients } from '../gl/guidedFilter';
import type { GpuKit } from '../gl/gpuKit';
import type { RenderTargetTex } from '../gl/texture';
import { maskRegistry } from '../maskRegistry';
import { mapDims } from '../mapDims';
import type { MapSpec, Stage, StageContext, StageTextures, Uniform } from '../types';
import { u } from '../types';

const BRUSH_EDGE = 2048;
const MAP_EDGE = 1024;
const CLARITY_RADIUS = 0.012;
const HAZE_RADIUS = 0.01;
const TEXTURE_SIGMA = 0.0025; // fraction of the long edge
const SHARP_SIGMA = 1 / 6000;
const NOISE_SIGMA = 1.2 / 6000;
const GF_EPS = 0.0015;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
`;

/** OKLab lightness of the previous pass (guide for refinement, base for detail). */
const L_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
${OKLAB_GLSL}
void main() {
  vec3 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb;
  float L = clamp(toOklab(max(c, 0.0)).x, 0.0, 1.5);
  o = vec4(L, L * L, 0.0, 1.0);
}`;

/** An AI bitmap (U frame) resampled into the intermediate frame, at 1/u_f of its resolution. */
const AIP_FS = /* glsl */ `${HEAD}
uniform sampler2D u_ai;
uniform mat3 u_view;
uniform mat3 u_oToU;
uniform vec2 u_srcSize;
uniform float u_f;
void main() {
  vec2 px = (u_view * vec3(gl_FragCoord.xy * u_f, 1.0)).xy;
  vec3 h = u_oToU * vec3(px, 1.0);
  o = texture(u_ai, (h.xy / h.z) / u_srcSize);
}`;

/** Guide × input for the guided filter's covariance. */
const IP_FS = /* glsl */ `${HEAD}
uniform sampler2D u_L;
uniform sampler2D u_p;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = texelFetch(u_L, p, 0).r * texelFetch(u_p, p, 0);
}`;

/** Per-channel guided-filter coefficients a (u_which = 0) or b (1) for a scalar guide. */
const COEF4_FS = /* glsl */ `${HEAD}
uniform sampler2D u_mg;
uniform sampler2D u_mp;
uniform sampler2D u_mip;
uniform float u_eps;
uniform int u_which;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 g = texelFetch(u_mg, p, 0).xy;
  vec4 mp = texelFetch(u_mp, p, 0);
  vec4 mip = texelFetch(u_mip, p, 0);
  float varI = max(g.y - g.x * g.x, 0.0);
  vec4 a = (mip - g.x * mp) / (varI + u_eps);
  o = u_which == 0 ? a : mp - a * g.x;
}`;

/**
 * Mask build: every mask (up to 16, four per output, one per channel) for every pixel of the frame,
 * in one draw into up to four render targets.
 */
const MASK_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
${OKLAB_GLSL}
uniform sampler2D u_prev;
uniform sampler2D u_L;
uniform sampler2D u_br0;
uniform sampler2D u_br1;
uniform sampler2D u_br2;
uniform sampler2D u_br3;
uniform sampler2D u_a0;
uniform sampler2D u_b0;
uniform sampler2D u_a1;
uniform sampler2D u_b1;
uniform sampler2D u_a2;
uniform sampler2D u_b2;
uniform sampler2D u_a3;
uniform sampler2D u_b3;
uniform vec4 u_aiRef;
uniform vec4 u_aiF;
uniform int u_needLab;
uniform int u_needI;
uniform int u_n;
uniform mat3 u_view;
uniform mat3 u_oToU;
uniform vec2 u_outSize;
uniform vec4 u_m[${MAX_MASKS}];      // start, count, invert
uniform vec4 u_cT[${MAX_COMPONENTS}];   // type, op, invert, slot * 4 + channel
uniform vec4 u_cP[${MAX_COMPONENTS}];
uniform vec4 u_cQ[${MAX_COMPONENTS}];
uniform vec4 u_cR[${MAX_COMPONENTS}];

float brushAt(int s, int ch, vec2 uv) {
  vec4 v = s == 0 ? texture(u_br0, uv) : s == 1 ? texture(u_br1, uv) : s == 2 ? texture(u_br2, uv) : texture(u_br3, uv);
  return v[ch];
}

// Guided-filter coefficients (or the plain resampled bitmap in b) live on a grid u_aiF[s] times
// coarser than the frame, aligned with it: sample them bilinearly at the frame pixel's centre.
float aiAt(int s, int ch, vec2 fp, float I) {
  vec4 a, b;
  vec2 q = fp / u_aiF[s];
  if (s == 0) { vec2 uv = q / vec2(textureSize(u_b0, 0)); a = texture(u_a0, uv); b = texture(u_b0, uv); }
  else if (s == 1) { vec2 uv = q / vec2(textureSize(u_b1, 0)); a = texture(u_a1, uv); b = texture(u_b1, uv); }
  else if (s == 2) { vec2 uv = q / vec2(textureSize(u_b2, 0)); a = texture(u_a2, uv); b = texture(u_b2, uv); }
  else { vec2 uv = q / vec2(textureSize(u_b3, 0)); a = texture(u_a3, uv); b = texture(u_b3, uv); }
  float v = u_aiRef[s] > 0.5 ? a[ch] * I + b[ch] : b[ch];
  return clamp(v, 0.0, 1.0);
}

float rangeEdge(float lo, float hi, float s, float L) {
  float a = lo <= 0.0 ? 1.0 : smoothstep(lo - s, lo, L);
  float b = hi >= 1.0 ? 1.0 : 1.0 - smoothstep(hi, hi + s, L);
  return a * b;
}

vec2 g_U, g_buv;
vec3 g_lab;
float g_I;

/** Mask k: its components combined left to right, then the mask's invert. */
float maskValue(int k) {
  vec4 mi = u_m[k];
  int start = int(mi.x), count = int(mi.y);
  float m = 0.0;
  for (int j = 0; j < ${MAX_COMPONENTS}; j++) {
    if (j >= count) break;
    int c = start + j;
    vec4 T = u_cT[c], P = u_cP[c], Q = u_cQ[c], R = u_cR[c];
    int type = int(T.x);
    float v = 0.0;
    if (type == 0) {
      vec2 d = P.zw - P.xy;
      float t = dot(g_U - P.xy, d) / max(dot(d, d), 1e-6);
      v = 1.0 - smoothstep(0.0, 1.0, t);
    } else if (type == 1) {
      vec2 q = g_U - P.xy;
      vec2 qr = vec2(q.x * Q.x + q.y * Q.y, -q.x * Q.y + q.y * Q.x) / P.zw;
      float r = length(qr);
      float inner = min(1.0 - Q.z, 0.999);
      v = 1.0 - smoothstep(inner, 1.0, r);
    } else if (type == 2) {
      int sc = int(T.w);
      v = brushAt(sc / 4, sc - (sc / 4) * 4, g_buv);
    } else if (type == 3) {
      float t = mix(0.012, 0.2, P.w);
      int n = int(Q.w);
      for (int s = 0; s < 3; s++) {
        if (s >= n) break;
        vec3 sm = s == 0 ? P.xyz : s == 1 ? Q.xyz : R.xyz;
        float d = length(vec3((g_lab.x - sm.x) * 0.6, g_lab.yz - sm.yz));
        v = max(v, 1.0 - smoothstep(t * 0.55, t, d));
      }
    } else if (type == 4) {
      v = rangeEdge(P.x, P.y, max(P.z, 0.002), clamp(g_lab.x, 0.0, 1.0));
    } else if (type == 5) {
      int sc = int(T.w);
      v = aiAt(sc / 4, sc - (sc / 4) * 4, gl_FragCoord.xy, g_I);
    }
    if (T.z > 0.5) v = 1.0 - v;
    int op = int(T.y);
    if (j == 0 || op == 0) m = max(m, v);
    else if (op == 1) m *= 1.0 - v;
    else m *= v;
  }
  if (mi.z > 0.5) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}

float mv(int k) { return k < u_n ? maskValue(k) : 0.0; }

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec2 px = (u_view * vec3(gl_FragCoord.xy, 1.0)).xy;
  vec3 h = u_oToU * vec3(px, 1.0);
  g_U = h.xy / h.z;
  g_buv = px / u_outSize;
  g_lab = u_needLab == 1 ? toOklab(max(texelFetch(u_prev, fc, 0).rgb, 0.0)) : vec3(0.0);
  g_I = u_needI == 1 ? texelFetch(u_L, fc, 0).r : 0.0;
  // Constant indices only (no dynamically indexed local arrays: they spill on some GPUs).
  o0 = vec4(mv(0), mv(1), mv(2), mv(3));
  if (u_n > 4) o1 = vec4(mv(4), mv(5), mv(6), mv(7)); else o1 = vec4(0.0);
  if (u_n > 8) o2 = vec4(mv(8), mv(9), mv(10), mv(11)); else o2 = vec4(0.0);
  if (u_n > 12) o3 = vec4(mv(12), mv(13), mv(14), mv(15)); else o3 = vec4(0.0);
}`;

/** Brush stroke chunk (≤ 64 points) into one channel of a brush map (premultiplied blending). */
const STROKE_FS = /* glsl */ `${HEAD}
uniform sampler2D u_guide;
uniform vec3 u_pts[64];
uniform int u_n;
uniform float u_r;
uniform float u_hard;
uniform float u_flow;
uniform float u_density;
uniform int u_erase;
uniform int u_auto;
uniform vec4 u_chan;
vec3 lg(vec3 c) { return log2(max(c, 0.0) + 0.004); }
void main() {
  vec2 p = gl_FragCoord.xy;
  float best = distance(p, u_pts[0].xy);
  vec2 nearest = u_pts[0].xy;
  float pr = u_pts[0].z;
  for (int i = 0; i < 63; i++) {
    if (i + 1 >= u_n) break;
    vec2 a = u_pts[i].xy, b = u_pts[i + 1].xy, ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    vec2 q = a + ab * t;
    float d = distance(p, q);
    if (d < best) { best = d; nearest = q; pr = mix(u_pts[i].z, u_pts[i + 1].z, t); }
  }
  float c = 1.0 - smoothstep(u_r * u_hard, u_r, best);
  c *= u_flow * pr;
  if (u_auto == 1 && c > 0.0) {
    vec2 sz = vec2(textureSize(u_guide, 0));
    vec3 g = lg(texelFetch(u_guide, ivec2(p), 0).rgb);
    vec3 ref = lg(texture(u_guide, nearest / sz).rgb);
    vec3 d = g - ref;
    float sim = exp(-dot(d, d) / (2.0 * 0.35 * 0.35));
    c *= smoothstep(0.25, 0.75, sim);
  }
  float v = u_erase == 1 ? 0.0 : u_density;
  o = vec4(u_chan.rgb * v * c, c);
}`;

const COPY_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
void main() { o = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

/** Self-guided stats of log luminance (clarity base) for the image-wide map. */
const STATS_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
const vec3 LW = vec3(${WORKING_LUMA.map((x) => x.toFixed(8)).join(', ')});
void main() {
  float g = log2(max(dot(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, LW), 1e-5));
  o = vec4(g, g * g, 0.0, 1.0);
}`;

/** Dark channel (haze estimate) for the image-wide map. */
const DARK_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
void main() {
  vec3 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb;
  float d = clamp(min(c.r, min(c.g, c.b)), 0.0, 1.0);
  o = vec4(d, d, 0.0, 1.0);
}`;

const glsl = /* glsl */ `
uniform sampler2D loc_m0;
uniform sampler2D loc_m1;
uniform sampler2D loc_m2;
uniform sampler2D loc_m3;
uniform sampler2D loc_L;
uniform sampler2D loc_Bt;
uniform sampler2D loc_cl;
uniform sampler2D loc_hz;
uniform int loc_n;
uniform int loc_flags;    // 1 sharpness blur, 2 texture blur, 4 noise mean, 8 clarity map, 16 haze map
uniform float loc_sigS;   // sharpness blur σ (target px, in-shader, ≤ 2 px radius)
uniform float loc_sigN;   // noise-reduction σ (target px, in-shader, ≤ 3 px radius)
uniform float loc_btF;    // grid factor of the texture blur
uniform vec4 loc_A[${MAX_MASKS}];    // log2 WB gains, exposure
uniform vec4 loc_B[${MAX_MASKS}];    // contrast, highlights, shadows, whites
uniform vec4 loc_C[${MAX_MASKS}];    // blacks, texture, clarity, dehaze
uniform vec4 loc_D[${MAX_MASKS}];    // hue (rad), saturation, tint a, tint b
uniform vec4 loc_E[${MAX_MASKS}];    // sharpness, noise, amount
uniform int loc_ov;
uniform int loc_ovMode;
uniform vec4 loc_ovCol;

/** Mask i at a frame pixel (four masks per texture, one per channel). */
float loc_mask(int i, ivec2 fc) {
  int g = i >> 2;
  vec4 t = g == 0 ? texelFetch(loc_m0, fc, 0) : g == 1 ? texelFetch(loc_m1, fc, 0) : g == 2 ? texelFetch(loc_m2, fc, 0) : texelFetch(loc_m3, fc, 0);
  return t[i & 3];
}

float loc_shoulder(float t) { return t < 0.8 ? t : 0.8 + 0.2 * (1.0 - exp(-(t - 0.8) / 0.2)); }

vec4 loc_apply(sampler2D prev, ivec2 fc) {
  vec4 c = texelFetch(prev, fc, 0);
  vec3 x = c.rgb;

  float L0 = (loc_flags & 7) != 0 ? texelFetch(loc_L, fc, 0).r : 0.0;
  float Bt = (loc_flags & 2) != 0 ? texture(loc_Bt, (vec2(fc) + 0.5) / (loc_btF * vec2(textureSize(loc_Bt, 0)))).r : L0;
  ivec2 lim = textureSize(loc_L, 0) - 1;
  // Small blurs in the shader (no full-frame targets): lightness for sharpness, and an
  // edge-aware mean of the colour for noise reduction.
  float Bs = L0;
  if ((loc_flags & 1) != 0) {
    int R = int(clamp(ceil(2.0 * loc_sigS), 1.0, 2.0));
    float acc = 0.0, ws = 0.0, k = -0.5 / (loc_sigS * loc_sigS);
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      if (abs(i) > R || abs(j) > R) continue;
      float w = exp(float(i * i + j * j) * k);
      acc += texelFetch(loc_L, clamp(fc + ivec2(i, j), ivec2(0), lim), 0).r * w;
      ws += w;
    }
    Bs = acc / ws;
  }
  vec3 N = x;
  if ((loc_flags & 4) != 0) {
    int R = int(clamp(ceil(2.0 * loc_sigN), 1.0, 3.0));
    vec3 acc = vec3(0.0);
    float ws = 0.0, k = -0.5 / (loc_sigN * loc_sigN);
    for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
      if (abs(i) > R || abs(j) > R) continue;
      ivec2 q = clamp(fc + ivec2(i, j), ivec2(0), lim);
      float dl = texelFetch(loc_L, q, 0).r - L0;
      float w = exp(float(i * i + j * j) * k) * exp(-dl * dl / (2.0 * 0.03 * 0.03));
      acc += texelFetch(prev, q, 0).rgb * w;
      ws += w;
    }
    N = acc / ws;
  }
  vec2 muv = g_px / u_fullSize;
  vec2 cl = (loc_flags & 8) != 0 ? texture(loc_cl, muv).xy : vec2(1.0, 0.0);
  float hz = (loc_flags & 16) != 0 ? texture(loc_hz, muv).r : 0.0;
  float g0 = log2(max(luma(x), 1e-5));
  float dCl = clamp(g0 - (cl.x * g0 + cl.y), -1.5, 1.5);
  float midW = smoothstep(-10.0, -6.0, g0) * (1.0 - smoothstep(-0.7, 0.0, g0));
  for (int i = 0; i < ${MAX_MASKS}; i++) {
    if (i >= loc_n) break;
    float m = loc_mask(i, fc);
    if (m <= 0.0005) continue;
    vec4 A = loc_A[i], B = loc_B[i], C = loc_C[i], D = loc_D[i], E = loc_E[i];
    float w = m * E.z;
    if (E.y > 0.0) x = mix(x, N, clamp(E.y * w, 0.0, 1.0));
    float dL = 0.0;
    if (C.y != 0.0) dL += C.y * w * clamp(L0 - Bt, -0.15, 0.15) * (C.y > 0.0 ? 1.3 : 1.0);
    if (E.x != 0.0) dL += E.x * w * clamp(L0 - Bs, -0.15, 0.15) * (E.x > 0.0 ? 1.6 : 1.0);
    if (dL != 0.0) { vec3 lab = toOklab(max(x, 0.0)); lab.x = max(lab.x + dL, 0.0); x = fromOklab(lab); }
    float n0 = max3(x);
    x *= exp2(A.xyz * w);
    float l = log2(max(luma(x), 1e-6) / 0.18);
    float ev = A.w * w
      + B.x * w * 0.3 * clamp(l, -5.0, 2.5)
      + B.y * w * 0.9 * smoothstep(-0.5, 2.3, l)
      + B.z * w * 1.1 * exp(-pow((l + 2.3) / 1.8, 2.0))
      + B.w * w * 0.5 * smoothstep(0.5, 2.4, l)
      + C.z * w * 0.7 * dCl * midW;
    x *= exp2(ev);
    if (C.x != 0.0) {
      float n = max3(x);
      float m2 = max(0.0, n + C.x * w * 0.035 * (1.0 - smoothstep(0.0, 0.25, n)));
      x *= m2 / max(n, 1e-6);
    }
    if (C.w > 0.0) {
      float t = clamp(C.w * w * 0.85 * hz, 0.0, 0.9);
      x = max(x - t, 0.0) / (1.0 - t);
    } else if (C.w < 0.0) {
      x = mix(x, vec3(max(hz, 0.35) * 0.95), -C.w * w * 0.5);
    }
    float n1 = max3(x);
    if (n1 > n0 && n1 > 0.8) x *= (n0 + loc_shoulder(n1) - loc_shoulder(n0)) / n1;
    if (D != vec4(0.0)) {
      vec3 lab = toOklab(max(x, 0.0));
      float a = D.x * w, ca = cos(a), sa = sin(a);
      lab.yz = vec2(lab.y * ca - lab.z * sa, lab.y * sa + lab.z * ca);
      lab.yz *= max(0.0, 1.0 + D.y * w);
      float L = clamp(lab.x, 0.0, 1.0);
      lab.yz += D.zw * w * smoothstep(0.02, 0.2, L) * (1.0 - smoothstep(0.85, 1.0, L));
      x = fromOklab(lab);
    }
  }
  if (loc_ov >= 0) {
    float m = loc_mask(loc_ov, fc);
    x = loc_ovMode == 1 ? vec3(pow(m, 2.2)) : mix(x, loc_ovCol.rgb, m * loc_ovCol.a);
  }
  return vec4(x, c.a);
}
`;

// ---------------------------------------------------------------------------
// Plan: which masks / components go to the GPU, and how they are packed
// ---------------------------------------------------------------------------

interface CompSlot {
  comp: MaskComponent;
  /** Brush: texture * 4 + channel (3 channels per texture). AI: slot * 4 + channel. */
  sc: number;
}

interface Plan {
  masks: Mask[];
  comps: CompSlot[][];
  brushes: MaskComponent<'brush'>[];
  /** Distinct AI bitmaps (registry keys), ≤ 4. */
  ai: string[];
  overlay: number;
  flags: { sharp: boolean; tex: boolean; noise: boolean; clarity: boolean; haze: boolean };
}

const planCache = new WeakMap<Mask[], Map<string, Plan>>();

function plan(ctx: StageContext): Plan {
  const all = ctx.recipe.masks ?? [];
  const ov = ctx.target.maskOverlay?.maskId ?? '';
  let byOv = planCache.get(all);
  if (!byOv) { byOv = new Map(); planCache.set(all, byOv); }
  const hit = byOv.get(ov);
  if (hit) return hit;
  const masks: Mask[] = [];
  const comps: CompSlot[][] = [];
  const brushes: MaskComponent<'brush'>[] = [];
  const ai: string[] = [];
  let total = 0;
  let overlay = -1;
  for (const m of all) {
    if (masks.length >= MAX_MASKS) break;
    const isOv = m.id === ov;
    if (!m.components.length || (!isOv && maskIsIdentity(m))) continue;
    const list: CompSlot[] = [];
    for (const c of m.components) {
      if (total >= MAX_COMPONENTS) break;
      let sc = 0;
      if (c.type === 'brush') {
        if (brushes.length >= MAX_BRUSH_COMPONENTS) continue;
        const i = brushes.length;
        brushes.push(c as MaskComponent<'brush'>);
        sc = Math.floor(i / 3) * 4 + (i % 3);
      } else if (isAiType(c.type)) {
        const key = c.cacheKey && maskRegistry.has(c.cacheKey) ? c.cacheKey : null;
        if (key) {
          let s = ai.indexOf(key);
          if (s < 0 && ai.length < 4) { ai.push(key); s = ai.length - 1; }
          sc = s < 0 ? -1 : s * 4 + aiChannelFor(c);
        } else sc = -1; // not computed yet: contributes nothing
      }
      list.push({ comp: c, sc });
      total++;
    }
    if (isOv) overlay = masks.length;
    masks.push(m);
    comps.push(list);
  }
  const on = (f: (m: Mask) => boolean) => masks.some((m) => m.visible && f(m));
  const p: Plan = {
    masks,
    comps,
    brushes,
    ai,
    overlay,
    flags: {
      sharp: on((m) => m.adjustments.sharpness !== 0 || m.adjustments.noise > 0),
      tex: on((m) => m.adjustments.texture !== 0),
      noise: on((m) => m.adjustments.noise > 0),
      clarity: on((m) => m.adjustments.clarity !== 0),
      haze: on((m) => m.adjustments.dehaze !== 0),
    },
  };
  byOv.set(ov, p);
  return p;
}

/** Blur σ in target pixels for a fraction of the long edge (0 when too small to matter). */
const sig = (ctx: StageContext, frac: number) => {
  const s = (frac * ctx.longEdge) / ctx.pxScale;
  return s >= 0.3 ? s : 0;
};

/** Guided-filter radius (target px) for an AI bitmap: about two bitmap texels. */
function aiRadius(ctx: StageContext, key: string): number {
  const b = maskRegistry.get(key);
  if (!b) return 0;
  const r = (2 * ctx.longEdge) / Math.max(b.width, b.height) / ctx.pxScale;
  return r >= 1.5 ? Math.round(r) : 0;
}

/** Grid factor of the texture blur (1, 2 or 4: the tile alignment rule). */
const textureFactor = (sigma: number) => (sigma >= 8 ? 4 : sigma >= 4 ? 2 : 1);

function detailSigmas(ctx: StageContext, p: Plan) {
  return {
    s: p.flags.sharp ? sig(ctx, SHARP_SIGMA) : 0,
    t: p.flags.tex ? sig(ctx, TEXTURE_SIGMA) : 0,
    n: p.flags.noise ? sig(ctx, NOISE_SIGMA) : 0,
  };
}

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

function wbGains(temp: number, tint: number): [number, number, number] {
  const t = temp / 100, g = tint / 100;
  const lg = [0.32 * t + 0.12 * g, -0.22 * g, -0.32 * t + 0.12 * g];
  const k = Math.log2(WORKING_LUMA[0] * 2 ** lg[0] + WORKING_LUMA[1] * 2 ** lg[1] + WORKING_LUMA[2] * 2 ** lg[2]);
  return [lg[0] - k, lg[1] - k, lg[2] - k];
}

function adjustUniforms(p: Plan, ctx: StageContext): Record<string, Uniform> {
  const A = new Float32Array(MAX_MASKS * 4), B = new Float32Array(MAX_MASKS * 4), C = new Float32Array(MAX_MASKS * 4);
  const D = new Float32Array(MAX_MASKS * 4), E = new Float32Array(MAX_MASKS * 4);
  p.masks.forEach((m, i) => {
    const a = m.adjustments;
    const o = i * 4;
    const g = wbGains(a.temp, a.tint);
    A.set([g[0], g[1], g[2], a.exposure], o);
    B.set([a.contrast / 100, a.highlights / 100, a.shadows / 100, a.whites / 100], o);
    C.set([a.blacks / 100, a.texture / 100, a.clarity / 100, a.dehaze / 100], o);
    const th = (a.tintColor.hue * Math.PI) / 180, ta = (a.tintColor.amount / 100) * 0.06;
    D.set([(a.hue / 100) * (Math.PI / 3), a.saturation / 100, ta * Math.cos(th), ta * Math.sin(th)], o);
    // Hidden or identity masks (overlay only) get amount 0: drawn, never applied.
    const live = m.visible && !maskIsIdentity(m);
    E.set([a.sharpness / 100, a.noise / 100, live ? m.amount / 100 : 0, 0], o);
  });
  const sg = detailSigmas(ctx, p);
  const flags = (sg.s ? 1 : 0) | (sg.t ? 2 : 0) | (sg.n ? 4 : 0) | (p.flags.clarity ? 8 : 0) | (p.flags.haze ? 16 : 0);
  const ov = ctx.target.maskOverlay;
  return {
    loc_n: u.i(p.masks.length),
    loc_flags: u.i(flags),
    loc_sigS: u.f(Math.max(sg.s, 0.3)),
    loc_sigN: u.f(Math.max(sg.n, 0.3)),
    loc_btF: u.f(textureFactor(sg.t)),
    loc_A: { t: 'v4a', v: A },
    loc_B: { t: 'v4a', v: B },
    loc_C: { t: 'v4a', v: C },
    loc_D: { t: 'v4a', v: D },
    loc_E: { t: 'v4a', v: E },
    loc_ov: u.i(p.overlay),
    loc_ovMode: u.i(ov?.mode === 'bw' ? 1 : 0),
    loc_ovCol: u.v4(...(ov?.color ?? [1, 0, 0]), ov?.opacity ?? 0.5),
  };
}

/** Component arrays for the mask-build pass (coordinates in undistorted source pixels). */
function componentUniforms(p: Plan, ctx: StageContext) {
  const T = new Float32Array(MAX_COMPONENTS * 4), P = new Float32Array(MAX_COMPONENTS * 4);
  const Q = new Float32Array(MAX_COMPONENTS * 4), R = new Float32Array(MAX_COMPONENTS * 4);
  const W = ctx.image.width, H = ctx.image.height;
  const info: number[][] = [];
  let c = 0;
  p.comps.forEach((list, mi) => {
    info.push([c, list.length, p.masks[mi].invert ? 1 : 0, 1]);
    for (const { comp, sc } of list) {
      const o = c * 4;
      const op = comp.op === 'add' ? 0 : comp.op === 'subtract' ? 1 : 2;
      let type = -1;
      let inv = comp.invert;
      switch (comp.type) {
        case 'linear': {
          const q = comp.params as MaskParams['linear'];
          type = 0;
          P.set([q.x1 * W, q.y1 * H, q.x2 * W, q.y2 * H], o);
          break;
        }
        case 'radial': {
          const q = comp.params as MaskParams['radial'];
          type = 1;
          const a = (q.angle * Math.PI) / 180;
          P.set([q.cx * W, q.cy * H, Math.max(1, q.rx * W), Math.max(1, q.ry * H)], o);
          Q.set([Math.cos(a), Math.sin(a), q.feather / 100, 0], o);
          break;
        }
        case 'brush': type = 2; break;
        case 'colorRange': {
          const q = comp.params as MaskParams['colorRange'];
          type = q.samples.length ? 3 : -1;
          const s = q.samples;
          if (s[0]) P.set([s[0].L, s[0].a, s[0].b], o);
          P[o + 3] = q.range / 100;
          if (s[1]) Q.set([s[1].L, s[1].a, s[1].b], o);
          Q[o + 3] = s.length;
          if (s[2]) R.set([s[2].L, s[2].a, s[2].b], o);
          break;
        }
        case 'lumRange': {
          const q = comp.params as MaskParams['lumRange'];
          type = 4;
          P.set([q.lo / 100, q.hi / 100, (q.smoothness / 100) * 0.25, 0], o);
          break;
        }
        default:
          if (sc >= 0) type = 5;
          if (comp.type === 'aiBackground') inv = !inv;
      }
      // A component that cannot be evaluated (no samples, AI not computed) contributes nothing.
      if (type < 0) { type = 6; inv = false; }
      T.set([type, op, inv ? 1 : 0, Math.max(0, sc)], o);
      c++;
    }
  });
  return { T, P, Q, R, info };
}

// ---------------------------------------------------------------------------
// Brush map
// ---------------------------------------------------------------------------

const strokeHashes = new WeakMap<object, string>();
function hashOf(o: object): string {
  let h = strokeHashes.get(o);
  if (!h) {
    const s = JSON.stringify(o);
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193); b = Math.imul(b + s.charCodeAt(i), 0x5bd1e995); }
    h = `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}:${s.length}`;
    strokeHashes.set(o, h);
  }
  return h;
}

/** What each pooled brush target currently holds (base raster reuse while painting). */
const rasterKeys = new WeakMap<RenderTargetTex, string>();

function rasterize(kit: GpuKit, target: RenderTargetTex, guide: WebGLTexture, comps: Array<MaskComponent<'brush'> | null>, upto: 'all' | 'base', ctx: StageContext) {
  const gl = kit.gl;
  const { geo } = ctx;
  const sx = geo.outW / target.width, sy = geo.outH / target.height;
  const W = ctx.image.width, H = ctx.image.height;
  const toMap = (x: number, y: number): [number, number] => {
    const [ox, oy] = project(geo.uToO, x * W, y * H);
    return [ox / sx, oy / sy];
  };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.SCISSOR_TEST);
  try {
    comps.forEach((comp, ch) => {
      if (!comp) return;
      const strokes = upto === 'all' ? comp.params.strokes : comp.params.strokes.slice(0, -1);
      gl.colorMask(ch === 0, ch === 1, ch === 2, false);
      for (const s of strokes) drawStroke(kit, target, guide, s, ch, toMap, ctx, sx);
    });
  } finally {
    gl.colorMask(true, true, true, true);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }
}

function drawStroke(
  kit: GpuKit, target: RenderTargetTex, guide: WebGLTexture, s: MaskParams['brush']['strokes'][number], ch: number,
  toMap: (x: number, y: number) => [number, number], ctx: StageContext, sx: number,
) {
  const gl = kit.gl;
  const n = Math.floor(s.points.length / 3);
  if (!n) return;
  // Radius in map pixels: the brush size in source pixels, scaled like the transform at its start.
  const [x0, y0] = toMap(s.points[0], s.points[1]);
  const [x1, y1] = toMap(s.points[0] + 1 / ctx.image.width, s.points[1]);
  const local = Math.max(0.05, Math.hypot(x1 - x0, y1 - y0)) * sx;
  const r = Math.max(0.75, (s.size * ctx.longEdge * local) / sx);
  const chan = [0, 0, 0, 0];
  chan[ch] = 1;
  const CH = 64;
  for (let start = 0; start < n; start += CH - 1) {
    const end = Math.min(n, start + CH);
    const pts = new Float32Array(CH * 3);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = start; i < end; i++) {
      const [mx, my] = toMap(s.points[i * 3], s.points[i * 3 + 1]);
      const k = (i - start) * 3;
      pts[k] = mx; pts[k + 1] = my; pts[k + 2] = s.points[i * 3 + 2];
      bx0 = Math.min(bx0, mx); by0 = Math.min(by0, my); bx1 = Math.max(bx1, mx); by1 = Math.max(by1, my);
    }
    const x = Math.max(0, Math.floor(bx0 - r - 2)), y = Math.max(0, Math.floor(by0 - r - 2));
    const w = Math.min(target.width, Math.ceil(bx1 + r + 2)) - x, h = Math.min(target.height, Math.ceil(by1 + r + 2)) - y;
    if (w <= 0 || h <= 0) { if (end >= n) break; continue; }
    gl.scissor(x, y, w, h);
    kit.draw(STROKE_FS, target, {
      u_pts: { t: 'v3a', v: pts },
      u_n: u.i(end - start),
      u_r: u.f(r),
      u_hard: u.f(Math.min(0.98, 1 - s.feather / 100)),
      u_flow: u.f(s.flow / 100),
      u_density: u.f(s.density / 100),
      u_erase: u.i(s.erase),
      u_auto: u.i(s.autoMask),
      u_chan: u.v4(...chan),
    }, { u_guide: guide });
    if (end >= n) break;
  }
}

function clearTarget(gl: WebGL2RenderingContext, t: RenderTargetTex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.viewport(0, 0, t.width, t.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function brushMap(p: Plan): MapSpec | null {
  if (!p.brushes.length) return null;
  const key = p.brushes.map((b) => hashOf(b.params.strokes)).join(',');
  return {
    id: 'locBrush',
    until: 'lens',
    edge: BRUSH_EDGE,
    key,
    helpers: [STROKE_FS, COPY_FS],
    build(kit, src, mctx) {
      const out: Record<string, WebGLTexture> = {};
      const groups = Math.ceil(p.brushes.length / 3);
      for (let g = 0; g < groups; g++) {
        const comps = [0, 1, 2].map((k) => p.brushes[g * 3 + k] ?? null);
        // Everything but each component's last stroke is kept in a base raster, so painting a new
        // stroke only draws that stroke.
        const base = kit.rt(`base${g}`, src.width, src.height, 'rgba16f');
        const baseKey = `${src.width}x${src.height}|${comps.map((c) => (c ? c.params.strokes.slice(0, -1).map(hashOf).join('.') : '-')).join('|')}`;
        if (rasterKeys.get(base) !== baseKey) {
          clearTarget(kit.gl, base);
          rasterize(kit, base, src.tex, comps, 'base', mctx);
          rasterKeys.set(base, baseKey);
        }
        const t = kit.rt(`b${g}`, src.width, src.height, 'rgba16f');
        kit.draw(COPY_FS, t, {}, { u_src: base.tex });
        rasterize(kit, t, src.tex, comps.map((c) => (c && c.params.strokes.length ? ({ ...c, params: { strokes: c.params.strokes.slice(-1) } }) : null)), 'all', mctx);
        out[`loc_br${g}`] = t.tex;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Image-wide clarity / haze map
// ---------------------------------------------------------------------------

function toneMap(p: Plan): MapSpec | null {
  if (!p.flags.clarity && !p.flags.haze) return null;
  return {
    id: 'locTone',
    until: 'look',
    edge: MAP_EDGE,
    key: `${+p.flags.clarity}${+p.flags.haze}`,
    draftable: true,
    helpers: [STATS_FS, DARK_FS, GF_COEF_FS],
    build(kit, src, mctx) {
      const out: Record<string, WebGLTexture> = {};
      if (p.flags.clarity) {
        const stats = kit.rt('stats', src.width, src.height, 'rg32f');
        kit.draw(STATS_FS, stats, {}, { u_src: src.tex });
        const r = Math.max(1, Math.round((CLARITY_RADIUS * mctx.longEdge) / mctx.pxScale));
        out.loc_cl = guidedCoefficients(kit, stats, r, 0.04, 'gf', true).tex;
      }
      if (p.flags.haze) {
        const dark = kit.rt('dark', src.width, src.height, 'rg16f');
        kit.draw(DARK_FS, dark, {}, { u_src: src.tex });
        out.loc_hz = kit.gauss(dark, Math.max(1, (HAZE_RADIUS * mctx.longEdge) / mctx.pxScale), 'hz', 'rg16f').tex;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export const localStage: Stage = {
  id: 'loc',
  label: 'Local adjustments',
  kind: 'spatial',
  glsl,
  helpers: [L_FS, AIP_FS, IP_FS, COEF4_FS, MASK_FS, STROKE_FS, COPY_FS, STATS_FS, DARK_FS],
  active: (ctx) => plan(ctx).masks.length > 0,
  reach(ctx) {
    const p = plan(ctx);
    const sg = detailSigmas(ctx, p);
    let r = Math.max(Math.ceil(3 * sg.t), sg.s ? 2 : 0, sg.n ? 3 : 0);
    for (const k of p.ai) { const a = aiRadius(ctx, k); r = Math.max(r, 2 * a + 9); }
    return r + 2;
  },
  uniforms: (ctx) => adjustUniforms(plan(ctx), ctx),
  prepKey(ctx) {
    const p = plan(ctx);
    const sg = detailSigmas(ctx, p);
    const c = componentUniforms(p, ctx);
    return JSON.stringify([sg, p.ai.map((k) => aiRadius(ctx, k)), c.info, Array.from(c.T), Array.from(c.P), Array.from(c.Q), Array.from(c.R), ctx.geo.oToU]);
  },
  maps(ctx) {
    const p = plan(ctx);
    return [brushMap(p), toneMap(p)].filter((m): m is MapSpec => !!m);
  },
  textures(ctx, res): StageTextures {
    const p = plan(ctx);
    const tone = res.map('locTone');
    const out: StageTextures = {
      loc_cl: tone?.loc_cl ?? res.dummy,
      loc_hz: tone?.loc_hz ?? res.dummy,
    };
    // Not samplers of the final pass: listed so the helper-pass cache sees when they change.
    const br = res.map('locBrush');
    if (br) for (const [k, v] of Object.entries(br)) out[`_${k}`] = v;
    p.ai.forEach((k, i) => { const t = res.aiMask(k); if (t) out[`_ai${i}`] = t; });
    return out;
  },
  prepare(ctx, input, kit, res): StageTextures {
    const p = plan(ctx);
    const W = input.width, H = input.height;
    const dummy = res.dummy;
    const sg = detailSigmas(ctx, p);
    // Lightness: base of the detail adjustments and guide of the AI refinement (skipped otherwise).
    const needL = !!(sg.s || sg.t || sg.n || p.ai.length);
    const L = needL ? kit.rt('loc:L', W, H, 'rg16f') : null;
    if (L) kit.draw(L_FS, L, {}, { u_src: input.tex });
    const out: StageTextures = {
      loc_L: L?.tex ?? dummy,
      loc_Bt: dummy,
    };
    // Texture base: a blur of ≥ 4 px computed on a grid 2 or 4 times coarser (aligned with every
    // tile, like the AI statistics) and upsampled bilinearly: a fraction of the memory.
    const btF = textureFactor(sg.t);
    if (sg.t && L) {
      const lo = btF > 1 ? kit.down(L, btF, `loc:Lt${btF}`, 'rg16f') : L;
      out.loc_Bt = kit.gauss(lo, sg.t / btF, 'loc:Bt', 'rg16f').tex;
    }

    // AI bitmaps → frame, refined against the image's lightness: a fast guided filter (scalar
    // guide) whose statistics and coefficients live on a grid 1, 2 or 4 times coarser than the
    // frame (frames and tiles are multiples of 4, so the grid is the same in every tile).
    const aiTex: Record<string, WebGLTexture> = {};
    const aiRef = [0, 0, 0, 0], aiF = [1, 1, 1, 1];
    const lows = new Map<number, RenderTargetTex>();
    p.ai.forEach((key, s) => {
      const tex = res.aiMask(key);
      if (!tex) return;
      const r = aiRadius(ctx, key);
      // Statistics on a coarser grid (1, 2 or 4: tile-aligned); ≥ 2 low-res texels of radius.
      const f = r >= 4 ? 4 : r >= 2 ? 2 : 1;
      const w = Math.ceil(W / f), h = Math.ceil(H / f);
      aiF[s] = f;
      const pt = kit.rt(`loc:p${s}`, w, h, 'rgba16f');
      kit.draw(AIP_FS, pt, { u_view: u.m3(input.view), u_oToU: u.m3(ctx.geo.oToU), u_srcSize: u.v2(ctx.image.width, ctx.image.height), u_f: u.f(f) }, { u_ai: tex });
      if (!r) { aiTex[`u_b${s}`] = pt.tex; return; }
      // Downsampled (I, I²) and its box mean, shared by bitmaps on the same grid.
      let gsm = lows.get(f * 1000 + r);
      if (!gsm) {
        const lo = f > 1 ? kit.down(L!, f, `loc:Ld${f}`, 'rg32f') : L!;
        gsm = kit.box(lo, Math.max(1, Math.round(r / f)), `loc:gsm${f}:${r}`, 'rg32f');
        lows.set(f * 1000 + r, gsm);
        lows.set(-f, lo);
      }
      const lo = lows.get(-f)!;
      const rl = Math.max(1, Math.round(r / f));
      // Means of p and I·p in 16-bit: errors in the covariance only matter where the guide varies,
      // and there they are far below its variance; flat areas reduce to the mean of p anyway.
      const mp = kit.box(pt, rl, `loc:mp${s}`, 'rgba16f');
      const ip = kit.rt(`loc:ip${s}`, w, h, 'rgba16f');
      kit.draw(IP_FS, ip, {}, { u_L: lo.tex, u_p: pt.tex });
      const mip = kit.box(ip, rl, `loc:mip${s}`, 'rgba16f');
      const a = kit.rt(`loc:ca${s}`, w, h, 'rgba16f');
      const b = kit.rt(`loc:cb${s}`, w, h, 'rgba16f');
      const tx = { u_mg: gsm.tex, u_mp: mp.tex, u_mip: mip.tex };
      kit.draw(COEF4_FS, a, { u_eps: u.f(GF_EPS), u_which: u.i(0) }, tx);
      kit.draw(COEF4_FS, b, { u_eps: u.f(GF_EPS), u_which: u.i(1) }, tx);
      aiTex[`u_a${s}`] = kit.box(a, rl, `loc:A${s}`, 'rgba16f').tex;
      aiTex[`u_b${s}`] = kit.box(b, rl, `loc:B${s}`, 'rgba16f').tex;
      aiRef[s] = 1;
    });

    const br = res.map('locBrush') ?? {};
    const brushTex: Record<string, WebGLTexture> = {};
    for (let g = 0; g < 4; g++) if (br[`loc_br${g}`]) brushTex[`u_br${g}`] = br[`loc_br${g}`];
    const c = componentUniforms(p, ctx);
    const groups = Math.ceil(p.masks.length / 4);
    const info = new Float32Array(MAX_MASKS * 4);
    c.info.forEach((m, k) => info.set(m, k * 4));
    const needLab = p.comps.some((l) => l.some((x) => x.comp.type === 'colorRange' || x.comp.type === 'lumRange'));
    const targets = Array.from({ length: groups }, (_, g) => kit.rt(`loc:m${g}`, W, H, 'rgba16f'));
    kit.drawMRT(MASK_FS, targets, {
      u_aiRef: u.v4(...aiRef),
      u_aiF: u.v4(...aiF),
      u_needLab: u.i(needLab),
      u_needI: u.i(!!L && aiRef.some((x) => x > 0)),
      u_n: u.i(p.masks.length),
      u_view: u.m3(input.view),
      u_oToU: u.m3(ctx.geo.oToU),
      u_outSize: u.v2(ctx.geo.outW, ctx.geo.outH),
      u_m: { t: 'v4a', v: info },
      u_cT: { t: 'v4a', v: c.T },
      u_cP: { t: 'v4a', v: c.P },
      u_cQ: { t: 'v4a', v: c.Q },
      u_cR: { t: 'v4a', v: c.R },
    }, { u_prev: input.tex, ...(L ? { u_L: L.tex } : {}), ...brushTex, ...aiTex });
    for (let g = 0; g < 4; g++) out[`loc_m${g}`] = targets[g]?.tex ?? dummy;
    return out;
  },
};

/** Size of the brush map for an output frame (UI hit-testing and tests). */
export const brushMapDims = (ctx: Pick<StageContext, 'geo' | 'longEdge'>) => mapDims(ctx, BRUSH_EDGE);
