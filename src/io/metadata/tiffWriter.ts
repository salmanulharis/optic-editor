/**
 * Little-endian TIFF IFD serialisation. Used for TIFF export and to build EXIF blobs
 * ("Exif\0\0" + TIFF structure) for JPEG APP1 and PNG eXIf.
 */

export type TagType = 1 | 2 | 3 | 4 | 5 | 7 | 10 | 12;
export interface TagValue {
  tag: number;
  type: TagType;
  /** Numbers for numeric types (rationals as floats), string for ASCII, bytes for UNDEFINED/BYTE blobs. */
  value: number[] | string | Uint8Array;
}

export interface IfdSpec {
  tags: TagValue[];
  /** Child IFDs, written and linked through the given pointer tag (e.g. 34665 Exif, 34853 GPS). */
  children?: Array<{ pointerTag: number; ifd: IfdSpec }>;
}

const SIZE: Record<TagType, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8, 12: 8 };

function toRational(x: number, signed: boolean): [number, number] {
  if (!Number.isFinite(x)) return [0, 1];
  if (Number.isInteger(x) && Math.abs(x) < 2 ** 31) return [x, 1];
  // Continued-fraction approximation with a bounded denominator.
  let best: [number, number] = [Math.round(x * 10000), 10000];
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = Math.abs(x);
  for (let i = 0; i < 20; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > 1e7 || h2 > (signed ? 2 ** 31 - 1 : 2 ** 32 - 1)) break;
    best = [Math.sign(x) * h2, k2];
    if (Math.abs(b - a) < 1e-12) break;
    b = 1 / (b - a);
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
  }
  return best;
}

function encodeValue(t: TagValue): { count: number; bytes: Uint8Array } {
  if (t.type === 2) {
    const s = typeof t.value === 'string' ? t.value : '';
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
    return { count: b.length, bytes: b };
  }
  if (t.value instanceof Uint8Array) return { count: t.value.length, bytes: t.value };
  const vals = t.value as number[];
  const b = new Uint8Array(vals.length * SIZE[t.type]);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => {
    switch (t.type) {
      case 1: case 7: dv.setUint8(i, v); break;
      case 3: dv.setUint16(i * 2, v, true); break;
      case 4: dv.setUint32(i * 4, v >>> 0, true); break;
      case 5: { const [n, d] = toRational(Math.max(0, v), false); dv.setUint32(i * 8, n, true); dv.setUint32(i * 8 + 4, d, true); break; }
      case 10: { const [n, d] = toRational(v, true); dv.setInt32(i * 8, n, true); dv.setInt32(i * 8 + 4, d, true); break; }
      case 12: dv.setFloat64(i * 8, v, true); break;
    }
  });
  return { count: vals.length, bytes: b };
}

/**
 * Serialise an IFD tree starting at absolute offset `base` within the final file.
 * Returns the bytes; the first IFD starts at `base`.
 * `extraOffsets` lets callers learn where a tag's data ended up (e.g. strip offsets to patch).
 */
export function writeIfdTree(root: IfdSpec, base: number): { bytes: Uint8Array; patch: Map<number, number> } {
  const chunks: Uint8Array[] = [];
  let pos = base;
  const patch = new Map<number, number>(); // tag → absolute offset of its value field

  const writeIfd = (spec: IfdSpec): number => {
    const children = spec.children ?? [];
    const tags = [...spec.tags, ...children.map((c) => ({ tag: c.pointerTag, type: 4 as TagType, value: [0] }))].sort(
      (a, b) => a.tag - b.tag,
    );
    const start = pos;
    const headerLen = 2 + tags.length * 12 + 4;
    const encoded = tags.map(encodeValue);
    let dataPos = start + headerLen;
    const dataOffsets: number[] = [];
    for (const e of encoded) {
      if (e.bytes.length > 4) {
        dataOffsets.push(dataPos);
        dataPos += e.bytes.length + (e.bytes.length & 1);
      } else dataOffsets.push(-1);
    }
    const buf = new Uint8Array(dataPos - start);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, tags.length, true);
    const childFields: Array<{ field: number; spec: IfdSpec }> = [];
    tags.forEach((t, i) => {
      const e = 2 + i * 12;
      dv.setUint16(e, t.tag, true);
      dv.setUint16(e + 2, t.type, true);
      dv.setUint32(e + 4, encoded[i].count, true);
      patch.set(t.tag, start + e + 8);
      if (dataOffsets[i] >= 0) {
        dv.setUint32(e + 8, dataOffsets[i], true);
        buf.set(encoded[i].bytes, dataOffsets[i] - start);
        patch.set(t.tag, dataOffsets[i]);
      } else buf.set(encoded[i].bytes, e + 8);
      const child = children.find((c) => c.pointerTag === t.tag);
      if (child) childFields.push({ field: e + 8, spec: child.ifd });
    });
    dv.setUint32(2 + tags.length * 12, 0, true); // next IFD
    chunks.push(buf);
    pos = dataPos;
    for (const c of childFields) {
      const childOff = writeIfd(c.spec);
      dv.setUint32(c.field, childOff, true);
    }
    return start;
  };

  writeIfd(root);
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { bytes: out, patch };
}

/** A standalone little-endian TIFF structure holding only metadata (for EXIF blobs). */
export function buildExifTiff(root: IfdSpec): Uint8Array {
  const { bytes } = writeIfdTree(root, 8);
  const out = new Uint8Array(8 + bytes.length);
  out.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  out.set(bytes, 8);
  return out;
}
