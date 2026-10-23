/**
 * Image measurements off the main thread (noise model, lateral CA). The decoded image is in a
 * SharedArrayBuffer when the page is cross-origin isolated, so nothing is copied.
 */
import * as Comlink from 'comlink';
import { estimateNoise } from '../color/noiseEstimate';
import { estimateCA } from '../geometry/caEstimate';
import type { FloatImage } from '../io/decode/types';

const api = {
  noise: (img: FloatImage, gains: [number, number, number]) => estimateNoise(img, gains),
  ca: (img: FloatImage) => estimateCA(img),
};

export type AnalysisWorkerApi = typeof api;
Comlink.expose(api);
