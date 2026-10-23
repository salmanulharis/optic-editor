/**
 * Local-adjustment (mask) actions. Like every edit they only change the recipe: live updates while
 * a slider or handle is dragged (`update`), one named history step on release (`commit`).
 */
import { workingToOklab } from '../color/oklab';
import type { OutputTarget } from '../pipeline/types';
import {
  type Mask,
  type MaskAdjustments,
  type MaskComponent,
  type MaskOp,
  type MaskParams,
  type MaskType,
  type PersonPart,
  MAX_BRUSH_COMPONENTS,
  MAX_COLOR_SAMPLES,
  MAX_COMPONENTS,
  MAX_MASKS,
  TYPE_LABELS,
  PART_LABELS,
  aiCacheKey,
  aiModelFor,
  componentCount,
  defaultAdjustments,
  isAiType,
  maskUid,
  newComponent,
  newMask,
} from '../recipe/masks';
import { type Recipe, effectiveRecipe } from '../recipe/schema';
import { useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { useUi } from '../state/uiStore';
import { ensureAiMask } from '../ai/aiMasks';
import { getRenderer } from './actions';

const edit = () => useEdit.getState();
const masksOf = () => edit().recipe.masks;

export function findMask(id: string | null | undefined): Mask | undefined {
  return id ? masksOf().find((m) => m.id === id) : undefined;
}

function mapMasks(r: Recipe, id: string, fn: (m: Mask) => Mask): Recipe {
  return { ...r, masks: r.masks.map((m) => (m.id === id ? fn(m) : m)) };
}

/** Error text for an add that would exceed the shader budget, else null. */
export function budgetError(type: MaskType, newMask = false): string | null {
  const ms = masksOf();
  if (newMask && ms.length >= MAX_MASKS) return `Up to ${MAX_MASKS} masks per photo`;
  if (componentCount(ms) >= MAX_COMPONENTS) return `Up to ${MAX_COMPONENTS} mask components per photo`;
  if (type === 'brush' && ms.flatMap((m) => m.components).filter((c) => c.type === 'brush').length >= MAX_BRUSH_COMPONENTS) {
    return `Up to ${MAX_BRUSH_COMPONENTS} brush components per photo`;
  }
  return null;
}

/** Fill in the AI cache key of AI components for the open photo and start computing missing ones. */
function prepareComponent<T extends MaskType>(c: MaskComponent<T>): MaskComponent<T> {
  const img = useImage.getState().image;
  const model = aiModelFor(c);
  if (!img || !model) return c;
  const key = aiCacheKey(img.model.key, model);
  void ensureAiMask(model);
  return { ...c, cacheKey: key };
}

function defaultName(type: MaskType, part?: PersonPart) {
  if (type === 'aiPerson' && part && part !== 'all') return PART_LABELS[part];
  const n = masksOf().filter((m) => m.name.startsWith(TYPE_LABELS[type])).length;
  return n ? `${TYPE_LABELS[type]} ${n + 1}` : TYPE_LABELS[type];
}

/** Create a mask with one component (the first step of every new mask) and select it. */
export function addMask(type: MaskType, params?: Partial<MaskParams[MaskType]>, adjustments?: Partial<MaskAdjustments>) {
  const err = budgetError(type, true);
  if (err) { alert(err); return; }
  const comp = prepareComponent(newComponent(type, 'add', params as Partial<MaskParams[typeof type]>));
  const m = newMask(defaultName(type, (params as MaskParams['aiPerson'] | undefined)?.part), [comp], adjustments);
  edit().apply((r) => ({ ...r, masks: [...r.masks, m] }));
  useUi.getState().set({ masksOpen: true, selectedMask: m.id, selectedComp: comp.id, maskPick: type === 'colorRange' });
}

/** Add a component to a mask (add / subtract / intersect). */
export function addComponent(maskId: string, type: MaskType, op: MaskOp, params?: Partial<MaskParams[MaskType]>) {
  const err = budgetError(type);
  if (err) { alert(err); return; }
  const comp = prepareComponent(newComponent(type, op, params as Partial<MaskParams[typeof type]>));
  edit().apply((r) => mapMasks(r, maskId, (m) => ({ ...m, components: [...m.components, comp] })));
  useUi.getState().set({ selectedMask: maskId, selectedComp: comp.id, maskPick: type === 'colorRange' });
}

export function updateMask(id: string, patch: Partial<Mask>, live = false) {
  const fn = (r: Recipe) => mapMasks(r, id, (m) => ({ ...m, ...patch }));
  if (live) edit().update(fn); else edit().apply(fn);
}

export function setAdjustment<K extends keyof MaskAdjustments>(id: string, key: K, value: MaskAdjustments[K]) {
  edit().update((r) => mapMasks(r, id, (m) => ({ ...m, adjustments: { ...m.adjustments, [key]: value } })));
}

export function resetAdjustments(id: string) {
  edit().apply((r) => mapMasks(r, id, (m) => ({ ...m, adjustments: defaultAdjustments() })), 'Reset mask adjustments');
}

export function updateComponent(maskId: string, compId: string, patch: Partial<MaskComponent>, live = false) {
  const fn = (r: Recipe) => mapMasks(r, maskId, (m) => ({ ...m, components: m.components.map((c) => (c.id === compId ? ({ ...c, ...patch } as MaskComponent) : c)) }));
  if (live) edit().update(fn); else edit().apply(fn);
}

export function updateParams<T extends MaskType>(maskId: string, compId: string, patch: Partial<MaskParams[T]>, live = true) {
  const fn = (r: Recipe) => mapMasks(r, maskId, (m) => ({
    ...m,
    components: m.components.map((c) => (c.id === compId ? ({ ...c, params: { ...c.params, ...patch } } as MaskComponent) : c)),
  }));
  if (live) edit().update(fn); else edit().apply(fn);
}

export const commitMasks = () => edit().commit();

export function deleteMask(id: string) {
  const ms = masksOf();
  const i = ms.findIndex((m) => m.id === id);
  edit().apply((r) => ({ ...r, masks: r.masks.filter((m) => m.id !== id) }));
  const next = masksOf()[Math.max(0, i - 1)];
  useUi.getState().set({ selectedMask: next?.id ?? null, selectedComp: next?.components[0]?.id ?? null });
}

export function duplicateMask(id: string) {
  const m = findMask(id);
  if (!m) return;
  if (masksOf().length >= MAX_MASKS || componentCount(masksOf()) + m.components.length > MAX_COMPONENTS) { alert('Mask limit reached'); return; }
  const copy: Mask = { ...structuredClone(m), id: maskUid(), name: `${m.name} copy`, components: m.components.map((c) => ({ ...structuredClone(c), id: maskUid() })) };
  edit().apply((r) => {
    const i = r.masks.findIndex((x) => x.id === id);
    const masks = [...r.masks];
    masks.splice(i + 1, 0, copy);
    return { ...r, masks };
  }, `Duplicate mask: ${m.name}`);
  useUi.getState().set({ selectedMask: copy.id, selectedComp: copy.components[0]?.id ?? null });
}

export function moveMask(id: string, dir: -1 | 1) {
  edit().apply((r) => {
    const i = r.masks.findIndex((m) => m.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= r.masks.length) return r;
    const masks = [...r.masks];
    [masks[i], masks[j]] = [masks[j], masks[i]];
    return { ...r, masks };
  }, 'Reorder masks');
}

export function deleteComponent(maskId: string, compId: string) {
  const m = findMask(maskId);
  if (!m) return;
  if (m.components.length <= 1) { deleteMask(maskId); return; }
  edit().apply((r) => mapMasks(r, maskId, (x) => ({ ...x, components: x.components.filter((c) => c.id !== compId) })));
  useUi.getState().set({ selectedComp: findMask(maskId)?.components[0]?.id ?? null });
}

export function setAllMasksVisible(on: boolean) {
  edit().apply((r) => ({ ...r, masks: r.masks.map((m) => ({ ...m, visible: on })) }), on ? 'Show all masks' : 'Hide all masks');
}

/**
 * Colour-range eyedropper: the colour of the image entering the mask stage at an output pixel,
 * in OKLab (what the shader compares against). Up to three samples per component.
 */
export function sampleColorRange(maskId: string, compId: string, x: number, y: number, replace = false) {
  const img = useImage.getState().image;
  const r = getRenderer();
  if (!img || !r) return;
  const rec = effectiveRecipe(edit().recipe, img.asShot);
  const LINEAR: OutputTarget = { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false };
  const v = r.readPixel(rec, x, y, LINEAR, 'look');
  if (!v) return;
  const [L, a, b] = workingToOklab([Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])]);
  const m = findMask(maskId);
  const c = m?.components.find((k) => k.id === compId);
  if (!c || c.type !== 'colorRange') return;
  const p = c.params as MaskParams['colorRange'];
  const samples = replace ? [{ L, a, b }] : [...p.samples, { L, a, b }].slice(-MAX_COLOR_SAMPLES);
  updateParams<'colorRange'>(maskId, compId, { samples }, false);
}

/** Lightness (0…100) of the image entering the mask stage at an output pixel. */
export function sampleLuminance(x: number, y: number): number | null {
  const img = useImage.getState().image;
  const r = getRenderer();
  if (!img || !r) return null;
  const v = r.readPixel(effectiveRecipe(edit().recipe, img.asShot), x, y, { mode: 'linear', space: 'rec2020', dither: false, clipOverlay: false }, 'look');
  if (!v) return null;
  return Math.round(workingToOklab([Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])])[0] * 100);
}

/** Append a brush stroke to a brush component (live while painting; commit on release). */
export function appendStroke(maskId: string, compId: string, stroke: MaskParams['brush']['strokes'][number], replaceLast: boolean) {
  edit().update((r) => mapMasks(r, maskId, (m) => ({
    ...m,
    components: m.components.map((c) => {
      if (c.id !== compId || c.type !== 'brush') return c;
      const strokes = (c.params as MaskParams['brush']).strokes;
      return { ...c, params: { strokes: replaceLast ? [...strokes.slice(0, -1), stroke] : [...strokes, stroke] } } as MaskComponent;
    }),
  })));
}

/** Recompute the AI bitmaps a recipe's masks need (after a reload, or if the cache was cleared). */
export function ensureAiForRecipe(r: Recipe) {
  const models = new Set<string>();
  for (const m of r.masks) for (const c of m.components) {
    const model = isAiType(c.type) ? aiModelFor(c) : null;
    if (model && !models.has(model)) { models.add(model); void ensureAiMask(model); }
  }
}

// ---------------------------------------------------------------------------
// Mask presets
// ---------------------------------------------------------------------------

export interface MaskPreset {
  id: string;
  name: string;
  masks: Array<{ name: string; components: Array<{ type: MaskType; op?: MaskOp; params?: Partial<MaskParams[MaskType]>; invert?: boolean }>; adjustments: Partial<MaskAdjustments> }>;
}

export const MASK_PRESETS: MaskPreset[] = [
  {
    id: 'brighten-face',
    name: 'Brighten face',
    masks: [{ name: 'Brighten face', components: [{ type: 'aiPerson', params: { part: 'faceSkin' } }], adjustments: { exposure: 0.35, shadows: 20, texture: -8 } }],
  },
  {
    id: 'darken-sky',
    name: 'Darken sky',
    masks: [{ name: 'Darken sky', components: [{ type: 'aiSky' }], adjustments: { exposure: -0.6, highlights: -30, saturation: 15, dehaze: 10 } }],
  },
  {
    id: 'enhance-eyes',
    name: 'Enhance eyes',
    masks: [{ name: 'Enhance eyes', components: [{ type: 'aiPerson', params: { part: 'eyes' } }], adjustments: { exposure: 0.3, clarity: 20, sharpness: 35, saturation: 10 } }],
  },
  {
    id: 'soften-skin',
    name: 'Soften skin',
    masks: [{
      name: 'Soften skin',
      components: [{ type: 'aiPerson', params: { part: 'faceSkin' } }, { type: 'aiPerson', op: 'add', params: { part: 'bodySkin' } }],
      adjustments: { texture: -45, clarity: -15, sharpness: -20 },
    }],
  },
  {
    id: 'warm-subject-cool-bg',
    name: 'Warm subject / cool background',
    masks: [
      { name: 'Warm subject', components: [{ type: 'aiSubject' }], adjustments: { temp: 18, saturation: 8 } },
      { name: 'Cool background', components: [{ type: 'aiBackground' }], adjustments: { temp: -15, exposure: -0.1 } },
    ],
  },
  {
    id: 'pop-subject',
    name: 'Pop subject',
    masks: [
      { name: 'Pop subject', components: [{ type: 'aiSubject' }], adjustments: { exposure: 0.2, clarity: 15, texture: 10, saturation: 12 } },
      { name: 'Subdue background', components: [{ type: 'aiBackground' }], adjustments: { exposure: -0.25, saturation: -10 } },
    ],
  },
];

export function applyMaskPreset(p: MaskPreset) {
  const masks: Mask[] = p.masks.map((d) =>
    newMask(d.name, d.components.map((c) => {
      const comp = prepareComponent(newComponent(c.type, c.op ?? 'add', c.params as Partial<MaskParams[typeof c.type]>));
      return { ...comp, invert: !!c.invert };
    }), d.adjustments));
  const cur = masksOf();
  if (cur.length + masks.length > MAX_MASKS || componentCount(cur) + masks.reduce((s, m) => s + m.components.length, 0) > MAX_COMPONENTS) {
    alert('Mask limit reached');
    return;
  }
  edit().apply((r) => ({ ...r, masks: [...r.masks, ...masks] }), `Mask preset: ${p.name}`);
  useUi.getState().set({ masksOpen: true, selectedMask: masks[0].id, selectedComp: masks[0].components[0].id });
}
