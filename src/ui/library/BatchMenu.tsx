import { t as tr } from '../../i18n';
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
import { Menu, type MenuItem } from '../controls/Menu';
import { confirmDialog, messageDialog } from '../feedback/dialogs';
import { DEFAULT_PRESET_GROUPS, GroupChecklist, Modal } from '../presets/Dialogs';
import { tp } from '../../i18n/format';

type DialogKind = null | 'sync' | 'copy' | 'paste' | 'preset';
export const useBatchDialog = create<{ open: DialogKind; set(o: DialogKind): void }>((set) => ({ open: null, set: (open) => set({ open }) }));

/** Reset the edits of the selection, after an in-app confirmation (each photo keeps an undo step). */
async function confirmReset() {
  const ids = targetIds();
  const n = ids.length;
  const ok = await confirmDialog({
    title: tp('batchMenu.reset_photos', n),
    message: tr('batchMenu.every_adjustment_goes_back_to_its'),
    confirmLabel: tr('batchMenu.reset_edits'),
    danger: true,
  });
  if (ok) void resetSelection(ids);
}

/** The batch actions as menu items (the Batch menu, and the editor's overflow menu below 1280 px). */
export function useBatchMenuItems(): MenuItem[] {
  const n = useLibrary((s) => s.selection.size);
  const active = useLibrary((s) => s.active);
  const autoSync = useBatch((s) => s.autoSync);
  const running = useBatch((s) => s.running);
  const clip = useUi((s) => s.clipboard);
  const open = useBatchDialog.getState().set;
  const many = n > 1;
  const has = n > 0 || !!active;
  return [
    { label: tr('batchMenu.sync_settings_from_the_active_photo'), disabled: !many || !active || running, onSelect: () => open('sync') },
    { label: `${autoSync ? '✓ ' : ''}${tr('batchMenu.auto_sync')}`, onSelect: () => setAutoSync(!autoSync) },
    { label: tr('batchMenu.copy_settings_of_the_active_photo'), disabled: !active, onSelect: () => open('copy') },
    { label: tr('batchMenu.paste_settings_to_the_selection'), disabled: !clip || !has || running, onSelect: () => open('paste') },
    { label: tr('batchMenu.apply_a_preset_to_the_selection'), disabled: !has || running, onSelect: () => open('preset') },
    { label: tr('batchMenu.auto_white_balance_each_photo'), disabled: !has || running, onSelect: () => void batchAutoWb() },
    { label: tr('batchMenu.auto_tone_each_photo'), disabled: !has || running, onSelect: () => void batchAutoTone() },
    { label: tr('batchMenu.match_exposure_wb_to_the_active'), disabled: !many || !active || running, hint: tr('batchMenu.the_active_outlined_photo_is_the'), onSelect: () => active && void matchLook(active) },
    { label: tr('batchMenu.reset_edits_2'), disabled: !has || running, onSelect: () => void confirmReset() },
    { label: tr('batchMenu.export_selection'), disabled: !has, onSelect: () => useUi.getState().set({ batchExportOpen: true }) },
  ];
}

export function BatchMenu() {
  const n = useLibrary((s) => s.selection.size);
  const items = useBatchMenuItems();
  return (
    <Menu label={n > 1 ? tr('batchMenu.batch_n', { n }) : tr('batchMenu.batch')} ariaLabel={tr('batchMenu.batch_actions')} align="right" className="rounded px-2 py-1 text-xs text-ink hover:bg-hover" items={items} />
  );
}

function SyncDialog({ mode }: { mode: 'sync' | 'copy' | 'paste' }) {
  const clip = useUi((s) => s.clipboard);
  const [groups, setGroups] = useState<PresetGroup[]>(mode === 'paste' && clip ? clip.groups.filter((g) => DEFAULT_PRESET_GROUPS.includes(g)) : DEFAULT_PRESET_GROUPS);
  const close = () => useBatchDialog.getState().set(null);
  const ids = targetIds();
  const title = mode === 'sync' ? tp('batchMenu.sync_to', Math.max(0, ids.length - 1)) : mode === 'copy' ? tr('batchMenu.copy_settings_title') : tp('batchMenu.paste_to', ids.length);
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
      <p className="mb-2 text-xs text-ink-faint">{tr('batchMenu.photo_specific_groups_white_balance_exposure')}</p>
      <GroupChecklist value={groups} onChange={setGroups} enabled={mode === 'paste' ? clip?.groups : undefined} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('batchMenu.cancel')}</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={!groups.length} onClick={() => void go()}>
          {mode === 'sync' ? tr('batchMenu.synchronize') : mode === 'copy' ? tr('batchMenu.copy') : tr('batchMenu.paste')}
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
    <Modal title={tp('batchMenu.apply_preset_photos', ids.length)} onClose={close}>
      <label className="mb-3 flex items-center gap-2 text-xs text-ink-dim">{tr('batchMenu.preset')}<select className="input min-w-0 flex-1" aria-label={tr('batchMenu.preset')} value={id} onChange={(e) => setId(e.target.value)}>
          {presets.map((x) => <option key={x.id} value={x.id}>{x.group} · {x.name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-dim">{tr('batchMenu.amount')}<input type="range" min={0} max={200} value={amount} onChange={(e) => setAmount(+e.target.value)} className="flex-1 accent-control" />
        <span className="w-10 text-end tabular-nums text-ink">{amount}%</span>
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('batchMenu.cancel')}</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={!p}
          onClick={() => { close(); if (p) void applyPresetToSelection(p, amount); }}>{tr('batchMenu.apply')}</button>
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
    <div className="flex items-center gap-2 text-2xs text-ink-dim" role="status" aria-live="polite">
      {autoSync && <button className="rounded bg-success-bg px-1.5 py-0.5 text-2xs text-ink" title={tr('batchMenu.auto_sync_is_on_edits_apply')} onClick={() => setAutoSync(false)}>{tr('batchMenu.auto_sync')}</button>}
      {b.running && (
        <>
          <span className="max-w-[220px] truncate">{b.label} · {b.done} / {b.total}</span>
          <button className="text-ink-faint hover:text-ink" onClick={() => b.set({ cancel: true })}>{tr('batchMenu.cancel')}</button>
        </>
      )}
      {!b.running && b.errors.length > 0 && (
        <button className="text-danger hover:underline" onClick={() => { void messageDialog({ title: tp('batchMenu.photos_failed', b.errors.length), items: b.errors.map((e) => `${e.name}: ${e.message}`) }); b.set({ errors: [] }); }}>
          {tp('batchMenu.photos_failed', b.errors.length)}</button>
      )}
    </div>
  );
}
