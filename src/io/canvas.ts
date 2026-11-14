/**
 * Canvases that work everywhere Optic runs: OffscreenCanvas where it exists (workers and modern
 * main threads), else a regular <canvas> on the main thread (browsers without OffscreenCanvas,
 * e.g. Safari before 16.4). In a worker without OffscreenCanvas there is no canvas at all: callers
 * get a clear error and fall back to the main thread.
 */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export const hasOffscreenCanvas = () => typeof OffscreenCanvas !== 'undefined';

export function createCanvas(width: number, height: number): AnyCanvas {
  if (hasOffscreenCanvas()) return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('No canvas available here (OffscreenCanvas is not supported in this browser’s workers)');
}

export function context2d(c: AnyCanvas, opts?: CanvasRenderingContext2DSettings): AnyContext2D {
  const ctx = (c as HTMLCanvasElement).getContext('2d', opts) as AnyContext2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** Encode a canvas (convertToBlob or toBlob). Callers check `type`: some browsers fall back to PNG. */
export function canvasToBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), type, quality));
}

/** WebGL 2 with float render targets on this kind of canvas (the renderer's requirement). */
export function canRenderWebGL2(): boolean {
  try {
    if (!hasOffscreenCanvas() && typeof document === 'undefined') return false;
    const c = createCanvas(1, 1);
    const gl = (c as HTMLCanvasElement).getContext('webgl2') as WebGL2RenderingContext | null;
    const ok = !!gl && !!gl.getExtension('EXT_color_buffer_float');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}
