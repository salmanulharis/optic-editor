/**
 * WCAG contrast of the theme tokens (src/index.css), in every theme: text pairs need 4.5:1
 * (1.4.3), meaningful non-text parts (slider thumbs, checkbox / range accents) 3:1 (1.4.11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');

function block(selector: string): Record<string, [number, number, number]> {
  const i = css.indexOf(`${selector} {`);
  const body = css.slice(i, css.indexOf('}', i));
  const out: Record<string, [number, number, number]> = {};
  for (const m of body.matchAll(/--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)/g)) out[m[1]] = [+m[2], +m[3], +m[4]];
  return out;
}

const base = block(':root');
const THEMES: Record<string, Record<string, [number, number, number]>> = {
  dark: base,
  darker: { ...base, ...block(":root[data-theme='darker']") },
  light: { ...base, ...block(":root[data-theme='light']") },
};

const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** [foreground, background, minimum] as used in the components. */
const TEXT: Array<[string, string]> = [
  ['ink', 'panel'], ['ink', 'raise'], ['ink', 'app'], ['ink', 'sunk'], ['ink', 'hover'], ['ink', 'active'],
  ['ink-dim', 'panel'], ['ink-dim', 'raise'], ['ink-dim', 'app'],
  ['ink-faint', 'panel'], ['ink-faint', 'raise'], ['ink-faint', 'app'], ['ink-faint', 'sunk'],
  ['strong', 'active'], ['on-accent', 'accent'],
  ['danger', 'panel'], ['danger', 'raise'], ['warn', 'panel'], ['success', 'panel'], ['info', 'info-bg'],
  ['ink', 'danger-bg'], ['ink', 'success-bg'], ['ink', 'info-bg'], ['on-accent', 'danger'],
];
/** Graphics that carry meaning: rating stars, checkbox / range accents. */
const NON_TEXT: Array<[string, string]> = [['star', 'panel'], ['star', 'raise'], ['control', 'panel'], ['thumb-edge', 'thumb']];

describe('theme contrast (WCAG 2.2 AA)', () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    it(`${theme}: text 4.5:1, controls 3:1`, () => {
      const fails: string[] = [];
      for (const [fg, bg] of TEXT) {
        const r = ratio(t[fg], t[bg]);
        if (r < 4.5) fails.push(`text ${fg} on ${bg}: ${r.toFixed(2)}`);
      }
      for (const [fg, bg] of NON_TEXT) {
        const r = ratio(t[fg], t[bg]);
        if (r < 3) fails.push(`control ${fg} on ${bg}: ${r.toFixed(2)}`);
      }
      // A slider thumb is seen by its fill or by its outline, whichever stands out from the panel.
      const thumb = Math.max(ratio(t.thumb, t.panel), ratio(t['thumb-edge'], t.panel));
      if (thumb < 3) fails.push(`slider thumb on panel: ${thumb.toFixed(2)}`);
      expect(fails).toEqual([]);
    });
  }
});
