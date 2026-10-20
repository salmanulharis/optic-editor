/** 16-bit RGB PNG writer with iCCP (ICC profile) and eXIf (EXIF) chunks. */
import { crc32, zlib, zlibChunks } from './compress';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

export async function encodePng16(
  rgb: Uint16Array,
  width: number,
  height: number,
  o: { icc: Uint8Array; profileName: string; exif: Uint8Array | null; onProgress?: (f: number) => void },
): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([16, 2, 0, 0, 0], 8); // 16-bit, truecolour, deflate, adaptive filter, no interlace

  const name = Uint8Array.from(o.profileName.slice(0, 79), (c) => c.charCodeAt(0) & 0x7f);
  const iccZ = await zlib(o.icc);
  const iccp = new Uint8Array(name.length + 2 + iccZ.length);
  iccp.set(name, 0);
  iccp.set(iccZ, name.length + 2); // null separator + compression method 0

  const rowBytes = width * 6;
  const idat = await zlibChunks(async (push) => {
    const batch = 64;
    for (let y0 = 0; y0 < height; y0 += batch) {
      const rows = Math.min(batch, height - y0);
      const buf = new Uint8Array(rows * (rowBytes + 1));
      for (let r = 0; r < rows; r++) {
        const y = y0 + r;
        const o2 = r * (rowBytes + 1);
        buf[o2] = 1; // filter: Sub (bpp = 6 bytes)
        const s = y * width * 3;
        let prev0 = 0, prev1 = 0, prev2 = 0;
        for (let x = 0; x < width; x++) {
          const i = s + x * 3, d = o2 + 1 + x * 6;
          const a = rgb[i], b = rgb[i + 1], c = rgb[i + 2];
          // Sub filter works per byte on big-endian samples.
          buf[d] = ((a >> 8) - (prev0 >> 8)) & 255; buf[d + 1] = ((a & 255) - (prev0 & 255)) & 255;
          buf[d + 2] = ((b >> 8) - (prev1 >> 8)) & 255; buf[d + 3] = ((b & 255) - (prev1 & 255)) & 255;
          buf[d + 4] = ((c >> 8) - (prev2 >> 8)) & 255; buf[d + 5] = ((c & 255) - (prev2 & 255)) & 255;
          prev0 = a; prev1 = b; prev2 = c;
        }
      }
      await push(buf);
      o.onProgress?.(Math.min(1, (y0 + rows) / height));
    }
  });

  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('iCCP', iccp),
    ...(o.exif ? [chunk('eXIf', o.exif)] : []),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
