/**
 * In-memory registry of AI mask bitmaps, keyed by the `cacheKey` a mask component stores
 * (photo key + model). Bitmaps are RGBA8 in the undistorted source frame U, row 0 at the top,
 * about 1024 px on the long edge. The UI fills the registry from the catalog (or by running the
 * model); the export worker receives the bitmaps it needs with the job. DOM-free.
 */

export interface MaskBitmap {
  key: string;
  width: number;
  height: number;
  /** RGBA8, one mask per channel (see masks.ts `aiChannelFor`). */
  data: Uint8Array;
}

const bitmaps = new Map<string, MaskBitmap>();
const listeners = new Set<() => void>();

export const maskRegistry = {
  get: (key: string | null | undefined) => (key ? bitmaps.get(key) : undefined),
  has: (key: string | null | undefined) => !!key && bitmaps.has(key),
  all: () => [...bitmaps.values()],
  set(b: MaskBitmap) {
    bitmaps.set(b.key, b);
    listeners.forEach((f) => f());
  },
  delete(key: string) {
    if (bitmaps.delete(key)) listeners.forEach((f) => f());
  },
  /** Drop every bitmap whose key does not start with `keep` (memory: only the open photo's). */
  retainOnly(prefix: string) {
    for (const k of [...bitmaps.keys()]) if (!k.startsWith(prefix)) bitmaps.delete(k);
  },
  subscribe(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

/** GPU textures for registry bitmaps (RGBA8, bilinear). */
export class MaskTextureCache {
  private cache = new Map<string, { data: Uint8Array; tex: WebGLTexture }>();
  constructor(private gl: WebGL2RenderingContext) {}

  get(key: string): WebGLTexture | null {
    const b = maskRegistry.get(key);
    if (!b) return null;
    const hit = this.cache.get(key);
    if (hit && hit.data === b.data) return hit.tex;
    if (hit) this.gl.deleteTexture(hit.tex);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15); // upload unit: never disturbs bindings used for drawing
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, b.width, b.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, b.data);
    this.cache.set(key, { data: b.data, tex });
    return tex;
  }

  /** Texture identity for cache keys (changes when the bitmap is replaced). */
  version(key: string): string {
    const b = maskRegistry.get(key);
    return b ? `${key}:${b.width}x${b.height}:${b.data.length}:${versionOf(b.data)}` : `${key}:none`;
  }

  dispose() {
    for (const v of this.cache.values()) this.gl.deleteTexture(v.tex);
    this.cache.clear();
  }
}

const versions = new WeakMap<Uint8Array, number>();
let nextVersion = 1;
function versionOf(d: Uint8Array) {
  let v = versions.get(d);
  if (!v) { v = nextVersion++; versions.set(d, v); }
  return v;
}
