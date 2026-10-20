/**
 * 16-bit RGB TIFF writer (baseline + Adobe Deflate with horizontal predictor), with the ICC
 * profile (tag 34675) and EXIF/GPS sub-IFDs. Little-endian, strips of 32 rows.
 */
import { type IfdSpec, type TagValue, writeIfdTree } from '../metadata/tiffWriter';
import { zlib } from './compress';

export interface TiffOptions {
  icc: Uint8Array;
  metadata: IfdSpec | null;
  compression: 'deflate' | 'none';
  onProgress?: (f: number) => void;
}

const ROWS_PER_STRIP = 32;

export async function encodeTiff16(rgb: Uint16Array, width: number, height: number, o: TiffOptions): Promise<Uint8Array> {
  const strips: Uint8Array[] = [];
  const rowSamples = width * 3;
  const nStrips = Math.ceil(height / ROWS_PER_STRIP);
  for (let s = 0; s < nStrips; s++) {
    const y0 = s * ROWS_PER_STRIP;
    const rows = Math.min(ROWS_PER_STRIP, height - y0);
    const src = rgb.subarray(y0 * rowSamples, (y0 + rows) * rowSamples);
    if (o.compression === 'none') {
      strips.push(new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)));
    } else {
      // Predictor 2: per-channel horizontal differencing, modulo 2^16.
      const d = new Uint16Array(src.length);
      for (let r = 0; r < rows; r++) {
        const base = r * rowSamples;
        d[base] = src[base]; d[base + 1] = src[base + 1]; d[base + 2] = src[base + 2];
        for (let i = 3; i < rowSamples; i++) d[base + i] = (src[base + i] - src[base + i - 3]) & 0xffff;
      }
      strips.push(await zlib(new Uint8Array(d.buffer)));
    }
    o.onProgress?.((s + 1) / nStrips);
  }

  const imageTags = (offsets: number[]): TagValue[] => [
    { tag: 254, type: 4, value: [0] },
    { tag: 256, type: 4, value: [width] },
    { tag: 257, type: 4, value: [height] },
    { tag: 258, type: 3, value: [16, 16, 16] },
    { tag: 259, type: 3, value: [o.compression === 'deflate' ? 8 : 1] },
    { tag: 262, type: 3, value: [2] },
    { tag: 273, type: 4, value: offsets },
    { tag: 277, type: 3, value: [3] },
    { tag: 278, type: 4, value: [ROWS_PER_STRIP] },
    { tag: 279, type: 4, value: strips.map((s) => s.length) },
    { tag: 282, type: 5, value: [300] },
    { tag: 283, type: 5, value: [300] },
    { tag: 284, type: 3, value: [1] },
    { tag: 296, type: 3, value: [2] },
    ...(o.compression === 'deflate' ? [{ tag: 317, type: 3 as const, value: [2] }] : []),
    { tag: 34675, type: 7, value: o.icc },
  ];
  const spec = (offsets: number[]): IfdSpec => {
    const meta = o.metadata;
    const own = imageTags(offsets);
    const ownIds = new Set(own.map((t) => t.tag));
    return {
      tags: [...own, ...(meta?.tags ?? []).filter((t) => !ownIds.has(t.tag))],
      children: meta?.children,
    };
  };
  // Two passes: the IFD size doesn't depend on the offset values, so measure then fill in.
  const first = writeIfdTree(spec(strips.map(() => 0)), 8);
  let pos = 8 + first.bytes.length;
  pos += pos & 1;
  const offsets: number[] = [];
  for (const s of strips) { offsets.push(pos); pos += s.length; }
  const ifd = writeIfdTree(spec(offsets), 8).bytes;

  const out = new Uint8Array(pos);
  out.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  out.set(ifd, 8);
  for (let i = 0; i < strips.length; i++) out.set(strips[i], offsets[i]);
  return out;
}
