/**
 * MediaPipe Tasks (person parts): the selfie multiclass segmenter (background, hair, body skin,
 * face skin, clothes, other) and the face landmarker, whose eye and lip contours are rasterised
 * into soft masks. Runs on the main thread with the CPU delegate (small models, a few tens of ms);
 * the WASM runtime is served from /vendor/mediapipe (same origin, cached for offline use).
 */
import { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

type WasmFileset = Parameters<typeof ImageSegmenter.createFromOptions>[0];
import { fetchModel } from './models';

type Progress = (f: number, label: string) => void;
interface Rgba { data: Uint8ClampedArray; width: number; height: number }

const FILESET: WasmFileset = {
  wasmLoaderPath: '/vendor/mediapipe/vision_wasm_internal.js',
  wasmBinaryPath: '/vendor/mediapipe/vision_wasm_internal.wasm',
};

let segmenter: Promise<ImageSegmenter> | null = null;
let landmarker: Promise<FaceLandmarker> | null = null;

/**
 * MediaPipe's WASM logs glog-style INFO / warning lines through console.error: keep them out of
 * the console (real errors still throw).
 */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const err = console.error, warn = console.warn;
  const drop = (orig: typeof console.error) => (...a: unknown[]) => {
    const s = String(a[0] ?? '');
    if (/^(INFO|W\d{4}|I\d{4})/.test(s) || s.includes('XNNPACK') || s.includes('Feedback manager')) return;
    orig(...a);
  };
  console.error = drop(err);
  console.warn = drop(warn);
  try {
    return await fn();
  } finally {
    console.error = err;
    console.warn = warn;
  }
}

const imageData = (i: Rgba) => new ImageData(i.data as unknown as Uint8ClampedArray<ArrayBuffer>, i.width, i.height);

export async function segmentPerson(input: Rgba, progress: Progress): Promise<{ width: number; height: number; classes: Float32Array[] }> {
  segmenter ??= (async () => {
    const bytes = await fetchModel('selfieMulticlass', (f) => progress(f * 0.9, `Downloading person model (${Math.round(f * 100)}%)`));
    progress(0.95, 'Preparing model');
    return quiet(() => ImageSegmenter.createFromOptions(FILESET, {
      baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }));
  })().catch((e) => { segmenter = null; throw e; });
  const s = await segmenter;
  progress(1, 'Finding people');
  const res = await quiet(() => s.segment(imageData(input)));
  try {
    const masks = res.confidenceMasks ?? [];
    if (masks.length < 6) throw new Error('Unexpected person model output');
    return { width: masks[0].width, height: masks[0].height, classes: masks.map((m) => m.getAsFloat32Array().slice()) };
  } finally {
    res.close();
  }
}

// Ordered contours of the 478-point face mesh.
const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

export async function faceParts(input: Rgba, progress: Progress): Promise<{ eyes: Uint8Array; lips: Uint8Array }> {
  landmarker ??= (async () => {
    const bytes = await fetchModel('faceLandmarker', (f) => progress(f * 0.9, `Downloading face model (${Math.round(f * 100)}%)`));
    return quiet(() => FaceLandmarker.createFromOptions(FILESET, {
      baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 8,
    }));
  })().catch((e) => { landmarker = null; throw e; });
  const f = await landmarker;
  progress(1, 'Finding faces');
  const res = await quiet(() => f.detect(imageData(input)));
  const W = input.width, H = input.height;
  const draw = (fill: (ctx: OffscreenCanvasRenderingContext2D, pt: (i: number) => [number, number], scale: number) => void) => {
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    for (const lm of res.faceLandmarks) {
      const pt = (i: number): [number, number] => [lm[i].x * W, lm[i].y * H];
      // Face width (outer eye corners) sets the feather.
      const scale = Math.hypot(pt(33)[0] - pt(263)[0], pt(33)[1] - pt(263)[1]);
      fill(ctx, pt, scale);
    }
    const d = ctx.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
    return out;
  };
  const poly = (ctx: OffscreenCanvasRenderingContext2D, pt: (i: number) => [number, number], idx: number[]) => {
    ctx.beginPath();
    idx.forEach((i, k) => (k ? ctx.lineTo(...pt(i)) : ctx.moveTo(...pt(i))));
    ctx.closePath();
    ctx.fill();
  };
  const eyes = draw((ctx, pt, scale) => {
    ctx.filter = `blur(${Math.max(0.5, scale * 0.015)}px)`;
    ctx.fillStyle = '#fff';
    poly(ctx, pt, RIGHT_EYE);
    poly(ctx, pt, LEFT_EYE);
  });
  const lips = draw((ctx, pt, scale) => {
    ctx.filter = `blur(${Math.max(0.5, scale * 0.02)}px)`;
    ctx.fillStyle = '#fff';
    poly(ctx, pt, LIPS_OUTER);
    ctx.globalCompositeOperation = 'destination-out';
    poly(ctx, pt, LIPS_INNER);
    ctx.globalCompositeOperation = 'source-over';
  });
  return { eyes, lips };
}
