/**
 * Stage 75 — the look layer: the "character" parameters presets are built from.
 *
 *  - Micro-contrast: local contrast at a small radius. The Pipeline renders the image (everything
 *    up to and including stage 70) into a map with a 512 px long edge from the preview proxy, takes
 *    log2 luminance and blurs it with a separable Gaussian (σ = 3 map px ≈ 0.6 % of the long edge).
 *    Here the pixel's own log-luminance minus the blurred value is the local detail, which is
 *    amplified (midtones only). The map is defined relative to the image, not the screen, and
 *    export builds it from the same proxy, so preview and full-resolution export match.
 *  - Highlight roll-off: a gentler approach to white above a knee, f(t) = t + a·t²(1−t):
 *    slope 1 at the knee (no kink), slope 1−a at white, monotone for a ≤ 1.
 *  - Shadow density: deepens the lower tones (gamma-2.2 domain) while keeping black at 0 and the
 *    toe slope positive, so nothing is crushed.
 *  - Colour density: lowers OKLab lightness as chroma rises (film dye density: rich, not neon).
 *  - Warmth bias: a small OKLab shift toward warm/cool that fades out near white and black.
 */
import type { Stage, StageTextures } from '../types';
import { u } from '../types';

const LOOK_MAP_EDGE = 512;
const LOOK_MAP_SIGMA = 3; // map pixels (≈ 0.6 % of the long edge, image-relative)

/** Separable blur; pass 1 converts to log2 luminance while blurring horizontally. */
const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform int u_log;
out vec4 o;
float val(ivec2 p) {
  ivec2 s = textureSize(u_src, 0);
  vec4 c = texelFetch(u_src, clamp(p, ivec2(0), s - 1), 0);
  return u_log == 1 ? log2(max(dot(c.rgb, vec3(0.2627, 0.6780, 0.0593)), 1e-6)) : c.r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 d = ivec2(u_dir);
  float acc = 0.0, wsum = 0.0;
  for (int i = -9; i <= 9; i++) {
    float w = exp(-float(i * i) / (2.0 * ${LOOK_MAP_SIGMA.toFixed(1)} * ${LOOK_MAP_SIGMA.toFixed(1)}));
    acc += val(p + d * i) * w;
    wsum += w;
  }
  o = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;

const glsl = /* glsl */ `
uniform sampler2D look_map;
uniform float look_micro;
uniform float look_roll;
uniform float look_density;
uniform float look_colorDensity;
uniform vec2 look_warm;

vec4 look_apply(vec4 c) {
  vec3 x = c.rgb;
  if (look_micro > 0.0) {
    float Y = max(luma(x), 1e-6);
    float lb = texture(look_map, g_px / u_fullSize).r;
    float d = clamp(log2(Y) - lb, -2.5, 2.5);
    float mid = smoothstep(0.002, 0.03, Y) * (1.0 - smoothstep(0.55, 1.0, Y));
    x *= exp2(d * look_micro * mid);
  }
  float n = max3(x);
  if (n > 1e-6 && (look_roll > 0.0 || look_density > 0.0)) {
    float e = pow(n, 1.0 / 2.2);
    float k = look_density * (1.0 - smoothstep(0.08, 0.6, e)) * smoothstep(0.0, 0.08, e);
    float e2 = e * (1.0 - 0.32 * k);
    const float knee = 0.55;
    if (e2 > knee && e2 < 1.0) {
      float t = (e2 - knee) / (1.0 - knee);
      e2 = knee + (1.0 - knee) * (t + look_roll * t * t * (1.0 - t));
    }
    x *= pow(e2, 2.2) / n;
  }
  if (look_colorDensity > 0.0 || look_warm != vec2(0.0)) {
    vec3 lab = toOklab(x);
    float C = length(lab.yz);
    float dens = look_colorDensity * smoothstep(0.03, 0.22, C);
    lab.x *= 1.0 - 0.22 * dens;
    lab.yz *= 1.0 - 0.08 * dens * smoothstep(0.12, 0.3, C);
    float L = clamp(lab.x, 0.0, 1.0);
    lab.yz += look_warm * smoothstep(0.02, 0.18, L) * (1.0 - smoothstep(0.82, 0.98, L));
    x = fromOklab(lab);
  }
  return vec4(x, c.a);
}
`;

export const lookStage: Stage = {
  id: 'look',
  label: 'Look',
  kind: 'point',
  glsl,
  active: (ctx) => {
    const k = ctx.recipe.look;
    return !!(k.highlightRolloff || k.shadowDensity || k.microContrast || k.colorDensity || k.warmthBias);
  },
  uniforms(ctx) {
    const k = ctx.recipe.look;
    const wh = (75 * Math.PI) / 180; // warm direction ≈ OKLCH hue 75° (amber)
    const w = (k.warmthBias / 100) * 0.018;
    return {
      look_micro: u.f((k.microContrast / 100) * 0.55),
      look_roll: u.f(k.highlightRolloff / 100),
      look_density: u.f(k.shadowDensity / 100),
      look_colorDensity: u.f(k.colorDensity / 100),
      look_warm: u.v2(w * Math.cos(wh), w * Math.sin(wh)),
    };
  },
  maps: (ctx) =>
    ctx.recipe.look.microContrast > 0
      ? [{
          id: 'look',
          until: 'lut',
          edge: LOOK_MAP_EDGE,
          key: '',
          helpers: [BLUR_FS],
          build(kit, src) {
            const b = kit.rt('b', src.width, src.height);
            const out = kit.rt('map', src.width, src.height);
            kit.draw(BLUR_FS, b, { u_dir: u.v2(1, 0), u_log: u.i(1) }, { u_src: src.tex });
            kit.draw(BLUR_FS, out, { u_dir: u.v2(0, 1), u_log: u.i(0) }, { u_src: b.tex });
            return { look_map: out.tex };
          },
        }]
      : [],
  textures: (ctx, res): StageTextures => ({
    look_map: (ctx.recipe.look.microContrast ? res.map('look')?.look_map : null) ?? res.dummy,
  }),
};
