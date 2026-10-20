/**
 * Stage 84 — film grain, one of the last stages so the grain itself is not colour-graded.
 *
 * The grain is a precomputed, tileable, blue-noise-like texture (gl/grainNoise.ts) sampled at three
 * octaves with incommensurate scales (1, 1.618, 0.707) and rotations (0°, 37°, 71°), so its 512-texel
 * period never shows. Grain is anchored to output pixels and its size is a fraction of the source
 * long edge (a 24 MP reference), so it is the same relative size on every image.
 *
 * Resolution independence: the texture is sampled with an explicit mip level = log2(output pixels
 * per screen pixel / grain texel), i.e. exactly the area average of the full-resolution grain. At
 * 100 % zoom the preview is the export pixel for pixel; at Fit it shows the grain as the
 * downscaled export would.
 * Seeded from the photo's identity: the same photo always gets the same grain.
 *
 * Tonal response like film: strongest in the midtones, weaker in deep shadows and highlights.
 * Roughness weights the larger octave and sharpens the grain profile (gentle clumping by a coarse
 * field); colour grain adds chroma noise in OKLab a, b.
 */
import type { Stage, StageTextures } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform sampler2D grain_tex;
uniform float grain_amp;
uniform float grain_texel;
uniform float grain_lod;
uniform float grain_rough;
uniform float grain_color;
uniform vec4 grain_seed;

vec4 grain_oct(vec2 p, float scale, float ang, vec2 off) {
  float cs = cos(ang), sn = sin(ang);
  vec2 q = mat2(cs, sn, -sn, cs) * (p / (grain_texel * scale)) + off;
  return textureLod(grain_tex, q / 512.0, max(grain_lod - log2(scale), 0.0));
}

vec4 grain_apply(vec4 c) {
  vec4 n1 = grain_oct(g_px, 1.0, 0.0, grain_seed.xy);
  vec4 n2 = grain_oct(g_px, 1.618, 0.6458, grain_seed.zw);
  vec4 n3 = grain_oct(g_px, 0.7071, 1.2392, grain_seed.yx);
  // Weights with squares summing to ~1 (unit variance at full resolution). Roughness shifts weight
  // to the larger octave and gives the grain a crisper, heavier-tailed profile; clumping by the
  // coarse field stays gentle (strong modulation reads as mottle, not grain).
  float w2 = mix(0.5, 0.78, grain_rough), w1 = mix(0.66, 0.45, grain_rough);
  vec3 n = (w1 * n1.rgb + w2 * n2.rgb + 0.56 * n3.rgb) / sqrt(w1 * w1 + w2 * w2 + 0.3136);
  n = sign(n) * pow(abs(n), vec3(mix(1.0, 0.75, grain_rough))) * mix(1.0, 0.9, grain_rough);
  float clump = mix(1.0, 0.8 + 0.4 * smoothstep(-1.5, 1.5, n2.a), grain_rough);
  vec3 lab = toOklab(c.rgb);
  float L = clamp(lab.x, 0.0, 1.0);
  float tone = (0.25 + 0.75 * smoothstep(0.02, 0.32, L)) * (1.0 - 0.7 * smoothstep(0.72, 1.0, L));
  float a = grain_amp * tone * clump;
  lab.x += a * n.r;
  lab.yz += a * grain_color * 0.45 * n.gb;
  return vec4(fromOklab(lab), c.a);
}
`;

/** Grain texel size in full-resolution pixels at a 24 MP (6000 px) reference. */
export function grainTexelRef(size: number) {
  return 0.45 + 2.4 * Math.pow(size / 100, 1.3);
}

/** FNV-1a → four offsets in texels: the grain pattern of a photo. */
function seedFor(key: string): [number, number, number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    out.push(((h >>> 0) % 51200) / 100);
  }
  return out as [number, number, number, number];
}

export const grainStage: Stage = {
  id: 'grain',
  label: 'Grain',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.effects.grain.amount > 0,
  uniforms(ctx) {
    const g = ctx.recipe.effects.grain;
    const texel = grainTexelRef(g.size) * (ctx.longEdge / 6000);
    return {
      grain_amp: u.f((g.amount / 100) * 0.1),
      grain_texel: u.f(texel),
      grain_lod: u.f(Math.log2(Math.max(1e-6, ctx.pxScale / texel))),
      grain_rough: u.f(g.roughness / 100),
      grain_color: u.f(g.color / 100),
      grain_seed: u.v4(...seedFor(ctx.image.key)),
    };
  },
  textures: (_ctx, res): StageTextures => ({ grain_tex: res.grain() }),
};
