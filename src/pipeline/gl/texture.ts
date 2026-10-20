/** Float textures and framebuffers. */

// Texture identity + content version, for cache keys: a cache keyed on a texture must notice when
// the same texture object is re-filled (curve LUTs, image-wide maps).
const texIds = new WeakMap<WebGLTexture, { id: number; v: number }>();
let nextTexId = 1;
export function texKey(t: WebGLTexture): string {
  let e = texIds.get(t);
  if (!e) { e = { id: nextTexId++, v: 0 }; texIds.set(t, e); }
  return `${e.id}.${e.v}`;
}
/** Mark a texture's content as changed. */
export function bumpTex(t: WebGLTexture) {
  const e = texIds.get(t);
  if (e) e.v++;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A texture holding (part of) the source image, in full-resolution pixel coordinates. */
export interface SourceTexture {
  tex: WebGLTexture;
  /** Area of the full-resolution image this texture covers. */
  region: Region;
  /** Texture pixels per full-resolution pixel (1 for detail/export tiles, < 1 for the proxy). */
  scale: number;
  mipmapped: boolean;
  /** Texture can be sampled with LINEAR filtering. */
  linear: boolean;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  opts: { linear?: boolean; levels?: number } = {},
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, opts.levels ?? 1, internalFormat, width, height);
  const lin = opts.linear ?? true;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, (opts.levels ?? 1) > 1 ? gl.LINEAR_MIPMAP_LINEAR : lin ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Upload a rectangle of an interleaved RGB Float32 image (row length = srcWidth) into `tex`
 * at (0, 0), using UNPACK_ROW_LENGTH/SKIP so no CPU-side copy is made.
 * `rowsPerChunk` splits the upload; `yieldFn` is awaited between chunks to keep frames flowing.
 */
export async function uploadRGB(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  data: Float32Array,
  srcWidth: number,
  region: Region,
  rowsPerChunk = Infinity,
  yieldFn?: () => Promise<void>,
) {
  for (let y = 0; y < region.h; y += rowsPerChunk) {
    const rows = Math.min(rowsPerChunk, region.h - y);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, srcWidth);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, region.x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, region.y + y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, region.w, rows, gl.RGB, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    if (yieldFn && y + rows < region.h) await yieldFn();
  }
}

export interface RenderTargetTex {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

/**
 * `linear` = sample with LINEAR filtering. RGBA32F is only filterable with
 * OES_texture_float_linear; a 32F target read with texelFetch only should pass false.
 */
export function createRenderTarget(gl: WebGL2RenderingContext, width: number, height: number, internalFormat: number, levels = 1, linear = true): RenderTargetTex {
  const tex = createTexture(gl, width, height, internalFormat, { linear, levels });
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete (0x${status.toString(16)})`);
  return { tex, fbo, width, height };
}

export function deleteRenderTarget(gl: WebGL2RenderingContext, t: RenderTargetTex | null) {
  if (!t) return;
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 o;
void main() { o = vec4(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`;

/**
 * Build a mipmapped RGBA16F texture from an RGB float image. RGB16F is neither renderable nor
 * mipmappable, so we upload RGB into a staging texture (in chunks), copy it on the GPU into an
 * RGBA16F render target, then generate mipmaps there.
 */
export async function createMipmappedFromRGB(
  gl: WebGL2RenderingContext,
  programs: { get(src: string): { program: WebGLProgram; loc(n: string): WebGLUniformLocation | null } },
  vao: WebGLVertexArrayObject,
  data: Float32Array,
  width: number,
  height: number,
  yieldFn?: () => Promise<void>,
): Promise<WebGLTexture> {
  const staging = createTexture(gl, width, height, gl.RGB32F, { linear: false });
  // Small chunks: ANGLE converts RGB float uploads on the CPU, so big chunks become long tasks.
  await uploadRGB(gl, staging, data, width, { x: 0, y: 0, w: width, h: height }, 128, yieldFn);
  await yieldFn?.();
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const target = createRenderTarget(gl, width, height, gl.RGBA16F, levels);
  const p = programs.get(COPY_FS);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, width, height);
  gl.useProgram(p.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, staging);
  gl.uniform1i(p.loc('u_src'), 0);
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(staging);
  gl.bindTexture(gl.TEXTURE_2D, target.tex);
  gl.generateMipmap(gl.TEXTURE_2D);
  return target.tex;
}
