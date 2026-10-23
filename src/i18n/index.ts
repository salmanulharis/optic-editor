/**
 * Translation structure (English first). Strings are looked up by key with {name} placeholders;
 * a missing key falls back to English, then to the key itself. Add a language by adding a
 * dictionary to MESSAGES and an entry in LANGUAGES (Settings shows them).
 */
import { useSettings } from '../state/settingsStore';
import en from './en';

export type Messages = Record<string, string>;

export const MESSAGES: Record<string, Messages> = { en };
export const LANGUAGES: Array<{ id: string; label: string }> = [{ id: 'en', label: 'English' }];

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
