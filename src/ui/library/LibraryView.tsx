/** The library (key G): sources, filter bar, grid and info panel. */
import { useRef } from 'react';
import { ACCEPT } from '../../io/decode/decodeClient';
import { removePhotos } from '../../library/actions';
import { exportRecipePack, importEdits } from '../../library/recipePack';
import { fromFiles, pickFiles, pickFolder, reviewImport } from '../../library/importer';
import { openPhoto } from '../../library/open';
import { filterActive, type SortKey, targetIds, useLibrary, useVisiblePhotos } from '../../state/libraryStore';
import { Menu } from '../controls/Menu';
import { BatchMenu } from './BatchMenu';
import { FilterBar } from './FilterBar';
import { Grid } from './Grid';
import { InfoPanel } from './InfoPanel';
import { Sidebar } from './Sidebar';

const SORTS: Array<[SortKey, string]> = [['captureDate', 'Capture date'], ['importDate', 'Import date'], ['editDate', 'Edit date'], ['fileName', 'File name'], ['rating', 'Rating']];

/** Import buttons: files and folders (File System Access pickers where available, else inputs). */
export function ImportButtons({ big = false }: { big?: boolean }) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const cls = big ? 'rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hi' : 'rounded px-2 py-1 text-xs text-ink hover:bg-hover';
  const cls2 = big ? 'rounded border border-line px-4 py-2 text-sm text-ink hover:bg-hover' : 'rounded px-2 py-1 text-xs text-ink hover:bg-hover';
  return (
    <>
      <button className={cls} title="Import photos (Ctrl/Cmd+Shift+I)" data-import-files
        onClick={async () => { const r = await pickFiles().catch(() => null); if (r === null) files.current?.click(); else if (r.length) reviewImport(r); }}>
        {big ? 'Import photos' : 'Import…'}
      </button>
      <button className={cls2} title="Import a folder (and its sub-folders)"
        onClick={async () => { const r = await pickFolder().catch(() => null); if (r === null) folder.current?.click(); else if (r.length) reviewImport(r); }}>
        {big ? 'Import a folder' : 'Folder…'}
      </button>
      <input ref={files} type="file" multiple accept={ACCEPT} className="hidden" aria-hidden tabIndex={-1}
        onChange={(e) => { if (e.target.files?.length) reviewImport(fromFiles(e.target.files)); e.target.value = ''; }} />
      <input ref={folder} type="file" multiple className="hidden" aria-hidden tabIndex={-1} {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={(e) => { if (e.target.files?.length) reviewImport(fromFiles(e.target.files)); e.target.value = ''; }} />
    </>
  );
}

function Toolbar() {
  const editsInput = useRef<HTMLInputElement>(null);
  const sort = useLibrary((s) => s.sort);
  const size = useLibrary((s) => s.thumbSize);
  const filterOpen = useLibrary((s) => s.filterOpen);
  const filter = useLibrary((s) => s.filter);
  const infoOpen = useLibrary((s) => s.infoOpen);
  const nSel = useLibrary((s) => s.selection.size);
  const list = useVisiblePhotos();
  const total = useLibrary((s) => s.photos.length);
  const lib = useLibrary.getState();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1.5 text-xs">
      <ImportButtons />
      <span className="mx-1 h-4 w-px bg-line" />
      <input type="search" placeholder="Search name, keyword, camera" value={filter.text ?? ''} aria-label="Search photos"
        className="input w-52" onChange={(e) => lib.setFilter({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      <button className={`rounded px-2 py-1 ${filterOpen || filterActive(filter) ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`} aria-pressed={filterOpen}
        onClick={() => lib.set({ filterOpen: !filterOpen })} title="Filter bar">Filter{filterActive(filter) ? ' •' : ''}</button>
      <label className="flex items-center gap-1 text-ink-dim">Sort
        <select className="rounded border border-line bg-raise px-1 py-0.5 text-[11px] text-ink" aria-label="Sort by" value={sort.key} onChange={(e) => lib.set({ sort: { ...sort, key: e.target.value as SortKey } })}>
          {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="rounded px-1 text-ink hover:bg-hover" title={sort.dir === 'asc' ? 'Ascending' : 'Descending'} aria-label="Sort direction"
          onClick={() => lib.set({ sort: { ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' } })}>{sort.dir === 'asc' ? '↑' : '↓'}</button>
      </label>
      <label className="flex items-center gap-1 text-ink-dim" title="Thumbnail size">
        <span aria-hidden>▫</span>
        <input type="range" min={96} max={420} value={size} onChange={(e) => lib.set({ thumbSize: +e.target.value })} className="w-24 accent-[#9a9a9a]" aria-label="Thumbnail size" />
        <span aria-hidden>◻</span>
      </label>
      <div className="flex-1" />
      <span className="text-[11px] text-ink-faint" aria-live="polite">
        {nSel > 1 ? `${nSel} selected · ` : ''}{list.length === total ? `${total} photos` : `${list.length} of ${total} photos`}
      </span>
      <BatchMenu />
      <Menu label="⋯" ariaLabel="More library actions" align="right" className="rounded px-2 py-1 text-ink hover:bg-hover" items={[
        { label: 'Select all (Ctrl/Cmd+A)', onSelect: () => lib.selectAll() },
        { label: 'Select none', onSelect: () => lib.set({ selection: new Set() }) },
        { label: 'Open in editor (E)', disabled: !lib.active, onSelect: () => lib.active && void openPhoto(lib.active) },
        { label: 'Export edits (recipe pack)…', disabled: !targetIds().length, onSelect: () => void exportRecipePack(targetIds()) },
        { label: 'Import edits (pack or .optic.json)…', onSelect: () => editsInput.current?.click() },
        { label: 'Remove from library…', disabled: !targetIds().length, onSelect: () => void removePhotos(targetIds()) },
      ]} />
      <input ref={editsInput} type="file" multiple accept=".opticedits,.json,.zip" className="hidden" aria-hidden tabIndex={-1} onChange={async (e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (!files.length) return;
        const r = await importEdits(files);
        alert(`Edits applied to ${r.applied} photo${r.applied === 1 ? '' : 's'}.${r.unmatched.length ? `
Not in the library: ${r.unmatched.slice(0, 10).join(', ')}${r.unmatched.length > 10 ? '…' : ''}` : ''}`);
      }} />
      <button className={`rounded px-2 py-1 ${infoOpen ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`} aria-pressed={infoOpen} onClick={() => lib.set({ infoOpen: !infoOpen })} title="Info panel (I)">Info</button>
    </div>
  );
}

export function LibraryView() {
  const total = useLibrary((s) => s.photos.length);
  const ready = useLibrary((s) => s.ready);
  const filterOpen = useLibrary((s) => s.filterOpen);
  const infoOpen = useLibrary((s) => s.infoOpen);
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <Sidebar />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        {filterOpen && <FilterBar />}
        {ready && total === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <svg viewBox="0 0 24 24" className="h-12 w-12 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
              <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 8" />
            </svg>
            <div className="text-base text-ink">Your library is empty</div>
            <div className="max-w-md text-xs text-ink-dim">Drop photos or folders anywhere, or import them. RAW (DNG, ProRAW, CR2/CR3, NEF, ARW, RAF, RW2, ORF), HEIC, JPEG, PNG, TIFF, WebP and AVIF. Everything stays on this device.</div>
            <div className="flex gap-2"><ImportButtons big /></div>
          </div>
        ) : <Grid />}
      </main>
      {infoOpen && <InfoPanel />}
    </div>
  );
}
