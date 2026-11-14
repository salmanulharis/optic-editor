/**
 * Filter bar: text search (file name, keywords, camera, lens), rating, flag, colour labels, file
 * type, RAW / non-RAW, edited, camera, lens, date range, keyword and preset; "Save as smart
 * collection" stores the current filter.
 */
import { useMemo } from 'react';
import { COLOR_LABELS, LABEL_CSS, type LibraryFilter } from '../../library/db';
import { filterActive, formatGroup, useLibrary } from '../../state/libraryStore';
import { promptDialog } from '../feedback/dialogs';
import { t as tr } from '../../i18n';

const sel = 'rounded border border-line bg-raise px-1.5 py-0.5 text-2xs text-ink outline-none';

export function FilterBar() {
  const f = useLibrary((s) => s.filter);
  const photos = useLibrary((s) => s.photos);
  const lib = useLibrary.getState();
  const opts = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      cameras: uniq(photos.map((p) => p.camera)),
      lenses: uniq(photos.map((p) => p.lens)),
      keywords: uniq(photos.flatMap((p) => p.keywords)),
      presets: uniq(photos.map((p) => p.preset ?? '')),
      formats: uniq(photos.map((p) => formatGroup(p))),
    };
  }, [photos]);
  const set = (p: Partial<LibraryFilter>) => lib.setFilter(p);
  const saveSmart = async () => {
    const name = await promptDialog({ title: tr('filterBar.save_as_smart_collection'), label: tr('filterBar.collection_name'), initial: 'Smart collection', confirmLabel: tr('filterBar.save') });
    if (!name) return;
    await lib.saveCollection({ id: crypto.randomUUID(), name, kind: 'smart', filter: { ...f }, created: Date.now() });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunk px-3 py-2 text-2xs text-ink-dim" role="search" aria-label={tr('filterBar.filter_photos')}>
      <label className="flex items-center gap-1">{tr('filterBar.rating')}<select className={sel} value={f.ratingOp ?? '>='} onChange={(e) => set({ ratingOp: e.target.value as LibraryFilter['ratingOp'] })} aria-label={tr('filterBar.rating_comparison')}>
          <option value=">=">≥</option><option value="==">=</option><option value="<=">≤</option>
        </select>
        <select className={sel} value={f.minRating ?? 0} onChange={(e) => set({ minRating: +e.target.value })} aria-label={tr('filterBar.rating')}>
          {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n ? '★'.repeat(n) : tr('filterBar.any')}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">{tr('filterBar.flag')}<select className={sel} value={f.flag ?? 'any'} onChange={(e) => set({ flag: e.target.value as LibraryFilter['flag'] })}>
          <option value="any">{tr('filterBar.any')}</option><option value="picked">{tr('filterBar.picked')}</option><option value="notRejected">{tr('filterBar.not_rejected')}</option>
          <option value="unflagged">{tr('filterBar.unflagged')}</option><option value="rejected">{tr('filterBar.rejected')}</option>
        </select>
      </label>
      <div className="flex items-center gap-1" role="group" aria-label={tr('filterBar.color_labels')}>
        {COLOR_LABELS.map((l) => {
          const on = f.labels?.includes(l);
          return (
            <button key={l} type="button" aria-pressed={!!on} title={tr('filterBar.l_label', { l: l })}
              className={`h-3.5 w-3.5 rounded-full border ${on ? 'border-white' : 'border-black/50 opacity-60 hover:opacity-100'}`}
              style={{ background: LABEL_CSS[l] }}
              onClick={() => set({ labels: on ? f.labels!.filter((x) => x !== l) : [...(f.labels ?? []), l] })} />
          );
        })}
      </div>
      <label className="flex items-center gap-1">{tr('filterBar.type')}<select className={sel} value={f.formats?.[0] ?? ''} onChange={(e) => set({ formats: e.target.value ? [e.target.value] : [] })}>
          <option value="">{tr('filterBar.all')}</option>{opts.formats.map((x) => <option key={x}>{x}</option>)}
        </select>
      </label>
      <select className={sel} value={f.raw ?? 'any'} onChange={(e) => set({ raw: e.target.value as LibraryFilter['raw'] })} aria-label={tr('filterBar.raw_or_not')}>
        <option value="any">{tr('filterBar.raw_non_raw')}</option><option value="raw">{tr('filterBar.raw_only')}</option><option value="nonRaw">{tr('filterBar.non_raw_only')}</option>
      </select>
      <select className={sel} value={f.edited ?? 'any'} onChange={(e) => set({ edited: e.target.value as LibraryFilter['edited'] })} aria-label={tr('filterBar.edited')}>
        <option value="any">{tr('filterBar.edited_unedited')}</option><option value="edited">{tr('filterBar.edited')}</option><option value="unedited">{tr('filterBar.unedited')}</option>
      </select>
      {opts.cameras.length > 0 && (
        <select className={`${sel} max-w-[140px]`} value={f.camera ?? ''} onChange={(e) => set({ camera: e.target.value || undefined })} aria-label={tr('filterBar.camera')}>
          <option value="">{tr('filterBar.any_camera')}</option>{opts.cameras.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      {opts.lenses.length > 0 && (
        <select className={`${sel} max-w-[140px]`} value={f.lens ?? ''} onChange={(e) => set({ lens: e.target.value || undefined })} aria-label={tr('filterBar.lens')}>
          <option value="">{tr('filterBar.any_lens')}</option>{opts.lenses.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      <label className="flex items-center gap-1">{tr('filterBar.from')}<input type="date" className={sel} value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined, lastDays: undefined })} />
      </label>
      <label className="flex items-center gap-1">{tr('filterBar.to')}<input type="date" className={sel} value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined, lastDays: undefined })} />
      </label>
      <select className={sel} value={f.lastDays ?? 0} onChange={(e) => set({ lastDays: +e.target.value || undefined, from: undefined, to: undefined })} aria-label={tr('filterBar.captured_within')}>
        <option value={0}>{tr('filterBar.any_time')}</option><option value={1}>{tr('filterBar.last_24_h')}</option><option value={7}>{tr('filterBar.last_7_days')}</option><option value={30}>{tr('filterBar.last_30_days')}</option><option value={365}>{tr('filterBar.last_year')}</option>
      </select>
      {opts.keywords.length > 0 && (
        <select className={`${sel} max-w-[130px]`} value={f.keyword ?? ''} onChange={(e) => set({ keyword: e.target.value || undefined })} aria-label={tr('filterBar.keyword')}>
          <option value="">{tr('filterBar.any_keyword')}</option>{opts.keywords.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      {opts.presets.length > 0 && (
        <select className={`${sel} max-w-[140px]`} value={f.preset ?? ''} onChange={(e) => set({ preset: e.target.value || undefined })} aria-label={tr('filterBar.preset_used')}>
          <option value="">{tr('filterBar.any_preset')}</option>{opts.presets.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      <div className="flex-1" />
      {filterActive(f) && (
        <>
          <button className="text-ink-dim hover:text-ink" onClick={() => void saveSmart()}>{tr('filterBar.save_as_smart_collection')}</button>
          <button className="text-ink-dim hover:text-ink" onClick={() => lib.clearFilter()}>{tr('filterBar.clear_filters')}</button>
        </>
      )}
    </div>
  );
}
