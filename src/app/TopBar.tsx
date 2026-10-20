import { type ReactNode, useRef } from 'react';
import { ACCEPT } from '../io/decode/decodeClient';
import { activeCopy, useEdit } from '../state/editStore';
import { type LoadedImage, useImage } from '../state/imageStore';
import { type CompareMode, useUi } from '../state/uiStore';
import { ExportProgress } from '../ui/export/ExportDialog';
import { openFile } from './openFile';

export function badgeFor(img: LoadedImage): string {
  if (img.isRaw) return `RAW · ${img.bitDepth}-bit`;
  const name = { heic: 'HEIC', jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF', webp: 'WebP', avif: 'AVIF', dng: 'DNG', raw: 'RAW' }[img.format];
  return `${name} · ${img.bitDepth === 32 ? '32-bit float' : `${img.bitDepth}-bit`}`;
}

function fmtShutter(s?: number) {
  if (!s) return null;
  return s >= 0.5 ? `${+s.toFixed(1)} s` : `1/${Math.round(1 / s)} s`;
}

const Btn = (p: { onClick(): void; children: ReactNode; title?: string; active?: boolean; disabled?: boolean }) => (
  <button
    title={p.title}
    disabled={p.disabled}
    onClick={p.onClick}
    className={`rounded px-2 py-1 text-xs disabled:opacity-30 ${p.active ? 'bg-[#3a3a3a] text-white' : 'text-ink hover:bg-[#333]'}`}
  >
    {p.children}
  </button>
);

const COMPARE_LABEL: Record<CompareMode, string> = { off: 'Compare', split: 'Split', side: 'Side by side' };
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
    <div className="flex items-center gap-0.5 border-l border-line pl-2">
      <Btn onClick={() => set({ compareMode: NEXT_COMPARE[mode] })} active={mode !== 'off'} disabled={disabled} title="Compare views: split / side by side (Y)">
        {COMPARE_LABEL[mode]}
      </Btn>
      {mode !== 'off' && (
        <>
          <select
            className="max-w-[150px] rounded border border-line bg-[#2d2d2d] px-1 py-0.5 text-[11px] text-ink outline-none"
            value={source}
            title="What the Before side shows"
            onChange={(e) => set({ compareSource: e.target.value })}
          >
            <option value="original">Original (no edits)</option>
            <option value="session">As opened this session</option>
            {cur.snapshots.length > 0 && (
              <optgroup label="Snapshots">
                {cur.snapshots.map((s) => <option key={s.id} value={`snap:${s.id}`}>{s.name}</option>)}
              </optgroup>
            )}
            {copies.length > 1 && (
              <optgroup label="Virtual copies">
                {copies.filter((c) => c.id !== active).map((c) => <option key={c.id} value={`copy:${c.id}`}>{c.name}</option>)}
              </optgroup>
            )}
            <optgroup label="History">
              {cur.steps.map((s, i) => <option key={i} value={`step:${i}`}>{i + 1}. {s.label}</option>).reverse()}
            </optgroup>
          </select>
          {mode === 'split' && (
            <Btn onClick={() => set({ compareVertical: !vertical })} title="Split orientation">{vertical ? '⇆' : '⇅'}</Btn>
          )}
          <Btn onClick={() => set({ compareSwap: !useUi.getState().compareSwap })} title="Swap before / after">⇄</Btn>
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

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
      <span className="px-1 text-sm font-semibold tracking-wide text-ink">Optic</span>
      <Btn onClick={() => inputRef.current?.click()} title="Open (Ctrl/Cmd+O)">Open</Btn>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
        }}
      />
      {image && (
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className="truncate text-xs text-ink" title={image.fileName}>{image.fileName}</span>
          <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-dim" title={`Decoded with ${image.decoder}`}>
            {badgeFor(image)}
          </span>
          <span className="hidden truncate text-[11px] text-ink-faint lg:inline">{infoParts.join(' · ')}</span>
        </div>
      )}
      {!image && <div className="flex-1" />}
      <ExportProgress />
      <div className="flex items-center gap-0.5 border-l border-line pl-2">
        <Btn onClick={() => useEdit.getState().undo()} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">↶</Btn>
        <Btn onClick={() => useEdit.getState().redo()} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">↷</Btn>
      </div>
      <div className="flex items-center gap-0.5 border-l border-line pl-2">
        <Btn onClick={() => setZoom('fit')} active={zoom === 'fit'} disabled={!image} title="Fit (Z toggles fit / 100%)">Fit</Btn>
        <Btn onClick={() => setZoom(1)} active={zoom === 1} disabled={!image}>100%</Btn>
        <Btn onClick={() => setZoom(2)} active={zoom === 2} disabled={!image}>200%</Btn>
        <span className="w-11 text-right text-[11px] tabular-nums text-ink-faint">{image ? `${pct}%` : ''}</span>
      </div>
      <div className="flex items-center gap-0.5 border-l border-line pl-2">
        <Btn onClick={() => useUi.getState().set({ cropMode: !cropMode, tool: 'none' })} active={cropMode} disabled={!image} title="Crop & straighten (R)">Crop</Btn>
      </div>
      <CompareControls disabled={!image} />
      <div className="flex items-center gap-1 border-l border-line pl-2">
        <button
          disabled={!image}
          title="Before / After (hold \\)"
          className={`rounded px-2 py-1 text-xs disabled:opacity-30 ${showBefore ? 'bg-[#3a3a3a] text-white' : 'text-ink hover:bg-[#333]'}`}
          onPointerDown={() => useUi.getState().set({ showBefore: true })}
          onPointerUp={() => useUi.getState().set({ showBefore: false })}
          onPointerLeave={() => showBefore && useUi.getState().set({ showBefore: false })}
        >
          {showBefore ? 'Before' : 'Before/After'}
        </button>
        <button
          disabled={!image}
          onClick={() => useUi.getState().set({ exportOpen: true })}
          className="rounded bg-[#e0e0e0] px-3 py-1 text-xs font-medium text-black hover:bg-white disabled:opacity-30"
          title="Export (Ctrl/Cmd+E)"
        >
          Export
        </button>
      </div>
    </header>
  );
}
