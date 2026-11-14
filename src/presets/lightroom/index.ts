/**
 * Lightroom / Camera Raw preset import: `.xmp` presets (and photo sidecars), legacy `.lrtemplate`
 * presets and Lightroom Mobile "DNG presets" → Optic user presets. Pure and DOM-free; the preset
 * store saves the result and the UI reports what was not converted.
 */
import type { Preset } from '../types';
import { lightroomLimit } from './limits';
import { convertCrs, type NotConverted, type SourceKind } from './convert';
import { dngXmp } from './dng';
import { LuaParseError, readLrTemplate } from './lrtemplate';
import { type CrsMap, decodeText, findXmpPacket, readXmpCrs } from './xmp';

export type { NotConverted, NotConvertedCode } from './convert';

export type LightroomFormat = 'xmp' | 'lrtemplate' | 'dng';

export const LIGHTROOM_FILE = /\.(xmp|lrtemplate|dng)$/i;
export const LIGHTROOM_GROUP = 'Lightroom imports';
export const LIGHTROOM_TAG = 'lightroom';

export { MAX_DNG_BYTES, MAX_PRESET_BYTES, lightroomLimit } from './limits';

export type LightroomErrorCode =
  | 'tooLarge'
  | 'unreadable'
  | 'notPreset'
  | 'isProfile'
  | 'notDevelop'
  | 'noXmpInDng'
  | 'nothingToConvert';

export class LightroomImportError extends Error {
  constructor(readonly code: LightroomErrorCode, readonly notConverted: NotConverted[] = []) {
    super(code);
    this.name = 'LightroomImportError';
  }
}

export interface LightroomImport {
  preset: Preset;
  format: LightroomFormat;
  kind: SourceKind;
  notConverted: NotConverted[];
  legacyProcess: boolean;
}

export function lightroomFormat(name: string): LightroomFormat | null {
  const m = LIGHTROOM_FILE.exec(name);
  return m ? (m[1].toLowerCase() as LightroomFormat) : null;
}

/** File name without folders and extension: "Packs/Moody/Warm Fade.xmp" → "Warm Fade". */
export function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim() || 'Lightroom preset';
}

/**
 * Convert one Lightroom file. `group` is the fallback group (e.g. the zip folder) used when the
 * preset does not name its own. Throws LightroomImportError with a code the UI translates.
 */
export function importLightroomFile(name: string, bytes: Uint8Array, opts: { group?: string } = {}): LightroomImport {
  const format = lightroomFormat(name);
  if (!format) throw new LightroomImportError('notPreset');
  if (bytes.length > lightroomLimit(name)) throw new LightroomImportError('tooLarge');

  let crs: CrsMap;
  let kind: SourceKind;
  let title: string | null = null;
  let uuid: string | null = null;
  let group: string | null = null;

  if (format === 'lrtemplate') {
    let t;
    try {
      t = readLrTemplate(decodeText(bytes));
    } catch (e) {
      if (e instanceof LuaParseError) throw new LightroomImportError('unreadable');
      throw e;
    }
    if (t.type && t.type !== 'Develop') throw new LightroomImportError('notDevelop');
    crs = t.settings;
    kind = 'preset';
    title = t.title;
    uuid = t.uuid;
  } else {
    const packet = format === 'dng' ? dngXmp(bytes) : findXmpPacket(decodeText(bytes));
    if (!packet) throw new LightroomImportError(format === 'dng' ? 'noXmpInDng' : 'unreadable');
    try {
      crs = readXmpCrs(packet);
    } catch {
      throw new LightroomImportError('unreadable');
    }
    const presetType = str(crs, 'PresetType');
    if (presetType === 'Look' || (!presetType && (crs.has('RGBTable') || [...crs.keys()].some((k) => k.startsWith('Table_'))) && !crs.has('Exposure2012'))) {
      throw new LightroomImportError('isProfile');
    }
    if (!crs.size) throw new LightroomImportError(format === 'dng' ? 'noXmpInDng' : 'notPreset');
    kind = format === 'xmp' && presetType ? 'preset' : 'snapshot';
    title = str(crs, 'Name') ?? null;
    uuid = str(crs, 'UUID') ?? null;
    group = str(crs, 'Group') ?? null;
  }

  const c = convertCrs(crs, kind);
  if (!c.includes.length) throw new LightroomImportError('nothingToConvert', c.notConverted);

  const presetName = (title?.trim() || baseName(name)).slice(0, 80);
  const presetGroup = (group?.trim() || opts.group?.trim() || LIGHTROOM_GROUP).slice(0, 60);
  const idSource = uuid?.trim() ? `uuid:${uuid.trim().toUpperCase()}` : `${presetName}|${JSON.stringify(c.settings)}`;
  const preset: Preset = {
    id: `lr-${hash(idSource)}`,
    name: presetName,
    group: presetGroup,
    version: 3,
    tags: [LIGHTROOM_TAG],
    includes: c.includes,
    settings: c.settings,
    ...(c.nonRaw ? { nonRaw: c.nonRaw } : {}),
  };
  return { preset, format, kind, notConverted: c.notConverted, legacyProcess: c.legacyProcess };
}

function str(m: CrsMap, k: string): string | undefined {
  const v = m.get(k);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** cyrb53: a fast, well-mixed 53-bit string hash (stable ids for re-imports). */
export function hash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
