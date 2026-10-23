/**
 * The edit recipe and its history, per photo and per virtual copy.
 *
 * Continuous edits (slider drags) call `update`; the change is committed as one named history step
 * on release via `commit`. Discrete edits use `apply`, which updates and commits in one step, with
 * an optional label ("Preset: Portra 400-like (80%)"); otherwise the label is derived from what
 * changed ("Exposure +0.65"). Rapid consecutive edits of the same control (within 1.5 s) are
 * collapsed into one step.
 *
 * History is a list of steps with a current index: undo / redo / click-to-jump move the index, and
 * a new edit truncates the steps after it. Snapshots are named recipes. A virtual copy is a second
 * recipe (with its own history and snapshots) for the same file. The whole document is saved to
 * IndexedDB per photo (debounced) and restored when the same file is opened again.
 */
import { create } from 'zustand';
import { type Recipe, type SectionKey, defaultRecipe } from '../recipe/schema';
import { deserializeRecipe } from '../recipe/serialize';
import { catalog } from '../library/db';
import { dbGet } from '../storage/db';
import { describeChange } from './describe';

const MAX_STEPS = 500;
const COALESCE_MS = 1500;
const DOC_VERSION = 1;

export interface HistoryStep {
  label: string;
  recipe: Recipe;
  /** Time of the edit (ms since epoch). */
  t: number;
  /** Changed fields, for collapsing repeated edits of one control. */
  key: string;
}

export interface Snapshot {
  id: string;
  name: string;
  recipe: Recipe;
  t: number;
}

export interface VirtualCopy {
  id: string;
  name: string;
  steps: HistoryStep[];
  index: number;
  snapshots: Snapshot[];
}

export interface DocRecord {
  key: string;
  version: number;
  fileName: string;
  updated: number;
  active: string;
  copies: VirtualCopy[];
}

interface EditState {
  recipe: Recipe;
  /** Last committed recipe (the current history step). */
  committed: Recipe;
  copies: VirtualCopy[];
  active: string;
  /** The recipe as it was when the photo was opened in this session (compare "Before"). */
  sessionStart: Recipe | null;
  docKey: string | null;
  update(fn: (r: Recipe) => Recipe): void;
  /** `key`: with a label, still collapse rapid repeats that share this key (e.g. preset amount). */
  commit(label?: string, key?: string): void;
  apply(fn: (r: Recipe) => Recipe, label?: string): void;
  undo(): void;
  redo(): void;
  /** Show history step i and continue editing from there. */
  jump(i: number): void;
  /** Replace everything without persistence (no photo document). */
  reset(r: Recipe): void;
  /** Load (or start) the document of a photo. `defaults` is the recipe of a fresh edit. */
  openDoc(key: string, fileName: string, defaults: Recipe, stored: DocRecord | null): void;
  setSectionEnabled(k: SectionKey, on: boolean): void;
  createSnapshot(name?: string): void;
  restoreSnapshot(id: string): void;
  renameSnapshot(id: string, name: string): void;
  updateSnapshot(id: string): void;
  deleteSnapshot(id: string): void;
  createVirtualCopy(): void;
  switchCopy(id: string): void;
  renameCopy(id: string, name: string): void;
  deleteCopy(id: string): void;
}

const same = (a: Recipe, b: Recipe) => a === b || JSON.stringify(a) === JSON.stringify(b);
const uid = () => crypto.randomUUID().slice(0, 8);
const firstStep = (r: Recipe, label = 'Opened'): HistoryStep => ({ label, recipe: r, t: Date.now(), key: '' });
export const dateName = () => new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The active copy. */
export function activeCopy(s: Pick<EditState, 'copies' | 'active'>): VirtualCopy {
  return s.copies.find((c) => c.id === s.active) ?? s.copies[0];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let saveTimer: number | undefined;
const savedListeners = new Set<(doc: DocRecord) => void>();

/** Called after every save of the open photo's document (the library mirrors the recipe). */
export function onDocSaved(fn: (doc: DocRecord) => void) {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

export async function saveDoc(doc: DocRecord) {
  await catalog.docs.put(doc);
  savedListeners.forEach((f) => f(doc));
}

function saveNow() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  const s = useEdit.getState();
  if (!s.docKey) return;
  const doc: DocRecord = { key: s.docKey, version: DOC_VERSION, fileName: docFileName, updated: Date.now(), active: s.active, copies: s.copies };
  saveDoc(doc).catch((e) => console.warn('[optic] history not saved', e));
}

function scheduleSave() {
  const { docKey } = useEdit.getState();
  if (!docKey || typeof window === 'undefined') return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 400);
}
let docFileName = '';

/** Write a pending save right away (page hidden / unloading). */
export function flushSave() {
  if (saveTimer !== undefined) saveNow();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushSave());
}

/** The stored document of a photo (catalog; documents from before the catalog are read once). */
export async function loadDoc(key: string): Promise<DocRecord | null> {
  const d = (await catalog.docs.get(key).catch(() => undefined)) ?? (await dbGet<DocRecord>('docs', key));
  if (!d || !Array.isArray(d.copies) || !d.copies.length) return null;
  try {
    // Recipes are migrated like any other stored recipe.
    const fix = (r: unknown) => deserializeRecipe(r);
    return {
      ...d,
      copies: d.copies.map((c) => ({
        ...c,
        steps: c.steps.map((s) => ({ ...s, recipe: fix(s.recipe) })),
        snapshots: (c.snapshots ?? []).map((s) => ({ ...s, recipe: fix(s.recipe) })),
        index: Math.min(Math.max(0, c.index), c.steps.length - 1),
      })),
    };
  } catch (e) {
    console.warn('[optic] stored history unreadable, starting fresh', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEdit = create<EditState>((set, get) => {
  /** Write the active copy back (immutably) and persist. */
  const putCopy = (c: VirtualCopy, extra: Partial<EditState> = {}) => {
    set({ copies: get().copies.map((x) => (x.id === c.id ? c : x)), ...extra });
    scheduleSave();
  };

  return {
    recipe: defaultRecipe(),
    committed: defaultRecipe(),
    copies: [{ id: 'main', name: 'Original', steps: [firstStep(defaultRecipe())], index: 0, snapshots: [] }],
    active: 'main',
    sessionStart: null,
    docKey: null,

    update: (fn) => set({ recipe: fn(get().recipe) }),

    commit(label, key) {
      const s = get();
      const c = activeCopy(s);
      const cur = c.steps[c.index];
      if (same(s.recipe, cur.recipe)) return;
      const d = describeChange(cur.recipe, s.recipe);
      const now = Date.now();
      const step: HistoryStep = { label: label ?? d.label, recipe: s.recipe, t: now, key: key ?? (label ? `label:${label}` : d.key) };
      let steps = c.steps.slice(0, c.index + 1);
      const last = steps[steps.length - 1];
      // Collapse rapid repeats of one control (arrow keys, wheel, several short drags).
      const coalescible = !label || !!key;
      if (coalescible && steps.length > 1 && last.key && last.key === step.key && now - last.t < COALESCE_MS) steps[steps.length - 1] = step;
      else steps.push(step);
      // Cap: keep the opening state, drop the oldest edits after it.
      if (steps.length > MAX_STEPS) steps = [steps[0], ...steps.slice(steps.length - MAX_STEPS + 1)];
      putCopy({ ...c, steps, index: steps.length - 1 }, { committed: s.recipe });
    },

    apply(fn, label) {
      get().update(fn);
      get().commit(label);
    },

    undo() {
      get().commit();
      const c = activeCopy(get());
      if (c.index <= 0) return;
      get().jump(c.index - 1);
    },

    redo() {
      const c = activeCopy(get());
      if (c.index >= c.steps.length - 1) return;
      get().jump(c.index + 1);
    },

    jump(i) {
      const c = activeCopy(get());
      if (i < 0 || i >= c.steps.length) return;
      const r = c.steps[i].recipe;
      putCopy({ ...c, index: i }, { recipe: r, committed: r });
    },

    reset(r) {
      set({
        recipe: r,
        committed: r,
        copies: [{ id: 'main', name: 'Original', steps: [firstStep(r)], index: 0, snapshots: [] }],
        active: 'main',
        sessionStart: r,
        docKey: null,
      });
    },

    openDoc(key, fileName, defaults, stored) {
      docFileName = fileName;
      if (stored) {
        const active = stored.copies.some((c) => c.id === stored.active) ? stored.active : stored.copies[0].id;
        const c = stored.copies.find((x) => x.id === active)!;
        const r = c.steps[c.index].recipe;
        set({ recipe: r, committed: r, copies: stored.copies, active, sessionStart: r, docKey: key });
      } else {
        set({
          recipe: defaults,
          committed: defaults,
          copies: [{ id: 'main', name: 'Original', steps: [firstStep(defaults)], index: 0, snapshots: [] }],
          active: 'main',
          sessionStart: defaults,
          docKey: key,
        });
      }
    },

    setSectionEnabled: (k, on) => get().apply((r) => ({ ...r, [k]: { ...r[k], enabled: on } })),

    createSnapshot(name) {
      get().commit();
      const c = activeCopy(get());
      const snap: Snapshot = { id: uid(), name: name?.trim() || dateName(), recipe: get().recipe, t: Date.now() };
      putCopy({ ...c, snapshots: [...c.snapshots, snap] });
    },

    restoreSnapshot(id) {
      const snap = activeCopy(get()).snapshots.find((s) => s.id === id);
      if (snap) get().apply(() => snap.recipe, `Snapshot: ${snap.name}`);
    },

    renameSnapshot(id, name) {
      const c = activeCopy(get());
      putCopy({ ...c, snapshots: c.snapshots.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s)) });
    },

    updateSnapshot(id) {
      get().commit();
      const c = activeCopy(get());
      putCopy({ ...c, snapshots: c.snapshots.map((s) => (s.id === id ? { ...s, recipe: get().recipe, t: Date.now() } : s)) });
    },

    deleteSnapshot(id) {
      const c = activeCopy(get());
      putCopy({ ...c, snapshots: c.snapshots.filter((s) => s.id !== id) });
    },

    createVirtualCopy() {
      get().commit();
      const s = get();
      const n = s.copies.length;
      const copy: VirtualCopy = { id: uid(), name: `Virtual copy ${n}`, steps: [firstStep(s.recipe, 'Virtual copy')], index: 0, snapshots: [] };
      set({ copies: [...s.copies, copy], active: copy.id, committed: s.recipe });
      scheduleSave();
    },

    switchCopy(id) {
      if (id === get().active) return;
      get().commit();
      const c = get().copies.find((x) => x.id === id);
      if (!c) return;
      const r = c.steps[c.index].recipe;
      set({ active: id, recipe: r, committed: r });
      scheduleSave();
    },

    renameCopy(id, name) {
      set({ copies: get().copies.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name } : c)) });
      scheduleSave();
    },

    deleteCopy(id) {
      const s = get();
      if (s.copies.length <= 1) return;
      const copies = s.copies.filter((c) => c.id !== id);
      if (s.active === id) {
        const c = copies[0];
        const r = c.steps[c.index].recipe;
        set({ copies, active: c.id, recipe: r, committed: r });
      } else set({ copies });
      scheduleSave();
    },
  };
});
