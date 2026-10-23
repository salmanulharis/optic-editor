/**
 * Local adjustments (recipe v4): masks, their components and their adjustment sets.
 *
 * Masks are stored resolution-independently, in the undistorted source frame U (see
 * geometry/transform.ts) normalised to 0…1 of its width and height, so they follow crop, straighten,
 * upright and transform automatically:
 *  - gradients as parameters (linear: start / end point; radial: centre, radii, angle, feather);
 *  - brush strokes as vector paths (x, y, pressure per point), radius as a fraction of the long edge;
 *  - colour / luminance ranges as targets in OKLab (evaluated per pixel, so they are exact at any
 *    resolution);
 *  - AI masks by model id; the low-resolution bitmap lives in the mask registry under `cacheKey`
 *    and is re-computed when missing.
 * Components combine left to right: add (union), subtract, intersect.
 */

export const MAX_MASKS = 16;
/** Total components over all masks (shader uniform budget). */
export const MAX_COMPONENTS = 32;
export const MAX_STROKES = 400;
export const MAX_STROKE_POINTS = 4000;
/** Brush components over all masks (3 per brush texture, 4 textures). */
export const MAX_BRUSH_COMPONENTS = 12;
export const MAX_COLOR_SAMPLES = 3;

export type MaskOp = 'add' | 'subtract' | 'intersect';
export const MASK_TYPES = ['linear', 'radial', 'brush', 'colorRange', 'lumRange', 'aiSubject', 'aiPerson', 'aiSky', 'aiBackground'] as const;
export type MaskType = (typeof MASK_TYPES)[number];
export const AI_TYPES: readonly MaskType[] = ['aiSubject', 'aiPerson', 'aiSky', 'aiBackground'];
export const isAiType = (t: MaskType) => AI_TYPES.includes(t);

export const PERSON_PARTS = ['all', 'faceSkin', 'bodySkin', 'hair', 'eyes', 'lips', 'clothes'] as const;
export type PersonPart = (typeof PERSON_PARTS)[number];

export interface BrushStroke {
  erase: boolean;
  /** Radius as a fraction of the long edge. */
  size: number;
  feather: number; // 0…100
  flow: number; // 0…100
  density: number; // 0…100
  /** Confine the stroke to areas similar to the colour under the brush. */
  autoMask: boolean;
  /** x, y (U-normalised), pressure (0…1) per point. */
  points: number[];
}

export interface OklabSample { L: number; a: number; b: number }

export interface MaskParams {
  /** Full effect on the start side, fading to none at the end point. */
  linear: { x1: number; y1: number; x2: number; y2: number };
  /** Centre and radii (fractions of width / height), rotation in degrees, feather 0…100. */
  radial: { cx: number; cy: number; rx: number; ry: number; angle: number; feather: number };
  brush: { strokes: BrushStroke[] };
  /** Up to 3 picked colours (OKLab of the image at the mask stage) and the tolerance 0…100. */
  colorRange: { samples: OklabSample[]; range: number };
  /** Perceptual lightness range 0…100 with soft edges (smoothness 0…100). */
  lumRange: { lo: number; hi: number; smoothness: number };
  aiSubject: Record<string, never>;
  aiPerson: { part: PersonPart };
  aiSky: Record<string, never>;
  aiBackground: Record<string, never>;
}

export interface MaskComponent<T extends MaskType = MaskType> {
  id: string;
  op: MaskOp;
  type: T;
  /** Invert this component before combining (radial: "outside"). */
  invert: boolean;
  params: MaskParams[T];
  /** AI components: registry key of the cached bitmap (photo key + model). */
  cacheKey?: string;
}

export interface MaskAdjustments {
  temp: number; // −100…+100
  tint: number;
  exposure: number; // EV −4…+4
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  hue: number; // −100…+100 (± 60°)
  saturation: number;
  tintColor: { hue: number; amount: number }; // hue 0…360, amount 0…100
  sharpness: number; // −100…+100
  noise: number; // 0…100
}

export interface Mask {
  id: string;
  name: string;
  visible: boolean;
  invert: boolean;
  /** Strength of the whole adjustment set, 0…200 %. */
  amount: number;
  components: MaskComponent[];
  adjustments: MaskAdjustments;
}

export const ADJUSTMENT_KEYS = [
  'temp', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'texture', 'clarity', 'dehaze', 'hue', 'saturation', 'sharpness', 'noise',
] as const;
export type ScalarAdjust = (typeof ADJUSTMENT_KEYS)[number];

export const ADJUST_RANGES: Record<ScalarAdjust, { min: number; max: number; step: number; label: string }> = {
  temp: { min: -100, max: 100, step: 1, label: 'Temp' },
  tint: { min: -100, max: 100, step: 1, label: 'Tint' },
  exposure: { min: -4, max: 4, step: 0.01, label: 'Exposure' },
  contrast: { min: -100, max: 100, step: 1, label: 'Contrast' },
  highlights: { min: -100, max: 100, step: 1, label: 'Highlights' },
  shadows: { min: -100, max: 100, step: 1, label: 'Shadows' },
  whites: { min: -100, max: 100, step: 1, label: 'Whites' },
  blacks: { min: -100, max: 100, step: 1, label: 'Blacks' },
  texture: { min: -100, max: 100, step: 1, label: 'Texture' },
  clarity: { min: -100, max: 100, step: 1, label: 'Clarity' },
  dehaze: { min: -100, max: 100, step: 1, label: 'Dehaze' },
  hue: { min: -100, max: 100, step: 1, label: 'Hue' },
  saturation: { min: -100, max: 100, step: 1, label: 'Saturation' },
  sharpness: { min: -100, max: 100, step: 1, label: 'Sharpness' },
  noise: { min: 0, max: 100, step: 1, label: 'Noise reduction' },
};

export function defaultAdjustments(): MaskAdjustments {
  return {
    temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, hue: 0, saturation: 0, tintColor: { hue: 30, amount: 0 }, sharpness: 0, noise: 0,
  };
}

export const maskUid = () => crypto.randomUUID().slice(0, 8);

export function defaultParams<T extends MaskType>(type: T): MaskParams[T] {
  const p: { [K in MaskType]: MaskParams[K] } = {
    linear: { x1: 0.5, y1: 0.15, x2: 0.5, y2: 0.55 },
    radial: { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0, feather: 50 },
    brush: { strokes: [] },
    colorRange: { samples: [], range: 40 },
    lumRange: { lo: 60, hi: 100, smoothness: 30 },
    aiSubject: {},
    aiPerson: { part: 'all' },
    aiSky: {},
    aiBackground: {},
  };
  return structuredClone(p[type]);
}

export function newComponent<T extends MaskType>(type: T, op: MaskOp = 'add', params?: Partial<MaskParams[T]>): MaskComponent<T> {
  return { id: maskUid(), op, type, invert: false, params: { ...defaultParams(type), ...(params ?? {}) } as MaskParams[T] };
}

export const TYPE_LABELS: Record<MaskType, string> = {
  linear: 'Linear gradient',
  radial: 'Radial gradient',
  brush: 'Brush',
  colorRange: 'Color range',
  lumRange: 'Luminance range',
  aiSubject: 'Subject',
  aiPerson: 'Person',
  aiSky: 'Sky',
  aiBackground: 'Background',
};

export const PART_LABELS: Record<PersonPart, string> = {
  all: 'Whole person',
  faceSkin: 'Face skin',
  bodySkin: 'Body skin',
  hair: 'Hair',
  eyes: 'Eyes',
  lips: 'Lips',
  clothes: 'Clothes',
};

export function newMask(name: string, components: MaskComponent[], adjustments: Partial<MaskAdjustments> = {}): Mask {
  return { id: maskUid(), name, visible: true, invert: false, amount: 100, components, adjustments: { ...defaultAdjustments(), ...adjustments } };
}

/** True when a mask changes nothing (no components or an identity adjustment set). */
export function maskIsIdentity(m: Mask): boolean {
  if (!m.visible || !m.components.length || m.amount === 0) return true;
  const a = m.adjustments;
  return ADJUSTMENT_KEYS.every((k) => a[k] === 0) && a.tintColor.amount === 0;
}

/** AI model behind a component type (the registry stores one bitmap per photo and model). */
export type AiModelId = 'subject' | 'sky' | 'person' | 'personParts';
export function aiModelFor(c: Pick<MaskComponent, 'type' | 'params'>): AiModelId | null {
  switch (c.type) {
    case 'aiSubject': case 'aiBackground': return 'subject';
    case 'aiSky': return 'sky';
    case 'aiPerson': {
      const part = (c.params as MaskParams['aiPerson']).part;
      return part === 'eyes' || part === 'lips' || part === 'clothes' ? 'personParts' : 'person';
    }
    default: return null;
  }
}

/**
 * Channel of a model's bitmap that holds a component's mask.
 *  subject: R = subject.  sky: R = sky.
 *  person: R = whole person, G = hair, B = face skin, A = body skin.
 *  personParts: R = clothes, G = eyes, B = lips.
 */
export function aiChannelFor(c: Pick<MaskComponent, 'type' | 'params'>): number {
  if (c.type !== 'aiPerson') return 0;
  const part = (c.params as MaskParams['aiPerson']).part;
  return ({ all: 0, hair: 1, faceSkin: 2, bodySkin: 3, clothes: 0, eyes: 1, lips: 2 } as Record<PersonPart, number>)[part];
}

export const aiCacheKey = (photoKey: string, model: AiModelId) => `${photoKey}|ai:${model}`;

// ---------------------------------------------------------------------------
// Parsing (tolerant, clamped), shared by recipes and mask presets
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, d: string, max = 64) => (typeof v === 'string' && v.length <= max ? v : d);

function parseParams(type: MaskType, v: unknown): MaskParams[MaskType] {
  const p = obj(v);
  const d = defaultParams(type) as unknown as Json;
  switch (type) {
    case 'linear':
      return { x1: num(p.x1, d.x1 as number, -2, 3), y1: num(p.y1, d.y1 as number, -2, 3), x2: num(p.x2, d.x2 as number, -2, 3), y2: num(p.y2, d.y2 as number, -2, 3) };
    case 'radial':
      return {
        cx: num(p.cx, 0.5, -2, 3), cy: num(p.cy, 0.5, -2, 3),
        rx: num(p.rx, 0.25, 0.001, 4), ry: num(p.ry, 0.25, 0.001, 4),
        angle: num(p.angle, 0, -180, 180), feather: num(p.feather, 50, 0, 100),
      };
    case 'brush': {
      const list = Array.isArray(p.strokes) ? p.strokes.slice(0, MAX_STROKES) : [];
      return {
        strokes: list.map((sv) => {
          const s = obj(sv);
          const pts = Array.isArray(s.points) ? s.points.slice(0, MAX_STROKE_POINTS * 3) : [];
          const clean: number[] = [];
          for (let i = 0; i + 2 < pts.length; i += 3) {
            clean.push(num(pts[i], 0, -2, 3), num(pts[i + 1], 0, -2, 3), num(pts[i + 2], 1, 0, 1));
          }
          return {
            erase: bool(s.erase, false),
            size: num(s.size, 0.03, 0.0005, 0.5),
            feather: num(s.feather, 50, 0, 100),
            flow: num(s.flow, 100, 1, 100),
            density: num(s.density, 100, 1, 100),
            autoMask: bool(s.autoMask, false),
            points: clean,
          };
        }),
      };
    }
    case 'colorRange': {
      const list = Array.isArray(p.samples) ? p.samples.slice(0, MAX_COLOR_SAMPLES) : [];
      return {
        samples: list.map((sv) => { const s = obj(sv); return { L: num(s.L, 0.5, 0, 1.5), a: num(s.a, 0, -0.5, 0.5), b: num(s.b, 0, -0.5, 0.5) }; }),
        range: num(p.range, 40, 0, 100),
      };
    }
    case 'lumRange': {
      const lo = num(p.lo, 60, 0, 100), hi = num(p.hi, 100, 0, 100);
      return { lo: Math.min(lo, hi), hi: Math.max(lo, hi), smoothness: num(p.smoothness, 30, 0, 100) };
    }
    case 'aiPerson':
      return { part: (PERSON_PARTS as readonly string[]).includes(p.part as string) ? (p.part as PersonPart) : 'all' };
    default:
      return {};
  }
}

export function parseAdjustments(v: unknown): MaskAdjustments {
  const a = obj(v);
  const out = defaultAdjustments();
  for (const k of ADJUSTMENT_KEYS) {
    const r = ADJUST_RANGES[k];
    out[k] = num(a[k], 0, r.min, r.max);
  }
  const t = obj(a.tintColor);
  out.tintColor = { hue: num(t.hue, 30, 0, 360), amount: num(t.amount, 0, 0, 100) };
  return out;
}

export function parseMasks(v: unknown): Mask[] {
  if (!Array.isArray(v)) return [];
  let budget = MAX_COMPONENTS;
  const out: Mask[] = [];
  for (const mv of v.slice(0, MAX_MASKS)) {
    const m = obj(mv);
    const comps: MaskComponent[] = [];
    for (const cv of Array.isArray(m.components) ? m.components : []) {
      if (budget <= 0) break;
      const c = obj(cv);
      const type = (MASK_TYPES as readonly string[]).includes(c.type as string) ? (c.type as MaskType) : null;
      if (!type) continue;
      const op: MaskOp = c.op === 'subtract' || c.op === 'intersect' ? c.op : 'add';
      const comp: MaskComponent = { id: str(c.id, maskUid(), 32), op, type, invert: bool(c.invert, false), params: parseParams(type, c.params) };
      if (typeof c.cacheKey === 'string' && c.cacheKey.length < 1024) comp.cacheKey = c.cacheKey;
      comps.push(comp);
      budget--;
    }
    out.push({
      id: str(m.id, maskUid(), 32),
      name: str(m.name, 'Mask', 80),
      visible: bool(m.visible, true),
      invert: bool(m.invert, false),
      amount: num(m.amount, 100, 0, 200),
      components: comps,
      adjustments: parseAdjustments(m.adjustments),
    });
  }
  return out;
}

/** Total component count (for the budget check when adding). */
export const componentCount = (masks: Mask[]) => masks.reduce((s, m) => s + m.components.length, 0);
