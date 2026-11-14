/**
 * Guard rails for the interface code (static checks over src/): rules that keep the UI accessible
 * and consistent. Each failure names the file and line to fix.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const ALL = files(SRC);
const UI = ALL.filter((f) => f.endsWith('.tsx'));

/** Lines of `list` matching `re`, as "file:line: text" (minus allowed files). */
function offenders(list: string[], re: RegExp, allow: (file: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const f of list) {
    const rel = relative(process.cwd(), f).replace(/\\/g, '/');
    if (allow(rel)) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line) && !/^\s*(\/\/|\*)/.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return out;
}

describe('UI rules', () => {
  it('uses in-app dialogs, never window.alert / confirm / prompt (they block and ignore the theme)', () => {
    expect(offenders(ALL, /(^|[^\w.])(window\.)?(alert|confirm|prompt)\(/)).toEqual([]);
  });
});

describe('text size', () => {
  it('never sets interface text below 11 px (use text-2xs, the smallest size token)', () => {
    expect(offenders(UI, /text-\[(?:[0-9]|10)(?:\.\d+)?px\]|\btext-xxs\b/)).toEqual([]);
  });
});

describe('colours', () => {
  it('styles interface colours with theme tokens, not hard-coded hex (canvas overlays drawn on the photo are exempt)', () => {
    expect(offenders(UI, /\b[\w:-]+-\[#[0-9a-fA-F]{3,8}\]/, (f) => f.startsWith('src/ui/canvas/'))).toEqual([]);
  });
});
