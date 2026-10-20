/**
 * Full-resolution render for export. Runs the *same* Pipeline as the preview, at 1:1, over the
 * original float pixels, in tiles of the output (cropped, transformed) image:
 *  - each tile's source area is found by mapping the tile (plus the spatial padding) through the
 *    output → source transform, then uploaded with a margin for the input filters, defringe and
 *    CA shifts;
 *  - spatial stages run on a padded frame (Pipeline padding ≥ their summed reach), so tiles join
 *    without seams;
 *  - image-wide maps (micro-contrast, clarity, dehaze, glow) are built once from the preview proxy,
 *    exactly as in the preview, and shared by all tiles.
 * Tiles are read back as float and quantised to 16 bits. The output has exactly the crop's pixel
 * size. DOM-free: used inside the export worker (OffscreenCanvas) and as a main-thread fallback.
 */
import type { FloatImage } from '../decode/types';
import { sourceRegion } from '../../geometry/mapping';
import { computeGeo } from '../../geometry/transform';
import { Pipeline } from '../../pipeline/Pipeline';
import { createContext, getCaps } from '../../pipeline/gl/context';
import { type SourceTexture, createMipmappedFromRGB, createRenderTarget, createTexture, deleteRenderTarget, uploadRGB } from '../../pipeline/gl/texture';
import { lutRegistry } from '../../pipeline/lutRegistry';
import type { LutData } from '../lut/lut';
import type { ImageModel, OutputTarget } from '../../pipeline/types';
import type { Recipe } from '../../recipe/schema';

export const TILE = 1024;
/** Source margin around each tile: deband reaches ~24 px, defringe and CA a few more. */
export const MARGIN = 40;

export interface ExportRenderInput {
  full: FloatImage;
  /** The preview proxy: image-wide maps are built from it, exactly as in the preview. */
  proxy: FloatImage;
  /** LUTs referenced by the recipe (the worker has no access to the UI's registry). */
  luts: LutData[];
  image: ImageModel;
  recipe: Recipe;
  target: OutputTarget;
}

export interface RenderOptions {
  /** Tile size override (seam test: small tiles vs. one tile). */
  tile?: number;
}

export interface RenderedImage {
  data: Uint16Array;
  width: number;
  height: number;
}

export async function renderFullResolution(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  input: ExportRenderInput,
  onProgress: (f: number) => void,
  yieldFn: () => Promise<void> = async () => {},
  opts: RenderOptions = {},
): Promise<RenderedImage> {
  const gl = createContext(canvas, false);
  const caps = getCaps(gl);
  const pipeline = new Pipeline(gl, caps.floatLinear, { intermediate: 'rgba32f' });
  for (const l of input.luts) lutRegistry.set(l);
  const { width: W, height: H, data } = input.full;
  const view1: [number, number, number, number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const probe = pipeline.context({ image: input.image, recipe: input.recipe, target: input.target, source: { tex: null as unknown as WebGLTexture, region: { x: 0, y: 0, w: W, h: H }, scale: 1, mipmapped: false, linear: false }, view: view1 });
  const stages = pipeline.activeStages(probe);
  let mapSource: SourceTexture | undefined;
  if (stages.some((s) => s.maps && s.maps(probe).length)) {
    const p = input.proxy;
    const tex = await createMipmappedFromRGB(gl, pipeline.programs, pipeline.vao, p.data, p.width, p.height, yieldFn);
    mapSource = { tex, region: { x: 0, y: 0, w: W, h: H }, scale: p.width / W, mipmapped: true, linear: true };
  }
  const geo = computeGeo(input.image, input.recipe);
  const OW = geo.outW, OH = geo.outH;
  const pad = pipeline.padding(probe, stages);
  // A multiple of 4 (like the padding): helper grids stay aligned with output pixels in every tile.
  const tile = Math.max(64, Math.floor(Math.min(opts.tile ?? TILE, caps.maxTextureSize - 2 * (pad + MARGIN)) / 4) * 4);
  const out = new Uint16Array(OW * OH * 3);
  let srcTex: WebGLTexture | null = null;
  let srcW = 0, srcH = 0;
  const rt = createRenderTarget(gl, tile, tile, gl.RGBA32F, 1, false);
  const readBuf = new Float32Array(tile * tile * 4);
  const tilesX = Math.ceil(OW / tile), tilesY = Math.ceil(OH / tile);
  let done = 0;
  try {
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * tile, y0 = ty * tile;
        const w = Math.min(tile, OW - x0), h = Math.min(tile, OH - y0);
        // Source area behind the tile and its padding.
        const reg = sourceRegion(input.image, input.recipe, x0 - pad, y0 - pad, w + 2 * pad, h + 2 * pad, MARGIN);
        if (reg.w > caps.maxTextureSize || reg.h > caps.maxTextureSize) throw new Error('Transform too extreme for the GPU texture size; reduce the perspective correction');
        if (!srcTex || reg.w > srcW || reg.h > srcH) {
          if (srcTex) gl.deleteTexture(srcTex);
          srcW = Math.max(reg.w, srcW, Math.min(caps.maxTextureSize, tile + 2 * (pad + MARGIN)));
          srcH = Math.max(reg.h, srcH, Math.min(caps.maxTextureSize, tile + 2 * (pad + MARGIN)));
          gl.activeTexture(gl.TEXTURE0 + 15);
          srcTex = createTexture(gl, srcW, srcH, gl.RGB32F, { linear: caps.floatLinear });
        }
        await uploadRGB(gl, srcTex, data, W, reg);
        pipeline.render({
          source: {
            tex: srcTex,
            // The texture is srcW × srcH; the valid data occupies its top-left reg.w × reg.h.
            region: { x: reg.x, y: reg.y, w: srcW, h: srcH },
            scale: 1,
            mipmapped: false,
            linear: caps.floatLinear,
          },
          image: input.image,
          recipe: input.recipe,
          target: input.target,
          mapSource,
          // Fragment (fx, fy) → output pixel (x0 + fx, y0 + fy); readPixels rows go top → bottom.
          view: [1, 0, x0, 0, 1, y0, 0, 0, 1],
          width: w,
          height: h,
          framebuffer: rt.fbo,
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, readBuf, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // A lost context (usually: out of GPU memory) reads back zeros: never write that to a file.
        if (gl.isContextLost() || gl.getError() === gl.OUT_OF_MEMORY) {
          throw new Error('The GPU ran out of memory during export. Try a smaller tile size or close other GPU-heavy tabs.');
        }
        for (let y = 0; y < h; y++) {
          let si = y * w * 4;
          let di = ((y0 + y) * OW + x0) * 3;
          for (let x = 0; x < w; x++, si += 4, di += 3) {
            const r = readBuf[si], g = readBuf[si + 1], b = readBuf[si + 2];
            out[di] = r <= 0 ? 0 : r >= 1 ? 65535 : Math.round(r * 65535);
            out[di + 1] = g <= 0 ? 0 : g >= 1 ? 65535 : Math.round(g * 65535);
            out[di + 2] = b <= 0 ? 0 : b >= 1 ? 65535 : Math.round(b * 65535);
          }
        }
        done++;
        onProgress(done / (tilesX * tilesY));
        await yieldFn();
      }
    }
  } finally {
    if (srcTex) gl.deleteTexture(srcTex);
    if (mapSource) gl.deleteTexture(mapSource.tex);
    deleteRenderTarget(gl, rt);
    pipeline.dispose();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return { data: out, width: OW, height: OH };
}

/** Area-average resample of 16-bit RGB to a smaller size (in the encoded domain). */
export function resampleU16(src: Uint16Array, W: number, H: number, w: number, h: number): Uint16Array {
  if (w === W && h === H) return src;
  const weights = (n: number, m: number) => {
    const s = n / m;
    return Array.from({ length: m }, (_, i) => {
      const a = i * s, b = (i + 1) * s;
      const taps: Array<[number, number]> = [];
      for (let k = Math.floor(a); k < Math.min(n, Math.ceil(b)); k++) taps.push([k, (Math.min(b, k + 1) - Math.max(a, k)) / s]);
      return taps;
    });
  };
  const wx = weights(W, w), wy = weights(H, h);
  const tmp = new Float32Array(H * w * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (const [k, wt] of wx[x]) {
        const i = (y * W + k) * 3;
        r += src[i] * wt; g += src[i + 1] * wt; b += src[i + 2] * wt;
      }
      const o = (y * w + x) * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  const out = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w * 3; x++) {
      let v = 0;
      for (const [k, wt] of wy[y]) v += tmp[k * w * 3 + x] * wt;
      out[y * w * 3 + x] = Math.min(65535, Math.round(v));
    }
  }
  return out;
}
