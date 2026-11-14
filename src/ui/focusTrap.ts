/**
 * Focus handling for modal dialogs: moves focus into the dialog when it opens (an `autoFocus`
 * element wins, else the first focusable control), keeps Tab / Shift+Tab inside it, and returns
 * focus to the element that was focused before it opened when it closes.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  // The opener is read during render: React applies `autoFocus` before effects run, so by the
  // time the effect below runs, focus is already inside the dialog.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const prev = opener.current;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (prev?.isConnected && prev !== document.body) prev.focus();
    };
  }, [open, ref]);
}
