import { t as tr } from '../i18n';
/** App-level overlays: the keyboard shortcuts list (?) and the first-launch tour. */
import { useRef, useState } from 'react';
import { SHORTCUTS } from '../app/shortcuts';
import { useT } from '../i18n';
import { useSettings } from '../state/settingsStore';
import { useUi } from '../state/uiStore';
import { useFocusTrap } from './focusTrap';
import { IconButton } from './controls/IconButton';
import { SampleButton } from './library/SampleButton';

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
          <input type="search" autoFocus className="input ms-auto w-60" placeholder={t('shortcuts.search')} aria-label={t('shortcuts.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <IconButton className="text-ink-dim hover:text-ink" onClick={close} label={tr('overlays.close')} shortcut="Esc">✕</IconButton>
        </div>
        <div className="grid min-h-0 flex-1 gap-x-8 overflow-y-auto px-4 py-3 md:grid-cols-2">
          {groups.map((g) => (
            <section key={g} className="mb-3 break-inside-avoid">
              <h3 className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink-faint">{g}</h3>
              <dl className="text-xs">
                {list.filter((s) => s.group === g).map((s) => (
                  <div key={s.keys + s.action} className="flex justify-between gap-3 border-b border-line/50 py-1">
                    <dt className="text-ink-dim">{s.action}</dt>
                    <dd><kbd className="whitespace-nowrap rounded border border-line bg-raise px-1.5 py-0.5 font-mono text-2xs text-ink">{s.keys}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {!list.length && <p className="text-xs text-ink-faint">{tr('overlays.no_shortcut_matches', { q })}</p>}
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
        {step === n - 1 && <SampleButton className="-mt-2 mb-4" onStart={finish} />}
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5" role="img" aria-label={tr('overlays.step_step_of_n', { step: step + 1, n: n })}>
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
