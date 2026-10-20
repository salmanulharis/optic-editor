/** Main-thread entry point for decoding: picks a worker, reports progress, supports cancel. */
import * as Comlink from 'comlink';
import { cameraInfoFromExif, readExifBlocks, type ExifBlocks } from '../metadata/exif';
import type { ImageDecoderApi } from './imageDecoder.worker';
import type { RawDecoderApi } from './rawDecoder.worker';
import type { DecodeResult, ProgressFn, SourceFormat } from './types';

const RAW_EXT = new Set(['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'rw2', 'orf', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'erf', 'mos', 'mrw', 'kdc', 'dcr', 'raw', 'rwl', 'gpr']);

export const ACCEPT =
  '.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.rw2,.orf,.pef,.srw,.3fr,.iiq,.rwl,.heic,.heif,.hif,.jpg,.jpeg,.png,.tif,.tiff,.webp,.avif';

export function detectFormat(name: string, head: Uint8Array): SourceFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const s = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n));
  if (ext === 'dng') return 'dng';
  if (RAW_EXT.has(ext)) return 'raw';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head[0] === 0x89 && s(1, 3) === 'PNG') return 'png';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (s(4, 4) === 'ftyp') {
    const brand = s(8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand === 'crx ') return 'raw';
    return 'heic';
  }
  if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) return ext === 'tif' || ext === 'tiff' ? 'tiff' : 'raw';
  if (ext === 'heic' || ext === 'heif' || ext === 'hif') return 'heic';
  return null;
}

export interface DecodeJob {
  promise: Promise<{ result: DecodeResult; exif: ExifBlocks | null }>;
  cancel(): void;
}

export function decodeFile(file: File, proxyLongEdge: number, onProgress: ProgressFn): DecodeJob {
  let worker: Worker | null = null;
  let cancelled = false;
  let rejectFn: (e: Error) => void = () => {};

  const promise = new Promise<{ result: DecodeResult; exif: ExifBlocks | null }>((resolve, reject) => {
    rejectFn = reject;
    (async () => {
      onProgress(0.01, 'Reading file');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (cancelled) return;
      const format = detectFormat(file.name, bytes.subarray(0, 32));
      if (!format) throw new Error(`Unsupported file type: ${file.name}`);
      const exifPromise = readExifBlocks(file);
      const progress = Comlink.proxy(onProgress);
      let result: DecodeResult;
      if (format === 'dng' || format === 'raw') {
        worker = new Worker(new URL('./rawDecoder.worker.ts', import.meta.url), { type: 'module' });
        const api = Comlink.wrap<RawDecoderApi>(worker);
        result = await api.decode(Comlink.transfer(bytes, [bytes.buffer]), file.name, { proxyLongEdge }, progress);
      } else {
        worker = new Worker(new URL('./imageDecoder.worker.ts', import.meta.url), { type: 'module' });
        const api = Comlink.wrap<ImageDecoderApi>(worker);
        result = await api.decode(Comlink.transfer(bytes, [bytes.buffer]), format, { proxyLongEdge }, progress);
      }
      const exif = await exifPromise;
      // Prefer EXIF for display info; LibRaw fills the gaps for vendor RAWs exifr cannot read.
      const fromExif = cameraInfoFromExif(exif);
      for (const [k, v] of Object.entries(fromExif)) if (v !== undefined) (result.info as Record<string, unknown>)[k] = v;
      resolve({ result, exif });
    })()
      .catch((e) => reject(e instanceof Error ? e : new Error(String(e))))
      .finally(() => worker?.terminate());
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      worker?.terminate();
      rejectFn(new DOMException('Cancelled', 'AbortError') as unknown as Error);
    },
  };
}
