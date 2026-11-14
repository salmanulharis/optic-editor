/**
 * Preset library state: built-in presets, user presets (IndexedDB), favourites and recents
 * (localStorage), and imported LUTs (IndexedDB → lutRegistry).
 */
import { create } from 'zustand';
import { t } from '../i18n';
import { type LutData, LutError, parseCube, parseLutFile, toCube } from '../io/lut/lut';
import { lutRegistry } from '../pipeline/lutRegistry';
import { BUILTIN_PRESETS, BUNDLED_LUTS } from '../presets/builtin';
import type { LightroomErrorCode, NotConverted } from '../presets/lightroom';
import type { Preset } from '../presets/types';
import { GROUP_LABELS, PRESET_GROUPS, type PresetGroup } from '../recipe/schema';
import { dbDelete, dbGetAll, dbPut, lsGet, lsSet } from '../storage/db';
import { ZipLimitError, readZip, writeZip } from '../storage/zip';
import { lightroomLimit } from '../presets/lightroom/limits';

interface PresetState {
  ready: boolean;
  user: Preset[];
  favorites: string[];
  recent: string[];
  luts: Array<{ id: string; name: string; size: number; source: LutData['source'] }>;
  init(): Promise<void>;
  all(): Preset[];
  byId(id: string): Preset | undefined;
  toggleFavorite(id: string): void;
  pushRecent(id: string): void;
  /** Saves to IndexedDB and the in-memory list; resolves false if storage refused it (e.g. full). */
  saveUser(p: Preset): Promise<boolean>;
  deleteUser(id: string): Promise<void>;
}

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export const usePresets = create<PresetState>((set, get) => ({
  ready: false,
  user: [],
  favorites: lsGet<string[]>('optic.favorites', []),
  recent: lsGet<string[]>('optic.recent', []),
  luts: [],
  async init() {
    if (get().ready) return;
    const syncLuts = () =>
      set({ luts: lutRegistry.all().map((l) => ({ id: l.id, name: l.name, size: l.size, source: l.source })) });
    lutRegistry.subscribe(syncLuts);
    const [user, luts] = await Promise.all([dbGetAll<Preset>('presets'), dbGetAll<LutData>('luts')]);
    for (const l of luts) lutRegistry.set(l);
    await Promise.all(
      BUNDLED_LUTS.map(async (b) => {
        try {
          const text = await (await fetch(b.url)).text();
          lutRegistry.set({ ...parseCube(text, b.name), name: b.name, id: b.id, source: 'builtin' });
        } catch (e) {
          console.warn('[optic] bundled LUT failed to load', b.url, e);
        }
      }),
    );
    set({ user: user.map((p) => ({ ...p, builtin: false })), ready: true });
    syncLuts();
  },
  all: () => [...BUILTIN_PRESETS, ...get().user],
  byId: (id) => BUILTIN_PRESETS.find((p) => p.id === id) ?? get().user.find((p) => p.id === id),
  toggleFavorite(id) {
    const f = get().favorites;
    const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
    lsSet('optic.favorites', next);
    set({ favorites: next });
  },
  pushRecent(id) {
    const next = [id, ...get().recent.filter((x) => x !== id)].slice(0, 12);
    lsSet('optic.recent', next);
    set({ recent: next });
  },
  async saveUser(p) {
    const clean = { ...p, builtin: undefined };
    const persisted = await dbPut('presets', clean).then(() => true, (e) => { console.warn('[optic] preset not persisted', e); return false; });
    set({ user: [...get().user.filter((x) => x.id !== p.id), { ...p, builtin: false }] });
    return persisted;
  },
  async deleteUser(id) {
    await dbDelete('presets', id).catch(() => {});
    set({ user: get().user.filter((x) => x.id !== id) });
  },
}));

// ---------------------------------------------------------------------------
// Validation, import / export
// ---------------------------------------------------------------------------

/** Validate and normalise untrusted preset JSON. Throws with a readable message. */
export function validatePreset(json: unknown, keepId = false): Preset {
  if (!json || typeof json !== 'object') throw new Error('Not a preset (expected a JSON object)');
  const j = json as Record<string, unknown>;
  if (typeof j.name !== 'string' || !j.name.trim()) throw new Error('Preset has no name');
  if (!j.settings || typeof j.settings !== 'object') throw new Error(`Preset "${j.name}" has no settings`);
  const includes = Array.isArray(j.includes)
    ? (j.includes.filter((g) => PRESET_GROUPS.includes(g as PresetGroup)) as PresetGroup[])
    : [];
  if (!includes.length) throw new Error(`Preset "${j.name}" includes no known groups`);
  return {
    id: keepId && typeof j.id === 'string' ? j.id : uid('user'),
    name: j.name.trim().slice(0, 80),
    group: typeof j.group === 'string' && j.group.trim() ? j.group.trim().slice(0, 60) : 'My Presets',
    version: 3,
    description: typeof j.description === 'string' ? j.description.slice(0, 500) : undefined,
    tags: Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : undefined,
    includes,
    settings: j.settings as Record<string, unknown>,
    nonRaw: j.nonRaw && typeof j.nonRaw === 'object' ? (j.nonRaw as Record<string, unknown>) : undefined,
    lut: typeof j.lut === 'string' ? j.lut : undefined,
  };
}

export function presetToJson(p: Preset): string {
  const { builtin: _b, ...rest } = p;
  return JSON.stringify(rest, null, 2);
}

export async function importLut(file: File): Promise<LutData> {
  const parsed = await parseLutFile(file);
  const lut: LutData = { ...parsed, id: uid('lut') };
  lutRegistry.set(lut);
  await dbPut('luts', lut).catch((e) => console.warn('[optic] LUT not persisted', e));
  return lut;
}

export async function deleteLut(id: string) {
  lutRegistry.delete(id);
  await dbDelete('luts', id).catch(() => {});
}

/** One Lightroom file in an import: what became of it (shown in the import report). */
export interface LightroomReportRow {
  file: string;
  status: 'converted' | 'partial' | 'failed' | 'duplicate';
  /** The preset's name, when it was converted. */
  name?: string;
  /** The group the converted preset was saved in. */
  group?: string;
  /** True when it replaced a preset imported earlier (same Lightroom preset). */
  updated?: boolean;
  /** True when browser storage refused it: usable until the page is reloaded. */
  notSaved?: boolean;
  notConverted?: NotConverted[];
  legacy?: boolean;
  error?: LightroomErrorCode;
}

export interface ImportSummary {
  presets: number;
  luts: number;
  /** Presets that came from Lightroom files (included in `presets`). */
  lightroom: number;
  errors: string[];
  report: LightroomReportRow[];
}

/** Zips larger than this, packed or unpacked, are not preset packs (DNG preset packs included). */
const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_UNPACKED = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1000;
/** Lightroom files (the converter itself is loaded on first use). */
const LIGHTROOM_EXT = /\.(xmp|lrtemplate|dng)$/i;
/** Yield to the event loop every few files so a large pack never blocks the UI. */
const YIELD_EVERY = 20;

/** Folder names in preset packs that say nothing about the look ("Pack/XMP/Moody.xmp"). */
const GENERIC_FOLDER = /^(xmp|lrtemplates?|dngs?|presets?|lightroom( classic| cc| mobile)?( presets?)?|lr( presets?)?|desktop|mobile|camera ?raw|acr|files?)$/i;

/** The group for a preset found in a zip: its nearest meaningful folder, else the zip's name. */
function zipGroup(entryPath: string, zipName: string): string {
  const folders = entryPath.split('/').slice(0, -1).filter((f) => f && f !== '__MACOSX');
  for (let i = folders.length - 1; i >= 0; i--) if (!GENERIC_FOLDER.test(folders[i].trim())) return folders[i].trim();
  const base = zipName.replace(/\.[^.]+$/, '').trim();
  return GENERIC_FOLDER.test(base) ? '' : base;
}

/** macOS resource forks and Finder metadata that ride along in zips. */
const isJunk = (path: string) => /(^|\/)(__MACOSX\/|\._)/.test(path) || /(^|\/)\.DS_Store$/.test(path);

/**
 * Import .json presets, .opticpack bundles, .cube / Hald .png LUTs, and Lightroom / Camera Raw
 * presets (.xmp, .lrtemplate, DNG presets), on their own or in a .zip. Returns a summary.
 */
export async function importFiles(
  files: File[],
  opts: { onProgress?(done: number, total: number): void } = {},
): Promise<ImportSummary> {
  const res: ImportSummary = { presets: 0, luts: 0, lightroom: 0, errors: [], report: [] };
  const store = usePresets.getState();
  let total = files.length;
  let done = 0;
  const seenLr = new Set<string>();
  const tick = async () => {
    done++;
    opts.onProgress?.(done, total);
    if (done % YIELD_EVERY === 0) await new Promise((r) => setTimeout(r, 0));
  };

  /** Convert and save one Lightroom file; never throws (failures become report rows). */
  const importLightroom = async (path: string, read: () => Promise<Uint8Array>, size: number, group?: string) => {
    const lr = await import('../presets/lightroom');
    const file = path.replace(/^.*\//, '');
    try {
      if (size > lightroomLimit(path)) throw new lr.LightroomImportError('tooLarge');
      const r = lr.importLightroomFile(path, await read(), { group });
      if (seenLr.has(r.preset.id)) {
        // The same preset in another format in the same pack (.xmp next to .lrtemplate).
        res.report.push({ file, status: 'duplicate', name: r.preset.name });
        return;
      }
      seenLr.add(r.preset.id);
      const p = validatePreset(r.preset, true);
      p.description = lightroomDescription(file, r.notConverted, r.legacyProcess);
      const updated = usePresets.getState().user.some((u) => u.id === p.id);
      const saved = await store.saveUser(p);
      res.presets++;
      res.lightroom++;
      res.report.push({
        file,
        status: r.notConverted.length || r.legacyProcess ? 'partial' : 'converted',
        name: p.name,
        group: p.group,
        updated,
        ...(saved ? {} : { notSaved: true }),
        notConverted: r.notConverted,
        legacy: r.legacyProcess,
      });
    } catch (e) {
      if (e instanceof lr.LightroomImportError) {
        res.report.push({ file, status: 'failed', error: e.code, notConverted: e.notConverted });
      } else {
        res.report.push({ file, status: 'failed', error: 'unreadable' });
      }
    }
  };

  for (const f of files) {
    try {
      if (/\.json$/i.test(f.name)) {
        await store.saveUser(validatePreset(JSON.parse(await f.text())));
        res.presets++;
      } else if (LIGHTROOM_EXT.test(f.name)) {
        await importLightroom(f.name, async () => new Uint8Array(await f.arrayBuffer()), f.size);
      } else if (/\.opticpack$|\.zip$/i.test(f.name)) {
        if (f.size > MAX_ZIP_BYTES) throw new Error(t('presets.import.zipTooLarge'));
        // Limits are checked from the zip directory before anything is inflated; entries that are
        // not presets (or too large to be one) are never inflated at all.
        const nested: string[] = [];
        const oversized: string[] = [];
        let entries;
        try {
          entries = await readZip(new Uint8Array(await f.arrayBuffer()), {
            maxEntries: MAX_ZIP_ENTRIES,
            maxTotalBytes: MAX_ZIP_UNPACKED,
            include: (name, size) => {
              if (isJunk(name)) return false;
              if (/\.(zip|opticpack)$/i.test(name)) { nested.push(name); return false; }
              if (LIGHTROOM_EXT.test(name)) {
                if (size > lightroomLimit(name)) { oversized.push(name); return false; }
                return true;
              }
              return /\.(json|cube)$/i.test(name);
            },
          });
        } catch (e) {
          if (e instanceof ZipLimitError) {
            throw new Error(e.kind === 'entries' ? t('presets.import.zipTooMany', { max: MAX_ZIP_ENTRIES }) : t('presets.import.zipTooBig'));
          }
          throw e;
        }
        for (const name of oversized) res.report.push({ file: name.replace(/^.*\//, ''), status: 'failed', error: 'tooLarge' });
        for (const name of nested) res.errors.push(`${name}: ${t('presets.import.nestedZip')}`);
        const lrEntries = entries.filter((e) => LIGHTROOM_EXT.test(e.name));
        total += lrEntries.length;
        for (const e of lrEntries) {
          await importLightroom(e.name, async () => e.data, e.data.length, zipGroup(e.name, f.name) || undefined);
          await tick();
        }
        const known = entries.filter((x) => /\.(json|cube)$/i.test(x.name));
        if (!known.length && !lrEntries.length && !oversized.length && !nested.length) throw new Error(t('presets.import.emptyZip'));
        const lutIdMap = new Map<string, string>();
        for (const e of entries.filter((x) => /\.cube$/i.test(x.name))) {
          const oldId = e.name.replace(/^.*\//, '').replace(/\.cube$/i, '');
          const lut: LutData = { ...parseCube(new TextDecoder().decode(e.data), oldId), id: uid('lut'), source: 'cube' };
          lutRegistry.set(lut);
          await dbPut('luts', lut).catch(() => {});
          lutIdMap.set(oldId, lut.id);
          res.luts++;
        }
        for (const e of entries.filter((x) => /\.json$/i.test(x.name))) {
          const p = validatePreset(JSON.parse(new TextDecoder().decode(e.data)));
          if (p.lut && lutIdMap.has(p.lut)) p.lut = lutIdMap.get(p.lut);
          const s = p.settings.lut as Record<string, unknown> | undefined;
          if (s && typeof s.id === 'string' && lutIdMap.has(s.id)) s.id = lutIdMap.get(s.id);
          await store.saveUser(p);
          res.presets++;
        }
      } else if (/\.cube$|\.png$/i.test(f.name)) {
        await importLut(f);
        res.luts++;
      } else res.errors.push(`${f.name}: ${t('presets.import.unsupported')}`);
    } catch (e) {
      res.errors.push(`${f.name}: ${e instanceof LutError || e instanceof Error ? e.message : String(e)}`);
    }
    await tick();
  }
  return res;
}

/** The note stored in a converted preset's description (shown in its tooltip). */
function lightroomDescription(file: string, notConverted: NotConverted[], legacy: boolean): string {
  const parts = [t('lr.description', { file })];
  if (legacy) parts.push(t('lr.error.legacy'));
  if (notConverted.length) parts.push(t('lr.description.skipped', { list: notConvertedText(notConverted) }));
  return parts.join(' ').slice(0, 500);
}

/** "camera profile (Adobe Portrait), 2 masks" — the translated list of what was not converted. */
export function notConvertedText(items: NotConverted[]): string {
  return items
    .map((n) => {
      const detail = n.code === 'photoSpecific' && n.detail
        ? n.detail.split(', ').map((g) => GROUP_LABELS[g as PresetGroup] ?? g).join(', ')
        : n.detail ?? '';
      return t(`lr.skip.${n.code}`, { detail }).replace(/\s*\(\)$/, '');
    })
    .join(', ');
}

/** Build an .opticpack (zip of preset JSON files + the user LUTs they reference). */
export function buildPack(presets: Preset[]): Uint8Array {
  const enc = new TextEncoder();
  const entries = presets.map((p) => ({ name: `presets/${p.id}.json`, data: enc.encode(presetToJson(p)) }));
  const lutIds = new Set<string>();
  for (const p of presets) {
    if (p.lut) lutIds.add(p.lut);
    const s = p.settings.lut as Record<string, unknown> | undefined;
    if (s && typeof s.id === 'string') lutIds.add(s.id);
  }
  for (const id of lutIds) {
    const l = lutRegistry.get(id);
    if (l) entries.push({ name: `luts/${id}.cube`, data: enc.encode(toCube(l)) });
  }
  return writeZip(entries);
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
