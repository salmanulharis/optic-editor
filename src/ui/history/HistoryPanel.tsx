/**
 * History & snapshots (left sidebar tab).
 *  - Snapshots: named recipes; click to restore, hover to preview, rename, update with the current
 *    settings, delete, or show as the compare "Before".
 *  - History: every committed change as a named step, newest first. Click to jump (editing from
 *    there truncates the steps after it), hover to preview, ⇆ to compare against it.
 * Both are saved per photo (and per virtual copy) and survive reloads.
 */
import { useState } from 'react';
import { effectiveRecipe } from '../../recipe/schema';
import { activeCopy, dateName, useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';

const preview = (r: Parameters<typeof effectiveRecipe>[0] | null) => useUi.getState().set({ previewRecipe: r });
const compareWith = (source: string) => {
  const ui = useUi.getState();
  ui.set({ compareSource: source, compareMode: ui.compareMode === 'off' ? 'side' : ui.compareMode, previewRecipe: null });
};

const IconBtn = (p: { title: string; onClick(e: React.MouseEvent): void; children: React.ReactNode }) => (
  <button title={p.title} className="rounded px-1 text-[11px] text-ink-faint hover:bg-[#3a3a3a] hover:text-ink" onClick={(e) => { e.stopPropagation(); p.onClick(e); }}>
    {p.children}
  </button>
);

export function HistoryPanel() {
  const copy = useEdit((s) => activeCopy(s));
  const hasImage = useImage((s) => !!s.image);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  if (!hasImage) return <p className="px-3 py-3 text-[11px] text-ink-faint">Open a photo to see its history.</p>;
  const e = useEdit.getState();
  return (
    <div className="flex min-h-0 flex-1 flex-col" onMouseLeave={() => preview(null)}>
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">Snapshots</span>
        <button className="rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:bg-[#333] hover:text-ink" title="Create snapshot (Ctrl/Cmd+Shift+S)"
          onClick={() => useUi.getState().set({ snapshotDialog: true })}>+ Snapshot</button>
      </div>
      <div className="max-h-[35%] overflow-y-auto border-b border-line">
        {!copy.snapshots.length && <p className="px-3 py-2 text-[11px] text-ink-faint">Save the current settings under a name to come back to them.</p>}
        {copy.snapshots.map((s) => (
          <div key={s.id} className="group flex cursor-pointer items-center gap-1 px-2 py-1 text-xs text-ink-dim hover:bg-[#2e2e2e] hover:text-ink"
            onMouseEnter={() => preview(s.recipe)} onClick={() => { preview(null); e.restoreSnapshot(s.id); }}>
            {editing === s.id ? (
              <input autoFocus className="input min-w-0 flex-1" value={name} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => setName(ev.target.value)}
                onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { e.renameSnapshot(s.id, name); setEditing(null); } if (ev.key === 'Escape') setEditing(null); }}
                onBlur={() => { e.renameSnapshot(s.id, name); setEditing(null); }} />
            ) : <span className="min-w-0 flex-1 truncate" title={new Date(s.t).toLocaleString()}>{s.name}</span>}
            <span className="hidden gap-0.5 group-hover:flex">
              <IconBtn title="Compare with this snapshot" onClick={() => compareWith(`snap:${s.id}`)}>⇆</IconBtn>
              <IconBtn title="Rename" onClick={() => { setEditing(s.id); setName(s.name); }}>✎</IconBtn>
              <IconBtn title="Update with current settings" onClick={() => e.updateSnapshot(s.id)}>⟳</IconBtn>
              <IconBtn title="Delete" onClick={() => { if (confirm(`Delete snapshot “${s.name}”?`)) e.deleteSnapshot(s.id); }}>✕</IconBtn>
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">History</span>
        <span className="text-[10px] text-ink-faint">{copy.steps.length} steps</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {copy.steps.map((s, i) => ({ s, i })).reverse().map(({ s, i }) => (
          <div key={i}
            className={`group flex cursor-pointer items-center gap-1 px-2 py-[3px] text-xs ${i === copy.index ? 'bg-[#3a3a3a] text-white' : i > copy.index ? 'text-ink-faint hover:bg-[#2e2e2e]' : 'text-ink-dim hover:bg-[#2e2e2e] hover:text-ink'}`}
            onMouseEnter={() => preview(i === copy.index ? null : s.recipe)}
            onClick={() => { preview(null); e.jump(i); }}
            title={new Date(s.t).toLocaleTimeString()}>
            <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-ink-faint">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="hidden group-hover:flex">
              <IconBtn title="Compare with this step" onClick={() => compareWith(`step:${i}`)}>⇆</IconBtn>
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
  if (!open) return null;
  const close = () => { useUi.getState().set({ snapshotDialog: false }); setName(''); };
  const save = () => { useEdit.getState().createSnapshot(name || dateName()); close(); };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Create snapshot" className="w-full max-w-sm rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'Enter') save(); }}>
        <h2 className="mb-3 text-sm font-medium">Create snapshot</h2>
        <input autoFocus className="input w-full" placeholder={dateName()} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-[#333]" onClick={close}>Cancel</button>
          <button className="rounded bg-[#e0e0e0] px-3 py-1.5 text-xs font-medium text-black hover:bg-white" onClick={save}>Create</button>
        </div>
      </div>
    </div>
  );
}
