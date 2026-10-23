/** Shared worker clients for image analysis and import work (created on first use). */
import * as Comlink from 'comlink';
import type { AnalysisWorkerApi } from './analysis.worker';
import type { ImportWorkerApi } from '../library/import.worker';

let analysis: Comlink.Remote<AnalysisWorkerApi> | null = null;
export const analysisWorker = () =>
  (analysis ??= Comlink.wrap<AnalysisWorkerApi>(new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })));

/** A small pool (round robin): import thumbnails and hashes for many files in parallel. */
const imports: Array<Comlink.Remote<ImportWorkerApi>> = [];
let next = 0;
const POOL = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
export const importWorker = () => {
  if (imports.length < POOL) imports.push(Comlink.wrap<ImportWorkerApi>(new Worker(new URL('../library/import.worker.ts', import.meta.url), { type: 'module' })));
  return imports[next++ % imports.length];
};
export const importPoolSize = POOL;
