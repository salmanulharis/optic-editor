/** Library sources: all photos, the last import, collections and smart collections. */
import { useState } from 'react';
import type { CollectionRecord } from '../../library/db';
import { type Source, matchesFilter, targetIds, useLibrary } from '../../state/libraryStore';

function Item({ label, count, active, onClick, onDrop, menu }: { label: string; count: number; active: boolean; onClick(): void; onDrop?(): void; menu?: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <li className={`group flex items-center rounded px-2 py-1 text-xs ${active ? 'bg-active text-strong' : over ? 'bg-hover' : 'text-ink hover:bg-hover'}`}
      onDragOver={onDrop ? (e) => { if (e.dataTransfer.types.includes('application/x-optic-photos')) { e.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop ? (e) => { e.preventDefault(); setOver(false); onDrop(); } : undefined}>
      <button className="min-w-0 flex-1 truncate text-left" onClick={onClick}>{label}</button>
      <span className="ml-2 text-[10px] tabular-nums text-ink-faint">{count}</span>
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
    const name = prompt('Name of the new collection', 'New collection');
    if (!name?.trim()) return;
    const c: CollectionRecord = { id: crypto.randomUUID(), name: name.trim(), kind: 'manual', created: Date.now() };
    await lib.saveCollection(c);
    const ids = targetIds();
    if (ids.length && confirm(`Add the ${ids.length} selected photo${ids.length > 1 ? 's' : ''} to “${c.name}”?`)) await lib.addToCollection(c.id, ids);
  };
  const actions = (c: CollectionRecord) => (
    <span className="ml-1 hidden gap-1 group-hover:flex">
      <button className="text-[10px] text-ink-faint hover:text-ink" title="Rename" aria-label={`Rename ${c.name}`}
        onClick={() => { const n = prompt('Rename collection', c.name); if (n?.trim()) void lib.saveCollection({ ...c, name: n.trim() }); }}>✎</button>
      <button className="text-[10px] text-ink-faint hover:text-[#e07070]" title="Delete collection (photos stay in the library)" aria-label={`Delete ${c.name}`}
        onClick={() => { if (confirm(`Delete the collection “${c.name}”? The photos stay in the library.`)) void lib.deleteCollection(c.id); }}>✕</button>
    </span>
  );
  return (
    <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2" aria-label="Library sources">
      <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Catalog</div>
      <ul className="mb-3 space-y-0.5">
        <Item label="All photographs" count={photos.length} active={is({ kind: 'all' })} onClick={() => go({ kind: 'all' })} />
        <Item label="Last import" count={lastImport.length} active={is({ kind: 'recent' })} onClick={() => go({ kind: 'recent' })} />
      </ul>
      <div className="mb-1 flex items-center justify-between px-2 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        <span>Collections</span>
        <button className="text-sm leading-none text-ink-dim hover:text-ink" title="New collection" aria-label="New collection" onClick={() => void newCollection()}>+</button>
      </div>
      <ul className="mb-3 space-y-0.5">
        {manual.map((c) => (
          <Item key={c.id} label={c.name} count={count(c)} active={is({ kind: 'collection', id: c.id })} onClick={() => go({ kind: 'collection', id: c.id })}
            onDrop={() => void lib.addToCollection(c.id, targetIds())} menu={actions(c)} />
        ))}
        {!manual.length && <li className="px-2 text-[11px] text-ink-faint">Albums you fill by hand. Drag photos onto one to add them.</li>}
      </ul>
      <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Smart collections</div>
      <ul className="space-y-0.5">
        {smart.map((c) => <Item key={c.id} label={c.name} count={count(c)} active={is({ kind: 'collection', id: c.id })} onClick={() => go({ kind: 'collection', id: c.id })} menu={actions(c)} />)}
        {!smart.length && <li className="px-2 text-[11px] text-ink-faint">Set filters, then “Save as smart collection”.</li>}
      </ul>
    </nav>
  );
}
