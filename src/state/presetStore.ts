/**
 * Preset library state: built-in presets, user presets (IndexedDB), favourites and recents
 * (localStorage), and imported LUTs (IndexedDB → lutRegistry).
 */
import { create } from 'zustand';
import { type LutData, LutError, parseCube, parseLutFile, toCube } from '../io/lut/lut';
import { lutRegistry } from '../pipeline/lutRegistry';
import { BUILTIN_PRESETS, BUNDLED_LUTS } from '../presets/builtin';
import type { Preset } from '../presets/types';
import { PRESET_GROUPS, type PresetGroup } from '../recipe/schema';
import { dbDelete, dbGetAll, dbPut, lsGet, lsSet } from '../storage/db';
import { readZip, writeZip } from '../storage/zip';

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
  saveUser(p: Preset): Promise<void>;
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
    await dbPut('presets', clean).catch((e) => console.warn('[optic] preset not persisted', e));
    set({ user: [...get().user.filter((x) => x.id !== p.id), { ...p, builtin: false }] });
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

/** Import .json presets, .opticpack bundles, .cube / Hald .png LUTs. Returns a summary. */
export async function importFiles(files: File[]): Promise<{ presets: number; luts: number; errors: string[] }> {
  const res = { presets: 0, luts: 0, errors: [] as string[] };
  const store = usePresets.getState();
  for (const f of files) {
    try {
      if (/\.json$/i.test(f.name)) {
        await store.saveUser(validatePreset(JSON.parse(await f.text())));
        res.presets++;
      } else if (/\.opticpack$|\.zip$/i.test(f.name)) {
        const entries = await readZip(new Uint8Array(await f.arrayBuffer()));
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
      } else res.errors.push(`${f.name}: unsupported file type`);
    } catch (e) {
      res.errors.push(`${f.name}: ${e instanceof LutError || e instanceof Error ? e.message : String(e)}`);
    }
  }
  return res;
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
