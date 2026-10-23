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

async function dirFor(path: string, create: boolean) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  let dir = await navigator.storage.getDirectory();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

export async function writeFile(path: string, data: Blob | Uint8Array): Promise<number> {
  return opfsWorker().write(path, data instanceof Uint8Array ? Comlink.transfer(data, [data.buffer as ArrayBuffer]) : data);
}

export async function appendFile(path: string, data: Uint8Array): Promise<number> {
  return opfsWorker().append(path, Comlink.transfer(data, [data.buffer as ArrayBuffer]));
}

export async function truncateFile(path: string, size: number) {
  return opfsWorker().truncate(path, size);
}

export async function writeFileAt(path: string, data: Uint8Array, at: number) {
  return opfsWorker().writeAt(path, data, at);
}

export async function readFile(path: string): Promise<File | null> {
  try {
    const { dir, name } = await dirFor(path, false);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function removeEntry(path: string) {
  try {
    const { dir, name } = await dirFor(path, false);
    await dir.removeEntry(name, { recursive: true });
  } catch { /* already gone */ }
}

/** Total bytes of everything under a directory (storage panel). */
export async function dirSize(path: string): Promise<number> {
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
