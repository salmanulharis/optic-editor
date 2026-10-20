/**
 * Export worker: full-resolution GPU render on an OffscreenCanvas (when the browser supports
 * WebGL2 in workers), resize, metadata, encode. The UI thread stays free throughout.
 */
import * as Comlink from 'comlink';
import { COLOR_SPACES } from '../../color/matrices';
import { buildIcc } from '../metadata/icc';
import { buildExifFromBlocks, exifIfdSpec, patchExif, type ExifBlocks, type ExifWriteOptions } from '../metadata/exif';
import { type ExportRenderInput, renderFullResolution, resampleU16 } from './exportRender';
import { type ExportSettings, outputSize } from './exportSettings';
import { encodeJpeg } from './jpeg';
import { encodePng16 } from './png16';
import { encodeTiff16 } from './tiff';

export interface EncodeRequest {
  rgb16: Uint16Array;
  width: number;
  height: number;
  settings: ExportSettings;
  exif: ExifBlocks | null;
  /** Raw EXIF TIFF structure of a JPEG source (kept verbatim in "keep all" mode). */
  sourceJpegExif: Uint8Array | null;
}

type Progress = (f: number, label: string) => void;

function canRenderHere(): boolean {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    const ok = !!gl && !!gl.getExtension('EXT_color_buffer_float');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

async function encode(req: EncodeRequest, progress: Progress): Promise<Uint8Array> {
  const { settings: s } = req;
  const { width, height } = outputSize(req.width, req.height, s.size);
  let rgb = req.rgb16;
  if (width !== req.width || height !== req.height) {
    progress(0.72, 'Resizing');
    rgb = resampleU16(rgb, req.width, req.height, width, height);
  }
  const icc = buildIcc(s.colorSpace);
  const opts: ExifWriteOptions = {
    mode: s.metadata,
    width,
    height,
    srgb: s.colorSpace === 'srgb',
    software: 'Optic',
  };
  const exifBlob = () =>
    s.metadata === 'strip'
      ? null
      : req.sourceJpegExif
        ? patchExif(req.sourceJpegExif, opts)
        : buildExifFromBlocks(req.exif, opts);
  const encodeProgress = (f: number) => progress(0.75 + 0.25 * f, 'Encoding');
  progress(0.75, 'Encoding');
  if (s.format === 'jpeg') return encodeJpeg(rgb, width, height, { quality: s.quality, icc, exif: exifBlob() });
  if (s.format === 'png') {
    return encodePng16(rgb, width, height, { icc, profileName: COLOR_SPACES[s.colorSpace].label, exif: exifBlob(), onProgress: encodeProgress });
  }
  return encodeTiff16(rgb, width, height, {
    icc,
    metadata: exifIfdSpec(req.exif, opts),
    compression: s.tiffCompression,
    onProgress: encodeProgress,
  });
}

const api = {
  canRenderHere,
  /** Render (GPU, in this worker) + encode. */
  async exportImage(
    input: ExportRenderInput,
    meta: Omit<EncodeRequest, 'rgb16' | 'width' | 'height'>,
    onProgress: Progress,
  ): Promise<Uint8Array> {
    const progress: Progress = (f, l) => void onProgress(f, l);
    const canvas = new OffscreenCanvas(1, 1);
    const img = await renderFullResolution(canvas, input, (f) => progress(0.02 + 0.68 * f, 'Rendering full resolution'));
    const out = await encode({ ...meta, rgb16: img.data, width: img.width, height: img.height }, progress);
    return Comlink.transfer(out, [out.buffer as ArrayBuffer]);
  },
  /** Encode only (the main thread rendered because worker WebGL2 is unavailable). */
  async encode(req: EncodeRequest, onProgress: Progress): Promise<Uint8Array> {
    const out = await encode(req, (f, l) => void onProgress(f, l));
    return Comlink.transfer(out, [out.buffer as ArrayBuffer]);
  },
};

export type ExportWorkerApi = typeof api;
Comlink.expose(api);
