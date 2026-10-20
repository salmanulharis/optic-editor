import { type ReactNode, useMemo, useState } from 'react';
import { create } from 'zustand';
import { COLOR_SPACES, type ColorSpaceId } from '../../color/matrices';
import { pickSaveTarget, runExport } from '../../io/encode/exportClient';
import {
  EXPORT_SPACES,
  type ExportFormat,
  type ExportSettings,
  exportFileName,
  outputSize,
} from '../../io/encode/exportSettings';
import type { MetadataMode } from '../../io/metadata/exif';
import { activeCopy, useEdit } from '../../state/editStore';
import { computeGeo } from '../../geometry/transform';
import { effectiveRecipe } from '../../recipe/schema';
import { type LoadedImage, useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';

interface ExportJob {
  running: boolean;
  fraction: number;
  label: string;
  error: string | null;
  controller: AbortController | null;
  set(p: Partial<ExportJob>): void;
}

export const useExportJob = create<ExportJob>((set) => ({
  running: false,
  fraction: 0,
  label: '',
  error: null,
  controller: null,
  set: (p) => set(p),
}));

/** Defaults: never worse than the source. JPEG sources → JPEG q95 4:4:4 in the source space. */
function defaultSettings(img: LoadedImage): ExportSettings {
  const srcSpace = img.color.kind === 'display' ? img.color.spaceId : null;
  const space: ColorSpaceId = srcSpace && EXPORT_SPACES.includes(srcSpace) ? srcSpace : 'display-p3';
  return {
    format: img.format === 'jpeg' ? 'jpeg' : 'tiff',
    quality: 95,
    colorSpace: img.isRaw ? 'display-p3' : space,
    size: { mode: 'original' },
    metadata: 'keep',
    tiffCompression: 'deflate',
  };
}

const lastSettings = new Map<number, ExportSettings>();

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  const image = useImage((s) => s.image);
  if (!open || !image) return null;
  return <Dialog image={image} key={image.id} />;
}

function Dialog({ image }: { image: LoadedImage }) {
  const [s, setS] = useState<ExportSettings>(() => lastSettings.get(image.id) ?? defaultSettings(image));
  const update = (p: Partial<ExportSettings>) => setS((prev) => ({ ...prev, ...p }));
  const close = () => useUi.getState().set({ exportOpen: false });
  // The cropped, transformed output: export never resamples it unless a size is asked for.
  const recipe = useEdit((st) => st.recipe);
  const copyName = useEdit((st) => (st.copies.length > 1 && st.active !== st.copies[0].id ? activeCopy(st).name : ''));
  const out = useMemo(() => computeGeo(image.model, effectiveRecipe(recipe, image.asShot)), [image, recipe]);
  const size = useMemo(() => outputSize(out.outW, out.outH, s.size), [out, s.size]);
  // A virtual copy exports under its own name ("IMG_7040 (B&W)_optic.tif").
  const name = exportFileName(copyName ? `${image.fileName.replace(/\.[^.]+$/, '')} (${copyName}).x` : image.fileName, s.format);
  const job = useExportJob();

  const start = async () => {
    lastSettings.set(image.id, s);
    let handle = null;
    try {
      handle = await pickSaveTarget(name, s.format);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    const recipe = useEdit.getState().recipe;
    const controller = new AbortController();
    useExportJob.getState().set({ running: true, fraction: 0, label: 'Starting', error: null, controller });
    close();
    const t0 = performance.now();
    try {
      await runExport(image, recipe, s, handle, (fraction, label) => useExportJob.getState().set({ fraction, label }), controller.signal, name);
      console.info(`[optic] exported ${name} (${size.width}×${size.height}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      useExportJob.getState().set({ running: false, label: 'Saved', controller: null });
      setTimeout(() => !useExportJob.getState().running && useExportJob.getState().set({ label: '' }), 3000);
    } catch (e) {
      const err = e as Error;
      const cancelled = err.name === 'AbortError' || controller.signal.aborted;
      if (!cancelled) console.error('[optic] export failed', err);
      useExportJob.getState().set({ running: false, controller: null, label: '', error: cancelled ? null : err.message });
    }
  };

  const fmtBtn = (f: ExportFormat, label: string) => (
    <button
      key={f}
      onClick={() => update({ format: f })}
      className={`flex-1 rounded px-2 py-1.5 text-xs ${s.format === f ? 'bg-[#3a3a3a] text-white' : 'text-ink-dim hover:text-ink'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl" role="dialog" aria-label="Export">
        <h2 className="mb-3 text-sm font-medium">Export</h2>

        <Row label="Format">
          <div className="flex rounded border border-line">
            {fmtBtn('tiff', 'TIFF 16-bit')}
            {fmtBtn('jpeg', 'JPEG')}
            {fmtBtn('png', 'PNG 16-bit')}
          </div>
        </Row>

        {s.format === 'jpeg' && (
          <Row label={`Quality ${s.quality}`}>
            <input type="range" min={1} max={100} value={s.quality} className="w-full accent-[#9a9a9a]"
              onChange={(e) => update({ quality: +e.target.value })} />
            <div className="text-[11px] text-ink-faint">{s.quality >= 90 ? '4:4:4 chroma (no subsampling)' : '4:2:0 chroma subsampling'}</div>
          </Row>
        )}
        {s.format === 'tiff' && (
          <Row label="Compression">
            <select className="input" value={s.tiffCompression} onChange={(e) => update({ tiffCompression: e.target.value as 'deflate' | 'none' })}>
              <option value="deflate">ZIP (lossless)</option>
              <option value="none">None</option>
            </select>
          </Row>
        )}

        <Row label="Color space">
          <select className="input" value={s.colorSpace} onChange={(e) => update({ colorSpace: e.target.value as ColorSpaceId })}>
            {EXPORT_SPACES.map((id) => <option key={id} value={id}>{COLOR_SPACES[id].label}</option>)}
          </select>
        </Row>

        <Row label="Size">
          <div className="flex items-center gap-2">
            <select
              className="input"
              value={s.size.mode}
              onChange={(e) => {
                const m = e.target.value;
                update({ size: m === 'longEdge' ? { mode: 'longEdge', px: 2048 } : m === 'percent' ? { mode: 'percent', pct: 50 } : { mode: 'original' } });
              }}
            >
              <option value="original">Original</option>
              <option value="longEdge">Long edge</option>
              <option value="percent">Percentage</option>
            </select>
            {s.size.mode === 'longEdge' && (
              <input type="number" className="input w-24" min={16} max={Math.max(out.outW, out.outH)} value={s.size.px}
                onChange={(e) => update({ size: { mode: 'longEdge', px: Math.max(16, +e.target.value || 16) } })} />
            )}
            {s.size.mode === 'percent' && (
              <input type="number" className="input w-20" min={1} max={100} value={s.size.pct}
                onChange={(e) => update({ size: { mode: 'percent', pct: Math.min(100, Math.max(1, +e.target.value || 1)) } })} />
            )}
          </div>
          <div className="mt-1 text-[11px] text-ink-faint">{size.width} × {size.height} px</div>
        </Row>

        <Row label="Metadata">
          <select className="input" value={s.metadata} onChange={(e) => update({ metadata: e.target.value as MetadataMode })}>
            <option value="keep">Keep all EXIF</option>
            <option value="stripGps">Remove location (GPS)</option>
            <option value="strip">Remove all</option>
          </select>
        </Row>

        <div className="mt-3 truncate text-[11px] text-ink-faint" title={name}>{name}</div>
        {job.error && <div className="mt-2 text-xs text-[#e07070]">Last export failed: {job.error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-[#333]" onClick={close}>Cancel</button>
          <button
            className="rounded bg-[#e0e0e0] px-3 py-1.5 text-xs font-medium text-black hover:bg-white disabled:opacity-40"
            disabled={job.running}
            onClick={start}
          >
            {job.running ? 'Export running…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

/** Small progress pill for the top bar while an export runs in the background. */
export function ExportProgress() {
  const job = useExportJob();
  if (!job.running && !job.label && !job.error) return null;
  if (job.error && !job.running) {
    return (
      <button className="rounded bg-[#4a2626] px-2 py-1 text-[11px] text-[#f0b0b0]" onClick={() => useExportJob.getState().set({ error: null })}>
        Export failed — {job.error.slice(0, 60)} ✕
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-dim">
      {job.running && (
        <div className="h-1.5 w-24 overflow-hidden rounded bg-[#333]">
          <div className="h-full bg-[#bbb] transition-[width]" style={{ width: `${Math.round(job.fraction * 100)}%` }} />
        </div>
      )}
      <span>{job.label}</span>
      {job.running && (
        <button className="text-ink-faint hover:text-ink" onClick={() => job.controller?.abort()} title="Cancel export">✕</button>
      )}
    </div>
  );
}
