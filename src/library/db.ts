/**
 * The catalog: one IndexedDB database (Dexie) holding every photo's record (file reference, hash,
 * metadata, rating / flag / label / keywords / collections, the current recipe of its main copy),
 * the edit documents (history, snapshots, virtual copies), collections, export presets and the
 * export queue. Originals and cached previews live in OPFS (see opfs.ts); the catalog only refers to
 * them. Ratings and keywords are photo metadata, never part of a recipe or a preset.
 */
import Dexie, { type Table } from 'dexie';
import type { SourceFormat } from '../io/decode/types';
import type { DocRecord } from '../state/editStore';

export type ColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export const COLOR_LABELS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];
export const LABEL_CSS: Record<ColorLabel, string> = { red: '#d9534f', yellow: '#e6c84a', green: '#5cb85c', blue: '#4a8fd9', purple: '#9b6bd6' };

export type Flag = -1 | 0 | 1;

export interface PhotoMeta {
  rating: number; // 0…5
  flag: Flag; // -1 rejected, 0 none, 1 pick
  label: ColorLabel | null;
  keywords: string[];
}

export interface PhotoRecord extends PhotoMeta {
  id: string;
  /** Identity of the edit document and seed of image-anchored patterns (grain). */
  key: string;
  fileName: string;
  size: number;
  lastModified: number;
  /** SHA-256 of size + head + tail of the file (duplicate detection). */
  hash: string;
  /** "Copy into Optic" (OPFS) or "Reference in place" (File System Access handle). */
  storage: 'opfs' | 'handle';
  opfsPath?: string;
  handle?: FileSystemFileHandle;
  format: SourceFormat | 'unknown';
  isRaw: boolean;
  width: number;
  height: number;
  camera: string;
  lens: string;
  iso?: number;
  shutter?: number;
  aperture?: number;
  focal?: number;
  hasGps: boolean;
  /** ms since epoch: capture (EXIF, else file date), import, last edit. */
  captureDate: number;
  importDate: number;
  editDate: number;
  collections: string[];
  edited: boolean;
  /** Name of the preset applied to the main copy, if any. */
  preset: string | null;
  /** Number of virtual copies (besides the original). */
  copies: number;
  /** Serialized recipe of the main copy's current state (null = never edited). */
  recipe: unknown | null;
  /** Version stamps of the cached thumbnail / preview files (0 = none). */
  thumb: number;
  preview: number;
  /** The cached images come from an embedded camera preview (not yet rendered by Optic). */
  previewEmbedded: boolean;
  /** Set when the file could not be decoded. */
  error?: string;
  /** Preset chosen at import, applied when the photo is first decoded (it needs As Shot WB). */
  pendingPreset?: { id: string; amount: number } | null;
}

export interface LibraryFilter {
  text?: string;
  minRating?: number;
  ratingOp?: '>=' | '==' | '<=';
  flag?: 'any' | 'picked' | 'rejected' | 'unflagged' | 'notRejected';
  labels?: ColorLabel[];
  formats?: string[];
  raw?: 'any' | 'raw' | 'nonRaw';
  edited?: 'any' | 'edited' | 'unedited';
  camera?: string;
  lens?: string;
  /** ISO dates (inclusive), or a rolling window in days. */
  from?: string;
  to?: string;
  lastDays?: number;
  keyword?: string;
  preset?: string;
}

export interface CollectionRecord {
  id: string;
  name: string;
  kind: 'manual' | 'smart';
  filter?: LibraryFilter;
  created: number;
}

export interface KV {
  k: string;
  v: unknown;
}

class CatalogDB extends Dexie {
  photos!: Table<PhotoRecord, string>;
  collections!: Table<CollectionRecord, string>;
  docs!: Table<DocRecord, string>;
  exportPresets!: Table<{ id: string; name: string; settings: unknown }, string>;
  exportQueue!: Table<{ id: string; job: unknown }, string>;
  kv!: Table<KV, string>;

  constructor() {
    super('optic-catalog');
    this.version(1).stores({
      photos: 'id, hash, key, captureDate, importDate, editDate, fileName, rating, *keywords, *collections',
      collections: 'id, name',
      docs: 'key',
      exportPresets: 'id',
      exportQueue: 'id',
      kv: 'k',
    });
  }
}

export const catalog = new CatalogDB();

export async function kvGet<T>(k: string, d: T): Promise<T> {
  try {
    const r = await catalog.kv.get(k);
    return r ? (r.v as T) : d;
  } catch {
    return d;
  }
}

export async function kvSet(k: string, v: unknown) {
  try { await catalog.kv.put({ k, v }); } catch (e) { console.warn('[optic] setting not saved', e); }
}
