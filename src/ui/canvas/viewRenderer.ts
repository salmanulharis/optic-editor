/**
 * Owns the on-screen WebGL2 context: the preview proxy texture, a full-resolution "detail"
 * texture for zoom ≥ 100 %, and the small renders for histogram, pixel readout and analysis.
 *
 * Performance model: the proxy (≤ 2× canvas, ≤ 4096 px, mipmapped RGBA16F) is uploaded once.
 * Every frame renders the pipeline straight into the canvas at canvas resolution, so the cost is
 * independent of the source's megapixels. Intermediate passes are kept between frames (cache slot
 * per side), so an edit late in the pipeline does not re-run early spatial stages. While a slider
 * is being dragged with expensive spatial effects on, frames can render at half resolution
 * (`draft`) and are refined when the drag ends.
 *
 * All view coordinates are output pixels: the cropped, transformed image the recipe produces.
 */
import type { ColorSpaceId, Mat3 } from '../../color/matrices';
import { sourceRegion } from '../../geometry/mapping';
import { computeGeo } from '../../geometry/transform';
import { Pipeline } from '../../pipeline/Pipeline';
import { type GLCaps, createContext, displayIsP3, getCaps } from '../../pipeline/gl/context';
import {
  type Region,
  type RenderTargetTex,
  type SourceTexture,
  createMipmappedFromRGB,
  createRenderTarget,
  createTexture,
  deleteRenderTarget,
  uploadRGB,
} from '../../pipeline/gl/texture';
import type { OutputTarget } from '../../pipeline/types';
import type { Recipe } from '../../recipe/schema';
import type { LoadedImage } from '../../state/imageStore';
import type { Histogram } from '../../state/uiStore';

const BG = 0x1c / 255;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** Source pixels around a detail region for input filters, defringe and CA shifts. */
const DETAIL_MARGIN = 48;

export interface ViewState {
  /** Device pixels per image pixel. */
  scale: number;
  /** Image pixel at the centre of the canvas (or of each half, side by side). */
  cx: number;
  cy: number;
}

export interface CompareSpec {
  mode: 'split' | 'side';
  before: Recipe;
  /** Split position 0…1 along the divider axis. */
  pos: number;
  /** Divider orientation: vertical (left | right) or horizontal (top / bottom). */
  vertical: boolean;
  /** Before on the right / bottom instead of the left / top. */
  swap: boolean;
}

export interface FrameSpec {
  recipe: Recipe;
  view: ViewState;
  overlay: boolean;
  visualize?: boolean;
  maskView?: 'sharpen';
  /** Render at half resolution (fast feedback while dragging). */
  draft?: boolean;
  compare?: CompareSpec | null;
}

/** Sobel gradient of gamma-encoded luminance (for line detection). */
const SOBEL_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_src;
out vec4 o;
float L(ivec2 p) {
  ivec2 s = textureSize(u_src, 0) - 1;
  vec3 c = texelFetch(u_src, clamp(p, ivec2(0), s), 0).rgb;
  return pow(max(dot(c, vec3(0.2627, 0.678, 0.0593)), 0.0), 1.0 / 2.2);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float gx = (L(p + ivec2(1, -1)) + 2.0 * L(p + ivec2(1, 0)) + L(p + ivec2(1, 1))) - (L(p + ivec2(-1, -1)) + 2.0 * L(p + ivec2(-1, 0)) + L(p + ivec2(-1, 1)));
  float gy = (L(p + ivec2(-1, 1)) + 2.0 * L(p + ivec2(0, 1)) + L(p + ivec2(1, 1))) - (L(p + ivec2(-1, -1)) + 2.0 * L(p + ivec2(0, -1)) + L(p + ivec2(1, -1)));
  o = vec4(gx * 0.125, gy * 0.125, 0.0, 1.0);
}`;

const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
out vec4 o;
void main() { o = vec4(texture(u_src, gl_FragCoord.xy / u_size).rgb, 1.0); }`;

export class ViewRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;
  readonly pipeline: Pipeline;
  private image: LoadedImage | null = null;
  private proxy: SourceTexture | null = null;
  private detail: SourceTexture | null = null;
  private detailPending: Region | null = null;
  private detailToken = 0;
  private small: RenderTargetTex | null = null;
  private pixel: RenderTargetTex;
  private draftRt: RenderTargetTex | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas, displayIsP3());
    this.caps = getCaps(this.gl);
    this.pipeline = new Pipeline(this.gl, this.caps.floatLinear, { intermediate: 'rgba16f' });
    this.pipeline.programs.prefetch(BLIT_FS);
    this.pixel = createRenderTarget(this.gl, 1, 1, this.gl.RGBA32F, 1, false);
  }

  /** Space the canvas displays in. */
  get displaySpace(): ColorSpaceId {
    return this.caps.p3 ? 'display-p3' : 'srgb';
  }

  async setImage(img: LoadedImage | null) {
    const gl = this.gl;
    this.dropTextures();
    this.image = img;
    this.pipeline.dropCache();
    if (!img) return;
    const p = img.proxy;
    const tex = await createMipmappedFromRGB(gl, this.pipeline.programs, this.pipeline.vao, p.data, p.width, p.height, nextFrame);
    if (this.image !== img) { gl.deleteTexture(tex); return; }
    this.proxy = {
      tex,
      region: { x: 0, y: 0, w: img.width, h: img.height },
      scale: p.width / img.width,
      mipmapped: true,
      linear: true,
    };
  }

  get ready() {
    return !!this.proxy;
  }

  private dropTextures() {
    if (this.proxy) this.gl.deleteTexture(this.proxy.tex);
    if (this.detail) this.gl.deleteTexture(this.detail.tex);
    this.proxy = this.detail = null;
    this.detailPending = null;
    this.detailToken++;
  }

  /** Output size (cropped, transformed) of the image under a recipe. */
  outputSize(recipe: Recipe): { width: number; height: number } {
    if (!this.image) return { width: 1, height: 1 };
    const g = computeGeo(this.image.model, recipe);
    return { width: g.outW, height: g.outH };
  }

  /** Local fragment coordinate (bottom-left origin) of a W × H area → output pixel. */
  viewMatrix(v: ViewState, W = this.canvas.width, H = this.canvas.height): Mat3 {
    const k = 1 / v.scale;
    return [k, 0, v.cx - (W / 2) * k, 0, -k, v.cy + (H / 2) * k, 0, 0, 1];
  }

  visibleRegion(v: ViewState, W = this.canvas.width, H = this.canvas.height): Region {
    const w = W / v.scale, h = H / v.scale;
    return { x: v.cx - w / 2, y: v.cy - h / 2, w, h };
  }

  previewTarget(recipe: Recipe, overlay: boolean, visualizePointColor = false, maskView?: 'sharpen'): OutputTarget {
    return {
      visualizePointColor,
      maskView,
      mode: 'encoded',
      // Preview gamut: the recipe's choice when the screen can show it, else sRGB.
      space: this.caps.p3 ? recipe.output.colorSpace : 'srgb',
      displaySpace: this.displaySpace,
      dither: true,
      clipOverlay: overlay,
    };
  }

  /**
   * Keep a full-resolution texture for the source area behind the visible output when zoomed in to
   * ≥ 100 %. Uploads happen in row chunks across frames; the proxy is used until it is complete.
   */
  private updateDetail(recipe: Recipe, v: ViewState, W: number, H: number, onReady: () => void) {
    const img = this.image;
    if (!img || !this.proxy || v.scale < 0.999 || this.proxy.scale >= 0.999) return;
    const vis = this.visibleRegion(v, W, H);
    const out = this.outputSize(recipe);
    const x0 = Math.max(0, vis.x), y0 = Math.max(0, vis.y);
    const x1 = Math.min(out.width, vis.x + vis.w), y1 = Math.min(out.height, vis.y + vis.h);
    if (x1 <= x0 || y1 <= y0) return;
    const need = sourceRegion(img.model, recipe, x0, y0, x1 - x0, y1 - y0, DETAIL_MARGIN);
    const covers = (r: Region) => need.x >= r.x && need.y >= r.y && need.x + need.w <= r.x + r.w && need.y + need.h <= r.y + r.h;
    if (this.detail && covers(this.detail.region)) return;
    if (this.detailPending && covers(this.detailPending)) return;
    const max = this.caps.maxTextureSize;
    // Some slack around the visible area so small pans don't re-upload.
    const grow = (a: number, len: number, total: number) => {
      const s = Math.max(0, Math.floor(a - len * 0.25));
      return [s, Math.min(total - s, Math.ceil(len * 1.5), max)] as const;
    };
    const [wx, ww] = grow(need.x, need.w, img.width);
    const [wy, wh] = grow(need.y, need.h, img.height);
    const want: Region = { x: wx, y: wy, w: ww, h: wh };
    this.detailPending = want;
    const token = ++this.detailToken;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15);
    const tex = createTexture(gl, want.w, want.h, gl.RGB32F, { linear: false });
    void uploadRGB(gl, tex, img.full.data, img.width, want, 128, nextFrame).then(() => {
      if (token !== this.detailToken) { gl.deleteTexture(tex); return; }
      if (this.detail) gl.deleteTexture(this.detail.tex);
      this.detail = { tex, region: want, scale: 1, mipmapped: false, linear: false };
      this.detailPending = null;
      onReady();
    });
  }

  /** False while the shaders this frame needs are still compiling (the caller retries next frame). */
  canRender(f: Pick<FrameSpec, 'recipe' | 'overlay' | 'visualize' | 'maskView' | 'compare'>): boolean {
    if (!this.image || !this.proxy) return true;
    const ready = (recipe: Recipe) => this.pipeline.isReady({
      image: this.image!.model,
      recipe,
      target: this.previewTarget(recipe, f.overlay, f.visualize, f.maskView),
      source: this.proxy!,
    });
    return ready(f.recipe) && (!f.compare || ready(f.compare.before)) && this.pipeline.programs.isReady(BLIT_FS);
  }

  private clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(BG, BG, BG, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private renderOne(
    recipe: Recipe, v: ViewState, f: FrameSpec, area: { x: number; y: number; w: number; h: number },
    fb: WebGLFramebuffer | null, slot: string, onDetailReady: () => void, scissor?: [number, number, number, number],
  ) {
    const gl = this.gl;
    this.updateDetail(recipe, v, area.w, area.h, onDetailReady);
    const out = this.outputSize(recipe);
    const vis = this.visibleRegion(v, area.w, area.h);
    const visibleOut = { x: Math.max(0, vis.x), y: Math.max(0, vis.y), w: Math.min(out.width, vis.x + vis.w) - Math.max(0, vis.x), h: Math.min(out.height, vis.y + vis.h) - Math.max(0, vis.y) };
    let useDetail = false;
    if (this.detail && v.scale >= 0.999 && visibleOut.w > 0 && visibleOut.h > 0) {
      const need = sourceRegion(this.image!.model, recipe, visibleOut.x, visibleOut.y, visibleOut.w, visibleOut.h, 0);
      const d = this.detail.region;
      useDetail = need.x >= d.x && need.y >= d.y && need.x + need.w <= d.x + d.w && need.y + need.h <= d.y + d.h;
    }
    const source = useDetail ? this.detail! : this.proxy!;
    if (useDetail) {
      // Nearest at ≥ 200 % for honest pixel peeping; linear between 100 % and 200 % if possible.
      const lin = this.caps.floatLinear && v.scale < 2;
      gl.bindTexture(gl.TEXTURE_2D, source.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
    }
    const texelsPerPx = source.scale / v.scale;
    this.pipeline.render({
      source,
      image: this.image!.model,
      recipe,
      target: this.previewTarget(recipe, f.overlay, f.visualize, f.maskView),
      mapSource: this.proxy!,
      view: this.viewMatrix(v, area.w, area.h),
      width: area.w,
      height: area.h,
      origin: [area.x, area.y],
      scissor,
      framebuffer: fb,
      background: [BG, BG, BG, 1],
      lod: Math.max(0, Math.log2(texelsPerPx)),
      cache: slot,
      draftMaps: !!f.draft,
    });
  }

  /** Render the view into the canvas. */
  render(f: FrameSpec, onDetailReady: () => void) {
    const gl = this.gl;
    if (!this.image || !this.proxy) { this.clear(); return; }
    const W = this.canvas.width, H = this.canvas.height;
    const c = f.compare;
    if (c && c.mode === 'side') {
      // Two halves, the same view (zoom and pan locked): each half centres the same image point.
      const half = Math.floor(W / 2);
      this.clear();
      const left = c.swap ? f.recipe : c.before, right = c.swap ? c.before : f.recipe;
      this.renderOne(left, f.view, f, { x: 0, y: 0, w: half, h: H }, null, c.swap ? 'main' : 'before', onDetailReady);
      this.renderOne(right, f.view, f, { x: W - half, y: 0, w: half, h: H }, null, c.swap ? 'before' : 'main', onDetailReady);
      return;
    }
    if (c && c.mode === 'split') {
      this.renderOne(f.recipe, f.view, f, { x: 0, y: 0, w: W, h: H }, null, 'main', onDetailReady);
      // Before covers the left (top) part; swapped, the right (bottom) part. GL y runs upwards.
      const sx = Math.round(W * c.pos), sy = Math.round(H * (1 - c.pos));
      const scissor: [number, number, number, number] = c.vertical
        ? (c.swap ? [sx, 0, W - sx, H] : [0, 0, sx, H])
        : (c.swap ? [0, 0, W, sy] : [0, sy, W, H - sy]);
      this.renderOne(c.before, f.view, f, { x: 0, y: 0, w: W, h: H }, null, 'before', onDetailReady, scissor);
      return;
    }
    if (f.draft && W > 64 && H > 64) {
      // Half resolution into an offscreen target, scaled up with linear filtering.
      const w = Math.ceil(W / 2), h = Math.ceil(H / 2);
      if (!this.draftRt || this.draftRt.width !== w || this.draftRt.height !== h) {
        deleteRenderTarget(gl, this.draftRt);
        gl.activeTexture(gl.TEXTURE0 + 15);
        this.draftRt = createRenderTarget(gl, w, h, gl.RGBA16F);
      }
      const v = { ...f.view, scale: f.view.scale * (w / W) };
      this.renderOne(f.recipe, v, f, { x: 0, y: 0, w, h }, this.draftRt.fbo, 'draft', onDetailReady);
      const prog = this.pipeline.programs.get(BLIT_FS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.draftRt.tex);
      gl.uniform1i(prog.loc('u_src'), 0);
      gl.uniform2f(prog.loc('u_size'), W, H);
      gl.bindVertexArray(this.pipeline.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    this.renderOne(f.recipe, f.view, f, { x: 0, y: 0, w: W, h: H }, null, 'main', onDetailReady);
  }

  /** Render the whole image small (≤ maxEdge) and read it back as float RGBA (synchronous). */
  renderSmall(recipe: Recipe, target: OutputTarget, maxEdge: number, until?: string): { data: Float32Array; width: number; height: number } | null {
    const size = this.renderSmallOnly(recipe, target, maxEdge, until);
    if (!size) return null;
    const gl = this.gl;
    const data = new Float32Array(size.w * size.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.small!.fbo);
    gl.readPixels(0, 0, size.w, size.h, gl.RGBA, gl.FLOAT, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data, width: size.w, height: size.h };
  }

  private renderSmallOnly(recipe: Recipe, target: OutputTarget, maxEdge: number, until?: string): { w: number; h: number } | null {
    const img = this.image;
    if (!img || !this.proxy) return null;
    const gl = this.gl;
    const out = this.outputSize(recipe);
    const k = Math.min(1, maxEdge / Math.max(out.width, out.height));
    const w = Math.max(1, Math.round(out.width * k)), h = Math.max(1, Math.round(out.height * k));
    if (!this.small || this.small.width !== w || this.small.height !== h) {
      deleteRenderTarget(gl, this.small);
      gl.activeTexture(gl.TEXTURE0 + 15);
      this.small = createRenderTarget(gl, w, h, gl.RGBA32F, 1, false);
    }
    const sx = out.width / w, sy = out.height / h;
    this.pipeline.render({
      source: this.proxy,
      image: img.model,
      recipe,
      target,
      view: [sx, 0, 0, 0, sy, 0, 0, 0, 1],
      width: w,
      height: h,
      framebuffer: this.small.fbo,
      mapSource: this.proxy,
      until,
      lod: Math.max(0, Math.log2(this.proxy.scale * sx)),
    });
    return { w, h };
  }

  /**
   * Gradient image for line detection (upright): the image at ≤ maxEdge in linear light, then a
   * Sobel filter of its gamma-encoded luminance on the GPU. Returns (gx, gy, -, -) per pixel,
   * rows top → bottom.
   */
  edgeMap(recipe: Recipe, maxEdge: number): { data: Float32Array; width: number; height: number } | null {
    const size = this.renderSmallOnly(recipe, { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false }, maxEdge, 'cast');
    if (!size) return null;
    const gl = this.gl;
    const out = this.pipeline.kit.rt('edges', size.w, size.h, 'rgba32f');
    this.pipeline.kit.draw(SOBEL_FS, out, {}, { u_src: this.small!.tex });
    const data = new Float32Array(size.w * size.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, size.w, size.h, gl.RGBA, gl.FLOAT, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data, width: size.w, height: size.h };
  }

  /** Preset thumbnail: the whole image at ≤ maxEdge, sRGB-encoded 8-bit (dithered). */
  thumbnail(recipe: Recipe, maxEdge = 256): ImageData | null {
    const res = this.renderSmall(recipe, { mode: 'encoded', space: 'srgb', dither: true, clipOverlay: false }, maxEdge);
    if (!res) return null;
    const out = new Uint8ClampedArray(res.width * res.height * 4);
    // Float readback rows run bottom → top in GL but our view maps row 0 to the image top already.
    for (let i = 0; i < out.length; i++) out[i] = (i & 3) === 3 ? 255 : res.data[i] * 255 + 0.5;
    return new ImageData(out, res.width, res.height);
  }

  /** Whether a thumbnail render for this recipe would not wait on the compiler. */
  thumbnailReady(recipe: Recipe): boolean {
    if (!this.image || !this.proxy) return false;
    return this.pipeline.isReady({ image: this.image.model, recipe, target: { mode: 'encoded', space: 'srgb', dither: true, clipOverlay: false }, source: this.proxy });
  }

  get imageId() {
    return this.image?.id ?? 0;
  }

  // Histogram readback is asynchronous (pixel-pack buffer + fence), so it never stalls a frame
  // waiting for the GPU: start() queues the copy, poll() returns the result once it has landed.
  private histPbo: WebGLBuffer | null = null;
  private histFence: WebGLSync | null = null;
  private histSize = { w: 0, h: 0 };

  startHistogram(recipe: Recipe): boolean {
    if (this.histFence) return false;
    const target = this.previewTarget(recipe, false);
    const size = this.renderSmallOnly(recipe, { ...target, dither: false, displaySpace: target.space }, 256);
    if (!size) return false;
    const gl = this.gl;
    this.histPbo ??= gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.histPbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size.w * size.h * 16, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.small!.fbo);
    gl.readPixels(0, 0, size.w, size.h, gl.RGBA, gl.FLOAT, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.histFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.histSize = size;
    return true;
  }

  /** The histogram once the GPU has delivered it, else undefined. */
  pollHistogram(): Histogram | undefined {
    const gl = this.gl;
    if (!this.histFence) return undefined;
    const st = gl.clientWaitSync(this.histFence, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return undefined;
    gl.deleteSync(this.histFence);
    this.histFence = null;
    const { w, h } = this.histSize;
    const data = new Float32Array(w * h * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.histPbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return this.binHistogram({ data, width: w, height: h });
  }

  histogram(recipe: Recipe): Histogram | null {
    const target = this.previewTarget(recipe, false);
    const res = this.renderSmall(recipe, { ...target, dither: false, displaySpace: target.space }, 256);
    return res ? this.binHistogram(res) : null;
  }

  private binHistogram(res: { data: Float32Array; width: number; height: number }): Histogram {
    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    let hiClip = 0, loClip = 0;
    const d = res.data;
    const n = res.width * res.height;
    const bin = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
    for (let i = 0; i < n; i++) {
      const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
      r[bin(R)]++; g[bin(G)]++; b[bin(B)]++;
      l[bin(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
      if (Math.max(R, G, B) >= 0.999) hiClip++;
      if (Math.max(R, G, B) <= 0.0015) loClip++;
    }
    return { r, g, b, l, clipHigh: hiClip / n, clipLow: loClip / n };
  }

  /**
   * Render a single output pixel at full resolution; returns RGBA floats (encoded or
   * working-linear per target). Spatial stages see their real neighbourhood (padding).
   */
  readPixel(recipe: Recipe, x: number, y: number, target: OutputTarget, until?: string): Float32Array | null {
    const img = this.image;
    if (!img || !this.proxy) return null;
    const gl = this.gl;
    const fx = Math.floor(x), fy = Math.floor(y);
    let source: SourceTexture = this.proxy;
    if (this.detail) {
      const need = sourceRegion(img.model, recipe, fx, fy, 1, 1, 0);
      const d = this.detail.region;
      if (need.x >= d.x && need.y >= d.y && need.x + need.w <= d.x + d.w && need.y + need.h <= d.y + d.h) source = this.detail;
    }
    this.pipeline.render({
      source,
      image: img.model,
      recipe,
      target,
      view: [1, 0, fx, 0, 1, fy, 0, 0, 1],
      width: 1,
      height: 1,
      framebuffer: this.pixel.fbo,
      mapSource: this.proxy,
      until,
      lod: source === this.proxy ? Math.max(0, Math.log2(this.proxy.scale)) : 0,
    });
    const out = new Float32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pixel.fbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  dispose() {
    this.dropTextures();
    if (this.histFence) this.gl.deleteSync(this.histFence);
    if (this.histPbo) this.gl.deleteBuffer(this.histPbo);
    deleteRenderTarget(this.gl, this.small);
    deleteRenderTarget(this.gl, this.pixel);
    deleteRenderTarget(this.gl, this.draftRt);
    this.pipeline.dispose();
  }
}
