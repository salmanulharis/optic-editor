/**
 * Stage 80 — halation and bloom: light that spreads around bright highlights, added in linear light.
 *
 *  - Halation: the red/orange glow film gets when light scatters back off the film base into the
 *    red-sensitive layer (the Cinestill look). A soft-thresholded luminance of the highlights is
 *    blurred (0.15 %–2 % of the long edge); what spills beyond the highlight is added with a hue.
 *  - Bloom: a diffusion-filter glow (Pro-Mist). The thresholded highlights, in colour, are blurred
 *    at four scales (σ · 0.35 / 0.7 / 1.4 / 2.8, weights 0.4 / 0.3 / 0.2 / 0.1) for a bright core
 *    and a long, soft tail, optionally warmed or cooled.
 * Both redistribute light rather than add it: glow = blurred highlights − the pixel's own
 * highlight, so large uniform bright areas are unchanged and the light spreads into the shadows.
 *
 * Both come from an image-wide map (1024 px long edge, the image after stage 75): threshold → box
 * pyramid → Gaussian blur at the pyramid level where the kernel is a few texels wide → combine.
 * Cheap at any resolution, and identical in the preview and every export tile.
 */
import { XYZ_TO_WORKING, mul, mulVec, toXYZ_D65 } from '../../color/matrices';
import { srgbToLinear } from '../../color/transfer';
import { mapDims } from '../mapDims';
import type { MapSpec, Stage, StageContext, StageTextures } from '../types';
import { u } from '../types';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
const vec3 LUMA = vec3(0.2627, 0.6780, 0.0593);
`;

const EDGE = 1024;

/** (bloom source rgb, halation source). */
const PREP_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_thr; // bloom, halation thresholds (luminance)
void main() {
  vec3 c = max(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 0.0);
  float Y = dot(c, LUMA);
  float wb = smoothstep(u_thr.x, u_thr.x + 0.25, Y);
  float wh = smoothstep(u_thr.y, u_thr.y + 0.2, Y);
  o = vec4(c * wb, min(Y, 4.0) * wh);
}`;

/** Weighted sum of up to four textures sampled at the same map position. */
const COMBINE_FS = /* glsl */ `${HEAD}
uniform sampler2D u_t0;
uniform sampler2D u_t1;
uniform sampler2D u_t2;
uniform sampler2D u_t3;
uniform vec4 u_w;
uniform vec2 u_uv0;
uniform vec2 u_uv1;
uniform vec2 u_uv2;
uniform vec2 u_uv3;
uniform vec2 u_mapPerFrag; // map-normalised units per output fragment
void main() {
  vec2 m = gl_FragCoord.xy * u_mapPerFrag;
  o = u_w.x * texture(u_t0, m * u_uv0) + u_w.y * texture(u_t1, m * u_uv1) + u_w.z * texture(u_t2, m * u_uv2) + u_w.w * texture(u_t3, m * u_uv3);
}`;

const glsl = /* glsl */ `
uniform sampler2D glow_bloom;
uniform sampler2D glow_hal;
uniform vec2 glow_bUv;
uniform vec2 glow_hUv;
uniform float glow_bAmt;
uniform vec3 glow_bTint;
uniform float glow_hAmt;
uniform vec3 glow_hColor;
uniform vec2 glow_thr; // bloom, halation thresholds

// Light is redistributed, not just added: the glow is the spread highlight minus the pixel's own
// highlight, so a large uniformly bright area stays as it is while light spills into darker
// neighbours (and a small highlight's core gives a little of its light to its halo).
vec4 glow_apply(vec4 c) {
  vec2 m = g_px / u_fullSize;
  vec3 x = max(c.rgb, 0.0);
  float Y = luma(x);
  if (glow_bAmt > 0.0) {
    vec3 g = texture(glow_bloom, m * glow_bUv).rgb - x * smoothstep(glow_thr.x, glow_thr.x + 0.25, Y);
    c.rgb += glow_bAmt * glow_bTint * mix(g * 0.3, g, step(0.0, g));
  }
  if (glow_hAmt > 0.0) {
    float h = texture(glow_hal, m * glow_hUv).a - min(Y, 4.0) * smoothstep(glow_thr.y, glow_thr.y + 0.2, Y);
    c.rgb += glow_hAmt * glow_hColor * max(h, 0.0);
  }
  return c;
}
`;

const BLOOM_SCALES = [0.35, 0.7, 1.4, 2.8];
const BLOOM_WEIGHTS = [0.4, 0.3, 0.2, 0.1];

/** Blur sizes in map texels, pyramid levels (downsample factors) and uv scales. */
function plan(ctx: StageContext) {
  const e = ctx.recipe.effects;
  const edge = EDGE * ctx.mapScale; // texels per source long edge (half while dragging)
  const { w, h } = mapDims(ctx, edge);
  const level = (sigma: number) => Math.max(0, Math.min(4, Math.floor(Math.log2(sigma / 2.5))));
  const uv = (f: number): [number, number] => [w / (f * Math.ceil(w / f)), h / (f * Math.ceil(h / f))];
  const sigmaH = (0.0015 + 0.0185 * Math.pow(e.halation.radius / 100, 1.5)) * edge;
  const sigmaB = (0.005 + 0.07 * Math.pow(e.bloom.radius / 100, 1.3)) * edge;
  const hf = 1 << level(sigmaH);
  const bl = BLOOM_SCALES.map((s) => { const sg = sigmaB * s; return { sigma: sg, f: 1 << level(sg) }; });
  return {
    w, h, sigmaH, sigmaB, hf, hUv: uv(hf), bl, bUv: uv(bl[0].f),
    thrB: 0.3 + 0.65 * (e.bloom.threshold / 100),
    thrH: 0.45 + 0.5 * (e.halation.threshold / 100),
    uv,
  };
}

const SRGB_TO_WORKING = mul(XYZ_TO_WORKING, toXYZ_D65('srgb'));
const WLUMA = [0.2627, 0.678, 0.0593];

/** Fully saturated colour of a hue (degrees, HSV-style) in working space, with luminance `Y`. */
function hueColor(deg: number, Y: number): [number, number, number] {
  const hh = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((hh % 2) - 1);
  const rgb = hh < 1 ? [1, x, 0] : hh < 2 ? [x, 1, 0] : hh < 3 ? [0, 1, x] : hh < 4 ? [0, x, 1] : hh < 5 ? [x, 0, 1] : [1, 0, x];
  const w = mulVec(SRGB_TO_WORKING, rgb.map(srgbToLinear) as [number, number, number]);
  const l = w[0] * WLUMA[0] + w[1] * WLUMA[1] + w[2] * WLUMA[2];
  return [w[0] * (Y / l), w[1] * (Y / l), w[2] * (Y / l)];
}

function warmTint(warmth: number): [number, number, number] {
  const t = warmth / 100;
  const c = t >= 0 ? [1, 1 - 0.18 * t, 1 - 0.42 * t] : [1 + 0.25 * t, 1 + 0.08 * t, 1];
  const w = mulVec(SRGB_TO_WORKING, c as [number, number, number]);
  const l = w[0] * WLUMA[0] + w[1] * WLUMA[1] + w[2] * WLUMA[2];
  return [w[0] / l, w[1] / l, w[2] / l];
}

export const glowStage: Stage = {
  id: 'glow',
  label: 'Halation & bloom',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.effects.halation.amount > 0 || ctx.recipe.effects.bloom.amount > 0,
  uniforms(ctx) {
    const e = ctx.recipe.effects;
    const p = plan(ctx);
    return {
      glow_bUv: u.v2(...p.bUv),
      glow_hUv: u.v2(...p.hUv),
      glow_bAmt: u.f((e.bloom.amount / 100) * 0.8),
      glow_bTint: u.v3(warmTint(e.bloom.warmth)),
      glow_hAmt: u.f((e.halation.amount / 100) * 1.4),
      glow_hColor: u.v3(hueColor(e.halation.hue, 0.45)),
      glow_thr: u.v2(p.thrB, p.thrH),
    };
  },
  maps: (ctx): MapSpec[] => {
    const e = ctx.recipe.effects;
    if (!(e.halation.amount > 0 || e.bloom.amount > 0)) return [];
    const p = plan(ctx);
    return [{
      id: 'glow',
      until: 'look',
      edge: EDGE,
      key: JSON.stringify([p.thrB, p.thrH, p.sigmaH, p.sigmaB, e.halation.amount > 0, e.bloom.amount > 0]),
      draftable: true,
      helpers: [PREP_FS, COMBINE_FS],
      build(kit, src, mctx) {
        const q = plan(mctx);
        const prep = kit.rt('prep', src.width, src.height);
        kit.draw(PREP_FS, prep, { u_thr: u.v2(q.thrB, q.thrH) }, { u_src: src.tex });
        const at = (f: number) => (f === 1 ? prep : kit.down(prep, f, `down${f}`));
        const out: Record<string, WebGLTexture> = {};
        if (e.halation.amount > 0) {
          const base = at(q.hf);
          out.glow_hal = kit.gauss(base, q.sigmaH / q.hf, 'hal').tex;
        }
        if (e.bloom.amount > 0) {
          const levels = q.bl.map((b, i) => kit.gauss(at(b.f), b.sigma / b.f, `bloom${i}`));
          const f0 = q.bl[0].f;
          const dst = kit.rt('bloom', Math.ceil(src.width / f0), Math.ceil(src.height / f0));
          const uvOf = (i: number) => u.v2(...q.uv(q.bl[i].f));
          kit.draw(COMBINE_FS, dst, {
            u_w: u.v4(...BLOOM_WEIGHTS),
            u_uv0: uvOf(0), u_uv1: uvOf(1), u_uv2: uvOf(2), u_uv3: uvOf(3),
            u_mapPerFrag: u.v2(f0 / src.width, f0 / src.height),
          }, { u_t0: levels[0].tex, u_t1: levels[1].tex, u_t2: levels[2].tex, u_t3: levels[3].tex });
          out.glow_bloom = dst.tex;
        }
        return out;
      },
    }];
  },
  textures: (_ctx, res): StageTextures => {
    const m = res.map('glow');
    return { glow_bloom: m?.glow_bloom ?? res.dummy, glow_hal: m?.glow_hal ?? res.dummy };
  },
};
