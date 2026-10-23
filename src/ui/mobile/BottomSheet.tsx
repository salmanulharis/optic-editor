/**
 * Bottom sheet: half height (the photo stays visible above it) or full height. Drag the handle up
 * for full height, down to go back to half height or to dismiss; Escape closes it.
 */
import { type ReactNode, useRef, useState } from 'react';

export function BottomSheet({ title, open, onClose, children, actions }: { title: string; open: boolean; onClose(): void; children: ReactNode; actions?: ReactNode }) {
  const [full, setFull] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<{ y: number; id: number } | null>(null);
  if (!open) return null;
  const onDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (start.current?.id === e.pointerId) setDrag(e.clientY - start.current.y);
  };
  const onUp = () => {
    if (!start.current) return;
    start.current = null;
    if (drag > 80) { if (full) setFull(false); else onClose(); }
    else if (drag < -60) setFull(true);
    setDrag(0);
  };
  return (
    <section
      role="dialog"
      aria-label={title}
      className={`flex shrink-0 flex-col border-t border-line bg-panel shadow-[0_-8px_24px_rgba(0,0,0,0.4)] ${full ? 'absolute inset-x-0 bottom-0 top-[8dvh] z-30 rounded-t-xl' : 'h-[44dvh] max-h-[460px] min-h-[220px] landscape:h-[56dvh]'}`}
      style={{ transform: drag ? `translateY(${Math.max(-40, drag)}px)` : undefined, transition: drag ? 'none' : 'transform 160ms ease-out' }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="flex cursor-grab touch-none items-center gap-2 px-3 pb-1 pt-1.5" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="flex-1" />
        <div className="h-1 w-10 rounded-full bg-[#555]" aria-hidden />
        <div className="flex flex-1 justify-end" />
      </div>
      <div className="flex items-center gap-2 px-3 pb-1">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink">{title}</h2>
        <div className="flex-1" />
        {actions}
        <button className="rounded px-2 py-1 text-xs text-ink-dim" onClick={() => setFull(!full)} aria-label={full ? 'Half height' : 'Full height'}>{full ? '▾' : '▴'}</button>
        <button className="rounded px-2 py-1 text-xs text-ink-dim" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(8px,env(safe-area-inset-bottom))]">{children}</div>
    </section>
  );
}
