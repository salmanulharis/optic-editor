import type { ColorSpaceId, Mat3 } from '../color/matrices';
import type { LensModel, LensProfile } from '../geometry/lens';
import type { Geo } from '../geometry/transform';
import type { ImageColor } from '../io/decode/types';
import type { Recipe } from '../recipe/schema';
import type { Derived } from './derive';
import type { CurveLutCache } from './gl/curveLut';
import type { GpuKit } from './gl/gpuKit';
import type { RenderTargetTex } from './gl/texture';
import type { LutTextureCache } from './lutRegistry';

export type Uniform =
  | { t: 'f'; v: number }
  | { t: 'i'; v: number }
  | { t: 'v2'; v: ArrayLike<number> }
  | { t: 'v3'; v: ArrayLike<number> }
  | { t: 'v4'; v: ArrayLike<number> }
  | { t: 'm3'; v: Mat3 }
  | { t: 'fa'; v: Float32Array } // float[]
  | { t: 'v2a'; v: Float32Array } // vec2[]
  | { t: 'v3a'; v: Float32Array } // vec3[]
  | { t: 'v4a'; v: Float32Array }; // vec4[]

export const u = {
  f: (v: number): Uniform => ({ t: 'f', v }),
  i: (v: number | boolean): Uniform => ({ t: 'i', v: +v }),
  v2: (...v: number[]): Uniform => ({ t: 'v2', v }),
  v3: (v: ArrayLike<number>): Uniform => ({ t: 'v3', v }),
  v4: (...v: number[]): Uniform => ({ t: 'v4', v }),
  m3: (v: Mat3): Uniform => ({ t: 'm3', v }),
};

/** Measurements made on the decoded image (asynchronously, after it is shown). */
export interface ImageAnalysis {
  /** Luminance noise model σ²(Y) = S·Y + O (linear, full resolution). */
  noise?: { S: number; O: number };
  /** Auto lateral-CA estimate: radial scale offsets of red and blue relative to green. */
  ca?: [number, number] | null;
}

/** What the pipeline needs to know about the loaded image (no pixels). */
export interface ImageModel {
  isRaw: boolean;
  bitDepth: number;
  color: ImageColor;
  width: number;
  height: number;
  /** Stable identity of the photo: seeds image-anchored patterns such as grain. */
  key: string;
  /** 35 mm-equivalent focal length (perspective model). */
  focal35?: number;
  /** Lens corrections from the file (DNG opcodes) or a matched lensfun profile. */
  lens?: LensProfile | null;
  analysis: ImageAnalysis;
}

export type OutputMode =
  /** Display-referred, encoded for a screen or file in `space`. */
  | 'encoded'
  /** Working-space linear values (analysis readbacks). */
  | 'linear';

export interface OutputTarget {
  mode: OutputMode;
  /** Gamut the image is mapped into (export space, or the preview's soft-proof space). */
  space: ColorSpaceId;
  /** Space of the physical destination (the canvas); defaults to `space`. */
  displaySpace?: ColorSpaceId;
  /** Add ±1 LSB triangular dither for 8-bit destinations. */
  dither: boolean;
  /** Highlight/shadow clipping overlay (preview only). */
  clipOverlay: boolean;
  /** Show the point-colour mask as grey (preview only). */
  visualizePointColor?: boolean;
  /** Show a detail mask in black and white (preview only, Alt + drag). */
  maskView?: 'sharpen';
}

export interface StageContext {
  recipe: Recipe;
  image: ImageModel;
  target: OutputTarget;
  derived: Derived;
  /** Texture pixels per full-resolution pixel of the current source texture. */
  sourceScale: number;
  /** Output geometry (crop, straighten, transform). */
  geo: Geo;
  /** Lens corrections in effect. */
  lens: LensModel;
  /** Full-resolution pixels per target pixel (1 at 100 % zoom and in export). */
  pxScale: number;
  /** Long edge of the source in full-resolution pixels: every spatial radius is a fraction of it. */
  longEdge: number;
  /** Density of draftable image-wide maps: 1, or 0.5 while a slider is dragged. */
  mapScale: number;
}

/** Sampler uniform name → 2D texture, or a 3D texture marked with is3d. */
export type StageTextures = Record<string, WebGLTexture | { tex: WebGLTexture; is3d: true }>;

export interface StageResources {
  curves: CurveLutCache;
  luts: LutTextureCache;
  /** Textures of an image-wide map declared by a stage's `maps` (null while unavailable). */
  map(id: string): Record<string, WebGLTexture> | null;
  /** Tileable, mipmapped film-grain noise. */
  grain(): WebGLTexture;
  /** Gain-map texture for a lens profile's gain map. */
  gainMap(g: NonNullable<LensProfile['gainMap']>): WebGLTexture;
  /**
   * A 1×1 texture for samplers a stage declares but does not need this frame. Sampler uniforms
   * keep their last unit per program, which may by now hold the render target (feedback loop =
   * rejected draw), so every declared sampler must always be bound to something.
   */
  dummy: WebGLTexture;
}

/** The previous pass's output, handed to a spatial stage's `prepare`. */
export interface PassInput {
  tex: WebGLTexture;
  /** Size of the (padded) intermediate frame. */
  width: number;
  height: number;
}

/**
 * An image-wide map: the pipeline up to `until`, rendered over the whole output frame from the
 * preview proxy at `edge` texels per source long edge, then post-processed by `build`. The preview,
 * every export tile and every analysis render use the same map, so large-radius effects match
 * exactly and tiles have no seams. Cached on the upstream state.
 */
export interface MapSpec {
  id: string;
  until: string;
  edge: number;
  /** Build parameters (cache key, beyond the upstream image). */
  key: string;
  helpers: string[];
  /**
   * The map may be built at a lower density while a slider is dragged (draft). Its build must then
   * derive every size from the map context (`ctx.pxScale`), not from `edge`.
   */
  draftable?: boolean;
  /** `ctx` is the map render's context: ctx.pxScale = source pixels per map texel. */
  build(kit: GpuKit, src: RenderTargetTex, ctx: StageContext): Record<string, WebGLTexture>;
}

/**
 * One step of the colour pipeline. Stages are pure: everything they need comes from the context.
 *  - `source`: the first stage; defines `vec4 <id>_sample(vec2 px)` reading the image texture.
 *  - `warp`: compiled into the first pass with the source; supplies the output → source mapping.
 *  - `point`: per-pixel; defines `vec4 <id>_apply(vec4 c)`. Consecutive point stages are fused
 *    into one shader pass.
 *  - `spatial`: needs neighbouring pixels of the previous result; defines
 *    `vec4 <id>_apply(sampler2D prev, ivec2 fc)` and forces a new (ping-pong) pass. It may run
 *    helper passes first (`prepare`) and must say how far it reads (`reach`, target pixels).
 * The alpha channel carries the source clipping mask (0…1) between stages.
 */
export interface Stage {
  id: string;
  label: string;
  kind: 'source' | 'warp' | 'point' | 'spatial';
  glsl: string;
  /** False when the stage's parameters are at their identity → stage is not compiled in. */
  active(ctx: StageContext): boolean;
  uniforms(ctx: StageContext): Record<string, Uniform>;
  /** Sampler uniforms → textures. */
  textures?(ctx: StageContext, res: StageResources): StageTextures;
  /** Spatial stages: helper passes over the previous pass's output; returns extra samplers. */
  prepare?(ctx: StageContext, input: PassInput, kit: GpuKit, res: StageResources): StageTextures;
  /** Spatial stages: how far the stage reads around a pixel, in target pixels. */
  reach?(ctx: StageContext): number;
  /** Image-wide maps the stage samples. */
  maps?(ctx: StageContext): MapSpec[];
  /**
   * Leave the stage out of the renders that build image-wide maps. For fine-detail stages (noise
   * reduction, texture) whose effect is invisible at map resolution; maps stay identical in the
   * preview and export either way.
   */
  skipInMaps?: boolean;
  /** Helper fragment shaders `prepare` uses (compiled ahead of time). */
  helpers?: string[];
}
