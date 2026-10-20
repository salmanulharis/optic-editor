/** zlib (RFC 1950) compression through the native CompressionStream, fed in chunks. */

export async function zlibChunks(produce: (push: (chunk: Uint8Array) => Promise<void>) => Promise<void>): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const result = new Response(cs.readable).arrayBuffer();
  await produce(async (chunk) => {
    await writer.ready;
    await writer.write(chunk as BufferSource);
  });
  await writer.close();
  return new Uint8Array(await result);
}

export function zlib(data: Uint8Array): Promise<Uint8Array> {
  return zlibChunks(async (push) => push(data));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
