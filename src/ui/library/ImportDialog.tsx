import { t as tr } from '../../i18n';
/** Import dialog: choose photos, storage mode, duplicates, preset, collection and keywords. */
import { useMemo, useRef } from 'react';
import { type ImportOptions, startImport, closeImportDialog, useImport } from '../../library/importer';
import { opfsAvailable } from '../../library/opfs';
import { openPhoto } from '../../library/open';
import { useLibrary } from '../../state/libraryStore';
import { usePresets } from '../../state/presetStore';
import { useFocusTrap } from '../focusTrap';
import { messageDialog } from '../feedback/dialogs';
import { tp } from '../../i18n/format';
import { sessionOnlyImports } from '../../library/sessionFiles';

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
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  if (!open) return null;
  const set = (p: Partial<ImportOptions>) => useImport.getState().set({ options: { ...useImport.getState().options, ...p } });
  const setSel = (fn: (id: string, dup: boolean) => boolean) =>
    useImport.getState().set({ candidates: useImport.getState().candidates.map((c) => ({ ...c, selected: fn(c.id, !!c.duplicateOf) })) });
  const dups = cands.filter((c) => c.duplicateOf).length;
  const chosen = cands.filter((c) => c.selected && !(o.skipDuplicates && c.duplicateOf)).length;
  const checking = cands.some((c) => c.hash === undefined);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.target === e.currentTarget && closeImportDialog()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="import-title" className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-lg border border-line bg-panel text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') closeImportDialog(); }}>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 id="import-title" className="text-sm font-medium">{tp('importDialog.import_photos', cands.length)}</h2>
          <span className="text-2xs text-ink-faint">
            {checking ? tr('importDialog.checking_for_duplicates') : dups ? tp('importDialog.already_in_library', dups) : tr('importDialog.no_duplicates')}
            {skipped.length ? tp('importDialog.unsupported_ignored', skipped.length) : ''}
          </span>
          <div className="flex-1" />
          <button className="text-2xs text-ink-dim hover:text-ink" onClick={() => setSel((_, d) => !(o.skipDuplicates && d))}>{tr('importDialog.select_all')}</button>
          <button className="text-2xs text-ink-dim hover:text-ink" onClick={() => setSel(() => false)}>{tr('importDialog.select_none')}</button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2 overflow-y-auto p-3" role="listbox" aria-multiselectable="true" aria-label={tr('importDialog.photos_to_import')}>
          {cands.map((c) => (
            <button key={c.id} role="option" aria-selected={c.selected} title={c.path}
              className={`relative flex h-[120px] flex-col overflow-hidden rounded border text-start ${c.selected ? 'border-ink-dim bg-hover' : 'border-line bg-sunk opacity-60'}`}
              onClick={() => useImport.getState().set({ candidates: useImport.getState().candidates.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)) })}>
              <div className="flex min-h-0 flex-1 items-center justify-center p-1">
                {c.thumbUrl ? <img src={c.thumbUrl} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-2xs text-ink-faint">{c.thumbUrl === null ? tr('importDialog.no_preview_yet') : '…'}</span>}
              </div>
              <div className="truncate px-1 pb-0.5 text-2xs text-ink-dim">{c.file.name}</div>
              <span className={`absolute end-1 top-1 h-3.5 w-3.5 rounded-sm border ${c.selected ? 'border-white bg-white' : 'border-edge bg-black/40'}`} aria-hidden>
                {c.selected && <svg viewBox="0 0 12 12" className="h-full w-full"><path d="M2.5 6.5l2.2 2.2 4.8-5" fill="none" stroke="#000" strokeWidth="1.6" /></svg>}
              </span>
              {c.duplicateOf && <span className="absolute start-1 top-1 rounded bg-amber-900/90 px-1 text-2xs text-amber-100">{tr('importDialog.duplicate')}</span>}
            </button>
          ))}
        </div>
        <div className="grid gap-x-6 gap-y-2 border-t border-line px-4 py-3 text-xs text-ink-dim md:grid-cols-2">
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink-faint">{tr('importDialog.storage')}</legend>
            <label className="flex items-center gap-2"><input type="radio" name="mode" checked={o.mode === 'copy'} disabled={!opfsAvailable()} onChange={() => set({ mode: 'copy' })} />{tr('importDialog.copy_into_optic')} <span className="text-ink-faint">{tr('importDialog.recommended_works_offline_and_on_safari')}</span></label>
            <label className={`flex items-center gap-2 ${canReference ? '' : 'opacity-40'}`}><input type="radio" name="mode" checked={o.mode === 'reference'} disabled={!canReference} onChange={() => set({ mode: 'reference' })} />{tr('importDialog.reference_in_place')} <span className="text-ink-faint">{canReference ? tr('importDialog.no_copy_files_must_stay_where') : tr('importDialog.chrome_edge_via_folder_or_file')}</span></label>
            {sessionOnlyImports(canReference, opfsAvailable()) && (
              <p role="note" className="mt-1 rounded border border-warn/40 px-2 py-1 text-xs text-ink">{tr('importDialog.session_only')}</p>
            )}
            <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={o.skipDuplicates} onChange={(e) => set({ skipDuplicates: e.target.checked })} /> {tr('importDialog.skip_duplicates')}</label>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink-faint">{tr('importDialog.apply_during_import')}</legend>
            <label className="flex items-center gap-2">{tr('importDialog.preset')}<select className="input min-w-0 flex-1" aria-label={tr('importDialog.preset_to_apply')} value={o.preset?.id ?? ''} onChange={(e) => set({ preset: e.target.value ? { id: e.target.value, amount: o.preset?.amount ?? 100 } : null })}>
                <option value="">{tr('importDialog.none')}</option>
                {allPresets.map((p) => <option key={p.id} value={p.id}>{p.group} · {p.name}</option>)}
              </select>
              {o.preset && <input type="number" className="input w-16" min={0} max={200} value={o.preset.amount} aria-label={tr('importDialog.preset_amount')}
                onChange={(e) => set({ preset: { ...o.preset!, amount: Math.max(0, Math.min(200, +e.target.value || 0)) } })} />}
            </label>
            <label className="flex items-center gap-2">{tr('importDialog.collection')}<select className="input min-w-0 flex-1" aria-label={tr('importDialog.add_to_collection')} value={o.collectionId ?? (o.newCollection ? '__new' : '')} onChange={(e) => set(e.target.value === '__new' ? { collectionId: null, newCollection: 'New collection' } : { collectionId: e.target.value || null, newCollection: '' })}>
                <option value="">{tr('importDialog.none')}</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new">{tr('importDialog.new_collection')}</option>
              </select>
              {!o.collectionId && o.newCollection !== '' && <input className="input w-32" value={o.newCollection} aria-label={tr('importDialog.new_collection_name')} onChange={(e) => set({ newCollection: e.target.value })} />}
            </label>
            <label className="flex items-center gap-2">{tr('importDialog.keywords')}<input className="input min-w-0 flex-1" placeholder={tr('importDialog.comma_separated')} value={o.keywords.join(', ')} onChange={(e) => set({ keywords: e.target.value.split(',').map((s) => s.trimStart()) })} />
            </label>
          </fieldset>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button className="rounded border border-line px-3 py-1 text-xs hover:bg-hover" onClick={closeImportDialog}>{tr('importDialog.cancel')}</button>
          <button className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={!chosen}
            onClick={() => void startImport(openAfter ? (id) => void openPhoto(id) : undefined)}>{tp('importDialog.import_photos', chosen)}
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
    <div className="flex items-center gap-2 text-2xs text-ink-dim" role="status" aria-live="polite">
      {q.running ? (
        <>
          <span>{tr('importDialog.importing_progress', { current: Math.min(q.done + 1, q.total), total: q.total })}</span>
          <div className="h-1 w-20 overflow-hidden rounded bg-hover"><div className="h-full bg-meter" style={{ width: `${(q.done / Math.max(1, q.total)) * 100}%` }} /></div>
        </>
      ) : (
        <button className="text-danger hover:underline"
          onClick={() => { void messageDialog({ title: tp('importDialog.files_failed', q.errors.length), items: q.errors.map((e) => `${e.name}: ${e.message}`) }); useImport.getState().set({ queue: { ...q, errors: [] } }); }}>
          {tp('importDialog.files_failed', q.errors.length)}</button>
      )}
    </div>
  );
}
