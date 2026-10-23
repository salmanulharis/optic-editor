/**
 * Batch editing. Every batch operation becomes exactly one history step per photo (on the photo's
 * active virtual copy), so each photo can be undone on its own. The open photo is edited through
 * the edit store (its history panel updates live); other photos through their stored documents.
 * Cached previews are re-rendered afterwards.
 *
 *  - Sync settings: chosen recipe groups from the active photo to the selection; Auto Sync repeats
 *    every committed change of the open photo on the other selected photos.
 *  - Paste settings and presets (with an amount) on the whole selection.
 *  - Auto white balance / auto tone, measured per photo.
 *  - Match look: exposure and white balance relative to a reference photo, from histograms and
 *    neutral estimates; only those fields are written.
 *  - Reset to each photo's defaults.
 */
import { create } from 'zustand';
import { estimateNeutral, autoTone as autoToneCalc } from '../color/autoTools';
import type { Vec3 } from '../color/matrices';
import { relativeToTempTint, tempTintToRelative } from '../color/whiteBalance';
import { wbForNeutral } from '../app/actions';
import { applyPreset } from '../presets/apply';
import type { Preset } from '../presets/types';
import { aiCacheKey, aiModelFor, isAiType } from '../recipe/masks';
import { type PresetGroup, type Recipe, defaultRecipe, getGroup, setGroup } from '../recipe/schema';
import { type DocRecord, type HistoryStep, activeCopy, loadDoc, saveDoc, useEdit } from '../state/editStore';
import { type LoadedImage, useImage } from '../state/imageStore';
import { targetIds, useLibrary } from '../state/libraryStore';
import type { PhotoRecord } from './db';
import { decodePhoto } from './decode';
import { ensureDoc, enqueuePreviews, mainRecipe, pausePreviews, renderLinear } from './previews';

interface BatchState {
  running: boolean;
  label: string;
  done: number;
  total: number;
  errors: Array<{ name: string; message: string }>;
  cancel: boolean;
  /** Auto Sync: committed edits of the open photo repeat on the other selected photos. */
  autoSync: boolean;
  set(p: Partial<BatchState>): void;
}

export const useBatch = create<BatchState>((set) => ({
  running: false, label: '', done: 0, total: 0, errors: [], cancel: false, autoSync: false,
  set: (p) => set(p),
}));

const MAX_STEPS = 500;
/** Set while a batch edits the open photo, so Auto Sync does not repeat the batch's own edits. */
let inBatch = 0;

interface PhotoCtx {
  rec: PhotoRecord;
  isRaw: boolean;
  /** The photo's defaults (its first history step: As Shot WB, source-type defaults). */
  defaults: Recipe;
  /** The decoded photo, for operations that measure pixels. */
  img?: LoadedImage;
}

type EditFn = (r: Recipe, ctx: PhotoCtx) => Recipe | Promise<Recipe>;

const same = (a: Recipe, b: Recipe) => JSON.stringify(a) === JSON.stringify(b);

/** AI masks refer to their photo's bitmaps: re-key them for the photo they are copied to. */
function rekeyMasks(r: Recipe, photoKey: string): Recipe {
  if (!r.masks.length) return r;
  return {
    ...r,
    masks: r.masks.map((m) => ({
      ...m,
      components: m.components.map((c) => (isAiType(c.type) ? { ...c, cacheKey: aiCacheKey(photoKey, aiModelFor(c)!) } : c)),
    })),
  };
}

/**
 * Apply `fn` to each photo's current recipe as one named history step. `needPixels`: decode each
 * photo (auto tools, match look). Runs one photo at a time with progress and cancel.
 */
export async function editPhotos(ids: string[], label: string, fn: EditFn, opts: { needPixels?: boolean; quiet?: boolean } = {}) {
  const b = useBatch.getState();
  if (!opts.quiet) b.set({ running: true, label, done: 0, total: ids.length, errors: [], cancel: false });
  pausePreviews('batch', true);
  const lib = useLibrary.getState();
  const touched: string[] = [];
  try {
    for (const id of ids) {
      if (useBatch.getState().cancel) break;
      const rec = lib.byId.get(id) ?? useLibrary.getState().byId.get(id);
      if (!rec) continue;
      try {
        const open = useImage.getState();
        if (open.photoId === id && open.image) {
          const e = useEdit.getState();
          e.commit();
          const c = activeCopy(e);
          const ctx: PhotoCtx = { rec, isRaw: open.image.isRaw, defaults: c.steps[0].recipe, img: open.image };
          const next = rekeyMasks(await fn(e.recipe, ctx), rec.key);
          inBatch++;
          try { if (!same(next, e.recipe)) e.apply(() => next, label); } finally { inBatch--; }
        } else {
          let doc = await loadDoc(rec.key);
          let img: LoadedImage | undefined;
          if (!doc || opts.needPixels) {
            img = await decodePhoto(rec, opts.needPixels ? 1024 : 512, mainRecipe(doc));
            doc ??= await ensureDoc(rec, img);
          }
          const c = activeCopy(doc);
          const cur = c.steps[c.index].recipe;
          const ctx: PhotoCtx = { rec, isRaw: rec.isRaw, defaults: c.steps[0].recipe, img };
          const next = rekeyMasks(await fn(cur, ctx), rec.key);
          if (img) (img as { full: unknown }).full = null;
          if (!same(next, cur)) await saveDoc(appendStep(doc, next, label));
        }
        touched.push(id);
      } catch (e) {
        console.warn('[optic] batch edit failed', rec.fileName, e);
        useBatch.getState().set({ errors: [...useBatch.getState().errors, { name: rec.fileName, message: (e as Error).message || String(e) }] });
      }
      if (!opts.quiet) useBatch.getState().set({ done: useBatch.getState().done + 1 });
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    pausePreviews('batch', false);
    if (!opts.quiet) useBatch.getState().set({ running: false, cancel: false });
    enqueuePreviews(touched.filter((id) => id !== useImage.getState().photoId));
  }
}

function appendStep(doc: DocRecord, recipe: Recipe, label: string): DocRecord {
  const c = activeCopy(doc);
  const step: HistoryStep = { label, recipe, t: Date.now(), key: `batch:${Date.now()}` };
  let steps = [...c.steps.slice(0, c.index + 1), step];
  if (steps.length > MAX_STEPS) steps = [steps[0], ...steps.slice(steps.length - MAX_STEPS + 1)];
  return { ...doc, updated: Date.now(), copies: doc.copies.map((x) => (x.id === c.id ? { ...c, steps, index: steps.length - 1 } : x)) };
}

// ---------------------------------------------------------------------------
// Sync, paste, presets, reset
// ---------------------------------------------------------------------------

/** White balance means different things for RAW (Kelvin) and non-RAW (relative): convert. */
function convertWb(src: Recipe, srcRaw: boolean, dstRaw: boolean): Partial<Recipe> {
  const wb = src.whiteBalance;
  if (srcRaw === dstRaw || wb.mode === 'asShot' || wb.mode === 'auto') return { whiteBalance: wb };
  if (srcRaw) {
    const rel = tempTintToRelative(wb.temperature, wb.tint);
    return { whiteBalance: { ...wb, temperature: Math.round(rel.temperature), tint: Math.round(rel.tint) } };
  }
  const tt = relativeToTempTint(wb.temperature, wb.tint);
  return { whiteBalance: { ...wb, temperature: Math.round(tt.temperature / 50) * 50, tint: Math.round(tt.tint) } };
}

function withGroups(r: Recipe, src: Recipe, groups: PresetGroup[], srcRaw: boolean, ctx: PhotoCtx): Recipe {
  let out = r;
  for (const g of groups) {
    if (g === 'whiteBalance') {
      // As Shot / Auto stay relative to each photo; custom values are converted between units.
      const wb = src.whiteBalance;
      if (wb.mode === 'asShot') out = { ...out, whiteBalance: { ...ctx.defaults.whiteBalance, castStrength: wb.castStrength, castEstimate: wb.castEstimate } };
      else out = setGroup(out, g, convertWb(src, srcRaw, ctx.isRaw));
    } else out = setGroup(out, g, getGroup(src, g));
  }
  return out;
}

/** The active photo's current recipe and type (the open photo, or its stored document). */
export async function activeSource(): Promise<{ recipe: Recipe; isRaw: boolean; id: string } | null> {
  const lib = useLibrary.getState();
  const id = lib.active;
  if (!id) return null;
  const open = useImage.getState();
  if (open.photoId === id && open.image) { useEdit.getState().commit(); return { recipe: useEdit.getState().recipe, isRaw: open.image.isRaw, id }; }
  const rec = lib.byId.get(id);
  const doc = rec ? await loadDoc(rec.key) : null;
  if (!rec || !doc) return null;
  const c = activeCopy(doc);
  return { recipe: c.steps[c.index].recipe, isRaw: rec.isRaw, id };
}

export async function syncSettings(groups: PresetGroup[], ids = targetIds()) {
  const src = await activeSource();
  if (!src || !groups.length) return;
  const others = ids.filter((id) => id !== src.id);
  await editPhotos(others, 'Sync settings', (r, ctx) => withGroups(r, src.recipe, groups, src.isRaw, ctx));
}

export async function pasteToSelection(groups: PresetGroup[], clip: { groups: PresetGroup[]; recipe: Recipe }, srcRaw: boolean, ids = targetIds()) {
  const gs = groups.filter((g) => clip.groups.includes(g));
  await editPhotos(ids, 'Paste settings', (r, ctx) => withGroups(r, clip.recipe, gs, srcRaw, ctx));
}

export async function applyPresetToSelection(p: Preset, amount: number, ids = targetIds()) {
  await editPhotos(ids, `Preset: ${p.name} (${Math.round(amount)}%)`, (r, ctx) => applyPreset(r, p, ctx.isRaw, amount));
}

export async function resetSelection(ids = targetIds()) {
  await editPhotos(ids, 'Reset all', (r, ctx) => ({ ...ctx.defaults, output: r.output }));
}

// ---------------------------------------------------------------------------
// Auto Sync
// ---------------------------------------------------------------------------

let autoSyncUnsub: (() => void) | null = null;
let pendingGroups = new Set<PresetGroup>();
let flushTimer: number | undefined;
const ALL_GROUPS = (() => {
  const all: PresetGroup[] = ['whiteBalance', 'exposure', 'light', 'look', 'curve', 'hsl', 'bw', 'pointColor', 'colorGrading', 'calibration', 'presence', 'lut', 'clarity', 'grain', 'glow', 'vignette', 'sharpening', 'noiseReduction', 'lens', 'geometry', 'crop', 'masks'];
  return all;
})();

/** Groups whose values differ between two recipes. */
export function changedGroups(a: Recipe, b: Recipe): PresetGroup[] {
  return ALL_GROUPS.filter((g) => {
    if (g === 'exposure') return a.light.exposure !== b.light.exposure;
    if (g === 'light') return JSON.stringify({ ...a.light, exposure: 0 }) !== JSON.stringify({ ...b.light, exposure: 0 });
    return JSON.stringify(getGroup(a, g)) !== JSON.stringify(getGroup(b, g));
  });
}

export function setAutoSync(on: boolean) {
  useBatch.getState().set({ autoSync: on });
  autoSyncUnsub?.();
  autoSyncUnsub = null;
  if (!on) return;
  autoSyncUnsub = useEdit.subscribe((s, p) => {
    if (s.committed === p.committed || !useImage.getState().photoId || inBatch) return;
    // Switching photos or copies, undo / redo are not edits to repeat.
    if (s.docKey !== p.docKey || s.active !== p.active) return;
    const cs = activeCopy(s), cp = activeCopy(p);
    if (cp.steps.includes(cs.steps[cs.index])) return;
    for (const g of changedGroups(p.committed, s.committed)) pendingGroups.add(g);
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      const groups = [...pendingGroups];
      pendingGroups = new Set();
      const ids = targetIds().filter((id) => id !== useImage.getState().photoId);
      const img = useImage.getState().image;
      if (!ids.length || !groups.length || !img) return;
      const src = useEdit.getState().committed;
      void editPhotos(ids, 'Auto Sync', (r, ctx) => withGroups(r, src, groups, img.isRaw, ctx), { quiet: true });
    }, 600);
  });
}

// ---------------------------------------------------------------------------
// Auto white balance / tone, per photo
// ---------------------------------------------------------------------------

function autoWb(img: LoadedImage) {
  const start: Vec3 = img.color.kind === 'raw' ? img.color.profile.asShotNeutral : [1, 1, 1];
  return wbForNeutral(img, estimateNeutral(img.thumb.data, start));
}

export async function batchAutoWb(ids = targetIds()) {
  await editPhotos(ids, 'Auto white balance', (r, ctx) => {
    const wb = autoWb(ctx.img!);
    return { ...r, whiteBalance: { ...r.whiteBalance, enabled: true, mode: 'auto', ...wb } };
  }, { needPixels: true });
}

export async function batchAutoTone(ids = targetIds()) {
  await editPhotos(ids, 'Auto tone', async (r, ctx) => {
    const base = { ...r, light: { ...defaultRecipe().light, deband: r.light.deband, deblock: r.light.deblock } };
    const res = await renderLinear(ctx.img!, base, 256, 'cast');
    const t = autoToneCalc(res.data as Float32Array, ctx.isRaw);
    return { ...r, light: { ...r.light, enabled: true, ...t } };
  }, { needPixels: true });
}

// ---------------------------------------------------------------------------
// Match look
// ---------------------------------------------------------------------------

/** WB as (mired, tint) whatever the source type, and back. */
const toKelvin = (isRaw: boolean, t: number, tint: number) => (isRaw ? { temperature: t, tint } : relativeToTempTint(t, tint));
const fromKelvin = (isRaw: boolean, temperature: number, tint: number) => {
  if (isRaw) return { temperature: Math.round(Math.min(50000, Math.max(2000, temperature)) / 50) * 50, tint: Math.round(Math.min(150, Math.max(-150, tint))) };
  const r = tempTintToRelative(temperature, tint);
  return { temperature: Math.round(r.temperature), tint: Math.round(r.tint) };
};

/** Median log2 luminance of a linear render (before exposure). */
async function medianLogY(img: LoadedImage, r: Recipe): Promise<number> {
  const res = await renderLinear(img, r, 256, 'cast');
  const d = res.data as Float32Array;
  const ys: number[] = [];
  for (let i = 0; i < d.length; i += 4) ys.push(Math.log2(Math.max(1e-5, 0.2627 * d[i] + 0.678 * d[i + 1] + 0.0593 * d[i + 2])));
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)] ?? -2.5;
}

/**
 * Match exposure and white balance of the selection to the reference (the active photo): its
 * rendered median brightness and its white balance offset from its own neutral estimate.
 */
export async function matchLook(referenceId: string, ids = targetIds()) {
  const lib = useLibrary.getState();
  const refRec = lib.byId.get(referenceId);
  if (!refRec) return;
  useBatch.getState().set({ running: true, label: 'Match look: measuring the reference', done: 0, total: ids.length, errors: [] });
  let ref: { logY: number; exposure: number; dMired: number; dTint: number };
  try {
    const doc = await loadDoc(refRec.key);
    const img = await decodePhoto(refRec, 1024, mainRecipe(doc));
    const d = doc ?? (await ensureDoc(refRec, img));
    const c = activeCopy(d);
    const r = useImage.getState().photoId === referenceId ? useEdit.getState().recipe : c.steps[c.index].recipe;
    const auto = toKelvin(img.isRaw, ...Object.values(autoWb(img)) as [number, number]);
    const cur = r.whiteBalance.mode === 'asShot' ? toKelvin(img.isRaw, img.asShot.temperature, img.asShot.tint) : toKelvin(img.isRaw, r.whiteBalance.temperature, r.whiteBalance.tint);
    ref = {
      logY: await medianLogY(img, r),
      exposure: r.light.exposure,
      dMired: 1e6 / cur.temperature - 1e6 / auto.temperature,
      dTint: cur.tint - auto.tint,
    };
  } catch (e) {
    useBatch.getState().set({ running: false, errors: [{ name: refRec.fileName, message: (e as Error).message }] });
    return;
  }
  await editPhotos(ids.filter((id) => id !== referenceId), `Match look: ${refRec.fileName}`, async (r, ctx) => {
    const img = ctx.img!;
    const auto = toKelvin(img.isRaw, ...Object.values(autoWb(img)) as [number, number]);
    const wb = fromKelvin(img.isRaw, 1e6 / (1e6 / auto.temperature + ref.dMired), auto.tint + ref.dTint);
    const r2: Recipe = { ...r, whiteBalance: { ...r.whiteBalance, enabled: true, mode: 'custom', ...wb } };
    const logY = await medianLogY(img, r2);
    const exposure = Math.round(Math.min(5, Math.max(-5, ref.exposure + ref.logY - logY)) * 100) / 100;
    return { ...r2, light: { ...r2.light, enabled: true, exposure } };
  }, { needPixels: true });
}
