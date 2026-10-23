/**
 * The edit recipe: a complete, versioned, serialisable description of an edit.
 * The renderer is a pure function render(image, recipe); the UI only ever edits this object.
 * Presets (Phase 2) and history (Phase 3) are built on top of it.
 *
 * v2 (Phase 2) adds: calibration, point colour, colour grading, treatment + B&W mixer, 3D LUT,
 * the look layer and the applied-preset record.
 * v3 (Phase 3) adds: detail (sharpening, noise reduction), effects (texture, clarity, dehaze, grain,
 * halation, bloom, vignette), lens corrections, geometry and crop. Older recipes are migrated in
 * serialize.ts; every v3 addition defaults to the identity, so a migrated recipe renders unchanged.
 * v4 (Phase 4) adds local adjustments: `masks` (see masks.ts), empty by default. Photo metadata
 * (rating, flag, colour label, keywords) is stored with the photo in the catalog, not here.
 */
import type { Mask } from './masks';

export const RECIPE_VERSION = 4;

export type Point = { x: number; y: number };

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslBand = (typeof HSL_BANDS)[number];
export type HslAdjust = { hue: number; sat: number; lum: number };

export type WbPresetName = 'daylight' | 'cloudy' | 'shade' | 'tungsten' | 'fluorescent' | 'flash';
export type WbMode = 'asShot' | 'auto' | 'custom' | WbPresetName;

export type Toggle3 = 'auto' | 'on' | 'off';

/** Lab offsets (a, b) estimated per tonal zone by the colour-cast tool. */
export type CastEstimate = { shadows: [number, number]; midtones: [number, number]; highlights: [number, number] };

/** Hue −100…+100 and saturation −100…+100 of one calibration primary. */
export type PrimaryAdjust = { hue: number; sat: number };

/** Colour-grading wheel: hue 0…360°, saturation 0…100, luminance −100…+100. */
export type Wheel = { hue: number; sat: number; lum: number };

/** One point-colour sample: target colour in OKLCH (h in degrees) and its adjustments. */
export interface ColorPoint {
  target: { L: number; C: number; h: number };
  hue: number; // −100…+100
  sat: number; // −100…+100
  lum: number; // −100…+100
  hueRange: number; // 0…100
  satRange: number; // 0…100
  lumRange: number; // 0…100
  smoothness: number; // 0…100
  /** Pull hues inside the range toward the target hue (skin uniformity), 0…100. */
  uniformity: number;
}

export type LutInputSpace = 'srgb' | 'p3' | 'linear' | 'logc3' | 'applelog';

export type GrainType = 'custom' | 'fine' | 'medium' | 'coarse' | '35mm' | 'mediumFormat';
export type VignetteStyle = 'highlight' | 'color' | 'paint';
export type UprightMode = 'off' | 'auto' | 'level' | 'vertical' | 'full' | 'guided';
/** A guided-upright line in undistorted source coordinates, normalised to 0…1 of width / height. */
export type GuideLine = { x1: number; y1: number; x2: number; y2: number };

/** The recipe groups a preset can include (and copy/paste can transfer). */
export const PRESET_GROUPS = [
  'whiteBalance',
  'exposure',
  'light',
  'look',
  'curve',
  'hsl',
  'bw',
  'pointColor',
  'colorGrading',
  'calibration',
  'presence',
  'lut',
  'clarity',
  'grain',
  'glow',
  'vignette',
  'sharpening',
  'noiseReduction',
  'lens',
  'geometry',
  'crop',
  'masks',
] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

export const GROUP_LABELS: Record<PresetGroup, string> = {
  whiteBalance: 'White balance',
  exposure: 'Exposure',
  light: 'Light (contrast, highlights, shadows, whites, blacks)',
  look: 'Look',
  curve: 'Tone curve',
  hsl: 'Color mixer (HSL)',
  bw: 'Treatment & B&W mix',
  pointColor: 'Point color',
  colorGrading: 'Color grading',
  calibration: 'Calibration',
  presence: 'Vibrance & saturation',
  lut: 'LUT',
  clarity: 'Texture, clarity & dehaze',
  grain: 'Grain',
  glow: 'Halation & bloom',
  vignette: 'Vignette',
  sharpening: 'Sharpening',
  noiseReduction: 'Noise reduction',
  lens: 'Lens corrections',
  geometry: 'Geometry (upright, transform)',
  crop: 'Crop & straighten',
  masks: 'Masks (local adjustments)',
};

/** Photo-specific groups: never part of a new preset or a paste unless explicitly ticked. */
export const PHOTO_SPECIFIC_GROUPS: readonly PresetGroup[] = ['whiteBalance', 'exposure', 'noiseReduction', 'lens', 'geometry', 'crop', 'masks'];

/**
 * Record of the applied preset. `base` holds the user's values for the preset's groups before it
 * was applied and `target` the preset's (non-RAW-scaled) values, so the amount slider can
 * re-interpolate without the preset file and "Remove preset" can restore the base exactly.
 */
export interface AppliedPreset {
  id: string;
  name: string;
  amount: number; // 0…200 (%)
  groups: PresetGroup[];
  base: Partial<Recipe>;
  target: Partial<Recipe>;
}

export interface Recipe {
  version: typeof RECIPE_VERSION;
  whiteBalance: {
    enabled: boolean;
    mode: WbMode;
    /**
     * RAW: Kelvin (2000…50000) and DNG tint (−150…+150).
     * Non-RAW: relative values (−100…+100), applied as a chromatic adaptation.
     */
    temperature: number;
    tint: number;
    /** Remove colour cast: strength 0…100 plus the zone estimates it neutralises. */
    castStrength: number;
    castEstimate: CastEstimate | null;
  };
  light: {
    enabled: boolean;
    exposure: number; // EV, −5…+5
    contrast: number; // −100…+100
    highlights: number;
    shadows: number;
    whites: number;
    blacks: number;
    /** Edge-aware debanding before tone/colour work. 'auto' = on for ≤ 8-bit sources. */
    deband: Toggle3;
    /** Mild deblocking for heavily compressed JPEGs. */
    deblock: boolean;
  };
  look: {
    enabled: boolean;
    highlightRolloff: number; // 0…100
    shadowDensity: number; // 0…100
    microContrast: number; // 0…100
    colorDensity: number; // 0…100
    warmthBias: number; // −100…+100
  };
  hsl: { enabled: boolean; bands: Record<HslBand, HslAdjust> };
  curve: { enabled: boolean; rgb: Point[]; r: Point[]; g: Point[]; b: Point[] };
  treatment: 'color' | 'monochrome';
  bwMixer: { enabled: boolean; mix: number } & Record<HslBand, number>;
  pointColor: { enabled: boolean; points: ColorPoint[] };
  colorGrading: {
    enabled: boolean;
    shadows: Wheel;
    midtones: Wheel;
    highlights: Wheel;
    global: Wheel;
    blending: number; // 0…100
    balance: number; // −100…+100
  };
  calibration: {
    enabled: boolean;
    red: PrimaryAdjust;
    green: PrimaryAdjust;
    blue: PrimaryAdjust;
    shadowTint: number; // −100 (green) … +100 (magenta)
    /** Optional white-preserving 3×3 colour matrix (row-major, rows sum to 1). */
    matrix: number[] | null;
  };
  presence: { enabled: boolean; vibrance: number; saturation: number; protectSkin: boolean };
  lut: { enabled: boolean; id: string | null; inputSpace: LutInputSpace; amount: number /* 0…200 */ };
  detail: {
    enabled: boolean;
    /** Amount 0…150, radius 0.5…3 px at a 24 MP reference, detail 0…100, masking 0…100. */
    sharpen: { amount: number; radius: number; detail: number; masking: number };
    /** All 0…100. */
    nr: { lum: number; lumDetail: number; lumContrast: number; color: number; colorDetail: number; colorSmooth: number };
  };
  effects: {
    enabled: boolean;
    texture: number; // −100…+100
    clarity: number; // −100…+100
    dehaze: number; // −100…+100
    grain: { amount: number; size: number; roughness: number; color: number; type: GrainType }; // 0…100
    /** Amount / threshold / radius 0…100; hue in degrees (0 = red, 30 = orange). */
    halation: { amount: number; threshold: number; radius: number; hue: number };
    /** Amount / threshold / radius 0…100; warmth −100…+100. */
    bloom: { amount: number; threshold: number; radius: number; warmth: number };
    /** Amount and roundness −100…+100, the rest 0…100. Relative to the cropped frame. */
    vignette: { amount: number; midpoint: number; roundness: number; feather: number; highlights: number; style: VignetteStyle };
  };
  lens: {
    enabled: boolean;
    /** Apply the file's own corrections (DNG opcodes) or a matching lensfun profile. */
    auto: boolean;
    distortion: number; // −100…+100 (+ corrects barrel)
    vignetting: { amount: number; midpoint: number }; // −100…+100, 0…100
    ca: { auto: boolean; redCyan: number; blueYellow: number }; // −100…+100
    /** Fringe amounts 0…100; hue ranges on a 0…100 scale (as in Lightroom). */
    defringe: { purpleAmount: number; purpleHue: [number, number]; greenAmount: number; greenHue: [number, number] };
  };
  geometry: {
    enabled: boolean;
    upright: UprightMode;
    guides: GuideLine[];
    vertical: number; // −100…+100
    horizontal: number; // −100…+100
    rotate: number; // −45…+45 degrees
    aspect: number; // −100…+100
    scale: number; // 50…150 %
    offsetX: number; // −100…+100
    offsetY: number; // −100…+100
    constrainCrop: boolean;
  };
  /**
   * Crop rectangle normalised to the transformed, straightened frame (see geometry/transform.ts),
   * straighten angle (degrees, + = clockwise), aspect label and orientation changes.
   */
  crop: { x: number; y: number; w: number; h: number; angle: number; aspect: string; flipH: boolean; flipV: boolean; rotate90: 0 | 1 | 2 | 3 };
  output: { colorSpace: 'srgb' | 'display-p3' };
  appliedPreset: AppliedPreset | null;
  /** Local adjustments, applied in order at stage 78. */
  masks: Mask[];
}

export type SectionKey =
  | 'whiteBalance' | 'light' | 'look' | 'hsl' | 'curve' | 'bwMixer' | 'pointColor'
  | 'colorGrading' | 'calibration' | 'presence' | 'lut' | 'detail' | 'effects' | 'lens' | 'geometry';

export const IDENTITY_CURVE: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
export const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const wheel = (): Wheel => ({ hue: 0, sat: 0, lum: 0 });

export function defaultRecipe(): Recipe {
  const bands = {} as Record<HslBand, HslAdjust>;
  for (const b of HSL_BANDS) bands[b] = { hue: 0, sat: 0, lum: 0 };
  return {
    version: RECIPE_VERSION,
    whiteBalance: { enabled: true, mode: 'asShot', temperature: 0, tint: 0, castStrength: 0, castEstimate: null },
    light: { enabled: true, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, deband: 'auto', deblock: false },
    look: { enabled: true, highlightRolloff: 0, shadowDensity: 0, microContrast: 0, colorDensity: 0, warmthBias: 0 },
    hsl: { enabled: true, bands },
    curve: { enabled: true, rgb: [...IDENTITY_CURVE], r: [...IDENTITY_CURVE], g: [...IDENTITY_CURVE], b: [...IDENTITY_CURVE] },
    treatment: 'color',
    bwMixer: { enabled: true, mix: 100, red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, magenta: 0 },
    pointColor: { enabled: true, points: [] },
    colorGrading: { enabled: true, shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 },
    calibration: { enabled: true, red: { hue: 0, sat: 0 }, green: { hue: 0, sat: 0 }, blue: { hue: 0, sat: 0 }, shadowTint: 0, matrix: null },
    presence: { enabled: true, vibrance: 0, saturation: 0, protectSkin: false },
    lut: { enabled: true, id: null, inputSpace: 'srgb', amount: 100 },
    detail: {
      enabled: true,
      sharpen: { amount: 0, radius: 1, detail: 25, masking: 0 },
      nr: { lum: 0, lumDetail: 50, lumContrast: 0, color: 0, colorDetail: 50, colorSmooth: 50 },
    },
    effects: {
      enabled: true,
      texture: 0,
      clarity: 0,
      dehaze: 0,
      grain: { amount: 0, size: 25, roughness: 50, color: 0, type: 'custom' },
      halation: { amount: 0, threshold: 75, radius: 30, hue: 15 },
      bloom: { amount: 0, threshold: 70, radius: 40, warmth: 0 },
      vignette: { amount: 0, midpoint: 50, roundness: 0, feather: 50, highlights: 0, style: 'highlight' },
    },
    lens: {
      enabled: true,
      auto: false,
      distortion: 0,
      vignetting: { amount: 0, midpoint: 50 },
      ca: { auto: false, redCyan: 0, blueYellow: 0 },
      defringe: { purpleAmount: 0, purpleHue: [30, 70], greenAmount: 0, greenHue: [40, 60] },
    },
    geometry: {
      enabled: true, upright: 'off', guides: [],
      vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0, constrainCrop: false,
    },
    crop: { ...IDENTITY_CROP },
    output: { colorSpace: 'display-p3' },
    appliedPreset: null,
    masks: [],
  };
}

export const IDENTITY_CROP: Recipe['crop'] = { x: 0, y: 0, w: 1, h: 1, angle: 0, aspect: 'original', flipH: false, flipV: false, rotate90: 0 };

/**
 * Starting values for a newly opened photo. RAW files get gentle capture sharpening, colour noise
 * reduction and the file's own lens corrections (like a raw converter's defaults); JPEG/HEIC/PNG
 * were sharpened and corrected in camera, so they start at the identity.
 */
export function defaultsForSource(isRaw: boolean): Recipe {
  const r = defaultRecipe();
  if (isRaw) {
    r.detail.sharpen = { amount: 30, radius: 1, detail: 25, masking: 0 };
    r.detail.nr.color = 25;
    r.lens.auto = true;
  }
  return r;
}

export function isIdentityCurve(pts: Point[]): boolean {
  return pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1;
}

/**
 * The recipe the renderer actually sees: sections whose eye toggle is off are replaced by their
 * defaults (WB falls back to As Shot), so stages never need to know about the toggles.
 */
export function effectiveRecipe(r: Recipe, asShot: { temperature: number; tint: number }): Recipe {
  const d = defaultRecipe();
  const mono = r.treatment === 'monochrome' && r.bwMixer.enabled;
  return {
    ...r,
    whiteBalance: r.whiteBalance.enabled
      ? r.whiteBalance
      : { ...d.whiteBalance, temperature: asShot.temperature, tint: asShot.tint },
    light: r.light.enabled ? r.light : { ...d.light, deband: r.light.deband, deblock: r.light.deblock },
    look: r.look.enabled ? r.look : d.look,
    hsl: r.hsl.enabled ? r.hsl : d.hsl,
    curve: r.curve.enabled ? r.curve : d.curve,
    treatment: mono ? 'monochrome' : 'color',
    pointColor: r.pointColor.enabled ? r.pointColor : d.pointColor,
    colorGrading: r.colorGrading.enabled ? r.colorGrading : d.colorGrading,
    calibration: r.calibration.enabled ? r.calibration : d.calibration,
    presence: r.presence.enabled ? r.presence : d.presence,
    lut: r.lut.enabled ? r.lut : d.lut,
    detail: r.detail.enabled ? r.detail : d.detail,
    effects: r.effects.enabled ? r.effects : d.effects,
    lens: r.lens.enabled ? r.lens : d.lens,
    geometry: r.geometry.enabled ? r.geometry : d.geometry,
  };
}

/**
 * Read / write a preset group of a recipe. Groups map onto recipe fields; `exposure` and `light`
 * split the Light section so presets never move exposure unless they explicitly include it.
 */
export function getGroup(r: Recipe, g: PresetGroup): Partial<Recipe> {
  switch (g) {
    case 'exposure': return { light: { ...r.light, exposure: r.light.exposure } } as Partial<Recipe>;
    case 'light': return { light: r.light };
    case 'bw': return { treatment: r.treatment, bwMixer: r.bwMixer };
    case 'clarity': case 'grain': case 'glow': case 'vignette': return { effects: r.effects };
    case 'sharpening': case 'noiseReduction': return { detail: r.detail };
    default: return { [g]: r[g] } as Partial<Recipe>;
  }
}

/** The fields of the shared `effects` section each group owns. */
const EFFECT_FIELDS = {
  clarity: ['texture', 'clarity', 'dehaze'],
  grain: ['grain'],
  glow: ['halation', 'bloom'],
  vignette: ['vignette'],
} as const;

export function setGroup(r: Recipe, g: PresetGroup, src: Partial<Recipe>): Recipe {
  switch (g) {
    case 'exposure':
      return src.light ? { ...r, light: { ...r.light, exposure: src.light.exposure } } : r;
    case 'light': {
      if (!src.light) return r;
      const { exposure: _e, deband: _d, deblock: _k, ...rest } = src.light;
      return { ...r, light: { ...r.light, ...rest } };
    }
    case 'bw':
      return {
        ...r,
        treatment: src.treatment ?? r.treatment,
        bwMixer: src.bwMixer ? { ...r.bwMixer, ...src.bwMixer } : r.bwMixer,
      };
    case 'clarity': case 'grain': case 'glow': case 'vignette': {
      if (!src.effects) return r;
      const e = { ...r.effects } as Record<string, unknown>;
      for (const f of EFFECT_FIELDS[g]) e[f] = structuredClone((src.effects as Record<string, unknown>)[f]);
      return { ...r, effects: e as Recipe['effects'] };
    }
    case 'sharpening':
      return src.detail ? { ...r, detail: { ...r.detail, sharpen: { ...src.detail.sharpen } } } : r;
    case 'noiseReduction':
      return src.detail ? { ...r, detail: { ...r.detail, nr: { ...src.detail.nr } } } : r;
    default: {
      const v = src[g];
      return v === undefined ? r : ({ ...r, [g]: structuredClone(v) } as Recipe);
    }
  }
}

/** Value ranges for numeric fields, used by sliders and validation. */
export const RANGES = {
  exposure: { min: -5, max: 5, step: 0.01 },
  tone: { min: -100, max: 100, step: 1 },
  temperatureRaw: { min: 2000, max: 50000, step: 50 },
  tintRaw: { min: -150, max: 150, step: 1 },
  relative: { min: -100, max: 100, step: 1 },
  hue: { min: -100, max: 100, step: 1 },
  strength: { min: 0, max: 100, step: 1 },
} as const;

export const MAX_COLOR_POINTS = 8;
