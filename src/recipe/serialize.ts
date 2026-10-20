/**
 * Recipe ↔ JSON. This is the on-disk format for edits and presets: tolerant on read (unknown
 * fields dropped, missing fields defaulted, values clamped), canonical on write.
 * Older versions are upgraded step by step through MIGRATIONS before parsing.
 */
import {
  HSL_BANDS,
  MAX_COLOR_POINTS,
  PRESET_GROUPS,
  RECIPE_VERSION,
  defaultRecipe,
  type AppliedPreset,
  type ColorPoint,
  type GrainType,
  type LutInputSpace,
  type UprightMode,
  type VignetteStyle,
  type Point,
  type PresetGroup,
  type Recipe,
  type Wheel,
} from './schema';

export function serializeRecipe(r: Recipe): string {
  return JSON.stringify(r);
}

type Json = Record<string, unknown>;

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

function points(v: unknown, d: Point[]): Point[] {
  if (!Array.isArray(v) || v.length < 2) return d;
  const pts = v
    .map((p) => obj(p))
    .map((p) => ({ x: num(p.x, 0, 0, 1), y: num(p.y, 0, 0, 1) }))
    .sort((a, b) => a.x - b.x);
  return pts.length >= 2 ? pts : d;
}

// ---------------------------------------------------------------------------
// Migrations: each takes the raw JSON of version N and returns raw JSON of version N+1.
// ---------------------------------------------------------------------------

/** v1 → v2: Phase 2 groups did not exist; they start at their (identity) defaults. */
function migrateV1toV2(src: Json): Json {
  const d = defaultRecipe();
  return {
    ...src,
    version: 2,
    look: d.look,
    treatment: d.treatment,
    bwMixer: d.bwMixer,
    pointColor: d.pointColor,
    colorGrading: d.colorGrading,
    calibration: d.calibration,
    lut: d.lut,
    appliedPreset: null,
  };
}

/**
 * v2 → v3: detail, effects, lens, geometry and crop did not exist. They start at the identity (no
 * sharpening, no lens corrections, full frame), so a migrated recipe renders exactly as before.
 * Only freshly opened RAW files get the raw-converter defaults (`defaultsForSource`).
 */
function migrateV2toV3(src: Json): Json {
  const d = defaultRecipe();
  return { ...src, version: 3, detail: d.detail, effects: d.effects, lens: d.lens, geometry: d.geometry, crop: d.crop };
}

const MIGRATIONS: Record<number, (j: Json) => Json> = { 1: migrateV1toV2, 2: migrateV2toV3 };

export function migrate(src: Json): Json {
  let v = num(src.version, 1);
  if (v > RECIPE_VERSION) throw new Error(`Recipe version ${v} is newer than this app supports`);
  let out = src;
  while (v < RECIPE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`No migration from recipe version ${v}`);
    out = step(out);
    v++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group parsers (also used for presets, which carry partial recipes)
// ---------------------------------------------------------------------------

const wheel = (v: unknown): Wheel => {
  const w = obj(v);
  return { hue: num(w.hue, 0, 0, 360), sat: num(w.sat, 0, 0, 100), lum: num(w.lum, 0, -100, 100) };
};

const primary = (v: unknown) => {
  const p = obj(v);
  return { hue: num(p.hue, 0, -100, 100), sat: num(p.sat, 0, -100, 100) };
};

function colorPoint(v: unknown): ColorPoint {
  const p = obj(v);
  const t = obj(p.target);
  return {
    target: { L: num(t.L, 0.5, 0, 2), C: num(t.C, 0.05, 0, 0.5), h: num(t.h, 0, 0, 360) },
    hue: num(p.hue, 0, -100, 100),
    sat: num(p.sat, 0, -100, 100),
    lum: num(p.lum, 0, -100, 100),
    hueRange: num(p.hueRange, 40, 0, 100),
    satRange: num(p.satRange, 50, 0, 100),
    lumRange: num(p.lumRange, 60, 0, 100),
    smoothness: num(p.smoothness, 50, 0, 100),
    uniformity: num(p.uniformity, 0, 0, 100),
  };
}

const LUT_SPACES: LutInputSpace[] = ['srgb', 'p3', 'linear', 'logc3', 'applelog'];
const GRAIN_TYPES: readonly GrainType[] = ['custom', 'fine', 'medium', 'coarse', '35mm', 'mediumFormat'];
const VIGNETTE_STYLES: readonly VignetteStyle[] = ['highlight', 'color', 'paint'];
const UPRIGHT_MODES: readonly UprightMode[] = ['off', 'auto', 'level', 'vertical', 'full', 'guided'];

const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

/** Parse every group present in `src` (a full or partial recipe JSON) onto `base`. */
export function parseGroups(src: Json, base: Recipe = defaultRecipe()): Recipe {
  const d = base;
  const r: Recipe = structuredClone(d);
  const has = (k: string) => src[k] !== undefined && src[k] !== null;

  if (has('whiteBalance')) {
    const wb = obj(src.whiteBalance);
    const est = obj(wb.castEstimate);
    const pair = (v: unknown): [number, number] =>
      Array.isArray(v) && v.length === 2 ? [num(v[0], 0), num(v[1], 0)] : [0, 0];
    r.whiteBalance = {
      enabled: bool(wb.enabled, true),
      mode: typeof wb.mode === 'string' ? (wb.mode as Recipe['whiteBalance']['mode']) : d.whiteBalance.mode,
      temperature: num(wb.temperature, d.whiteBalance.temperature),
      tint: num(wb.tint, d.whiteBalance.tint),
      castStrength: num(wb.castStrength, 0, 0, 100),
      castEstimate: wb.castEstimate
        ? { shadows: pair(est.shadows), midtones: pair(est.midtones), highlights: pair(est.highlights) }
        : null,
    };
  }
  if (has('light')) {
    const l = obj(src.light);
    const tri = (v: unknown) => (v === 'on' || v === 'off' || v === 'auto' ? v : 'auto');
    r.light = {
      enabled: bool(l.enabled, true),
      exposure: num(l.exposure, d.light.exposure, -5, 5),
      contrast: num(l.contrast, 0, -100, 100),
      highlights: num(l.highlights, 0, -100, 100),
      shadows: num(l.shadows, 0, -100, 100),
      whites: num(l.whites, 0, -100, 100),
      blacks: num(l.blacks, 0, -100, 100),
      deband: tri(l.deband ?? d.light.deband),
      deblock: bool(l.deblock, d.light.deblock),
    };
  }
  if (has('look')) {
    const k = obj(src.look);
    r.look = {
      enabled: bool(k.enabled, true),
      highlightRolloff: num(k.highlightRolloff, 0, 0, 100),
      shadowDensity: num(k.shadowDensity, 0, 0, 100),
      microContrast: num(k.microContrast, 0, 0, 100),
      colorDensity: num(k.colorDensity, 0, 0, 100),
      warmthBias: num(k.warmthBias, 0, -100, 100),
    };
  }
  if (has('hsl')) {
    const hsl = obj(src.hsl);
    const bands = obj(hsl.bands);
    r.hsl = {
      enabled: bool(hsl.enabled, true),
      bands: Object.fromEntries(
        HSL_BANDS.map((b) => {
          const v = obj(bands[b]);
          return [b, { hue: num(v.hue, 0, -100, 100), sat: num(v.sat, 0, -100, 100), lum: num(v.lum, 0, -100, 100) }];
        }),
      ) as Recipe['hsl']['bands'],
    };
  }
  if (has('curve')) {
    const c = obj(src.curve);
    const id = defaultRecipe().curve;
    r.curve = {
      enabled: bool(c.enabled, true),
      rgb: points(c.rgb, id.rgb),
      r: points(c.r, id.r),
      g: points(c.g, id.g),
      b: points(c.b, id.b),
    };
  }
  if (has('treatment')) r.treatment = src.treatment === 'monochrome' ? 'monochrome' : 'color';
  if (has('bwMixer')) {
    const m = obj(src.bwMixer);
    r.bwMixer = {
      enabled: bool(m.enabled, true),
      mix: num(m.mix, 100, 0, 100),
      ...(Object.fromEntries(HSL_BANDS.map((b) => [b, num(m[b], 0, -100, 100)])) as Record<(typeof HSL_BANDS)[number], number>),
    };
  }
  if (has('pointColor')) {
    const p = obj(src.pointColor);
    const list = Array.isArray(src.pointColor) ? src.pointColor : Array.isArray(p.points) ? p.points : [];
    r.pointColor = { enabled: bool(p.enabled, true), points: list.slice(0, MAX_COLOR_POINTS).map(colorPoint) };
  }
  if (has('colorGrading')) {
    const g = obj(src.colorGrading);
    r.colorGrading = {
      enabled: bool(g.enabled, true),
      shadows: wheel(g.shadows),
      midtones: wheel(g.midtones),
      highlights: wheel(g.highlights),
      global: wheel(g.global),
      blending: num(g.blending, 50, 0, 100),
      balance: num(g.balance, 0, -100, 100),
    };
  }
  if (has('calibration')) {
    const c = obj(src.calibration);
    const m = Array.isArray(c.matrix) && c.matrix.length === 9 && c.matrix.every((x) => typeof x === 'number' && Number.isFinite(x))
      ? (c.matrix as number[]).map((x) => Math.min(4, Math.max(-4, x)))
      : null;
    r.calibration = {
      enabled: bool(c.enabled, true),
      red: primary(c.red),
      green: primary(c.green),
      blue: primary(c.blue),
      shadowTint: num(c.shadowTint, 0, -100, 100),
      matrix: m,
    };
  }
  if (has('presence')) {
    const p = obj(src.presence);
    r.presence = {
      enabled: bool(p.enabled, true),
      vibrance: num(p.vibrance, 0, -100, 100),
      saturation: num(p.saturation, 0, -100, 100),
      protectSkin: bool(p.protectSkin, false),
    };
  }
  if (has('lut')) {
    const l = obj(src.lut);
    r.lut = {
      enabled: bool(l.enabled, true),
      id: typeof l.id === 'string' && l.id ? l.id : null,
      inputSpace: LUT_SPACES.includes(l.inputSpace as LutInputSpace) ? (l.inputSpace as LutInputSpace) : 'srgb',
      amount: num(l.amount, 100, 0, 200),
    };
  }
  if (has('detail')) {
    const dt = obj(src.detail);
    const s = obj(dt.sharpen), n = obj(dt.nr);
    const ds = d.detail.sharpen, dn = d.detail.nr;
    r.detail = {
      enabled: bool(dt.enabled, true),
      sharpen: {
        amount: num(s.amount, ds.amount, 0, 150),
        radius: num(s.radius, ds.radius, 0.5, 3),
        detail: num(s.detail, ds.detail, 0, 100),
        masking: num(s.masking, ds.masking, 0, 100),
      },
      nr: {
        lum: num(n.lum, dn.lum, 0, 100),
        lumDetail: num(n.lumDetail, dn.lumDetail, 0, 100),
        lumContrast: num(n.lumContrast, dn.lumContrast, 0, 100),
        color: num(n.color, dn.color, 0, 100),
        colorDetail: num(n.colorDetail, dn.colorDetail, 0, 100),
        colorSmooth: num(n.colorSmooth, dn.colorSmooth, 0, 100),
      },
    };
  }
  if (has('effects')) {
    const e = obj(src.effects);
    const de = defaultRecipe().effects;
    const g = obj(e.grain), h = obj(e.halation), b = obj(e.bloom), v = obj(e.vignette);
    r.effects = {
      enabled: bool(e.enabled, true),
      texture: num(e.texture, 0, -100, 100),
      clarity: num(e.clarity, 0, -100, 100),
      dehaze: num(e.dehaze, 0, -100, 100),
      grain: {
        amount: num(g.amount, de.grain.amount, 0, 100),
        size: num(g.size, de.grain.size, 0, 100),
        roughness: num(g.roughness, de.grain.roughness, 0, 100),
        color: num(g.color, de.grain.color, 0, 100),
        type: oneOf(g.type, GRAIN_TYPES, 'custom'),
      },
      halation: {
        amount: num(h.amount, de.halation.amount, 0, 100),
        threshold: num(h.threshold, de.halation.threshold, 0, 100),
        radius: num(h.radius, de.halation.radius, 0, 100),
        hue: num(h.hue, de.halation.hue, 0, 360),
      },
      bloom: {
        amount: num(b.amount, de.bloom.amount, 0, 100),
        threshold: num(b.threshold, de.bloom.threshold, 0, 100),
        radius: num(b.radius, de.bloom.radius, 0, 100),
        warmth: num(b.warmth, de.bloom.warmth, -100, 100),
      },
      vignette: {
        amount: num(v.amount, 0, -100, 100),
        midpoint: num(v.midpoint, de.vignette.midpoint, 0, 100),
        roundness: num(v.roundness, de.vignette.roundness, -100, 100),
        feather: num(v.feather, de.vignette.feather, 0, 100),
        highlights: num(v.highlights, de.vignette.highlights, 0, 100),
        style: oneOf(v.style, VIGNETTE_STYLES, 'highlight'),
      },
    };
  }
  if (has('lens')) {
    const l = obj(src.lens);
    const dl = defaultRecipe().lens;
    const vg = obj(l.vignetting), ca = obj(l.ca), df = obj(l.defringe);
    const range = (v: unknown, dv: [number, number]): [number, number] => {
      if (!Array.isArray(v) || v.length !== 2) return [...dv];
      const a = num(v[0], dv[0], 0, 100), b = num(v[1], dv[1], 0, 100);
      return a <= b ? [a, b] : [b, a];
    };
    r.lens = {
      enabled: bool(l.enabled, true),
      auto: bool(l.auto, d.lens.auto),
      distortion: num(l.distortion, 0, -100, 100),
      vignetting: { amount: num(vg.amount, 0, -100, 100), midpoint: num(vg.midpoint, dl.vignetting.midpoint, 0, 100) },
      ca: { auto: bool(ca.auto, false), redCyan: num(ca.redCyan, 0, -100, 100), blueYellow: num(ca.blueYellow, 0, -100, 100) },
      defringe: {
        purpleAmount: num(df.purpleAmount, 0, 0, 100),
        purpleHue: range(df.purpleHue, dl.defringe.purpleHue),
        greenAmount: num(df.greenAmount, 0, 0, 100),
        greenHue: range(df.greenHue, dl.defringe.greenHue),
      },
    };
  }
  if (has('geometry')) {
    const g = obj(src.geometry);
    const guides = Array.isArray(g.guides)
      ? g.guides.slice(0, 4).map((v) => {
          const l = obj(v);
          return { x1: num(l.x1, 0, -1, 2), y1: num(l.y1, 0, -1, 2), x2: num(l.x2, 1, -1, 2), y2: num(l.y2, 1, -1, 2) };
        })
      : [];
    r.geometry = {
      enabled: bool(g.enabled, true),
      upright: oneOf(g.upright, UPRIGHT_MODES, 'off'),
      guides,
      vertical: num(g.vertical, 0, -100, 100),
      horizontal: num(g.horizontal, 0, -100, 100),
      rotate: num(g.rotate, 0, -45, 45),
      aspect: num(g.aspect, 0, -100, 100),
      scale: num(g.scale, 100, 50, 150),
      offsetX: num(g.offsetX, 0, -100, 100),
      offsetY: num(g.offsetY, 0, -100, 100),
      constrainCrop: bool(g.constrainCrop, false),
    };
  }
  if (has('crop')) {
    const c = obj(src.crop);
    const x = num(c.x, 0, -1, 1), y = num(c.y, 0, -1, 1);
    const rot = num(c.rotate90, 0, 0, 3);
    r.crop = {
      x,
      y,
      w: num(c.w, 1, 0.005, 3),
      h: num(c.h, 1, 0.005, 3),
      angle: num(c.angle, 0, -45, 45),
      aspect: typeof c.aspect === 'string' && c.aspect.length < 32 ? c.aspect : 'original',
      flipH: bool(c.flipH, false),
      flipV: bool(c.flipV, false),
      rotate90: (Math.round(rot) & 3) as 0 | 1 | 2 | 3,
    };
  }
  if (has('output')) r.output = { colorSpace: obj(src.output).colorSpace === 'srgb' ? 'srgb' : 'display-p3' };
  if (has('appliedPreset')) {
    const a = obj(src.appliedPreset);
    const groups = Array.isArray(a.groups) ? (a.groups.filter((g) => PRESET_GROUPS.includes(g as PresetGroup)) as PresetGroup[]) : [];
    r.appliedPreset = typeof a.id === 'string'
      ? ({
          id: a.id,
          name: typeof a.name === 'string' ? a.name : a.id,
          amount: num(a.amount, 100, 0, 200),
          groups,
          base: obj(a.base) as Partial<Recipe>,
          target: obj(a.target) as Partial<Recipe>,
        } satisfies AppliedPreset)
      : null;
  }
  return r;
}

/** Parse and migrate a full recipe from JSON (string or object). */
export function deserializeRecipe(json: string | unknown): Recipe {
  const src = migrate(obj(typeof json === 'string' ? JSON.parse(json) : json));
  return parseGroups(src, defaultRecipe());
}
