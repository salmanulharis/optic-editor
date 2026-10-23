import { enqueueImport } from '../library/importer';
import { openPhoto } from '../library/open';
import { isIOS } from '../ui/mobile/layout';
import { useSettings } from '../state/settingsStore';

/** Proxy long edge = min(original, 2 × canvas CSS size × DPR, 4096); the worker caps at the original. */
export function proxyLongEdge(): number {
  const canvas = document.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const css = canvas ? Math.max(canvas.clientWidth, canvas.clientHeight) : Math.max(window.innerWidth, window.innerHeight);
  // iOS / iPadOS give a web page far less GPU and heap memory: a smaller working texture.
  const q = useSettings.getState().previewQuality;
  const want = q === 'quality' ? 4096 : q === 'performance' ? Math.min(2048, Math.ceil(1.5 * css * dpr)) : Math.ceil(2 * css * dpr);
  return Math.min(isIOS() ? 2560 : 4096, want);
}

/**
 * Open a single file in the editor: it is imported into the library first (copied into Optic,
 * duplicates reuse the existing photo and its edits), then opened.
 */
export function openFile(file: File, handle?: FileSystemFileHandle) {
  enqueueImport([{ file, handle, path: file.name }], undefined, (id) => void openPhoto(id));
}
