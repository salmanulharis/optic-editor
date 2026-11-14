/**
 * The XMP packet of a DNG (Lightroom Mobile "DNG presets" carry their develop settings there):
 * TIFF tag 700 (XMLPacket) of IFD 0, falling back to a scan for the packet in the file bytes.
 */
import { TiffReader } from '../../io/metadata/tiffReader';
import { decodeText, findXmpPacket } from './xmp';

const XMP_TAG = 700;

export function dngXmp(bytes: Uint8Array): string | null {
  try {
    const r = new TiffReader(bytes);
    for (const ifd of r.ifds) {
      const e = ifd.entries.get(XMP_TAG);
      if (e && e.dataOffset + e.count <= bytes.length) {
        const packet = findXmpPacket(decodeText(bytes.subarray(e.dataOffset, e.dataOffset + e.count)));
        if (packet) return packet;
      }
    }
  } catch {
    // Not a readable TIFF structure: fall through to the byte scan.
  }
  return scanForPacket(bytes);
}

/** Find "<x:xmpmeta" … "</x:xmpmeta>" anywhere in the bytes (XMP is always UTF-8 inside TIFF). */
function scanForPacket(bytes: Uint8Array): string | null {
  const open = new TextEncoder().encode('<x:xmpmeta');
  const close = new TextEncoder().encode('</x:xmpmeta>');
  const start = indexOf(bytes, open, 0);
  if (start < 0) return null;
  const end = indexOf(bytes, close, start);
  if (end < 0) return null;
  return new TextDecoder().decode(bytes.subarray(start, end + close.length));
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  outer: for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    for (let k = 1; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}
