/**
 * Modal dialog shell: backdrop, focus trap (focus moves in, stays in, returns to the opener),
 * Escape and backdrop click close it. `layer` raises dialogs that open on top of other dialogs
 * (the shared confirm / prompt / message dialogs).
 */
import { type ReactNode, useRef } from 'react';
import { useFocusTrap } from '../focusTrap';

export function Modal({ title, onClose, children, layer = 'z-40' }: { title: string; onClose(): void; children: ReactNode; layer?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  return (
    <div className={`fixed inset-0 ${layer} flex items-center justify-center bg-black/50 p-4`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <h2 className="mb-3 text-sm font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}
