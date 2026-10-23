/**
 * Import: collect files (picker, folder picker, drag and drop of files and folders), review them in
 * the import dialog (thumbnails, duplicates, options), then a background queue copies each into
 * Optic (OPFS) or references it in place (File System Access handle), reads its metadata, writes a
 * quick preview and adds it to the catalog. Optic's own render of each photo follows in the preview
 * queue. The app stays usable throughout; photos appear in the grid one by one.
 */
import { create } from 'zustand';
import { ACCEPT } from '../io/decode/decodeClient';
import { useLibrary } from '../state/libraryStore';
import type { CollectionRecord, PhotoRecord } from './db';
import { catalog } from './db';
import { importPoolSize, importWorker } from '../app/analysisClient';
import { opfsAvailable, writeFile } from './opfs';
import { enqueuePreviews } from './previews';

const EXTS = new Set(ACCEPT.split(',').map((e) => e.slice(1).toLowerCase()));
export const isSupported = (name: string) => EXTS.has(name.split('.').pop()?.toLowerCase() ?? '');

export interface Candidate {
  id: string;
  file: File;
  handle?: FileSystemFileHandle;
  path: string;
  selected: boolean;
  hash?: string;
  duplicateOf?: string | null;
  thumbUrl?: string | null;
}

export interface ImportOptions {
  mode: 'copy' | 'reference';
  skipDuplicates: boolean;
  preset: { id: string; amount: number } | null;
  collectionId: string | null;
  newCollection: string;
  keywords: string[];
}

interface ImportState {
  dialogOpen: boolean;
  candidates: Candidate[];
  /** Files the dialog skipped (unsupported type). */
  skipped: string[];
  /** Whether "Reference in place" is possible (every candidate has a handle). */
  canReference: boolean;
  options: ImportOptions;
  /** Open this candidate in the editor once imported (single-file open). */
  openAfter: boolean;
  queue: { total: number; done: number; current: string; running: boolean; added: number; duplicates: number; errors: Array<{ name: string; message: string }> };
  set(p: Partial<ImportState>): void;
}

const DEFAULT_OPTIONS: ImportOptions = { mode: 'copy', skipDuplicates: true, preset: null, collectionId: null, newCollection: '', keywords: [] };

export const useImport = create<ImportState>((set) => ({
  dialogOpen: false,
  candidates: [],
  skipped: [],
  canReference: false,
  options: DEFAULT_OPTIONS,
  openAfter: false,
  queue: { total: 0, done: 0, current: '', running: false, added: 0, duplicates: 0, errors: [] },
  set: (p) => set(p),
}));

export interface Incoming {
  file: File;
  handle?: FileSystemFileHandle;
  path: string;
}

// ---------------------------------------------------------------------------
// Collecting files
// ---------------------------------------------------------------------------

type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?(ok: (f: File) => void, err: (e: unknown) => void): void; createReader?(): { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void } };

async function walkEntry(e: Entry, out: Incoming[]) {
  if (e.isFile && e.file) {
    const f = await new Promise<File>((ok, err) => e.file!(ok, err));
    out.push({ file: f, path: e.fullPath.replace(/^\//, '') });
  } else if (e.isDirectory && e.createReader) {
    const r = e.createReader();
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, err) => r.readEntries(ok, err));
      if (!batch.length) break;
      for (const c of batch) await walkEntry(c, out);
    }
  }
}

async function walkHandle(h: FileSystemHandle, path: string, out: Incoming[]) {
  if (h.kind === 'file') {
    const fh = h as FileSystemFileHandle;
    out.push({ file: await fh.getFile(), handle: fh, path: path + h.name });
  } else {
    for await (const c of (h as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) await walkHandle(c, `${path}${h.name}/`, out);
  }
}

/** Files and folders from a drop: handles where the browser gives them (reference in place), else entries. */
export async function fromDataTransfer(dt: DataTransfer): Promise<Incoming[]> {
  const out: Incoming[] = [];
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const withHandles = items.map((i) => (i as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.());
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?(): Entry | null }).webkitGetAsEntry?.() ?? null);
  const handles = await Promise.all(withHandles.map((p) => p?.catch(() => null) ?? null));
  for (let i = 0; i < items.length; i++) {
    const h = handles[i];
    if (h) await walkHandle(h, '', out);
    else if (entries[i]) await walkEntry(entries[i]!, out);
    else { const f = items[i].getAsFile(); if (f) out.push({ file: f, path: f.name }); }
  }
  return out;
}

export async function fromDirectoryHandle(dir: FileSystemDirectoryHandle): Promise<Incoming[]> {
  const out: Incoming[] = [];
  await walkHandle(dir, '', out);
  return out;
}

export const fromFiles = (files: Iterable<File>): Incoming[] =>
  [...files].map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));

/** File / folder pickers (File System Access where available: enables "Reference in place"). */
export async function pickFiles(): Promise<Incoming[] | null> {
  const w = window as unknown as { showOpenFilePicker?(o: unknown): Promise<FileSystemFileHandle[]> };
  if (!w.showOpenFilePicker) return null;
  try {
    const hs = await w.showOpenFilePicker({ multiple: true, types: [{ description: 'Photos', accept: { 'image/*': [...EXTS].map((e) => `.${e}`) } }], excludeAcceptAllOption: false });
    return Promise.all(hs.map(async (h) => ({ file: await h.getFile(), handle: h, path: h.name })));
  } catch (e) {
    if ((e as Error).name === 'AbortError') return [];
    throw e;
  }
}

export async function pickFolder(): Promise<Incoming[] | null> {
  const w = window as unknown as { showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) return null;
  try {
    return await fromDirectoryHandle(await w.showDirectoryPicker({ mode: 'read' }));
  } catch (e) {
    if ((e as Error).name === 'AbortError') return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

let reviewToken = 0;

/** Open the import dialog for these files; thumbnails and duplicate checks fill in progressively. */
export function reviewImport(incoming: Incoming[], openAfter = false) {
  const ok = incoming.filter((i) => isSupported(i.file.name));
  const skipped = incoming.filter((i) => !isSupported(i.file.name)).map((i) => i.path);
  const prev = useImport.getState();
  prev.candidates.forEach((c) => c.thumbUrl && URL.revokeObjectURL(c.thumbUrl));
  const candidates: Candidate[] = ok.map((i) => ({ id: crypto.randomUUID(), file: i.file, handle: i.handle, path: i.path, selected: true }));
  const canReference = candidates.length > 0 && candidates.every((c) => !!c.handle);
  useImport.getState().set({
    dialogOpen: true,
    candidates,
    skipped,
    canReference,
    openAfter,
    options: { ...prev.options, mode: canReference && prev.options.mode === 'reference' ? 'reference' : opfsAvailable() ? 'copy' : 'reference' },
  });
  void analyseCandidates(++reviewToken);
}

async function analyseCandidates(token: number) {
  const byHash = new Set((await catalog.photos.toArray().catch(() => [] as PhotoRecord[])).map((p) => p.hash));
  const list = useImport.getState().candidates;
  let i = 0;
  const worker = async () => {
    while (i < list.length && token === reviewToken) {
      const c = list[i++];
      try {
        const hash = await importWorker().hash(c.file);
        const dup = byHash.has(hash);
        update(c.id, { hash, duplicateOf: dup ? hash : null, selected: dup ? false : useImport.getState().candidates.find((x) => x.id === c.id)?.selected ?? true });
        const { preview: q } = await importWorker().analyse(c.file, true);
        if (token !== reviewToken) return;
        if (q) update(c.id, { thumbUrl: URL.createObjectURL(q.thumb) });
        else update(c.id, { thumbUrl: null });
      } catch {
        update(c.id, { thumbUrl: null });
      }
    }
  };
  await Promise.all(Array.from({ length: importPoolSize }, () => worker()));
  function update(id: string, patch: Partial<Candidate>) {
    if (token !== reviewToken) return;
    useImport.getState().set({ candidates: useImport.getState().candidates.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }
}

export function closeImportDialog() {
  reviewToken++;
  const s = useImport.getState();
  s.candidates.forEach((c) => c.thumbUrl && URL.revokeObjectURL(c.thumbUrl));
  s.set({ dialogOpen: false, candidates: [], skipped: [] });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface Job {
  file: File;
  handle?: FileSystemFileHandle;
  path: string;
  hash?: string;
}

const pending: Job[] = [];
let running = false;
let runOptions: ImportOptions = DEFAULT_OPTIONS;
let openWhenDone: ((id: string) => void) | null = null;

/** Start importing the dialog's selected candidates with its options. */
export async function startImport(onFirst?: (id: string) => void) {
  const s = useImport.getState();
  const opts = { ...s.options };
  // A new collection named in the dialog is created first.
  if (opts.newCollection.trim()) {
    const c: CollectionRecord = { id: crypto.randomUUID(), name: opts.newCollection.trim(), kind: 'manual', created: Date.now() };
    await useLibrary.getState().saveCollection(c);
    opts.collectionId = c.id;
    opts.newCollection = '';
  }
  const jobs = s.candidates.filter((c) => c.selected).map((c) => ({ file: c.file, handle: c.handle, path: c.path, hash: c.hash }));
  closeImportDialog();
  enqueueImport(jobs, opts, onFirst);
}

/** Import without the dialog (single photo opened from the editor, share target, file handler). */
export function enqueueImport(jobs: Job[], opts: ImportOptions = DEFAULT_OPTIONS, onFirst?: (id: string) => void) {
  if (!jobs.length) return;
  runOptions = { ...opts, mode: opts.mode === 'reference' && jobs.every((j) => j.handle) ? 'reference' : opfsAvailable() ? 'copy' : 'reference' };
  if (onFirst) openWhenDone = onFirst;
  pending.push(...jobs);
  const q = useImport.getState().queue;
  useImport.getState().set({ queue: { ...q, total: (q.running ? q.total : 0) + jobs.length, done: q.running ? q.done : 0, running: true, ...(q.running ? {} : { added: 0, duplicates: 0, errors: [] }) } });
  if (!q.running) useLibrary.getState().set({ lastImport: [] });
  if (!running) void run();
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

async function run() {
  running = true;
  try {
    while (pending.length) {
      const job = pending.shift()!;
      const q = () => useImport.getState().queue;
      useImport.getState().set({ queue: { ...q(), current: job.path } });
      try {
        const id = await importOne(job, runOptions);
        if (id) {
          useLibrary.getState().set({ lastImport: [...useLibrary.getState().lastImport, id] });
          if (openWhenDone) { const f = openWhenDone; openWhenDone = null; f(id); }
        }
        useImport.getState().set({ queue: { ...q(), added: q().added + (id && !dupHit ? 1 : 0), duplicates: q().duplicates + (dupHit ? 1 : 0) } });
      } catch (e) {
        console.warn('[optic] import failed', job.path, e);
        useImport.getState().set({ queue: { ...q(), errors: [...q().errors, { name: job.path, message: (e as Error).message || String(e) }] } });
      }
      useImport.getState().set({ queue: { ...q(), done: q().done + 1 } });
      await yieldToUi();
    }
  } finally {
    running = false;
    useImport.getState().set({ queue: { ...useImport.getState().queue, running: false, current: '' } });
  }
}

let dupHit = false;

/** Import one file; returns the photo id (the existing one for a skipped duplicate). */
async function importOne(job: Job, opts: ImportOptions): Promise<string | null> {
  dupHit = false;
  const hash = job.hash ?? (await importWorker().hash(job.file));
  if (opts.skipDuplicates) {
    const existing = await catalog.photos.where('hash').equals(hash).first();
    if (existing) { dupHit = true; return existing.id; }
  }
  const { facts, preview: quick } = await importWorker().analyse(job.file, true);
  const id = crypto.randomUUID();
  const now = Date.now();
  let opfsPath: string | undefined;
  if (opts.mode === 'copy') {
    opfsPath = `originals/${id}/${job.file.name}`;
    await writeFile(opfsPath, job.file);
  }
  let thumb = 0, preview = 0;
  if (quick) {
    await writeFile(`previews/${id}/thumb`, quick.thumb);
    thumb = now;
    if (quick.preview) { await writeFile(`previews/${id}/preview`, quick.preview); preview = now; }
  }
  const rec: PhotoRecord = {
    id,
    key: `${job.file.name}|${job.file.size}|${job.file.lastModified}`,
    fileName: job.file.name,
    size: job.file.size,
    lastModified: job.file.lastModified,
    hash,
    storage: opts.mode === 'copy' ? 'opfs' : 'handle',
    opfsPath,
    handle: opts.mode === 'reference' ? job.handle : undefined,
    format: facts.format,
    isRaw: facts.isRaw,
    width: facts.width || quick?.width || 0,
    height: facts.height || quick?.height || 0,
    camera: facts.camera,
    lens: facts.lens,
    iso: facts.iso,
    shutter: facts.shutter,
    aperture: facts.aperture,
    focal: facts.focal,
    hasGps: facts.hasGps,
    captureDate: facts.captureDate,
    importDate: now,
    editDate: 0,
    rating: 0,
    flag: 0,
    label: null,
    keywords: [...new Set(opts.keywords.map((k) => k.trim()).filter(Boolean))],
    collections: opts.collectionId ? [opts.collectionId] : [],
    edited: false,
    preset: null,
    copies: 0,
    recipe: null,
    thumb,
    preview,
    previewEmbedded: true,
    pendingPreset: opts.preset,
  };
  await useLibrary.getState().addPhotos([rec]);
  enqueuePreviews([id]);
  return id;
}
