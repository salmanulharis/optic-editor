/** Minimal TIFF / DNG / EXIF IFD reader. */

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute byte offset of the value data. */
  dataOffset: number;
  /** Absolute byte offset of the entry's 4-byte value/offset field (for in-place patching). */
  fieldOffset: number;
}

export interface Ifd {
  offset: number;
  entries: Map<number, IfdEntry>;
  subIfds: Ifd[];
  exif?: Ifd;
  gps?: Ifd;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

export class TiffReader {
  readonly dv: DataView;
  readonly le: boolean;
  readonly ifds: Ifd[] = [];

  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bo = this.dv.getUint16(0);
    if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('Not a TIFF stream');
    this.le = bo === 0x4949;
    if (this.u16(2) !== 42) throw new Error('Unsupported TIFF variant (BigTIFF?)');
    let off = this.u32(4);
    const seen = new Set<number>();
    while (off && off < bytes.length && !seen.has(off) && this.ifds.length < 64) {
      seen.add(off);
      const ifd = this.readIfd(off, 0);
      this.ifds.push(ifd);
      off = this.u32(off + 2 + this.u16(off) * 12);
    }
  }

  u16(o: number) { return this.dv.getUint16(o, this.le); }
  u32(o: number) { return this.dv.getUint32(o, this.le); }

  private readIfd(off: number, depth: number): Ifd {
    const n = this.u16(off);
    const entries = new Map<number, IfdEntry>();
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > this.bytes.length) break;
      const tag = this.u16(e), type = this.u16(e + 2), count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      entries.set(tag, { tag, type, count, dataOffset: size <= 4 ? e + 8 : this.u32(e + 8), fieldOffset: e + 8 });
    }
    const ifd: Ifd = { offset: off, entries, subIfds: [] };
    if (depth < 3) {
      const sub = entries.get(330);
      if (sub) for (const o of this.values(sub)) if (o < this.bytes.length) ifd.subIfds.push(this.readIfd(o, depth + 1));
      const exif = entries.get(34665);
      if (exif) ifd.exif = this.readIfd(this.values(exif)[0], depth + 1);
      const gps = entries.get(34853);
      if (gps) ifd.gps = this.readIfd(this.values(gps)[0], depth + 1);
    }
    return ifd;
  }

  /** Read an entry's values as numbers (rationals are divided out). */
  values(e: IfdEntry): number[] {
    const out: number[] = [];
    const o = e.dataOffset;
    for (let i = 0; i < e.count; i++) {
      switch (e.type) {
        case 1: case 7: out.push(this.dv.getUint8(o + i)); break;
        case 6: out.push(this.dv.getInt8(o + i)); break;
        case 3: out.push(this.u16(o + i * 2)); break;
        case 8: out.push(this.dv.getInt16(o + i * 2, this.le)); break;
        case 4: case 13: out.push(this.u32(o + i * 4)); break;
        case 9: out.push(this.dv.getInt32(o + i * 4, this.le)); break;
        case 5: { const d = this.u32(o + i * 8 + 4); out.push(d ? this.u32(o + i * 8) / d : 0); break; }
        case 10: { const d = this.dv.getInt32(o + i * 8 + 4, this.le); out.push(d ? this.dv.getInt32(o + i * 8, this.le) / d : 0); break; }
        case 11: out.push(this.dv.getFloat32(o + i * 4, this.le)); break;
        case 12: out.push(this.dv.getFloat64(o + i * 8, this.le)); break;
        default: out.push(this.dv.getUint8(o + i));
      }
    }
    return out;
  }

  get(ifd: Ifd, tag: number): number[] | undefined {
    const e = ifd.entries.get(tag);
    return e ? this.values(e) : undefined;
  }

  ascii(ifd: Ifd, tag: number): string | undefined {
    const e = ifd.entries.get(tag);
    if (!e) return undefined;
    let s = '';
    for (let i = 0; i < e.count; i++) {
      const c = this.dv.getUint8(e.dataOffset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  raw(ifd: Ifd, tag: number): Uint8Array | undefined {
    const e = ifd.entries.get(tag);
    if (!e) return undefined;
    const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
    return this.bytes.subarray(e.dataOffset, e.dataOffset + size);
  }

  /** All IFDs including SubIFDs, depth first. */
  allIfds(): Ifd[] {
    const out: Ifd[] = [];
    const walk = (i: Ifd) => { out.push(i); i.subIfds.forEach(walk); };
    this.ifds.forEach(walk);
    return out;
  }
}
