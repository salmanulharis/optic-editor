import { WORKING_LUMA } from '../color/matrices';
import { OKLAB_GLSL } from '../color/oklab';

/** GLSL shared by all stages (prepended once per generated program). */
export const COMMON_GLSL = /* glsl */ `
const vec3 LUMA = vec3(${WORKING_LUMA.map((x) => x.toFixed(8)).join(', ')});
const float PI = 3.14159265359;
const float TAU = 6.28318530718;
float max3(vec3 v) { return max(v.r, max(v.g, v.b)); }
float min3(vec3 v) { return min(v.r, min(v.g, v.b)); }
float luma(vec3 c) { return dot(c, LUMA); }
// Stable per-position hash in [0, 1)
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Skin-tone weight in OKLCH: hues ≈ 20°–70°, moderate chroma.
float skinMask(float h, float C) {
  float hd = degrees(h);
  float hw = smoothstep(12.0, 25.0, hd) * (1.0 - smoothstep(65.0, 80.0, hd));
  float cw = smoothstep(0.015, 0.04, C) * (1.0 - smoothstep(0.16, 0.24, C));
  return hw * cw;
}
${OKLAB_GLSL}
`;
