/**
 * Translation structure (English first). Strings are looked up by key with {name} placeholders;
 * a missing key falls back to English, then to the key itself. Add a language by adding a
 * dictionary to MESSAGES and an entry in LANGUAGES (Settings shows them).
 */
import { useSettings } from '../state/settingsStore';
import en from './en';
import { pseudoLong, pseudoRtl } from './pseudo';

export type Messages = Record<string, string>;

export const MESSAGES: Record<string, Messages> = { en };
/** Languages offered in Settings, with their reading direction (applied to <html dir>). */
export const LANGUAGES: Array<{ id: string; label: string; dir: 'ltr' | 'rtl' }> = [{ id: 'en', label: 'English', dir: 'ltr' }];

// Development builds only: test languages for text expansion and right-to-left layout.
if (import.meta.env.DEV) {
  MESSAGES['en-XA'] = pseudoLong(en);
  MESSAGES['ar-XB'] = pseudoRtl(en);
  LANGUAGES.push({ id: 'en-XA', label: 'Pseudo: long text (dev)', dir: 'ltr' }, { id: 'ar-XB', label: 'Pseudo: right to left (dev)', dir: 'rtl' });
}

export const dirOf = (lang: string): 'ltr' | 'rtl' => LANGUAGES.find((l) => l.id === lang)?.dir ?? 'ltr';

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const lang = useSettings.getState().language;
  const s = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

/** `t` that re-renders the component when the language changes. */
export function useT() {
  useSettings((s) => s.language);
  return t;
}
