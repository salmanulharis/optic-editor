import { useEdit } from '../../state/editStore';

/** Color / Monochrome treatment switch (key V). */
export function TreatmentToggle() {
  const t = useEdit((s) => s.recipe.treatment);
  const set = (treatment: 'color' | 'monochrome') =>
    useEdit.getState().apply((r) => ({ ...r, treatment, bwMixer: { ...r.bwMixer, enabled: true } }));
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <span className="text-[11px] uppercase tracking-wider text-ink-dim">Treatment</span>
      <div className="ml-auto flex rounded border border-line text-xs" title="Toggle with V">
        {(['color', 'monochrome'] as const).map((v) => (
          <button key={v} onClick={() => set(v)} aria-pressed={t === v}
            className={`px-2.5 py-0.5 ${t === v ? 'bg-[#3a3a3a] text-white' : 'text-ink-dim hover:text-ink'}`}>
            {v === 'color' ? 'Color' : 'B&W'}
          </button>
        ))}
      </div>
    </div>
  );
}
