/**
 * Presets on a phone: group chips and a horizontal strip of thumbnails rendered on this photo. Tap
 * applies a preset; tapping the applied one again shows its amount slider.
 */
import { useMemo, useRef, useState } from 'react';
import { applyPresetToEdit, commitAmount, removeAppliedPreset, setAmountLive } from '../../app/presetActions';
import type { Preset } from '../../presets/types';
import { useEdit } from '../../state/editStore';
import { usePresets } from '../../state/presetStore';
import { useT } from '../../i18n';
import { Slider } from '../controls/Slider';
import { ImportReportDialog, ImportStatus, usePresetImport } from '../presets/ImportReport';
import { useThumbnail } from '../presets/thumbnails';
import { t as tr } from '../../i18n';

function Tile({ p, applied, onTap }: { p: Preset; applied: boolean; onTap(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const url = useThumbnail(p, ref);
  return (
    <button ref={ref} onClick={onTap} aria-pressed={applied} aria-label={p.name}
      className={`flex w-[88px] shrink-0 flex-col overflow-hidden rounded ${applied ? 'ring-2 ring-white' : ''}`}>
      <div className="aspect-[4/5] w-full bg-sunk">
        {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : <div className="h-full w-full animate-pulse bg-sunk" />}
      </div>
      <div className="truncate px-1 py-1 text-2xs text-ink-dim">{p.name}</div>
    </button>
  );
}

export function PresetStrip() {
  const ready = usePresets((s) => s.ready);
  const user = usePresets((s) => s.user);
  const favorites = usePresets((s) => s.favorites);
  const applied = useEdit((s) => s.recipe.appliedPreset);
  const all = useMemo(() => (ready ? usePresets.getState().all() : []), [ready, user]);
  const groups = useMemo(() => ['Favorites', ...new Set(all.map((p) => p.group))], [all]);
  const [group, setGroup] = useState<string>(() => (favorites.length ? 'Favorites' : all[0]?.group ?? ''));
  const [showAmount, setShowAmount] = useState(false);
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  // After an import, show the group the new presets landed in.
  const imp = usePresetImport((g) => { if (g) setGroup(g); });
  const list = group === 'Favorites' ? all.filter((p) => favorites.includes(p.id)) : all.filter((p) => p.group === group);
  return (
    <div className="px-3">
      <div className="-mx-3 mb-2 flex gap-1.5 overflow-x-auto px-3 pb-1" role="tablist" aria-label={tr('presetStrip.preset_groups')}>
        {groups.map((g) => (
          <button key={g} role="tab" aria-selected={g === group} onClick={() => setGroup(g)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs ${g === group ? 'border-ink-dim bg-active text-strong' : 'border-line text-ink-dim'}`}>{g}</button>
        ))}
      </div>
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-2">
        {list.map((p) => (
          <Tile key={p.id} p={p} applied={applied?.id === p.id} onTap={() => {
            if (applied?.id === p.id) setShowAmount(!showAmount);
            else { applyPresetToEdit(p); setShowAmount(false); }
          }} />
        ))}
        {!list.length && <div className="py-6 text-xs text-ink-faint">{group === 'Favorites' ? tr('presetStrip.star_presets_in_the_desktop_browser') : tr('presetStrip.no_presets')}</div>}
        <button onClick={() => fileRef.current?.click()} disabled={imp.busy} aria-label={t('presets.import.aria')}
          className="flex w-[88px] shrink-0 flex-col overflow-hidden rounded border border-dashed border-line disabled:opacity-40">
          <div className="flex aspect-[4/5] w-full items-center justify-center text-2xl text-ink-dim" aria-hidden>＋</div>
          <div className="truncate px-1 py-1 text-2xs text-ink-dim">{t('presets.import')}</div>
        </button>
        {/* No `accept` filter: iOS greys out extensions it has no type for (.xmp, .lrtemplate). */}
        <input ref={fileRef} type="file" multiple className="hidden" tabIndex={-1} aria-hidden
          onChange={(e) => { const f = [...(e.target.files ?? [])]; if (f.length) void imp.run(f); e.target.value = ''; }} />
      </div>
      <ImportStatus imp={imp} className="mb-2 rounded border border-line px-2 py-1.5 text-2xs text-ink-dim" />
      <ImportReportDialog imp={imp} />
      {applied && (
        <div className="mt-1 rounded border border-line p-2">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-ink">{applied.name}</span>
            <button className="text-ink-dim" onClick={() => setShowAmount(!showAmount)}>{showAmount ? tr('presetStrip.hide_amount') : tr('presetStrip.amount')}</button>
            <button className="text-ink-dim" onClick={removeAppliedPreset}>{tr('presetStrip.remove')}</button>
          </div>
          {showAmount && (
            <Slider label={tr('presetStrip.amount')} value={applied.amount} min={0} max={200} step={1} defaultValue={100}
              format={(v) => `${Math.round(v)}%`} onChange={setAmountLive} onCommit={commitAmount} />
          )}
        </div>
      )}
    </div>
  );
}
