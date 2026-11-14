/**
 * Translation keys: every key the code uses exists in en.ts (plural keys need .one and .other),
 * and every key in en.ts is used. Keys built at run time (t(`lr.skip.${code}`)) count through
 * their prefix.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/en';

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !p.includes(`${join('src', 'i18n')}`)) out.push(p);
  }
  return out;
}

const code = files(join(process.cwd(), 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
const plain = new Set([...code.matchAll(/\b(?:t|tr)\(\s*'([^']+)'/g)].map((m) => m[1]));
const plural = new Set([...code.matchAll(/\btp\(\s*'([^']+)'/g)].map((m) => m[1]));
const dynamicPrefixes = [...code.matchAll(/\b(?:t|tr|tp)\(\s*`([\w.]+)\$\{/g)].map((m) => m[1]);
const keys = Object.keys(en);

describe('translations (en.ts)', () => {
  it('defines every key the code uses', () => {
    const missing = [...plain].filter((k) => !(k in en));
    for (const k of plural) for (const c of ['one', 'other']) if (!(`${k}.${c}` in en)) missing.push(`${k}.${c}`);
    expect(missing).toEqual([]);
  });

  it('has no unused keys', () => {
    const used = (k: string) => plain.has(k) || plural.has(k.replace(/\.(zero|one|two|few|many|other)$/, '')) || dynamicPrefixes.some((p) => k.startsWith(p));
    expect(keys.filter((k) => !used(k))).toEqual([]);
  });

  it('keeps placeholders balanced in every message', () => {
    expect(Object.entries(en).filter(([, v]) => (v.match(/\{/g) ?? []).length !== (v.match(/\}/g) ?? []).length && !/\{filename\}/.test(v)).map(([k]) => k)).toEqual([]);
  });
});
