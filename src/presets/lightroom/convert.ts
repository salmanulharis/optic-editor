/**
 * Lightroom / Camera Raw develop settings (the `crs:` fields of an XMP or .lrtemplate) → an Optic
 * partial recipe in the preset JSON shape (docs/PRESETS.md), plus what could not be converted.
 *
 * The result is approximate by nature: Optic's tone, curve and grading models are its own, so
 * sliders map onto the closest Optic control on the same scale (most Lightroom ranges and defaults
 * match Optic's exactly). Everything is validated and clamped again by `parseGroups` when the
 * preset is applied, so this module only has to produce well-typed numbers.
 *
 * `kind` decides which groups are taken:
 *  - 'preset': a Lightroom preset lists only the settings it owns, so every group with a field
 *    present is included (as Lightroom would apply it);
 *  - 'snapshot': a photo's full settings (sidecar XMP, DNG "preset"). Groups still at their
 *    neutral values are dropped, and photo-specific groups (white balance, exposure, noise
 *    reduction, lens, geometry) are skipped, as Optic's own copy / paste does by default.
 */
import { toXYZ_D65, WORKING_TO_XYZ, inv, mul, mulVec } from '../../color/matrices';
import { workingToOklab } from '../../color/oklab';
import { srgbToLinear } from '../../color/transfer';
import { WB_PRESETS, relativeToTempTint, tempTintToRelative } from '../../color/whiteBalance';
import { monotoneCubic } from '../../recipe/curve';
import {
  HSL_BANDS,
  PHOTO_SPECIFIC_GROUPS,
  defaultRecipe,
  isIdentityCurve,
  setGroup,
  type Point,
  type PresetGroup,
} from '../../recipe/schema';
import { parseGroups } from '../../recipe/serialize';
import { STRUCT, type CrsMap } from './xmp';

export type SourceKind = 'preset' | 'snapshot';

/** Reasons a part of a Lightroom preset was not converted (translated by the UI). */
export type NotConvertedCode =
  | 'profile'
  | 'masks'
  | 'retouch'
  | 'crop'
  | 'pointColor'
  | 'hdr'
  | 'lensBlur'
  | 'autoWb'
  | 'autoTone'
  | 'legacyTone'
  | 'guidedUpright'
  | 'photoSpecific';

export interface NotConverted {
  code: NotConvertedCode;
  /** Optional detail: a profile name, a count, a list of groups. */
  detail?: string;
}

export interface Conversion {
  includes: PresetGroup[];
  settings: Record<string, unknown>;
  nonRaw?: Record<string, unknown>;
  notConverted: NotConverted[];
  /** Made with Lightroom 3 or older (process version 2010 or earlier). */
  legacyProcess: boolean;
}

type J = Record<string, unknown>;

/** Lightroom's band names, in Optic's HSL_BANDS order. */
const LR_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

/** crs:PerspectiveUpright values (as documented by ExifTool). */
const UPRIGHT = ['off', 'auto', 'full', 'level', 'vertical'] as const;
const UPRIGHT_GUIDED = 5;

const VIGNETTE_STYLE: Record<number, string> = { 1: 'highlight', 2: 'color', 3: 'paint' };

/** Lightroom defringe amounts run 0…20; Optic's run 0…100. */
const DEFRINGE_SCALE = 5;

/** Profiles that are Lightroom's neutral defaults (not worth reporting as "not converted"). */
const DEFAULT_PROFILES = new Set(['Adobe Color', 'Adobe Standard', 'Adobe Default', 'Embedded', 'Camera Standard']);

const round = (v: number, digits = 2) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export function convertCrs(crs: CrsMap, kind: SourceKind): Conversion {
  const str = (k: string): string | undefined => {
    const v = crs.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = str(k);
    if (v === undefined || v === '' || v === STRUCT) return undefined;
    const n = Number(v.trim().replace(/^\+/, ''));
    return Number.isFinite(n) ? n : undefined;
  };
  const bool = (k: string): boolean | undefined => {
    const v = str(k)?.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return undefined;
  };
  const list = (k: string): string[] | undefined => {
    const v = crs.get(k);
    return Array.isArray(v) ? v : undefined;
  };
  const has = (k: string) => crs.has(k);
  const any = (...keys: string[]) => keys.some((k) => num(k) !== undefined);

  const settings: J = {};
  const nonRaw: J = {};
  const groups = new Set<PresetGroup>();
  const notConverted: NotConverted[] = [];
  const skip = (code: NotConvertedCode, detail?: string) => {
    if (!notConverted.some((n) => n.code === code)) notConverted.push(detail ? { code, detail } : { code });
  };

  const pv = Number(str('ProcessVersion'));
  const legacyProcess = (Number.isFinite(pv) && pv > 0 && pv < 6.7) || (has('Exposure') && !has('Exposure2012'));

  // --- Light -------------------------------------------------------------------------------
  const light: J = {};
  const exposure = num('Exposure2012') ?? (legacyProcess ? num('Exposure') : undefined);
  if (exposure !== undefined) {
    light.exposure = round(exposure, 2);
    groups.add('exposure');
  }
  if (any('Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012')) {
    light.contrast = num('Contrast2012') ?? 0;
    light.highlights = num('Highlights2012') ?? 0;
    light.shadows = num('Shadows2012') ?? 0;
    light.whites = num('Whites2012') ?? 0;
    light.blacks = num('Blacks2012') ?? 0;
    groups.add('light');
  }
  if (Object.keys(light).length) settings.light = light;
  if (legacyProcess) {
    const legacyDefaults: Record<string, number> = { Brightness: 50, Contrast: 25, FillLight: 0, HighlightRecovery: 0, Shadows: 5 };
    if (Object.entries(legacyDefaults).some(([k, d]) => num(k) !== undefined && num(k) !== d)) skip('legacyTone');
  }
  if (bool('AutoTone') || bool('AutoExposure')) skip('autoTone');

  // --- White balance -------------------------------------------------------------------------
  const wbName = str('WhiteBalance');
  const kelvin = num('Temperature'), tint = num('Tint');
  const incT = num('IncrementalTemperature'), incTint = num('IncrementalTint');
  const preset = wbName ? WB_PRESETS[wbName.toLowerCase()] : undefined;
  if (wbName === 'Auto') skip('autoWb');
  else if (wbName === 'As Shot') {
    // "As Shot" restores the camera's white balance, which is what every photo starts with.
  } else if (preset) {
    settings.whiteBalance = { mode: wbName!.toLowerCase(), temperature: preset.temperature, tint: preset.tint };
    const rel = tempTintToRelative(preset.temperature, preset.tint);
    nonRaw.whiteBalance = { mode: 'custom', temperature: round(rel.temperature, 1), tint: round(rel.tint, 1) };
    groups.add('whiteBalance');
  } else if (kelvin !== undefined) {
    const t = tint ?? 0;
    settings.whiteBalance = { mode: 'custom', temperature: Math.round(kelvin), tint: round(t, 1) };
    const rel = tempTintToRelative(kelvin, t);
    nonRaw.whiteBalance = { mode: 'custom', temperature: round(rel.temperature, 1), tint: round(rel.tint, 1) };
    groups.add('whiteBalance');
  } else if (incT !== undefined || incTint !== undefined) {
    const abs = relativeToTempTint(incT ?? 0, incTint ?? 0);
    settings.whiteBalance = { mode: 'custom', temperature: Math.round(abs.temperature), tint: round(abs.tint, 1) };
    nonRaw.whiteBalance = { mode: 'custom', temperature: incT ?? 0, tint: incTint ?? 0 };
    groups.add('whiteBalance');
  }

  // --- Tone curve ------------------------------------------------------------------------------
  const pointCurve = (k: string) => parseCurve(list(k));
  const master = pointCurve('ToneCurvePV2012') ?? (legacyProcess ? pointCurve('ToneCurve') : null);
  const parametric = parametricPoints({
    shadows: num('ParametricShadows') ?? 0,
    darks: num('ParametricDarks') ?? 0,
    lights: num('ParametricLights') ?? 0,
    highlights: num('ParametricHighlights') ?? 0,
    s1: num('ParametricShadowSplit') ?? 25,
    s2: num('ParametricMidtoneSplit') ?? 50,
    s3: num('ParametricHighlightSplit') ?? 75,
  });
  const curveKeys = ['ToneCurvePV2012', 'ToneCurvePV2012Red', 'ToneCurvePV2012Green', 'ToneCurvePV2012Blue', 'ParametricShadows', 'ParametricDarks', 'ParametricLights', 'ParametricHighlights'];
  if (curveKeys.some(has) || (legacyProcess && has('ToneCurve'))) {
    const curve = {
      rgb: composeCurves(parametric, master),
      r: pointCurve('ToneCurvePV2012Red') ?? identity(),
      g: pointCurve('ToneCurvePV2012Green') ?? identity(),
      b: pointCurve('ToneCurvePV2012Blue') ?? identity(),
    };
    // Presets often carry an untouched (linear) curve; it must not reset the user's own curve.
    if (![curve.rgb, curve.r, curve.g, curve.b].every(isIdentityCurve)) {
      settings.curve = curve;
      groups.add('curve');
    }
  }

  // --- Colour mixer, B&W ---------------------------------------------------------------------------
  const hslKeys = LR_BANDS.flatMap((b) => [`HueAdjustment${b}`, `SaturationAdjustment${b}`, `LuminanceAdjustment${b}`]);
  if (any(...hslKeys)) {
    const bands: J = {};
    HSL_BANDS.forEach((band, i) => {
      const b = LR_BANDS[i];
      bands[band] = { hue: num(`HueAdjustment${b}`) ?? 0, sat: num(`SaturationAdjustment${b}`) ?? 0, lum: num(`LuminanceAdjustment${b}`) ?? 0 };
    });
    settings.hsl = { bands };
    groups.add('hsl');
  }
  const gray = bool('ConvertToGrayscale');
  const mixerKeys = LR_BANDS.map((b) => `GrayMixer${b}`);
  if (gray !== undefined || any(...mixerKeys)) {
    settings.treatment = gray ? 'monochrome' : 'color';
    const mixer: J = { mix: 100 };
    HSL_BANDS.forEach((band, i) => { mixer[band] = num(`GrayMixer${LR_BANDS[i]}`) ?? 0; });
    settings.bwMixer = mixer;
    groups.add('bw');
  }

  // --- Colour grading (and pre-2020 split toning) ----------------------------------------------------
  const gradeKeys = ['Shadow', 'Midtone', 'Highlight', 'Global'].flatMap((z) => [`ColorGrade${z}Hue`, `ColorGrade${z}Sat`, `ColorGrade${z}Lum`]);
  const splitKeys = ['SplitToningShadowHue', 'SplitToningShadowSaturation', 'SplitToningHighlightHue', 'SplitToningHighlightSaturation', 'SplitToningBalance'];
  const modernGrading = any(...gradeKeys, 'ColorGradeBlending');
  if (modernGrading || any(...splitKeys)) {
    const wheel = (zone: string, splitHue?: string, splitSat?: string) => {
      const h = num(`ColorGrade${zone}Hue`) ?? (splitHue ? num(splitHue) : undefined) ?? 0;
      const s = num(`ColorGrade${zone}Sat`) ?? (splitSat ? num(splitSat) : undefined) ?? 0;
      return { hue: round(adobeHueToOklch(h), 1), sat: s, lum: num(`ColorGrade${zone}Lum`) ?? 0 };
    };
    settings.colorGrading = {
      shadows: wheel('Shadow', 'SplitToningShadowHue', 'SplitToningShadowSaturation'),
      midtones: wheel('Midtone'),
      highlights: wheel('Highlight', 'SplitToningHighlightHue', 'SplitToningHighlightSaturation'),
      global: wheel('Global'),
      // Split toning predates the Blending control; Lightroom converts it with Blending 100.
      blending: num('ColorGradeBlending') ?? (modernGrading ? 50 : 100),
      balance: num('SplitToningBalance') ?? 0,
    };
    groups.add('colorGrading');
  }

  // --- Calibration, presence -------------------------------------------------------------------------
  if (any('RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation', 'ShadowTint')) {
    settings.calibration = {
      red: { hue: num('RedHue') ?? 0, sat: num('RedSaturation') ?? 0 },
      green: { hue: num('GreenHue') ?? 0, sat: num('GreenSaturation') ?? 0 },
      blue: { hue: num('BlueHue') ?? 0, sat: num('BlueSaturation') ?? 0 },
      shadowTint: num('ShadowTint') ?? 0,
    };
    groups.add('calibration');
  }
  if (any('Vibrance', 'Saturation')) {
    settings.presence = { vibrance: num('Vibrance') ?? 0, saturation: num('Saturation') ?? 0 };
    groups.add('presence');
  }

  // --- Effects -----------------------------------------------------------------------------------------
  const effects: J = {};
  const clarity = num('Clarity2012') ?? (legacyProcess ? num('Clarity') : undefined);
  if (clarity !== undefined || any('Texture', 'Dehaze')) {
    effects.texture = num('Texture') ?? 0;
    effects.clarity = clarity ?? 0;
    effects.dehaze = num('Dehaze') ?? 0;
    groups.add('clarity');
  }
  if (any('GrainAmount', 'GrainSize', 'GrainFrequency')) {
    effects.grain = { amount: num('GrainAmount') ?? 0, size: num('GrainSize') ?? 25, roughness: num('GrainFrequency') ?? 50, color: 0, type: 'custom' };
    groups.add('grain');
  }
  const vigKeys = ['PostCropVignetteAmount', 'PostCropVignetteMidpoint', 'PostCropVignetteRoundness', 'PostCropVignetteFeather', 'PostCropVignetteHighlightContrast', 'PostCropVignetteStyle'];
  if (any(...vigKeys)) {
    effects.vignette = {
      amount: num('PostCropVignetteAmount') ?? 0,
      midpoint: num('PostCropVignetteMidpoint') ?? 50,
      roundness: num('PostCropVignetteRoundness') ?? 0,
      feather: num('PostCropVignetteFeather') ?? 50,
      highlights: num('PostCropVignetteHighlightContrast') ?? 0,
      style: VIGNETTE_STYLE[num('PostCropVignetteStyle') ?? 1] ?? 'highlight',
    };
    groups.add('vignette');
  }
  if (Object.keys(effects).length) settings.effects = effects;

  // --- Detail ------------------------------------------------------------------------------------------
  const detail: J = {};
  if (any('Sharpness', 'SharpenRadius', 'SharpenDetail', 'SharpenEdgeMasking')) {
    detail.sharpen = {
      amount: num('Sharpness') ?? 0,
      radius: num('SharpenRadius') ?? 1,
      detail: num('SharpenDetail') ?? 25,
      masking: num('SharpenEdgeMasking') ?? 0,
    };
    groups.add('sharpening');
  }
  const nrKeys = ['LuminanceSmoothing', 'LuminanceNoiseReductionDetail', 'LuminanceNoiseReductionContrast', 'ColorNoiseReduction', 'ColorNoiseReductionDetail', 'ColorNoiseReductionSmoothness'];
  if (any(...nrKeys)) {
    detail.nr = {
      lum: num('LuminanceSmoothing') ?? 0,
      lumDetail: num('LuminanceNoiseReductionDetail') ?? 50,
      lumContrast: num('LuminanceNoiseReductionContrast') ?? 0,
      color: num('ColorNoiseReduction') ?? 0,
      colorDetail: num('ColorNoiseReductionDetail') ?? 50,
      colorSmooth: num('ColorNoiseReductionSmoothness') ?? 50,
    };
    groups.add('noiseReduction');
  }
  if (Object.keys(detail).length) settings.detail = detail;

  // --- Lens corrections, geometry -------------------------------------------------------------------------
  const lensKeys = ['LensProfileEnable', 'AutoLateralCA', 'LensManualDistortionAmount', 'VignetteAmount', 'VignetteMidpoint', 'DefringePurpleAmount', 'DefringeGreenAmount', 'DefringePurpleHueLo', 'DefringePurpleHueHi', 'DefringeGreenHueLo', 'DefringeGreenHueHi'];
  if (any(...lensKeys)) {
    settings.lens = {
      auto: num('LensProfileEnable') === 1,
      distortion: num('LensManualDistortionAmount') ?? 0,
      vignetting: { amount: num('VignetteAmount') ?? 0, midpoint: num('VignetteMidpoint') ?? 50 },
      ca: { auto: num('AutoLateralCA') === 1, redCyan: 0, blueYellow: 0 },
      defringe: {
        purpleAmount: (num('DefringePurpleAmount') ?? 0) * DEFRINGE_SCALE,
        purpleHue: [num('DefringePurpleHueLo') ?? 30, num('DefringePurpleHueHi') ?? 70],
        greenAmount: (num('DefringeGreenAmount') ?? 0) * DEFRINGE_SCALE,
        greenHue: [num('DefringeGreenHueLo') ?? 40, num('DefringeGreenHueHi') ?? 60],
      },
    };
    groups.add('lens');
  }
  const geoKeys = ['PerspectiveUpright', 'PerspectiveVertical', 'PerspectiveHorizontal', 'PerspectiveRotate', 'PerspectiveAspect', 'PerspectiveScale', 'PerspectiveX', 'PerspectiveY'];
  if (any(...geoKeys)) {
    const up = num('PerspectiveUpright') ?? 0;
    if (up === UPRIGHT_GUIDED) skip('guidedUpright');
    settings.geometry = {
      upright: UPRIGHT[up] ?? 'off',
      vertical: num('PerspectiveVertical') ?? 0,
      horizontal: num('PerspectiveHorizontal') ?? 0,
      rotate: num('PerspectiveRotate') ?? 0,
      aspect: num('PerspectiveAspect') ?? 0,
      scale: num('PerspectiveScale') ?? 100,
      offsetX: num('PerspectiveX') ?? 0,
      offsetY: num('PerspectiveY') ?? 0,
    };
    groups.add('geometry');
  }

  // --- What Optic cannot take over ---------------------------------------------------------------------------
  const lookName = str('Look.Name');
  const cameraProfile = str('CameraProfile');
  if (lookName && !DEFAULT_PROFILES.has(lookName)) skip('profile', lookName);
  else if (cameraProfile && !DEFAULT_PROFILES.has(cameraProfile)) skip('profile', cameraProfile);
  else if (has('RGBTable')) skip('profile');
  const maskCount = ['MaskGroupBasedCorrections', 'GradientBasedCorrections', 'CircularGradientBasedCorrections', 'PaintBasedCorrections']
    .reduce((n, k) => {
      const v = crs.get(k);
      return n + (Array.isArray(v) ? v.length : v === STRUCT ? 1 : 0);
    }, 0);
  if (maskCount) skip('masks', String(maskCount));
  if (['RetouchInfo', 'RetouchAreas', 'RedEyeInfo'].some((k) => nonEmpty(crs.get(k)))) skip('retouch');
  if (bool('HasCrop') || (num('CropAngle') ?? 0) !== 0) skip('crop');
  if (nonEmpty(crs.get('PointColors'))) skip('pointColor');
  if ((num('HDREditMode') ?? 0) > 0) skip('hdr');
  if (has('LensBlur') && str('LensBlur.Active')?.toLowerCase() !== 'false') skip('lensBlur');

  // --- Which groups to keep ---------------------------------------------------------------------------------
  let includes = [...groups];
  if (kind === 'snapshot') {
    const parsed = parseGroups(settings, defaultRecipe());
    const neutral = JSON.stringify(defaultRecipe());
    includes = includes.filter((g) => JSON.stringify(setGroup(defaultRecipe(), g, parsed)) !== neutral);
    const photo = orderGroups(includes).filter((g) => PHOTO_SPECIFIC_GROUPS.includes(g));
    if (photo.length) skip('photoSpecific', photo.join(', '));
    includes = includes.filter((g) => !PHOTO_SPECIFIC_GROUPS.includes(g));
  }
  // Keep only the settings the kept groups own (no stray fields in the stored preset).
  const kept = pickSettings(settings, includes);
  const keptNonRaw = includes.includes('whiteBalance') && nonRaw.whiteBalance ? { whiteBalance: nonRaw.whiteBalance } : undefined;
  return { includes: orderGroups(includes), settings: kept, nonRaw: keptNonRaw, notConverted, legacyProcess };
}

const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.some((s) => s !== '') : v === STRUCT || (typeof v === 'string' && v.trim() !== ''));

function orderGroups(g: PresetGroup[]): PresetGroup[] {
  const order: PresetGroup[] = ['whiteBalance', 'exposure', 'light', 'curve', 'hsl', 'bw', 'colorGrading', 'calibration', 'presence', 'clarity', 'grain', 'vignette', 'sharpening', 'noiseReduction', 'lens', 'geometry'];
  return order.filter((x) => g.includes(x));
}

function pickSettings(s: J, groups: PresetGroup[]): J {
  const out: J = {};
  const light = (s.light ?? {}) as J;
  if (groups.includes('exposure') || groups.includes('light')) {
    const l: J = {};
    if (groups.includes('exposure')) l.exposure = light.exposure;
    if (groups.includes('light')) for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks']) l[k] = light[k];
    out.light = l;
  }
  const eff = (s.effects ?? {}) as J;
  const e: J = {};
  if (groups.includes('clarity')) { e.texture = eff.texture; e.clarity = eff.clarity; e.dehaze = eff.dehaze; }
  if (groups.includes('grain')) e.grain = eff.grain;
  if (groups.includes('vignette')) e.vignette = eff.vignette;
  if (Object.keys(e).length) out.effects = e;
  const det = (s.detail ?? {}) as J;
  const d: J = {};
  if (groups.includes('sharpening')) d.sharpen = det.sharpen;
  if (groups.includes('noiseReduction')) d.nr = det.nr;
  if (Object.keys(d).length) out.detail = d;
  const direct: Array<[PresetGroup, string[]]> = [
    ['whiteBalance', ['whiteBalance']], ['curve', ['curve']], ['hsl', ['hsl']], ['bw', ['treatment', 'bwMixer']],
    ['colorGrading', ['colorGrading']], ['calibration', ['calibration']], ['presence', ['presence']],
    ['lens', ['lens']], ['geometry', ['geometry']],
  ];
  for (const [g, keys] of direct) if (groups.includes(g)) for (const k of keys) out[k] = s[k];
  return out;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

const identity = (): Point[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];

/** "x, y" items on a 0…255 scale → sorted, de-duplicated points on 0…1 (null if unusable). */
export function parseCurve(items: string[] | undefined): Point[] | null {
  if (!items?.length) return null;
  const pts: Point[] = [];
  for (const it of items) {
    const m = /^\s*([+-]?[\d.]+)\s*[,\s]\s*([+-]?[\d.]+)\s*$/.exec(it);
    if (!m) continue;
    const x = Number(m[1]), y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({ x: round(Math.min(255, Math.max(0, x)) / 255, 4), y: round(Math.min(255, Math.max(0, y)) / 255, 4) });
  }
  pts.sort((a, b) => a.x - b.x);
  const dedup = pts.filter((p, i) => i === 0 || p.x > pts[i - 1].x);
  if (dedup.length < 2) return null;
  // Very dense curves (some presets store dozens of points) are resampled to stay editable.
  return dedup.length <= 16 ? dedup : resample(monotoneCubic(dedup), 16);
}

export interface Parametric { shadows: number; darks: number; lights: number; highlights: number; s1: number; s2: number; s3: number }

/**
 * Lightroom's parametric curve, approximated: four regions split at s1 / s2 / s3 (percent), each
 * slider (−100…+100) moving the region's centre by up to half the region's width. Returns 17
 * points through a monotone curve, or null when every slider is 0.
 */
export function parametricPoints(p: Parametric): Point[] | null {
  if (!p.shadows && !p.darks && !p.lights && !p.highlights) return null;
  const splits = [p.s1, p.s2, p.s3].map((v) => Math.min(95, Math.max(5, v)) / 100).sort((a, b) => a - b);
  const bounds = [0, ...splits, 1];
  const amounts = [p.shadows, p.darks, p.lights, p.highlights];
  const ctrl: Point[] = [{ x: 0, y: 0 }];
  for (let k = 0; k < 4; k++) {
    const a = bounds[k], b = bounds[k + 1];
    const c = (a + b) / 2;
    ctrl.push({ x: c, y: c + (Math.max(-100, Math.min(100, amounts[k])) / 100) * 0.5 * (b - a) });
  }
  ctrl.push({ x: 1, y: 1 });
  // Keep it monotone (a strong Darks pull can't cross a strong Shadows lift).
  for (let i = 1; i < ctrl.length; i++) ctrl[i].y = Math.min(1, Math.max(ctrl[i].y, ctrl[i - 1].y + 0.002));
  ctrl[ctrl.length - 1].y = Math.max(ctrl[ctrl.length - 1].y, 1);
  return resample(monotoneCubic(ctrl), 17);
}

/** Parametric curve first, then the point curve (Lightroom's order). */
function composeCurves(parametric: Point[] | null, point: Point[] | null): Point[] {
  if (!parametric) return point ?? identity();
  if (!point || isIdentityCurve(point)) return parametric;
  const pf = monotoneCubic(parametric), cf = monotoneCubic(point);
  return resample((x) => cf(pf(x)), 17);
}

function resample(f: (x: number) => number, n: number): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return { x: round(x, 4), y: round(Math.min(1, Math.max(0, f(x))), 4) };
  });
}

// ---------------------------------------------------------------------------
// Hue
// ---------------------------------------------------------------------------

const SRGB_TO_WORKING = mul(inv(WORKING_TO_XYZ), toXYZ_D65('srgb'));

/**
 * Lightroom's colour-wheel hue (an HSV-style hue, 0° = red, 120° = green) → the OKLCH hue Optic's
 * grading wheels use, through the fully saturated sRGB colour of that hue.
 */
export function adobeHueToOklch(h: number): number {
  const hh = ((h % 360) + 360) % 360;
  const [r, g, b] = hsvToRgb(hh);
  const lin = mulVec(SRGB_TO_WORKING, [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]);
  const [, a, bb] = workingToOklab(lin);
  const deg = (Math.atan2(bb, a) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function hsvToRgb(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 1 - Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}
