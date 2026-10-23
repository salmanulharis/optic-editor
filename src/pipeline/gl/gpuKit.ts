/**
 * Helper passes for spatial stages and image-wide maps: pooled render targets, a draw call that
 * binds every sampler a helper declares (texture-unit hygiene), and the common separable filters.
 *
 * Targets are pooled by tag and re-created only when their size or format changes, so a stage
 * that asks for `nr:lum0` every frame gets the same texture back. Image-wide maps use a scoped kit
 * (tag prefix per map and cache slot) so their results survive other renders.
 */
import { type Uniform } from '../types';
import { declaredSamplers, setUniform, type ProgramCache } from './program';
import { type RenderTargetTex, bumpTex, createRenderTarget, deleteRenderTarget } from './texture';

export type Fmt = 'rgba16f' | 'rgba32f' | 'rg16f' | 'rg32f';
export interface TexIn {
  tex: WebGLTexture;
  width: number;
  height: number;
}

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
`;

/** Separable Gaussian (one direction); radius ≈ 3σ, edge-clamped. */
export const GAUSS_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_radius;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), s = textureSize(u_src, 0) - 1, d = ivec2(u_dir);
  vec4 acc = vec4(0.0);
  float ws = 0.0, k = -0.5 / (u_sigma * u_sigma);
  for (int i = -u_radius; i <= u_radius; i++) {
    float w = exp(float(i * i) * k);
    acc += texelFetch(u_src, clamp(p + d * i, ivec2(0), s), 0) * w;
    ws += w;
  }
  o = acc / ws;
}`;

/** Separable box mean (one direction), edge-clamped. */
export const BOX_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform int u_radius;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), s = textureSize(u_src, 0) - 1, d = ivec2(u_dir);
  vec4 acc = vec4(0.0);
  for (int i = -u_radius; i <= u_radius; i++) acc += texelFetch(u_src, clamp(p + d * i, ivec2(0), s), 0);
  o = acc / float(2 * u_radius + 1);
}`;

/** Box downsample by an integer factor (each output texel = mean of its f × f block). */
export const DOWN_FS = /* glsl */ `${HEAD}
uniform sampler2D u_src;
uniform int u_factor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * u_factor, s = textureSize(u_src, 0) - 1;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < u_factor; j++) for (int i = 0; i < u_factor; i++) acc += texelFetch(u_src, min(p + ivec2(i, j), s), 0);
  o = acc / float(u_factor * u_factor);
}`;

export const KIT_HELPERS = [GAUSS_FS, BOX_FS, DOWN_FS];

const FORMATS: Record<Fmt, number> = { rgba16f: 0x881a, rgba32f: 0x8814, rg16f: 0x822f, rg32f: 0x8230 };
const isHalf = (f: Fmt) => f === 'rgba16f' || f === 'rg16f';

/** Pooled targets unused for this many top-level renders are freed. */
const MAX_AGE = 240;

export class GpuKit {
  private pool = new Map<string, RenderTargetTex & { fmt: Fmt; used: number }>();
  /** Recycled targets (size|format → list), handed out again before allocating new ones. */
  private free = new Map<string, Array<RenderTargetTex & { fmt: Fmt; used: number }>>();
  private samplers = new Map<string, Array<{ name: string; is3d: boolean }>>();
  private tick = 0;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly programs: ProgramCache,
    readonly vao: WebGLVertexArrayObject,
    private dummy: () => WebGLTexture,
    readonly floatLinear: boolean,
    private prefix = '',
    private root?: GpuKit,
  ) {}

  /** A kit whose targets are namespaced (and kept apart from everyone else's). */
  scoped(prefix: string): GpuKit {
    const root = this.root ?? this;
    return new GpuKit(this.gl, this.programs, this.vao, this.dummy, this.floatLinear, this.prefix + prefix, root);
  }

  /**
   * A pooled render target, keyed by tag, size and format (renders of different sizes — viewer,
   * map renders, readouts — each keep their own instead of re-allocating every frame).
   * 32F targets are sampled with texelFetch unless float filtering exists.
   */
  rt(tag: string, width: number, height: number, fmt: Fmt = 'rgba16f'): RenderTargetTex {
    const root = this.root ?? this;
    const key = `${this.prefix}${tag}|${width}x${height}|${fmt}`;
    const cur = root.pool.get(key);
    if (cur) { cur.used = root.tick; return cur; }
    const want = `${width}x${height}|${fmt}`;
    const spare = root.free.get(want)?.pop();
    if (spare) { spare.used = root.tick; root.pool.set(key, spare); return spare; }
    // Recycled targets of other sizes / formats are leftovers of finished passes: free them before
    // allocating, so a render's peak memory stays close to its largest pass.
    for (const [fk, list] of root.free) {
      if (fk === want) continue;
      list.forEach((t) => deleteRenderTarget(this.gl, t));
      root.free.delete(fk);
    }
    this.gl.activeTexture(this.gl.TEXTURE0 + 15);
    const t = { ...createRenderTarget(this.gl, width, height, FORMATS[fmt], 1, isHalf(fmt) || this.floatLinear), fmt, used: root.tick };
    root.pool.set(key, t);
    return t;
  }

  /**
   * Call once per top-level render: frees targets no render has used for a while. Targets of
   * image-wide maps and cache slots are owned by their cache and freed with it (`release`).
   */
  sweep() {
    const root = this.root ?? this;
    root.tick++;
    for (const [k, t] of root.pool) {
      if (k.startsWith('map:') || k.startsWith('slot:')) continue;
      if (root.tick - t.used > MAX_AGE) { deleteRenderTarget(this.gl, t); root.pool.delete(k); }
    }
    for (const [fk, list] of root.free) {
      const keep = list.filter((t) => root.tick - t.used <= MAX_AGE);
      list.filter((t) => root.tick - t.used > MAX_AGE).forEach((t) => deleteRenderTarget(this.gl, t));
      if (keep.length) root.free.set(fk, keep); else root.free.delete(fk);
    }
  }

  /**
   * Make the unscoped targets (spatial helpers of an uncached render) available to later passes of
   * any size-and-format-compatible tag. Called after each pass: its helper results are consumed, so
   * a render's peak memory is its largest pass, not the sum of every stage's helpers. Targets of
   * image-wide maps and cache slots are kept.
   */
  recycle() {
    const root = this.root ?? this;
    for (const [k, t] of root.pool) {
      if (k.startsWith('map:') || k.startsWith('slot:')) continue;
      root.pool.delete(k);
      const fk = `${t.width}x${t.height}|${t.fmt}`;
      const list = root.free.get(fk) ?? [];
      list.push(t);
      root.free.set(fk, list);
    }
  }

  /** Delete this scope's targets that the current render did not use (e.g. a map's old size). */
  releaseStale() {
    const root = this.root ?? this;
    for (const [k, t] of root.pool) if (k.startsWith(this.prefix) && t.used < root.tick) { deleteRenderTarget(this.gl, t); root.pool.delete(k); }
  }

  /** Delete every pooled target whose tag starts with `prefix` (relative to this kit's scope). */
  release(prefix = '') {
    const pool = (this.root ?? this).pool;
    for (const [k, t] of pool) if (k.startsWith(this.prefix + prefix)) { deleteRenderTarget(this.gl, t); pool.delete(k); }
  }

  /** Full-screen draw of a helper shader into `out`. Undeclared samplers get the dummy texture. */
  draw(fs: string, out: RenderTargetTex, uniforms: Record<string, Uniform>, textures: Record<string, WebGLTexture>) {
    const gl = this.gl;
    const prog = this.programs.get(fs);
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.width, out.height);
    let decl = this.samplers.get(fs);
    if (!decl) { decl = declaredSamplers(fs); this.samplers.set(fs, decl); }
    decl.forEach((s, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const t = textures[s.name] ?? this.dummy();
      if (t === out.tex) throw new Error(`Helper pass reads its own target (${s.name})`);
      gl.bindTexture(s.is3d ? gl.TEXTURE_3D : gl.TEXTURE_2D, t);
      gl.uniform1i(prog.loc(s.name), unit);
    });
    for (const [name, v] of Object.entries(uniforms)) setUniform(gl, prog.loc(name), v);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    bumpTex(out.tex);
  }

  /**
   * Full-screen draw into several targets at once (multiple render targets): the shader writes
   * `layout(location = k) out vec4` for output k. All targets must have the same size.
   */
  drawMRT(fs: string, outs: RenderTargetTex[], uniforms: Record<string, Uniform>, textures: Record<string, WebGLTexture>) {
    const gl = this.gl;
    // A framebuffer per draw, deleted right after: a cached one would keep its attachments alive
    // after the pool frees them (GPU memory leak across render sizes).
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    outs.forEach((o, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, o.tex, 0));
    const prog = this.programs.get(fs);
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.drawBuffers(outs.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
    gl.viewport(0, 0, outs[0].width, outs[0].height);
    let decl = this.samplers.get(fs);
    if (!decl) { decl = declaredSamplers(fs); this.samplers.set(fs, decl); }
    decl.forEach((sm, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const t = textures[sm.name] ?? this.dummy();
      if (outs.some((o) => o.tex === t)) throw new Error(`MRT pass reads its own target (${sm.name})`);
      gl.bindTexture(sm.is3d ? gl.TEXTURE_3D : gl.TEXTURE_2D, t);
      gl.uniform1i(prog.loc(sm.name), unit);
    });
    for (const [name, v] of Object.entries(uniforms)) setUniform(gl, prog.loc(name), v);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    outs.forEach((o) => bumpTex(o.tex));
  }

  /** Separable Gaussian blur of all four channels (`outFmt` for the result, `fmt` in between). */
  gauss(src: TexIn, sigma: number, tag: string, fmt: Fmt = 'rgba16f', outFmt: Fmt = fmt): RenderTargetTex {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    // The horizontal intermediate only lives during this call: one shared scratch per size/format.
    const h = this.rt('~h', src.width, src.height, fmt);
    const v = this.rt(tag, src.width, src.height, outFmt);
    const un = (dx: number, dy: number) => ({ u_dir: { t: 'v2', v: [dx, dy] }, u_sigma: { t: 'f', v: Math.max(sigma, 0.1) }, u_radius: { t: 'i', v: radius } }) as Record<string, Uniform>;
    this.draw(GAUSS_FS, h, un(1, 0), { u_src: src.tex });
    this.draw(GAUSS_FS, v, un(0, 1), { u_src: h.tex });
    return v;
  }

  /** Separable box mean with a (2r + 1)² window. */
  box(src: TexIn, radius: number, tag: string, fmt: Fmt = 'rgba16f', outFmt: Fmt = fmt): RenderTargetTex {
    const r = Math.max(1, Math.round(radius));
    const h = this.rt('~h', src.width, src.height, fmt);
    const v = this.rt(tag, src.width, src.height, outFmt);
    this.draw(BOX_FS, h, { u_dir: { t: 'v2', v: [1, 0] }, u_radius: { t: 'i', v: r } }, { u_src: src.tex });
    this.draw(BOX_FS, v, { u_dir: { t: 'v2', v: [0, 1] }, u_radius: { t: 'i', v: r } }, { u_src: h.tex });
    return v;
  }

  /** Integer-factor box downsample (output size rounded up). */
  down(src: TexIn, factor: number, tag: string, fmt: Fmt = 'rgba16f'): RenderTargetTex {
    const f = Math.max(1, Math.round(factor));
    const out = this.rt(tag, Math.ceil(src.width / f), Math.ceil(src.height / f), fmt);
    this.draw(DOWN_FS, out, { u_factor: { t: 'i', v: f } }, { u_src: src.tex });
    return out;
  }

  dispose() {
    for (const t of this.pool.values()) deleteRenderTarget(this.gl, t);
    this.pool.clear();
    for (const list of this.free.values()) list.forEach((t) => deleteRenderTarget(this.gl, t));
    this.free.clear();
  }
}
