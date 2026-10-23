/**
 * The library in memory: every photo record of the catalog (10 000 records are a few MB), the
 * collections, the current source (all photos / a collection / a smart collection), the filter
 * bar, the sort, the selection and which view is showing (grid or editor). Writes go through to the
 * catalog (Dexie). The visible list is derived (filter + sort) and memoised.
 */
import { create } from 'zustand';
import { type CollectionRecord, type LibraryFilter, type PhotoMeta, type PhotoRecord, catalog, kvGet, kvSet } from '../library/db';

export type SortKey = 'captureDate' | 'importDate' | 'editDate' | 'fileName' | 'rating';
export type Source = { kind: 'all' } | { kind: 'recent' } | { kind: 'collection'; id: string };

export interface LibraryState {
  ready: boolean;
  photos: PhotoRecord[];
  byId: Map<string, PhotoRecord>;
  collections: CollectionRecord[];
  view: 'library' | 'editor';
  source: Source;
  filter: LibraryFilter;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  selection: Set<string>;
  anchor: string | null;
  /** Focused photo (grid cursor; the photo open in the editor). */
  active: string | null;
  thumbSize: number;
  infoOpen: boolean;
  filterOpen: boolean;
  /** Ids of the most recent import (the "Last import" source). */
  lastImport: string[];
  init(): Promise<void>;
  set(p: Partial<LibraryState>): void;
  addPhotos(p: PhotoRecord[]): Promise<void>;
  patch(ids: string[], fn: (p: PhotoRecord) => Partial<PhotoRecord>): Promise<void>;
  remove(ids: string[]): Promise<void>;
  setFilter(f: Partial<LibraryFilter>): void;
  clearFilter(): void;
  select(id: string, mode?: 'only' | 'toggle' | 'range'): void;
  selectAll(): void;
  saveCollection(c: CollectionRecord): Promise<void>;
  deleteCollection(id: string): Promise<void>;
  addToCollection(collectionId: string, ids: string[]): Promise<void>;
  removeFromCollection(collectionId: string, ids: string[]): Promise<void>;
}

const index = (photos: PhotoRecord[]) => new Map(photos.map((p) => [p.id, p]));

export const useLibrary = create<LibraryState>((set, get) => ({
  ready: false,
  photos: [],
  byId: new Map(),
  collections: [],
  view: 'library',
  source: { kind: 'all' },
  filter: {},
  sort: { key: 'captureDate', dir: 'desc' },
  selection: new Set(),
  anchor: null,
  active: null,
  thumbSize: 180,
  infoOpen: false,
  filterOpen: false,
  lastImport: [],

  async init() {
    if (get().ready) return;
    try {
      const [photos, collections, ui] = await Promise.all([
        catalog.photos.toArray(),
        catalog.collections.toArray(),
        kvGet<Partial<Pick<LibraryState, 'sort' | 'thumbSize' | 'infoOpen' | 'lastImport'>>>('libraryUi', {}),
      ]);
      set({ photos, byId: index(photos), collections, ready: true, ...ui });
    } catch (e) {
      console.warn('[optic] catalog unavailable', e);
      set({ ready: true });
    }
  },

  set(p) {
    set(p);
    if ('sort' in p || 'thumbSize' in p || 'infoOpen' in p || 'lastImport' in p) {
      const s = get();
      void kvSet('libraryUi', { sort: s.sort, thumbSize: s.thumbSize, infoOpen: s.infoOpen, lastImport: s.lastImport });
    }
  },

  async addPhotos(list) {
    if (!list.length) return;
    await catalog.photos.bulkPut(list);
    const ids = new Set(list.map((p) => p.id));
    const photos = [...get().photos.filter((p) => !ids.has(p.id)), ...list];
    set({ photos, byId: index(photos) });
  },

  async patch(ids, fn) {
    const want = new Set(ids);
    const changed: PhotoRecord[] = [];
    const photos = get().photos.map((p) => {
      if (!want.has(p.id)) return p;
      const n = { ...p, ...fn(p) };
      changed.push(n);
      return n;
    });
    if (!changed.length) return;
    set({ photos, byId: index(photos) });
    await catalog.photos.bulkPut(changed).catch((e) => console.warn('[optic] catalog not saved', e));
  },

  async remove(ids) {
    const gone = new Set(ids);
    const photos = get().photos.filter((p) => !gone.has(p.id));
    const selection = new Set([...get().selection].filter((x) => !gone.has(x)));
    set({ photos, byId: index(photos), selection, active: get().active && gone.has(get().active!) ? null : get().active });
    await catalog.photos.bulkDelete(ids);
  },

  setFilter(f) {
    set({ filter: { ...get().filter, ...f } });
  },
  clearFilter() {
    set({ filter: {} });
  },

  select(id, mode = 'only') {
    const s = get();
    if (mode === 'toggle') {
      const sel = new Set(s.selection);
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      set({ selection: sel, anchor: id, active: sel.has(id) ? id : s.active === id ? [...sel][0] ?? null : s.active });
      return;
    }
    if (mode === 'range' && s.anchor) {
      const list = visiblePhotos(s);
      const a = list.findIndex((p) => p.id === s.anchor), b = list.findIndex((p) => p.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        set({ selection: new Set(list.slice(lo, hi + 1).map((p) => p.id)), active: id });
        return;
      }
    }
    set({ selection: new Set([id]), anchor: id, active: id });
  },

  selectAll() {
    const list = visiblePhotos(get());
    set({ selection: new Set(list.map((p) => p.id)), anchor: list[0]?.id ?? null });
  },

  async saveCollection(c) {
    await catalog.collections.put(c);
    set({ collections: [...get().collections.filter((x) => x.id !== c.id), c] });
  },

  async deleteCollection(id) {
    await catalog.collections.delete(id);
    const s = get();
    set({ collections: s.collections.filter((c) => c.id !== id), source: s.source.kind === 'collection' && s.source.id === id ? { kind: 'all' } : s.source });
    const members = s.photos.filter((p) => p.collections.includes(id)).map((p) => p.id);
    await get().patch(members, (p) => ({ collections: p.collections.filter((x) => x !== id) }));
  },

  async addToCollection(cid, ids) {
    await get().patch(ids, (p) => ({ collections: p.collections.includes(cid) ? p.collections : [...p.collections, cid] }));
  },

  async removeFromCollection(cid, ids) {
    await get().patch(ids, (p) => ({ collections: p.collections.filter((x) => x !== cid) }));
  },
}));

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

export function matchesFilter(p: PhotoRecord, f: LibraryFilter): boolean {
  if (f.minRating !== undefined && f.minRating > 0) {
    const op = f.ratingOp ?? '>=';
    if (op === '>=' && p.rating < f.minRating) return false;
    if (op === '==' && p.rating !== f.minRating) return false;
    if (op === '<=' && p.rating > f.minRating) return false;
  }
  switch (f.flag ?? 'any') {
    case 'picked': if (p.flag !== 1) return false; break;
    case 'rejected': if (p.flag !== -1) return false; break;
    case 'unflagged': if (p.flag !== 0) return false; break;
    case 'notRejected': if (p.flag === -1) return false; break;
  }
  if (f.labels?.length && (!p.label || !f.labels.includes(p.label))) return false;
  if (f.formats?.length && !f.formats.includes(formatGroup(p))) return false;
  if (f.raw === 'raw' && !p.isRaw) return false;
  if (f.raw === 'nonRaw' && p.isRaw) return false;
  if (f.edited === 'edited' && !p.edited) return false;
  if (f.edited === 'unedited' && p.edited) return false;
  if (f.camera && p.camera !== f.camera) return false;
  if (f.lens && p.lens !== f.lens) return false;
  if (f.from && p.captureDate < new Date(`${f.from}T00:00:00`).getTime()) return false;
  if (f.to && p.captureDate > new Date(`${f.to}T23:59:59.999`).getTime()) return false;
  if (f.lastDays && p.captureDate < Date.now() - f.lastDays * DAY) return false;
  if (f.keyword && !p.keywords.some((k) => k.toLowerCase() === f.keyword!.toLowerCase())) return false;
  if (f.preset && p.preset !== f.preset) return false;
  if (f.text) {
    const q = f.text.toLowerCase().trim();
    if (q) {
      const hay = `${p.fileName} ${p.keywords.join(' ')} ${p.camera} ${p.lens}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
  }
  return true;
}

/** RAW / JPEG / HEIC / PNG / TIFF / WebP / AVIF badge and filter group. */
export function formatGroup(p: Pick<PhotoRecord, 'format' | 'isRaw'>): string {
  if (p.isRaw) return 'RAW';
  return ({ heic: 'HEIC', jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF', webp: 'WebP', avif: 'AVIF' } as Record<string, string>)[p.format] ?? 'Other';
}

export function filterActive(f: LibraryFilter): boolean {
  return Object.entries(f).some(([k, v]) => v !== undefined && v !== '' && v !== 'any' && !(Array.isArray(v) && !v.length) && !(k === 'minRating' && !v));
}

const cmp: Record<SortKey, (a: PhotoRecord, b: PhotoRecord) => number> = {
  captureDate: (a, b) => a.captureDate - b.captureDate,
  importDate: (a, b) => a.importDate - b.importDate,
  editDate: (a, b) => a.editDate - b.editDate,
  fileName: (a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
  rating: (a, b) => a.rating - b.rating,
};

let memo: { photos: PhotoRecord[]; key: string; out: PhotoRecord[] } | null = null;

/** The photos in view: source, then filter bar, then sort. Memoised on its inputs. */
export function visiblePhotos(s: Pick<LibraryState, 'photos' | 'source' | 'filter' | 'sort' | 'collections' | 'lastImport'>): PhotoRecord[] {
  const key = JSON.stringify([s.source, s.filter, s.sort, s.source.kind === 'collection' ? s.collections.find((c) => c.id === (s.source as { id: string }).id) : null, s.source.kind === 'recent' ? s.lastImport.length : 0]);
  if (memo && memo.photos === s.photos && memo.key === key) return memo.out;
  let list = s.photos;
  if (s.source.kind === 'recent') {
    const ids = new Set(s.lastImport);
    list = list.filter((p) => ids.has(p.id));
  } else if (s.source.kind === 'collection') {
    const id = s.source.id;
    const c = s.collections.find((x) => x.id === id);
    if (c?.kind === 'smart' && c.filter) list = list.filter((p) => matchesFilter(p, c.filter!));
    else list = list.filter((p) => p.collections.includes(id));
  }
  list = list.filter((p) => matchesFilter(p, s.filter));
  const c = cmp[s.sort.key];
  const dir = s.sort.dir === 'asc' ? 1 : -1;
  const out = [...list].sort((a, b) => (c(a, b) || a.fileName.localeCompare(b.fileName)) * dir);
  memo = { photos: s.photos, key, out };
  return out;
}

export function useVisiblePhotos(): PhotoRecord[] {
  const photos = useLibrary((s) => s.photos);
  const source = useLibrary((s) => s.source);
  const filter = useLibrary((s) => s.filter);
  const sort = useLibrary((s) => s.sort);
  const collections = useLibrary((s) => s.collections);
  const lastImport = useLibrary((s) => s.lastImport);
  return visiblePhotos({ photos, source, filter, sort, collections, lastImport });
}

/** The photos an action applies to: the selection when it includes the active photo, else the active photo. */
export function targetIds(): string[] {
  const s = useLibrary.getState();
  if (s.selection.size && (!s.active || s.selection.has(s.active))) return [...s.selection];
  return s.active ? [s.active] : [...s.selection];
}

export async function setMeta(ids: string[], patch: Partial<PhotoMeta>) {
  await useLibrary.getState().patch(ids, () => patch);
}
