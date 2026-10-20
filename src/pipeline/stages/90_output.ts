/**
 * Stage 90 — output: working (linear Rec.2020) → destination space, gamut compression,
 * transfer function, optional dither and clipping overlay.
 *
 * Soft gamut compression (instead of hard per-channel clipping, which shifts hues and flattens
 * gradients): in OKLCH we find, by bisection, the largest chroma at this lightness and hue that
 * is still inside the destination gamut (no negative channels). With r = C / Cmax, chroma inside
 * r ≤ 0.9 is untouched; r ∈ [0.9, 1.6] is compressed into [0.9, 1.0] by the same smooth rational
 * curve the tone shoulder uses, preserving lightness and hue. Colours beyond 1.6× the boundary land
 * on it. Brightness above 1.0 has already been handled by the tone stage; a final clamp catches
 * the remainder.
 *
 * Compression is skipped when it cannot be needed: a non-RAW source exported/previewed in its own
 * colour space with no colour-expanding edits. That keeps a default export bit-identical in colour.
 */
import { type ColorSpaceId, COLOR_SPACES, IDENTITY, inv, mul, toXYZ_D65, workingTo } from '../../color/matrices';
import { HSL_BANDS } from '../../recipe/schema';
import type { Stage, StageContext } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform mat3 out_matrix;
uniform mat3 out_display;   // target space → destination space (identity except soft-proofing)
uniform int out_transfer;   // 0 linear, 1 sRGB, 2 pure gamma
uniform float out_gamma;
uniform int out_gamut;
uniform int out_dither;
uniform float out_seed;
uniform int out_overlay;

vec3 out_encode(vec3 v) {
  v = clamp(v, 0.0, 1.0);
  if (out_transfer == 1) return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, v));
  if (out_transfer == 2) return pow(v, vec3(1.0 / out_gamma));
  return v;
}

float out_inGamut(vec3 lch) { return min3(out_matrix * fromOklch(lch)); }

vec3 out_gamutMap(vec3 w) {
  vec3 t = out_matrix * w;
  if (out_gamut == 0) return t;
  vec3 lch = toOklch(w);
  if (lch.y < 1e-5 || lch.x <= 0.0) return max(t, 0.0);
  // Bisection for the boundary scale s_b in [0, 4]: chroma × s_b is just inside the gamut.
  float lo = 0.0, hi = 4.0;
  if (out_inGamut(vec3(lch.x, lch.y * hi, lch.z)) >= 0.0) return t; // far inside
  for (int i = 0; i < 10; i++) {
    float mid = 0.5 * (lo + hi);
    if (out_inGamut(vec3(lch.x, lch.y * mid, lch.z)) >= 0.0) lo = mid; else hi = mid;
  }
  float r = 1.0 / max(lo, 1e-4);       // chroma relative to the boundary
  const float thr = 0.9, lim = 1.6;
  if (r <= thr) return t;
  float X = (lim - thr) / (1.0 - thr);
  float a = (X - 1.0) / X;
  float x = min((r - thr) / (1.0 - thr), X);
  float r2 = thr + (1.0 - thr) * x / (1.0 + a * x);
  lch.y *= r2 / r;
  return max(out_matrix * fromOklch(lch), 0.0);
}

vec4 out_apply(vec4 c) {
  vec3 t = out_gamutMap(c.rgb);
  vec3 e = out_encode(out_display * clamp(t, 0.0, 1.0));
  if (out_overlay == 1) {
    if (max3(t) >= 0.999) e = vec3(1.0, 0.15, 0.15);
    else if (max3(t) <= 0.0015) e = vec3(0.15, 0.35, 1.0);
  }
  if (out_dither == 1) {
    vec2 p = gl_FragCoord.xy + out_seed;
    e += (hash12(p) - hash12(p + 71.7)) / 255.0;
  }
  return vec4(e, 1.0);
}
`;

function colorEditsActive(ctx: StageContext): boolean {
  const r = ctx.recipe;
  return (
    r.presence.vibrance !== 0 ||
    r.presence.saturation !== 0 ||
    r.whiteBalance.temperature !== 0 ||
    r.whiteBalance.tint !== 0 ||
    r.whiteBalance.castStrength > 0 ||
    HSL_BANDS.some((b) => r.hsl.bands[b].sat > 0 || r.hsl.bands[b].hue !== 0 || r.hsl.bands[b].lum !== 0) ||
    r.curve.r.length > 2 || r.curve.g.length > 2 || r.curve.b.length > 2 ||
    r.light.contrast > 0
  );
}

function needsGamutCompression(ctx: StageContext, space: ColorSpaceId): boolean {
  const c = ctx.image.color;
  if (c.kind === 'raw') return true;
  if (c.spaceId !== space) return true;
  return colorEditsActive(ctx);
}

export const outputStage: Stage = {
  id: 'out',
  label: 'Output',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.target.mode === 'encoded',
  uniforms(ctx) {
    const dest = ctx.target.displaySpace ?? ctx.target.space;
    const cs = COLOR_SPACES[dest];
    const display = dest === ctx.target.space
      ? IDENTITY
      : mul(inv(toXYZ_D65(dest)), toXYZ_D65(ctx.target.space));
    return {
      out_matrix: u.m3(workingTo(ctx.target.space)),
      out_display: u.m3(display),
      out_transfer: u.i(cs.transfer === 'srgb' ? 1 : cs.transfer === 'gamma' ? 2 : 0),
      out_gamma: u.f(cs.gamma ?? 2.2),
      out_gamut: u.i(needsGamutCompression(ctx, ctx.target.space)),
      out_dither: u.i(ctx.target.dither),
      out_seed: u.f(0),
      out_overlay: u.i(ctx.target.clipOverlay),
    };
  },
};
