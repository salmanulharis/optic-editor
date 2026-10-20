/**
 * ICC profile support.
 *  - `parseIcc` reads matrix/TRC RGB profiles (the kind every camera, phone and editor embeds),
 *    giving us per-channel linearisation curves and an RGB→XYZ matrix, so *any* such profile is
 *    handled exactly, not just a whitelist.
 *  - `buildIcc` generates compact ICC v4 matrix/TRC profiles for export (sRGB, Display P3,
 *    Adobe RGB, ProPhoto). These are the bytes we embed in TIFF / JPEG / PNG output.
 */
import {
  type ColorSpaceId,
  type Mat3,
  COLOR_SPACES,
  D50_TO_D65,
  D50_XYZ,
  D65_TO_D50,
  identifySpace,
  mul,
  toXYZ_D65,
} from '../../color/matrices';
import type { ParametricCurve, ToneCurve } from '../../color/transfer';

export interface ParsedIcc {
  description: string;
  /** Linear RGB → XYZ (D65-referenced, via Bradford from the D50 PCS). */
  toXYZ: Mat3;
  curves: [ToneCurve, ToneCurve, ToneCurve];
  spaceId: ColorSpaceId | null;
}

const s15 = (dv: DataView, o: number) => dv.getInt32(o) / 65536;
const sig = (dv: DataView, o: number) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

function readCurve(dv: DataView, off: number): ToneCurve | null {
  const type = sig(dv, off);
  if (type === 'curv') {
    const n = dv.getUint32(off + 8);
    if (n === 0) return { kind: 'parametric', p: { g: 1, a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } };
    if (n === 1) {
      const g = dv.getUint16(off + 12) / 256;
      return { kind: 'parametric', p: { g, a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } };
    }
    const table = new Float32Array(n);
    for (let i = 0; i < n; i++) table[i] = dv.getUint16(off + 12 + i * 2) / 65535;
    return { kind: 'sampled', table };
  }
  if (type === 'para') {
    const fn = dv.getUint16(off + 8);
    const v = (i: number) => s15(dv, off + 12 + i * 4);
    const p: ParametricCurve = { g: v(0), a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 };
    if (fn === 1) { p.a = v(1); p.b = v(2); p.d = -p.b / p.a; }
    else if (fn === 2) { p.a = v(1); p.b = v(2); p.e = v(3); p.d = -p.b / p.a; p.f = p.e; }
    else if (fn === 3) { p.a = v(1); p.b = v(2); p.c = v(3); p.d = v(4); }
    else if (fn === 4) { p.a = v(1); p.b = v(2); p.c = v(3); p.d = v(4); p.e = v(5); p.f = v(6); }
    return { kind: 'parametric', p };
  }
  return null;
}

function readText(dv: DataView, off: number, size: number): string {
  const type = sig(dv, off);
  try {
    if (type === 'desc') {
      const n = dv.getUint32(off + 8);
      let s = '';
      for (let i = 0; i < n - 1 && i < size; i++) s += String.fromCharCode(dv.getUint8(off + 12 + i));
      return s;
    }
    if (type === 'mluc') {
      const recSize = dv.getUint32(off + 12);
      const len = dv.getUint32(off + 16 + 4);
      const o = dv.getUint32(off + 16 + 8);
      void recSize;
      let s = '';
      for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(off + o + i));
      return s;
    }
  } catch {
    /* fall through */
  }
  return '';
}

export function parseIcc(bytes: Uint8Array): ParsedIcc | null {
  if (bytes.length < 132) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sig(dv, 36) !== 'acsp' || sig(dv, 16) !== 'RGB ') return null;
  const count = dv.getUint32(128);
  const tags = new Map<string, { off: number; size: number }>();
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12;
    if (e + 12 > bytes.length) break;
    tags.set(sig(dv, e), { off: dv.getUint32(e + 4), size: dv.getUint32(e + 8) });
  }
  const xyz = (name: string) => {
    const t = tags.get(name);
    if (!t || sig(dv, t.off) !== 'XYZ ') return null;
    return [s15(dv, t.off + 8), s15(dv, t.off + 12), s15(dv, t.off + 16)];
  };
  const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
  const trc = ['rTRC', 'gTRC', 'bTRC'].map((n) => {
    const t = tags.get(n);
    return t ? readCurve(dv, t.off) : null;
  });
  const desc = tags.get('desc');
  const description = desc ? readText(dv, desc.off, desc.size) : '';
  if (!r || !g || !b || trc.some((c) => !c)) return null; // LUT-based profile: not supported
  const toXYZ_D50: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const toXYZ = mul(D50_TO_D65, toXYZ_D50);
  return {
    description,
    toXYZ,
    curves: trc as [ToneCurve, ToneCurve, ToneCurve],
    spaceId: identifySpace(toXYZ),
  };
}

// ---------------------------------------------------------------------------
// Profile generation
// ---------------------------------------------------------------------------

class ByteWriter {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 255); }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  s15(v: number) { this.u32(Math.round(v * 65536) | 0); }
  str(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); }
  pad4() { while (this.bytes.length % 4) this.u8(0); }
}

function mluc(text: string): number[] {
  const w = new ByteWriter();
  w.str('mluc'); w.u32(0); w.u32(1); w.u32(12); w.str('enUS');
  w.u32(text.length * 2); w.u32(28);
  for (const c of text) w.u16(c.charCodeAt(0));
  w.pad4();
  return w.bytes;
}

function xyzTag(v: readonly number[]): number[] {
  const w = new ByteWriter();
  w.str('XYZ '); w.u32(0); v.forEach((x) => w.s15(x));
  return w.bytes;
}

function paraTag(id: ColorSpaceId): number[] {
  const cs = COLOR_SPACES[id];
  const w = new ByteWriter();
  w.str('para'); w.u32(0);
  if (cs.transfer === 'srgb') {
    w.u16(3); w.u16(0);
    [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].forEach((x) => w.s15(x));
  } else {
    w.u16(0); w.u16(0);
    w.s15(cs.transfer === 'gamma' ? cs.gamma! : 1);
  }
  w.pad4();
  return w.bytes;
}

const iccCache = new Map<ColorSpaceId, Uint8Array>();

/** ICC v4.3 display profile (matrix/TRC) for a standard RGB space. */
export function buildIcc(id: ColorSpaceId): Uint8Array {
  const cached = iccCache.get(id);
  if (cached) return cached;
  const cs = COLOR_SPACES[id];
  // Colourants are D50-adapted (Bradford), as the ICC PCS requires.
  const m = mul(D65_TO_D50, toXYZ_D65(id));
  const chad = D65_TO_D50;
  const sf32 = (() => {
    const w = new ByteWriter();
    w.str('sf32'); w.u32(0); chad.forEach((x) => w.s15(x));
    return w.bytes;
  })();
  const trc = paraTag(id);
  const tags: Array<[string, number[]]> = [
    ['desc', mluc(cs.label)],
    ['cprt', mluc('No copyright, use freely')],
    ['wtpt', xyzTag(D50_XYZ)],
    ['chad', sf32],
    ['rXYZ', xyzTag([m[0], m[3], m[6]])],
    ['gXYZ', xyzTag([m[1], m[4], m[7]])],
    ['bXYZ', xyzTag([m[2], m[5], m[8]])],
    ['rTRC', trc],
    ['gTRC', trc], // identical curves may share data, but separate copies keep the writer simple
    ['bTRC', trc],
  ];
  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const entries: Array<[string, number, number]> = [];
  for (const [name, data] of tags) {
    entries.push([name, offset, data.length]);
    offset += data.length;
    offset += (4 - (offset % 4)) % 4;
  }
  const total = offset;
  const w = new ByteWriter();
  w.u32(total); w.u32(0); w.u32(0x04300000);
  w.str('mntr'); w.str('RGB '); w.str('XYZ ');
  const d = new Date(Date.UTC(2024, 0, 1));
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0].forEach((x) => w.u16(x));
  w.str('acsp'); w.u32(0); w.u32(0); w.u32(0); w.u32(0); w.u32(0); w.u32(0);
  w.u32(0); // rendering intent: perceptual
  D50_XYZ.forEach((x) => w.s15(x));
  w.str('optc');
  while (w.bytes.length < 128) w.u8(0);
  w.u32(tags.length);
  for (const [name, off, size] of entries) { w.str(name); w.u32(off); w.u32(size); }
  for (const [, data] of tags) { data.forEach((b) => w.u8(b)); w.pad4(); }
  const out = Uint8Array.from(w.bytes);
  iccCache.set(id, out);
  return out;
}
