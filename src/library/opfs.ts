/**
 * Origin Private File System storage: imported originals (`originals/<id>/<name>`) and cached
 * previews (`previews/<id>/thumb.<ext>`, `previews/<id>/preview.<ext>`). Reads happen here (OPFS
 * File objects are disk-backed, never loaded whole); writes go through a worker (opfs.worker.ts).
 */
import * as Comlink from 'comlink';
import type { OpfsWorkerApi } from './opfs.worker';

let worker: Comlink.Remote<OpfsWorkerApi> | null = null;
const opfsWorker = () => (worker ??= Comlink.wrap<OpfsWorkerApi>(new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' })));

export const opfsAvailable = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

/**
 * Session fallback for browsers without OPFS (private windows, some engines): the same files kept
 * in memory until the tab closes, so previews, thumbnails and ZIP exports still work. Imports in
 * such browsers are flagged as session-only in the import dialog (see sessionFiles.ts).
 */
const memory = new Map<string, Blob>();
const inMemory = () => !opfsAvailable();
const memWrite = (path: string, blob: Blob) => { memory.set(path, blob); return blob.size; };

async function dirFor(path: string, create: boolean) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  let dir = await navigator.storage.getDirectory();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

export async function writeFile(path: string, data: Blob | Uint8Array): Promise<number> {
  if (inMemory()) return memWrite(path, data instanceof Uint8Array ? new Blob([data as BlobPart]) : data);
  return opfsWorker().write(path, data instanceof Uint8Array ? Comlink.transfer(data, [data.buffer as ArrayBuffer]) : data);
}

export async function appendFile(path: string, data: Uint8Array): Promise<number> {
  if (inMemory()) return memWrite(path, new Blob([memory.get(path) ?? new Blob(), data as BlobPart]));
  return opfsWorker().append(path, Comlink.transfer(data, [data.buffer as ArrayBuffer]));
}

export async function truncateFile(path: string, size: number) {
  if (inMemory()) { const b = memory.get(path); if (b) memWrite(path, b.slice(0, size)); return; }
  return opfsWorker().truncate(path, size);
}

export async function writeFileAt(path: string, data: Uint8Array, at: number) {
  if (inMemory()) {
    const b = memory.get(path) ?? new Blob();
    const pad = at > b.size ? new Uint8Array(at - b.size) : new Uint8Array(0);
    return memWrite(path, new Blob([b.slice(0, at), pad, data as BlobPart, b.slice(at + data.length)]));
  }
  return opfsWorker().writeAt(path, data, at);
}

export async function readFile(path: string): Promise<File | null> {
  if (inMemory()) {
    const b = memory.get(path);
    return b ? new File([b], path.split('/').pop() ?? 'file', { type: b.type }) : null;
  }
  try {
    const { dir, name } = await dirFor(path, false);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function removeEntry(path: string) {
  if (inMemory()) {
    for (const k of [...memory.keys()]) if (k === path || k.startsWith(`${path}/`)) memory.delete(k);
    return;
  }
  try {
    const { dir, name } = await dirFor(path, false);
    await dir.removeEntry(name, { recursive: true });
  } catch { /* already gone */ }
}

/** Total bytes of everything under a directory (storage panel). */
export async function dirSize(path: string): Promise<number> {
  if (inMemory()) {
    let total = 0;
    for (const [k, b] of memory) if (k.startsWith(`${path}/`)) total += b.size;
    return total;
  }
  try {
    const parts = path.split('/').filter(Boolean);
    let dir = await navigator.storage.getDirectory();
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    let total = 0;
    const walk = async (d: FileSystemDirectoryHandle) => {
      for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (h.kind === 'file') total += (await (h as FileSystemFileHandle).getFile()).size;
        else await walk(h as FileSystemDirectoryHandle);
      }
    };
    await walk(dir);
    return total;
  } catch {
    return 0;
  }
}
