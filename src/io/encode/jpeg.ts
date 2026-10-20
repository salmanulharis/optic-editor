/**
 * JPEG export via MozJPEG (WASM). Quality ≥ 90 uses 4:4:4 (no chroma subsampling).
 * 16-bit input is reduced to 8 bits with triangular (TPDF) dither to avoid banding.
 * EXIF (APP1) and the ICC profile (APP2) are injected after SOI/APP0.
 */
import encodeMozJpeg from '@jsquash/jpeg/encode.js';

export function ditherTo8(rgb16: Uint16Array, width: number, height: number): ImageData {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  // xorshift32 PRNG: fast and deterministic.
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = rgb16[i * 3 + c] / 257 + (rnd() - rnd());
      out[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, width, height);
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  if (len > 0xffff) throw new Error('JPEG segment too large');
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff; out[1] = marker; out[2] = len >> 8; out[3] = len & 255;
  out.set(payload, 4);
  return out;
}

function iccSegments(icc: Uint8Array): Uint8Array[] {
  const max = 65519;
  const count = Math.ceil(icc.length / max);
  const sig = Uint8Array.from('ICC_PROFILE\0', (c) => c.charCodeAt(0));
  const segs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = icc.subarray(i * max, (i + 1) * max);
    const p = new Uint8Array(14 + part.length);
    p.set(sig, 0); p[12] = i + 1; p[13] = count; p.set(part, 14);
    segs.push(segment(0xe2, p));
  }
  return segs;
}

export function injectSegments(jpeg: Uint8Array, exifTiff: Uint8Array | null, icc: Uint8Array): Uint8Array {
  // Skip SOI and an optional APP0 (JFIF); insert ours after it; drop any existing APP1/APP2.
  let o = 2;
  const head: Uint8Array[] = [jpeg.subarray(0, 2)];
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) {
    const len = (jpeg[4] << 8) | jpeg[5];
    head.push(jpeg.subarray(2, 4 + len));
    o = 4 + len;
  }
  const ours: Uint8Array[] = [];
  if (exifTiff) {
    const p = new Uint8Array(6 + exifTiff.length);
    p.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
    p.set(exifTiff, 6);
    ours.push(segment(0xe1, p));
  }
  ours.push(...iccSegments(icc));
  while (jpeg[o] === 0xff && (jpeg[o + 1] === 0xe1 || jpeg[o + 1] === 0xe2)) o += 2 + ((jpeg[o + 2] << 8) | jpeg[o + 3]);
  const parts = [...head, ...ours, jpeg.subarray(o)];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

export async function encodeJpeg(
  rgb16: Uint16Array,
  width: number,
  height: number,
  o: { quality: number; icc: Uint8Array; exif: Uint8Array | null },
): Promise<Uint8Array> {
  const img = ditherTo8(rgb16, width, height);
  const buf = await encodeMozJpeg(img, {
    quality: o.quality,
    auto_subsample: false,
    chroma_subsample: o.quality >= 90 ? 1 : 2, // 1 = 4:4:4, 2 = 4:2:0
    progressive: true,
    optimize_coding: true,
    // Fidelity over file size: MozJPEG's default (ImageMagick) quant table plus trellis
    // quantisation strip the dither from smooth gradients and bring back banding in skies
    // (measured: ~1.5× larger steps). Use the standard Annex K table without trellis instead,
    // so "quality 95" means what it does in every other encoder.
    quant_table: 0,
    trellis_multipass: false,
    trellis_opt_zero: false,
    trellis_opt_table: false,
    trellis_loops: 0,
  });
  return injectSegments(new Uint8Array(buf), o.exif, o.icc);
}
