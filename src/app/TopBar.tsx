import { type ReactNode, useRef } from 'react';
import { ACCEPT } from '../io/decode/decodeClient';
import { activeCopy, useEdit } from '../state/editStore';
import { type LoadedImage, useImage } from '../state/imageStore';
import { type CompareMode, useUi } from '../state/uiStore';
import { ExportProgress } from '../ui/export/ExportProgress';
import { ImportProgress } from '../ui/library/ImportDialog';
import { BatchMenu, BatchProgress, useBatchMenuItems } from '../ui/library/BatchMenu';
import { IconButton } from '../ui/controls/IconButton';
import { Menu } from '../ui/controls/Menu';
import { WIDE_QUERY, XL_QUERY, useMediaQuery } from '../ui/mobile/layout';
import { PwaStatus } from '../ui/PwaStatus';
import { useLibrary } from '../state/libraryStore';
import { openPhoto } from '../library/open';
import { openFile } from './openFile';
import { t as tr } from '../i18n';

export function badgeFor(img: LoadedImage): string {
  if (img.isRaw) return `RAW · ${img.bitDepth}-bit`;
  const name = { heic: 'HEIC', jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF', webp: 'WebP', avif: 'AVIF', dng: 'DNG', raw: 'RAW' }[img.format];
  return `${name} · ${img.bitDepth === 32 ? '32-bit float' : `${img.bitDepth}-bit`}`;
}

function fmtShutter(s?: number) {
  if (!s) return null;
  return s >= 0.5 ? `${+s.toFixed(1)} s` : `1/${Math.round(1 / s)} s`;
}

const Btn = (p: { onClick(): void; children: ReactNode; title?: string; active?: boolean; disabled?: boolean; expanded?: boolean; controls?: string }) => (
  <button
    title={p.title}
    disabled={p.disabled}
    aria-expanded={p.expanded}
    aria-controls={p.expanded ? p.controls : undefined}
    onClick={p.onClick}
    className={`rounded px-2 py-1 text-xs disabled:opacity-30 ${p.active ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`}
  >
    {p.children}
  </button>
);

const COMPARE_LABEL: Record<CompareMode, string> = { get off() { return tr('topBar.compare'); }, get split() { return tr('topBar.split'); }, get side() { return tr('topBar.side_by_side'); } };
const NEXT_COMPARE: Record<CompareMode, CompareMode> = { off: 'split', split: 'side', side: 'off' };

/** Compare view (Y cycles), its "Before" source, split orientation and swap. */
function CompareControls({ disabled }: { disabled: boolean }) {
  const mode = useUi((s) => s.compareMode);
  const source = useUi((s) => s.compareSource);
  const vertical = useUi((s) => s.compareVertical);
  const copies = useEdit((s) => s.copies);
  const active = useEdit((s) => s.active);
  const cur = useEdit((s) => activeCopy(s));
  const set = useUi.getState().set;
  return (
    <div className="flex items-center gap-0.5 border-s border-line ps-2">
      <Btn onClick={() => set({ compareMode: NEXT_COMPARE[mode] })} active={mode !== 'off'} disabled={disabled} title={tr('topBar.compare_views_split_side_by_side')}>
        {COMPARE_LABEL[mode]}
      </Btn>
      {mode !== 'off' && (
        <>
          <select
            className="max-w-[150px] rounded border border-line bg-raise px-1 py-0.5 text-2xs text-ink outline-none"
            value={source}
            title={tr('topBar.what_the_before_side_shows')}
            onChange={(e) => set({ compareSource: e.target.value })}
          >
            <option value="original">{tr('topBar.original_no_edits')}</option>
            <option value="session">{tr('topBar.as_opened_this_session')}</option>
            {cur.snapshots.length > 0 && (
              <optgroup label={tr('topBar.snapshots')}>
                {cur.snapshots.map((s) => <option key={s.id} value={`snap:${s.id}`}>{s.name}</option>)}
              </optgroup>
            )}
            {copies.length > 1 && (
              <optgroup label={tr('topBar.virtual_copies')}>
                {copies.filter((c) => c.id !== active).map((c) => <option key={c.id} value={`copy:${c.id}`}>{c.name}</option>)}
              </optgroup>
            )}
            <optgroup label={tr('topBar.history')}>
              {cur.steps.map((s, i) => <option key={i} value={`step:${i}`}>{i + 1}. {s.label}</option>).reverse()}
            </optgroup>
          </select>
          {mode === 'split' && (
            <Btn onClick={() => set({ compareVertical: !vertical })} title={tr('topBar.split_orientation')}>{vertical ? '⇆' : '⇅'}</Btn>
          )}
          <Btn onClick={() => set({ compareSwap: !useUi.getState().compareSwap })} title={tr('topBar.swap_before_after')}>⇄</Btn>
        </>
      )}
    </div>
  );
}

export function TopBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const image = useImage((s) => s.image);
  const zoom = useUi((s) => s.zoom);
  const fitScale = useUi((s) => s.fitScale);
  const showBefore = useUi((s) => s.showBefore);
  const canUndo = useEdit((s) => activeCopy(s).index > 0 || s.recipe !== s.committed);
  const canRedo = useEdit((s) => { const c = activeCopy(s); return c.index < c.steps.length - 1; });
  const cropMode = useUi((s) => s.cropMode);
  const masksOpen = useUi((s) => s.masksOpen);
  const pct = Math.round((zoom === 'fit' ? fitScale : zoom) * 100);
  const setZoom = (z: 'fit' | number) => {
    if (!image) return;
    const ui = useUi.getState();
    const center = ui.zoom === 'fit' ? { x: image.width / 2, y: image.height / 2 } : ui.center;
    ui.set({ zoom: z, center });
  };
  const i = image?.info;
  const infoParts = image
    ? [
        `${image.width} × ${image.height}`,
        [i?.make && !i?.model?.startsWith(i.make) ? i.make : '', i?.model].filter(Boolean).join(' '),
        i?.iso ? `ISO ${i.iso}` : null,
        fmtShutter(i?.shutter),
        i?.aperture ? `ƒ/${+i.aperture.toFixed(1)}` : null,
        i?.focalLength ? `${+i.focalLength.toFixed(1)} mm` : null,
      ].filter(Boolean)
    : [];

  const view = useLibrary((s) => s.view);
  const libActive = useLibrary((s) => s.active);
  const toEditor = () => {
    const id = useImage.getState().photoId ?? libActive;
    if (id && useImage.getState().photoId !== id) void openPhoto(id);
    else useLibrary.getState().set({ view: 'editor' });
  };
  const wide = useMediaQuery(WIDE_QUERY);
  const xl = useMediaQuery(XL_QUERY);
  const presetsDrawer = useUi((s) => s.presetsDrawer);
  const panelsHidden = useUi((s) => s.panelsHidden);
  const batchItems = useBatchMenuItems();
  const openSettings = () => useUi.getState().set({ settingsOpen: true });
  const openShortcuts = () => useUi.getState().set({ shortcutsOpen: true });
  const editor = view === 'editor';
  const group = 'flex shrink-0 items-center gap-0.5 border-l border-line pl-2';
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2 lg:gap-2">
      {/* Navigation and file */}
      <h1 className="px-1 text-sm font-semibold tracking-wide text-ink">{tr('topBar.optic')}<span className="sr-only">: {view === 'library' ? tr('topBar.library') : image ? image.fileName : tr('topBar.editor')}</span>
      </h1>
      <div className="flex shrink-0 rounded border border-line p-0.5" role="tablist" aria-label={tr('topBar.view')}>
        <button role="tab" aria-selected={view === 'library'} className={`rounded px-2 py-0.5 text-xs ${view === 'library' ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}
          onClick={() => useLibrary.getState().set({ view: 'library' })} title={tr('topBar.library_g')}>{tr('topBar.library')}</button>
        <button role="tab" aria-selected={editor} className={`rounded px-2 py-0.5 text-xs ${editor ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}
          onClick={toEditor} title={tr('topBar.edit_e')}>{tr('topBar.edit')}</button>
      </div>
      {editor && !wide && (
        <Btn onClick={() => useUi.getState().set({ presetsDrawer: !presetsDrawer })} active={presetsDrawer}
          title={tr('topBar.presets_and_history')} expanded={presetsDrawer} controls="presets-drawer">{tr('topBar.presets')}</Btn>
      )}
      <ImportProgress />
      <BatchProgress />
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
        }}
      />
      {editor && image ? (
        <div className="flex min-w-[120px] flex-1 items-center gap-2 overflow-hidden">
          <span className="truncate text-xs text-ink" title={image.fileName}>{image.fileName}</span>
          <span className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-2xs uppercase tracking-wider text-ink-dim lg:inline" title={tr('topBar.decoded_with_decoder', { decoder: image.decoder })}>
            {badgeFor(image)}
          </span>
          <span className="hidden truncate text-2xs text-ink-faint xl:inline">{infoParts.join(' · ')}</span>
        </div>
      ) : <div className="flex-1" />}
      <PwaStatus />
      <ExportProgress />
      {(!editor || xl) && (<>
        {editor && <Btn onClick={() => inputRef.current?.click()} title={tr('topBar.open_a_photo_ctrl_cmd_o')}>{tr('topBar.open')}</Btn>}
        {editor && <BatchMenu />}
        <IconButton className="px-1.5 text-sm text-ink-dim hover:bg-hover hover:text-ink" label={tr('topBar.settings')} shortcut="Ctrl/Cmd+," onClick={openSettings}>⚙</IconButton>
        <IconButton className="px-1.5 text-xs text-ink-dim hover:bg-hover hover:text-ink" label={tr('topBar.keyboard_shortcuts')} shortcut="?" onClick={openShortcuts}>?</IconButton>
      </>)}
      {editor && (<>
        {/* View */}
        <div className={group}>
          <ZoomControl zoom={zoom} pct={pct} disabled={!image} setZoom={setZoom} />
        </div>
        {/* Tools */}
        <div className={group}>
          <Btn onClick={() => useUi.getState().set({ cropMode: !cropMode, tool: 'none', masksOpen: false })} active={cropMode} disabled={!image} title={tr('topBar.crop_straighten_r')}>{tr('topBar.crop')}</Btn>
          <Btn onClick={() => useUi.getState().set({ masksOpen: !masksOpen, cropMode: false, tool: 'none', maskPick: false })} active={masksOpen} disabled={!image} title={tr('topBar.masks_local_adjustments_m')}>{tr('topBar.masks')}</Btn>
        </div>
        <CompareControls disabled={!image} />
        <div className={group}>
          <button
            disabled={!image}
            title={tr('topBar.before_after_hold')}
            className={`rounded px-2 py-1 text-xs disabled:opacity-30 ${showBefore ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`}
            onPointerDown={() => useUi.getState().set({ showBefore: true })}
            onPointerUp={() => useUi.getState().set({ showBefore: false })}
            onPointerLeave={() => showBefore && useUi.getState().set({ showBefore: false })}
          >
            {showBefore ? tr('topBar.before') : tr('topBar.before_after')}
          </button>
        </div>
        {/* History, layout, overflow, then the primary action */}
        <div className={group}>
          <IconButton className="px-1 text-ink hover:bg-hover disabled:opacity-30" label={tr('topBar.undo')} shortcut="Ctrl/Cmd+Z" disabled={!canUndo} onClick={() => useEdit.getState().undo()}>↶</IconButton>
          <IconButton className="px-1 text-ink hover:bg-hover disabled:opacity-30" label={tr('topBar.redo')} shortcut="Ctrl/Cmd+Shift+Z" disabled={!canRedo} onClick={() => useEdit.getState().redo()}>↷</IconButton>
          <IconButton className={`px-1 hover:bg-hover ${panelsHidden ? 'bg-active text-strong' : 'text-ink'}`} label={panelsHidden ? tr('topBar.show_the_side_panels') : tr('topBar.hide_the_side_panels')} shortcut="F"
            onClick={() => useUi.getState().set({ panelsHidden: !panelsHidden, presetsDrawer: false })}>
            <PanelsIcon />
          </IconButton>
          {!xl && (
            <Menu label="⋯" ariaLabel={tr('topBar.more_actions')} align="right" className="hit rounded px-1.5 text-ink hover:bg-hover" items={[
              { label: tr('topBar.photo'), heading: true },
              { label: tr('topBar.open_a_photo'), hint: tr('topBar.ctrl_cmd_o_imports_it_into'), onSelect: () => inputRef.current?.click() },
              { label: tr('topBar.batch'), heading: true },
              ...batchItems,
              { label: tr('topBar.optic'), heading: true },
              { label: tr('topBar.settings'), hint: tr('topBar.ctrl_cmd'), onSelect: openSettings },
              { label: tr('topBar.keyboard_shortcuts'), hint: '?', onSelect: openShortcuts },
            ]} />
          )}
        </div>
        <button
          disabled={!image}
          onClick={() => useUi.getState().set({ exportOpen: true })}
          className="shrink-0 rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-30"
          title={tr('topBar.export_ctrl_cmd_e')}
        >{tr('topBar.export')}</button>
      </>)}
    </header>
  );
}

/** Two side columns around the photo (hide / show the side panels). */
function PanelsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M8 5v14M16 5v14" />
    </svg>
  );
}

/** Zoom as one control: the current scale on the button, Fit / 100 % / 200 % in its menu. */
function ZoomControl({ zoom, pct, disabled, setZoom }: { zoom: 'fit' | number; pct: number; disabled: boolean; setZoom(z: 'fit' | number): void }) {
  const label = zoom === 'fit' ? tr('topBar.fit_pct', { pct }) : `${pct}%`;
  if (disabled) return <span className="px-2 py-1 text-xs text-ink-faint opacity-30">{tr('topBar.zoom')}</span>;
  const item = (z: 'fit' | number, text: string, hint?: string) => ({ label: `${zoom === z ? '✓ ' : ''}${text}`, hint, onSelect: () => setZoom(z) });
  return (
    <Menu label={<span className="tabular-nums">{label} <span aria-hidden className="text-ink-faint">▾</span></span>} ariaLabel={tr('topBar.zoom_label', { label: label })}
      title={tr('topBar.zoom_z_toggles_fit_100')} className="min-w-[88px] rounded px-2 py-1 text-xs text-ink hover:bg-hover" items={[
        item('fit', tr('topBar.fit'), 'Z'),
        item(1, '100%', 'Z'),
        item(2, '200%'),
      ]} />
  );
}
