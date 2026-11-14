/**
 * Non-RAW decode → linear float image + proxy + thumbnail. imageDecoder.worker.ts runs it for every
 * non-RAW format (HEIC through `packDecoded`); decodeClient.ts also runs `decodeImage` on the main
 * thread for WebP / AVIF in browsers whose workers have no OffscreenCanvas (the browser decode
 * needs a canvas). HEIC stays out of this module so libheif is not bundled for the main thread.
 */
import { makeDerivatives } from './imageOps';
import { decodeStandard, type StandardDecoded } from './standardDecoder';
import type { DecodeOptions, DecodeResult, SourceFormat } from './types';

type Progress = (f: number, label: string) => void;

export function packDecoded(d: StandardDecoded, format: SourceFormat, opts: DecodeOptions, progress: Progress): DecodeResult {
  progress(0.8, 'Building preview');
  const { proxy, thumb } = makeDerivatives(d.image, opts.proxyLongEdge);
  progress(1, 'Done');
  return {
    format,
    isRaw: false,
    bitDepth: d.bitDepth,
    full: d.image,
    proxy,
    thumb,
    color: d.sourceColor.color,
    info: {},
    decoder: d.decoder,
    warnings: d.sourceColor.warnings,
  };
}

/** JPEG, PNG, TIFF, WebP and AVIF (not HEIC). */
export async function decodeImage(bytes: Uint8Array, format: SourceFormat, opts: DecodeOptions, progress: Progress): Promise<DecodeResult> {
  progress(0.1, 'Decoding');
  return packDecoded(await decodeStandard(bytes, format), format, opts, progress);
}
