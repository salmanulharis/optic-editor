/**
 * HEIC / HEIF decode via libheif (WASM), keeping 10/12-bit precision.
 * libheif applies the irot/imir transforms, so the result is already upright.
 */
import { colorFromIcc, colorFromSpace, linearizeInts, type StandardDecoded } from './standardDecoder';
import { findColr, nclxIsHdr, nclxSpace } from '../metadata/isobmff';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Libheif = any;
let libheifPromise: Promise<Libheif> | null = null;

async function getLibheif(): Promise<Libheif> {
  libheifPromise ??= (async () => {
    // The bundle variant has the .wasm inlined, so no asset URL resolution is needed.
    // @ts-expect-error untyped module
    const mod = await import('libheif-js/libheif-wasm/libheif-bundle.mjs');
    const factory = mod.default ?? mod;
    const lib = typeof factory === 'function' ? await factory() : factory;
    return lib;
  })();
  return libheifPromise;
}

const HEIF_CHANNEL_INTERLEAVED = 10;

export async function decodeHeic(bytes: Uint8Array): Promise<StandardDecoded> {
  const lib = await getLibheif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images?.length) throw new Error('No image found in HEIF container');
  const primary = images.find((i: Libheif) => i.is_primary?.()) ?? images[0];
  const width: number = primary.get_width();
  const height: number = primary.get_height();

  // Colour: prefer an embedded ICC profile (iPhone: Display P3), else CICP code points.
  const colr = findColr(bytes);
  let sc;
  if (colr?.kind === 'icc') sc = colorFromIcc(colr.icc);
  else if (colr?.kind === 'nclx') {
    sc = colorFromSpace(nclxSpace(colr.primaries));
    if (nclxIsHdr(colr.transfer)) sc.warnings.push('HDR (PQ/HLG) transfer is rendered as SDR in this version');
  } else sc = colorFromSpace('srgb');

  const decodeAs = async (chroma: number) => {
    const res = await lib.heif_js_decode_image2(primary.handle, lib.heif_colorspace.heif_colorspace_RGB, chroma);
    if (!res || res.code) return null;
    return res;
  };

  // Try high bit depth first; libheif returns 16-bit little-endian containers holding the
  // native bit depth (10 or 12 bits) for HDR-capable files.
  const hiChroma = lib.heif_chroma.heif_chroma_interleaved_RRGGBB_LE;
  let res = hiChroma !== undefined ? await decodeAs(hiChroma) : null;
  try {
    if (res) {
      const ch = res.channels.find((c: Libheif) => c.id === lib.heif_channel.heif_channel_interleaved);
      let bits = 0;
      try { bits = lib._heif_image_get_bits_per_pixel_range(res.image, HEIF_CHANNEL_INTERLEAVED); } catch { bits = 0; }
      const raw: Uint8Array = ch.data;
      const samples = new Uint16Array(width * height * 3);
      let max = 0;
      for (let y = 0; y < height; y++) {
        const row = new Uint16Array(raw.buffer.slice(raw.byteOffset + y * ch.stride, raw.byteOffset + y * ch.stride + width * 6));
        samples.set(row, y * width * 3);
        for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
      }
      if (!bits) bits = max > 4095 ? 16 : max > 1023 ? 12 : max > 255 ? 10 : 8;
      if (bits > 8) {
        lib.heif_image_release(res.image);
        res = null;
        return {
          image: linearizeInts(samples, 3, width, height, 2 ** bits - 1, sc.curves),
          sourceColor: sc,
          bitDepth: bits,
          decoder: 'libheif',
        };
      }
      lib.heif_image_release(res.image);
      res = null;
    }
    // 8-bit path
    res = await decodeAs(lib.heif_chroma.heif_chroma_interleaved_RGBA);
    if (!res) throw new Error('libheif could not decode this image');
    const ch = res.channels.find((c: Libheif) => c.id === lib.heif_channel.heif_channel_interleaved);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) rgba.set(ch.data.subarray(y * ch.stride, y * ch.stride + width * 4), y * width * 4);
    return { image: linearizeInts(rgba, 4, width, height, 255, sc.curves), sourceColor: sc, bitDepth: 8, decoder: 'libheif' };
  } finally {
    if (res) lib.heif_image_release(res.image);
    decoder.decoder && lib.heif_context_free?.(decoder.decoder);
  }
}
