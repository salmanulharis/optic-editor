import { t as tr } from '../../i18n';
/** The library (key G): sources, filter bar, grid and info panel. */
import { useRef } from 'react';
import { ACCEPT } from '../../io/decode/decodeClient';
import { removePhotos } from '../../library/actions';
import { exportRecipePack, importEdits } from '../../library/recipePack';
import { fromFiles, pickFiles, pickFolder, reviewImport } from '../../library/importer';
import { openPhoto } from '../../library/open';
import { filterActive, type SortKey, targetIds, useLibrary, useVisiblePhotos } from '../../state/libraryStore';
import { IconButton } from '../controls/IconButton';
import { Menu } from '../controls/Menu';
import { messageDialog } from '../feedback/dialogs';
import { toast } from '../feedback/toasts';
import { BatchMenu } from './BatchMenu';
import { FilterBar } from './FilterBar';
import { Grid } from './Grid';
import { InfoPanel } from './InfoPanel';
import { Sidebar } from './Sidebar';
import { SampleButton } from './SampleButton';
import { tp } from '../../i18n/format';

const SORTS: Array<[SortKey, string]> = [['captureDate', tr('libraryView.capture_date')], ['importDate', tr('libraryView.import_date')], ['editDate', tr('libraryView.edit_date')], ['fileName', tr('libraryView.file_name')], ['rating', tr('libraryView.rating')]];

/** Import buttons: files and folders (File System Access pickers where available, else inputs). */
export function ImportButtons({ big = false }: { big?: boolean }) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  // Import is the library's primary action: a filled button in both sizes.
  const cls = big ? 'rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hi' : 'rounded bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hi';
  const cls2 = big ? 'rounded border border-line px-4 py-2 text-sm text-ink hover:bg-hover' : 'rounded px-2 py-1 text-xs text-ink hover:bg-hover';
  return (
    <>
      <button className={cls} title={tr('libraryView.import_photos_ctrl_cmd_shift_i')} data-import-files
        onClick={async () => { const r = await pickFiles().catch(() => null); if (r === null) files.current?.click(); else if (r.length) reviewImport(r); }}>
        {big ? tr('libraryView.import_photos') : tr('libraryView.import')}
      </button>
      <button className={cls2} title={tr('libraryView.import_a_folder_and_its_sub')}
        onClick={async () => { const r = await pickFolder().catch(() => null); if (r === null) folder.current?.click(); else if (r.length) reviewImport(r); }}>
        {big ? tr('libraryView.import_a_folder') : tr('libraryView.folder')}
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
      <input type="search" placeholder={tr('libraryView.search_name_keyword_camera')} value={filter.text ?? ''} aria-label={tr('libraryView.search_photos')}
        className="input w-52" onChange={(e) => lib.setFilter({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      <button className={`rounded px-2 py-1 ${filterOpen || filterActive(filter) ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`} aria-pressed={filterOpen}
        onClick={() => lib.set({ filterOpen: !filterOpen })} title={tr('libraryView.filter_bar')}>{tr('libraryView.filter')}{filterActive(filter) ? ' •' : ''}</button>
      <div className="flex items-center gap-1 text-ink-dim">
        <label htmlFor="optic-sort" className="text-ink-dim">{tr('libraryView.sort')}</label>
        <select id="optic-sort" className="rounded border border-line bg-raise px-1 py-0.5 text-2xs text-ink" value={sort.key} onChange={(e) => lib.set({ sort: { ...sort, key: e.target.value as SortKey } })}>
          {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <IconButton className="text-ink hover:bg-hover" label={sort.dir === 'asc' ? tr('libraryView.sort_ascending') : tr('libraryView.sort_descending')}
          onClick={() => lib.set({ sort: { ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' } })}><span aria-hidden>{sort.dir === 'asc' ? '↑' : '↓'}</span></IconButton>
      </div>
      <label className="flex items-center gap-1 text-ink-dim" title={tr('libraryView.thumbnail_size')}>
        <span aria-hidden>▫</span>
        <input type="range" min={96} max={420} value={size} onChange={(e) => lib.set({ thumbSize: +e.target.value })} className="w-24 accent-control" aria-label={tr('libraryView.thumbnail_size')} />
        <span aria-hidden>◻</span>
      </label>
      <div className="flex-1" />
      <span className="text-2xs text-ink-faint" aria-live="polite">
        {nSel > 1 ? `${nSel} selected · ` : ''}{list.length === total ? `${total} photos` : `${list.length} of ${total} photos`}
      </span>
      <BatchMenu />
      <Menu label="⋯" ariaLabel={tr('libraryView.more_library_actions')} align="right" className="rounded px-2 py-1 text-ink hover:bg-hover" items={[
        { label: tr('libraryView.select_all_ctrl_cmd_a'), onSelect: () => lib.selectAll() },
        { label: tr('libraryView.select_none'), onSelect: () => lib.set({ selection: new Set() }) },
        { label: tr('libraryView.open_in_editor_e'), disabled: !lib.active, onSelect: () => lib.active && void openPhoto(lib.active) },
        { label: tr('libraryView.export_edits_recipe_pack'), disabled: !targetIds().length, onSelect: () => void exportRecipePack(targetIds()) },
        { label: tr('libraryView.import_edits_pack_or_optic_json'), onSelect: () => editsInput.current?.click() },
        { label: tr('libraryView.remove_from_library'), disabled: !targetIds().length, onSelect: () => void removePhotos(targetIds()) },
      ]} />
      <input ref={editsInput} type="file" multiple accept=".opticedits,.json,.zip" className="hidden" aria-hidden tabIndex={-1} onChange={async (e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (!files.length) return;
        const r = await importEdits(files);
        const applied = `Edits applied to ${r.applied} photo${r.applied === 1 ? '' : 's'}.`;
        if (r.unmatched.length) void messageDialog({ title: applied, message: tp('libraryView.not_in_library', r.unmatched.length), items: r.unmatched });
        else toast(applied);
      }} />
      <button className={`rounded px-2 py-1 ${infoOpen ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`} aria-pressed={infoOpen} onClick={() => lib.set({ infoOpen: !infoOpen })} title={tr('libraryView.info_panel_i')}>{tr('libraryView.info')}</button>
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
      <aside className="hidden w-56 shrink-0 flex-col border-e border-line bg-panel md:flex" aria-label={tr('libraryView.catalog_and_collections')}>
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
            <div className="text-base text-ink">{tr('libraryView.your_library_is_empty')}</div>
            <div className="max-w-md text-xs text-ink-dim">{tr('libraryView.drop_photos_or_folders_anywhere_or')}</div>
            <div className="flex gap-2"><ImportButtons big /></div>
            <SampleButton className="mt-1" />
          </div>
        ) : <Grid />}
      </main>
      {infoOpen && <InfoPanel />}
    </div>
  );
}
