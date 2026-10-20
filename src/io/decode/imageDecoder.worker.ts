/** Decode worker for non-RAW formats (HEIC/HEIF, JPEG, PNG, TIFF, WebP, AVIF). */
import * as Comlink from 'comlink';
import { decodeHeic } from './heicDecoder';
import { makeDerivatives } from './imageOps';
import { decodeStandard } from './standardDecoder';
import type { DecodeOptions, DecodeResult, ProgressFn, SourceFormat } from './types';

const api = {
  async decode(bytes: Uint8Array, format: SourceFormat, opts: DecodeOptions, onProgress: ProgressFn): Promise<DecodeResult> {
    const progress: ProgressFn = (f, l) => void onProgress(f, l);
    progress(0.1, 'Decoding');
    const d = format === 'heic' ? await decodeHeic(bytes) : await decodeStandard(bytes, format);
    progress(0.8, 'Building preview');
    const { proxy, thumb } = makeDerivatives(d.image, opts.proxyLongEdge);
    progress(1, 'Done');
    const result: DecodeResult = {
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
    // Shared buffers are visible to every thread already; only plain ArrayBuffers are transferred.
    const transfers = [d.image.data.buffer, proxy.data.buffer, thumb.data.buffer].filter((b): b is ArrayBuffer => !(b instanceof SharedArrayBuffer));
    return Comlink.transfer(result, transfers);
  },
};

export type ImageDecoderApi = typeof api;
Comlink.expose(api);
