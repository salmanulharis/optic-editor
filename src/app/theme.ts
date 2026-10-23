/** Applies the appearance settings (theme, reduced motion, language) to the document. */
import { useSettings } from '../state/settingsStore';

function apply() {
  const s = useSettings.getState();
  const root = document.documentElement;
  if (s.theme === 'dark') delete root.dataset.theme; else root.dataset.theme = s.theme;
  if (s.reducedMotion === 'system') delete root.dataset.motion;
  else root.dataset.motion = s.reducedMotion === 'on' ? 'reduce' : 'full';
  root.lang = s.language;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--c-panel').trim().split(/\s+/).length === 3 ? `rgb(${getComputedStyle(root).getPropertyValue('--c-panel').trim().split(/\s+/).join(',')})` : '#1c1c1c');
}

export function initTheme() {
  apply();
  useSettings.subscribe((s, p) => { if (s.theme !== p.theme || s.reducedMotion !== p.reducedMotion || s.language !== p.language) apply(); });
}
