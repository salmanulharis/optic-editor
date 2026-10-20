/**
 * Tone-curve lookup textures: 4096 entries × RGBA where R = master (RGB) curve and G/B/A are the
 * red/green/blue channel curves. Cached by curve contents.
 */
import { bakeCurve } from '../../recipe/curve';
import type { Recipe } from '../../recipe/schema';
import { bumpTex } from './texture';

export const CURVE_LUT_SIZE = 4096;
/** Texture unit used only for uploads, so baking a LUT never disturbs bindings used for drawing. */
export const UPLOAD_UNIT = 15;

/** A few entries, so compare views with two different curves don't re-upload every frame. */
const SLOTS = 4;

export class CurveLutCache {
  private entries: Array<{ key: string; tex: WebGLTexture; used: number }> = [];
  private tick = 0;
  constructor(private gl: WebGL2RenderingContext, private floatLinear: boolean) {}

  get(curve: Recipe['curve']): WebGLTexture {
    const key = JSON.stringify([curve.rgb, curve.r, curve.g, curve.b]);
    const hit = this.entries.find((e) => e.key === key);
    if (hit) { hit.used = ++this.tick; return hit.tex; }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
    const data = new Float32Array(CURVE_LUT_SIZE * 4);
    bakeCurve(curve.rgb, CURVE_LUT_SIZE, data, 4, 0);
    bakeCurve(curve.r, CURVE_LUT_SIZE, data, 4, 1);
    bakeCurve(curve.g, CURVE_LUT_SIZE, data, 4, 2);
    bakeCurve(curve.b, CURVE_LUT_SIZE, data, 4, 3);
    let e: (typeof this.entries)[number];
    if (this.entries.length < SLOTS) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // 32F needs OES_texture_float_linear to be filterable; 16F is always filterable.
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.floatLinear ? gl.RGBA32F : gl.RGBA16F, CURVE_LUT_SIZE, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e = { key, tex, used: 0 };
      this.entries.push(e);
    } else {
      e = this.entries.reduce((a, b) => (a.used <= b.used ? a : b));
      e.key = key;
    }
    e.used = ++this.tick;
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CURVE_LUT_SIZE, 1, gl.RGBA, gl.FLOAT, data);
    bumpTex(e.tex);
    return e.tex;
  }

  dispose() {
    for (const e of this.entries) this.gl.deleteTexture(e.tex);
    this.entries = [];
  }
}
