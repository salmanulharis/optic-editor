import { useEdit } from '../../state/editStore';
import { t as tr } from '../../i18n';

/** Color / Monochrome treatment switch (key V). */
export function TreatmentToggle() {
  const t = useEdit((s) => s.recipe.treatment);
  const set = (treatment: 'color' | 'monochrome') =>
    useEdit.getState().apply((r) => ({ ...r, treatment, bwMixer: { ...r.bwMixer, enabled: true } }));
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <span className="text-2xs uppercase tracking-wider text-ink-dim">{tr('treatmentToggle.treatment')}</span>
      <div className="ms-auto flex rounded border border-line text-xs" title={tr('treatmentToggle.toggle_with_v')}>
        {(['color', 'monochrome'] as const).map((v) => (
          <button key={v} onClick={() => set(v)} aria-pressed={t === v}
            className={`px-2.5 py-0.5 ${t === v ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}>
            {v === 'color' ? tr('treatmentToggle.color') : 'B&W'}
          </button>
        ))}
      </div>
    </div>
  );
}
