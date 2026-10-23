/**
 * Cached library previews (512 px thumbnail + 2560 px preview per photo, in OPFS), rendered by
 * Optic from the photo's current recipe:
 *  - after import (replacing the camera's embedded preview),
 *  - after an edit of the open photo (debounced; from the already decoded proxy),
 *  - after batch edits of photos that are not open (decoded in the background).
 * One photo at a time, paused while the user drags a control, while the editor decodes a photo and
 * while an export runs, so it never competes with interactive work.
 */
import * as Comlink from 'comlink';
import { useEffect, useState } from 'react';
import type { LutData } from '../io/lut/lut';
import { lutRegistry } from '../pipeline/lutRegistry';
import { type MaskBitmap, maskRegistry } from '../pipeline/maskRegistry';
import { applyPreset } from '../presets/apply';
import { type Recipe, effectiveRecipe } from '../recipe/schema';
import { serializeRecipe } from '../recipe/serialize';
import { aiModelFor, aiCacheKey, isAiType } from '../recipe/masks';
import { activeCopy, loadDoc, saveDoc, type DocRecord } from '../state/editStore';
import { type LoadedImage, defaultRecipeFor, useImage } from '../state/imageStore';
import { useLibrary } from '../state/libraryStore';
import { usePresets } from '../state/presetStore';
import { useUi } from '../state/uiStore';
import { dbGet } from '../storage/db';
import type { PhotoRecord } from './db';
import { decodePhoto } from './decode';
import { PREVIEW_EDGE, THUMB_EDGE } from './fileInfo';
import { readFile, writeFile } from './opfs';
import type { RenderJob } from './renderCore';
import type { RenderWorkerApi } from './render.worker';

// ---------------------------------------------------------------------------
// Renderer (worker, else main thread)
// ---------------------------------------------------------------------------

let remote: Comlink.Remote<RenderWorkerApi> | null = null;
let remoteOk: Promise<boolean> | null = null;

async function renderApi(): Promise<Pick<RenderWorkerApi, 'preview' | 'linear'>> {
  if (!remoteOk) {
    remote = Comlink.wrap<RenderWorkerApi>(new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }));
    remoteOk = remote.canRender().catch(() => false);
  }
  if (await remoteOk) return remote!;
  const core = await import('./renderCore');
  return {
    preview: async (job, edge, thumbEdge) => {
      const px = await core.renderWhole(job, edge);
      return { ...(await core.encodePreview(px, thumbEdge)), width: px.width, height: px.height };
    },
    linear: (job, edge, until) => core.renderWhole(job, edge, { linear: true, until }),
  } as Pick<RenderWorkerApi, 'preview' | 'linear'>;
}

/** Linear (working-space) render of a decoded photo for batch analysis. */
export async function renderLinear(img: LoadedImage, recipe: Recipe, edge: number, until?: string) {
  const api = await renderApi();
  return api.linear(await jobFor(img, recipe), edge, until);
}

/** The AI mask bitmaps a recipe uses (registry, else the IndexedDB cache). */
export async function aiBitmaps(r: Recipe, key: string): Promise<MaskBitmap[]> {
  const out: MaskBitmap[] = [];
  const seen = new Set<string>();
  for (const m of r.masks) for (const c of m.components) {
    if (!isAiType(c.type)) continue;
    const k = c.cacheKey ?? aiCacheKey(key, aiModelFor(c)!);
    if (seen.has(k)) continue;
    seen.add(k);
    const b = maskRegistry.get(k) ?? (await dbGet<MaskBitmap>('aimasks', k));
    if (b) out.push(b);
  }
  return out;
}

export async function jobFor(img: LoadedImage, recipe: Recipe): Promise<RenderJob> {
  const eff = effectiveRecipe(recipe, img.asShot);
  const lut = lutRegistry.get(eff.lut.id);
  return { proxy: img.proxy, image: img.model, recipe: eff, luts: lut ? [lut as LutData] : [], masks: await aiBitmaps(eff, img.model.key) };
}

// ---------------------------------------------------------------------------
// Recipes of catalog photos
// ---------------------------------------------------------------------------

export const mainRecipe = (doc: DocRecord | null): Recipe | null => {
  if (!doc) return null;
  const c = doc.copies[0];
  return c ? c.steps[c.index].recipe : null;
};

/**
 * The document of a photo, creating it on first decode (defaults + As Shot WB + the preset chosen
 * at import), so the preset's interpolation base is the photo's real defaults.
 */
export async function ensureDoc(rec: PhotoRecord, img: LoadedImage): Promise<DocRecord> {
  const doc = await loadDoc(rec.key);
  if (doc) return doc;
  let r = defaultRecipeFor(img);
  let label = 'Imported';
  if (rec.pendingPreset) {
    await usePresets.getState().init();
    const p = usePresets.getState().byId(rec.pendingPreset.id);
    if (p) { r = applyPreset(r, p, img.isRaw, rec.pendingPreset.amount); label = `Preset: ${p.name} (${Math.round(rec.pendingPreset.amount)}%)`; }
  }
  const steps = [{ label: 'Opened', recipe: defaultRecipeFor(img), t: Date.now(), key: '' }];
  if (label !== 'Imported') steps.push({ label, recipe: r, t: Date.now(), key: '' });
  const d: DocRecord = { key: rec.key, version: 1, fileName: rec.fileName, updated: Date.now(), active: 'main', copies: [{ id: 'main', name: 'Original', steps, index: steps.length - 1, snapshots: [] }] };
  await saveDoc(d);
  if (rec.pendingPreset) await useLibrary.getState().patch([rec.id], () => ({ pendingPreset: null }));
  return d;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const queue: string[] = [];
let running = false;
const pausers = new Set<string>();
let wake: (() => void) | null = null;

/** Pause / resume background previews (e.g. while an export runs). */
export function pausePreviews(reason: string, on: boolean) {
  if (on) pausers.add(reason); else pausers.delete(reason);
  if (!on) wake?.();
}

export function enqueuePreviews(ids: string[], front = false) {
  for (const id of ids) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    if (front) queue.unshift(id); else queue.push(id);
  }
  if (!running) void loop();
}

const busy = () => pausers.size > 0 || useUi.getState().dragging || !!useImage.getState().loading;

async function waitIdle() {
  while (busy()) await new Promise<void>((r) => { wake = r; setTimeout(r, 500); });
}

async function loop() {
  running = true;
  try {
    while (queue.length) {
      await waitIdle();
      const id = queue.shift()!;
      const rec = useLibrary.getState().byId.get(id);
      if (!rec) continue;
      try {
        // The open photo is already decoded.
        const open = useImage.getState();
        if (open.photoId === id && open.image) await renderOpen(rec, open.image);
        else await renderBackground(rec);
      } catch (e) {
        console.warn('[optic] preview failed', rec.fileName, e);
        await useLibrary.getState().patch([id], () => ({ error: (e as Error).message || String(e) }));
      }
    }
  } finally {
    running = false;
  }
}

async function store(rec: PhotoRecord, out: { preview: Blob; thumb: Blob; width: number; height: number }, img: LoadedImage) {
  await writeFile(`previews/${rec.id}/preview`, out.preview);
  await writeFile(`previews/${rec.id}/thumb`, out.thumb);
  const now = Date.now();
  await useLibrary.getState().patch([rec.id], () => ({ thumb: now, preview: now, previewEmbedded: false, error: undefined, width: img.width, height: img.height }));
}

async function renderBackground(rec: PhotoRecord) {
  const doc0 = await loadDoc(rec.key);
  const img = await decodePhoto(rec, PREVIEW_EDGE, mainRecipe(doc0));
  try {
    const doc = doc0 ?? (await ensureDoc(rec, img));
    const recipe = mainRecipe(doc) ?? defaultRecipeFor(img);
    if (!doc0) await mirrorDoc(doc);
    const api = await renderApi();
    const out = await api.preview(await jobFor(img, recipe), PREVIEW_EDGE, THUMB_EDGE);
    await store(rec, out, img);
  } finally {
    // Drop the full-resolution pixels now rather than at the next GC.
    (img as { full: unknown }).full = null;
  }
}

async function renderOpen(rec: PhotoRecord, img: LoadedImage) {
  const doc = await loadDoc(rec.key);
  const recipe = mainRecipe(doc) ?? defaultRecipeFor(img);
  const api = await renderApi();
  const out = await api.preview(await jobFor(img, recipe), PREVIEW_EDGE, THUMB_EDGE);
  await store(rec, out, img);
}

// ---------------------------------------------------------------------------
// Catalog mirror of the edit document
// ---------------------------------------------------------------------------

/** Update a photo's catalog record from its edit document (recipe, edited, copies, preset). */
export async function mirrorDoc(doc: DocRecord) {
  const lib = useLibrary.getState();
  const rec = lib.photos.find((p) => p.key === doc.key);
  if (!rec) return;
  const r = mainRecipe(doc);
  const edited = doc.copies.some((c) => c.index > 0 || c.snapshots.length > 0) || doc.copies.length > 1;
  const active = activeCopy(doc);
  await lib.patch([rec.id], () => ({
    recipe: r ? JSON.parse(serializeRecipe(r)) : null,
    edited,
    editDate: edited ? doc.updated : rec.editDate,
    copies: Math.max(0, doc.copies.length - 1),
    preset: (r ?? active.steps[active.index].recipe).appliedPreset?.name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Thumbnail / preview URLs
// ---------------------------------------------------------------------------

const urls = new Map<string, string>();
const MAX_URLS = 900;

export async function imageUrl(p: PhotoRecord, kind: 'thumb' | 'preview'): Promise<string | null> {
  const v = kind === 'thumb' ? p.thumb : p.preview;
  if (!v) return kind === 'preview' && p.thumb ? imageUrl(p, 'thumb') : null;
  const key = `${p.id}:${kind}:${v}`;
  const hit = urls.get(key);
  if (hit) { urls.delete(key); urls.set(key, hit); return hit; }
  const f = await readFile(`previews/${p.id}/${kind}`);
  if (!f) return null;
  const u = URL.createObjectURL(f);
  urls.set(key, u);
  while (urls.size > MAX_URLS) {
    const [k, old] = urls.entries().next().value as [string, string];
    urls.delete(k);
    URL.revokeObjectURL(old);
  }
  return u;
}

/** URL of a photo's cached thumbnail or preview (re-resolves when it is regenerated). */
export function usePhotoImage(p: PhotoRecord | undefined, kind: 'thumb' | 'preview'): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const v = p ? (kind === 'thumb' ? p.thumb : p.preview) : 0;
  useEffect(() => {
    if (!p) { setUrl(null); return; }
    let live = true;
    void imageUrl(p, kind).then((u) => live && setUrl(u));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.id, v, kind]);
  return url;
}
