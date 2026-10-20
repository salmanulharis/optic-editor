/**
 * Reads colour signalling from HEIF/AVIF ('colr' box): either an embedded ICC profile
 * ('prof' / 'rICC') or CICP code points ('nclx').
 */
import type { ColorSpaceId } from '../../color/matrices';

export type IsoColor =
  | { kind: 'icc'; icc: Uint8Array }
  | { kind: 'nclx'; primaries: number; transfer: number; matrix: number; fullRange: boolean };

export function findColr(bytes: Uint8Array, limit = 4 * 1024 * 1024): IsoColor | null {
  const n = Math.min(bytes.length - 8, limit);
  for (let i = 4; i < n; i++) {
    if (bytes[i] !== 0x63 || bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x6c || bytes[i + 3] !== 0x72) continue; // 'colr'
    const size = ((bytes[i - 4] << 24) | (bytes[i - 3] << 16) | (bytes[i - 2] << 8) | bytes[i - 1]) >>> 0;
    if (size < 12 || i - 4 + size > bytes.length) continue;
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const body = i + 8;
    if (type === 'prof' || type === 'rICC') return { kind: 'icc', icc: bytes.slice(body, i - 4 + size) };
    if (type === 'nclx') {
      return {
        kind: 'nclx',
        primaries: (bytes[body] << 8) | bytes[body + 1],
        transfer: (bytes[body + 2] << 8) | bytes[body + 3],
        matrix: (bytes[body + 4] << 8) | bytes[body + 5],
        fullRange: (bytes[body + 6] & 0x80) !== 0,
      };
    }
  }
  return null;
}

/** Map CICP colour primaries to one of our spaces (all D65). */
export function nclxSpace(primaries: number): ColorSpaceId {
  if (primaries === 12) return 'display-p3';
  if (primaries === 9) return 'rec2020';
  return 'srgb';
}

/** True for HDR transfer functions (PQ, HLG), which Phase 1 renders as SDR. */
export function nclxIsHdr(transfer: number): boolean {
  return transfer === 16 || transfer === 18;
}
