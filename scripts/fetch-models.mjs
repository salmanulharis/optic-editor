#!/usr/bin/env node
/**
 * Downloads the on-device AI models into public/models so a deployment serves them itself
 * (same origin, no third-party request at first use). Optional: without them Optic downloads each
 * model from its public mirror on first use. Licences: see LICENSES.md.
 *   npm run models:fetch            all models
 *   npm run models:fetch -- u2netp  only some
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODELS = {
  u2netp: ['u2netp.onnx', 'https://huggingface.co/edgetools/u2netp/resolve/main/u2netp.onnx', 4_574_861],
  skyseg: ['skyseg.onnx', 'https://huggingface.co/JianyuanWang/skyseg/resolve/main/skyseg.onnx', 175_997_079],
  selfieMulticlass: ['selfie_multiclass_256x256.tflite', 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite', 16_371_837],
  faceLandmarker: ['face_landmarker.task', 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task', 3_758_596],
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODELS);
mkdirSync('public/models', { recursive: true });
for (const id of want) {
  const m = MODELS[id];
  if (!m) { console.error(`Unknown model ${id}. Known: ${Object.keys(MODELS).join(', ')}`); process.exit(1); }
  const [file, url, bytes] = m;
  const dest = `public/models/${file}`;
  if (existsSync(dest) && statSync(dest).size === bytes) { console.log(`✓ ${file} (already there)`); continue; }
  process.stdout.write(`↓ ${file} (${(bytes / 1e6).toFixed(1)} MB)… `);
  const res = await fetch(url);
  if (!res.ok || !res.body) { console.error(`failed: HTTP ${res.status}`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log('done');
}
