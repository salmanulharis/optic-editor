import { t as tr } from '../../i18n';
/**
 * Preset browser (left sidebar): applied-preset header with Amount, search, grid/list toggle,
 * collapsible groups, thumbnails on the current photo, hover / arrow-key preview, right-click menu.
 */
import { useMemo, useRef, useState } from 'react';
import {
  applyPresetToEdit,
  previewPreset,
  removeAppliedPreset,
  resetToPreset,
  setAmountLive,
  commitAmount,
} from '../../app/presetActions';
import { presetEdited } from '../../presets/apply';
import { BUILTIN_PRESETS } from '../../presets/builtin';
import { BUILTIN_GROUP_ORDER, type Preset } from '../../presets/types';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useT } from '../../i18n';
import { buildPack, download, presetToJson, usePresets } from '../../state/presetStore';
import { useUi } from '../../state/uiStore';
import { Slider } from '../controls/Slider';
import { ImportReportDialog, ImportStatus, PRESET_IMPORT_ACCEPT, usePresetImport } from './ImportReport';
import { useThumbnail } from './thumbnails';
import { confirmDialog, promptDialog } from '../feedback/dialogs';
import { IconButton } from '../controls/IconButton';

interface Menu { x: number; y: number; preset: Preset }

export function PresetBrowser() {
  const user = usePresets((s) => s.user);
  const favorites = usePresets((s) => s.favorites);
  const recent = usePresets((s) => s.recent);
  const luts = usePresets((s) => s.luts);
  const view = useUi((s) => s.presetView);
  const hasImage = useImage((s) => !!s.image);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({ Recent: false });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState(false);
  const t = useT();
  const importRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // After an import, open the group the new presets landed in.
  const imp = usePresetImport((group) => {
    if (group) setClosed((c) => ({ ...c, [group === 'My Presets' ? group : `My Presets · ${group}`]: false }));
  });

  const all = useMemo(() => [...BUILTIN_PRESETS, ...user], [user]);
  const match = (p: Preset) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return p.name.toLowerCase().includes(s) || (p.description ?? '').toLowerCase().includes(s) || (p.tags ?? []).some((t) => t.toLowerCase().includes(s)) || p.group.toLowerCase().includes(s);
  };
  const byId = (id: string) => all.find((p) => p.id === id);
  const sections: Array<[string, Preset[]]> = [
    ['Favorites', favorites.map(byId).filter((p): p is Preset => !!p)],
    ['Recent', recent.map(byId).filter((p): p is Preset => !!p)],
    ...BUILTIN_GROUP_ORDER.map((g): [string, Preset[]] => [g, BUILTIN_PRESETS.filter((p) => p.group === g)]),
    ...[...new Set(user.map((p) => p.group))].sort().map((g): [string, Preset[]] => [g === 'My Presets' ? g : `My Presets · ${g}`, user.filter((p) => p.group === g)]),
  ];
  if (!user.length) sections.push(['My Presets', []]);

  const onKeyNav = (e: React.KeyboardEvent) => {
    const tiles = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-preset]') ?? [])];
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const cols = view === 'grid' ? 2 : 1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (step) { e.preventDefault(); tiles[Math.max(0, Math.min(tiles.length - 1, i + step))]?.focus(); }
  };

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); // tells the app-wide drop handler this drop is taken (no photo import)
        setDragging(false);
        void imp.run([...e.dataTransfer.files]);
      }}>
      <AppliedHeader />
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <input className="input min-w-0 flex-1" placeholder={tr('presetBrowser.search_presets')} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()} aria-label={tr('presetBrowser.search_presets')} />
        <button title={view === 'grid' ? tr('presetBrowser.compact_list') : tr('presetBrowser.thumbnail_grid')} className="rounded px-1.5 py-1 text-xs text-ink-dim hover:bg-hover"
          onClick={() => useUi.getState().set({ presetView: view === 'grid' ? 'list' : 'grid' })}>
          {view === 'grid' ? '☰' : '▦'}
        </button>
      </div>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1 text-2xs">
        <button className="rounded px-1.5 py-0.5 text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-40" disabled={!hasImage}
          onClick={() => useUi.getState().set({ createPresetOpen: true })}>{tr('presetBrowser.create')}</button>
        <button className="rounded px-1.5 py-0.5 text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-40" disabled={imp.busy}
          title={t('presets.import.title')} aria-label={t('presets.import.aria')} onClick={() => importRef.current?.click()}>{t('presets.import')}</button>
        <button className="rounded px-1.5 py-0.5 text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-40" disabled={!user.length}
          onClick={() => download('my-presets.opticpack', buildPack(user) as BlobPart, 'application/zip')}>{tr('presetBrowser.export_pack')}</button>
        <input ref={importRef} type="file" multiple accept={PRESET_IMPORT_ACCEPT} className="hidden" tabIndex={-1} aria-hidden
          onChange={(e) => { const f = [...(e.target.files ?? [])]; if (f.length) void imp.run(f); e.target.value = ''; }} />
      </div>
      <ImportStatus imp={imp} className="border-b border-line px-2 py-1 text-2xs text-ink-dim" />
      <ImportReportDialog imp={imp} />
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded border-2 border-dashed border-edge bg-panel/90 px-4 text-center text-xs text-ink">
          {t('presets.import.drop')}
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onKeyDown={onKeyNav} onMouseLeave={() => previewPreset(null)}>
        {sections.map(([name, list]) => {
          const items = list.filter(match);
          if (!items.length && (name === 'Favorites' || name === 'Recent' || q)) return null;
          const isClosed = closed[name] ?? (name !== 'Favorites' && name !== 'Hasselblad-inspired' && !q);
          return (
            <section key={name} className="border-b border-line">
              <button className="flex w-full items-center gap-1.5 px-2 py-1.5 text-start text-2xs font-medium uppercase tracking-wider text-ink-dim hover:text-ink"
                aria-expanded={!isClosed} onClick={() => setClosed({ ...closed, [name]: !isClosed })}>
                <span aria-hidden className={`text-ink-faint transition-transform ${isClosed ? '' : 'rotate-90'}`}>▸</span>
                <span className="truncate">{name}</span>
                <span className="ms-auto text-ink-faint">{items.length}</span>
              </button>
              {!isClosed && (
                items.length ? (
                  <div className={view === 'grid' ? 'grid grid-cols-2 gap-1.5 px-2 pb-2' : 'pb-1'}>
                    {items.map((p) => <PresetTile key={`${name}-${p.id}`} preset={p} view={view} fav={favorites.includes(p.id)} onMenu={setMenu} />)}
                  </div>
                ) : <p className="px-3 pb-2 text-xs text-ink-faint">{t('presets.import.empty')}</p>
              )}
            </section>
          );
        })}
        <section className="border-b border-line">
          <button className="flex w-full items-center gap-1.5 px-2 py-1.5 text-start text-2xs font-medium uppercase tracking-wider text-ink-dim hover:text-ink"
            aria-expanded={!(closed.luts ?? true)} onClick={() => setClosed({ ...closed, luts: !(closed.luts ?? true) })}>
            <span aria-hidden className={`text-ink-faint transition-transform ${(closed.luts ?? true) ? '' : 'rotate-90'}`}>▸</span>{tr('presetBrowser.my_luts')} <span className="ms-auto text-ink-faint">{luts.length}</span>
          </button>
          {!(closed.luts ?? true) && (
            <div className="pb-1">
              {luts.map((l) => (
                <button key={l.id} className="block w-full truncate px-3 py-1 text-start text-xs text-ink-dim hover:bg-hover hover:text-ink"
                  onClick={() => useEdit.getState().apply((r) => ({ ...r, lut: { ...r.lut, enabled: true, id: l.id } }))}>
                  {l.name} <span className="text-ink-faint">{l.size}³</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      {menu && <ContextMenu menu={menu} close={() => setMenu(null)} />}
    </div>
  );
}

function PresetTile({ preset, view, fav, onMenu }: { preset: Preset; view: 'grid' | 'list'; fav: boolean; onMenu(m: Menu): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const url = useThumbnail(preset, ref);
  const applied = useEdit((s) => s.recipe.appliedPreset?.id === preset.id);
  const hasImage = useImage((s) => !!s.image);
  const star = (
    <IconButton label={fav ? tr('presetBrowser.favorite_remove', { name: preset.name }) : tr('presetBrowser.favorite_add', { name: preset.name })} aria-pressed={fav}
      className={`text-xs ${fav ? 'text-star' : 'text-ink-faint opacity-0 focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100'}`}
      onClick={(e) => { e.stopPropagation(); usePresets.getState().toggleFavorite(preset.id); }}>★</IconButton>
  );
  const common = {
    ref,
    'data-preset': preset.id,
    tabIndex: 0,
    title: preset.description ? `${preset.name} — ${preset.description}` : preset.name,
    onMouseEnter: () => hasImage && previewPreset(preset),
    onFocus: () => hasImage && previewPreset(preset),
    onBlur: () => previewPreset(null),
    onClick: () => hasImage && applyPresetToEdit(preset),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') applyPresetToEdit(preset); },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY, preset }); },
  };
  if (view === 'list') {
    return (
      <div {...common} className={`group flex cursor-pointer items-center gap-2 px-3 py-1 text-xs outline-none hover:bg-hover focus:bg-hover ${applied ? 'text-strong' : 'text-ink-dim'}`}>
        <span className="truncate">{preset.name}</span>
        <span className="ms-auto">{star}</span>
      </div>
    );
  }
  return (
    <div {...common} className={`group cursor-pointer rounded outline-none focus:ring-1 focus:ring-edge ${applied ? 'ring-1 ring-ink' : ''}`}>
      <div className="relative aspect-[4/3] overflow-hidden rounded bg-sunk">
        {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : <div className="h-full w-full animate-pulse bg-sunk" />}
        <span className="absolute end-1 top-0.5">{star}</span>
      </div>
      <div className="truncate px-0.5 pt-0.5 text-2xs text-ink-dim group-hover:text-ink">{preset.name}</div>
    </div>
  );
}

function ContextMenu({ menu, close }: { menu: Menu; close(): void }) {
  const p = menu.preset;
  const store = usePresets.getState();
  const item = (label: string, fn: () => void, danger = false) => (
    <button className={`block w-full px-3 py-1.5 text-start text-xs hover:bg-active ${danger ? 'text-danger' : 'text-ink'}`}
      onClick={(e) => { e.stopPropagation(); fn(); close(); }}>{label}</button>
  );
  return (
    <div className="fixed z-50 min-w-[180px] rounded border border-line bg-raise py-1 shadow-xl" style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}>
      {item(tr('presetBrowser.apply'), () => applyPresetToEdit(p))}
      {item(tr('presetBrowser.apply_at_50'), () => applyPresetToEdit(p, 50))}
      {item(tr('presetBrowser.duplicate_as_my_preset'), () => void store.saveUser({ ...structuredClone(p), id: `user-${crypto.randomUUID().slice(0, 8)}`, name: `${p.name} copy`, group: 'My Presets', builtin: false }))}
      {!p.builtin && item(tr('presetBrowser.rename_2'), () => {
        void promptDialog({ title: tr('presetBrowser.rename_preset'), label: tr('presetBrowser.preset_name'), initial: p.name, confirmLabel: tr('presetBrowser.rename') })
          .then((name) => { if (name) void store.saveUser({ ...p, name }); });
      })}
      {item(tr('presetBrowser.export_json'), () => download(`${p.name.replace(/[^\w.-]+/g, '_')}.json`, presetToJson(p), 'application/json'))}
      {!p.builtin && item(tr('presetBrowser.delete'), () => {
        void confirmDialog({ title: tr('presetBrowser.delete_the_preset_name', { name: p.name }), message: tr('presetBrowser.photos_it_was_applied_to_keep'), confirmLabel: tr('presetBrowser.delete_preset'), danger: true })
          .then((ok) => { if (ok) void store.deleteUser(p.id); });
      }, true)}
    </div>
  );
}

/** Applied preset chip, Amount 0–200 %, reset / remove. */
function AppliedHeader() {
  const applied = useEdit((s) => s.recipe.appliedPreset);
  const edited = useEdit((s) => (s.recipe.appliedPreset ? presetEdited(s.recipe) : false));
  if (!applied) {
    return <div className="border-b border-line px-3 py-2 text-2xs text-ink-faint">{tr('presetBrowser.no_preset_applied_hover_to_preview')}</div>;
  }
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 truncate rounded bg-hover px-1.5 py-0.5 text-xs text-strong" title={applied.name}>
          {applied.name}{edited ? tr('presetBrowser.edited') : ''}
        </span>
        <button className="ms-auto rounded px-1.5 py-0.5 text-2xs text-ink-dim hover:bg-hover hover:text-ink" onClick={resetToPreset} title={tr('presetBrowser.discard_manual_changes_to_the_preset')}>{tr('presetBrowser.reset')}</button>
        <button className="rounded px-1.5 py-0.5 text-2xs text-ink-dim hover:bg-hover hover:text-ink" onClick={removeAppliedPreset} title={tr('presetBrowser.restore_the_settings_from_before_the')}>{tr('presetBrowser.remove')}</button>
      </div>
      <Slider label={tr('presetBrowser.amount')} value={applied.amount} min={0} max={200} step={1} defaultValue={100}
        format={(v) => `${Math.round(v)}%`} onChange={setAmountLive} onCommit={commitAmount} />
    </div>
  );
}
