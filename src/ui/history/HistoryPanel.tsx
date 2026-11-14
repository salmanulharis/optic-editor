import { t as tr } from '../../i18n';
/**
 * History & snapshots (left sidebar tab).
 *  - Snapshots: named recipes; click to restore, hover to preview, rename, update with the current
 *    settings, delete, or show as the compare "Before".
 *  - History: every committed change as a named step, newest first. Click to jump (editing from
 *    there truncates the steps after it), hover to preview, ⇆ to compare against it.
 * Both are saved per photo (and per virtual copy) and survive reloads.
 */
import { useRef, useState } from 'react';
import { effectiveRecipe } from '../../recipe/schema';
import { activeCopy, dateName, useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { useFocusTrap } from '../focusTrap';
import { confirmDialog } from '../feedback/dialogs';
import { IconButton } from '../controls/IconButton';
import { tp } from '../../i18n/format';

const preview = (r: Parameters<typeof effectiveRecipe>[0] | null) => useUi.getState().set({ previewRecipe: r });
const compareWith = (source: string) => {
  const ui = useUi.getState();
  ui.set({ compareSource: source, compareMode: ui.compareMode === 'off' ? 'side' : ui.compareMode, previewRecipe: null });
};

const IconBtn = (p: { title: string; onClick(e: React.MouseEvent): void; children: React.ReactNode }) => (
  <IconButton label={p.title} className="px-1 text-2xs text-ink-faint hover:bg-active hover:text-ink" onClick={(e) => { e.stopPropagation(); p.onClick(e); }}>
    {p.children}
  </IconButton>
);

export function HistoryPanel() {
  const copy = useEdit((s) => activeCopy(s));
  const hasImage = useImage((s) => !!s.image);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  if (!hasImage) return <p className="px-3 py-3 text-xs text-ink-faint">{tr('historyPanel.open_a_photo_to_see_its')}</p>;
  const e = useEdit.getState();
  return (
    <div className="flex min-h-0 flex-1 flex-col" onMouseLeave={() => preview(null)}>
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-dim">{tr('historyPanel.snapshots')}</span>
        <button className="rounded px-1.5 py-0.5 text-2xs text-ink-dim hover:bg-hover hover:text-ink" title={tr('historyPanel.create_snapshot_ctrl_cmd_shift_s')}
          onClick={() => useUi.getState().set({ snapshotDialog: true })}>{tr('historyPanel.snapshot')}</button>
      </div>
      <div className="max-h-[35%] overflow-y-auto border-b border-line">
        {!copy.snapshots.length && <p className="px-3 py-2 text-xs text-ink-faint">{tr('historyPanel.save_the_current_settings_under_a')}</p>}
        {copy.snapshots.map((s) => (
          <div key={s.id} className="group flex cursor-pointer items-center gap-1 px-2 py-1 text-xs text-ink-dim hover:bg-hover hover:text-ink"
            onMouseEnter={() => preview(s.recipe)} onClick={() => { preview(null); e.restoreSnapshot(s.id); }}>
            {editing === s.id ? (
              <input autoFocus className="input min-w-0 flex-1" value={name} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => setName(ev.target.value)}
                onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { e.renameSnapshot(s.id, name); setEditing(null); } if (ev.key === 'Escape') setEditing(null); }}
                onBlur={() => { e.renameSnapshot(s.id, name); setEditing(null); }} />
            ) : <span className="min-w-0 flex-1 truncate" title={new Date(s.t).toLocaleString()}>{s.name}</span>}
            <span className="hidden gap-0.5 group-focus-within:flex group-hover:flex [@media(pointer:coarse)]:flex">
              <IconBtn title={tr('historyPanel.compare_with_this_snapshot')} onClick={() => compareWith(`snap:${s.id}`)}>⇆</IconBtn>
              <IconBtn title={tr('historyPanel.rename')} onClick={() => { setEditing(s.id); setName(s.name); }}>✎</IconBtn>
              <IconBtn title={tr('historyPanel.update_with_current_settings')} onClick={() => e.updateSnapshot(s.id)}>⟳</IconBtn>
              <IconBtn title={tr('historyPanel.delete')} onClick={() => void confirmDialog({ title: tr('historyPanel.delete_snapshot_name', { name: s.name }), message: tr('historyPanel.the_snapshot_is_removed_your_current'), confirmLabel: tr('historyPanel.delete_snapshot'), danger: true }).then((ok) => ok && e.deleteSnapshot(s.id))}>✕</IconBtn>
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-dim">{tr('historyPanel.history')}</span>
        <span className="text-2xs text-ink-faint">{tp('historyPanel.steps', copy.steps.length)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {copy.steps.map((s, i) => ({ s, i })).reverse().map(({ s, i }) => (
          <div key={i}
            className={`group flex cursor-pointer items-center gap-1 px-2 py-[3px] text-xs ${i === copy.index ? 'bg-active text-strong' : i > copy.index ? 'text-ink-faint hover:bg-hover' : 'text-ink-dim hover:bg-hover hover:text-ink'}`}
            onMouseEnter={() => preview(i === copy.index ? null : s.recipe)}
            onClick={() => { preview(null); e.jump(i); }}
            title={new Date(s.t).toLocaleTimeString()}>
            <span className="w-6 shrink-0 text-end text-2xs tabular-nums text-ink-faint">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="hidden group-hover:flex">
              <IconBtn title={tr('historyPanel.compare_with_this_step')} onClick={() => compareWith(`step:${i}`)}>⇆</IconBtn>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Name a new snapshot (Ctrl/Cmd+Shift+S); the default name is the date and time. */
export function SnapshotDialog() {
  const open = useUi((s) => s.snapshotDialog);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  if (!open) return null;
  const close = () => { useUi.getState().set({ snapshotDialog: false }); setName(''); };
  const save = () => { useEdit.getState().createSnapshot(name || dateName()); close(); };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={tr('historyPanel.create_snapshot')} className="w-full max-w-sm rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'Enter') save(); }}>
        <h2 className="mb-3 text-sm font-medium">{tr('historyPanel.create_snapshot')}</h2>
        <input autoFocus className="input w-full" placeholder={dateName()} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('historyPanel.cancel')}</button>
          <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi" onClick={save}>{tr('historyPanel.create')}</button>
        </div>
      </div>
    </div>
  );
}
