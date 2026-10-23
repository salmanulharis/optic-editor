/**
 * Pipeline: render(image, recipe) on the GPU.
 *
 * The ordered stage list is split into passes. A pass starts at the source stage or at a
 * `spatial` stage; every following `point` stage is fused into the same fragment shader, so a
 * typical edit is a single full-screen pass. The `warp` stage (lens + geometry) is compiled into the
 * first pass, where the source is sampled exactly once per output pixel. Stages whose parameters
 * are at identity are left out of the generated shader entirely (zero cost); programs are cached
 * per active-stage combination.
 *
 * Coordinates: `view` maps local fragment coordinates (target pixels, origin bottom-left of the
 * render area) to output pixels (origin top-left of the cropped, transformed image). The same
 * mapping serves the on-screen viewer, histogram and pixel-readout renders and the 1:1 export
 * tiles. The renderer itself is DOM-free, so it also runs in the export worker.
 *
 * Spatial passes: intermediate passes render a padded frame (target + `pad` on each side, where
 * pad ≥ the summed reach of every spatial stage), so a spatial filter near the edge of the target
 * reads real neighbours. That makes a tile of the export identical to the same area of an untiled
 * render, and lets the viewer process only the visible area at 100 % zoom. Outside the image the
 * intermediate passes replicate the edge; only the final pass paints the background.
 *
 * Image-wide maps (large-radius effects: clarity, dehaze, bloom/halation, micro-contrast) are
 * rendered over the whole output frame from the preview proxy and cached on the uniforms of every
 * stage upstream of them, so they are shared by the preview, analysis renders and all export tiles.
 *
 * Intermediate results can be kept between renders (`cache` slot): a pass whose inputs did not
 * change is not re-run, so dragging grain does not re-run noise reduction.
 */
import { type Mat3, mul, toGL } from '../color/matrices';
import { lensModel } from '../geometry/lens';
import { computeGeo } from '../geometry/transform';
import type { Recipe } from '../recipe/schema';
import { derive } from './derive';
import { CurveLutCache } from './gl/curveLut';
import { type Fmt, GpuKit, KIT_HELPERS } from './gl/gpuKit';
import { grainTexture } from './gl/grainNoise';
import { ProgramCache, declaredSamplers, setUniform } from './gl/program';
import { type RenderTargetTex, type SourceTexture, createRenderTarget, createTexture, deleteRenderTarget, texKey } from './gl/texture';
import { COMMON_GLSL } from './glslCommon';
import { LutTextureCache } from './lutRegistry';
import { MaskTextureCache } from './maskRegistry';
import { mapDims } from './mapDims';
import { STAGES } from './stages';
import type { ImageModel, MapSpec, OutputTarget, Stage, StageContext, StageResources, StageTextures, Uniform } from './types';

export interface RenderParams {
  source: SourceTexture;
  image: ImageModel;
  /** Effective recipe (section toggles already applied). */
  recipe: Recipe;
  target: OutputTarget;
  /** Local fragment coordinate → output pixel. */
  view: Mat3;
  width: number;
  height: number;
  framebuffer: WebGLFramebuffer | null;
  /** Bottom-left corner of the render area in the framebuffer (side-by-side compare). */
  origin?: [number, number];
  /** Restrict the final pass to this framebuffer rectangle (split compare). */
  scissor?: [number, number, number, number];
  /** Encoded colour written outside the image. */
  background?: [number, number, number, number];
  /** Stop after this stage id (inclusive); used for analysis readbacks. */
  until?: string;
  /** Mip level of the source texture to sample (viewer zoom). */
  lod?: number;
  /**
   * Whole-image, mipmapped texture (the preview proxy) used to build image-wide maps. Defaults to
   * `source`; export tiles must pass the proxy here.
   */
  mapSource?: SourceTexture;
  /** Keep intermediate results under this name and skip passes whose inputs did not change. */
  cache?: string;
  /** This render builds an image-wide map (stages marked skipInMaps are left out). */
  forMap?: boolean;
  /** Build draftable maps at half density (fast feedback while a slider is dragged). */
  draftMaps?: boolean;
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
uniform mat3 u_view;
uniform vec2 u_fullSize;   // output (cropped, transformed) image size in pixels
uniform vec2 u_srcSize;    // source image size in pixels
uniform vec2 u_origin;
uniform float u_prevOffset;
uniform int u_final;
uniform vec4 u_bg;
uniform sampler2D u_prev;
out vec4 outColor;
vec2 g_px;  // output-pixel position of the current fragment (for image-space lookups)
ivec2 g_fc; // the fragment's pixel in the (padded) intermediate frame
`;

interface Pass {
  stages: Stage[];
}

const LINEAR_TARGET: OutputTarget = { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false };
const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];

interface MapEntry {
  key: string;
  tex: Record<string, WebGLTexture>;
  used: number;
}

interface SlotPass {
  key: string;
  rt: RenderTargetTex | null;
  prepKey: string;
  aux: StageTextures | null;
}

export class Pipeline {
  readonly programs: ProgramCache;
  readonly curves: CurveLutCache;
  readonly luts: LutTextureCache;
  readonly masks: MaskTextureCache;
  readonly vao: WebGLVertexArrayObject;
  readonly kit: GpuKit;
  private pingPong = new Map<string, { rts: RenderTargetTex[]; used: number }>();
  private cacheSlots = new Map<string, SlotPass[]>();
  private maps = new Map<string, MapEntry[]>();
  private tick = 0;
  private readonly fmt: Fmt;

  /**
   * `intermediate`: format of the intermediate passes. The viewer uses RGBA16F (half the memory
   * and bandwidth); export uses RGBA32F.
   */
  constructor(readonly gl: WebGL2RenderingContext, readonly floatLinear: boolean, opts: { intermediate?: Fmt } = {}) {
    this.programs = new ProgramCache(gl);
    this.curves = new CurveLutCache(gl, floatLinear);
    this.luts = new LutTextureCache(gl);
    this.masks = new MaskTextureCache(gl);
    this.vao = gl.createVertexArray()!;
    this.kit = new GpuKit(gl, this.programs, this.vao, () => this.dummyTex(), floatLinear);
    this.fmt = opts.intermediate ?? 'rgba32f';
    for (const h of this.allHelpers()) this.programs.prefetch(h);
  }

  private allHelpers(): string[] {
    const out = new Set<string>(KIT_HELPERS);
    for (const s of STAGES) s.helpers?.forEach((h) => out.add(h));
    return [...out];
  }

  /** Stages that will run for these parameters, in order. */
  activeStages(ctx: StageContext, until?: string, forMap = false): Stage[] {
    const out: Stage[] = [];
    for (const s of STAGES) {
      if (!(forMap && s.skipInMaps) && s.active(ctx)) out.push(s);
      if (until && s.id === until) break;
    }
    return out;
  }

  private splitPasses(stages: Stage[]): Pass[] {
    const passes: Pass[] = [];
    for (const s of stages) {
      if (s.kind === 'warp') { passes[0].stages.push(s); continue; }
      if (s.kind !== 'point' || passes.length === 0) passes.push({ stages: [s] });
      else passes[passes.length - 1].stages.push(s);
    }
    return passes;
  }

  private shaderFor(pass: Pass, first: boolean): string {
    const [head, ...rest] = pass.stages;
    const body: string[] = [];
    if (first) body.push(`  vec4 c = ${head.id}_sample(px);`);
    else body.push(`  vec4 c = ${head.id}_apply(u_prev, g_fc);`);
    for (const s of rest) if (s.kind === 'point') body.push(`  c = ${s.id}_apply(c);`);
    const defines = pass.stages.some((s) => s.kind === 'warp') ? '#define HAS_LENS 1\n' : '';
    return `${HEADER}${defines}${COMMON_GLSL}
${pass.stages.map((s) => s.glsl).join('\n')}
void main() {
  vec2 fc = gl_FragCoord.xy - u_origin;
  vec2 px = (u_view * vec3(fc, 1.0)).xy;
  g_px = px;
  if (px.x < 0.0 || px.y < 0.0 || px.x > u_fullSize.x || px.y > u_fullSize.y) {
    if (u_final == 1) { outColor = u_bg; return; }
    px = clamp(px, vec2(0.5), u_fullSize - 0.5);
    g_px = px;
  }
  g_fc = ivec2(fc) + int(u_prevOffset);
${body.join('\n')}
  outColor = c;
}`;
  }

  context(p: Pick<RenderParams, 'image' | 'recipe' | 'target' | 'source' | 'view' | 'draftMaps'>): StageContext {
    const img = p.image;
    return {
      recipe: p.recipe,
      image: img,
      target: p.target,
      derived: derive(img, p.recipe),
      sourceScale: p.source.scale,
      geo: computeGeo(img, p.recipe),
      lens: lensModel({ width: img.width, height: img.height, profile: img.lens, caEstimate: img.analysis.ca }, p.recipe.lens),
      pxScale: Math.max(1e-6, Math.hypot(p.view[0], p.view[3])),
      longEdge: Math.max(img.width, img.height),
      mapScale: p.draftMaps ? 0.5 : 1,
    };
  }

  /**
   * Summed reach (target pixels) of the spatial stages: the padding intermediate passes need.
   * A multiple of 4, so downsampled helper grids stay aligned with output pixels across tiles.
   */
  padding(ctx: StageContext, stages: Stage[]): number {
    let r = 0;
    for (const s of stages) if (s.kind === 'spatial') r += s.reach?.(ctx) ?? 0;
    return Math.ceil((r + 2) / 4) * 4;
  }

  private resources(maps: Map<string, Record<string, WebGLTexture>>): StageResources {
    return {
      curves: this.curves,
      luts: this.luts,
      map: (id) => maps.get(id) ?? null,
      grain: () => this.grainTex(),
      gainMap: (g) => this.gainMapTex(g),
      aiMask: (k) => this.masks.get(k),
      dummy: this.dummyTex(),
    };
  }

  private intermediate(w: number, h: number): RenderTargetTex[] {
    const key = `${w}x${h}`;
    let e = this.pingPong.get(key);
    if (!e) {
      // A few sizes alive (viewer, map renders, readouts); drop the least recently used.
      if (this.pingPong.size >= 6) {
        const [oldKey, old] = [...this.pingPong.entries()].reduce((a, b) => (a[1].used <= b[1].used ? a : b));
        old.rts.forEach((t) => deleteRenderTarget(this.gl, t));
        this.pingPong.delete(oldKey);
      }
      this.gl.activeTexture(this.gl.TEXTURE0 + 15);
      const f = this.fmt === 'rgba32f' ? this.gl.RGBA32F : this.gl.RGBA16F;
      e = { rts: [0, 1].map(() => createRenderTarget(this.gl, w, h, f, 1, false)), used: 0 };
      this.pingPong.set(key, e);
    }
    e.used = ++this.tick;
    return e.rts;
  }

  /** Kept state of pass `i` in a cache slot: its output and its spatial helper results. */
  private slotState(slot: string, i: number): SlotPass {
    let list = this.cacheSlots.get(slot);
    if (!list) { list = []; this.cacheSlots.set(slot, list); }
    return (list[i] ??= { key: '', rt: null, prepKey: '', aux: null });
  }

  private slotOutput(e: SlotPass, w: number, h: number): RenderTargetTex {
    if (!e.rt || e.rt.width !== w || e.rt.height !== h) {
      deleteRenderTarget(this.gl, e.rt);
      this.gl.activeTexture(this.gl.TEXTURE0 + 15);
      e.rt = createRenderTarget(this.gl, w, h, this.fmt === 'rgba32f' ? this.gl.RGBA32F : this.gl.RGBA16F, 1, false);
      e.key = '';
    }
    return e.rt;
  }

  /** Drop the intermediate results kept for a cache slot (e.g. when the image changes). */
  dropCache(slot?: string) {
    for (const [k, list] of this.cacheSlots) {
      if (slot && k !== slot) continue;
      list.forEach((e) => e && deleteRenderTarget(this.gl, e.rt));
      this.kit.release(`slot:${k}:`);
      this.cacheSlots.delete(k);
    }
  }

  private shaderIds = new Map<string, number>();
  private shaderId(src: string) {
    let id = this.shaderIds.get(src);
    if (!id) { id = this.shaderIds.size + 1; this.shaderIds.set(src, id); }
    return id;
  }

  private texturesKey(t: StageTextures): string {
    return Object.entries(t).map(([k, v]) => `${k}=${texKey('is3d' in v ? v.tex : v)}`).join(',');
  }

  private depth = 0;

  render(p: RenderParams) {
    if (this.depth === 0) this.kit.sweep();
    this.depth++;
    try {
      this.renderPasses(p);
    } finally {
      this.depth--;
    }
  }

  private renderPasses(p: RenderParams) {
    const gl = this.gl;
    const ctx = this.context(p);
    const stages = this.activeStages(ctx, p.until, p.forMap);
    // Image-wide maps must exist before the main passes bind them.
    const maps = this.ensureMaps(p, ctx, stages);
    const res = this.resources(maps);
    const passes = this.splitPasses(stages);
    const pad = passes.length > 1 ? this.padding(ctx, stages) : 0;
    const W2 = p.width + 2 * pad, H2 = p.height + 2 * pad;
    const viewI = pad ? mul(p.view, translate(-pad, -pad)) : p.view;
    const origin = p.origin ?? [0, 0];
    const bg = p.background ?? [0, 0, 0, 1];
    const pp = passes.length > 1 && !p.cache ? this.intermediate(W2, H2) : null;
    let prev: RenderTargetTex | null = null;
    // Cache key chain: everything that determines the output of the passes so far.
    let chain = p.cache
      ? `${texKey(p.source.tex)}|${JSON.stringify(p.source.region)}|${p.lod ?? 0}|${toGL(viewI).join(',')}|${W2}x${H2}`
      : '';

    passes.forEach((pass, pi) => {
      const first = pi === 0;
      const last = pi === passes.length - 1;
      const src = this.shaderFor(pass, first);
      // Resolve every stage texture first: building one (curve / LUT upload) binds textures, which
      // must not happen between binding the inputs and drawing.
      const stageTex = pass.stages.map((s) => (s.textures ? s.textures(ctx, res) : {}));
      const stageUni = pass.stages.map((s) => s.uniforms(ctx));
      const before = chain;
      const slot = p.cache ? this.slotState(p.cache, pi) : null;
      let out: RenderTargetTex | null = null;
      if (slot) chain += `#${this.shaderId(src)}:${JSON.stringify(stageUni)}:${stageTex.map((t) => this.texturesKey(t)).join(';')}`;
      if (!last) {
        if (slot) {
          out = this.slotOutput(slot, W2, H2);
          if (slot.key === chain) { prev = out; return; }
          slot.key = '';
        } else out = pp![pi % 2];
      }
      // Spatial helper passes read the previous result and produce extra samplers for this pass.
      // In a cache slot they are kept too: a change further down the pass does not re-run them.
      let aux: StageTextures = {};
      const head = pass.stages[0];
      if (!first && head.prepare) {
        const prepIn = head.prepKey ? head.prepKey(ctx) : JSON.stringify(stageUni[0]);
        const prepKey = slot ? `${before}#prep:${head.id}:${prepIn}:${this.texturesKey(stageTex[0])}` : '';
        if (slot && slot.aux && slot.prepKey === prepKey) aux = slot.aux;
        else {
          const kit = p.cache ? this.kit.scoped(`slot:${p.cache}:${pi}:`) : this.kit;
          aux = head.prepare(ctx, { tex: prev!.tex, width: W2, height: H2, view: viewI }, kit, res);
          if (slot) { slot.prepKey = prepKey; slot.aux = aux; }
        }
      }
      if (slot && !last) slot.key = chain;
      const prog = this.programs.get(src);
      gl.useProgram(prog.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, last ? p.framebuffer : out!.fbo);
      if (last) gl.viewport(origin[0], origin[1], p.width, p.height);
      else gl.viewport(0, 0, W2, H2);
      if (last && p.scissor) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(...p.scissor);
      }
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.vao);
      gl.uniformMatrix3fv(prog.loc('u_view'), false, toGL(last ? p.view : viewI));
      gl.uniform2f(prog.loc('u_fullSize'), ctx.geo.outW, ctx.geo.outH);
      gl.uniform2f(prog.loc('u_srcSize'), p.image.width, p.image.height);
      gl.uniform2f(prog.loc('u_origin'), last ? origin[0] : 0, last ? origin[1] : 0);
      gl.uniform1f(prog.loc('u_prevOffset'), last ? pad : 0);
      gl.uniform1i(prog.loc('u_final'), last ? 1 : 0);
      gl.uniform4f(prog.loc('u_bg'), bg[0], bg[1], bg[2], bg[3]);

      let unit = 0;
      const bindTex = (name: string, t: WebGLTexture | { tex: WebGLTexture; is3d: true }) => {
        const loc = prog.loc(name);
        if (!loc) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        if ('is3d' in t) gl.bindTexture(gl.TEXTURE_3D, t.tex);
        else gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(loc, unit);
        unit++;
      };
      if (first) {
        bindTex('input_tex', p.source.tex);
        const r = p.source.region;
        gl.uniform4f(prog.loc('input_region'), r.x, r.y, r.w, r.h);
        gl.uniform1f(prog.loc('input_lod'), p.source.mipmapped ? p.lod ?? 0 : 0);
      } else {
        bindTex('u_prev', prev!.tex);
      }
      pass.stages.forEach((_s, si) => {
        for (const [name, v] of Object.entries(stageUni[si])) setUniform(gl, prog.loc(name), v as Uniform);
        for (const [name, tex] of Object.entries(stageTex[si])) bindTex(name, tex);
      });
      for (const [name, tex] of Object.entries(aux)) bindTex(name, tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (last && p.scissor) gl.disable(gl.SCISSOR_TEST);
      // Uncached renders: this pass's helper targets are consumed; later passes may reuse them.
      if (!p.cache && this.depth === 1) this.kit.recycle();
      prev = out;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // -------------------------------------------------------------------------
  // Image-wide maps
  // -------------------------------------------------------------------------

  /** Render parameters of a map: the whole output frame at the map's texel density. */
  private mapParams(p: RenderParams, ctx: StageContext, spec: MapSpec): RenderParams & { w: number; h: number } {
    const src = p.mapSource ?? p.source;
    const { w, h } = mapDims(ctx, spec.edge * (spec.draftable ? ctx.mapScale : 1));
    const sx = ctx.geo.outW / w, sy = ctx.geo.outH / h;
    return {
      ...p,
      source: src,
      mapSource: src,
      target: LINEAR_TARGET,
      view: [sx, 0, 0, 0, sy, 0, 0, 0, 1],
      width: w,
      height: h,
      w,
      h,
      framebuffer: null,
      until: spec.until,
      lod: src.mipmapped ? Math.max(0, Math.log2(src.scale * sx)) : 0,
      cache: undefined,
      origin: undefined,
      scissor: undefined,
      forMap: true,
    };
  }

  private srcId(tex: WebGLTexture) {
    return texKey(tex);
  }

  /** Cache key of a map: its parameters plus every upstream stage's uniforms and textures. */
  private mapKey(p: RenderParams, ctx: StageContext, spec: MapSpec): string {
    const mp = this.mapParams(p, ctx, spec);
    const mctx = this.context(mp);
    const parts = [spec.id, this.srcId(mp.source.tex), `${mp.w}x${mp.h}`, spec.key];
    const keyRes = this.resources(new Map());
    for (const s of this.activeStages(mctx, spec.until, true)) {
      parts.push(s.id, JSON.stringify(s.uniforms(mctx)));
      for (const sub of s.maps?.(mctx) ?? []) parts.push(this.mapKey(mp, mctx, sub));
      if (s.textures && !s.maps) parts.push(this.texturesKey(s.textures(mctx, keyRes)));
    }
    return parts.join('|');
  }

  private ensureMaps(p: RenderParams, ctx: StageContext, stages: Stage[]): Map<string, Record<string, WebGLTexture>> {
    const out = new Map<string, Record<string, WebGLTexture>>();
    for (const s of stages) for (const spec of s.maps?.(ctx) ?? []) out.set(spec.id, this.ensureMap(p, ctx, spec));
    return out;
  }

  private ensureMap(p: RenderParams, ctx: StageContext, spec: MapSpec): Record<string, WebGLTexture> {
    const key = this.mapKey(p, ctx, spec);
    let list = this.maps.get(spec.id);
    if (!list) { list = []; this.maps.set(spec.id, list); }
    const hit = list.find((e) => e.key === key);
    if (hit) { hit.used = ++this.tick; return hit.tex; }
    // Two slots per map: compare views (before / after) don't rebuild every frame.
    const slot = list.length < 2 ? list.length : list.indexOf(list.reduce((a, b) => (a.used <= b.used ? a : b)));
    const mp = this.mapParams(p, ctx, spec);
    const kit = this.kit.scoped(`map:${spec.id}:${slot}:`);
    const rt = kit.rt('src', mp.w, mp.h, 'rgba16f');
    this.render({ ...mp, framebuffer: rt.fbo });
    const tex = spec.build(kit, rt, this.context(mp));
    kit.releaseStale(); // targets of the slot's previous map at another size
    const entry: MapEntry = { key, tex, used: ++this.tick };
    if (slot < list.length) list[slot] = entry; else list.push(entry);
    return tex;
  }

  // -------------------------------------------------------------------------
  // Shared textures
  // -------------------------------------------------------------------------

  private dummy: WebGLTexture | null = null;
  private dummyTex(): WebGLTexture {
    if (this.dummy) return this.dummy;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15);
    this.dummy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 1, 1);
    return this.dummy;
  }

  private grain: WebGLTexture | null = null;
  private grainTex(): WebGLTexture {
    if (this.grain) return this.grain;
    const gl = this.gl;
    const g = grainTexture();
    gl.activeTexture(gl.TEXTURE0 + 15);
    const levels = Math.log2(g.size) + 1;
    const tex = createTexture(gl, g.size, g.size, gl.RGBA16F, { linear: true, levels });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, g.size, g.size, gl.RGBA, gl.FLOAT, g.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.grain = tex;
    return tex;
  }

  private gainTex = new WeakMap<object, WebGLTexture>();
  private gainMapTex(g: NonNullable<ImageModel['lens']>['gainMap'] & object): WebGLTexture {
    const hit = this.gainTex.get(g);
    if (hit) return hit;
    const gl = this.gl;
    const n = g.pointsV * g.pointsH;
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = g.data[i * g.planes + (g.planes === 3 ? c : 0)];
      rgba[i * 4 + 3] = 1;
    }
    gl.activeTexture(gl.TEXTURE0 + 15);
    const tex = createTexture(gl, g.pointsH, g.pointsV, gl.RGBA16F, { linear: true });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, g.pointsH, g.pointsV, gl.RGBA, gl.FLOAT, rgba);
    this.gainTex.set(g, tex);
    return tex;
  }

  // -------------------------------------------------------------------------
  // Shader readiness
  // -------------------------------------------------------------------------

  private collectPrograms(p: Pick<RenderParams, 'image' | 'recipe' | 'target' | 'source' | 'until' | 'view' | 'mapSource' | 'forMap'>, out: Set<string>) {
    const ctx = this.context(p);
    const stages = this.activeStages(ctx, p.until, p.forMap);
    this.splitPasses(stages).forEach((pass, i) => out.add(this.shaderFor(pass, i === 0)));
    for (const s of stages) {
      s.helpers?.forEach((h) => out.add(h));
      for (const spec of s.maps?.(ctx) ?? []) {
        spec.helpers.forEach((h) => out.add(h));
        this.collectPrograms(this.mapParams(p as RenderParams, ctx, spec), out);
      }
    }
  }

  /** Whether render(p) can run without waiting for the shader compiler (starts compiles if not). */
  isReady(p: Pick<RenderParams, 'image' | 'recipe' | 'target' | 'source' | 'until'> & { view?: Mat3 }): boolean {
    const set = new Set<string>(KIT_HELPERS);
    this.collectPrograms({ ...p, view: p.view ?? [1, 0, 0, 0, 1, 0, 0, 0, 1] }, set);
    let ready = true;
    for (const src of set) {
      this.programs.prefetch(src);
      if (!this.programs.isReady(src)) ready = false;
    }
    return ready;
  }

  /**
   * Start compiling the programs for a set of recipes in the background, so neither the first
   * frame nor the first slider move waits on the shader compiler.
   */
  prefetch(params: Pick<RenderParams, 'image' | 'target' | 'source' | 'until'>, recipes: Recipe[]) {
    for (const recipe of recipes) {
      const set = new Set<string>();
      this.collectPrograms({ ...params, recipe, view: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, set);
      set.forEach((s) => this.programs.prefetch(s));
    }
  }

  /** Samplers declared by a generated program (debugging aid). */
  static samplersOf(src: string) {
    return declaredSamplers(src);
  }

  dispose() {
    this.programs.dispose();
    this.curves.dispose();
    this.luts.dispose();
    this.masks.dispose();
    this.kit.dispose();
    if (this.dummy) this.gl.deleteTexture(this.dummy);
    if (this.grain) this.gl.deleteTexture(this.grain);
    for (const e of this.pingPong.values()) e.rts.forEach((t) => deleteRenderTarget(this.gl, t));
    this.pingPong.clear();
    this.dropCache();
    this.gl.deleteVertexArray(this.vao);
  }
}
