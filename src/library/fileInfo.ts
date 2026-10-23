/**
 * Cheap per-file facts for import: a duplicate-detection hash, the capture metadata, and a quick
 * preview (the camera's embedded JPEG for RAW files, the browser's own decoder for JPEG / PNG /
 * WebP / AVIF), shown until Optic's own render of the photo replaces it.
 */
import exifr from 'exifr';
import { detectFormat } from '../io/decode/decodeClient';
import type { SourceFormat } from '../io/decode/types';
import { cameraInfoFromExif, orientationFromExif, readExifBlocks, type ExifBlocks } from '../io/metadata/exif';
import { TiffReader } from '../io/metadata/tiffReader';

const MB = 1024 * 1024;

/** SHA-256 of the size, the first 2 MB and the last 1 MB: identical files collide, others don't in practice. */
export async function fileHash(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2 * MB).arrayBuffer());
  const tail = file.size > 3 * MB ? new Uint8Array(await file.slice(file.size - MB).arrayBuffer()) : new Uint8Array(0);
  const buf = new Uint8Array(8 + head.length + tail.length);
  new DataView(buf.buffer).setFloat64(0, file.size);
  buf.set(head, 8);
  buf.set(tail, 8 + head.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FileFacts {
  format: SourceFormat | 'unknown';
  isRaw: boolean;
  camera: string;
  lens: string;
  iso?: number;
  shutter?: number;
  aperture?: number;
  focal?: number;
  captureDate: number;
  hasGps: boolean;
  orientation: number;
  width: number;
  height: number;
  exif: ExifBlocks | null;
}

function parseExifDate(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

export async function fileFacts(file: File): Promise<FileFacts> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const format = detectFormat(file.name, head) ?? 'unknown';
  const exif = await readExifBlocks(file);
  const info = cameraInfoFromExif(exif);
  const make = info.make ?? '', model = info.model ?? '';
  const camera = model.startsWith(make) ? model : [make, model].filter(Boolean).join(' ');
  const w = Number(exif?.exif[40962] ?? exif?.ifd0[256] ?? 0) || 0;
  const h = Number(exif?.exif[40963] ?? exif?.ifd0[257] ?? 0) || 0;
  const orientation = orientationFromExif(exif);
  const swap = orientation >= 5;
  return {
    format,
    isRaw: format === 'dng' || format === 'raw',
    camera,
    lens: info.lens ?? '',
    iso: info.iso,
    shutter: info.shutter,
    aperture: info.aperture,
    focal: info.focalLength,
    captureDate: parseExifDate(info.date) ?? file.lastModified ?? Date.now(),
    hasGps: !!exif && Object.keys(exif.gps).length > 0,
    orientation,
    width: swap ? h : w,
    height: swap ? w : h,
    exif,
  };
}

/** Largest embedded JPEG of a TIFF-based RAW (DNG, CR2, NEF, ARW, ORF, RW2 …), as a Blob slice. */
async function embeddedJpeg(file: File): Promise<Blob | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 2 * MB).arrayBuffer());
    const t = new TiffReader(head);
    let best: { off: number; len: number } | null = null;
    const consider = (off?: number, len?: number) => {
      if (!off || !len || off + len > file.size || len < 2048) return;
      if (!best || len > best.len) best = { off, len };
    };
    for (const ifd of t.allIfds()) {
      consider(t.get(ifd, 513)?.[0], t.get(ifd, 514)?.[0]);
      const comp = t.get(ifd, 259)?.[0];
      const photometric = t.get(ifd, 262)?.[0];
      const bits = t.get(ifd, 258)?.[0];
      const strips = t.get(ifd, 273), counts = t.get(ifd, 279);
      // A baseline JPEG strip (YCbCr / RGB, 8-bit), not lossless-JPEG raw data.
      if ((comp === 6 || comp === 7) && (photometric === 6 || photometric === 2) && (bits ?? 8) === 8 && strips?.length === 1 && counts?.length === 1) {
        consider(strips[0], counts[0]);
      }
    }
    const b = best as { off: number; len: number } | null;
    if (!b) return null;
    const blob = file.slice(b.off, b.off + b.len, 'image/jpeg');
    const sig = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    return sig[0] === 0xff && sig[1] === 0xd8 ? blob : null;
  } catch {
    return null;
  }
}

/** Draw a bitmap upright (EXIF orientation 1…8) and scaled to fit `edge`. */
function orient(bmp: ImageBitmap, orientation: number, edge: number): OffscreenCanvas {
  const swap = orientation >= 5;
  const w0 = swap ? bmp.height : bmp.width, h0 = swap ? bmp.width : bmp.height;
  const k = Math.min(1, edge / Math.max(w0, h0));
  const W = Math.max(1, Math.round(w0 * k)), H = Math.max(1, Math.round(h0 * k));
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const bw = swap ? H : W, bh = swap ? W : H;
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, W, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, W, H); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, H); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, W, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, W, H); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, H); break;
  }
  ctx.drawImage(bmp, 0, 0, bw, bh);
  return c;
}

export const PREVIEW_EDGE = 2560;
export const THUMB_EDGE = 512;

export interface QuickPreview {
  thumb: Blob;
  preview: Blob | null;
  width: number;
  height: number;
}

/** Encode a canvas: WebP where supported (smaller), else JPEG. */
export async function encodeCanvas(c: OffscreenCanvas, quality = 0.85): Promise<Blob> {
  const webp = await c.convertToBlob({ type: 'image/webp', quality });
  return webp.type === 'image/webp' ? webp : c.convertToBlob({ type: 'image/jpeg', quality });
}

/**
 * A quick thumbnail (and a preview if the source is large enough) without decoding the RAW data.
 * Null when there is nothing to show quickly (HEIC, CR3): the background render provides it.
 */
export async function quickPreview(file: File, facts: Pick<FileFacts, 'format' | 'orientation'>): Promise<QuickPreview | null> {
  let src: Blob | null = null;
  let orientation = 1;
  if (facts.format === 'jpeg' || facts.format === 'png' || facts.format === 'webp' || facts.format === 'avif') src = file;
  else if (facts.format === 'dng' || facts.format === 'raw' || facts.format === 'tiff') {
    src = await embeddedJpeg(file);
    orientation = facts.orientation;
    if (!src) {
      const t = await exifr.thumbnail(file).catch(() => undefined);
      if (t) src = new Blob([t as BlobPart], { type: 'image/jpeg' });
    }
  }
  if (!src) return null;
  try {
    // JPEGs carry their own orientation, applied by the browser; embedded previews don't.
    const bmp = await createImageBitmap(src, { imageOrientation: src === file ? 'from-image' : 'none' } as ImageBitmapOptions);
    // Camera previews are stored like the sensor data (landscape), except some (Apple ProRAW)
    // that are already upright: a portrait preview needs no quarter turn.
    if (orientation >= 5 && bmp.height > bmp.width) orientation = 1;
    try {
      const big = Math.max(bmp.width, bmp.height);
      const thumb = await encodeCanvas(orient(bmp, orientation, THUMB_EDGE), 0.82);
      const preview = big >= 1200 ? await encodeCanvas(orient(bmp, orientation, PREVIEW_EDGE), 0.85) : null;
      const swap = orientation >= 5;
      return { thumb, preview, width: swap ? bmp.height : bmp.width, height: swap ? bmp.width : bmp.height };
    } finally {
      bmp.close();
    }
  } catch {
    return null;
  }
}
