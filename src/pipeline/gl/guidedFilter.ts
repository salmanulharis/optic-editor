/**
 * Guided filter (He, Sun & Tang) as GPU helper passes, used for edge-aware base layers (clarity,
 * texture) and for refining the dehaze transmission.
 *
 *   stats  = (I, I², p, I·p), or (I, I²) when self-guided (p = I)   written by the caller (32F)
 *   means  = box(stats, r)                                          32F (variance needs it)
 *   a      = cov(I, p) / (var(I) + ε),  b = mean(p) − a·mean(I)
 *   coef   = box((a, b), r)                                         16F, sampled bilinearly
 *   q(x)   = coef.a(x) · I(x) + coef.b(x)
 *
 * The coefficients are smooth, so they can be computed at a lower resolution and applied to the
 * full-resolution guide ("fast guided filter"): that is how clarity and dehaze maps built from the
 * proxy produce edge-aware results at full resolution, identical in preview and export.
 * Self-guided filters use two-channel (RG) targets: half the memory traffic.
 */
import type { RenderTargetTex } from './texture';
import type { GpuKit, TexIn } from './gpuKit';

export const GF_COEF_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_m;
uniform float u_eps;
uniform int u_self;
out vec4 o;
void main() {
  vec4 m = texelFetch(u_m, ivec2(gl_FragCoord.xy), 0);
  float varI = max(m.y - m.x * m.x, 0.0);
  float cov = u_self == 1 ? varI : m.w - m.x * m.z;
  float a = cov / (varI + u_eps);
  o = vec4(a, (u_self == 1 ? m.x : m.z) - a * m.x, 0.0, 1.0);
}`;

/**
 * Box-mean the stats, solve for (a, b), box-mean those: returns the (a, b) texture (16F).
 * `self`: stats are (I, I²) in an RG32F target.
 */
export function guidedCoefficients(kit: GpuKit, stats: TexIn, radius: number, eps: number, tag: string, self = false): RenderTargetTex {
  const f32 = self ? 'rg32f' : 'rgba32f';
  const means = kit.box(stats, radius, `${tag}:m`, f32);
  const ab = kit.rt(`${tag}:ab`, stats.width, stats.height, 'rg32f');
  kit.draw(GF_COEF_FS, ab, { u_eps: { t: 'f', v: eps }, u_self: { t: 'i', v: self ? 1 : 0 } }, { u_m: means.tex });
  return kit.box(ab, radius, `${tag}:coef`, 'rg32f', 'rg16f');
}
