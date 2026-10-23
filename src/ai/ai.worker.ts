/**
 * ONNX models (salient subject, sky) in a worker with ONNX Runtime Web (WASM, threaded when the
 * page is cross-origin isolated), so inference never blocks the UI. Input: an RGBA8 image already
 * resized to the model's input size. Output: the model's mask, normalised to 0…1.
 */
import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web/wasm';

ort.env.wasm.wasmPaths = '/vendor/ort/';
// Threaded WASM spawns nested workers, which stall inside this module worker: one thread is fast
// enough at 320 × 320.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const sessions = new Map<string, Promise<ort.InferenceSession>>();

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

const api = {
  async load(id: string, bytes: Uint8Array) {
    if (!sessions.has(id)) sessions.set(id, ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
    await sessions.get(id);
  },
  /**
   * U²-Net family: CHW float input normalised with ImageNet mean / std (for u2netp after scaling by
   * the image maximum, as rembg does), first output = saliency map. `stretch`: min–max normalise
   * the output (subject); otherwise it is the model's probability, clamped (sky: no sky = no mask).
   */
  async run(id: string, rgba: Uint8Array, size: number, maxNormalize: boolean, stretch: boolean): Promise<Float32Array> {
    const s = await sessions.get(id);
    if (!s) throw new Error(`Model ${id} not loaded`);
    const n = size * size;
    const x = new Float32Array(3 * n);
    let mx = 1;
    if (maxNormalize) { mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]); mx = Math.max(1, mx); }
    else mx = 255;
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) x[c * n + i] = (rgba[i * 4 + c] / mx - MEAN[c]) / STD[c];
    const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, size, size]) };
    const out = await s.run(feeds);
    const y = out[s.outputNames[0]].data as Float32Array;
    let lo = 0, hi = 1;
    if (stretch) {
      lo = Infinity; hi = -Infinity;
      for (let i = 0; i < n; i++) { lo = Math.min(lo, y[i]); hi = Math.max(hi, y[i]); }
    }
    const r = new Float32Array(n);
    const k = hi > lo ? 1 / (hi - lo) : 0;
    for (let i = 0; i < n; i++) r[i] = Math.min(1, Math.max(0, (y[i] - lo) * k));
    return Comlink.transfer(r, [r.buffer]);
  },
};

export type AiWorkerApi = typeof api;
Comlink.expose(api);
