/**
 * Batch actions on the selection: sync settings, Auto Sync, copy / paste, presets, auto white
 * balance and tone, match look, reset, export. Available in the library and in the editor (with
 * several photos selected in the filmstrip).
 */
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import {
  activeSource,
  applyPresetToSelection,
  batchAutoTone,
  batchAutoWb,
  matchLook,
  pasteToSelection,
  resetSelection,
  setAutoSync,
  syncSettings,
  useBatch,
} from '../../library/batch';
import type { PresetGroup } from '../../recipe/schema';
import { targetIds, useLibrary } from '../../state/libraryStore';
import { usePresets } from '../../state/presetStore';
import { useUi } from '../../state/uiStore';
import { Menu } from '../controls/Menu';
import { DEFAULT_PRESET_GROUPS, GroupChecklist, Modal } from '../presets/Dialogs';

type DialogKind = null | 'sync' | 'copy' | 'paste' | 'preset';
export const useBatchDialog = create<{ open: DialogKind; set(o: DialogKind): void }>((set) => ({ open: null, set: (open) => set({ open }) }));

export function BatchMenu() {
  const n = useLibrary((s) => s.selection.size);
  const active = useLibrary((s) => s.active);
  const autoSync = useBatch((s) => s.autoSync);
  const running = useBatch((s) => s.running);
  const clip = useUi((s) => s.clipboard);
  const open = useBatchDialog.getState().set;
  const many = n > 1;
  const has = n > 0 || !!active;
  return (
    <Menu label={`Batch${many ? ` (${n})` : ''}`} ariaLabel="Batch actions" align="right" className="rounded px-2 py-1 text-xs text-ink hover:bg-hover" items={[
      { label: 'Sync settings from the active photo…', disabled: !many || !active || running, onSelect: () => open('sync') },
      { label: `${autoSync ? '✓ ' : ''}Auto Sync (edits apply to the whole selection)`, onSelect: () => setAutoSync(!autoSync) },
      { label: 'Copy settings of the active photo…', disabled: !active, onSelect: () => open('copy') },
      { label: 'Paste settings to the selection…', disabled: !clip || !has || running, onSelect: () => open('paste') },
      { label: 'Apply a preset to the selection…', disabled: !has || running, onSelect: () => open('preset') },
      { label: 'Auto white balance (each photo)', disabled: !has || running, onSelect: () => void batchAutoWb() },
      { label: 'Auto tone (each photo)', disabled: !has || running, onSelect: () => void batchAutoTone() },
      { label: 'Match exposure & WB to the active photo', disabled: !many || !active || running, hint: 'The active (outlined) photo is the reference', onSelect: () => active && void matchLook(active) },
      { label: 'Reset edits…', disabled: !has || running, onSelect: () => { const ids = targetIds(); if (confirm(`Reset all edits of ${ids.length} photo${ids.length > 1 ? 's' : ''}? Each can be undone in its history.`)) void resetSelection(ids); } },
      { label: 'Export selection…', disabled: !has, onSelect: () => useUi.getState().set({ batchExportOpen: true }) },
    ]} />
  );
}

function SyncDialog({ mode }: { mode: 'sync' | 'copy' | 'paste' }) {
  const clip = useUi((s) => s.clipboard);
  const [groups, setGroups] = useState<PresetGroup[]>(mode === 'paste' && clip ? clip.groups.filter((g) => DEFAULT_PRESET_GROUPS.includes(g)) : DEFAULT_PRESET_GROUPS);
  const close = () => useBatchDialog.getState().set(null);
  const ids = targetIds();
  const title = mode === 'sync' ? `Sync settings to ${Math.max(0, ids.length - 1)} photo${ids.length === 2 ? '' : 's'}` : mode === 'copy' ? 'Copy settings' : `Paste settings to ${ids.length} photo${ids.length > 1 ? 's' : ''}`;
  const go = async () => {
    close();
    if (mode === 'sync') await syncSettings(groups);
    else if (mode === 'copy') {
      const src = await activeSource();
      if (src) useUi.getState().set({ clipboard: { groups, recipe: structuredClone(src.recipe), isRaw: src.isRaw } });
    } else if (clip) await pasteToSelection(groups, clip, clip.isRaw ?? false);
  };
  return (
    <Modal title={title} onClose={close}>
      <p className="mb-2 text-[11px] text-ink-faint">Photo-specific groups (white balance, exposure, noise reduction, lens, geometry, crop, masks) start unticked.</p>
      <GroupChecklist value={groups} onChange={setGroups} enabled={mode === 'paste' ? clip?.groups : undefined} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>Cancel</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={!groups.length} onClick={() => void go()}>
          {mode === 'sync' ? 'Synchronize' : mode === 'copy' ? 'Copy' : 'Paste'}
        </button>
      </div>
    </Modal>
  );
}

function PresetDialog() {
  const ready = usePresets((s) => s.ready);
  const presets = useMemo(() => (ready ? usePresets.getState().all() : []), [ready]);
  const [id, setId] = useState(presets[0]?.id ?? '');
  const [amount, setAmount] = useState(100);
  const close = () => useBatchDialog.getState().set(null);
  const ids = targetIds();
  const p = presets.find((x) => x.id === id);
  return (
    <Modal title={`Apply a preset to ${ids.length} photo${ids.length > 1 ? 's' : ''}`} onClose={close}>
      <label className="mb-3 flex items-center gap-2 text-xs text-ink-dim">Preset
        <select className="input min-w-0 flex-1" aria-label="Preset" value={id} onChange={(e) => setId(e.target.value)}>
          {presets.map((x) => <option key={x.id} value={x.id}>{x.group} · {x.name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-dim">Amount
        <input type="range" min={0} max={200} value={amount} onChange={(e) => setAmount(+e.target.value)} className="flex-1 accent-[#9a9a9a]" />
        <span className="w-10 text-right tabular-nums text-ink">{amount}%</span>
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>Cancel</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={!p}
          onClick={() => { close(); if (p) void applyPresetToSelection(p, amount); }}>Apply</button>
      </div>
    </Modal>
  );
}

export function BatchDialogs() {
  const open = useBatchDialog((s) => s.open);
  if (open === 'preset') return <PresetDialog />;
  if (open) return <SyncDialog mode={open} />;
  return null;
}

/** Batch progress (top bar): count, cancel, errors. */
export function BatchProgress() {
  const b = useBatch();
  const autoSync = b.autoSync;
  if (!b.running && !b.errors.length && !autoSync) return null;
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-dim" role="status" aria-live="polite">
      {autoSync && <button className="rounded bg-[#3a4a3a] px-1.5 py-0.5 text-[10px] text-[#cfe8cf]" title="Auto Sync is on: edits apply to every selected photo. Click to turn off." onClick={() => setAutoSync(false)}>Auto Sync</button>}
      {b.running && (
        <>
          <span className="max-w-[220px] truncate">{b.label} · {b.done} / {b.total}</span>
          <button className="text-ink-faint hover:text-ink" onClick={() => b.set({ cancel: true })}>Cancel</button>
        </>
      )}
      {!b.running && b.errors.length > 0 && (
        <button className="text-[#e09090] hover:underline" onClick={() => { alert(b.errors.map((e) => `${e.name}: ${e.message}`).join('\n')); b.set({ errors: [] }); }}>
          {b.errors.length} photo{b.errors.length > 1 ? 's' : ''} failed
        </button>
      )}
    </div>
  );
}
