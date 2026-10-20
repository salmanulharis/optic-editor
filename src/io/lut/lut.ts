/**
 * 3D LUT parsing: Adobe/Resolve `.cube` and Hald CLUT PNGs.
 * Output: RGB float table of size N³ with red varying fastest (the .cube order), plus domain.
 * Parsers throw `LutError` with a user-readable message for anything malformed.
 */
import { decode as decodePng } from '@jsquash/png/decode.js';

export interface LutData {
  id: string;
  name: string;
  size: number;
  /** N³ × 3 floats, red fastest, then green, then blue. */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  source: 'cube' | 'hald' | 'builtin';
}

export class LutError extends Error {}

const MAX_SIZE = 129;

export function parseCube(text: string, fallbackName: string): Omit<LutData, 'id' | 'source'> {
  let name = fallbackName;
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'TITLE') { name = line.slice(5).trim().replace(/^"|"$/g, '') || name; continue; }
    if (key === 'LUT_3D_SIZE') {
      size = parseInt(parts[1], 10);
      if (!Number.isFinite(size) || size < 2 || size > MAX_SIZE) throw new LutError(`Unsupported LUT_3D_SIZE ${parts[1]} (2–${MAX_SIZE})`);
      continue;
    }
    if (key === 'LUT_1D_SIZE') throw new LutError('1D LUTs are not supported; please use a 3D .cube');
    if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const v = parts.slice(1, 4).map(Number);
      if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new LutError(`Bad ${key} on line ${ln + 1}`);
      if (key === 'DOMAIN_MIN') domainMin = v as [number, number, number];
      else domainMax = v as [number, number, number];
      continue;
    }
    if (/^[A-Z_]+$/.test(key)) continue; // unknown keyword (e.g. LUT_IN_VIDEO_RANGE): ignore
    if (parts.length < 3) throw new LutError(`Malformed data on line ${ln + 1}`);
    for (let i = 0; i < 3; i++) {
      const v = Number(parts[i]);
      if (!Number.isFinite(v)) throw new LutError(`Not a number on line ${ln + 1}: "${parts[i]}"`);
      values.push(v);
    }
  }
  if (!size) throw new LutError('Missing LUT_3D_SIZE — is this a .cube file?');
  const expected = size ** 3 * 3;
  if (values.length !== expected) {
    throw new LutError(`Expected ${size ** 3} entries for size ${size}, found ${values.length / 3}`);
  }
  if (domainMax.some((m, i) => m <= domainMin[i])) throw new LutError('DOMAIN_MAX must be greater than DOMAIN_MIN');
  return { name, size, data: Float32Array.from(values), domainMin, domainMax };
}

/** Hald CLUT: a square PNG of side L³ holding an N = L² cube, red fastest. */
export async function parseHald(bytes: Uint8Array, fallbackName: string): Promise<Omit<LutData, 'id' | 'source'>> {
  let img: { width: number; height: number; data: Uint16Array };
  try {
    img = await decodePng(bytes.slice().buffer as ArrayBuffer, { bitDepth: 16 });
  } catch {
    throw new LutError('Could not decode the PNG');
  }
  const { width: W, height: H } = img;
  const level = Math.round(Math.cbrt(W));
  if (W !== H || level ** 3 !== W || level < 2) {
    throw new LutError(`Not a Hald CLUT: ${W}×${H} is not a square of side level³ (e.g. 512×512 for level 8)`);
  }
  const N = level * level;
  const data = new Float32Array(N ** 3 * 3);
  for (let i = 0; i < N ** 3; i++) {
    data[i * 3] = img.data[i * 4] / 65535;
    data[i * 3 + 1] = img.data[i * 4 + 1] / 65535;
    data[i * 3 + 2] = img.data[i * 4 + 2] / 65535;
  }
  return { name: fallbackName, size: N, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

export async function parseLutFile(file: File): Promise<Omit<LutData, 'id'>> {
  const base = file.name.replace(/\.[^.]+$/, '');
  if (/\.cube$/i.test(file.name)) return { ...parseCube(await file.text(), base), source: 'cube' };
  if (/\.png$/i.test(file.name)) return { ...(await parseHald(new Uint8Array(await file.arrayBuffer()), base)), source: 'hald' };
  throw new LutError('Unsupported LUT file: use .cube or a Hald CLUT .png');
}

/** Serialise to .cube text (used by .opticpack export). */
export function toCube(l: LutData): string {
  const lines = [`TITLE "${l.name.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${l.size}`];
  if (l.domainMin.some((v) => v !== 0)) lines.push(`DOMAIN_MIN ${l.domainMin.join(' ')}`);
  if (l.domainMax.some((v) => v !== 1)) lines.push(`DOMAIN_MAX ${l.domainMax.join(' ')}`);
  for (let i = 0; i < l.data.length; i += 3) lines.push(`${l.data[i].toFixed(6)} ${l.data[i + 1].toFixed(6)} ${l.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}
