/**
 * Reader for Lightroom Classic's legacy `.lrtemplate` presets (Lightroom 7.2 and older): a Lua
 * table literal such as
 *
 *   s = { id = "…", title = ZSTR "$$$/…=Moody", type = "Develop",
 *         value = { settings = { Exposure2012 = 0.5, ToneCurvePV2012 = { 0, 0, 255, 255 } } } }
 *
 * Parsed with a tokenizer + recursive descent over the literal subset only (never evaluated).
 * The settings are returned in the same shape as the XMP reader's map, so one converter serves both.
 */
import type { CrsMap } from './xmp';

type LuaValue = string | number | boolean | null | LuaTable;
interface LuaTable { list: LuaValue[]; map: Map<string, LuaValue> }

const MAX_DEPTH = 32;
const MAX_ITEMS = 200_000;

export class LuaParseError extends Error {}

type Tok =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'sym'; v: string }
  | { t: 'eof' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (out.length > MAX_ITEMS) throw new LuaParseError('File is too complex');
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      // Comment: --[[ … ]] or to end of line.
      const long = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
      if (long) {
        const end = src.indexOf(`]${long[1]}]`, i + long[0].length);
        i = end < 0 ? n : end + long[1].length + 2;
      } else {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl + 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
          if (/\d/.test(e)) {
            const d = /^\d{1,3}/.exec(src.slice(i + 1, i + 4))![0];
            s += String.fromCharCode(Number(d));
            i += 1 + d.length;
            continue;
          }
          s += map[e] ?? e;
          i += 2;
          continue;
        }
        s += src[i++];
      }
      if (i >= n) throw new LuaParseError('Unterminated string');
      i++;
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c === '[' && /^\[=*\[/.test(src.slice(i, i + 64))) {
      const open = /^\[(=*)\[/.exec(src.slice(i, i + 64))!;
      const close = `]${open[1]}]`;
      const end = src.indexOf(close, i + open[0].length);
      if (end < 0) throw new LuaParseError('Unterminated long string');
      out.push({ t: 'str', v: src.slice(i + open[0].length, end).replace(/^\r?\n/, '') });
      i = end + close.length;
      continue;
    }
    const num = /^(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i.exec(src.slice(i, i + 64));
    if (num && /[\d.]/.test(c)) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 256));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    if ('{}[]=,;-+'.includes(c)) {
      out.push({ t: 'sym', v: c });
      i++;
      continue;
    }
    throw new LuaParseError(`Unexpected character "${c}"`);
  }
  out.push({ t: 'eof' });
  return out;
}

class Parser {
  private p = 0;
  constructor(private readonly toks: Tok[]) {}
  private peek(k = 0) { return this.toks[Math.min(this.p + k, this.toks.length - 1)]; }
  private next() { return this.toks[this.p++] ?? { t: 'eof' }; }
  private isSym(v: string, k = 0) { const t = this.peek(k); return t.t === 'sym' && t.v === v; }
  private expect(v: string) {
    if (!this.isSym(v)) throw new LuaParseError(`Expected "${v}"`);
    this.p++;
  }

  /** `name = value` at the top level (Lightroom writes `s = { … }`), or a bare `return { … }`. */
  document(): LuaValue {
    let t = this.peek();
    if (t.t === 'id' && t.v === 'return') { this.p++; return this.value(0); }
    if (t.t === 'id' && t.v === 'local') { this.p++; t = this.peek(); }
    if (t.t === 'id' && this.isSym('=', 1)) { this.p += 2; return this.value(0); }
    return this.value(0);
  }

  value(depth: number): LuaValue {
    if (depth > MAX_DEPTH) throw new LuaParseError('Nesting is too deep');
    const t = this.next();
    switch (t.t) {
      case 'str': return t.v;
      case 'num': return t.v;
      case 'sym':
        if (t.v === '{') return this.table(depth + 1);
        if (t.v === '-' || t.v === '+') {
          const n = this.next();
          if (n.t !== 'num') throw new LuaParseError('Expected a number');
          return t.v === '-' ? -n.v : n.v;
        }
        throw new LuaParseError(`Unexpected "${t.v}"`);
      case 'id':
        if (t.v === 'true') return true;
        if (t.v === 'false') return false;
        if (t.v === 'nil') return null;
        // Function-call sugar Lightroom uses for localised strings: ZSTR "…", LOC "…".
        {
          const s = this.peek();
          if (s.t === 'str') { this.p++; return s.v; }
        }
        throw new LuaParseError(`Unsupported expression "${t.v}"`);
      default:
        throw new LuaParseError('Unexpected end of file');
    }
  }

  table(depth: number): LuaTable {
    const tbl: LuaTable = { list: [], map: new Map() };
    let count = 0;
    while (!this.isSym('}')) {
      if (++count > MAX_ITEMS) throw new LuaParseError('Table is too large');
      const t = this.peek();
      if (t.t === 'eof') throw new LuaParseError('Unterminated table');
      if (t.t === 'id' && this.isSym('=', 1)) {
        this.p += 2;
        tbl.map.set(t.v, this.value(depth));
      } else if (this.isSym('[')) {
        this.p++;
        const k = this.value(depth);
        this.expect(']');
        this.expect('=');
        const v = this.value(depth);
        if (typeof k === 'string') tbl.map.set(k, v);
        else if (typeof k === 'number') tbl.map.set(String(k), v);
      } else tbl.list.push(this.value(depth));
      if (this.isSym(',') || this.isSym(';')) this.p++;
      else if (!this.isSym('}')) throw new LuaParseError('Expected "," or "}"');
    }
    this.p++;
    return tbl;
  }
}

const isTable = (v: LuaValue | undefined): v is LuaTable => !!v && typeof v === 'object';

export interface LrTemplate {
  title: string | null;
  type: string | null;
  uuid: string | null;
  settings: CrsMap;
}

/** Strip Lightroom's localisation wrapper: "$$$/AgCameraRawNamedSettings/Foo=Moody" → "Moody". */
export function stripZstr(s: string): string {
  const m = /^\$\$\$\/[^=]*=(.*)$/s.exec(s);
  return (m ? m[1] : s).trim();
}

/** Parse an .lrtemplate file. Throws LuaParseError when the text is not a readable Lua table. */
export function readLrTemplate(text: string): LrTemplate {
  const root = new Parser(tokenize(text.replace(/^﻿/, ''))).document();
  if (!isTable(root)) throw new LuaParseError('Not a Lightroom template');
  const str = (t: LuaTable, k: string) => {
    const v = t.map.get(k);
    return typeof v === 'string' ? v : null;
  };
  const value = root.map.get('value');
  const settingsTbl = isTable(value) ? value.map.get('settings') : undefined;
  const settings: CrsMap = new Map();
  if (isTable(settingsTbl)) {
    for (const [k, v] of settingsTbl.map) {
      if (typeof v === 'number') settings.set(k, String(v));
      else if (typeof v === 'boolean') settings.set(k, v ? 'True' : 'False');
      else if (typeof v === 'string') settings.set(k, v);
      else if (isTable(v)) {
        if (/^ToneCurve/.test(k) && v.list.every((x) => typeof x === 'number')) {
          // Flat {x0, y0, x1, y1, …} → the XMP form "x, y".
          const pts: string[] = [];
          for (let i = 0; i + 1 < v.list.length; i += 2) pts.push(`${v.list[i]}, ${v.list[i + 1]}`);
          settings.set(k, pts);
        } else if (v.list.length || v.map.size) {
          settings.set(k, v.list.length ? v.list.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '[struct]')) : '[struct]');
        }
      }
    }
  }
  const title = str(root, 'title') ?? str(root, 'internalName');
  return {
    title: title ? stripZstr(title) : null,
    type: str(root, 'type'),
    uuid: (isTable(value) ? str(value, 'uuid') : null) ?? str(root, 'id'),
    settings,
  };
}
