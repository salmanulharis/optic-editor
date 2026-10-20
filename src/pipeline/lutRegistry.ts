/**
 * In-memory registry of loaded 3D LUTs, keyed by id. The recipe only stores the id; the UI fills
 * the registry from IndexedDB / bundled files, and the export worker receives the LUTs it needs
 * with the render job. DOM-free so it works in workers.
 */
import type { LutData } from '../io/lut/lut';

const luts = new Map<string, LutData>();
const listeners = new Set<() => void>();

export const lutRegistry = {
  get: (id: string | null | undefined) => (id ? luts.get(id) : undefined),
  has: (id: string | null | undefined) => !!id && luts.has(id),
  all: () => [...luts.values()],
  set(l: LutData) {
    luts.set(l.id, l);
    listeners.forEach((f) => f());
  },
  delete(id: string) {
    luts.delete(id);
    listeners.forEach((f) => f());
  },
  subscribe(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

/** GPU textures for registry LUTs (3D RGB32F, read with texelFetch). */
export class LutTextureCache {
  private cache = new Map<string, { data: Float32Array; tex: WebGLTexture }>();
  constructor(private gl: WebGL2RenderingContext) {}

  get(id: string): WebGLTexture | null {
    const l = lutRegistry.get(id);
    if (!l) return null;
    const hit = this.cache.get(id);
    if (hit && hit.data === l.data) return hit.tex;
    if (hit) this.gl.deleteTexture(hit.tex);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15); // upload unit: never disturbs bindings used for drawing
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, l.size, l.size, l.size, 0, gl.RGB, gl.FLOAT, l.data);
    this.cache.set(id, { data: l.data, tex });
    return tex;
  }

  dispose() {
    for (const v of this.cache.values()) this.gl.deleteTexture(v.tex);
    this.cache.clear();
  }
}
