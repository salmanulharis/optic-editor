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

/** iOS / iPadOS (WebKit everywhere): tighter GPU and memory budgets. */
export const isIOS = () =>
  typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1));
