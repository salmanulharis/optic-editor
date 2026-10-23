/**
 * Names for history steps: what changed between two recipes, e.g. "Exposure +0.65",
 * "Grain amount 25", "Tone curve". The key (the set of changed fields) lets the history collapse
 * rapid consecutive edits of the same control into one step.
 */
import { ADJUST_RANGES, TYPE_LABELS, type Mask, type ScalarAdjust } from '../recipe/masks';
import type { Recipe } from '../recipe/schema';

const SECTION: Record<string, string> = {
  whiteBalance: 'White balance',
  light: 'Light',
  look: 'Look',
  hsl: 'Color mixer',
  curve: 'Tone curve',
  treatment: 'Treatment',
  bwMixer: 'B&W mix',
  pointColor: 'Point color',
  colorGrading: 'Color grading',
  calibration: 'Calibration',
  presence: 'Presence',
  lut: 'LUT',
  detail: 'Detail',
  effects: 'Effects',
  lens: 'Lens corrections',
  geometry: 'Transform',
  crop: 'Crop',
  output: 'Output',
  appliedPreset: 'Preset',
  masks: 'Masks',
};

/** Field paths with their own names (others are built from the path). */
const NAMES: Record<string, string> = {
  'whiteBalance.temperature': 'Temperature',
  'whiteBalance.tint': 'Tint',
  'whiteBalance.castStrength': 'Remove cast',
  'light.exposure': 'Exposure',
  'light.contrast': 'Contrast',
  'light.highlights': 'Highlights',
  'light.shadows': 'Shadows',
  'light.whites': 'Whites',
  'light.blacks': 'Blacks',
  'presence.vibrance': 'Vibrance',
  'presence.saturation': 'Saturation',
  'detail.sharpen.amount': 'Sharpening',
  'detail.sharpen.radius': 'Sharpen radius',
  'detail.sharpen.detail': 'Sharpen detail',
  'detail.sharpen.masking': 'Sharpen masking',
  'detail.nr.lum': 'Luminance NR',
  'detail.nr.lumDetail': 'Luminance NR detail',
  'detail.nr.lumContrast': 'Luminance NR contrast',
  'detail.nr.color': 'Color NR',
  'detail.nr.colorDetail': 'Color NR detail',
  'detail.nr.colorSmooth': 'Color NR smoothness',
  'effects.texture': 'Texture',
  'effects.clarity': 'Clarity',
  'effects.dehaze': 'Dehaze',
  'effects.grain.amount': 'Grain',
  'effects.vignette.amount': 'Vignette',
  'effects.halation.amount': 'Halation',
  'effects.bloom.amount': 'Bloom',
  'lens.distortion': 'Distortion',
  'lens.auto': 'Lens profile',
  'geometry.vertical': 'Vertical',
  'geometry.horizontal': 'Horizontal',
  'geometry.rotate': 'Rotate',
  'geometry.aspect': 'Aspect',
  'geometry.scale': 'Scale',
  'crop.angle': 'Straighten',
  'treatment': 'Treatment',
};

/** Fields whose slider is centred on zero: shown with a sign. */
const SIGNED = /^(light\.(exposure|contrast|highlights|shadows|whites|blacks)|presence\.|effects\.(texture|clarity|dehaze|vignette\.amount|bloom\.warmth)|whiteBalance\.tint|lens\.(distortion|vignetting\.amount|ca\.)|geometry\.(vertical|horizontal|rotate|aspect|offset)|hsl\.|calibration\.|look\.warmthBias|crop\.angle)/;

const human = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);

function fieldName(path: string): string {
  if (NAMES[path]) return NAMES[path];
  const parts = path.split('.');
  // effects.grain.size → "Grain size"; hsl.bands.red.sat → "Red saturation"
  if (parts[0] === 'hsl' && parts.length === 4) return `${human(parts[2])} ${({ hue: 'hue', sat: 'saturation', lum: 'luminance' } as Record<string, string>)[parts[3]] ?? parts[3]}`;
  const tail = parts.slice(1).filter((p) => p !== 'bands');
  return human(tail.join(' ')) || SECTION[parts[0]] || human(parts[0]);
}

function fmt(path: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v;
  if (typeof v !== 'number') return '';
  const dec = path === 'light.exposure' ? 2 : Math.abs(v - Math.round(v)) > 1e-6 ? (path.endsWith('radius') ? 1 : 2) : 0;
  const s = v.toFixed(dec);
  if (path === 'crop.angle' || path === 'geometry.rotate') return `${v > 0 ? '+' : ''}${s}°`;
  return SIGNED.test(path) && v > 0 ? `+${s}` : s;
}

/** Leaf paths whose values differ (arrays compare as a whole). */
function changedPaths(a: unknown, b: unknown, path: string, out: string[]) {
  if (a === b) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) changedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path);
}

const get = (r: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), r);

/** "Sky: Exposure −0.60", "New mask: Radial", "Delete mask: Sky", with a key per mask control. */
function describeMasks(a: Mask[], b: Mask[]): { label: string; key: string } {
  if (b.length > a.length) {
    const m = b.find((x) => !a.some((y) => y.id === x.id));
    return { label: `New mask${m ? `: ${m.name}` : ''}`, key: `masks:add:${m?.id}` };
  }
  if (b.length < a.length) {
    const m = a.find((x) => !b.some((y) => y.id === x.id));
    return { label: `Delete mask${m ? `: ${m.name}` : ''}`, key: `masks:del:${m?.id}` };
  }
  const i = b.findIndex((m, k) => JSON.stringify(m) !== JSON.stringify(a[k]));
  if (i < 0) return { label: 'Masks', key: 'masks' };
  const pm = a[i], nm = b[i];
  if (pm.id !== nm.id) return { label: 'Reorder masks', key: 'masks:order' };
  const paths: string[] = [];
  changedPaths(pm, nm, '', paths);
  const p = paths[0] ?? '';
  const key = `masks:${nm.id}:${paths.sort().join('|')}`;
  if (paths.length === 1 && p.startsWith('adjustments.')) {
    const k = p.split('.')[1] as ScalarAdjust;
    const v = get(nm, p);
    const r = ADJUST_RANGES[k];
    if (r && typeof v === 'number') return { label: `${nm.name}: ${r.label} ${v > 0 ? '+' : ''}${v.toFixed(k === 'exposure' ? 2 : 0)}`, key };
    return { label: `${nm.name}: Color tint`, key };
  }
  if (paths.length === 1 && p === 'amount') return { label: `${nm.name}: Amount ${nm.amount}%`, key };
  if (paths.length === 1 && p === 'visible') return { label: `${nm.name} ${nm.visible ? 'shown' : 'hidden'}`, key };
  if (paths.length === 1 && p === 'invert') return { label: `Invert ${nm.name}`, key };
  if (paths.length === 1 && p === 'name') return { label: `Rename mask: ${nm.name}`, key };
  if (p === 'components' || paths.includes('components')) {
    if (nm.components.length > pm.components.length) {
      const c = nm.components[nm.components.length - 1];
      return { label: `${nm.name}: ${c.op === 'add' ? 'Add' : c.op === 'subtract' ? 'Subtract' : 'Intersect'} ${TYPE_LABELS[c.type]}`, key };
    }
    if (nm.components.length < pm.components.length) return { label: `${nm.name}: Remove component`, key };
    const c = nm.components.find((x, k) => JSON.stringify(x) !== JSON.stringify(pm.components[k]));
    return { label: `${nm.name}: ${c ? TYPE_LABELS[c.type] : 'Components'}`, key: c?.type === 'brush' ? `${key}:${Date.now()}` : key };
  }
  return { label: nm.name, key };
}

export function describeChange(prev: Recipe, next: Recipe): { label: string; key: string } {
  const paths: string[] = [];
  changedPaths(prev, next, '', paths);
  const key = paths.sort().join('|');
  if (!paths.length) return { label: 'No change', key };
  if (paths.length === 1 && paths[0] === 'masks') return describeMasks(prev.masks ?? [], next.masks ?? []);
  if (paths.length === 1) {
    const p = paths[0];
    if (p.endsWith('.enabled')) return { label: `${SECTION[p.split('.')[0]] ?? human(p)} ${get(next, p) ? 'on' : 'off'}`, key };
    const v = get(next, p);
    const val = fmt(p, v);
    return { label: val ? `${fieldName(p)} ${val}` : fieldName(p), key };
  }
  const sections = new Set(paths.map((p) => p.split('.')[0]));
  if (sections.size === 1) {
    const sec = [...sections][0];
    // Several fields of one sub-group (e.g. grain amount + size from a grain type).
    const groups = new Set(paths.map((p) => p.split('.').slice(0, 2).join('.')));
    if (groups.size === 1 && sec === 'effects') return { label: human(paths[0].split('.')[1]), key };
    return { label: SECTION[sec] ?? human(sec), key };
  }
  return { label: 'Multiple edits', key };
}

/** Human-readable list of what a recipe changes relative to `base` (info panel, sidecars). */
export function recipeSummary(r: Recipe, base: Recipe): string[] {
  const out: string[] = [];
  if (r.appliedPreset) out.push(`Preset: ${r.appliedPreset.name} (${Math.round(r.appliedPreset.amount)}%)`);
  const paths: string[] = [];
  changedPaths({ ...base, appliedPreset: null, masks: [] }, { ...r, appliedPreset: null, masks: [] }, '', paths);
  const seen = new Set<string>();
  for (const p of paths.sort()) {
    if (p.endsWith('.enabled')) { if (!get(r, p)) out.push(`${SECTION[p.split('.')[0]] ?? human(p)} off`); continue; }
    const v = get(r, p);
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      const label = `${fieldName(p)} ${fmt(p, v)}`.trim();
      if (!seen.has(label)) { seen.add(label); out.push(label); }
    } else {
      const sec = SECTION[p.split('.')[0]] ?? human(p.split('.')[0]);
      if (!seen.has(sec)) { seen.add(sec); out.push(sec); }
    }
  }
  for (const m of r.masks) out.push(`Mask: ${m.name}${m.visible ? '' : ' (hidden)'}`);
  return out;
}
