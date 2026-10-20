import { useEffect, useRef, useState } from 'react';
import { ACCEPT } from '../io/decode/decodeClient';
import { useImage } from '../state/imageStore';
import { Viewer } from '../ui/canvas/Viewer';
import { ExportDialog } from '../ui/export/ExportDialog';
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
import { HistoryPanel, SnapshotDialog } from '../ui/history/HistoryPanel';
import { Filmstrip } from '../ui/filmstrip/Filmstrip';
import { PresetBrowser } from '../ui/presets/PresetBrowser';
import { usePresets } from '../state/presetStore';
import { useUi } from '../state/uiStore';
import { resetAll } from './presetActions';
import { useKeyboard } from './keyboard';
import { openFile } from './openFile';
import { TopBar } from './TopBar';

function EmptyState() {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <button
        onClick={() => ref.current?.click()}
        className="flex h-full max-h-[420px] w-full max-w-[640px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[#3a3a3a] text-ink-dim hover:border-[#555] hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="2" />
          <path d="M21 16l-5-5-8 8" />
        </svg>
        <span className="text-base">Drop a ProRAW DNG, HEIC or JPEG</span>
        <span className="text-xs text-ink-faint">or click to choose · RAW (DNG, CR2/CR3, NEF, ARW, RAF, RW2, ORF), HEIC, JPEG, PNG, TIFF, WebP, AVIF</span>
      </button>
      <input ref={ref} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
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
        <div className="mb-2 text-[11px] text-ink-faint">{loading.label}</div>
        <div className="h-1.5 overflow-hidden rounded bg-[#333]">
          <div className="h-full bg-[#bbb] transition-[width] duration-200" style={{ width: `${Math.round(loading.fraction * 100)}%` }} />
        </div>
        <div className="mt-3 flex justify-end">
          <button className="rounded border border-line px-3 py-1 text-xs text-ink hover:bg-[#333]" onClick={() => useImage.getState().cancel()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorToast() {
  const error = useImage((s) => s.error);
  if (!error) return null;
  return (
    <div className="absolute bottom-4 left-1/2 z-30 max-w-lg -translate-x-1/2 rounded border border-[#5a3030] bg-[#2e1f1f] px-3 py-2 text-xs text-[#f0c0c0] shadow-lg">
      Could not open the file: {error}
      <button className="ml-3 text-ink-faint hover:text-ink" onClick={() => useImage.getState().clearError()}>✕</button>
    </div>
  );
}

export function App() {
  useKeyboard();
  useEffect(() => {
    void usePresets.getState().init();
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
  const leftTab = useUi((s) => s.leftTab);
  const cropMode = useUi((s) => s.cropMode);
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
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) openFile(f);
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

  return (
    <div className="flex h-[100dvh] flex-col bg-app text-ink">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel lg:flex">
          <div className="flex border-b border-line text-xs font-medium uppercase tracking-wider">
            {(['presets', 'history'] as const).map((t) => (
              <button key={t} onClick={() => useUi.getState().set({ leftTab: t })}
                className={`flex-1 px-3 py-2 ${leftTab === t ? 'text-ink' : 'text-ink-faint hover:text-ink-dim'}`}>
                {t === 'presets' ? 'Presets' : 'History'}
              </button>
            ))}
          </div>
          {leftTab === 'presets' ? <PresetBrowser /> : <HistoryPanel />}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Viewer />
            {!image && !loading && <EmptyState />}
            <LoadingOverlay />
            <ErrorToast />
            {dragOver && (
              <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-[#888] bg-black/40 text-sm text-ink">
                Drop to open
              </div>
            )}
          </div>
          <Filmstrip />
        </main>
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel max-md:w-[260px]">
          <HistogramView />
          <TreatmentToggle />
          <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${image ? '' : 'pointer-events-none opacity-40'}`}>
            {cropMode && <CropPanel />}
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
            <div className="flex justify-between gap-2 px-3 py-3 text-[11px]">
              <button className="text-ink-faint hover:text-ink" onClick={() => useUi.getState().set({ copyPaste: 'copy' })} title="Ctrl/Cmd+Shift+C">Copy settings…</button>
              <button className="text-ink-faint hover:text-ink" onClick={() => useUi.getState().set({ copyPaste: 'paste' })} title="Ctrl/Cmd+Shift+V">Paste settings…</button>
              <button className="text-ink-faint hover:text-[#e07070]" onClick={() => { if (confirm('Reset all adjustments for this photo? (Undo is available.)')) resetAll(); }}>Reset all</button>
            </div>
          </div>
        </aside>
      </div>
      <ExportDialog />
      <CreatePresetDialog />
      <CopyPasteDialog />
      <SnapshotDialog />
    </div>
  );
}
