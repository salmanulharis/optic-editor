/**
 * Tolerant reader for the Camera Raw settings (`crs:` namespace) in an XMP packet: Lightroom /
 * Camera Raw presets, photo sidecars and the XMP embedded in DNG files.
 *
 * No DOM: a small tokenizer that runs in workers and Node tests and never resolves entities or
 * external references. Only the top-level rdf:Description of the packet is read:
 *  - simple properties, as attributes (crs:Exposure2012="+0.50") or elements (<crs:X>v</crs:X>);
 *  - rdf:Seq / rdf:Bag lists (tone curves) as string arrays;
 *  - rdf:Alt language alternatives (Name, Group) as the x-default (or first) value;
 *  - structs (crs:Look, masks, …) are recorded as present, with the nested struct's own `crs:`
 *    attributes as "Prop.Attr" (for example "Look.Name").
 */

export type CrsValue = string | string[];
export type CrsMap = Map<string, CrsValue>;

export const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** Value stored for a struct-valued property (masks, Look, …). */
export const STRUCT = '[struct]';

const MAX_TOKENS = 400_000;

/** Decode file bytes as text, honouring UTF-8 / UTF-16 byte order marks (and BOM-less UTF-16). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] !== 0) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x3c) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

interface Tag {
  kind: 'open' | 'close' | 'text';
  name: string;
  attrs: Array<[string, string]>;
  selfClosing: boolean;
  text: string;
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s>/!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function* tokens(text: string): Generator<Tag> {
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = TOKEN.exec(text))) {
    if (++n > MAX_TOKENS) throw new Error('XMP is too complex');
    if (m[1] !== undefined) yield { kind: 'text', name: '', attrs: [], selfClosing: false, text: m[1] };
    else if (m[2] !== undefined) yield { kind: 'close', name: m[2], attrs: [], selfClosing: false, text: '' };
    else if (m[3] !== undefined) {
      const attrs: Array<[string, string]> = [];
      ATTR.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(m[4] ?? ''))) attrs.push([a[1], decodeEntities(a[2] ?? a[3] ?? '')]);
      yield { kind: 'open', name: m[3], attrs, selfClosing: m[5] === '/', text: '' };
    } else if (m[6] !== undefined) yield { kind: 'text', name: '', attrs: [], selfClosing: false, text: decodeEntities(m[6]) };
  }
}

const split = (qname: string): [string, string] => {
  const i = qname.indexOf(':');
  return i < 0 ? ['', qname] : [qname.slice(0, i), qname.slice(i + 1)];
};

interface Frame {
  name: string;
  /** Namespace prefixes declared on this element. */
  ns: Map<string, string>;
  role: 'other' | 'rdf' | 'topDesc' | 'prop' | 'container' | 'li' | 'structDesc';
  /** For 'prop' frames: the property name and collected value. */
  prop?: { key: string; text: string; items: string[]; alt: Array<[string, string]>; struct: boolean };
  lang?: string;
}

/** Locate the XMP packet (<x:xmpmeta> … or a bare <rdf:RDF>) in text that may contain other data. */
export function findXmpPacket(text: string): string | null {
  const start = text.search(/<x:xmpmeta[\s>]|<rdf:RDF[\s>]/);
  if (start < 0) return null;
  const endTag = text.indexOf('</x:xmpmeta>', start);
  const end = endTag >= 0 ? endTag + 12 : text.indexOf('</rdf:RDF>', start);
  return end < 0 ? text.slice(start) : text.slice(start, end + (endTag >= 0 ? 0 : 10));
}

/**
 * Read the top-level Camera Raw settings of an XMP packet. Keys are the local names without the
 * prefix (e.g. "Exposure2012"). Returns an empty map when the packet has no crs: settings.
 */
export function readXmpCrs(text: string): CrsMap {
  const out: CrsMap = new Map();
  const stack: Frame[] = [];
  const resolve = (prefix: string): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const u = stack[i].ns.get(prefix);
      if (u !== undefined) return u;
    }
    // Undeclared but conventional prefixes (some hand-made presets omit xmlns declarations).
    if (prefix === 'crs') return CRS_NS;
    if (prefix === 'rdf') return RDF_NS;
    return undefined;
  };
  const isRdf = (q: string, local: string) => {
    const [p, l] = split(q);
    return l === local && resolve(p) === RDF_NS;
  };
  const isCrs = (q: string) => resolve(split(q)[0]) === CRS_NS;

  for (const t of tokens(text)) {
    const top = stack[stack.length - 1];
    if (t.kind === 'text') {
      if (top?.role === 'prop' && top.prop) top.prop.text += t.text;
      else if (top?.role === 'li') {
        const owner = stack[stack.length - 3];
        if (owner?.role === 'prop' && owner.prop) {
          const container = stack[stack.length - 2];
          if (split(container.name)[1] === 'Alt') {
            const last = owner.prop.alt[owner.prop.alt.length - 1];
            if (last) last[1] += t.text;
          } else {
            owner.prop.items[owner.prop.items.length - 1] += t.text;
          }
        }
      }
      continue;
    }
    if (t.kind === 'close') {
      // Pop to the matching element (tolerates unbalanced input).
      let i = stack.length - 1;
      while (i >= 0 && stack[i].name !== t.name) i--;
      if (i < 0) continue;
      while (stack.length > i) finish(stack.pop()!, out);
      continue;
    }
    // Open tag.
    const ns = new Map<string, string>();
    for (const [k, v] of t.attrs) {
      if (k === 'xmlns') ns.set('', v);
      else if (k.startsWith('xmlns:')) ns.set(k.slice(6), v);
    }
    const frame: Frame = { name: t.name, ns, role: 'other' };
    stack.push(frame);
    const parent = stack[stack.length - 2];
    if (isRdf(t.name, 'RDF')) frame.role = 'rdf';
    else if (isRdf(t.name, 'Description') && parent?.role === 'rdf') {
      frame.role = 'topDesc';
      for (const [k, v] of t.attrs) if (!k.startsWith('xmlns') && isCrs(k)) out.set(split(k)[1], v.trim());
    } else if (parent?.role === 'topDesc' && isCrs(t.name)) {
      frame.role = 'prop';
      frame.prop = { key: split(t.name)[1], text: '', items: [], alt: [], struct: false };
      if (t.attrs.some(([k, v]) => k === 'rdf:parseType' && v === 'Resource')) frame.prop.struct = true;
      // Attributes on a property element (rdf:parseType="Resource" shorthand).
      for (const [k, v] of t.attrs) if (!k.startsWith('xmlns') && isCrs(k)) out.set(`${frame.prop.key}.${split(k)[1]}`, v.trim());
    } else if (parent?.role === 'prop' && (isRdf(t.name, 'Seq') || isRdf(t.name, 'Bag') || isRdf(t.name, 'Alt'))) {
      frame.role = 'container';
    } else if (parent?.role === 'container' && isRdf(t.name, 'li')) {
      frame.role = 'li';
      const owner = stack[stack.length - 3];
      if (owner?.prop) {
        if (split(parent.name)[1] === 'Alt') {
          const lang = t.attrs.find(([k]) => k === 'xml:lang')?.[1] ?? '';
          owner.prop.alt.push([lang, '']);
        } else owner.prop.items.push('');
        // A list item that holds a struct (masks, retouch areas).
        if (t.attrs.some(([k, v]) => k === 'rdf:parseType' && v === 'Resource')) owner.prop.struct = true;
      }
    } else if (parent?.role === 'prop' && isRdf(t.name, 'Description')) {
      frame.role = 'structDesc';
      parent.prop!.struct = true;
      for (const [k, v] of t.attrs) if (!k.startsWith('xmlns') && isCrs(k)) out.set(`${parent.prop!.key}.${split(k)[1]}`, v.trim());
    } else {
      // Anything deeper inside a property makes it a struct (nested descriptions, list-of-structs).
      for (let i = stack.length - 2; i >= 0; i--) {
        if (stack[i].role === 'prop') { stack[i].prop!.struct = true; break; }
        if (stack[i].role === 'topDesc') break;
      }
    }
    if (t.selfClosing) finish(stack.pop()!, out);
  }
  while (stack.length) finish(stack.pop()!, out);
  return out;
}

function finish(f: Frame, out: CrsMap) {
  if (f.role !== 'prop' || !f.prop) return;
  const p = f.prop;
  if (p.alt.length) {
    const pick = p.alt.find(([l]) => l === 'x-default') ?? p.alt[0];
    out.set(p.key, pick[1].trim());
  } else if (p.struct) {
    out.set(p.key, p.items.length ? p.items.map((s) => s.trim()) : STRUCT);
  } else if (p.items.length) out.set(p.key, p.items.map((s) => s.trim()));
  else out.set(p.key, p.text.trim());
}
