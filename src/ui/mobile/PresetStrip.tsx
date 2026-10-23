/**
 * Presets on a phone: group chips and a horizontal strip of thumbnails rendered on this photo. Tap
 * applies a preset; tapping the applied one again shows its amount slider.
 */
import { useMemo, useRef, useState } from 'react';
import { applyPresetToEdit, commitAmount, removeAppliedPreset, setAmountLive } from '../../app/presetActions';
import type { Preset } from '../../presets/types';
import { useEdit } from '../../state/editStore';
import { usePresets } from '../../state/presetStore';
import { Slider } from '../controls/Slider';
import { useThumbnail } from '../presets/thumbnails';

function Tile({ p, applied, onTap }: { p: Preset; applied: boolean; onTap(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const url = useThumbnail(p, ref);
  return (
    <button ref={ref} onClick={onTap} aria-pressed={applied} aria-label={p.name}
      className={`flex w-[88px] shrink-0 flex-col overflow-hidden rounded ${applied ? 'ring-2 ring-white' : ''}`}>
      <div className="aspect-[4/5] w-full bg-sunk">
        {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : <div className="h-full w-full animate-pulse bg-sunk" />}
      </div>
      <div className="truncate px-1 py-1 text-[10px] text-ink-dim">{p.name}</div>
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
  const list = group === 'Favorites' ? all.filter((p) => favorites.includes(p.id)) : all.filter((p) => p.group === group);
  return (
    <div className="px-3">
      <div className="-mx-3 mb-2 flex gap-1.5 overflow-x-auto px-3 pb-1" role="tablist" aria-label="Preset groups">
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
        {!list.length && <div className="py-6 text-xs text-ink-faint">{group === 'Favorites' ? 'Star presets in the desktop browser or with a long press to see them here.' : 'No presets'}</div>}
      </div>
      {applied && (
        <div className="mt-1 rounded border border-line p-2">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-ink">{applied.name}</span>
            <button className="text-ink-dim" onClick={() => setShowAmount(!showAmount)}>{showAmount ? 'Hide amount' : 'Amount'}</button>
            <button className="text-ink-dim" onClick={removeAppliedPreset}>Remove</button>
          </div>
          {showAmount && (
            <Slider label="Amount" value={applied.amount} min={0} max={200} step={1} defaultValue={100}
              format={(v) => `${Math.round(v)}%`} onChange={setAmountLive} onCommit={commitAmount} />
          )}
        </div>
      )}
    </div>
  );
}
