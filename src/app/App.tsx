import { t as tr } from '../i18n';
import { lazy, Suspense, useEffect, useState } from 'react';
import { fromDataTransfer, isSupported, reviewImport } from '../library/importer';
import { startLibrarySync } from '../library/open';
import { useLibrary } from '../state/libraryStore';
import { ImportDialog } from '../ui/library/ImportDialog';
import { ImportButtons, LibraryView } from '../ui/library/LibraryView';
import { BatchDialogs } from '../ui/library/BatchMenu';
import { MobileApp } from '../ui/mobile/MobileApp';
import { WIDE_QUERY, useMediaQuery, useMobileLayout } from '../ui/mobile/layout';
import { Drawer } from '../ui/layout/Drawer';
import { SectionGroup, SoloToggle } from '../ui/layout/SectionGroup';
import { useImage } from '../state/imageStore';
import { Viewer } from '../ui/canvas/Viewer';
import { restoreExportQueue, useExportQueue } from '../library/exportQueue';
import { initPwa } from './pwa';
import { HistogramView } from '../ui/histogram/Histogram';
import { ColorMixerPanel } from '../ui/panels/ColorMixerPanel';
import { CurvePanel } from '../ui/panels/CurvePanel';
import { LightPanel } from '../ui/panels/LightPanel';
import { PresencePanel } from '../ui/panels/PresencePanel';
import { WhiteBalancePanel } from '../ui/panels/WhiteBalancePanel';
import { CalibrationPanel } from '../ui/panels/CalibrationPanel';
import { ColorGradingPanel } from '../ui/panels/ColorGradingPanel';
import { LookPanel } from '../ui/panels/LookPanel';
import { LutPanel } from '../ui/panels/LutPanel';
import { PointColorPanel } from '../ui/panels/PointColorPanel';
import { TreatmentToggle } from '../ui/panels/TreatmentToggle';
import { CopyPasteDialog, CreatePresetDialog } from '../ui/presets/Dialogs';
import { CropPanel } from '../ui/panels/CropPanel';
import { DetailPanel } from '../ui/panels/DetailPanel';
import { EffectsPanel } from '../ui/panels/EffectsPanel';
import { GeometryPanel } from '../ui/panels/GeometryPanel';
import { LensPanel } from '../ui/panels/LensPanel';
import { MasksPanel } from '../ui/panels/MasksPanel';
import { HistoryPanel, SnapshotDialog } from '../ui/history/HistoryPanel';
import { Filmstrip } from '../ui/filmstrip/Filmstrip';
import { PresetBrowser } from '../ui/presets/PresetBrowser';
import { usePresets } from '../state/presetStore';
import { useUi } from '../state/uiStore';
import { resetAllWithUndo } from './presetActions';
import { useKeyboard } from './keyboard';
import { openFile } from './openFile';
import { TopBar } from './TopBar';
import { DialogHost } from '../ui/feedback/dialogs';
import { Toaster } from '../ui/feedback/Toaster';
import { useSettings } from '../state/settingsStore';
import { SampleButton } from '../ui/library/SampleButton';

// Rarely opened UI loads on first use (the service worker precaches these chunks for offline use).
const ExportDialog = lazy(() => import('../ui/export/ExportDialog').then((m) => ({ default: m.ExportDialog })));
const BatchExportDialog = lazy(() => import('../ui/export/ExportDialog').then((m) => ({ default: m.BatchExportDialog })));
const ExportQueuePanel = lazy(() => import('../ui/export/ExportDialog').then((m) => ({ default: m.ExportQueuePanel })));
const SettingsDialog = lazy(() => import('../ui/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));
const ShortcutsOverlay = lazy(() => import('../ui/Overlays').then((m) => ({ default: m.ShortcutsOverlay })));
const Onboarding = lazy(() => import('../ui/Overlays').then((m) => ({ default: m.Onboarding })));

/** The lazily loaded dialogs, each mounted only while it is open. */
function LazyDialogs() {
  const exportOpen = useUi((s) => s.exportOpen);
  const batchExportOpen = useUi((s) => s.batchExportOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const shortcutsOpen = useUi((s) => s.shortcutsOpen);
  const queueOpen = useExportQueue((s) => !!s.job && s.panelOpen);
  const onboardingDone = useSettings((s) => s.onboardingDone);
  return (
    <Suspense fallback={null}>
      {exportOpen && <ExportDialog />}
      {batchExportOpen && <BatchExportDialog />}
      {queueOpen && <ExportQueuePanel />}
      {settingsOpen && <SettingsDialog />}
      {shortcutsOpen && <ShortcutsOverlay />}
      {!onboardingDone && <Onboarding />}
    </Suspense>
  );
}

function EmptyState() {
  const total = useLibrary((s) => s.photos.length);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <svg viewBox="0 0 24 24" className="h-10 w-10 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="10" r="2" />
        <path d="M21 16l-5-5-8 8" />
      </svg>
      <span className="text-base text-ink">{total ? tr('app.pick_a_photo_in_the_filmstrip') : tr('app.drop_a_proraw_dng_heic_or')}</span>
      <span className="text-xs text-ink-faint">{tr('app.raw_dng_cr2_cr3_nef_arw')}</span>
      <div className="flex gap-2"><ImportButtons big /></div>
      {!total && <SampleButton className="mt-1" />}
    </div>
  );
}

function LoadingOverlay() {
  const loading = useImage((s) => s.loading);
  if (!loading) return null;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
      <div className="w-80 rounded-lg border border-line bg-panel p-4 shadow-xl">
        <div className="mb-1 truncate text-xs text-ink">{loading.fileName}</div>
        <div className="mb-2 text-2xs text-ink-faint">{loading.label}</div>
        <div className="h-1.5 overflow-hidden rounded bg-hover">
          <div className="h-full bg-meter transition-[width] duration-200" style={{ width: `${Math.round(loading.fraction * 100)}%` }} />
        </div>
        <div className="mt-3 flex justify-end">
          <button className="rounded border border-line px-3 py-1 text-xs text-ink hover:bg-hover" onClick={() => useImage.getState().cancel()}>{tr('app.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

function ErrorToast() {
  const error = useImage((s) => s.error);
  if (!error) return null;
  return (
    <div className="absolute bottom-4 left-1/2 z-30 max-w-lg -translate-x-1/2 rounded border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-ink shadow-lg">{tr('app.could_not_open_the_file_error', { error: error })}
      <button className="hit ms-2 rounded text-ink-faint hover:text-ink" aria-label={tr('app.dismiss')} onClick={() => useImage.getState().clearError()}>✕</button>
    </div>
  );
}

/** Presets / History column (or drawer): a tab list over the two panels. */
function PresetsHistory() {
  const leftTab = useUi((s) => s.leftTab);
  const tabs = ['presets', 'history'] as const;
  const select = (t: (typeof tabs)[number]) => useUi.getState().set({ leftTab: t });
  return (
    <>
      <div className="flex border-b border-line text-xs font-medium uppercase tracking-wider" role="tablist" aria-label={tr('app.presets_and_history')}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const next = tabs[(tabs.indexOf(leftTab) + 1) % tabs.length];
          select(next);
          document.getElementById(`left-tab-${next}`)?.focus();
        }}>
        {tabs.map((t) => (
          <button key={t} id={`left-tab-${t}`} role="tab" aria-selected={leftTab === t} aria-controls="left-tab-panel" tabIndex={leftTab === t ? 0 : -1}
            onClick={() => select(t)}
            className={`flex-1 px-3 py-2 ${leftTab === t ? 'text-ink' : 'text-ink-faint hover:text-ink-dim'}`}>
            {t === 'presets' ? tr('app.presets') : tr('app.history')}
          </button>
        ))}
      </div>
      <div id="left-tab-panel" role="tabpanel" aria-labelledby={`left-tab-${leftTab}`} className="flex min-h-0 flex-1 flex-col">
        {leftTab === 'presets' ? <PresetBrowser /> : <HistoryPanel />}
      </div>
    </>
  );
}

export function App() {
  const mobile = useMobileLayout();
  useKeyboard();
  useEffect(() => {
    void usePresets.getState().init();
    void useLibrary.getState().init();
    startLibrarySync();
    void restoreExportQueue();
    void initPwa();
    // Background work (preset thumbnails) pauses while any pointer is held down.
    const down = () => useUi.getState().set({ dragging: true });
    const up = () => useUi.getState().set({ dragging: false });
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);
  const image = useImage((s) => s.image);
  const loading = useImage((s) => s.loading);
  const view = useLibrary((s) => s.view);
  const cropMode = useUi((s) => s.cropMode);
  const masksOpen = useUi((s) => s.masksOpen);
  const wide = useMediaQuery(WIDE_QUERY);
  const panelsHidden = useUi((s) => s.panelsHidden);
  const presetsDrawer = useUi((s) => s.presetsDrawer);
  // The drawer only exists below 1024 px; crop and masks need the adjustments column.
  useEffect(() => { if (wide && useUi.getState().presetsDrawer) useUi.getState().set({ presetsDrawer: false }); }, [wide]);
  useEffect(() => { if ((cropMode || masksOpen) && useUi.getState().panelsHidden) useUi.getState().set({ panelsHidden: false }); }, [cropMode, masksOpen]);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      depth++;
      setDragOver(true);
    };
    const over = (e: DragEvent) => e.dataTransfer?.types.includes('Files') && e.preventDefault();
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); };
    const drop = (e: DragEvent) => {
      // A panel that handled the drop itself (presets dropped on the preset browser) prevents default.
      const handled = e.defaultPrevented;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (handled || !e.dataTransfer) return;
      // A single photo dropped on the editor opens it; anything else goes through the import dialog.
      const single = useLibrary.getState().view === 'editor' && e.dataTransfer.items.length === 1 && e.dataTransfer.files.length === 1 && isSupported(e.dataTransfer.files[0].name);
      if (single) { openFile(e.dataTransfer.files[0]); return; }
      void fromDataTransfer(e.dataTransfer).then((list) => list.length && reviewImport(list));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const dialogs = (
    <>
      {view === 'library' && dragOver && (
        <div className="pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-edge bg-black/40 text-sm text-ink">{tr('app.drop_photos_or_folders_to_import')}</div>
      )}
      <ImportDialog />
      <BatchDialogs />
      <CreatePresetDialog />
      <CopyPasteDialog />
      <SnapshotDialog />
      <LazyDialogs />
      <DialogHost />
      <Toaster className={mobile ? 'bottom-[calc(72px+env(safe-area-inset-bottom))]' : 'bottom-28'} />
    </>
  );
  if (mobile) return <><MobileApp />{dialogs}</>;

  return (
    <div className="flex h-[100dvh] flex-col bg-app text-ink">
      <TopBar />
      {view === 'library' && <LibraryView />}
      <div className={`relative min-h-0 flex-1 ${view === 'library' ? 'hidden' : 'flex'}`}>
        {wide && !panelsHidden && (
          <aside className="flex w-64 shrink-0 flex-col border-e border-line bg-panel" aria-label={tr('app.presets_and_history')}>
            <PresetsHistory />
          </aside>
        )}
        {!wide && presetsDrawer && (
          <Drawer id="presets-drawer" title={tr('app.presets_and_history')} onClose={() => useUi.getState().set({ presetsDrawer: false })}>
            <PresetsHistory />
          </Drawer>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Viewer />
            {!image && !loading && <EmptyState />}
            <LoadingOverlay />
            <ErrorToast />
            {dragOver && (
              <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-edge bg-black/40 text-sm text-ink">{tr('app.drop_to_import')}</div>
            )}
          </div>
          <Filmstrip />
        </main>
        <aside className={`w-[300px] shrink-0 flex-col border-s border-line bg-panel max-md:w-[260px] ${panelsHidden ? 'hidden' : 'flex'}`} aria-label={tr('app.adjustments')}>
          <HistogramView />
          <TreatmentToggle />
          <SoloToggle />
          <SectionGroup>
          <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${image ? '' : 'pointer-events-none opacity-40'}`}>
            {cropMode && <CropPanel />}
            {masksOpen && <MasksPanel />}
            <WhiteBalancePanel />
            <LightPanel />
            <PresencePanel />
            <LookPanel />
            <CurvePanel />
            <ColorMixerPanel />
            <PointColorPanel />
            <ColorGradingPanel />
            <DetailPanel />
            <EffectsPanel />
            <LensPanel />
            <GeometryPanel />
            <CalibrationPanel />
            <LutPanel />
            {!masksOpen && <MasksPanel />}
            <div className="flex justify-between gap-2 px-3 py-3 text-2xs">
              <button className="text-ink-faint hover:text-ink" onClick={() => useUi.getState().set({ copyPaste: 'copy' })} title={tr('app.ctrl_cmd_shift_c')}>{tr('app.copy_settings')}</button>
              <button className="text-ink-faint hover:text-ink" onClick={() => useUi.getState().set({ copyPaste: 'paste' })} title={tr('app.ctrl_cmd_shift_v')}>{tr('app.paste_settings')}</button>
              <button className="text-ink-faint hover:text-danger" onClick={resetAllWithUndo}>{tr('app.reset_all')}</button>
            </div>
          </div>
          </SectionGroup>
        </aside>
      </div>
      {dialogs}
    </div>
  );
}
