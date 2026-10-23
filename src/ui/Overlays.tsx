/** App-level overlays: the keyboard shortcuts list (?) and the first-launch tour. */
import { useEffect, useRef, useState } from 'react';
import { SHORTCUTS } from '../app/shortcuts';
import { useT } from '../i18n';
import { useSettings } from '../state/settingsStore';
import { useUi } from '../state/uiStore';

/** Keep keyboard focus inside a dialog while it is open; restore it afterwards. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('input,button,select,[tabindex]:not([tabindex="-1"])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>('input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, [open, ref]);
}

export function ShortcutsOverlay() {
  const open = useUi((s) => s.shortcutsOpen);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useFocusTrap(ref, open);
  if (!open) return null;
  const close = () => useUi.getState().set({ shortcutsOpen: false });
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = SHORTCUTS.filter((s) => words.every((w) => `${s.keys} ${s.action} ${s.group}`.toLowerCase().includes(w)));
  const groups = [...new Set(list.map((s) => s.group))];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('shortcuts.title')} className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg border border-line bg-panel text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === '?' && !q)) { e.preventDefault(); close(); } }}>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium">{t('shortcuts.title')}</h2>
          <input type="search" autoFocus className="input ml-auto w-60" placeholder={t('shortcuts.search')} aria-label={t('shortcuts.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="text-ink-dim hover:text-ink" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="grid min-h-0 flex-1 gap-x-8 overflow-y-auto px-4 py-3 md:grid-cols-2">
          {groups.map((g) => (
            <section key={g} className="mb-3 break-inside-avoid">
              <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">{g}</h3>
              <dl className="text-xs">
                {list.filter((s) => s.group === g).map((s) => (
                  <div key={s.keys + s.action} className="flex justify-between gap-3 border-b border-line/50 py-1">
                    <dt className="text-ink-dim">{s.action}</dt>
                    <dd><kbd className="whitespace-nowrap rounded border border-line bg-raise px-1.5 py-0.5 font-mono text-[11px] text-ink">{s.keys}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {!list.length && <p className="text-xs text-ink-faint">No shortcut matches “{q}”.</p>}
        </div>
      </div>
    </div>
  );
}

export function Onboarding() {
  const done = useSettings((s) => s.onboardingDone);
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useFocusTrap(ref, !done);
  if (done) return null;
  const finish = () => { useSettings.getState().set({ onboardingDone: true }); setStep(0); };
  const n = 4;
  const icons = ['◎', '▦', '◐', '⇪'];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="tour-title" className="w-full max-w-md rounded-xl border border-line bg-panel p-6 text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') finish(); }}>
        <div className="mb-3 text-3xl text-ink-dim" aria-hidden>{icons[step]}</div>
        <h2 id="tour-title" className="mb-2 text-base font-medium">{t(`tour.${step + 1}.title`)}</h2>
        <p className="mb-5 text-sm leading-relaxed text-ink-dim">{t(`tour.${step + 1}.body`)}</p>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5" role="img" aria-label={`Step ${step + 1} of ${n}`}>
            {Array.from({ length: n }, (_, i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === step ? 'bg-ink' : 'bg-edge'}`} />)}
          </div>
          <div className="flex-1" />
          <button className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink" onClick={finish}>{t('tour.skip')}</button>
          <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi" autoFocus
            onClick={() => (step < n - 1 ? setStep(step + 1) : finish())}>{step < n - 1 ? t('tour.next') : t('tour.done')}</button>
        </div>
      </div>
    </div>
  );
}
