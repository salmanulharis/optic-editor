/**
 * Accessible tooltip (WCAG 1.4.13): shown on hover after a short delay, on keyboard focus, and on
 * touch after a long press (which then swallows that tap, so a long press explains a control
 * instead of using it). It stays open while the pointer is over it and closes with Escape.
 *
 * The text is not linked with aria-describedby: tooltips here repeat the control's accessible name
 * (plus its shortcut, exposed as aria-keyshortcuts by IconButton), so linking would read it twice.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const HOVER_DELAY = 400;
const LONG_PRESS = 500;

export function Tooltip({ label, shortcut, children, className = '' }: { label: string; shortcut?: string; children: ReactNode; className?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef(0);
  const closeTimer = useRef(0);
  const swallowClick = useRef(false);

  const clear = () => { window.clearTimeout(timer.current); window.clearTimeout(closeTimer.current); };
  const show = (delay: number) => { clear(); timer.current = window.setTimeout(() => setOpen(true), delay); };
  const hide = (delay = 0) => { clear(); closeTimer.current = window.setTimeout(() => setOpen(false), delay); };

  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); } };
    const onScroll = () => setOpen(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);

  // Place below the control (above when there is no room), clamped to the viewport.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) { setPos(null); return; }
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const below = a.bottom + 6 + t.height <= window.innerHeight - 4;
    const y = below ? a.bottom + 6 : a.top - 6 - t.height;
    const x = Math.min(Math.max(4, a.left + a.width / 2 - t.width / 2), window.innerWidth - t.width - 4);
    setPos({ x, y });
  }, [open, label, shortcut]);

  return (
    <span
      ref={anchor}
      className={`inline-flex ${className}`}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') show(HOVER_DELAY); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') hide(120); }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse') { hide(); return; }
        swallowClick.current = false;
        clear();
        timer.current = window.setTimeout(() => { swallowClick.current = true; setOpen(true); }, LONG_PRESS);
      }}
      onPointerUp={(e) => { if (e.pointerType !== 'mouse') { window.clearTimeout(timer.current); if (swallowClick.current) hide(1500); } }}
      onPointerCancel={() => { window.clearTimeout(timer.current); }}
      onClickCapture={(e) => { if (swallowClick.current) { swallowClick.current = false; e.preventDefault(); e.stopPropagation(); } }}
      onContextMenu={(e) => { if (swallowClick.current) e.preventDefault(); }}
      onFocus={(e) => { if ((e.target as HTMLElement).matches?.(':focus-visible')) show(0); }}
      onBlur={() => hide()}
    >
      {children}
      {open && createPortal(
        <div
          ref={tip}
          role="tooltip"
          className="pointer-events-auto fixed z-[60] max-w-[260px] rounded border border-line bg-raise px-2 py-1 text-2xs text-ink shadow-lg"
          style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
          onPointerEnter={() => window.clearTimeout(closeTimer.current)}
          onPointerLeave={() => hide(120)}
        >
          {label}
          {shortcut && <kbd className="ms-2 rounded border border-line px-1 font-sans text-2xs text-ink-dim">{shortcut}</kbd>}
        </div>,
        document.body,
      )}
    </span>
  );
}
