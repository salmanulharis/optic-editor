/**
 * Decodes one JPEG XL tile (from a DNG 1.7 file) to 16-bit RGBA.
 * jxl-oxide renders at the codestream's native bit depth; its PNG output is the only pixel
 * export it offers, so we round-trip through a 16-bit PNG (lossless).
 */
import * as Comlink from 'comlink';
import initJxl, { JxlImage } from 'jxl-oxide-wasm';
import { decode as decodePng } from '@jsquash/png/decode.js';

let ready: Promise<unknown> | null = null;

const api = {
  async decode(bytes: Uint8Array) {
    ready ??= initJxl();
    await ready;
    const img = new JxlImage();
    try {
      img.feedBytes(bytes);
      if (!img.tryInit()) throw new Error('Incomplete JPEG XL tile');
      const res = img.render();
      // encodeToPng() consumes the RenderResult (Rust takes `self`), so it must not be freed after.
      const png = res.encodeToPng();
      const dec = await decodePng(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, { bitDepth: 16 });
      // The decoder's array may be a view onto WASM memory, which cannot be transferred: copy it.
      const data = new Uint16Array(dec.data);
      return Comlink.transfer({ width: dec.width, height: dec.height, data }, [data.buffer]);
    } finally {
      img.free();
    }
  },
};

export type JxlTileApi = typeof api;
Comlink.expose(api);
