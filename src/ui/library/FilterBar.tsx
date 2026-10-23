/**
 * Filter bar: text search (file name, keywords, camera, lens), rating, flag, colour labels, file
 * type, RAW / non-RAW, edited, camera, lens, date range, keyword and preset; "Save as smart
 * collection" stores the current filter.
 */
import { useMemo } from 'react';
import { COLOR_LABELS, LABEL_CSS, type LibraryFilter } from '../../library/db';
import { filterActive, formatGroup, useLibrary } from '../../state/libraryStore';

const sel = 'rounded border border-line bg-raise px-1.5 py-0.5 text-[11px] text-ink outline-none';

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
    const name = prompt('Name of the smart collection', 'Smart collection');
    if (!name) return;
    await lib.saveCollection({ id: crypto.randomUUID(), name, kind: 'smart', filter: { ...f }, created: Date.now() });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunk px-3 py-2 text-[11px] text-ink-dim" role="search" aria-label="Filter photos">
      <label className="flex items-center gap-1">Rating
        <select className={sel} value={f.ratingOp ?? '>='} onChange={(e) => set({ ratingOp: e.target.value as LibraryFilter['ratingOp'] })} aria-label="Rating comparison">
          <option value=">=">≥</option><option value="==">=</option><option value="<=">≤</option>
        </select>
        <select className={sel} value={f.minRating ?? 0} onChange={(e) => set({ minRating: +e.target.value })} aria-label="Rating">
          {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n ? '★'.repeat(n) : 'Any'}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">Flag
        <select className={sel} value={f.flag ?? 'any'} onChange={(e) => set({ flag: e.target.value as LibraryFilter['flag'] })}>
          <option value="any">Any</option><option value="picked">Picked</option><option value="notRejected">Not rejected</option>
          <option value="unflagged">Unflagged</option><option value="rejected">Rejected</option>
        </select>
      </label>
      <div className="flex items-center gap-1" role="group" aria-label="Color labels">
        {COLOR_LABELS.map((l) => {
          const on = f.labels?.includes(l);
          return (
            <button key={l} type="button" aria-pressed={!!on} title={`${l} label`}
              className={`h-3.5 w-3.5 rounded-full border ${on ? 'border-white' : 'border-black/50 opacity-60 hover:opacity-100'}`}
              style={{ background: LABEL_CSS[l] }}
              onClick={() => set({ labels: on ? f.labels!.filter((x) => x !== l) : [...(f.labels ?? []), l] })} />
          );
        })}
      </div>
      <label className="flex items-center gap-1">Type
        <select className={sel} value={f.formats?.[0] ?? ''} onChange={(e) => set({ formats: e.target.value ? [e.target.value] : [] })}>
          <option value="">All</option>{opts.formats.map((x) => <option key={x}>{x}</option>)}
        </select>
      </label>
      <select className={sel} value={f.raw ?? 'any'} onChange={(e) => set({ raw: e.target.value as LibraryFilter['raw'] })} aria-label="RAW or not">
        <option value="any">RAW + non-RAW</option><option value="raw">RAW only</option><option value="nonRaw">Non-RAW only</option>
      </select>
      <select className={sel} value={f.edited ?? 'any'} onChange={(e) => set({ edited: e.target.value as LibraryFilter['edited'] })} aria-label="Edited">
        <option value="any">Edited + unedited</option><option value="edited">Edited</option><option value="unedited">Unedited</option>
      </select>
      {opts.cameras.length > 0 && (
        <select className={`${sel} max-w-[140px]`} value={f.camera ?? ''} onChange={(e) => set({ camera: e.target.value || undefined })} aria-label="Camera">
          <option value="">Any camera</option>{opts.cameras.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      {opts.lenses.length > 0 && (
        <select className={`${sel} max-w-[140px]`} value={f.lens ?? ''} onChange={(e) => set({ lens: e.target.value || undefined })} aria-label="Lens">
          <option value="">Any lens</option>{opts.lenses.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      <label className="flex items-center gap-1">From
        <input type="date" className={sel} value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined, lastDays: undefined })} />
      </label>
      <label className="flex items-center gap-1">to
        <input type="date" className={sel} value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined, lastDays: undefined })} />
      </label>
      <select className={sel} value={f.lastDays ?? 0} onChange={(e) => set({ lastDays: +e.target.value || undefined, from: undefined, to: undefined })} aria-label="Captured within">
        <option value={0}>Any time</option><option value={1}>Last 24 h</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={365}>Last year</option>
      </select>
      {opts.keywords.length > 0 && (
        <select className={`${sel} max-w-[130px]`} value={f.keyword ?? ''} onChange={(e) => set({ keyword: e.target.value || undefined })} aria-label="Keyword">
          <option value="">Any keyword</option>{opts.keywords.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      {opts.presets.length > 0 && (
        <select className={`${sel} max-w-[140px]`} value={f.preset ?? ''} onChange={(e) => set({ preset: e.target.value || undefined })} aria-label="Preset used">
          <option value="">Any preset</option>{opts.presets.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
      <div className="flex-1" />
      {filterActive(f) && (
        <>
          <button className="text-ink-dim hover:text-ink" onClick={() => void saveSmart()}>Save as smart collection</button>
          <button className="text-ink-dim hover:text-ink" onClick={() => lib.clearFilter()}>Clear filters</button>
        </>
      )}
    </div>
  );
}
