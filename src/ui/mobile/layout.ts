/**
 * Layout selection: the touch-first layout below 900 px wide (phones, iPad split view) and on
 * phones in landscape (short and touch-only); the desktop layout otherwise, including an iPad with
 * a keyboard / trackpad at full width.
 */
import { useEffect, useState } from 'react';

const QUERY = '(max-width: 899px), (max-height: 520px) and (pointer: coarse)';

export function isMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

export function useMobileLayout(): boolean {
  const [m, setM] = useState(isMobileLayout);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return m;
}

/** Tracks a CSS media query (e.g. the desktop layout's breakpoints). */
export function useMediaQuery(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const f = () => setM(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return m;
}

/** Desktop layout widths: the Presets / History column shows from 1024 px, every top-bar control from 1280 px. */
export const WIDE_QUERY = '(min-width: 1024px)';
export const XL_QUERY = '(min-width: 1280px)';

/** iOS / iPadOS (WebKit everywhere): tighter GPU and memory budgets. */
export const isIOS = () =>
  typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1));
