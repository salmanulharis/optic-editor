/**
 * Stage 70 — 3D LUT with an amount blend.
 * Working linear Rec.2020 is converted into the LUT's declared input space (primaries + transfer),
 * looked up with tetrahedral interpolation (4 texel fetches, no 3D-texture filtering needed),
 * converted back, then blended with the un-LUTed pixel by Amount (0–200 %; above 100 % the change
 * is extrapolated and the output stage's gamut compression keeps it in range).
 *
 * Input spaces: sRGB/Rec.709 gamma, Display P3 gamma, linear Rec.709, ARRI LogC3 (EI 800,
 * ALEXA Wide Gamut), Apple Log (Rec.2020). LUTs are output-referred in the same space.
 */
import { type Mat3, D65_XY, WORKING_TO_XYZ, inv, mul, rgbToXYZ, toXYZ_D65 } from '../../color/matrices';
import type { LutInputSpace } from '../../recipe/schema';
import { lutRegistry } from '../lutRegistry';
import type { Stage, StageTextures } from '../types';
import { u } from '../types';

const glsl = /* glsl */ `
uniform highp sampler3D lut_tex;
uniform float lut_size;
uniform vec3 lut_dmin;
uniform vec3 lut_dmax;
uniform mat3 lut_toIn;
uniform mat3 lut_fromIn;
uniform int lut_tf;     // 0 linear, 1 sRGB, 2 LogC3, 3 Apple Log
uniform float lut_amount;

float lut_encode1(float x) {
  if (lut_tf == 1) { x = max(x, 0.0); return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
  if (lut_tf == 2) return x > 0.010591 ? 0.247190 * log(5.555556 * x + 0.052272) / log(10.0) + 0.385537 : 5.367655 * x + 0.092809;
  if (lut_tf == 3) {
    if (x >= 0.01) return 0.08550479 * log2(x + 0.00964052) + 0.69336945;
    if (x >= -0.05641088) return 47.28711236 * (x + 0.05641088) * (x + 0.05641088);
    return 0.0;
  }
  return x;
}
float lut_decode1(float y) {
  if (lut_tf == 1) { y = max(y, 0.0); return y <= 0.04045 ? y / 12.92 : pow((y + 0.055) / 1.055, 2.4); }
  if (lut_tf == 2) return y > 0.149658 ? (pow(10.0, (y - 0.385537) / 0.247190) - 0.052272) / 5.555556 : (y - 0.092809) / 5.367655;
  if (lut_tf == 3) {
    if (y >= 0.2085556) return exp2((y - 0.69336945) / 0.08550479) - 0.00964052;
    return sqrt(max(y, 0.0) / 47.28711236) - 0.05641088;
  }
  return y;
}
vec3 lut_encode(vec3 v) { return vec3(lut_encode1(v.r), lut_encode1(v.g), lut_encode1(v.b)); }
vec3 lut_decode(vec3 v) { return vec3(lut_decode1(v.r), lut_decode1(v.g), lut_decode1(v.b)); }

vec3 lut_fetch(ivec3 p) { return texelFetch(lut_tex, p, 0).rgb; }

// Tetrahedral interpolation (the cube is split into 6 tetrahedra along its main diagonal).
vec3 lut_tetra(vec3 x) {
  float n1 = lut_size - 1.0;
  vec3 p = clamp(x, 0.0, 1.0) * n1;
  vec3 b = min(floor(p), vec3(n1 - 1.0));
  vec3 f = p - b;
  ivec3 i = ivec3(b);
  vec3 c000 = lut_fetch(i), c111 = lut_fetch(i + ivec3(1));
  vec3 c;
  if (f.r > f.g) {
    if (f.g > f.b) { vec3 c100 = lut_fetch(i + ivec3(1,0,0)), c110 = lut_fetch(i + ivec3(1,1,0));
      c = c000 + f.r * (c100 - c000) + f.g * (c110 - c100) + f.b * (c111 - c110); }
    else if (f.r > f.b) { vec3 c100 = lut_fetch(i + ivec3(1,0,0)), c101 = lut_fetch(i + ivec3(1,0,1));
      c = c000 + f.r * (c100 - c000) + f.b * (c101 - c100) + f.g * (c111 - c101); }
    else { vec3 c001 = lut_fetch(i + ivec3(0,0,1)), c101 = lut_fetch(i + ivec3(1,0,1));
      c = c000 + f.b * (c001 - c000) + f.r * (c101 - c001) + f.g * (c111 - c101); }
  } else {
    if (f.b > f.g) { vec3 c001 = lut_fetch(i + ivec3(0,0,1)), c011 = lut_fetch(i + ivec3(0,1,1));
      c = c000 + f.b * (c001 - c000) + f.g * (c011 - c001) + f.r * (c111 - c011); }
    else if (f.b > f.r) { vec3 c010 = lut_fetch(i + ivec3(0,1,0)), c011 = lut_fetch(i + ivec3(0,1,1));
      c = c000 + f.g * (c010 - c000) + f.b * (c011 - c010) + f.r * (c111 - c011); }
    else { vec3 c010 = lut_fetch(i + ivec3(0,1,0)), c110 = lut_fetch(i + ivec3(1,1,0));
      c = c000 + f.g * (c010 - c000) + f.r * (c110 - c010) + f.b * (c111 - c110); }
  }
  return c;
}

vec4 lut_apply(vec4 c) {
  vec3 e = lut_encode(lut_toIn * c.rgb);
  vec3 xn = (e - lut_dmin) / (lut_dmax - lut_dmin);
  vec3 o = lut_tetra(xn) + max(xn - 1.0, 0.0) * (lut_dmax - lut_dmin); // carry over-range values through
  vec3 lin = lut_fromIn * lut_decode(o);
  return vec4(mix(c.rgb, lin, lut_amount), c.a);
}
`;

const AWG: [[number, number], [number, number], [number, number]] = [[0.684, 0.313], [0.221, 0.848], [0.0861, -0.102]];

function spaceToXYZ(s: LutInputSpace): Mat3 {
  switch (s) {
    case 'p3': return toXYZ_D65('display-p3');
    case 'logc3': return rgbToXYZ(AWG, D65_XY);
    case 'applelog': return toXYZ_D65('rec2020');
    default: return toXYZ_D65('srgb');
  }
}

const TF: Record<LutInputSpace, number> = { linear: 0, srgb: 1, p3: 1, logc3: 2, applelog: 3 };

export const lutStage: Stage = {
  id: 'lut',
  label: 'LUT',
  kind: 'point',
  glsl,
  active: (ctx) => ctx.recipe.lut.amount > 0 && lutRegistry.has(ctx.recipe.lut.id),
  uniforms(ctx) {
    const l = lutRegistry.get(ctx.recipe.lut.id)!;
    const toIn = mul(inv(spaceToXYZ(ctx.recipe.lut.inputSpace)), WORKING_TO_XYZ);
    return {
      lut_size: u.f(l.size),
      lut_dmin: u.v3(l.domainMin),
      lut_dmax: u.v3(l.domainMax),
      lut_toIn: u.m3(toIn),
      lut_fromIn: u.m3(inv(toIn)),
      lut_tf: u.i(TF[ctx.recipe.lut.inputSpace]),
      lut_amount: u.f(ctx.recipe.lut.amount / 100),
    };
  },
  textures: (ctx, res): StageTextures => {
    const t = res.luts.get(ctx.recipe.lut.id!);
    return t ? { lut_tex: { tex: t, is3d: true as const } } : {};
  },
};
