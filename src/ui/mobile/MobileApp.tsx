/**
 * Touch-first layout (phones, narrow iPad windows): a full-bleed photo with a bottom toolbar
 * (Presets · Light · Color · Effects · Detail · Crop · Masks · Export) whose panels open as a bottom
 * sheet, and a library grid with tap-to-open and long-press multi-select. Safe areas (notch, home
 * indicator) are respected in portrait and landscape.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { resetAll } from '../../app/presetActions';
import { removePhotos, setFlag, setRating } from '../../library/actions';
import { fromFiles, reviewImport } from '../../library/importer';
import { openRelative } from '../../library/open';
import { activeCopy, useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { filterActive, targetIds, useLibrary, useVisiblePhotos } from '../../state/libraryStore';
import { useUi } from '../../state/uiStore';
import { ACCEPT } from '../../io/decode/decodeClient';
import { Viewer } from '../canvas/Viewer';
import { HistogramView } from '../histogram/Histogram';
import { BatchMenu } from '../library/BatchMenu';
import { FilterBar } from '../library/FilterBar';
import { Grid } from '../library/Grid';
import { InfoPanel } from '../library/InfoPanel';
import { Stars } from '../library/PhotoBadges';
import { CalibrationPanel } from '../panels/CalibrationPanel';
import { ColorGradingPanel } from '../panels/ColorGradingPanel';
import { ColorMixerPanel } from '../panels/ColorMixerPanel';
import { CropPanel } from '../panels/CropPanel';
import { CurvePanel } from '../panels/CurvePanel';
import { DetailPanel } from '../panels/DetailPanel';
import { EffectsPanel } from '../panels/EffectsPanel';
import { GeometryPanel } from '../panels/GeometryPanel';
import { LensPanel } from '../panels/LensPanel';
import { LightPanel } from '../panels/LightPanel';
import { LookPanel } from '../panels/LookPanel';
import { LutPanel } from '../panels/LutPanel';
import { MasksPanel } from '../panels/MasksPanel';
import { PointColorPanel } from '../panels/PointColorPanel';
import { PresencePanel } from '../panels/PresencePanel';
import { TreatmentToggle } from '../panels/TreatmentToggle';
import { WhiteBalancePanel } from '../panels/WhiteBalancePanel';
import { HistoryPanel } from '../history/HistoryPanel';
import { Menu } from '../controls/Menu';
import { BottomSheet } from './BottomSheet';
import { PresetStrip } from './PresetStrip';
import { ImportProgress } from '../library/ImportDialog';
import { BatchProgress } from '../library/BatchMenu';
import { ExportProgress } from '../export/ExportDialog';
import { PwaStatus } from '../PwaStatus';

type Tab = 'presets' | 'light' | 'color' | 'effects' | 'detail' | 'crop' | 'masks' | 'export';

const TABS: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'presets', label: 'Presets', icon: <path d="M4 6h16M4 12h16M4 18h10" /> },
  { id: 'light', label: 'Light', icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></> },
  { id: 'color', label: 'Color', icon: <><circle cx="9" cy="10" r="5" /><circle cx="15" cy="10" r="5" /><circle cx="12" cy="15" r="5" /></> },
  { id: 'effects', label: 'Effects', icon: <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /> },
  { id: 'detail', label: 'Detail', icon: <><path d="M3 21l7-7" /><circle cx="15" cy="9" r="6" /></> },
  { id: 'crop', label: 'Crop', icon: <path d="M6 2v16h16M2 6h16v16" /> },
  { id: 'masks', label: 'Masks', icon: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></> },
  { id: 'export', label: 'Export', icon: <path d="M12 3v12M7 8l5-5 5 5M4 15v5h16v-5" /> },
];

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

function SheetContent({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'presets': return <PresetStrip />;
    case 'light': return <><LightPanel /><CurvePanel /></>;
    case 'color': return <><TreatmentToggle /><WhiteBalancePanel /><PresencePanel /><ColorMixerPanel /><PointColorPanel /><ColorGradingPanel /><LookPanel /><CalibrationPanel /><LutPanel /></>;
    case 'effects': return <EffectsPanel />;
    case 'detail': return <><DetailPanel /><LensPanel /></>;
    case 'crop': return <><CropPanel /><GeometryPanel /></>;
    case 'masks': return <MasksPanel />;
    default: return null;
  }
}

function MobileEditor() {
  const image = useImage((s) => s.image);
  const loading = useImage((s) => s.loading);
  const error = useImage((s) => s.error);
  const [tab, setTab] = useState<Tab | null>(null);
  const [sheet, setSheet] = useState<'history' | 'info' | null>(null);
  const canUndo = useEdit((s) => activeCopy(s).index > 0 || s.recipe !== s.committed);
  const canRedo = useEdit((s) => { const c = activeCopy(s); return c.index < c.steps.length - 1; });
  const list = useVisiblePhotos();
  const ui = useUi.getState();
  // Crop and Masks tabs switch the canvas into their tools.
  useEffect(() => {
    useUi.getState().set({ cropMode: tab === 'crop', masksOpen: tab === 'masks', tool: 'none', maskPick: false });
  }, [tab]);
  const pick = (t: Tab) => {
    if (t === 'export') { if (image) ui.set({ exportOpen: true }); return; }
    setSheet(null);
    setTab(tab === t ? null : t);
  };
  return (
    <div className="flex h-[100dvh] flex-col bg-app text-ink">
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 pb-1 pt-[max(4px,env(safe-area-inset-top))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))]">
        <button className="rounded px-2 py-2 text-sm text-ink" onClick={() => useLibrary.getState().set({ view: 'library' })} aria-label="Back to the library">‹ Library</button>
        <div className="min-w-0 flex-1 truncate px-1 text-center text-xs text-ink-dim">{image?.fileName ?? ''}</div>
        <ExportProgress />
        <button className="rounded px-2.5 py-2 text-base disabled:opacity-30" disabled={!canUndo} onClick={() => useEdit.getState().undo()} aria-label="Undo">↶</button>
        <button className="rounded px-2.5 py-2 text-base disabled:opacity-30" disabled={!canRedo} onClick={() => useEdit.getState().redo()} aria-label="Redo">↷</button>
        <Menu label="⋯" ariaLabel="More" align="right" className="rounded px-2.5 py-2 text-base" items={[
          { label: 'History', onSelect: () => { setTab(null); setSheet('history'); } },
          { label: 'Histogram & info', onSelect: () => { setTab(null); setSheet('info'); } },
          { label: 'Copy settings…', disabled: !image, onSelect: () => ui.set({ copyPaste: 'copy' }) },
          { label: 'Paste settings…', disabled: !image, onSelect: () => ui.set({ copyPaste: 'paste' }) },
          { label: 'Create virtual copy', disabled: !image, onSelect: () => useEdit.getState().createVirtualCopy() },
          { label: 'Compare split view', disabled: !image, onSelect: () => ui.set({ compareMode: useUi.getState().compareMode === 'off' ? 'split' : 'off' }) },
          { label: 'Previous photo', onSelect: () => openRelative(-1, list) },
          { label: 'Next photo', onSelect: () => openRelative(1, list) },
          { label: 'Settings', onSelect: () => ui.set({ settingsOpen: true }) },
          { label: 'Reset all…', disabled: !image, onSelect: () => { if (confirm('Reset all adjustments? (Undo is available.)')) resetAll(); } },
        ]} />
      </header>
      <div className="relative min-h-0 flex-1">
        <Viewer />
        {loading && (
          <div className="absolute inset-x-6 top-1/2 z-20 -translate-y-1/2 rounded-lg border border-line bg-panel p-3 text-xs" role="status">
            <div className="truncate">{loading.fileName}</div>
            <div className="mb-2 text-ink-faint">{loading.label}</div>
            <div className="h-1.5 overflow-hidden rounded bg-hover"><div className="h-full bg-meter" style={{ width: `${Math.round(loading.fraction * 100)}%` }} /></div>
          </div>
        )}
        {error && (
          <div className="absolute inset-x-3 bottom-3 z-30 rounded border border-[#5a3030] bg-[#2e1f1f] px-3 py-2 text-xs text-[#f0c0c0]" role="alert">
            {error}<button className="ml-2 text-ink-faint" onClick={() => useImage.getState().clearError()} aria-label="Dismiss">✕</button>
          </div>
        )}
        {!image && !loading && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-dim">Pick a photo in the library.</div>}
      </div>
      {tab && <BottomSheet title={TABS.find((t) => t.id === tab)!.label} open onClose={() => setTab(null)}><SheetContent tab={tab} /></BottomSheet>}
      {sheet === 'history' && <BottomSheet title="History" open onClose={() => setSheet(null)}><div className="h-[60dvh]"><HistoryPanel /></div></BottomSheet>}
      {sheet === 'info' && <BottomSheet title="Histogram" open onClose={() => setSheet(null)}><HistogramView /></BottomSheet>}
      <nav className="flex shrink-0 overflow-x-auto border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]" aria-label="Edit tools">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => pick(t.id)} aria-pressed={tab === t.id} disabled={!image}
            className={`flex min-w-[44px] flex-1 flex-col items-center gap-0.5 px-0.5 py-2 text-[10px] disabled:opacity-30 ${tab === t.id ? 'text-strong' : 'text-ink-dim'}`}>
            <Icon>{t.icon}</Icon>{t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function MobileLibrary() {
  const total = useLibrary((s) => s.photos.length);
  const nSel = useLibrary((s) => s.selection.size);
  const filterOpen = useLibrary((s) => s.filterOpen);
  const filter = useLibrary((s) => s.filter);
  const active = useLibrary((s) => s.active);
  const p = useLibrary((s) => (s.active ? s.byId.get(s.active) : undefined));
  const [info, setInfo] = useState(false);
  const lib = useLibrary.getState();
  useEffect(() => {
    // Three columns on a phone in portrait, more in landscape.
    const fit = () => lib.set({ thumbSize: Math.max(96, Math.floor((window.innerWidth - 24) / (window.innerWidth > window.innerHeight ? 5 : 3)) - 6) });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex h-[100dvh] flex-col bg-app text-ink">
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 pb-1 pt-[max(4px,env(safe-area-inset-top))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))]">
        <span className="px-1 text-sm font-semibold">Optic</span>
        <ImportProgress />
        <BatchProgress />
        <PwaStatus />
        <div className="flex-1" />
        <label className="rounded px-2 py-2 text-xs text-ink">Import
          <input type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { if (e.target.files?.length) reviewImport(fromFiles(e.target.files)); e.target.value = ''; }} />
        </label>
        <button className={`rounded px-2 py-2 text-xs ${filterOpen || filterActive(filter) ? 'text-strong' : 'text-ink'}`} onClick={() => lib.set({ filterOpen: !filterOpen })} aria-pressed={filterOpen}>Filter</button>
        <BatchMenu />
        <button className="rounded px-2 py-2 text-sm text-ink-dim" aria-label="Settings" onClick={() => useUi.getState().set({ settingsOpen: true })}>⚙</button>
      </header>
      {filterOpen && <div className="max-h-[45dvh] overflow-y-auto"><FilterBar /></div>}
      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-ink-dim">
          Your library is empty.
          <label className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent">Import photos
            <input type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { if (e.target.files?.length) reviewImport(fromFiles(e.target.files)); e.target.value = ''; }} />
          </label>
          <span className="text-xs text-ink-faint">Or share photos to Optic from the Photos app.</span>
        </div>
      ) : <Grid touch />}
      {nSel > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-3 py-2 pb-[max(8px,env(safe-area-inset-bottom))] text-xs" role="toolbar" aria-label="Selection">
          <span className="text-ink-dim">{nSel} selected</span>
          {p && <Stars n={p.rating} onSet={(r) => void setRating(r)} size="text-lg" />}
          <button className="rounded px-2 py-1" onClick={() => void setFlag(p?.flag === 1 ? 0 : 1)} aria-label="Pick">⚑</button>
          <button className="rounded px-2 py-1" onClick={() => void setFlag(p?.flag === -1 ? 0 : -1)} aria-label="Reject">✕</button>
          <div className="flex-1" />
          <button className="rounded px-2 py-1" onClick={() => setInfo(true)} disabled={!active}>Info</button>
          <button className="rounded px-2 py-1 text-[#e09090]" onClick={() => void removePhotos(targetIds())}>Remove</button>
          <button className="rounded px-2 py-1" onClick={() => lib.set({ selection: new Set() })}>Done</button>
        </div>
      )}
      {info && <BottomSheet title="Info" open onClose={() => setInfo(false)}><div className="[&>aside]:w-full [&>aside]:border-0"><InfoPanel /></div></BottomSheet>}
    </div>
  );
}

export function MobileApp() {
  const view = useLibrary((s) => s.view);
  return (
    <>
      {/* The editor stays mounted (its GPU context and decoded photo) while the library shows. */}
      <div className={view === 'editor' ? 'contents' : 'hidden'}><MobileEditor /></div>
      {view === 'library' && <MobileLibrary />}
    </>
  );
}
