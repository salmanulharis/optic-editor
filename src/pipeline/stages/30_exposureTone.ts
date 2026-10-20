/**
 * Stage 30 — exposure and tone (exposure, contrast, highlights, shadows, whites, blacks).
 *
 * Everything is luminance-driven and hue-preserving (RGB is scaled by a common factor):
 *  1. Exposure: × 2^EV in linear light.
 *  2. Shadows / highlights: an EV offset that depends on log2(Y / 0.18): a bell around −2.5 EV for
 *     shadows, a rising ramp above mid grey for highlights. Slopes stay < 1 so tones never invert.
 *  3. Contrast: scales log-luminance around middle grey (0.18), within ±6/4 EV of it.
 *  4. Filmic shoulder on max(R,G,B): identity below a knee, then a rational roll-off
 *     t / (1 + a·t) that maps the *image of the source white* (W) exactly to 1.0. So values above
 *     1.0 (RAW headroom, or +EV on a JPEG) are compressed smoothly instead of clipping, and at
 *     default settings on a JPEG (W = 1) the curve is exactly the identity.
 *     Whites moves W; strong compression also desaturates toward luminance (like film).
 *  5. Blacks: a soft pedestal confined to the bottom quarter of the range.
 * Clipped source areas (alpha mask) resist being pulled down, which avoids grey/coloured blotches.
 *
 * RAW files additionally get a gentle base contrast (like a camera profile's base curve), so the
 * default render looks natural rather than flat; non-RAW files are untouched at default.
 */
import type { Stage } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform float tone_gain;
uniform float tone_contrast;
uniform float tone_shadows;
uniform float tone_highlights;
uniform float tone_whites;      // multiplier on W
uniform float tone_blacks;
uniform float tone_srcWhite;
uniform float tone_clipProtect;

float tone_ev(float Y, float clip) {
  float l = log2(max(Y, 1e-7) / 0.18);
  float ev = tone_shadows * exp(-pow((l + 2.5) / 1.8, 2.0)) + tone_highlights * smoothstep(-0.5, 3.0, l);
  if (ev < 0.0) ev *= mix(1.0, 0.35, clip * tone_clipProtect);
  float l2 = l + ev;
  return ev + tone_contrast * clamp(l2, -6.0, 4.0);
}

// Maps [0, W] → [0, 1]; identity when W == 1; C1-continuous at the knee.
float tone_shoulder(float n, float W, out float slope) {
  float k = min(0.6, 0.8 * W);
  slope = 1.0;
  if (n <= k) return n;
  float T = (W - k) / (1.0 - k);
  float a = (T - 1.0) / T;
  float t = min((n - k) / (1.0 - k), T);
  float den = 1.0 + a * t;
  slope = 1.0 / (den * den);
  return k + (1.0 - k) * t / den;
}

vec4 tone_apply(vec4 c) {
  vec3 x = c.rgb * tone_gain;
  float Y = max(luma(x), 0.0);
  x *= exp2(tone_ev(Y, c.a));

  // White point: where the brightest source value lands after the adjustments above.
  float sw = tone_srcWhite * tone_gain;
  float W = max(1.0, sw * exp2(tone_ev(sw, 0.0))) * tone_whites;

  float n = max3(x);
  if (n > 1e-8) {
    float slope;
    float m = tone_shoulder(n, W, slope);
    // Blacks: soft pedestal in the bottom quarter (monotone for |blacks| ≤ 1).
    m = max(0.0, m + tone_blacks * 0.05 * (1.0 - smoothstep(0.0, 0.25, m)));
    x *= m / n;
    x = mix(x, vec3(luma(x)), clamp(1.0 - slope, 0.0, 1.0) * 0.5);
  }
  return vec4(x, c.a);
}
`;

export const RAW_BASE_CONTRAST = 0.12;

export const exposureToneStage: Stage = {
  id: 'tone',
  label: 'Exposure & tone',
  kind: 'point',
  glsl,
  active(ctx) {
    if (ctx.image.isRaw) return true;
    const l = ctx.recipe.light;
    return !!(l.exposure || l.contrast || l.highlights || l.shadows || l.whites || l.blacks);
  },
  uniforms(ctx) {
    const l = ctx.recipe.light;
    const c = l.contrast / 100;
    const base = ctx.image.isRaw ? RAW_BASE_CONTRAST : 0;
    const srcWhite = ctx.image.isRaw && ctx.image.color.kind === 'raw'
      ? Math.pow(2, ctx.image.color.profile.baselineExposure)
      : 1;
    return {
      tone_gain: u.f(Math.pow(2, l.exposure)),
      tone_contrast: u.f(base + (c > 0 ? c * 0.6 : c * 0.45)),
      tone_shadows: u.f((l.shadows / 100) * 1.5),
      tone_highlights: u.f((l.highlights / 100) * (l.highlights < 0 ? 1.5 : 1.0)),
      tone_whites: u.f(Math.pow(2, (-l.whites / 100) * 1.25)),
      tone_blacks: u.f(l.blacks / 100),
      tone_srcWhite: u.f(srcWhite),
      tone_clipProtect: u.f(ctx.image.isRaw ? 0 : 1),
    };
  },
};
