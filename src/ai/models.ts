/**
 * The on-device AI models: where they come from, their size and licence. Models are downloaded on
 * first use only: from this site (`/models/<file>`, filled by `npm run models:fetch` for
 * self-contained deployments) or from the public mirror below, then kept in Cache Storage so masks
 * work offline. Images never leave the device; only the model files are downloaded.
 */

export type ModelId = 'u2netp' | 'skyseg' | 'selfieMulticlass' | 'faceLandmarker';

export interface ModelInfo {
  id: ModelId;
  name: string;
  file: string;
  url: string;
  bytes: number;
  license: string;
  source: string;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  u2netp: {
    id: 'u2netp',
    name: 'U²-Net (small) salient object segmentation',
    file: 'u2netp.onnx',
    url: 'https://huggingface.co/edgetools/u2netp/resolve/main/u2netp.onnx',
    bytes: 4_574_861,
    license: 'Apache-2.0',
    source: 'https://github.com/xuebinqin/U-2-Net',
  },
  skyseg: {
    id: 'skyseg',
    name: 'Sky segmentation (U²-Net)',
    file: 'skyseg.onnx',
    url: 'https://huggingface.co/JianyuanWang/skyseg/resolve/main/skyseg.onnx',
    bytes: 175_997_079,
    license: 'MIT',
    source: 'https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing',
  },
  selfieMulticlass: {
    id: 'selfieMulticlass',
    name: 'MediaPipe selfie multiclass segmenter (256×256)',
    file: 'selfie_multiclass_256x256.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    bytes: 16_371_837,
    license: 'Apache-2.0',
    source: 'https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter',
  },
  faceLandmarker: {
    id: 'faceLandmarker',
    name: 'MediaPipe face landmarker',
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
    bytes: 3_758_596,
    license: 'Apache-2.0',
    source: 'https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker',
  },
};

export const MODEL_CACHE = 'optic-models-v1';

async function cached(file: string): Promise<Uint8Array | null> {
  try {
    const c = await caches.open(MODEL_CACHE);
    const r = await c.match(`/models/${file}`);
    return r ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function download(url: string, total: number, onProgress: (f: number) => void): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
  // A dev server answers unknown paths with index.html: that is not a model.
  if ((res.headers.get('content-type') ?? '').includes('text/html')) return null;
  const size = Number(res.headers.get('content-length')) || total;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(0.99, got / size));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The model's bytes: Cache Storage, else this site, else the public mirror (then cached). */
export async function fetchModel(id: ModelId, onProgress: (f: number) => void = () => {}): Promise<Uint8Array> {
  const m = MODELS[id];
  const hit = await cached(m.file);
  if (hit) { onProgress(1); return hit; }
  const bytes = (await download(`/models/${m.file}`, m.bytes, onProgress)) ?? (await download(m.url, m.bytes, onProgress));
  if (!bytes) throw new Error(`Could not download the ${m.name} model (${Math.round(m.bytes / 1e6)} MB). Check the connection and try again.`);
  try {
    const c = await caches.open(MODEL_CACHE);
    await c.put(`/models/${m.file}`, new Response(bytes as BlobPart, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch (e) {
    console.warn('[optic] model not cached for offline use', e);
  }
  onProgress(1);
  return bytes;
}

/** Which models are already available offline. */
export async function cachedModels(): Promise<ModelId[]> {
  const out: ModelId[] = [];
  try {
    const c = await caches.open(MODEL_CACHE);
    for (const m of Object.values(MODELS)) if (await c.match(`/models/${m.file}`)) out.push(m.id);
  } catch { /* no Cache Storage */ }
  return out;
}
