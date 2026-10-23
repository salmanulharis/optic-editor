/**
 * OPFS writes through synchronous access handles (supported in workers by Chrome, Edge, Safari and
 * Firefox, unlike createWritable on the main thread). Files are streamed in chunks, so a 100 MB RAW
 * never has to be in memory at once.
 */
import * as Comlink from 'comlink';

async function dirFor(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  let dir = await navigator.storage.getDirectory();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

type SyncHandle = { write(b: ArrayBufferView, o?: { at: number }): number; truncate(n: number): void; flush(): void; close(): void; getSize(): number };

const api = {
  /** Write a Blob (streamed) or bytes to `path`, replacing it. */
  async write(path: string, data: Blob | Uint8Array): Promise<number> {
    const { dir, name } = await dirFor(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
    try {
      h.truncate(0);
      let at = 0;
      if (data instanceof Uint8Array) {
        at += h.write(data, { at });
      } else {
        const reader = data.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          at += h.write(value, { at });
        }
      }
      h.flush();
      return at;
    } finally {
      h.close();
    }
  },
  /** Append bytes at the end of `path` (export ZIP streaming). Returns the new size. */
  async append(path: string, data: Uint8Array): Promise<number> {
    const { dir, name } = await dirFor(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
    try {
      const at = h.getSize();
      h.write(data, { at });
      h.flush();
      return at + data.length;
    } finally {
      h.close();
    }
  },
  /** Cut a file back to `size` bytes (drop a partly written ZIP entry before resuming). */
  async truncate(path: string, size: number) {
    const { dir, name } = await dirFor(path, false);
    const fh = await dir.getFileHandle(name);
    const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
    try { h.truncate(size); h.flush(); } finally { h.close(); }
  },
  /** Write `data` at an offset (ZIP header patching). */
  async writeAt(path: string, data: Uint8Array, at: number) {
    const { dir, name } = await dirFor(path, false);
    const fh = await dir.getFileHandle(name);
    const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
    try { h.write(data, { at }); h.flush(); } finally { h.close(); }
  },
};

export type OpfsWorkerApi = typeof api;
Comlink.expose(api);
