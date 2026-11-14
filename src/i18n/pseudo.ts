/**
 * Test languages for development builds only (never shipped):
 *  - en-XA "long": accented and ~40 % longer, in brackets: untranslated text stays plain English,
 *    truncated text loses its closing bracket;
 *  - ar-XB "right to left": the layout mirrors (dir="rtl") so physical left / right mistakes show.
 * Placeholders ({name}) are kept intact.
 */
import type { Messages } from './index';

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

function accent(s: string): string {
  // Leave {placeholders} untouched.
  return s.split(/(\{\w+\})/).map((part) => (/^\{\w+\}$/.test(part) ? part : part.replace(/[A-Za-z]/g, (c) => ACCENTS[c] ?? c))).join('');
}

export function pseudoLong(en: Messages): Messages {
  const out: Messages = {};
  for (const [k, v] of Object.entries(en)) {
    const pad = '·'.repeat(Math.max(1, Math.round(v.replace(/\{\w+\}/g, '').length * 0.4)));
    out[k] = `[${accent(v)} ${pad}]`;
  }
  return out;
}

export function pseudoRtl(en: Messages): Messages {
  const out: Messages = {};
  for (const [k, v] of Object.entries(en)) out[k] = `‏${v}‏`;
  return out;
}
