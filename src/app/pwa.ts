/**
 * PWA integration: service-worker registration with an update prompt (never while an export
 * runs), the "offline ready" state, files opened through the OS (File Handling API), photos shared
 * from other apps (Web Share Target), and persistent storage.
 */
import { create } from 'zustand';
import { useExportQueue } from '../library/exportQueue';
import { enqueueImport, reviewImport, type Incoming } from '../library/importer';
import { openPhoto } from '../library/open';
import { useLibrary } from '../state/libraryStore';
import { isNative } from './native';

interface PwaState {
  offlineReady: boolean;
  needRefresh: boolean;
  persisted: boolean | null;
  update: ((reload?: boolean) => Promise<void>) | null;
  set(p: Partial<PwaState>): void;
}

export const usePwa = create<PwaState>((set) => ({
  offlineReady: false,
  needRefresh: false,
  persisted: null,
  update: null,
  set: (p) => set(p),
}));

export async function initPwa() {
  // The Android / iOS apps ship every file in the bundle and add the isolation headers natively:
  // no service worker (it would only shadow app updates).
  if (isNative()) {
    void requestPersistence();
    return;
  }
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    try {
      const { registerSW } = await import('virtual:pwa-register');
      const update = registerSW({
        immediate: true,
        onNeedRefresh: () => usePwa.getState().set({ needRefresh: true }),
        onOfflineReady: () => {
          usePwa.getState().set({ offlineReady: true });
          try { localStorage.setItem('optic.offlineReady', '1'); } catch { /* no storage */ }
        },
      });
      usePwa.getState().set({ update });
    } catch (e) {
      console.warn('[optic] service worker not registered', e);
    }
  }
  try {
    if (localStorage.getItem('optic.offlineReady') === '1' && navigator.serviceWorker?.controller) usePwa.getState().set({ offlineReady: true });
  } catch { /* no storage */ }
  void requestPersistence();
  handleLaunchQueue();
  void handleShared();
}

/** Apply a waiting update and reload (asks first while an export is running). */
export async function applyUpdate() {
  const job = useExportQueue.getState().job;
  if (job?.status === 'running' && !confirm('An export is running. Reload now? It can be resumed after the reload.')) return;
  await usePwa.getState().update?.(true);
}

/** Ask the browser to keep Optic's storage (originals, catalog) even under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    const persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
    usePwa.getState().set({ persisted });
    return persisted;
  } catch {
    return false;
  }
}

/** Open one photo in the editor, or review several in the import dialog. */
export function ingest(list: Incoming[]) {
  if (!list.length) return;
  if (list.length === 1) {
    useLibrary.getState().set({ view: 'editor' });
    enqueueImport(list, undefined, (id) => void openPhoto(id));
  } else reviewImport(list);
}

/** Files the OS asked Optic to open (installed app, "Open with"). */
function handleLaunchQueue() {
  const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const list = await Promise.all(params.files.map(async (h) => ({ file: await h.getFile(), handle: h, path: h.name })));
    ingest(list);
  });
}

/** Photos shared to Optic: the service worker stashed them in Cache Storage. */
async function handleShared() {
  const url = new URL(location.href);
  if (!url.searchParams.has('share')) return;
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('optic-shared');
    const keys = await cache.keys();
    const list: Incoming[] = [];
    for (const req of keys) {
      const r = await cache.match(req);
      if (!r) continue;
      const name = decodeURIComponent(r.headers.get('x-name') ?? 'shared.jpg');
      const blob = await r.blob();
      list.push({ file: new File([blob], name, { type: blob.type, lastModified: Number(r.headers.get('x-last-modified')) || Date.now() }), path: name });
      await cache.delete(req);
    }
    ingest(list);
  } catch (e) {
    console.warn('[optic] shared photos could not be read', e);
  }
}
