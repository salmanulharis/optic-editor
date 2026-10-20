/**
 * Fallback decoder for DNG 1.7 files whose image data is JPEG XL compressed (Compression 52546),
 * as written by newer iPhones for ProRAW. LibRaw's WASM build cannot decode these, so we read the
 * tile layout ourselves, decode tiles in parallel with jxl-oxide, and assemble the image.
 * Only LinearRaw (already demosaiced, 3 samples) data is supported, which is what ProRAW uses.
 */
import * as Comlink from 'comlink';
import type { Ifd, TiffReader } from '../metadata/tiffReader';
import { TAG } from './dng';
import { allocFloat, crop } from './imageOps';
import type { FloatImage, ProgressFn } from './types';
import type { JxlTileApi } from './jxlTile.worker';

function perSample(v: number[] | undefined, spp: number, fallback: number): number[] {
  if (!v || !v.length) return new Array(spp).fill(fallback);
  if (v.length === spp) return v;
  if (v.length === 1) return new Array(spp).fill(v[0]);
  // BlackLevelRepeatDim pattern: average per sample.
  const out = new Array(spp).fill(0), n = new Array(spp).fill(0);
  v.forEach((x, i) => { out[i % spp] += x; n[i % spp]++; });
  return out.map((s, i) => s / Math.max(1, n[i]));
}

export async function decodeDngJxl(r: TiffReader, ifd: Ifd, progress: ProgressFn): Promise<FloatImage> {
  const g = (t: number) => r.get(ifd, t);
  const width = g(TAG.Width)![0];
  const height = g(TAG.Height)![0];
  const spp = g(TAG.SamplesPerPixel)?.[0] ?? 1;
  const photometric = g(TAG.Photometric)?.[0];
  if (photometric !== 34892 || spp < 3) {
    throw new Error('This JPEG XL DNG holds mosaic (CFA) data, which is not supported yet.');
  }
  const tiled = ifd.entries.has(TAG.TileOffsets);
  const tw = tiled ? g(TAG.TileWidth)![0] : width;
  const th = tiled ? g(TAG.TileLength)![0] : g(TAG.RowsPerStrip)?.[0] ?? height;
  const offsets = g(tiled ? TAG.TileOffsets : TAG.StripOffsets)!;
  const counts = g(tiled ? TAG.TileByteCounts : TAG.StripByteCounts)!;
  const across = Math.ceil(width / tw);

  const bits = g(TAG.BitsPerSample)?.[0] ?? 16;
  const black = perSample(g(TAG.BlackLevel), 3, 0);
  const white = perSample(g(TAG.WhiteLevel), 3, 2 ** bits - 1);
  const lin = g(TAG.LinearizationTable);
  // Per-channel lookup from stored 16-bit code to normalised linear value.
  const luts = [0, 1, 2].map((c) => {
    const lut = new Float32Array(65536);
    const range = white[c] - black[c] || 1;
    for (let v = 0; v < 65536; v++) {
      const raw = lin ? lin[Math.min(lin.length - 1, v)] : v;
      lut[v] = Math.min(1, Math.max(0, (raw - black[c]) / range));
    }
    return lut;
  });

  const out = allocFloat(width * height * 3);
  const poolSize = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: poolSize }, () =>
    new Worker(new URL('./jxlTile.worker.ts', import.meta.url), { type: 'module' }),
  );
  const apis = workers.map((w) => Comlink.wrap<JxlTileApi>(w));
  let next = 0, done = 0;
  const total = offsets.length;
  // The PNG round-trip reports samples at the file's bit depth scaled to 16 bits.
  const scaleTo = bits < 16 ? (2 ** bits - 1) / 65535 : 1;

  const run = async (api: Comlink.Remote<JxlTileApi>) => {
    while (next < total) {
      const i = next++;
      const bytes = r.bytes.slice(offsets[i], offsets[i] + counts[i]);
      const tile = await api.decode(Comlink.transfer(bytes, [bytes.buffer]));
      const x0 = (i % across) * tw, y0 = Math.floor(i / across) * th;
      const w = Math.min(tile.width, width - x0), h = Math.min(tile.height, height - y0);
      for (let y = 0; y < h; y++) {
        let si = y * tile.width * 4;
        let di = ((y0 + y) * width + x0) * 3;
        for (let x = 0; x < w; x++, si += 4, di += 3) {
          out[di] = luts[0][Math.round(tile.data[si] * scaleTo)];
          out[di + 1] = luts[1][Math.round(tile.data[si + 1] * scaleTo)];
          out[di + 2] = luts[2][Math.round(tile.data[si + 2] * scaleTo)];
        }
      }
      done++;
      progress(0.1 + 0.75 * (done / total), `Decoding JPEG XL tiles ${done}/${total}`);
    }
  };
  try {
    await Promise.all(apis.map(run));
  } finally {
    workers.forEach((w) => w.terminate());
  }

  let img: FloatImage = { width, height, data: out };
  const origin = g(TAG.DefaultCropOrigin);
  const size = g(TAG.DefaultCropSize);
  if (origin && size) img = crop(img, origin[0], origin[1], size[0], size[1]);
  return img;
}
