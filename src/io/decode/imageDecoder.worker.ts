/** Decode worker for non-RAW formats (HEIC/HEIF, JPEG, PNG, TIFF, WebP, AVIF): see imageDecode.ts. */
import * as Comlink from 'comlink';
import { decodeHeic } from './heicDecoder';
import { decodeImage, packDecoded } from './imageDecode';
import { transferable } from './imageOps';
import type { DecodeOptions, DecodeResult, ProgressFn, SourceFormat } from './types';

const api = {
  async decode(bytes: Uint8Array, format: SourceFormat, opts: DecodeOptions, onProgress: ProgressFn): Promise<DecodeResult> {
    const progress = (f: number, l: string) => void onProgress(f, l);
    let result: DecodeResult;
    if (format === 'heic') {
      progress(0.1, 'Decoding');
      result = packDecoded(await decodeHeic(bytes), format, opts, progress);
    } else {
      result = await decodeImage(bytes, format, opts, progress);
    }
    // Shared buffers are visible to every thread already; only plain ArrayBuffers are transferred.
    const transfers = transferable([result.full.data.buffer, result.proxy.data.buffer, result.thumb.data.buffer]);
    return Comlink.transfer(result, transfers);
  },
};

export type ImageDecoderApi = typeof api;
Comlink.expose(api);
