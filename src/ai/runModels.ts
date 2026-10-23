/**
 * Runs the AI models for a photo and packs their output into a mask bitmap (RGBA8, ≈ 1024 px on the
 * long edge, in the undistorted source frame U; see recipe/masks.ts `aiChannelFor`):
 *  - subject: U²-Netp salient-object map (ONNX, worker)          R = subject
 *  - sky: U²-Net sky segmentation (ONNX, worker)                  R = sky
 *  - person: MediaPipe selfie multiclass                          R person, G hair, B face skin, A body skin
 *  - personParts: selfie multiclass + face landmarker polygons    R clothes, G eyes, B lips
 * The input is the photo with neutral settings (lens corrections on, no crop / transform), so the
 * bitmap stays valid whatever is edited later; the stage refines its edges at full resolution.
 */
import * as Comlink from 'comlink';
import { getRenderer } from '../app/actions';
import { IDENTITY_CROP, defaultRecipe, effectiveRecipe } from '../recipe/schema';
import type { AiModelId } from '../recipe/masks';
import { defaultRecipeFor, type LoadedImage } from '../state/imageStore';
import { useEdit } from '../state/editStore';
import type { AiWorkerApi } from './ai.worker';
import { fetchModel } from './models';

export const AI_EDGE = 1024;
const U2_SIZE = 320;

type Progress = (f: number, label: string) => void;
interface Rgba { data: Uint8ClampedArray; width: number; height: number }

/** The photo in the U frame at ≤ AI_EDGE px, sRGB 8-bit. */
function aiInput(img: LoadedImage): Rgba {
  const r = getRenderer();
  if (!r) throw new Error('The renderer is not ready');
  const base = defaultRecipeFor(img);
  const lens = useEdit.getState().recipe.lens;
  const rec = effectiveRecipe({ ...base, lens, geometry: defaultRecipe().geometry, crop: { ...IDENTITY_CROP } }, img.asShot);
  const res = r.renderSmall(rec, { mode: 'encoded', space: 'srgb', dither: false, clipOverlay: false }, AI_EDGE);
  if (!res) throw new Error('The photo is not ready yet');
  const data = new Uint8ClampedArray(res.width * res.height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 255 : res.data[i] * 255 + 0.5;
  return { data, width: res.width, height: res.height };
}

function resize(src: Rgba, w: number, h: number): Uint8Array {
  const a = new OffscreenCanvas(src.width, src.height);
  a.getContext('2d')!.putImageData(new ImageData(src.data as unknown as Uint8ClampedArray<ArrayBuffer>, src.width, src.height), 0, 0);
  const b = new OffscreenCanvas(w, h);
  const ctx = b.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(a, 0, 0, w, h);
  return new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
}

/** Class confidences are soft at every class boundary: firm them up so thin outlines vanish. */
const firm = (m: Float32Array) => m.map((v) => { const t = Math.min(1, Math.max(0, (v - 0.2) / 0.6)); return t * t * (3 - 2 * t); });

/** Bilinear resample of a single-channel float map into one channel of an RGBA8 bitmap. */
function putChannel(dst: Uint8Array, W: number, H: number, ch: number, src: Float32Array, sw: number, sh: number) {
  for (let y = 0; y < H; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / H - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / W - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const v = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
      dst[(y * W + x) * 4 + ch] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
}

let worker: Comlink.Remote<AiWorkerApi> | null = null;
function aiWorker() {
  worker ??= Comlink.wrap<AiWorkerApi>(new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }));
  return worker;
}

async function runU2(id: 'u2netp' | 'skyseg', input: Rgba, progress: Progress, subject: boolean): Promise<Float32Array> {
  const bytes = await fetchModel(id, (f) => progress(f * 0.9, `Downloading model (${Math.round(f * 100)}%)`));
  progress(0.92, 'Preparing model');
  const w = aiWorker();
  await w.load(id, Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]));
  progress(1, 'Analysing photo');
  const px = resize(input, U2_SIZE, U2_SIZE);
  return w.run(id, Comlink.transfer(px, [px.buffer as ArrayBuffer]), U2_SIZE, subject, subject);
}

export async function runAiModel(model: AiModelId, img: LoadedImage, progress: Progress): Promise<{ width: number; height: number; data: Uint8Array }> {
  const input = aiInput(img);
  const { width: W, height: H } = input;
  const out = new Uint8Array(W * H * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 0;
  if (model === 'subject' || model === 'sky') {
    const m = await runU2(model === 'subject' ? 'u2netp' : 'skyseg', input, progress, model === 'subject');
    putChannel(out, W, H, 0, m, U2_SIZE, U2_SIZE);
    return { width: W, height: H, data: out };
  }
  const { segmentPerson, faceParts } = await import('./mediapipe');
  const seg = await segmentPerson(input, progress);
  if (model === 'person') {
    // Person = everything that is not background.
    const person = new Float32Array(seg.width * seg.height);
    for (let i = 0; i < person.length; i++) person[i] = 1 - seg.classes[0][i];
    putChannel(out, W, H, 0, person, seg.width, seg.height);
    putChannel(out, W, H, 1, firm(seg.classes[1]), seg.width, seg.height);
    putChannel(out, W, H, 2, firm(seg.classes[3]), seg.width, seg.height);
    putChannel(out, W, H, 3, firm(seg.classes[2]), seg.width, seg.height);
    return { width: W, height: H, data: out };
  }
  putChannel(out, W, H, 0, firm(seg.classes[4]), seg.width, seg.height);
  const parts = await faceParts(input, progress);
  for (let i = 0; i < W * H; i++) { out[i * 4 + 1] = parts.eyes[i]; out[i * 4 + 2] = parts.lips[i]; }
  return { width: W, height: H, data: out };
}
