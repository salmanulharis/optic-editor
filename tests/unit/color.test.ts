import { describe, expect, it } from 'vitest';
import { gamutMap, workingToOklch } from '../../src/color/gamut';
import {
  COLOR_SPACES, D50_XYZ, D65_XY, D65_XYZ, IDENTITY, bradford, inv, isIdentity, mul, mulVec, rgbToXYZ, toXYZ_D65, workingTo,
} from '../../src/color/matrices';
import { oklabToWorking, workingToOklab } from '../../src/color/oklab';
import { linearToSrgb, srgbToLinear } from '../../src/color/transfer';
import {
  displayWbMatrix, relativeToTempTint, tempTintToRelative, tempTintToXY, xyToTempTint,
} from '../../src/color/whiteBalance';

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < eps);

describe('matrices', () => {
  it('inverts', () => {
    const m = toXYZ_D65('display-p3');
    expect(isIdentity(mul(m, inv(m)), 1e-9)).toBe(true);
  });

  it('builds the sRGB → XYZ matrix from primaries', () => {
    const m = rgbToXYZ(COLOR_SPACES.srgb.primaries as never, D65_XY);
    // IEC 61966-2-1 (4 decimals)
    expect(close(m, [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505], 2e-4)).toBe(true);
  });

  it('maps white to white in every space', () => {
    for (const id of Object.keys(COLOR_SPACES) as Array<keyof typeof COLOR_SPACES>) {
      const w = mulVec(workingTo(id), [1, 1, 1]);
      // ProPhoto's D50 white goes through rounded Bradford constants: within 5e-4.
      expect(close(w, [1, 1, 1], 5e-4)).toBe(true);
    }
  });

  it('Bradford adaptation is the identity for the same white and maps D50 → D65', () => {
    expect(isIdentity(bradford(D65_XYZ, D65_XYZ), 1e-9)).toBe(true);
    expect(close(mulVec(bradford(D50_XYZ, D65_XYZ), D50_XYZ), D65_XYZ, 1e-6)).toBe(true);
  });
});

describe('transfer and OKLab', () => {
  it('sRGB transfer round-trips', () => {
    for (const v of [0, 0.002, 0.04, 0.2, 0.5, 0.99, 1]) expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 9);
  });

  it('OKLab round-trips and white has L = 1, no chroma', () => {
    const lab = workingToOklab([1, 1, 1]);
    expect(lab[0]).toBeCloseTo(1, 4);
    expect(Math.hypot(lab[1], lab[2])).toBeLessThan(1e-4);
    for (const c of [[0.2, 0.5, 0.1], [0.9, 0.05, 0.3], [0.01, 0.01, 0.02]] as Array<[number, number, number]>) {
      expect(close(oklabToWorking(workingToOklab(c)), c, 1e-6)).toBe(true);
    }
  });
});

describe('white balance', () => {
  it('temperature / tint ↔ chromaticity round-trips', () => {
    for (const [T, tint] of [[2850, 0], [5000, 10], [6504, 0], [9000, -20]]) {
      const tt = xyToTempTint(tempTintToXY(T, tint));
      expect(tt.temperature).toBeCloseTo(T, -1);
      expect(tt.tint).toBeCloseTo(tint, 0);
    }
  });

  it('relative (non-RAW) WB converts to Kelvin and back', () => {
    for (const [t, g] of [[0, 0], [-60, 10], [40, -25], [-100, 0], [100, 50]]) {
      const k = relativeToTempTint(t, g);
      const r = tempTintToRelative(k.temperature, k.tint);
      expect(r.temperature).toBeCloseTo(t, 6);
      expect(r.tint).toBeCloseTo(g, 6);
    }
  });

  it('relative WB at (0, 0) is exactly the identity', () => {
    expect(displayWbMatrix(toXYZ_D65('srgb'), 0, 0)).toEqual([...IDENTITY]);
  });

  it('a warmer assumed illuminant cools the image (negative temperature)', () => {
    const m = displayWbMatrix(toXYZ_D65('srgb'), -50, 0);
    const out = mulVec(m, [1, 1, 1]);
    expect(out[2]).toBeGreaterThan(out[0]);
  });
});

describe('gamut compression', () => {
  const toSrgb = workingTo('srgb');

  it('leaves colours well inside the gamut unchanged', () => {
    for (const c of [[0.2, 0.2, 0.2], [0.3, 0.2, 0.1], [0.05, 0.1, 0.08]] as Array<[number, number, number]>) {
      expect(close(gamutMap(c, toSrgb), mulVec(toSrgb, c), 1e-9)).toBe(true);
    }
  });

  it('brings out-of-gamut colours inside, keeping hue and lightness', () => {
    // Saturated Rec.2020 primaries are far outside sRGB.
    for (const c of [[0.6, 0.02, 0.02], [0.02, 0.5, 0.03], [0.03, 0.03, 0.7], [0.4, 0.45, 0.01]] as Array<[number, number, number]>) {
      const naive = mulVec(toSrgb, c);
      expect(Math.min(...naive)).toBeLessThan(0);
      const out = gamutMap(c, toSrgb);
      expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
      const back = mulVec(inv(toSrgb), out);
      const a = workingToOklch(c), b = workingToOklch(back);
      expect(b[0]).toBeCloseTo(a[0], 2); // lightness
      expect(Math.abs(Math.atan2(Math.sin(b[2] - a[2]), Math.cos(b[2] - a[2])))).toBeLessThan(0.02); // hue
      expect(b[1]).toBeLessThan(a[1]); // chroma reduced
    }
  });

  it('is monotone: more saturated input never gives less saturated output', () => {
    const base: [number, number, number] = [0.2, 0.18, 0.15];
    let prev = 0;
    for (let k = 0; k <= 3; k += 0.25) {
      const lab = workingToOklab(base);
      const w = oklabToWorking([lab[0], 0.02 + lab[1] * k + 0.12 * k, lab[2]]);
      const out = gamutMap(w, toSrgb);
      const C = workingToOklch(mulVec(inv(toSrgb), out))[1];
      // Within the boundary search's precision (10 bisection steps).
      expect(C).toBeGreaterThanOrEqual(prev * 0.99);
      prev = C;
    }
  });
});
