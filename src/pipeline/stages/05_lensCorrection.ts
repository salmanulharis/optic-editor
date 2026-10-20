/**
 * Stage 05 — lens correction and geometry (a `warp` stage: compiled into the first pass, where the
 * input stage calls it to find and sample the source).
 *
 *  lens_map(o)     output pixel → undistorted source position U: crop, straighten, quarter turns,
 *                  flips and the upright/transform homography as ONE projective matrix.
 *  lens_fetchU(u)  samples the source at U through the lens model (geometry/lens.ts): manual
 *                  distortion, the profile (DNG WarpRectilinear in raw coordinates, or lensfun
 *                  ptlens/poly3/poly5 + TCA in Hugin units) and lateral CA. Red, green and blue
 *                  are fetched at their own positions only when CA or a per-plane profile needs it.
 *  lens_finish     vignetting corrections (manual, DNG FixVignetteRadial, lensfun pa, DNG GainMap)
 *                  and defringing (purple / green fringes next to high-contrast edges lose chroma).
 * Areas that map outside the source (after strong transforms) are black.
 */
import type { Stage, StageTextures } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform mat3 lens_oToU;
uniform int lens_geo;
uniform int lens_on;
uniform int lens_perChannel;
uniform vec2 lens_c;
uniform float lens_n;
uniform float lens_k;
uniform int lens_mode;
uniform mat3 lens_sToRaw;
uniform mat3 lens_rawToS;
uniform vec2 lens_dngC;
uniform float lens_dngM;
uniform vec4 lens_kr[3];
uniform vec2 lens_kt[3];
uniform vec2 lens_lfC;
uniform float lens_lfN;
uniform float lens_lfDist[5];
uniform vec3 lens_lfTca[2];
uniform vec2 lens_ca;
uniform vec2 lens_vigMan;
uniform float lens_vigDng[5];
uniform vec2 lens_vigDngC;
uniform float lens_vigDngM;
uniform vec3 lens_vigLf;
uniform int lens_hasGain;
uniform sampler2D lens_gainTex;
uniform mat3 lens_gainM;
uniform vec3 lens_purple;
uniform vec3 lens_green;
uniform float lens_fringeR;

vec2 lens_map(vec2 o) {
  if (lens_geo == 0) return o;
  vec3 h = lens_oToU * vec3(o, 1.0);
  return h.xy / h.z;
}

vec2 lens_toS(vec2 p, int ch) {
  if (lens_on == 0) return p;
  if (lens_k != 0.0) {
    vec2 d = (p - lens_c) / lens_n;
    p = lens_c + d * (1.0 + lens_k * dot(d, d)) * lens_n;
  }
  if (lens_mode == 1) {
    vec2 q = (lens_sToRaw * vec3(p, 1.0)).xy;
    vec2 d = (q - lens_dngC) / lens_dngM;
    float r2 = dot(d, d);
    vec4 k = lens_kr[ch];
    vec2 t = lens_kt[ch];
    float f = k.x + r2 * (k.y + r2 * (k.z + r2 * k.w));
    vec2 tg = vec2(t.x * 2.0 * d.x * d.y + t.y * (r2 + 2.0 * d.x * d.x), t.y * 2.0 * d.x * d.y + t.x * (r2 + 2.0 * d.y * d.y));
    p = (lens_rawToS * vec3(lens_dngC + lens_dngM * (f * d + tg), 1.0)).xy;
  } else if (lens_mode == 2) {
    vec2 d = (p - lens_lfC) / lens_lfN;
    float r = length(d);
    float f = lens_lfDist[0] + r * (lens_lfDist[1] + r * (lens_lfDist[2] + r * (lens_lfDist[3] + r * lens_lfDist[4])));
    if (ch != 1) {
      vec3 t = lens_lfTca[ch == 0 ? 0 : 1];
      float rd = r * f;
      f *= t.x + rd * (t.y + rd * t.z);
    }
    p = lens_lfC + d * f * lens_lfN;
  }
  if (ch == 0) p = lens_c + (p - lens_c) * lens_ca.x;
  else if (ch == 2) p = lens_c + (p - lens_c) * lens_ca.y;
  return p;
}

vec3 lens_fetchU(vec2 p) {
  if (lens_on == 0) return input_texel(p);
  vec2 g = lens_toS(p, 1);
  if (lens_perChannel == 0) return input_texel(g);
  return vec3(input_texel(lens_toS(p, 0)).r, input_texel(g).g, input_texel(lens_toS(p, 2)).b);
}

bool lens_inside(vec2 p) {
  vec2 s = lens_toS(p, 1);
  return s.x > -0.5 && s.y > -0.5 && s.x < u_srcSize.x + 0.5 && s.y < u_srcSize.y + 0.5;
}

vec3 lens_defringe(vec2 p, vec3 c) {
  // Edge strength: luminance range over a ring of 8 samples (gamma domain).
  float yc = pow(max(luma(c), 0.0), 1.0 / 2.2), lo = yc, hi = yc;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * (PI / 4.0);
    float y = pow(max(luma(input_fetch(p + lens_fringeR * vec2(cos(a), sin(a)))), 0.0), 1.0 / 2.2);
    lo = min(lo, y); hi = max(hi, y);
  }
  float edge = smoothstep(0.06, 0.22, hi - lo);
  if (edge <= 0.0) return c;
  vec3 lch = toOklch(c);
  float h = degrees(lch.z);
  float wp = lens_purple.x * smoothstep(lens_purple.y - 12.0, lens_purple.y, h) * (1.0 - smoothstep(lens_purple.z, lens_purple.z + 12.0, h));
  float wg = lens_green.x * smoothstep(lens_green.y - 10.0, lens_green.y, h) * (1.0 - smoothstep(lens_green.z, lens_green.z + 10.0, h));
  float w = clamp(max(wp, wg) * edge * smoothstep(0.015, 0.05, lch.y), 0.0, 1.0);
  lch.y *= 1.0 - w;
  return fromOklch(lch);
}

vec3 lens_finish(vec2 p, vec3 c) {
  if (lens_on == 0) return c;
  if (lens_purple.x > 0.0 || lens_green.x > 0.0) c = lens_defringe(p, c);
  vec2 s = lens_toS(p, 1);
  vec3 gain = vec3(1.0);
  if (lens_vigMan.x != 0.0) {
    float r = length(s - lens_c) / lens_n;
    gain *= exp2(lens_vigMan.x * smoothstep(lens_vigMan.y, 1.0, r));
  }
  if (lens_vigDng[0] != 0.0 || lens_vigDng[1] != 0.0 || lens_vigDng[2] != 0.0) {
    vec2 q = (lens_sToRaw * vec3(s, 1.0)).xy;
    float r2 = dot(q - lens_vigDngC, q - lens_vigDngC) / (lens_vigDngM * lens_vigDngM);
    gain *= 1.0 + r2 * (lens_vigDng[0] + r2 * (lens_vigDng[1] + r2 * (lens_vigDng[2] + r2 * (lens_vigDng[3] + r2 * lens_vigDng[4]))));
  }
  if (lens_vigLf != vec3(0.0)) {
    float r2 = dot(s - lens_c, s - lens_c) / (lens_n * lens_n);
    gain /= max(1.0 + r2 * (lens_vigLf.x + r2 * (lens_vigLf.y + r2 * lens_vigLf.z)), 0.05);
  }
  if (lens_hasGain == 1) gain *= texture(lens_gainTex, (lens_gainM * vec3(s, 1.0)).xy).rgb;
  return c * gain;
}
`;

export const lensStage: Stage = {
  id: 'lens',
  label: 'Lens correction & geometry',
  kind: 'warp',
  glsl,
  active: (ctx) => !ctx.geo.identity || ctx.lens.active,
  uniforms(ctx) {
    const m = ctx.lens, g = ctx.geo;
    const perChannel = m.ca[0] !== 1 || m.ca[1] !== 1 || (m.mode === 1 && (m.kr.some((v, i) => v !== m.kr[4 + (i % 4)]) || m.kt.some((v, i) => v !== m.kt[2 + (i % 2)]))) ||
      (m.mode === 2 && (m.lfTca[0] !== 1 || m.lfTca[1] !== 0 || m.lfTca[2] !== 0 || m.lfTca[3] !== 1 || m.lfTca[4] !== 0 || m.lfTca[5] !== 0));
    return {
      lens_oToU: u.m3(g.oToU),
      lens_geo: u.i(!g.identity),
      lens_on: u.i(m.active),
      lens_perChannel: u.i(perChannel),
      lens_c: u.v2(...m.center),
      lens_n: u.f(m.norm),
      lens_k: u.f(m.manualK),
      lens_mode: u.i(m.mode),
      lens_sToRaw: u.m3(m.sToRaw),
      lens_rawToS: u.m3(m.rawToS),
      lens_dngC: u.v2(...m.dngC),
      lens_dngM: u.f(m.dngM),
      lens_kr: { t: 'v4a', v: m.kr },
      lens_kt: { t: 'v2a', v: m.kt },
      lens_lfC: u.v2(...m.lfC),
      lens_lfN: u.f(m.lfN),
      lens_lfDist: { t: 'fa', v: m.lfDist },
      lens_lfTca: { t: 'v3a', v: m.lfTca },
      lens_ca: u.v2(...m.ca),
      lens_vigMan: u.v2(...m.vigManual),
      lens_vigDng: { t: 'fa', v: m.vigDng },
      lens_vigDngC: u.v2(...m.vigDngC),
      lens_vigDngM: u.f(m.vigDngM),
      lens_vigLf: u.v3(m.vigLf),
      lens_hasGain: u.i(!!m.gainMap),
      lens_gainM: u.m3(m.gainM),
      lens_purple: u.v3(m.purple),
      lens_green: u.v3(m.green),
      lens_fringeR: u.f(m.fringeRadius),
    };
  },
  textures: (ctx, res): StageTextures => ({
    lens_gainTex: ctx.lens.gainMap ? res.gainMap(ctx.lens.gainMap) : res.dummy,
  }),
};
