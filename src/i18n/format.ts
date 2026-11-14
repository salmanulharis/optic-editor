/**
 * Plurals and locale formatting on top of t():
 *  - tp('import.photos', n, vars) picks 'import.photos.one' / '.other' (or any CLDR category the
 *    language has: zero, two, few, many) with Intl.PluralRules, and passes {n} to the message;
 *  - formatNumber / formatDate follow the chosen language.
 */
import { useSettings } from '../state/settingsStore';
import { MESSAGES, t } from './index';

const lang = () => useSettings.getState().language || 'en';
const rules = new Map<string, Intl.PluralRules>();

/** Plural message: `${key}.${category}`, falling back to `${key}.other`. */
export function tp(key: string, n: number, vars: Record<string, string | number> = {}): string {
  const l = lang();
  let r = rules.get(l);
  if (!r) { r = new Intl.PluralRules(l); rules.set(l, r); }
  const cat = r.select(n);
  const dict = MESSAGES[l] ?? MESSAGES.en;
  const k = dict[`${key}.${cat}`] !== undefined || MESSAGES.en[`${key}.${cat}`] !== undefined ? `${key}.${cat}` : `${key}.other`;
  return t(k, { n: formatNumber(n), ...vars });
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  try { return new Intl.NumberFormat(lang(), opts).format(n); } catch { return String(n); }
}

export function formatDate(d: Date | number, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  try { return new Intl.DateTimeFormat(lang(), opts).format(d); } catch { return new Date(d).toLocaleString(); }
}
