/** WebGL2 context setup and capability detection. */

export interface GLCaps {
  /** OES_texture_float_linear: RGBA32F textures can be linearly filtered. */
  floatLinear: boolean;
  maxTextureSize: number;
  /** Canvas drawing buffer is Display P3. */
  p3: boolean;
}

export function getCaps(gl: WebGL2RenderingContext): GLCaps {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('This browser/GPU cannot render to float textures (EXT_color_buffer_float missing).');
  }
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const anyGl = gl as WebGL2RenderingContext & { drawingBufferColorSpace?: string };
  return {
    floatLinear,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    p3: anyGl.drawingBufferColorSpace === 'display-p3',
  };
}

/** Create a WebGL2 context, asking for a Display P3 drawing buffer where supported. */
export function createContext(canvas: HTMLCanvasElement | OffscreenCanvas, wantP3: boolean): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('WebGL2 is not available.');
  const anyGl = gl as WebGL2RenderingContext & { drawingBufferColorSpace?: string; unpackColorSpace?: string };
  if (wantP3 && 'drawingBufferColorSpace' in gl) {
    try { anyGl.drawingBufferColorSpace = 'display-p3'; } catch { /* unsupported */ }
  }
  return gl;
}

/** Display supports wide gamut (P3) colours. */
export function displayIsP3(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(color-gamut: p3)').matches;
}
