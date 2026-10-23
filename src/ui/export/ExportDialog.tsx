/**
 * Export: the single-photo dialog (editor, Ctrl/Cmd+E), the batch dialog (the selection) and the
 * export queue panel. Both dialogs share the settings form and export presets (built-in + saved).
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { COLOR_SPACES, type ColorSpaceId } from '../../color/matrices';
import { pickSaveTarget, runExport } from '../../io/encode/exportClient';
import {
  BUILTIN_EXPORT_PRESETS,
  EXT,
  type ExportFormat,
  type ExportPreset,
  type ExportSettings,
  type ExportSize,
  FORMAT_CAPS,
  FORMAT_LABEL,
  applyTemplate,
  baseSettings,
  exportFileName,
  normalizeSettings,
  outputSize,
} from '../../io/encode/exportSettings';
import type { MetadataMode } from '../../io/metadata/exif';
import { catalog, kvGet, kvSet } from '../../library/db';
import { cancelExport, dismissExport, eta, pauseExport, resumeExport, retryFailed, startExportJob, useExportQueue } from '../../library/exportQueue';
import { activeCopy, useEdit } from '../../state/editStore';
import { computeGeo } from '../../geometry/transform';
import { effectiveRecipe } from '../../recipe/schema';
import { type LoadedImage, useImage } from '../../state/imageStore';
import { targetIds, useLibrary } from '../../state/libraryStore';
import { useUi } from '../../state/uiStore';
import { useSettings } from '../../state/settingsStore';

interface ExportJobState {
  running: boolean;
  fraction: number;
  label: string;
  error: string | null;
  controller: AbortController | null;
  set(p: Partial<ExportJobState>): void;
}

export const useExportJob = create<ExportJobState>((set) => ({
  running: false,
  fraction: 0,
  label: '',
  error: null,
  controller: null,
  set: (p) => set(p),
}));

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function useExportPresets() {
  const [user, setUser] = useState<ExportPreset[]>([]);
  useEffect(() => {
    void catalog.exportPresets.toArray().then((l) => setUser(l.map((p) => ({ id: p.id, name: p.name, settings: normalizeSettings(p.settings as ExportSettings) }))));
  }, []);
  const save = async (name: string, settings: ExportSettings) => {
    const p = { id: `user-${crypto.randomUUID().slice(0, 8)}`, name, settings };
    await catalog.exportPresets.put(p);
    setUser((u) => [...u, p]);
    return p;
  };
  const remove = async (id: string) => {
    await catalog.exportPresets.delete(id);
    setUser((u) => u.filter((p) => p.id !== id));
  };
  return { all: [...BUILTIN_EXPORT_PRESETS, ...user], user, save, remove };
}

/** Settings a dialog opens with: the default export preset (Settings), else the last used. */
async function initialSettings(): Promise<{ settings: ExportSettings; presetId: string }> {
  const def = useSettings.getState().defaultExportPreset;
  const last = await kvGet<{ settings: ExportSettings; presetId: string } | null>('lastExport', null);
  if (def) {
    const b = BUILTIN_EXPORT_PRESETS.find((p) => p.id === def);
    if (b) return { settings: structuredClone(b.settings), presetId: b.id };
    const u = await catalog.exportPresets.get(def).catch(() => undefined);
    if (u) return { settings: normalizeSettings(u.settings as ExportSettings), presetId: u.id };
  }
  if (last) return { settings: normalizeSettings(last.settings), presetId: last.presetId };
  return { settings: structuredClone(BUILTIN_EXPORT_PRESETS[1].settings), presetId: BUILTIN_EXPORT_PRESETS[1].id };
}

// ---------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

function SettingsForm({ s, update, sample }: { s: ExportSettings; update(p: Partial<ExportSettings>): void; sample?: { w: number; h: number } }) {
  const caps = FORMAT_CAPS[s.format];
  const sizeOf = sample ? outputSize(sample.w, sample.h, s.size, s.allowUpscale) : null;
  const setSize = (m: ExportSize['mode']) => {
    const sizes: Record<ExportSize['mode'], ExportSize> = {
      original: { mode: 'original' },
      longEdge: { mode: 'longEdge', px: 2048 },
      shortEdge: { mode: 'shortEdge', px: 1080 },
      megapixels: { mode: 'megapixels', mp: 12 },
      percent: { mode: 'percent', pct: 50 },
      exact: { mode: 'exact', width: 1080, height: 1350 },
    };
    update({ size: sizes[m] });
  };
  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, +v || lo));
  const wm = s.watermark;
  return (
    <div className="grid gap-x-6 md:grid-cols-2">
      <div>
        <Row label="Format">
          <div className="flex flex-wrap rounded border border-line" role="radiogroup" aria-label="Format">
            {(Object.keys(FORMAT_LABEL) as ExportFormat[]).map((f) => (
              <button key={f} role="radio" aria-checked={s.format === f}
                onClick={() => update({ format: f, colorSpace: FORMAT_CAPS[f].spaces.includes(s.colorSpace) ? s.colorSpace : 'srgb' })}
                className={`flex-1 rounded px-2 py-1.5 text-xs ${s.format === f ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}>
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
          {!caps.metadata && <div className="mt-1 text-[11px] text-ink-faint">{FORMAT_LABEL[s.format]}: sRGB only, no embedded metadata (encoder limits).</div>}
        </Row>
        {caps.quality && (
          <Row label={`Quality ${s.quality}`}>
            <input type="range" min={1} max={100} value={s.quality} className="w-full accent-[#9a9a9a]" aria-label="Quality" onChange={(e) => update({ quality: +e.target.value })} />
            {s.format === 'jpeg' && <div className="text-[11px] text-ink-faint">{s.quality >= 90 ? '4:4:4 chroma (no subsampling)' : '4:2:0 chroma subsampling'}</div>}
          </Row>
        )}
        {s.format === 'tiff' && (
          <Row label="Compression">
            <select className="input" aria-label="TIFF compression" value={s.tiffCompression} onChange={(e) => update({ tiffCompression: e.target.value as 'deflate' | 'none' })}>
              <option value="deflate">ZIP (lossless)</option>
              <option value="none">None</option>
            </select>
          </Row>
        )}
        <Row label="Color space">
          <select className="input" aria-label="Color space" value={s.colorSpace} onChange={(e) => update({ colorSpace: e.target.value as ColorSpaceId })}>
            {caps.spaces.map((id) => <option key={id} value={id}>{COLOR_SPACES[id].label}</option>)}
          </select>
        </Row>
        <Row label="Size">
          <div className="flex flex-wrap items-center gap-2">
            <select className="input" value={s.size.mode} onChange={(e) => setSize(e.target.value as ExportSize['mode'])} aria-label="Size mode">
              <option value="original">Original</option>
              <option value="longEdge">Long edge</option>
              <option value="shortEdge">Short edge</option>
              <option value="megapixels">Megapixels</option>
              <option value="percent">Percentage</option>
              <option value="exact">Exact (crop to fit)</option>
            </select>
            {(s.size.mode === 'longEdge' || s.size.mode === 'shortEdge') && (
              <input type="number" className="input w-20" min={16} max={20000} value={s.size.px} aria-label="Pixels"
                onChange={(e) => update({ size: { mode: s.size.mode as 'longEdge', px: num(e.target.value, 16, 20000) } })} />
            )}
            {s.size.mode === 'megapixels' && (
              <input type="number" className="input w-20" min={0.1} max={200} step={0.1} value={s.size.mp} aria-label="Megapixels"
                onChange={(e) => update({ size: { mode: 'megapixels', mp: Math.max(0.1, +e.target.value || 0.1) } })} />
            )}
            {s.size.mode === 'percent' && (
              <input type="number" className="input w-20" min={1} max={400} value={s.size.pct} aria-label="Percent"
                onChange={(e) => update({ size: { mode: 'percent', pct: num(e.target.value, 1, 400) } })} />
            )}
            {s.size.mode === 'exact' && (
              <>
                <input type="number" className="input w-20" min={16} max={20000} value={s.size.width} aria-label="Width"
                  onChange={(e) => update({ size: { ...(s.size as { mode: 'exact'; width: number; height: number }), width: num(e.target.value, 16, 20000) } })} />
                ×
                <input type="number" className="input w-20" min={16} max={20000} value={s.size.height} aria-label="Height"
                  onChange={(e) => update({ size: { ...(s.size as { mode: 'exact'; width: number; height: number }), height: num(e.target.value, 16, 20000) } })} />
              </>
            )}
          </div>
          <label className="mt-1 flex items-center gap-2 text-[11px] text-ink-dim"><input type="checkbox" checked={s.allowUpscale} onChange={(e) => update({ allowUpscale: e.target.checked })} /> Allow enlarging</label>
          {sizeOf && <div className="mt-1 text-[11px] text-ink-faint">{sizeOf.width} × {sizeOf.height} px</div>}
        </Row>
        <Row label="Output sharpening">
          <div className="flex gap-2">
            <select className="input" value={s.sharpen.target} onChange={(e) => update({ sharpen: { ...s.sharpen, target: e.target.value as ExportSettings['sharpen']['target'] } })} aria-label="Sharpen for">
              <option value="none">None</option><option value="screen">Screen</option><option value="matte">Matte paper</option><option value="glossy">Glossy paper</option>
            </select>
            {s.sharpen.target !== 'none' && (
              <select className="input" value={s.sharpen.amount} onChange={(e) => update({ sharpen: { ...s.sharpen, amount: e.target.value as ExportSettings['sharpen']['amount'] } })} aria-label="Sharpening amount">
                <option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option>
              </select>
            )}
          </div>
        </Row>
      </div>
      <div>
        <Row label="Metadata">
          <select className="input" aria-label="Metadata" value={s.metadata} disabled={!caps.metadata} onChange={(e) => update({ metadata: e.target.value as MetadataMode })}>
            <option value="keep">All</option>
            <option value="stripGps">All except location (GPS)</option>
            <option value="copyright">Copyright only</option>
            <option value="strip">None</option>
          </select>
        </Row>
        <Row label="Author & copyright (EXIF + XMP)">
          <input className="input mb-1 w-full" placeholder="Author" value={s.author.artist} onChange={(e) => update({ author: { ...s.author, artist: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
          <input className="input w-full" placeholder="© 2026 Your Name" value={s.author.copyright} onChange={(e) => update({ author: { ...s.author, copyright: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
        </Row>
        {(s.format === 'tiff' || s.format === 'jpeg' || s.format === 'png') && (
          <Row label="Print resolution">
            <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="number" className="input w-20" min={36} max={1200} value={s.dpi} onChange={(e) => update({ dpi: num(e.target.value, 36, 1200) })} /> ppi</label>
          </Row>
        )}
        <Row label="File name">
          <input className="input w-full font-mono" value={s.fileName} onChange={(e) => update({ fileName: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="File name template" />
          <div className="mt-1 text-[10px] leading-snug text-ink-faint">{'{filename} {date:YYYY-MM-DD} {seq:001} {preset} {rating} {camera} {custom} {copy}'}</div>
        </Row>
        <Row label="Watermark">
          <label className="mb-1 flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={wm.enabled} onChange={(e) => update({ watermark: { ...wm, enabled: e.target.checked } })} /> Add a watermark</label>
          {wm.enabled && (
            <div className="space-y-1 text-xs text-ink-dim">
              <div className="flex gap-2">
                <select className="input" value={wm.kind} onChange={(e) => update({ watermark: { ...wm, kind: e.target.value as 'text' | 'image' } })} aria-label="Watermark type">
                  <option value="text">Text</option><option value="image">PNG image</option>
                </select>
                {wm.kind === 'text' ? (
                  <input className="input min-w-0 flex-1" value={wm.text} onChange={(e) => update({ watermark: { ...wm, text: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} aria-label="Watermark text" />
                ) : (
                  <label className="input flex-1 cursor-pointer truncate">{wm.imageName || 'Choose PNG…'}
                    <input type="file" accept="image/png" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) update({ watermark: { ...wm, image: new Uint8Array(await f.arrayBuffer()), imageName: f.name } });
                    }} />
                  </label>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className="input" value={wm.position} onChange={(e) => update({ watermark: { ...wm, position: e.target.value as typeof wm.position } })} aria-label="Position">
                  {[['tl', 'Top left'], ['tc', 'Top'], ['tr', 'Top right'], ['cl', 'Left'], ['c', 'Centre'], ['cr', 'Right'], ['bl', 'Bottom left'], ['bc', 'Bottom'], ['br', 'Bottom right']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {wm.kind === 'text' && (
                  <select className="input" value={wm.color} onChange={(e) => update({ watermark: { ...wm, color: e.target.value as 'white' | 'black' } })} aria-label="Colour">
                    <option value="white">White</option><option value="black">Black</option>
                  </select>
                )}
              </div>
              <label className="flex items-center gap-2">Size <input type="range" min={1} max={20} value={wm.size} className="flex-1 accent-[#9a9a9a]" onChange={(e) => update({ watermark: { ...wm, size: +e.target.value } })} /><span className="w-8 tabular-nums">{wm.size}%</span></label>
              <label className="flex items-center gap-2">Opacity <input type="range" min={5} max={100} value={wm.opacity} className="flex-1 accent-[#9a9a9a]" onChange={(e) => update({ watermark: { ...wm, opacity: +e.target.value } })} /><span className="w-8 tabular-nums">{wm.opacity}%</span></label>
              <label className="flex items-center gap-2">Margin <input type="range" min={0} max={15} value={wm.margin} className="flex-1 accent-[#9a9a9a]" onChange={(e) => update({ watermark: { ...wm, margin: +e.target.value } })} /><span className="w-8 tabular-nums">{wm.margin}%</span></label>
            </div>
          )}
        </Row>
        <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={s.sidecar} onChange={(e) => update({ sidecar: e.target.checked })} /> Also save the edit as <code className="text-[11px]">.optic.json</code></label>
      </div>
    </div>
  );
}

function PresetBar({ presetId, setPreset, s }: { presetId: string; setPreset(id: string, s: ExportSettings): void; s: ExportSettings }) {
  const presets = useExportPresets();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <select className="input min-w-0 flex-1" value={presetId} aria-label="Export preset" onChange={(e) => {
        const p = presets.all.find((x) => x.id === e.target.value);
        if (p) setPreset(p.id, structuredClone(p.settings));
      }}>
        <option value="" disabled>Custom settings</option>
        <optgroup label="Built-in">{BUILTIN_EXPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        {presets.user.length > 0 && <optgroup label="My presets">{presets.user.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
      </select>
      <button className="rounded border border-line px-2 py-1 text-[11px] hover:bg-hover" onClick={async () => {
        const name = prompt('Name of the export preset');
        if (name?.trim()) { const p = await presets.save(name.trim(), s); setPreset(p.id, s); }
      }}>Save preset…</button>
      {presets.user.some((p) => p.id === presetId) && (
        <button className="rounded px-2 py-1 text-[11px] text-ink-faint hover:text-[#e07070]" onClick={() => { if (confirm('Delete this export preset?')) void presets.remove(presetId).then(() => setPreset('', s)); }}>Delete</button>
      )}
    </div>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl" role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <h2 className="mb-3 text-sm font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function useInitialSettings(defaults?: (s: ExportSettings) => ExportSettings) {
  const [state, setState] = useState<{ s: ExportSettings; presetId: string } | null>(null);
  useEffect(() => {
    void initialSettings().then(({ settings, presetId }) => setState({ s: defaults ? defaults(settings) : settings, presetId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [state, setState] as const;
}

// ---------------------------------------------------------------------------
// Single photo
// ---------------------------------------------------------------------------

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  const image = useImage((s) => s.image);
  if (!open || !image) return null;
  return <SingleDialog image={image} key={image.id} />;
}

function SingleDialog({ image }: { image: LoadedImage }) {
  const [state, setState] = useInitialSettings();
  const close = () => useUi.getState().set({ exportOpen: false });
  const recipe = useEdit((st) => st.recipe);
  const copyName = useEdit((st) => (st.copies.length > 1 && st.active !== st.copies[0].id ? activeCopy(st).name : ''));
  const out = useMemo(() => computeGeo(image.model, effectiveRecipe(recipe, image.asShot)), [image, recipe]);
  const job = useExportJob();
  const photoId = useImage((s) => s.photoId);
  const rec = useLibrary((s) => (photoId ? s.byId.get(photoId) : undefined));
  if (!state) return null;
  const s = state.s;
  const update = (p: Partial<ExportSettings>) => setState({ s: { ...s, ...p }, presetId: '' });
  const base = applyTemplate(s.fileName, {
    filename: image.fileName, date: rec?.captureDate ?? Date.now(), seq: 1, preset: state.presetId ? BUILTIN_EXPORT_PRESETS.find((p) => p.id === state.presetId)?.name ?? '' : '',
    rating: rec?.rating ?? 0, camera: rec?.camera ?? '', custom: '', copy: copyName,
  });
  const name = s.fileName === '{filename}' ? exportFileName(image.fileName, s.format, copyName) : `${base}.${EXT[s.format]}`;

  const start = async () => {
    void kvSet('lastExport', { settings: s, presetId: state.presetId });
    let handle = null;
    try {
      handle = await pickSaveTarget(name, s.format);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    useEdit.getState().commit();
    const recipeNow = useEdit.getState().recipe;
    const controller = new AbortController();
    useExportJob.getState().set({ running: true, fraction: 0, label: 'Starting', error: null, controller });
    close();
    const t0 = performance.now();
    try {
      await runExport(image, recipeNow, s, handle, (fraction, label) => useExportJob.getState().set({ fraction, label }), controller.signal, name);
      console.info(`[optic] exported ${name} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      useExportJob.getState().set({ running: false, label: 'Saved', controller: null });
      setTimeout(() => !useExportJob.getState().running && useExportJob.getState().set({ label: '' }), 3000);
    } catch (e) {
      const err = e as Error;
      const cancelled = err.name === 'AbortError' || controller.signal.aborted;
      if (!cancelled) console.warn('[optic] export failed', err);
      useExportJob.getState().set({ running: false, controller: null, label: '', error: cancelled ? null : err.message });
    }
  };

  return (
    <Shell title="Export" onClose={close}>
      <PresetBar presetId={state.presetId} s={s} setPreset={(id, settings) => setState({ s: settings, presetId: id })} />
      <SettingsForm s={s} update={update} sample={{ w: out.outW, h: out.outH }} />
      <div className="mt-2 truncate text-[11px] text-ink-faint" title={name}>{name}</div>
      {job.error && <div className="mt-2 text-xs text-[#e07070]">Last export failed: {job.error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>Cancel</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={job.running} onClick={() => void start()}>
          {job.running ? 'Export running…' : 'Export'}
        </button>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export function BatchExportDialog() {
  const open = useUi((s) => s.batchExportOpen);
  if (!open) return null;
  return <BatchDialog />;
}

function BatchDialog() {
  const [state, setState] = useInitialSettings();
  const [custom, setCustom] = useState('');
  const [dest, setDest] = useState<'folder' | 'zip'>(() => ('showDirectoryPicker' in window ? 'folder' : 'zip'));
  const close = () => useUi.getState().set({ batchExportOpen: false });
  const ids = useMemo(() => targetIds(), []);
  const running = useExportQueue((s) => s.job?.status === 'running');
  const first = useLibrary.getState().byId.get(ids[0]);
  if (!state) return null;
  const s = state.s;
  const update = (p: Partial<ExportSettings>) => setState({ s: { ...s, ...p }, presetId: '' });
  const presetName = BUILTIN_EXPORT_PRESETS.find((p) => p.id === state.presetId)?.name ?? '';
  const sampleName = first ? `${applyTemplate(s.fileName, { filename: first.fileName, date: first.captureDate, seq: 1, preset: presetName, rating: first.rating, camera: first.camera, custom })}.${EXT[s.format]}` : '';
  const start = async () => {
    void kvSet('lastExport', { settings: s, presetId: state.presetId });
    let folder: FileSystemDirectoryHandle | null = null;
    if (dest === 'folder') {
      try {
        folder = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        throw e;
      }
    }
    close();
    const zipName = `optic-export-${new Date().toISOString().slice(0, 10)}.zip`;
    await startExportJob(ids, s, { presetName, custom, folder, zipName });
  };
  return (
    <Shell title={`Export ${ids.length} photo${ids.length === 1 ? '' : 's'}`} onClose={close}>
      <PresetBar presetId={state.presetId} s={s} setPreset={(id, settings) => setState({ s: settings, presetId: id })} />
      <SettingsForm s={s} update={update} sample={first && first.width ? { w: first.width, h: first.height } : undefined} />
      <div className="mt-1 grid gap-x-6 md:grid-cols-2">
        <Row label="Destination">
          <label className={`flex items-center gap-2 text-xs ${'showDirectoryPicker' in window ? 'text-ink-dim' : 'text-ink-faint'}`}>
            <input type="radio" name="dest" checked={dest === 'folder'} disabled={!('showDirectoryPicker' in window)} onChange={() => setDest('folder')} /> Save into a folder…
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="radio" name="dest" checked={dest === 'zip'} onChange={() => setDest('zip')} /> Download as a ZIP (streamed; any size)</label>
        </Row>
        <Row label="{custom} text">
          <input className="input w-full" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Custom text for the file name" />
        </Row>
      </div>
      {sampleName && <div className="truncate text-[11px] text-ink-faint">First file: {sampleName}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>Cancel</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={running || !ids.length} onClick={() => void start()}>
          {running ? 'An export is running…' : `Export ${ids.length}`}
        </button>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const fmtTime = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

/** Export queue panel: per-photo progress, ETA, pause / cancel / retry, and the summary. */
export function ExportQueuePanel() {
  const job = useExportQueue((s) => s.job);
  const open = useExportQueue((s) => s.panelOpen);
  const current = useExportQueue((s) => s.current);
  if (!job || !open) return null;
  const done = job.items.filter((i) => i.state === 'done');
  const failed = job.items.filter((i) => i.state === 'failed');
  const left = job.items.filter((i) => i.state === 'pending' || i.state === 'running').length;
  const total = done.reduce((s, i) => s + (i.bytes ?? 0), 0);
  const e = eta(job);
  const fraction = (done.length + failed.length + (current?.fraction ?? 0)) / Math.max(1, job.items.length);
  return (
    <div className="fixed bottom-3 right-3 z-40 flex max-h-[70vh] w-[380px] max-w-[calc(100vw-24px)] flex-col rounded-lg border border-line bg-panel text-xs text-ink shadow-2xl" role="region" aria-label="Export queue">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-medium">
          {job.status === 'done' ? 'Export finished' : job.status === 'cancelled' ? 'Export cancelled' : job.status === 'interrupted' ? 'Export interrupted' : job.status === 'paused' ? 'Export paused' : 'Exporting'}
        </span>
        <span className="text-ink-faint">{done.length}/{job.items.length}</span>
        <div className="flex-1" />
        <button className="text-ink-faint hover:text-ink" aria-label="Hide export panel" onClick={() => useExportQueue.getState().set({ panelOpen: false })}>—</button>
      </div>
      <div className="px-3 py-2">
        <div className="mb-1 h-1.5 overflow-hidden rounded bg-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div className="h-full bg-meter transition-[width]" style={{ width: `${fraction * 100}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-ink-dim">
          <span className="truncate">{job.status === 'running' ? current?.label ?? 'Starting…' : `${done.length} exported · ${fmtBytes(total)}${failed.length ? ` · ${failed.length} failed` : ''}`}</span>
          {job.status === 'running' && e !== null && <span className="ml-2 shrink-0">~{fmtTime(e)} left</span>}
        </div>
        <div className="mt-1 text-[11px] text-ink-faint">{job.destination === 'folder' ? `To folder “${job.folderName ?? ''}”` : 'ZIP download when finished'}{job.presetName ? ` · ${job.presetName}` : ''}</div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-1" aria-label="Photos">
        {job.items.map((i) => (
          <li key={i.photoId} className="flex items-center gap-2 py-0.5 text-[11px]">
            <span className={`w-3 text-center ${i.state === 'done' ? 'text-[#7fc77f]' : i.state === 'failed' ? 'text-[#e07070]' : 'text-ink-faint'}`} aria-hidden>
              {i.state === 'done' ? '✓' : i.state === 'failed' ? '!' : i.state === 'running' ? '…' : i.state === 'cancelled' ? '–' : '·'}
            </span>
            <span className="min-w-0 flex-1 truncate" title={i.error ?? i.outName ?? i.fileName}>{i.outName ?? i.fileName}</span>
            {i.bytes ? <span className="text-ink-faint">{fmtBytes(i.bytes)}</span> : null}
            {i.error && <span className="max-w-[140px] truncate text-[#e07070]" title={i.error}>{i.error}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-3 py-2">
        {job.status === 'running' && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={pauseExport}>Pause</button>}
        {(job.status === 'paused' || job.status === 'interrupted') && left > 0 && <button className="rounded bg-accent px-2 py-1 font-medium text-on-accent hover:bg-accent-hi" onClick={() => void resumeExport()}>Resume</button>}
        {(job.status === 'running' || job.status === 'paused' || job.status === 'interrupted') && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={cancelExport}>Cancel</button>}
        {(job.status === 'done' || job.status === 'cancelled') && failed.length > 0 && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={retryFailed}>Retry failed</button>}
        {(job.status === 'done' || job.status === 'cancelled' || job.status === 'interrupted') && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={dismissExport}>Close</button>}
      </div>
    </div>
  );
}

/** Small progress pill for the top bar: single export, or the batch queue (click to show it). */
export function ExportProgress() {
  const job = useExportJob();
  const q = useExportQueue((s) => s.job);
  const panelOpen = useExportQueue((s) => s.panelOpen);
  if (q && !panelOpen && (q.status === 'running' || q.status === 'paused' || q.status === 'interrupted')) {
    const done = q.items.filter((i) => i.state === 'done').length;
    return <button className="rounded bg-hover px-2 py-1 text-[11px] text-ink" onClick={() => useExportQueue.getState().set({ panelOpen: true })}>Export {done}/{q.items.length}{q.status !== 'running' ? ` (${q.status})` : ''}</button>;
  }
  if (!job.running && !job.label && !job.error) return null;
  if (job.error && !job.running) {
    return (
      <button className="rounded bg-[#4a2626] px-2 py-1 text-[11px] text-[#f0b0b0]" onClick={() => useExportJob.getState().set({ error: null })}>
        Export failed — {job.error.slice(0, 60)} ✕
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-dim" role="status" aria-live="polite">
      {job.running && (
        <div className="h-1.5 w-24 overflow-hidden rounded bg-hover">
          <div className="h-full bg-meter transition-[width]" style={{ width: `${Math.round(job.fraction * 100)}%` }} />
        </div>
      )}
      <span>{job.label}</span>
      {job.running && (
        <button className="text-ink-faint hover:text-ink" onClick={() => job.controller?.abort()} title="Cancel export" aria-label="Cancel export">✕</button>
      )}
    </div>
  );
}

export { baseSettings };
