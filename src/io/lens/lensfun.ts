/**
 * Lens profile lookup in the bundled lensfun subset (scripts/build-lensfun-subset.mjs), for raw
 * files that carry no corrections of their own. The EXIF lens name is matched token by token
 * (focal range and aperture must agree), calibrations are interpolated at the shot's focal length
 * (and aperture, for vignetting) and converted to the lens model's polynomial form (Hugin units).
 */
import type { LensProfile, LensfunCalib } from '../../geometry/lens';
import type { CameraInfo } from '../decode/types';

type Dist = [number, 'ptlens', number, number, number] | [number, 'poly3', number] | [number, 'poly5', number, number];
interface LfLens {
  maker: string;
  model: string;
  crop: number;
  dist: Dist[];
  tca: Array<[number, number, number, number, number, number, number]>;
  vig: Array<[number, number, number, number, number]>;
}
interface LfDb { cameras: Array<{ maker: string; model: string; crop: number }>; lenses: LfLens[] }

let db: Promise<LfDb> | null = null;
const loadDb = () => (db ??= import('./lensfun-subset.json').then((m) => m.default as unknown as LfDb));

/** Lower-case tokens with f-numbers normalised ("F3.5-5.6", "f/3.5-5.6" → "f3.5-5.6"). */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/f\/\s*/g, 'f')
    .replace(/\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*mm\b/g, '$1-$2mm')
    .replace(/[^a-z0-9.\-+]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Best lens for an EXIF lens name: every distinctive token of the lensfun name must appear. */
export function matchLens(lenses: LfLens[], exifLens: string, make?: string): LfLens | null {
  const have = new Set(tokens(`${make ?? ''} ${exifLens}`));
  let best: LfLens | null = null, bestScore = 0;
  for (const l of lenses) {
    const want = tokens(l.model);
    const focal = want.find((t) => /\d+(-\d+)?mm$/.test(t));
    if (focal && !have.has(focal)) continue;
    const hit = want.filter((t) => have.has(t)).length;
    const score = hit / want.length + (have.has(l.maker.toLowerCase()) ? 0.05 : 0);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  return bestScore >= 0.8 ? best : null;
}

/** Linear interpolation between the two entries around `x` (by the first element). */
function interp<T extends number[]>(rows: T[], x: number): T | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return sorted[0];
  if (x >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1];
  const i = sorted.findIndex((r) => r[0] >= x);
  const a = sorted[i - 1], b = sorted[i];
  const t = (x - a[0]) / (b[0] - a[0]);
  return a.map((v, k) => v + (b[k] - v) * t) as T;
}

function distPoly(rows: Dist[], focal: number): LensfunCalib['dist'] {
  if (!rows.length) return undefined;
  // Interpolate within the model of the nearest calibration.
  const near = rows.reduce((a, b) => (Math.abs(a[0] - focal) <= Math.abs(b[0] - focal) ? a : b));
  const same = rows.filter((r) => r[1] === near[1]).map((r) => [r[0], ...r.slice(2)] as number[]);
  const c = interp(same, focal)!;
  if (near[1] === 'ptlens') {
    const [, a, b, cc] = c;
    return [1 - a - b - cc, cc, b, a, 0];
  }
  if (near[1] === 'poly3') return [1 - c[1], 0, c[1], 0, 0];
  return [1, 0, c[1], 0, c[2]];
}

export async function lensfunProfile(info: CameraInfo, width: number, height: number): Promise<LensProfile | null> {
  if (!info.lens || !info.focalLength) return null;
  const d = await loadDb();
  const lens = matchLens(d.lenses, info.lens, info.make);
  if (!lens) return null;
  const cam = d.cameras.find((c) => info.model && c.model.toLowerCase() === info.model.toLowerCase());
  const cropImg = info.focal35 && info.focalLength ? info.focal35 / info.focalLength : cam?.crop ?? lens.crop;
  const f = info.focalLength;
  const tca = interp(lens.tca, f);
  let vig: [number, number, number] | undefined;
  if (lens.vig.length) {
    // Nearest focal length, then interpolate over aperture (in stops).
    const nf = lens.vig.reduce((a, b) => (Math.abs(a[0] - f) <= Math.abs(b[0] - f) ? a : b))[0];
    const rows = lens.vig.filter((v) => v[0] === nf).map((v) => [Math.log2(v[1]), v[2], v[3], v[4]]);
    const v = interp(rows, Math.log2(info.aperture ?? 5.6));
    if (v) vig = [v[1], v[2], v[3]];
  }
  const calib: LensfunCalib = {
    dist: distPoly(lens.dist, f),
    tcaR: tca ? [tca[1], tca[2], tca[3]] : undefined,
    tcaB: tca ? [tca[4], tca[5], tca[6]] : undefined,
    vig,
    cropCal: lens.crop,
    cropImg,
  };
  return { source: 'lensfun', name: `${lens.maker} ${lens.model} (lensfun)`, rawW: width, rawH: height, orientation: 1, lensfun: calib };
}
