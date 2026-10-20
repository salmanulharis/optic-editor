/**
 * Non-RAW decoders: JPEG, PNG (8/16), TIFF (8/16/32f), WebP, AVIF.
 * Every path ends in linear float RGB in the *source* primaries plus an RGB→XYZ matrix; the
 * conversion to the working space happens on the GPU (pipeline stage 20).
 * Transfer curves come from the embedded ICC profile (any matrix/TRC profile), falling back to sRGB.
 */
import decodeJpeg from '@jsquash/jpeg/decode.js';
import { decode as decodePng } from '@jsquash/png/decode.js';
import pako from 'pako';
import { COLOR_SPACES, toXYZ_D65 } from '../../color/matrices';
import { type ToneCurve, buildDecodeLut, curveForSpace, evalCurve } from '../../color/transfer';
import { parseIcc } from '../metadata/icc';
import { findColr, nclxIsHdr, nclxSpace } from '../metadata/isobmff';
import { TiffReader } from '../metadata/tiffReader';
import { extractJpegExif } from '../metadata/exif';
import { allocFloat, applyOrientation } from './imageOps';
import type { FloatImage, ImageColor, SourceFormat } from './types';

(globalThis as unknown as { pako: typeof pako }).pako = pako; // UTIF expects a global for Deflate TIFFs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UTIF: any = null;

export interface SourceColor {
  color: ImageColor;
  curves: [ToneCurve, ToneCurve, ToneCurve];
  warnings: string[];
}

export function colorFromIcc(icc: Uint8Array | null | undefined, warnings: string[] = []): SourceColor {
  if (icc && icc.length) {
    const p = parseIcc(icc);
    if (p) {
      return {
        color: {
          kind: 'display',
          toXYZ: p.toXYZ,
          spaceId: p.spaceId,
          spaceLabel: p.spaceId ? COLOR_SPACES[p.spaceId].label : p.description || 'Embedded ICC',
        },
        curves: p.curves,
        warnings,
      };
    }
    warnings.push('Embedded ICC profile is LUT-based (unsupported); assuming sRGB');
  }
  return colorFromSpace('srgb', warnings);
}

export function colorFromSpace(id: keyof typeof COLOR_SPACES, warnings: string[] = []): SourceColor {
  const c = curveForSpace(id);
  return {
    color: { kind: 'display', toXYZ: toXYZ_D65(id), spaceId: id, spaceLabel: COLOR_SPACES[id].label },
    curves: [c, c, c],
    warnings,
  };
}

/**
 * Integer samples → linear float RGB through per-channel LUTs.
 * `channels` is the interleave stride of the source (3 or 4); gray sources use 1.
 */
export function linearizeInts(
  src: ArrayLike<number>,
  channels: number,
  width: number,
  height: number,
  maxCode: number,
  curves: [ToneCurve, ToneCurve, ToneCurve],
): FloatImage {
  const luts = curves.map((c) => buildDecodeLut(c, maxCode));
  const n = width * height;
  const out = allocFloat(n * 3);
  if (channels === 1) {
    for (let i = 0; i < n; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = luts[0][src[i]];
  } else {
    for (let i = 0, s = 0; i < n; i++, s += channels) {
      out[i * 3] = luts[0][src[s]];
      out[i * 3 + 1] = luts[1][src[s + 1]];
      out[i * 3 + 2] = luts[2][src[s + 2]];
    }
  }
  return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// Embedded profile extraction
// ---------------------------------------------------------------------------

function jpegIcc(b: Uint8Array): Uint8Array | null {
  const parts: Array<[number, Uint8Array]> = [];
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const m = b[o + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xe2 && String.fromCharCode(...b.subarray(o + 4, o + 15)) === 'ICC_PROFILE') {
      parts.push([b[o + 16], b.subarray(o + 18, o + 2 + len)]);
    }
    o += 2 + len;
  }
  if (!parts.length) return null;
  parts.sort((a, c) => a[0] - c[0]);
  const total = parts.reduce((s, p) => s + p[1].length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const [, d] of parts) { out.set(d, p); p += d.length; }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function pngInfo(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const bitDepth = b[24];
  let icc: Uint8Array | null = null;
  let srgbChunk = false;
  let o = 8;
  while (o + 8 < b.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'iCCP') {
      const body = b.subarray(o + 8, o + 8 + len);
      const nul = body.indexOf(0);
      try { icc = await inflate(body.subarray(nul + 2)); } catch { icc = null; }
    } else if (type === 'sRGB') srgbChunk = true;
    else if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { bitDepth, icc: srgbChunk ? null : icc };
}

function webpIcc(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12;
  while (o + 8 <= b.length) {
    const type = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const len = dv.getUint32(o + 4, true);
    if (type === 'ICCP') return b.slice(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  return null;
}

function jpegOrientation(b: Uint8Array): number {
  const exif = extractJpegExif(b);
  if (!exif) return 1;
  try {
    const r = new TiffReader(exif);
    const o = r.get(r.ifds[0], 274)?.[0] ?? 1;
    return o >= 1 && o <= 8 ? o : 1;
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export interface StandardDecoded {
  image: FloatImage;
  sourceColor: SourceColor;
  bitDepth: number;
  decoder: string;
}

async function decodeJpegFile(b: Uint8Array): Promise<StandardDecoded> {
  const sc = colorFromIcc(jpegIcc(b));
  // MozJPEG gives the raw decoded samples with no colour management, identical in every browser.
  const id = await decodeJpeg(b.slice().buffer as ArrayBuffer, { preserveOrientation: false });
  let image = linearizeInts(id.data, 4, id.width, id.height, 255, sc.curves);
  image = applyOrientation(image, jpegOrientation(b));
  return { image, sourceColor: sc, bitDepth: 8, decoder: 'MozJPEG' };
}

async function decodePngFile(b: Uint8Array): Promise<StandardDecoded> {
  const info = await pngInfo(b);
  const sc = colorFromIcc(info.icc);
  const buf = b.slice().buffer as ArrayBuffer;
  if (info.bitDepth === 16) {
    const d = await decodePng(buf, { bitDepth: 16 });
    return { image: linearizeInts(d.data, 4, d.width, d.height, 65535, sc.curves), sourceColor: sc, bitDepth: 16, decoder: 'PNG' };
  }
  const d = await decodePng(buf);
  return { image: linearizeInts(d.data, 4, d.width, d.height, 255, sc.curves), sourceColor: sc, bitDepth: 8, decoder: 'PNG' };
}

async function decodeTiffFile(b: Uint8Array): Promise<StandardDecoded> {
  UTIF ??= (await import('utif')).default;
  const buf = b.slice().buffer;
  const ifds = UTIF.decode(buf);
  // Choose the largest image (skip thumbnails / reduced-resolution pages).
  let page = ifds[0];
  for (const i of ifds) if ((i.t256?.[0] ?? 0) * (i.t257?.[0] ?? 0) > (page.t256?.[0] ?? 0) * (page.t257?.[0] ?? 0)) page = i;
  UTIF.decodeImage(buf, page, ifds);
  const w: number = page.width, h: number = page.height;
  const bps: number = page.t258?.[0] ?? 8;
  const spp: number = page.t277?.[0] ?? 1;
  const fmt: number = page.t339?.[0] ?? 1;
  const photometric: number = page.t262?.[0] ?? 2;
  if (photometric !== 1 && photometric !== 2) throw new Error(`Unsupported TIFF photometric interpretation ${photometric}`);
  const iccTag = page.t34675 as number[] | undefined;
  const sc = colorFromIcc(iccTag ? Uint8Array.from(iccTag) : null);
  const data: Uint8Array = page.data;
  const ch = photometric === 1 ? 1 : spp;
  let image: FloatImage;
  if (bps === 8) image = linearizeInts(data, ch, w, h, 255, sc.curves);
  else if (bps === 16) {
    image = linearizeInts(new Uint16Array(data.buffer, data.byteOffset, w * h * ch), ch, w, h, 65535, sc.curves);
  } else if (bps === 32 && fmt === 3) {
    const le = new Uint8Array(buf)[0] === 0x49;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = w * h;
    const out = allocFloat(n * 3);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = dv.getFloat32((i * ch + (ch === 1 ? 0 : c)) * 4, le);
        out[i * 3 + c] = Math.sign(v) * evalCurve(sc.curves[c], Math.abs(v));
      }
    }
    image = { width: w, height: h, data: out };
  } else throw new Error(`Unsupported TIFF sample format (${bps}-bit, format ${fmt})`);
  image = applyOrientation(image, page.t274?.[0] ?? 1);
  return { image, sourceColor: sc, bitDepth: bps, decoder: 'UTIF' };
}

/** WebP / AVIF through the browser's decoder, with colour management disabled. */
async function decodeViaBrowser(b: Uint8Array, mime: string, format: SourceFormat): Promise<StandardDecoded> {
  let sc: SourceColor;
  if (format === 'webp') sc = colorFromIcc(webpIcc(b));
  else {
    const colr = findColr(b);
    if (colr?.kind === 'icc') sc = colorFromIcc(colr.icc);
    else if (colr?.kind === 'nclx') {
      sc = colorFromSpace(nclxSpace(colr.primaries));
      if (nclxIsHdr(colr.transfer)) sc.warnings.push('HDR (PQ/HLG) transfer is rendered as SDR in this version');
    } else sc = colorFromSpace('srgb');
  }
  const bmp = await createImageBitmap(new Blob([b as BlobPart], { type: mime }), {
    colorSpaceConversion: 'none',
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return {
    image: linearizeInts(id.data, 4, id.width, id.height, 255, sc.curves),
    sourceColor: sc,
    bitDepth: 8,
    decoder: 'Browser',
  };
}

export async function decodeStandard(bytes: Uint8Array, format: SourceFormat): Promise<StandardDecoded> {
  switch (format) {
    case 'jpeg': return decodeJpegFile(bytes);
    case 'png': return decodePngFile(bytes);
    case 'tiff': return decodeTiffFile(bytes);
    case 'webp': return decodeViaBrowser(bytes, 'image/webp', format);
    case 'avif': return decodeViaBrowser(bytes, 'image/avif', format);
    default: throw new Error(`Unsupported format ${format}`);
  }
}
