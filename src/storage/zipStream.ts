/**
 * Streaming ZIP writer into an OPFS file: each entry is appended as soon as it is encoded, so a
 * batch export of hundreds of full-resolution images never has to fit in memory. Entries are
 * stored (images are already compressed). ZIP64 records are written when the archive or an entry
 * passes 4 GB. The entry list is plain data, so an interrupted export can resume appending.
 */
import { crc32 } from '../io/encode/compress';
import { appendFile } from '../library/opfs';

export interface ZipEntryInfo {
  name: string;
  crc: number;
  size: number;
  offset: number;
}

export interface ZipState {
  path: string;
  /** Bytes written so far. */
  size: number;
  entries: ZipEntryInfo[];
}

const enc = new TextEncoder();
const MAX32 = 0xffffffff;

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function newZip(path: string): ZipState {
  return { path, size: 0, entries: [] };
}

/** Append one stored entry. Returns the updated state (also mutated in place). */
export async function zipAdd(z: ZipState, name: string, data: Uint8Array): Promise<ZipState> {
  const nameBytes = enc.encode(name);
  const crc = crc32([data]);
  const big = data.length >= MAX32 || z.size >= MAX32;
  const extra = big ? new Uint8Array(20) : new Uint8Array(0);
  if (big) {
    const dv = new DataView(extra.buffer);
    dv.setUint16(0, 0x0001, true);
    dv.setUint16(2, 16, true);
    dv.setBigUint64(4, BigInt(data.length), true);
    dv.setBigUint64(12, BigInt(data.length), true);
  }
  const h = new DataView(new ArrayBuffer(30));
  const { time, date } = dosTime();
  h.setUint32(0, 0x04034b50, true);
  h.setUint16(4, big ? 45 : 20, true);
  h.setUint16(6, 0x0800, true); // UTF-8 names
  h.setUint16(8, 0, true); // stored
  h.setUint16(10, time, true);
  h.setUint16(12, date, true);
  h.setUint32(14, crc, true);
  h.setUint32(18, big ? MAX32 : data.length, true);
  h.setUint32(22, big ? MAX32 : data.length, true);
  h.setUint16(26, nameBytes.length, true);
  h.setUint16(28, extra.length, true);
  const head = new Uint8Array(30 + nameBytes.length + extra.length);
  head.set(new Uint8Array(h.buffer), 0);
  head.set(nameBytes, 30);
  head.set(extra, 30 + nameBytes.length);
  const offset = z.size;
  // appendFile transfers (detaches) the buffers it is given: take the lengths first.
  const written = head.length + data.length;
  await appendFile(z.path, head);
  // Large entries in chunks: the worker writes them without another full copy.
  const CH = 64 * 1024 * 1024;
  for (let o = 0; o < data.length; o += CH) await appendFile(z.path, data.slice(o, Math.min(data.length, o + CH)));
  z.size += written;
  z.entries.push({ name, crc, size: data.length, offset });
  return z;
}

/** Write the central directory and end records. */
export async function zipFinish(z: ZipState): Promise<number> {
  const parts: Uint8Array[] = [];
  const cdStart = z.size;
  let zip64 = cdStart >= MAX32 || z.entries.length >= 0xffff;
  for (const e of z.entries) {
    const nameBytes = enc.encode(e.name);
    const needs = e.size >= MAX32 || e.offset >= MAX32;
    zip64 ||= needs;
    const extra = needs ? new Uint8Array(28) : new Uint8Array(0);
    if (needs) {
      const dv = new DataView(extra.buffer);
      dv.setUint16(0, 0x0001, true);
      dv.setUint16(2, 24, true);
      dv.setBigUint64(4, BigInt(e.size), true);
      dv.setBigUint64(12, BigInt(e.size), true);
      dv.setBigUint64(20, BigInt(e.offset), true);
    }
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, needs ? 45 : 20, true);
    c.setUint16(6, needs ? 45 : 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, needs ? MAX32 : e.size, true);
    c.setUint32(24, needs ? MAX32 : e.size, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint16(30, extra.length, true);
    c.setUint32(42, needs ? MAX32 : e.offset, true);
    const rec = new Uint8Array(46 + nameBytes.length + extra.length);
    rec.set(new Uint8Array(c.buffer), 0);
    rec.set(nameBytes, 46);
    rec.set(extra, 46 + nameBytes.length);
    parts.push(rec);
  }
  const cdSize = parts.reduce((s, p) => s + p.length, 0);
  if (zip64) {
    const r = new DataView(new ArrayBuffer(56));
    r.setUint32(0, 0x06064b50, true);
    r.setBigUint64(4, 44n, true);
    r.setUint16(12, 45, true);
    r.setUint16(14, 45, true);
    r.setBigUint64(24, BigInt(z.entries.length), true);
    r.setBigUint64(32, BigInt(z.entries.length), true);
    r.setBigUint64(40, BigInt(cdSize), true);
    r.setBigUint64(48, BigInt(cdStart), true);
    parts.push(new Uint8Array(r.buffer));
    const l = new DataView(new ArrayBuffer(20));
    l.setUint32(0, 0x07064b50, true);
    l.setBigUint64(8, BigInt(cdStart + cdSize), true);
    l.setUint32(16, 1, true);
    parts.push(new Uint8Array(l.buffer));
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, zip64 ? 0xffff : z.entries.length, true);
  end.setUint16(10, zip64 ? 0xffff : z.entries.length, true);
  end.setUint32(12, zip64 ? MAX32 : cdSize, true);
  end.setUint32(16, zip64 ? MAX32 : cdStart, true);
  parts.push(new Uint8Array(end.buffer));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  await appendFile(z.path, out);
  z.size += total;
  return z.size;
}
