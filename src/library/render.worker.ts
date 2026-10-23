/** Library preview and batch-analysis renders off the main thread (see renderCore.ts). */
import * as Comlink from 'comlink';
import { type RenderJob, canRender, encodePreview, renderWhole } from './renderCore';

const api = {
  canRender,
  async preview(job: RenderJob, edge: number, thumbEdge: number) {
    const px = await renderWhole(job, edge);
    const out = await encodePreview(px, thumbEdge);
    return { ...out, width: px.width, height: px.height };
  },
  async linear(job: RenderJob, edge: number, until?: string) {
    const px = await renderWhole(job, edge, { linear: true, until });
    return Comlink.transfer(px, [px.data.buffer as ArrayBuffer]);
  },
};

export type RenderWorkerApi = typeof api;
Comlink.expose(api);
