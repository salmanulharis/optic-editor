/**
 * Slide-over panel from the start edge, inside its positioned parent (the editor row): used for
 * Presets / History when the desktop layout is narrower than 1024 px. Modal while open: focus moves
 * in and is trapped, Escape or the backdrop closes it, and focus returns to the opener.
 */
import { type ReactNode, useRef } from 'react';
import { useFocusTrap } from '../focusTrap';

export function Drawer({ id, title, onClose, children }: { id?: string; title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  return (
    <div className="absolute inset-0 z-40 flex" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/40" aria-hidden onPointerDown={onClose} />
      <div ref={ref} id={id} role="dialog" aria-modal="true" aria-label={title}
        className="relative flex w-72 max-w-[85%] flex-col border-e border-line bg-panel shadow-2xl"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        {children}
      </div>
    </div>
  );
}
