/** Applies the appearance settings (theme, reduced motion, language) to the document. */
import { dirOf } from '../i18n';
import { useSettings } from '../state/settingsStore';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The theme actually shown: 'system' resolves to Dark or Light from the OS setting. */
function resolvedTheme(theme: string): string {
  if (theme !== 'system') return theme;
  return typeof window !== 'undefined' && window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

function apply() {
  const s = useSettings.getState();
  const root = document.documentElement;
  const theme = resolvedTheme(s.theme);
  if (theme === 'dark') delete root.dataset.theme; else root.dataset.theme = theme;
  if (s.reducedMotion === 'system') delete root.dataset.motion;
  else root.dataset.motion = s.reducedMotion === 'on' ? 'reduce' : 'full';
  root.lang = s.language;
  root.dir = dirOf(s.language);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--c-panel').trim().split(/\s+/).length === 3 ? `rgb(${getComputedStyle(root).getPropertyValue('--c-panel').trim().split(/\s+/).join(',')})` : '#1c1c1c');
}

export function initTheme() {
  apply();
  // Follow OS theme changes live while "Follow the system" is chosen.
  window.matchMedia(LIGHT_QUERY).addEventListener('change', () => { if (useSettings.getState().theme === 'system') apply(); });
  useSettings.subscribe((s, p) => { if (s.theme !== p.theme || s.reducedMotion !== p.reducedMotion || s.language !== p.language) apply(); });
}
