/**
 * Export worker: full-resolution GPU render on an OffscreenCanvas (when the browser supports
 * WebGL2 in workers), resize, metadata, encode. The UI thread stays free throughout.
 */
import * as Comlink from 'comlink';
import { COLOR_SPACES } from '../../color/matrices';
import { buildIcc } from '../metadata/icc';
import { buildExifFromBlocks, exifIfdSpec, patchExif, type ExifBlocks, type ExifWriteOptions } from '../metadata/exif';
import { type ExportRenderInput, renderFullResolution, resampleU16 } from './exportRender';
import { type ExportSettings, normalizeSettings, outputSize } from './exportSettings';
import { ditherTo8, encodeJpeg } from './jpeg';
import { applyWatermark, buildXmp, cropCenter, sharpenForOutput } from './postprocess';
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
  const s = normalizeSettings(req.settings);
  const size = outputSize(req.width, req.height, s.size, s.allowUpscale);
  let rgb = req.rgb16;
  let W = req.width, H = req.height;
  if (size.cropW !== W || size.cropH !== H) {
    rgb = cropCenter(rgb, W, H, size.cropW, size.cropH);
    W = size.cropW; H = size.cropH;
  }
  const { width, height } = size;
  if (width !== W || height !== H) {
    progress(0.72, 'Resizing');
    rgb = resampleU16(rgb, W, H, width, height);
  }
  if (s.sharpen.target !== 'none') {
    progress(0.73, 'Output sharpening');
    rgb = sharpenForOutput(rgb, width, height, s.sharpen.target, s.sharpen.amount);
  }
  if (s.watermark.enabled) await applyWatermark(rgb, width, height, s.watermark);
  const icc = buildIcc(s.colorSpace);
  const opts: ExifWriteOptions = {
    mode: s.metadata,
    width,
    height,
    srgb: s.colorSpace === 'srgb',
    software: 'Optic',
    artist: s.author.artist,
    copyright: s.author.copyright,
    dpi: s.dpi,
  };
  // The source JPEG's EXIF is copied verbatim only when nothing has to be added to it.
  const verbatim = req.sourceJpegExif && (s.metadata === 'keep' || s.metadata === 'stripGps') && !s.author.artist.trim() && !s.author.copyright.trim();
  const exifBlob = () =>
    s.metadata === 'strip'
      ? null
      : verbatim
        ? patchExif(req.sourceJpegExif!, opts)
        : buildExifFromBlocks(req.exif, opts);
  const xmp = s.metadata === 'strip' ? null : buildXmp(s.author.artist.trim(), s.author.copyright.trim());
  const encodeProgress = (f: number) => progress(0.75 + 0.25 * f, 'Encoding');
  progress(0.75, 'Encoding');
  switch (s.format) {
    case 'jpeg':
      return encodeJpeg(rgb, width, height, { quality: s.quality, icc, exif: exifBlob(), xmp });
    case 'png':
      return encodePng16(rgb, width, height, { icc, profileName: COLOR_SPACES[s.colorSpace].label, exif: exifBlob(), xmp, dpi: s.dpi, onProgress: encodeProgress });
    case 'avif':
      return encodeAvif10(rgb, width, height, s.quality);
    case 'jxl':
      return encodeJxl8(rgb, width, height, s.quality);
    default:
      return encodeTiff16(rgb, width, height, {
        icc,
        metadata: exifIfdSpec(req.exif, opts),
        compression: s.tiffCompression,
        dpi: s.dpi,
        xmp,
        onProgress: encodeProgress,
      });
  }
}

/** AVIF, 10 bits per channel from the 16-bit render (sRGB, BT.709 signalling). */
async function encodeAvif10(rgb: Uint16Array, w: number, h: number, quality: number): Promise<Uint8Array> {
  const { default: encode } = await import('@jsquash/avif/encode');
  const data = new Uint16Array(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    data[j] = (rgb[i] * 1023 + 32767) / 65535;
    data[j + 1] = (rgb[i + 1] * 1023 + 32767) / 65535;
    data[j + 2] = (rgb[i + 2] * 1023 + 32767) / 65535;
    data[j + 3] = 1023;
  }
  const out = await encode({ data, width: w, height: h }, { bitDepth: 10, quality, speed: 6, subsample: quality >= 90 ? 3 : 1 });
  return new Uint8Array(out);
}

/** JPEG XL (8-bit sRGB, dithered from the 16-bit render). */
async function encodeJxl8(rgb: Uint16Array, w: number, h: number, quality: number): Promise<Uint8Array> {
  const { default: encode } = await import('@jsquash/jxl/encode');
  const out = await encode(ditherTo8(rgb, w, h), { quality, effort: 7 });
  return new Uint8Array(out);
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
