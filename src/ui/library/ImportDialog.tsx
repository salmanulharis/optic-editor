/** Import dialog: choose photos, storage mode, duplicates, preset, collection and keywords. */
import { useMemo } from 'react';
import { type ImportOptions, startImport, closeImportDialog, useImport } from '../../library/importer';
import { opfsAvailable } from '../../library/opfs';
import { openPhoto } from '../../library/open';
import { useLibrary } from '../../state/libraryStore';
import { usePresets } from '../../state/presetStore';

export function ImportDialog() {
  const open = useImport((s) => s.dialogOpen);
  const cands = useImport((s) => s.candidates);
  const skipped = useImport((s) => s.skipped);
  const canReference = useImport((s) => s.canReference);
  const o = useImport((s) => s.options);
  const openAfter = useImport((s) => s.openAfter);
  const allCollections = useLibrary((s) => s.collections);
  const collections = allCollections.filter((c) => c.kind === 'manual');
  const presets = usePresets((s) => s.ready);
  const allPresets = useMemo(() => (presets ? usePresets.getState().all() : []), [presets]);
  if (!open) return null;
  const set = (p: Partial<ImportOptions>) => useImport.getState().set({ options: { ...useImport.getState().options, ...p } });
  const setSel = (fn: (id: string, dup: boolean) => boolean) =>
    useImport.getState().set({ candidates: useImport.getState().candidates.map((c) => ({ ...c, selected: fn(c.id, !!c.duplicateOf) })) });
  const dups = cands.filter((c) => c.duplicateOf).length;
  const chosen = cands.filter((c) => c.selected && !(o.skipDuplicates && c.duplicateOf)).length;
  const checking = cands.some((c) => c.hash === undefined);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.target === e.currentTarget && closeImportDialog()}>
      <div role="dialog" aria-modal="true" aria-labelledby="import-title" className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-lg border border-line bg-panel text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') closeImportDialog(); }}>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 id="import-title" className="text-sm font-medium">Import {cands.length} photo{cands.length === 1 ? '' : 's'}</h2>
          <span className="text-[11px] text-ink-faint">
            {checking ? 'Checking for duplicates…' : dups ? `${dups} already in the library` : 'No duplicates'}
            {skipped.length ? ` · ${skipped.length} unsupported file${skipped.length > 1 ? 's' : ''} ignored` : ''}
          </span>
          <div className="flex-1" />
          <button className="text-[11px] text-ink-dim hover:text-ink" onClick={() => setSel((_, d) => !(o.skipDuplicates && d))}>Select all</button>
          <button className="text-[11px] text-ink-dim hover:text-ink" onClick={() => setSel(() => false)}>Select none</button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2 overflow-y-auto p-3" role="listbox" aria-multiselectable="true" aria-label="Photos to import">
          {cands.map((c) => (
            <button key={c.id} role="option" aria-selected={c.selected} title={c.path}
              className={`relative flex h-[120px] flex-col overflow-hidden rounded border text-left ${c.selected ? 'border-ink-dim bg-hover' : 'border-line bg-sunk opacity-60'}`}
              onClick={() => useImport.getState().set({ candidates: useImport.getState().candidates.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)) })}>
              <div className="flex min-h-0 flex-1 items-center justify-center p-1">
                {c.thumbUrl ? <img src={c.thumbUrl} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-ink-faint">{c.thumbUrl === null ? 'No preview yet' : '…'}</span>}
              </div>
              <div className="truncate px-1 pb-0.5 text-[10px] text-ink-dim">{c.file.name}</div>
              <span className={`absolute right-1 top-1 h-3.5 w-3.5 rounded-sm border ${c.selected ? 'border-white bg-white' : 'border-edge bg-black/40'}`} aria-hidden>
                {c.selected && <svg viewBox="0 0 12 12" className="h-full w-full"><path d="M2.5 6.5l2.2 2.2 4.8-5" fill="none" stroke="#000" strokeWidth="1.6" /></svg>}
              </span>
              {c.duplicateOf && <span className="absolute left-1 top-1 rounded bg-[#5a4a20] px-1 text-[9px] text-[#f0e0b0]">Duplicate</span>}
            </button>
          ))}
        </div>
        <div className="grid gap-x-6 gap-y-2 border-t border-line px-4 py-3 text-xs text-ink-dim md:grid-cols-2">
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Storage</legend>
            <label className="flex items-center gap-2"><input type="radio" name="mode" checked={o.mode === 'copy'} disabled={!opfsAvailable()} onChange={() => set({ mode: 'copy' })} />
              Copy into Optic <span className="text-ink-faint">(recommended; works offline and on Safari)</span></label>
            <label className={`flex items-center gap-2 ${canReference ? '' : 'opacity-40'}`}><input type="radio" name="mode" checked={o.mode === 'reference'} disabled={!canReference} onChange={() => set({ mode: 'reference' })} />
              Reference in place <span className="text-ink-faint">{canReference ? '(no copy; files must stay where they are)' : '(Chrome / Edge, via Folder or File picker)'}</span></label>
            <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={o.skipDuplicates} onChange={(e) => set({ skipDuplicates: e.target.checked })} /> Skip duplicates</label>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Apply during import</legend>
            <label className="flex items-center gap-2">Preset
              <select className="input min-w-0 flex-1" aria-label="Preset to apply" value={o.preset?.id ?? ''} onChange={(e) => set({ preset: e.target.value ? { id: e.target.value, amount: o.preset?.amount ?? 100 } : null })}>
                <option value="">None</option>
                {allPresets.map((p) => <option key={p.id} value={p.id}>{p.group} · {p.name}</option>)}
              </select>
              {o.preset && <input type="number" className="input w-16" min={0} max={200} value={o.preset.amount} aria-label="Preset amount (%)"
                onChange={(e) => set({ preset: { ...o.preset!, amount: Math.max(0, Math.min(200, +e.target.value || 0)) } })} />}
            </label>
            <label className="flex items-center gap-2">Collection
              <select className="input min-w-0 flex-1" aria-label="Add to collection" value={o.collectionId ?? (o.newCollection ? '__new' : '')} onChange={(e) => set(e.target.value === '__new' ? { collectionId: null, newCollection: 'New collection' } : { collectionId: e.target.value || null, newCollection: '' })}>
                <option value="">None</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new">New collection…</option>
              </select>
              {!o.collectionId && o.newCollection !== '' && <input className="input w-32" value={o.newCollection} aria-label="New collection name" onChange={(e) => set({ newCollection: e.target.value })} />}
            </label>
            <label className="flex items-center gap-2">Keywords
              <input className="input min-w-0 flex-1" placeholder="comma separated" value={o.keywords.join(', ')} onChange={(e) => set({ keywords: e.target.value.split(',').map((s) => s.trimStart()) })} />
            </label>
          </fieldset>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button className="rounded border border-line px-3 py-1 text-xs hover:bg-hover" onClick={closeImportDialog}>Cancel</button>
          <button className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={!chosen}
            onClick={() => void startImport(openAfter ? (id) => void openPhoto(id) : undefined)}>
            Import {chosen} photo{chosen === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Import queue progress (top bar). */
export function ImportProgress() {
  const q = useImport((s) => s.queue);
  if (!q.running && !q.errors.length) return null;
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-dim" role="status" aria-live="polite">
      {q.running ? (
        <>
          <span>Importing {Math.min(q.done + 1, q.total)} / {q.total}</span>
          <div className="h-1 w-20 overflow-hidden rounded bg-hover"><div className="h-full bg-meter" style={{ width: `${(q.done / Math.max(1, q.total)) * 100}%` }} /></div>
        </>
      ) : (
        <button className="text-[#e09090] hover:underline" title={q.errors.map((e) => `${e.name}: ${e.message}`).join('\n')}
          onClick={() => { alert(q.errors.map((e) => `${e.name}: ${e.message}`).join('\n')); useImport.getState().set({ queue: { ...q, errors: [] } }); }}>
          {q.errors.length} file{q.errors.length > 1 ? 's' : ''} could not be imported
        </button>
      )}
    </div>
  );
}
