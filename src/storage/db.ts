/**
 * IndexedDB persistence for user presets, imported LUTs (structured-clone values, so LUT
 * Float32Arrays are stored as-is) and per-photo edit documents (history, snapshots, virtual
 * copies). Small conveniences (favourites, recents) live in localStorage.
 * Every call fails soft: private windows / blocked storage just mean nothing is remembered.
 */

const DB_NAME = 'optic';
const DB_VERSION = 2;
export type StoreName = 'presets' | 'luts' | 'docs';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('luts')) db.createObjectStore('luts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  try {
    return await tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  } catch (e) {
    console.warn(`[optic] could not read ${store}`, e);
    return [];
  }
}

export async function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    return await tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  } catch (e) {
    console.warn(`[optic] could not read ${store}/${key}`, e);
    return undefined;
  }
}

export async function dbPut<T>(store: StoreName, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value));
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
