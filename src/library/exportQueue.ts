/**
 * Batch export queue. One full-resolution photo at a time (decode → render → encode → write), each
 * export worker and GPU context released before the next photo, so memory stays flat over hundreds
 * of photos. Output goes to a folder (File System Access) or into a ZIP streamed into OPFS and
 * downloaded at the end. Progress per photo, ETA, pause / cancel / retry failed, and a summary.
 * The job is saved in the catalog after every photo: a reload offers to resume it.
 */
import { create } from 'zustand';
import { MIME, applyTemplate, EXT, type ExportSettings, normalizeSettings } from '../io/encode/exportSettings';
import { downloadBlob, renderAndEncode } from '../io/encode/exportClient';
import { serializeRecipe } from '../recipe/serialize';
import type { Recipe } from '../recipe/schema';
import { activeCopy, loadDoc, useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { useLibrary } from '../state/libraryStore';
import { type ZipState, newZip, zipAdd, zipFinish } from '../storage/zipStream';
import { catalog } from './db';
import { decodePhoto } from './decode';
import { readFile, removeEntry, truncateFile } from './opfs';
import { ensureDoc, mainRecipe, pausePreviews } from './previews';

export type ItemState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ExportItem {
  photoId: string;
  fileName: string;
  state: ItemState;
  outName?: string;
  bytes?: number;
  ms?: number;
  error?: string;
}

export interface ExportJob {
  id: string;
  created: number;
  presetName: string;
  settings: ExportSettings;
  custom: string;
  destination: 'folder' | 'zip';
  folder?: FileSystemDirectoryHandle;
  folderName?: string;
  zip?: ZipState;
  zipName?: string;
  items: ExportItem[];
  status: 'running' | 'paused' | 'done' | 'cancelled' | 'interrupted';
  finished?: number;
}

interface QueueState {
  job: ExportJob | null;
  /** Label / fraction of the photo being exported. */
  current: { label: string; fraction: number } | null;
  panelOpen: boolean;
  set(p: Partial<QueueState>): void;
}

export const useExportQueue = create<QueueState>((set) => ({ job: null, current: null, panelOpen: false, set: (p) => set(p) }));

let controller: AbortController | null = null;
let running = false;

const save = (job: ExportJob) => catalog.exportQueue.put({ id: 'current', job }).catch((e) => console.warn('[optic] export queue not saved', e));
const setJob = (job: ExportJob) => { useExportQueue.getState().set({ job: { ...job, items: [...job.items] } }); void save(job); };

/** On start-up: a job that was running when the page went away is offered for resuming. */
export async function restoreExportQueue() {
  try {
    const r = await catalog.exportQueue.get('current');
    const job = r?.job as ExportJob | undefined;
    if (!job) return;
    if (job.status === 'running' || job.status === 'paused') {
      job.status = 'interrupted';
      job.items = job.items.map((i) => (i.state === 'running' ? { ...i, state: 'pending' } : i));
      useExportQueue.getState().set({ job, panelOpen: true });
      void save(job);
    } else useExportQueue.getState().set({ job });
  } catch { /* no catalog */ }
}

export async function startExportJob(ids: string[], settings: ExportSettings, opts: { presetName: string; custom: string; folder?: FileSystemDirectoryHandle | null; zipName: string }) {
  if (running) throw new Error('An export is already running');
  const lib = useLibrary.getState();
  const job: ExportJob = {
    id: crypto.randomUUID(),
    created: Date.now(),
    presetName: opts.presetName,
    settings: normalizeSettings(settings),
    custom: opts.custom,
    destination: opts.folder ? 'folder' : 'zip',
    folder: opts.folder ?? undefined,
    folderName: opts.folder?.name,
    zipName: opts.zipName,
    items: ids.map((id) => ({ photoId: id, fileName: lib.byId.get(id)?.fileName ?? id, state: 'pending' })),
    status: 'running',
  };
  if (!opts.folder) {
    await removeEntry('exports/current.zip');
    job.zip = newZip('exports/current.zip');
  }
  useExportQueue.getState().set({ panelOpen: true });
  setJob(job);
  void run();
}

export function pauseExport() {
  const job = useExportQueue.getState().job;
  if (job?.status === 'running') setJob({ ...job, status: 'paused' });
}

export async function resumeExport() {
  const job = useExportQueue.getState().job;
  if (!job || running) return;
  if (job.destination === 'folder' && job.folder) {
    const h = job.folder as FileSystemDirectoryHandle & { requestPermission?(o: unknown): Promise<string> };
    const p = (await h.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (p !== 'granted') { alert('Optic needs permission to write to the export folder.'); return; }
  }
  // A reload may have stopped in the middle of a ZIP entry: cut the file back to the last
  // complete entry (the saved state) before appending again.
  if (job.destination === 'zip' && job.zip) {
    const f = await readFile(job.zip.path);
    if (!f) { alert('The partial ZIP is gone; the export starts over.'); job.zip = { path: job.zip.path, size: 0, entries: [] }; job.items = job.items.map((i) => ({ ...i, state: 'pending' })); }
    else if (f.size !== job.zip.size) await truncateFile(job.zip.path, job.zip.size);
  }
  setJob({ ...job, status: 'running' });
  void run();
}

export function cancelExport() {
  const job = useExportQueue.getState().job;
  if (!job) return;
  controller?.abort();
  setJob({ ...job, status: 'cancelled', finished: Date.now(), items: job.items.map((i) => (i.state === 'pending' || i.state === 'running' ? { ...i, state: 'cancelled' } : i)) });
}

export function retryFailed() {
  const job = useExportQueue.getState().job;
  if (!job || running) return;
  setJob({ ...job, status: 'running', finished: undefined, items: job.items.map((i) => (i.state === 'failed' || i.state === 'cancelled' ? { ...i, state: 'pending', error: undefined } : i)) });
  void run();
}

export function dismissExport() {
  if (running) return;
  useExportQueue.getState().set({ job: null, panelOpen: false });
  void catalog.exportQueue.delete('current');
}

/** Average seconds per finished photo × remaining photos. */
export function eta(job: ExportJob): number | null {
  const done = job.items.filter((i) => i.state === 'done' && i.ms);
  const left = job.items.filter((i) => i.state === 'pending' || i.state === 'running').length;
  if (!done.length || !left) return null;
  return (done.reduce((s, i) => s + i.ms!, 0) / done.length / 1000) * left;
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let k = 2; ; k++) {
    const n = `${base} (${k})${ext}`;
    if (!used.has(n.toLowerCase())) { used.add(n.toLowerCase()); return n; }
  }
}

async function folderHas(dir: FileSystemDirectoryHandle, name: string) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

async function writeToFolder(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array | string) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as unknown as { createWritable(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }> }).createWritable();
  await w.write(typeof data === 'string' ? data : (data as BlobPart));
  await w.close();
}

async function run() {
  if (running) return;
  running = true;
  pausePreviews('export', true);
  const used = new Set<string>();
  try {
    let job = useExportQueue.getState().job!;
    for (const i of job.items) if (i.outName) used.add(i.outName.toLowerCase());
    for (const e of job.zip?.entries ?? []) used.add(e.name.toLowerCase());
    for (;;) {
      job = useExportQueue.getState().job!;
      if (!job || job.status !== 'running') break;
      const idx = job.items.findIndex((i) => i.state === 'pending');
      if (idx < 0) break;
      const item = job.items[idx];
      const t0 = performance.now();
      job.items[idx] = { ...item, state: 'running' };
      setJob(job);
      controller = new AbortController();
      try {
        const res = await exportOne(job, item, idx, used, controller.signal);
        job = useExportQueue.getState().job!;
        job.items[idx] = { ...job.items[idx], state: 'done', outName: res.name, bytes: res.bytes, ms: performance.now() - t0 };
      } catch (e) {
        job = useExportQueue.getState().job!;
        const cancelled = controller.signal.aborted || (e as Error).name === 'AbortError';
        if (!cancelled) console.warn('[optic] export failed', item.fileName, e);
        job.items[idx] = { ...job.items[idx], state: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : (e as Error).message || String(e) };
      }
      useExportQueue.getState().set({ current: null });
      setJob(job);
      // Give the GPU process and the garbage collector a moment between full-resolution images.
      await new Promise((r) => setTimeout(r, 50));
    }
    job = useExportQueue.getState().job!;
    if (job && job.status === 'running') {
      if (job.destination === 'zip' && job.zip && job.zip.entries.length) {
        useExportQueue.getState().set({ current: { label: 'Finishing ZIP', fraction: 1 } });
        await zipFinish(job.zip);
        const f = await readFile(job.zip.path);
        if (f) downloadBlob(f, job.zipName ?? 'optic-export.zip');
      }
      setJob({ ...job, status: 'done', finished: Date.now() });
    }
  } finally {
    running = false;
    controller = null;
    useExportQueue.getState().set({ current: null });
    pausePreviews('export', false);
  }
}

async function exportOne(job: ExportJob, item: ExportItem, idx: number, used: Set<string>, signal: AbortSignal): Promise<{ name: string; bytes: number }> {
  const rec = useLibrary.getState().byId.get(item.photoId);
  if (!rec) throw new Error('The photo is no longer in the library');
  const s = job.settings;
  const progress = (fraction: number, label: string) => useExportQueue.getState().set({ current: { label: `${rec.fileName}: ${label}`, fraction } });
  // The open photo is exported as it is in the editor (already decoded); others are decoded here.
  const open = useImage.getState();
  let recipe: Recipe;
  let image = open.photoId === rec.id ? open.image : null;
  let copyName = '';
  if (image) {
    useEdit.getState().commit();
    recipe = useEdit.getState().recipe;
    const e = useEdit.getState();
    if (e.copies.length > 1 && e.active !== e.copies[0].id) copyName = activeCopy(e).name;
  } else {
    progress(0.01, 'Decoding');
    const doc0 = await loadDoc(rec.key);
    image = await decodePhoto(rec, 2048, mainRecipe(doc0), signal);
    const doc = doc0 ?? (await ensureDoc(rec, image));
    const c = activeCopy(doc);
    recipe = c.steps[c.index].recipe;
    if (doc.copies.length > 1 && c.id !== doc.copies[0].id) copyName = c.name;
  }
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  try {
    const bytes = await renderAndEncode(image, recipe, s, progress, signal);
    const base = applyTemplate(s.fileName, {
      filename: rec.fileName, date: rec.captureDate, seq: idx + 1, preset: job.presetName, rating: rec.rating,
      camera: rec.camera, custom: job.custom, copy: copyName,
    });
    let name = uniqueName(`${base}.${EXT[s.format]}`, used);
    progress(0.99, 'Saving');
    if (job.destination === 'folder' && job.folder) {
      while (await folderHas(job.folder, name)) name = uniqueName(name, used);
      await writeToFolder(job.folder, name, bytes);
      if (s.sidecar) await writeToFolder(job.folder, `${name.replace(/\.[^.]+$/, '')}.optic.json`, sidecarJson(rec.fileName, recipe, rec));
    } else if (job.zip) {
      await zipAdd(job.zip, name, bytes);
      if (s.sidecar) await zipAdd(job.zip, `${name.replace(/\.[^.]+$/, '')}.optic.json`, new TextEncoder().encode(sidecarJson(rec.fileName, recipe, rec)));
      // Save the ZIP's entry list with the job (resume after a reload).
      void save(useExportQueue.getState().job!);
    }
    return { name, bytes: bytes.length };
  } finally {
    if (image !== open.image) (image as { full: unknown }).full = null;
  }
}

/** Recipe sidecar: the edit, portable to another device (Import edits). */
export function sidecarJson(fileName: string, recipe: Recipe, meta?: { rating: number; flag: number; label: string | null; keywords: string[] }): string {
  return JSON.stringify({
    optic: 'recipe',
    version: 1,
    file: fileName,
    recipe: JSON.parse(serializeRecipe(recipe)),
    meta: meta ? { rating: meta.rating, flag: meta.flag, label: meta.label, keywords: meta.keywords } : undefined,
  }, null, 2);
}

export const outputMime = (s: ExportSettings) => MIME[s.format];
