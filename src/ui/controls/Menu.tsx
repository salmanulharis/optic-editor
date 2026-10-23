/**
 * Small popover menu: a button that opens a list of actions. Keyboard: Enter / Space opens, arrow
 * keys move, Escape closes; closes on outside click.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect?(): void;
  disabled?: boolean;
  hint?: string;
  /** Section heading (not selectable). */
  heading?: boolean;
}

export function Menu(props: { label: ReactNode; items: MenuItem[]; title?: string; className?: string; align?: 'left' | 'right'; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close, true);
    listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  };
  return (
    <div ref={ref} className="relative inline-block" onKeyDown={onKey}>
      <button
        type="button"
        title={props.title}
        aria-label={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={props.className ?? 'rounded border border-line bg-raise px-2 py-1 text-xs text-ink hover:bg-hover'}
        onClick={() => setOpen(!open)}
      >
        {props.label}
      </button>
      {open && (
        <div ref={listRef} role="menu"
          className={`absolute z-50 mt-1 max-h-[60vh] min-w-[180px] overflow-y-auto rounded border border-line bg-raise py-1 shadow-xl ${props.align === 'right' ? 'right-0' : 'left-0'}`}>
          {props.items.map((it, i) => it.heading ? (
            <div key={i} className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wider text-ink-faint">{it.label}</div>
          ) : (
            <button key={i} role="menuitem" type="button" disabled={it.disabled} title={it.hint}
              className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-active focus:bg-active focus:outline-none disabled:opacity-40"
              onClick={() => { setOpen(false); it.onSelect?.(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
