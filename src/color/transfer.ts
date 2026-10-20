/** Transfer functions (encoding ↔ linear light), CPU side. GLSL versions live in stage 90. */
import { COLOR_SPACES, type ColorSpaceId } from './matrices';

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Decoding function for a known colour space. */
export function decoderFor(id: ColorSpaceId): (v: number) => number {
  const cs = COLOR_SPACES[id];
  if (cs.transfer === 'srgb') return srgbToLinear;
  if (cs.transfer === 'gamma') {
    const g = cs.gamma!;
    return (v) => Math.pow(Math.max(v, 0), g);
  }
  return (v) => v;
}

/**
 * Parametric curve as defined by ICC 'para' (function types 0–4):
 * Y = (aX+b)^g + e for X ≥ d, else cX + f. Covers sRGB, gamma and BT.709 style curves.
 */
export interface ParametricCurve {
  g: number; a: number; b: number; c: number; d: number; e: number; f: number;
}

export function evalParametric(p: ParametricCurve, x: number): number {
  return x >= p.d ? Math.pow(Math.max(p.a * x + p.b, 0), p.g) + p.e : p.c * x + p.f;
}

/** A per-channel linearisation curve, either parametric or sampled (ICC 'curv'). */
export type ToneCurve =
  | { kind: 'parametric'; p: ParametricCurve }
  | { kind: 'sampled'; table: Float32Array };

export function evalCurve(c: ToneCurve, x: number): number {
  if (c.kind === 'parametric') return evalParametric(c.p, x);
  const t = c.table;
  const pos = Math.min(Math.max(x, 0), 1) * (t.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i >= t.length - 1 ? t[t.length - 1] : t[i] * (1 - f) + t[i + 1] * f;
}

export const SRGB_CURVE: ToneCurve = {
  kind: 'parametric',
  p: { g: 2.4, a: 1 / 1.055, b: 0.055 / 1.055, c: 1 / 12.92, d: 0.04045, e: 0, f: 0 },
};

export function gammaCurve(g: number): ToneCurve {
  return { kind: 'parametric', p: { g, a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } };
}

export function curveForSpace(id: ColorSpaceId): ToneCurve {
  const cs = COLOR_SPACES[id];
  if (cs.transfer === 'srgb') return SRGB_CURVE;
  if (cs.transfer === 'gamma') return gammaCurve(cs.gamma!);
  return gammaCurve(1);
}

/** Build a decoding LUT for integer code values 0…maxCode. */
export function buildDecodeLut(curve: ToneCurve, maxCode: number): Float32Array {
  const lut = new Float32Array(maxCode + 1);
  for (let i = 0; i <= maxCode; i++) lut[i] = evalCurve(curve, i / maxCode);
  return lut;
}
