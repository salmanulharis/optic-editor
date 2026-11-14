import { t as tr } from '../../i18n';
/** Library sources: all photos, the last import, collections and smart collections. */
import { useState } from 'react';
import type { CollectionRecord } from '../../library/db';
import { type Source, matchesFilter, targetIds, useLibrary } from '../../state/libraryStore';
import { confirmDialog, promptDialog } from '../feedback/dialogs';
import { IconButton } from '../controls/IconButton';
import { tp } from '../../i18n/format';

function Item({ label, count, active, onClick, onDrop, menu }: { label: string; count: number; active: boolean; onClick(): void; onDrop?(): void; menu?: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <li className={`group flex items-center rounded px-2 py-1 text-xs ${active ? 'bg-active text-strong' : over ? 'bg-hover' : 'text-ink hover:bg-hover'}`}
      onDragOver={onDrop ? (e) => { if (e.dataTransfer.types.includes('application/x-optic-photos')) { e.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop ? (e) => { e.preventDefault(); setOver(false); onDrop(); } : undefined}>
      <button className="min-w-0 flex-1 truncate text-start" onClick={onClick}>{label}</button>
      <span className="ms-2 text-2xs tabular-nums text-ink-faint">{count}</span>
      {menu}
    </li>
  );
}

export function Sidebar() {
  const photos = useLibrary((s) => s.photos);
  const collections = useLibrary((s) => s.collections);
  const source = useLibrary((s) => s.source);
  const lastImport = useLibrary((s) => s.lastImport);
  const lib = useLibrary.getState();
  const is = (s: Source) => JSON.stringify(s) === JSON.stringify(source);
  const go = (s: Source) => lib.set({ source: s });
  const manual = collections.filter((c) => c.kind === 'manual').sort((a, b) => a.name.localeCompare(b.name));
  const smart = collections.filter((c) => c.kind === 'smart').sort((a, b) => a.name.localeCompare(b.name));
  const count = (c: CollectionRecord) => (c.kind === 'smart' && c.filter ? photos.filter((p) => matchesFilter(p, c.filter!)).length : photos.filter((p) => p.collections.includes(c.id)).length);
  const newCollection = async () => {
    const name = await promptDialog({ title: tr('sidebar.new_collection'), label: tr('sidebar.collection_name'), initial: 'New collection', confirmLabel: tr('sidebar.create') });
    if (!name) return;
    const c: CollectionRecord = { id: crypto.randomUUID(), name, kind: 'manual', created: Date.now() };
    await lib.saveCollection(c);
    const ids = targetIds();
    if (ids.length && await confirmDialog({ title: tp('sidebar.add_selected', ids.length, { name: c.name }), confirmLabel: tr('sidebar.add_photos'), cancelLabel: tr('sidebar.not_now') })) await lib.addToCollection(c.id, ids);
  };
  const actions = (c: CollectionRecord) => (
    <span className="ms-1 hidden gap-1 group-focus-within:flex group-hover:flex [@media(pointer:coarse)]:flex">
      <IconButton className="text-2xs text-ink-faint hover:text-ink" label={tr('sidebar.rename_name', { name: c.name })}
        onClick={async () => { const n = await promptDialog({ title: tr('sidebar.rename_collection'), label: tr('sidebar.collection_name'), initial: c.name, confirmLabel: tr('sidebar.rename') }); if (n) void lib.saveCollection({ ...c, name: n }); }}>✎</IconButton>
      <IconButton className="text-2xs text-ink-faint hover:text-danger" label={tr('sidebar.delete_name_photos_stay_in_the', { name: c.name })}
        onClick={async () => { if (await confirmDialog({ title: tr('sidebar.delete_the_collection_name', { name: c.name }), message: tr('sidebar.the_photos_stay_in_the_library'), confirmLabel: tr('sidebar.delete_collection'), danger: true })) void lib.deleteCollection(c.id); }}>✕</IconButton>
    </span>
  );
  return (
    <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2" aria-label={tr('sidebar.library_sources')}>
      <div className="mb-1 px-2 text-2xs font-medium uppercase tracking-wider text-ink-faint">{tr('sidebar.catalog')}</div>
      <ul className="mb-3 space-y-0.5">
        <Item label={tr('sidebar.all_photographs')} count={photos.length} active={is({ kind: 'all' })} onClick={() => go({ kind: 'all' })} />
        <Item label={tr('sidebar.last_import')} count={lastImport.length} active={is({ kind: 'recent' })} onClick={() => go({ kind: 'recent' })} />
      </ul>
      <div className="mb-1 flex items-center justify-between px-2 text-2xs font-medium uppercase tracking-wider text-ink-faint">
        <span>{tr('sidebar.collections')}</span>
        <IconButton className="text-sm leading-none text-ink-dim hover:text-ink" label={tr('sidebar.new_collection')} onClick={() => void newCollection()}>+</IconButton>
      </div>
      <ul className="mb-3 space-y-0.5">
        {manual.map((c) => (
          <Item key={c.id} label={c.name} count={count(c)} active={is({ kind: 'collection', id: c.id })} onClick={() => go({ kind: 'collection', id: c.id })}
            onDrop={() => void lib.addToCollection(c.id, targetIds())} menu={actions(c)} />
        ))}
        {!manual.length && <li className="px-2 text-2xs text-ink-faint">{tr('sidebar.albums_you_fill_by_hand_drag')}</li>}
      </ul>
      <div className="mb-1 px-2 text-2xs font-medium uppercase tracking-wider text-ink-faint">{tr('sidebar.smart_collections')}</div>
      <ul className="space-y-0.5">
        {smart.map((c) => <Item key={c.id} label={c.name} count={count(c)} active={is({ kind: 'collection', id: c.id })} onClick={() => go({ kind: 'collection', id: c.id })} menu={actions(c)} />)}
        {!smart.length && <li className="px-2 text-2xs text-ink-faint">{tr('sidebar.set_filters_then_save_as_smart')}</li>}
      </ul>
    </nav>
  );
}
