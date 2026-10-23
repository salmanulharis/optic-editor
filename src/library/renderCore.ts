/**
 * Small whole-image renders of a photo that is not open in the editor: cached library previews
 * (2560 px + 512 px), and linear readbacks for batch tools (auto white balance / tone, match look).
 * The same Pipeline as the editor, from the decoded proxy. DOM-free: runs in render.worker.ts
 * (OffscreenCanvas) or on the main thread as a fallback.
 */
import type { FloatImage } from '../io/decode/types';
import type { LutData } from '../io/lut/lut';
import { computeGeo } from '../geometry/transform';
import { Pipeline } from '../pipeline/Pipeline';
import { createContext, getCaps } from '../pipeline/gl/context';
import { type SourceTexture, createMipmappedFromRGB, createRenderTarget, deleteRenderTarget } from '../pipeline/gl/texture';
import { lutRegistry } from '../pipeline/lutRegistry';
import { type MaskBitmap, maskRegistry } from '../pipeline/maskRegistry';
import type { ImageModel, OutputTarget } from '../pipeline/types';
import type { Recipe } from '../recipe/schema';

export interface RenderJob {
  proxy: FloatImage;
  image: ImageModel;
  /** Effective recipe (section toggles applied). */
  recipe: Recipe;
  luts: LutData[];
  masks: MaskBitmap[];
}

export interface RenderedPixels {
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
}

let state: { canvas: OffscreenCanvas; gl: WebGL2RenderingContext; pipeline: Pipeline } | null = null;

function ctx() {
  if (state && !state.gl.isContextLost()) return state;
  state?.pipeline.dispose();
  const canvas = new OffscreenCanvas(1, 1);
  const gl = createContext(canvas, false);
  state = { canvas, gl, pipeline: new Pipeline(gl, getCaps(gl).floatLinear, { intermediate: 'rgba16f' }) };
  return state;
}

export function canRender(): boolean {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    const ok = !!gl && !!gl.getExtension('EXT_color_buffer_float');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Render the whole output (cropped, transformed) at ≤ maxEdge. `linear`: working-space float
 * readback (until a stage, for analysis); else sRGB 8-bit with dither. Rows run top → bottom.
 */
export async function renderWhole(job: RenderJob, maxEdge: number, opts: { linear?: boolean; until?: string } = {}): Promise<RenderedPixels> {
  const { gl, pipeline } = ctx();
  for (const l of job.luts) lutRegistry.set(l);
  // Registered for this render only (on the main-thread fallback the registry is the editor's).
  const added = job.masks.filter((m) => !maskRegistry.has(m.key));
  for (const m of added) maskRegistry.set(m);
  const p = job.proxy;
  const tex = await createMipmappedFromRGB(gl, pipeline.programs, pipeline.vao, p.data, p.width, p.height);
  const source: SourceTexture = { tex, region: { x: 0, y: 0, w: job.image.width, h: job.image.height }, scale: p.width / job.image.width, mipmapped: true, linear: true };
  const geo = computeGeo(job.image, job.recipe);
  const k = Math.min(1, maxEdge / Math.max(geo.outW, geo.outH));
  const w = Math.max(1, Math.round(geo.outW * k)), h = Math.max(1, Math.round(geo.outH * k));
  const sx = geo.outW / w, sy = geo.outH / h;
  const linear = !!opts.linear;
  const target: OutputTarget = linear
    ? { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false }
    : { mode: 'encoded', space: 'srgb', dither: true, clipOverlay: false };
  const rt = createRenderTarget(gl, w, h, linear ? gl.RGBA32F : gl.RGBA8, 1, false);
  try {
    pipeline.render({
      source,
      image: job.image,
      recipe: job.recipe,
      target,
      view: [sx, 0, 0, 0, sy, 0, 0, 0, 1],
      width: w,
      height: h,
      framebuffer: rt.fbo,
      mapSource: source,
      until: opts.until,
      lod: Math.max(0, Math.log2(source.scale * sx)),
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    const data = linear ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, linear ? gl.FLOAT : gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (gl.isContextLost()) throw new Error('The GPU context was lost while rendering a preview');
    return { data, width: w, height: h };
  } finally {
    deleteRenderTarget(gl, rt);
    gl.deleteTexture(tex);
    // Release everything kept for this photo: the next job is another image.
    pipeline.dropCache();
    for (const m of added) maskRegistry.delete(m.key);
  }
}

/** Encode 8-bit RGBA as WebP (else JPEG) at its size and as a thumbnail. */
export async function encodePreview(px: RenderedPixels, thumbEdge: number): Promise<{ preview: Blob; thumb: Blob }> {
  const full = new OffscreenCanvas(px.width, px.height);
  const fctx = full.getContext('2d')!;
  const rgba = new Uint8ClampedArray(px.data.buffer as ArrayBuffer, (px.data as Uint8Array).byteOffset, px.data.length);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  fctx.putImageData(new ImageData(rgba, px.width, px.height), 0, 0);
  const k = Math.min(1, thumbEdge / Math.max(px.width, px.height));
  const small = new OffscreenCanvas(Math.max(1, Math.round(px.width * k)), Math.max(1, Math.round(px.height * k)));
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(full, 0, 0, small.width, small.height);
  const enc = async (c: OffscreenCanvas, q: number) => {
    const b = await c.convertToBlob({ type: 'image/webp', quality: q });
    return b.type === 'image/webp' ? b : c.convertToBlob({ type: 'image/jpeg', quality: q });
  };
  return { preview: await enc(full, 0.86), thumb: await enc(small, 0.82) };
}

export function disposeRenderer() {
  state?.pipeline.dispose();
  state?.gl.getExtension('WEBGL_lose_context')?.loseContext();
  state = null;
}
