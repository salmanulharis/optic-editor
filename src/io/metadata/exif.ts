/**
 * EXIF read (exifr) and write (our own TIFF IFD writer).
 *
 * Writing strategy:
 *  - JPEG source + "keep all": copy the original APP1 TIFF structure byte-for-byte (maker notes
 *    included) and patch Orientation / pixel dimensions / colour space in place.
 *  - Everything else: re-serialise the tags exifr read (IFD0, Exif, GPS) generically.
 * In both cases Orientation is written as 1, because pixels are exported upright.
 */
import exifr from 'exifr';
import type { CameraInfo } from '../decode/types';
import { TiffReader } from './tiffReader';
import { buildExifTiff, type IfdSpec, type TagType, type TagValue } from './tiffWriter';

export type TagBlock = Record<number, unknown>;
export interface ExifBlocks {
  ifd0: TagBlock;
  exif: TagBlock;
  gps: TagBlock;
}

export type MetadataMode = 'keep' | 'stripGps' | 'strip';

export async function readExifBlocks(file: Blob): Promise<ExifBlocks | null> {
  try {
    const out = (await exifr.parse(file, {
      tiff: true, ifd0: true, exif: true, gps: true, ifd1: false, interop: false,
      makerNote: false, userComment: true, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
      translateKeys: false, translateValues: false, reviveValues: false, sanitize: true, mergeOutput: false,
    } as never)) as Record<string, TagBlock> | undefined;
    if (!out) return null;
    return { ifd0: out.ifd0 ?? {}, exif: out.exif ?? {}, gps: out.gps ?? {} };
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function cameraInfoFromExif(b: ExifBlocks | null): CameraInfo {
  if (!b) return {};
  return {
    make: str(b.ifd0[271]),
    model: str(b.ifd0[272]),
    lens: str(b.exif[42036]),
    iso: num(b.exif[34855]) ?? (Array.isArray(b.exif[34855]) ? num((b.exif[34855] as unknown[])[0]) : undefined),
    shutter: num(b.exif[33434]),
    aperture: num(b.exif[33437]),
    focalLength: num(b.exif[37386]),
    focal35: num(b.exif[41989]) || undefined,
    date: str(b.exif[36867]) ?? str(b.ifd0[306]),
  };
}

export function orientationFromExif(b: ExifBlocks | null): number {
  const o = num(b?.ifd0[274]);
  return o && o >= 1 && o <= 8 ? o : 1;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Tags that describe the source's pixel layout or point elsewhere; never copied. */
const SKIP_IFD0 = new Set([
  254, 255, 256, 257, 258, 259, 262, 263, 266, 269, 273, 274, 277, 278, 279, 280, 281, 282, 283, 284, 296, 317, 318,
  319, 320, 322, 323, 324, 325, 330, 338, 339, 340, 341, 513, 514, 529, 530, 531, 532, 700, 33421, 33422, 34665,
  34675, 34853, 37393, 50341,
]);
const SKIP_EXIF = new Set([37500 /* MakerNote */, 40965 /* Interop */, 40962, 40963, 40961]);
const UNDEFINED_TAGS = new Set([36864, 40960, 37121, 41728, 41729, 37510, 41730, 34856]);
const SIGNED_RATIONAL = new Set([37377, 37379, 37380]);
const BYTE_TAGS_GPS = new Set([0, 5]);

function toTag(tag: number, v: unknown, block: 'ifd0' | 'exif' | 'gps'): TagValue | null {
  if (v == null) return null;
  if (UNDEFINED_TAGS.has(tag)) {
    if (v instanceof Uint8Array) return { tag, type: 7, value: v };
    if (typeof v === 'string') return { tag, type: 7, value: Uint8Array.from(v, (c) => c.charCodeAt(0) & 255) };
    if (Array.isArray(v)) return { tag, type: 7, value: Uint8Array.from(v as number[]) };
    return null;
  }
  if (typeof v === 'string') return { tag, type: 2, value: v };
  if (v instanceof Uint8Array) return { tag, type: 7, value: v };
  const arr = (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!arr.length) return null;
  if (block === 'gps' && BYTE_TAGS_GPS.has(tag)) return { tag, type: 1, value: arr };
  let type: TagType;
  if (SIGNED_RATIONAL.has(tag)) type = 10;
  else if (arr.every(Number.isInteger)) type = arr.every((x) => x >= 0 && x <= 65535) ? 3 : 4;
  else type = 5;
  if (type !== 10 && arr.some((x) => x < 0)) type = 10;
  return { tag, type, value: arr };
}

export interface ExifWriteOptions {
  mode: MetadataMode;
  width: number;
  height: number;
  /** EXIF ColorSpace: 1 = sRGB, 65535 = uncalibrated (P3/Adobe/ProPhoto with embedded ICC). */
  srgb: boolean;
  software: string;
}

/** Build a TIFF-structured EXIF blob (without the "Exif\0\0" prefix) from tag blocks. */
export function buildExifFromBlocks(b: ExifBlocks | null, o: ExifWriteOptions): Uint8Array | null {
  const spec = exifIfdSpec(b, o);
  return spec ? buildExifTiff(spec) : null;
}

/** IFD0 metadata tags plus Exif/GPS child IFDs, ready to merge into a TIFF file's IFD0. */
export function exifIfdSpec(b: ExifBlocks | null, o: ExifWriteOptions): IfdSpec | null {
  if (o.mode === 'strip') return null;
  const ifd0: TagValue[] = [];
  const exif: TagValue[] = [];
  const gps: TagValue[] = [];
  if (b) {
    for (const [k, v] of Object.entries(b.ifd0)) {
      const t = +k;
      if (SKIP_IFD0.has(t) || t >= 50700 || t === 305) continue;
      const tv = toTag(t, v, 'ifd0');
      if (tv) ifd0.push(tv);
    }
    for (const [k, v] of Object.entries(b.exif)) {
      const t = +k;
      if (SKIP_EXIF.has(t)) continue;
      const tv = toTag(t, v, 'exif');
      if (tv) exif.push(tv);
    }
    if (o.mode === 'keep') {
      for (const [k, v] of Object.entries(b.gps)) {
        const tv = toTag(+k, v, 'gps');
        if (tv) gps.push(tv);
      }
    }
  }
  ifd0.push({ tag: 274, type: 3, value: [1] });
  ifd0.push({ tag: 305, type: 2, value: o.software });
  exif.push({ tag: 40961, type: 3, value: [o.srgb ? 1 : 65535] });
  exif.push({ tag: 40962, type: 4, value: [o.width] });
  exif.push({ tag: 40963, type: 4, value: [o.height] });
  if (!exif.some((t) => t.tag === 36864)) exif.push({ tag: 36864, type: 7, value: Uint8Array.from([48, 50, 51, 50]) });
  const children: NonNullable<IfdSpec['children']> = [{ pointerTag: 34665, ifd: { tags: exif } }];
  if (gps.length) children.push({ pointerTag: 34853, ifd: { tags: gps } });
  return { tags: ifd0, children };
}

/** Find the raw EXIF TIFF structure inside a JPEG's APP1 segment. */
export function extractJpegExif(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 < jpeg.length) {
    if (jpeg[o] !== 0xff) return null;
    const marker = jpeg[o + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (jpeg[o + 2] << 8) | jpeg[o + 3];
    if (marker === 0xe1 && jpeg[o + 4] === 0x45 && jpeg[o + 5] === 0x78 && jpeg[o + 6] === 0x69 && jpeg[o + 7] === 0x66) {
      return jpeg.slice(o + 10, o + 2 + len);
    }
    o += 2 + len;
  }
  return null;
}

/**
 * Patch a copied EXIF TIFF structure in place: orientation → 1, new pixel dimensions, colour
 * space; optionally wipe GPS (entries and their data are zeroed); drop the IFD1 thumbnail link.
 */
export function patchExif(tiff: Uint8Array, o: ExifWriteOptions): Uint8Array {
  const bytes = tiff.slice();
  const r = new TiffReader(bytes);
  const ifd0 = r.ifds[0];
  if (!ifd0) return bytes;
  const dv = r.dv;
  const setShortOrLong = (e: { type: number; fieldOffset: number } | undefined, v: number) => {
    if (!e) return;
    if (e.type === 3) dv.setUint16(e.fieldOffset, v, r.le);
    else if (e.type === 4) dv.setUint32(e.fieldOffset, v, r.le);
  };
  setShortOrLong(ifd0.entries.get(274), 1);
  // Unlink the thumbnail IFD (it shows the unedited image).
  dv.setUint32(ifd0.offset + 2 + r.u16(ifd0.offset) * 12, 0, r.le);
  if (ifd0.exif) {
    setShortOrLong(ifd0.exif.entries.get(40962), o.width);
    setShortOrLong(ifd0.exif.entries.get(40963), o.height);
    setShortOrLong(ifd0.exif.entries.get(40961), o.srgb ? 1 : 65535);
  }
  if (o.mode === 'stripGps' && ifd0.gps) {
    const g = ifd0.gps;
    for (const e of g.entries.values()) {
      const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
      const len = (sizes[e.type] ?? 1) * e.count;
      if (len > 4) bytes.fill(0, e.dataOffset, Math.min(bytes.length, e.dataOffset + len));
    }
    const n = r.u16(g.offset);
    bytes.fill(0, g.offset + 2, Math.min(bytes.length, g.offset + 2 + n * 12));
    dv.setUint16(g.offset, 0, r.le);
  }
  return bytes;
}
