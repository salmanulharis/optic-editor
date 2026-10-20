/**
 * Lens model: U (undistorted) → S (source) per colour channel, plus the vignetting gain at S.
 *
 * Sources of corrections, applied in this order for each output pixel:
 *  1. Manual distortion: r_d = r_u · (1 + k·r_u²) about the image centre (r = 1 at the corner).
 *  2. Profile ("Auto"): either the file's own DNG opcodes (WarpRectilinear: radial + tangential,
 *     per colour plane; FixVignetteRadial; GainMap), evaluated in the raw (pre-orientation)
 *     coordinates the DNG spec defines them in, or a lensfun calibration (ptlens / poly3 / poly5
 *     distortion, poly3 / linear TCA, pa vignetting) in Hugin coordinates.
 *  3. Lateral chromatic aberration: red and blue scaled radially about the centre relative to green
 *     (auto estimate + manual sliders).
 * Vignetting corrections (manual, DNG, lensfun, gain map) multiply the sample taken at S.
 *
 * The same math exists in GLSL (pipeline/stages/05_lensCorrection.ts) and here in TypeScript for
 * the CPU side (export tile bounds, crop constraints, pointer → source mapping).
 */
import { type Mat3, IDENTITY, inv, mul } from '../color/matrices';
import type { Recipe } from '../recipe/schema';
import type { Vec2 } from './transform';

/** WarpRectilinear (DNG opcode 1): per-plane radial kr0…kr3 and tangential kt0, kt1. */
export interface DngWarp {
  planes: Array<{ kr: [number, number, number, number]; kt: [number, number] }>;
  /** Optical centre, relative to the raw image (0.5 = middle). */
  cx: number;
  cy: number;
}

/** FixVignetteRadial (DNG opcode 3): gain = 1 + k0 r² + k1 r⁴ + … + k4 r¹⁰. */
export interface DngVignette {
  k: [number, number, number, number, number];
  cx: number;
  cy: number;
}

/** GainMap (DNG opcode 9), already merged to one map with 1 or 3 planes (R, G, B). */
export interface GainMap {
  /** Area of the raw image the map covers, in raw pixels. */
  top: number;
  left: number;
  bottom: number;
  right: number;
  pointsV: number;
  pointsH: number;
  spacingV: number;
  spacingH: number;
  originV: number;
  originH: number;
  planes: 1 | 3;
  /** pointsV × pointsH × planes, row-major. */
  data: Float32Array;
}

export interface LensfunCalib {
  /** r_d / r_u = c0 + c1 r + c2 r² + c3 r³ + c4 r⁴ (Hugin units). */
  dist?: [number, number, number, number, number];
  /** Per channel r_d / r_u = v + c r + b r² (Hugin units, relative to green). */
  tcaR?: [number, number, number];
  tcaB?: [number, number, number];
  /** pa model: vignetting factor 1 + k1 r² + k2 r⁴ + k3 r⁶, r = 1 at the corner. */
  vig?: [number, number, number];
  /** Calibration sensor crop factor and the image's crop factor. */
  cropCal: number;
  cropImg: number;
}

export interface LensProfile {
  source: 'dng' | 'lensfun';
  name: string;
  /** Raw image size and orientation (DNG opcodes live in raw coordinates). */
  rawW: number;
  rawH: number;
  orientation: number;
  warp?: DngWarp;
  vignette?: DngVignette;
  gainMap?: GainMap;
  lensfun?: LensfunCalib;
}

/** Everything the shader needs, derived once per (image, lens recipe). */
export interface LensModel {
  /** Any lens correction at all (geometry-only transforms don't need this stage's lens part). */
  active: boolean;
  center: Vec2;
  /** Half-diagonal of S in pixels (manual distortion / vignetting / CA normalisation). */
  norm: number;
  manualK: number;
  /** 0 none, 1 DNG warp, 2 lensfun. */
  mode: 0 | 1 | 2;
  sToRaw: Mat3;
  rawToS: Mat3;
  dngC: Vec2;
  dngM: number;
  /** 3 planes × (kr0…kr3), and 3 × (kt0, kt1). */
  kr: Float32Array;
  kt: Float32Array;
  lfC: Vec2;
  /** Pixels per Hugin unit. */
  lfN: number;
  lfDist: Float32Array; // 5
  lfTca: Float32Array; // 6: R(v, c, b), B(v, c, b)
  /** Radial scale of red and blue relative to green (1 = none). */
  ca: Vec2;
  /** Manual vignetting: stops at the corner, start radius. */
  vigManual: Vec2;
  /** DNG FixVignetteRadial k0…k4 (0 = off) with its centre / radius in raw pixels. */
  vigDng: Float32Array; // 5
  vigDngC: Vec2;
  vigDngM: number;
  /** lensfun pa k1…k3 (0 = off), r = 1 at the S corner. */
  vigLf: Float32Array; // 3
  gainMap: GainMap | null;
  /** S pixel → gain-map texture coordinate. */
  gainM: Mat3;
  /** Defringe: amount 0…1, hue window (OKLCH degrees) for purple and green fringes. */
  purple: [number, number, number];
  green: [number, number, number];
  /** Defringe sampling radius in S pixels. */
  fringeRadius: number;
  /** Lens correction needs neighbouring source pixels (defringe). */
  needsNeighbours: boolean;
}

/** S → raw coordinates for an EXIF orientation (continuous pixel coordinates). */
export function orientationMatrix(o: number, rawW: number, rawH: number): Mat3 {
  switch (o) {
    case 2: return [-1, 0, rawW, 0, 1, 0, 0, 0, 1];
    case 3: return [-1, 0, rawW, 0, -1, rawH, 0, 0, 1];
    case 4: return [1, 0, 0, 0, -1, rawH, 0, 0, 1];
    case 5: return [0, 1, 0, 1, 0, 0, 0, 0, 1];
    case 6: return [0, 1, 0, -1, 0, rawH, 0, 0, 1];
    case 7: return [0, -1, rawW, -1, 0, rawH, 0, 0, 1];
    case 8: return [0, -1, rawW, 1, 0, 0, 0, 0, 1];
    default: return IDENTITY;
  }
}

/** Defringe hue windows: Lightroom-style 0…100 sliders mapped onto OKLCH hue. */
const PURPLE_HUE: Vec2 = [250, 350];
const GREEN_HUE: Vec2 = [95, 175];
const hueWindow = (r: [number, number], span: Vec2): Vec2 => [span[0] + ((span[1] - span[0]) * r[0]) / 100, span[0] + ((span[1] - span[0]) * r[1]) / 100];

/** Manual CA slider (±100) → radial scale offset. ±100 ≈ ±5 px at the corner of a 24 MP frame. */
const CA_PER_UNIT = 0.0017 / 100;

export interface LensInputs {
  width: number;
  height: number;
  profile?: LensProfile | null;
  /** Auto-estimated radial scale offsets for red and blue (analysis). */
  caEstimate?: Vec2 | null;
}

let memo: { key: string; inputs: LensInputs; model: LensModel } | null = null;

export function lensModel(img: LensInputs, l: Recipe['lens']): LensModel {
  const key = JSON.stringify([l, img.caEstimate ?? null, img.width, img.height]);
  if (memo && memo.inputs.profile === img.profile && memo.inputs.width === img.width && memo.key === key) return memo.model;
  const { width: W, height: H } = img;
  const center: Vec2 = [W / 2, H / 2];
  const norm = Math.hypot(W, H) / 2;
  const prof = l.auto ? img.profile ?? null : null;
  const m: LensModel = {
    active: false,
    center,
    norm,
    manualK: (-l.distortion / 100) * 0.18,
    mode: 0,
    sToRaw: IDENTITY,
    rawToS: IDENTITY,
    dngC: [0, 0],
    dngM: 1,
    kr: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    kt: new Float32Array(6),
    lfC: center,
    lfN: Math.min(W, H) / 2,
    lfDist: new Float32Array([1, 0, 0, 0, 0]),
    lfTca: new Float32Array([1, 0, 0, 1, 0, 0]),
    ca: [1, 1],
    vigManual: [(l.vignetting.amount / 100) * 1.5, 0.15 + 0.7 * (l.vignetting.midpoint / 100)],
    vigDng: new Float32Array(5),
    vigDngC: [0, 0],
    vigDngM: 1,
    vigLf: new Float32Array(3),
    gainMap: null,
    gainM: IDENTITY,
    purple: [l.defringe.purpleAmount / 100, ...hueWindow(l.defringe.purpleHue, PURPLE_HUE)],
    green: [l.defringe.greenAmount / 100, ...hueWindow(l.defringe.greenHue, GREEN_HUE)],
    fringeRadius: Math.max(1.5, (2.5 * Math.max(W, H)) / 6000),
    needsNeighbours: l.defringe.purpleAmount > 0 || l.defringe.greenAmount > 0,
  };
  let profileTca = false;
  if (prof) {
    const sToRaw = orientationMatrix(prof.orientation, prof.rawW, prof.rawH);
    m.sToRaw = sToRaw;
    m.rawToS = inv(sToRaw);
    const maxDist = (cx: number, cy: number) =>
      Math.max(Math.hypot(cx, cy), Math.hypot(prof.rawW - cx, cy), Math.hypot(cx, prof.rawH - cy), Math.hypot(prof.rawW - cx, prof.rawH - cy));
    if (prof.warp) {
      m.mode = 1;
      const w = prof.warp;
      m.dngC = [w.cx * prof.rawW, w.cy * prof.rawH];
      m.dngM = maxDist(m.dngC[0], m.dngC[1]);
      for (let c = 0; c < 3; c++) {
        const p = w.planes[Math.min(c, w.planes.length - 1)];
        m.kr.set(p.kr, c * 4);
        m.kt.set(p.kt, c * 2);
      }
      profileTca = w.planes.length > 1;
    }
    if (prof.vignette) {
      m.vigDng.set(prof.vignette.k);
      m.vigDngC = [prof.vignette.cx * prof.rawW, prof.vignette.cy * prof.rawH];
      m.vigDngM = maxDist(m.vigDngC[0], m.vigDngC[1]);
    }
    if (prof.gainMap) {
      const g = prof.gainMap;
      m.gainMap = g;
      // raw px → relative (0…1 of the map area) → map column / row → texel-centred uv
      const sx = 1 / (g.right - g.left), sy = 1 / (g.bottom - g.top);
      const toRel: Mat3 = [sx, 0, -g.left * sx, 0, sy, -g.top * sy, 0, 0, 1];
      const toTex: Mat3 = [
        1 / (g.spacingH * g.pointsH), 0, (0.5 - g.originH / g.spacingH) / g.pointsH,
        0, 1 / (g.spacingV * g.pointsV), (0.5 - g.originV / g.spacingV) / g.pointsV,
        0, 0, 1,
      ];
      m.gainM = mul(toTex, mul(toRel, sToRaw));
    }
    if (prof.lensfun) {
      const lf = prof.lensfun;
      // Hugin unit = half the short side of the *calibration* sensor, here in image pixels.
      const diagPx = Math.hypot(W, H);
      const pxPerMm = diagPx / (Math.hypot(36, 24) / lf.cropImg);
      const halfShortCalMm = 12 / lf.cropCal;
      m.lfN = halfShortCalMm * pxPerMm;
      if (lf.dist) { m.mode = 2; m.lfDist.set(lf.dist); }
      if (lf.tcaR && lf.tcaB) { m.mode = 2; m.lfTca.set([...lf.tcaR, ...lf.tcaB]); profileTca = true; }
      if (lf.vig) {
        // pa: r = 1 at the corner of the calibration sensor; rescale to this image's corner.
        const k = (Math.hypot(36, 24) / 2 / lf.cropCal) / (Math.hypot(36, 24) / 2 / lf.cropImg);
        m.vigLf.set([lf.vig[0] / (k * k), lf.vig[1] / k ** 4, lf.vig[2] / k ** 6]);
      }
    }
  }
  const est = l.ca.auto && !profileTca ? img.caEstimate ?? [0, 0] : [0, 0];
  m.ca = [1 + est[0] + l.ca.redCyan * CA_PER_UNIT, 1 + est[1] - l.ca.blueYellow * CA_PER_UNIT];
  m.active =
    m.manualK !== 0 || m.mode !== 0 || m.ca[0] !== 1 || m.ca[1] !== 1 || m.vigManual[0] !== 0 ||
    m.vigDng.some((v) => v !== 0) || m.vigLf.some((v) => v !== 0) || !!m.gainMap || m.needsNeighbours;
  memo = { key, inputs: img, model: m };
  return m;
}

const apply = (mm: Mat3, p: Vec2): Vec2 => [mm[0] * p[0] + mm[1] * p[1] + mm[2], mm[3] * p[0] + mm[4] * p[1] + mm[5]];

/** U → S for one channel (0 R, 1 G, 2 B). Mirrors lens_toS in the shader. */
export function uToS(m: LensModel, u: Vec2, ch = 1): Vec2 {
  let p: Vec2 = u;
  if (m.manualK !== 0) {
    const dx = (p[0] - m.center[0]) / m.norm, dy = (p[1] - m.center[1]) / m.norm;
    const f = 1 + m.manualK * (dx * dx + dy * dy);
    p = [m.center[0] + dx * f * m.norm, m.center[1] + dy * f * m.norm];
  }
  if (m.mode === 1) {
    const q = apply(m.sToRaw, p);
    const dx = (q[0] - m.dngC[0]) / m.dngM, dy = (q[1] - m.dngC[1]) / m.dngM;
    const r2 = dx * dx + dy * dy;
    const k = m.kr.subarray(ch * 4, ch * 4 + 4), t = m.kt.subarray(ch * 2, ch * 2 + 2);
    const f = k[0] + r2 * (k[1] + r2 * (k[2] + r2 * k[3]));
    const tx = t[0] * 2 * dx * dy + t[1] * (r2 + 2 * dx * dx);
    const ty = t[1] * 2 * dx * dy + t[0] * (r2 + 2 * dy * dy);
    p = apply(m.rawToS, [m.dngC[0] + m.dngM * (f * dx + tx), m.dngC[1] + m.dngM * (f * dy + ty)]);
  } else if (m.mode === 2) {
    const dx = (p[0] - m.lfC[0]) / m.lfN, dy = (p[1] - m.lfC[1]) / m.lfN;
    const r = Math.hypot(dx, dy);
    const d = m.lfDist;
    let f = d[0] + r * (d[1] + r * (d[2] + r * (d[3] + r * d[4])));
    if (ch !== 1) {
      const o = ch === 0 ? 0 : 3;
      const rd = r * f;
      f *= m.lfTca[o] + rd * (m.lfTca[o + 1] + rd * m.lfTca[o + 2]);
    }
    p = [m.lfC[0] + dx * f * m.lfN, m.lfC[1] + dy * f * m.lfN];
  }
  if (ch !== 1) {
    const s = ch === 0 ? m.ca[0] : m.ca[1];
    p = [m.center[0] + (p[0] - m.center[0]) * s, m.center[1] + (p[1] - m.center[1]) * s];
  }
  return p;
}
