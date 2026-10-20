/** Main-thread export orchestration: save target, worker, fallback, download. */
import * as Comlink from 'comlink';
import { effectiveRecipe } from '../../recipe/schema';
import type { Recipe } from '../../recipe/schema';
import type { LoadedImage } from '../../state/imageStore';
import { extractJpegExif } from '../metadata/exif';
import { lutRegistry } from '../../pipeline/lutRegistry';
import { renderFullResolution } from './exportRender';
import { type ExportSettings, MIME, exportFileName } from './exportSettings';
import type { ExportWorkerApi } from './exportWorker';

type SaveHandle = { createWritable(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }> };

/**
 * Ask for the destination first (File System Access API needs the click's user activation).
 * Returns null when the API is unavailable; throws AbortError if the user cancels.
 */
export async function pickSaveTarget(fileName: string, format: ExportSettings['format']): Promise<SaveHandle | null> {
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<SaveHandle> };
  if (!w.showSaveFilePicker) return null;
  const ext = fileName.split('.').pop()!;
  return w.showSaveFilePicker({
    suggestedName: fileName,
    types: [{ description: format.toUpperCase(), accept: { [MIME[format]]: [`.${ext}`] } }],
  });
}

export async function runExport(
  image: LoadedImage,
  recipe: Recipe,
  settings: ExportSettings,
  handle: SaveHandle | null,
  onProgress: (f: number, label: string) => void,
  signal: AbortSignal,
  fileName = exportFileName(image.fileName, settings.format),
): Promise<void> {
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
  signal.addEventListener('abort', () => worker.terminate());
  try {
    const api = Comlink.wrap<ExportWorkerApi>(worker);
    let sourceJpegExif: Uint8Array | null = null;
    if (image.format === 'jpeg' && settings.metadata !== 'strip') {
      sourceJpegExif = extractJpegExif(new Uint8Array(await image.file.slice(0, 256 * 1024).arrayBuffer()));
    }
    const eff = effectiveRecipe(recipe, image.asShot);
    const lut = lutRegistry.get(eff.lut.id);
    const input = {
      full: image.full,
      proxy: image.proxy,
      luts: lut ? [lut] : [],
      image: image.model,
      recipe: eff,
      target: { mode: 'encoded' as const, space: settings.colorSpace, dither: false, clipOverlay: false },
    };
    const meta = { settings, exif: image.exif, sourceJpegExif };
    const progress = Comlink.proxy(onProgress);
    let bytes: Uint8Array;
    if (await api.canRenderHere()) {
      // With SharedArrayBuffer the pixels are shared, not copied.
      bytes = await api.exportImage(input, meta, progress);
    } else {
      const canvas = document.createElement('canvas');
      const img = await renderFullResolution(
        canvas,
        input,
        (f) => onProgress(0.02 + 0.68 * f, 'Rendering full resolution'),
        () => new Promise((r) => setTimeout(r, 0)),
      );
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      bytes = await api.encode(
        Comlink.transfer({ ...meta, rgb16: img.data, width: img.width, height: img.height }, [img.data.buffer]),
        progress,
      );
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const blob = new Blob([bytes as BlobPart], { type: MIME[settings.format] });
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    onProgress(1, 'Saved');
  } finally {
    worker.terminate();
  }
}
