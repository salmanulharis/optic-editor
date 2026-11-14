/**
 * Where toasts appear: bottom centre, above the filmstrip / bottom tabs. Messages are announced
 * politely, errors assertively. Auto-hide pauses while the pointer or keyboard focus is on a toast.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { type Toast, useToasts } from './toasts';

function ToastItem({ t }: { t: Toast }) {
  const tr = useT();
  const [paused, setPaused] = useState(false);
  const left = useRef(t.duration);
  const started = useRef(0);
  useEffect(() => {
    if (!t.duration || paused) return;
    started.current = performance.now();
    const id = window.setTimeout(() => useToasts.getState().dismiss(t.id), left.current);
    return () => { window.clearTimeout(id); left.current -= performance.now() - started.current; };
  }, [paused, t.duration, t.id]);
  const dismiss = () => useToasts.getState().dismiss(t.id);
  return (
    <div
      className={`pointer-events-auto flex max-w-[min(92vw,520px)] items-center gap-3 rounded border px-3 py-2 text-xs shadow-xl ${
        t.kind === 'error' ? 'border-danger/50 bg-danger-bg text-ink' : 'border-line bg-raise text-ink'}`}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="min-w-0 flex-1 break-words">{t.message}</span>
      {t.action && (
        <button type="button" className="hit shrink-0 rounded px-2 font-medium text-strong underline-offset-2 hover:underline"
          onClick={() => { t.action!.run(); dismiss(); }}>{t.action.label}</button>
      )}
      <button type="button" className="hit shrink-0 rounded text-ink-dim hover:text-ink" aria-label={tr('toast.dismiss')} onClick={dismiss}>✕</button>
    </div>
  );
}

export function Toaster({ className = 'bottom-24' }: { className?: string }) {
  const toasts = useToasts((s) => s.toasts);
  // Live regions must exist before content is added to them, so both are always rendered.
  return (
    <div className={`pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4 ${className}`}>
      <div aria-live="assertive" aria-relevant="additions" className="flex flex-col items-center gap-2">
        {toasts.filter((t) => t.kind === 'error').map((t) => <ToastItem key={t.id} t={t} />)}
      </div>
      <div aria-live="polite" aria-relevant="additions" className="flex flex-col items-center gap-2">
        {toasts.filter((t) => t.kind !== 'error').map((t) => <ToastItem key={t.id} t={t} />)}
      </div>
    </div>
  );
}
