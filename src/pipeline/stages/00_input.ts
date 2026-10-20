/**
 * Stage 00 — input. Samples the source texture at a full-resolution pixel position, and computes
 * the clipping mask (alpha) from the untouched source values.
 * Optional spatial clean-up for low-bit-depth sources happens here, before any tone/colour work:
 *  - deband: edge-aware (f3kdb-style) — replaces a pixel by the mean of 4 jittered samples at a
 *    ~14 px radius, but only where all samples are within a tiny threshold (i.e. a flat gradient).
 *  - deblock: 3×3 bilateral filter with a small range sigma (mild JPEG artefact reduction).
 * Both work on a gamma-2.2 encoding so thresholds are perceptual.
 *
 * With crop / geometry / lens corrections active (HAS_LENS, stage 05), the output pixel is first
 * mapped to the undistorted source position and every fetch goes through the lens model, so the
 * source is resampled exactly once.
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform sampler2D input_tex;
uniform vec4 input_region;   // x, y, w, h of the texture in full-resolution pixels
uniform float input_lod;
uniform int input_deband;
uniform float input_debandThr;
uniform int input_deblock;
uniform int input_raw;

#ifdef HAS_LENS
vec2 lens_map(vec2 o);
vec3 lens_fetchU(vec2 p);
bool lens_inside(vec2 p);
vec3 lens_finish(vec2 p, vec3 c);
#endif

// Source pixel → texel (no lens model).
vec3 input_texel(vec2 px) {
  px = clamp(px, vec2(0.5), u_srcSize - 0.5);
  return textureLod(input_tex, (px - input_region.xy) / input_region.zw, input_lod).rgb;
}
vec3 input_fetch(vec2 px) {
#ifdef HAS_LENS
  return lens_fetchU(px);
#else
  return input_texel(px);
#endif
}
vec3 input_enc(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 input_dec(vec3 e) { return pow(max(e, 0.0), vec3(2.2)); }

vec4 input_filter(vec2 px);

vec4 input_sample(vec2 o) {
#ifdef HAS_LENS
  vec2 px = lens_map(o);
  if (!lens_inside(px)) return vec4(0.0);
  vec4 c = input_filter(px);
  return vec4(lens_finish(px, c.rgb), c.a);
#else
  return input_filter(o);
#endif
}

vec4 input_filter(vec2 px) {
  vec3 c = input_fetch(px);
  float clip = smoothstep(0.94, 0.995, max3(c));
  // Display-referred sources: only near-white clipping counts (a saturated colour touching 1.0
  // in one channel is a real colour, not lost highlight detail).
  if (input_raw == 0) clip *= smoothstep(0.55, 0.85, min3(c));
  if (input_deband == 0 && input_deblock == 0) return vec4(c, clip);
  vec3 e = input_enc(c);
  if (input_deblock == 1) {
    vec3 acc = e; float wsum = 1.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec3 s = input_enc(input_fetch(px + vec2(i, j)));
      vec3 d = s - e;
      float w = exp(-dot(d, d) / (2.0 * 0.018 * 0.018)) * (i * j == 0 ? 1.0 : 0.6);
      acc += s * w; wsum += w;
    }
    e = acc / wsum;
  }
  if (input_deband == 1) {
    // 4 symmetric pairs at a per-pixel random rotation and radius: symmetric pairs average a
    // linear ramp exactly, and the random offsets turn 8-bit steps back into a smooth slope.
    float ang = hash12(floor(px) + 0.5) * TAU;
    vec3 acc = vec3(0.0);
    float maxDiff = 0.0;
    for (int k = 0; k < 4; k++) {
      float a = ang + float(k) * (PI * 0.25);
      float r = 8.0 + 16.0 * hash12(floor(px) + vec2(17.31 * float(k + 1), 3.7));
      vec2 d = r * vec2(cos(a), sin(a));
      vec3 s1 = input_enc(input_fetch(px + d));
      vec3 s2 = input_enc(input_fetch(px - d));
      maxDiff = max(maxDiff, max3(max(abs(s1 - e), abs(s2 - e))));
      acc += s1 + s2;
    }
    float w = 1.0 - smoothstep(input_debandThr * 0.5, input_debandThr, maxDiff);
    e = mix(e, acc * 0.125, w);
  }
  return vec4(input_dec(e), clip);
}
`;

export const inputStage: Stage = {
  id: 'input',
  label: 'Input',
  kind: 'source',
  glsl,
  active: () => true,
  uniforms(ctx) {
    const l = ctx.recipe.light;
    const deband = l.deband === 'on' || (l.deband === 'auto' && !ctx.image.isRaw && ctx.image.bitDepth <= 8);
    return {
      input_deband: u.i(deband),
      // ~3.5 code values of an 8-bit source, in gamma-2.2 units (edges are far larger)
      input_debandThr: u.f(3.5 / 255),
      input_deblock: u.i(l.deblock && !ctx.image.isRaw),
      input_raw: u.i(ctx.image.isRaw),
    };
  },
};
