import { t as tr } from '../../i18n';
/**
 * Export: the single-photo dialog (editor, Ctrl/Cmd+E), the batch dialog (the selection) and the
 * export queue panel. Both dialogs share the settings form and export presets (built-in + saved).
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
import { useFocusTrap } from '../focusTrap';
import { confirmDialog, promptDialog } from '../feedback/dialogs';
import { useExportJob } from './ExportProgress';
import { useSettings } from '../../state/settingsStore';
import { IconButton } from '../controls/IconButton';
import { tp } from '../../i18n/format';

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
      <div className="mb-1 text-2xs uppercase tracking-wider text-ink-faint">{label}</div>
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
        <Row label={tr('exportDialog.format')}>
          <div className="flex flex-wrap rounded border border-line" role="radiogroup" aria-label={tr('exportDialog.format')}>
            {(Object.keys(FORMAT_LABEL) as ExportFormat[]).map((f) => (
              <button key={f} role="radio" aria-checked={s.format === f}
                onClick={() => update({ format: f, colorSpace: FORMAT_CAPS[f].spaces.includes(s.colorSpace) ? s.colorSpace : 'srgb' })}
                className={`flex-1 rounded px-2 py-1.5 text-xs ${s.format === f ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}>
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
          {!caps.metadata && <div className="mt-1 text-2xs text-ink-faint">{FORMAT_LABEL[s.format]}{tr('exportDialog.srgb_only_no_embedded_metadata_encoder')}</div>}
        </Row>
        {caps.quality && (
          <Row label={tr('exportDialog.quality_quality', { quality: s.quality })}>
            <input type="range" min={1} max={100} value={s.quality} className="w-full accent-control" aria-label={tr('exportDialog.quality')} onChange={(e) => update({ quality: +e.target.value })} />
            {s.format === 'jpeg' && <div className="text-2xs text-ink-faint">{s.quality >= 90 ? tr('exportDialog.4_4_4_chroma_no_subsampling') : tr('exportDialog.4_2_0_chroma_subsampling')}</div>}
          </Row>
        )}
        {s.format === 'tiff' && (
          <Row label={tr('exportDialog.compression')}>
            <select className="input" aria-label={tr('exportDialog.tiff_compression')} value={s.tiffCompression} onChange={(e) => update({ tiffCompression: e.target.value as 'deflate' | 'none' })}>
              <option value="deflate">{tr('exportDialog.zip_lossless')}</option>
              <option value="none">{tr('exportDialog.none')}</option>
            </select>
          </Row>
        )}
        <Row label={tr('exportDialog.color_space')}>
          <select className="input" aria-label={tr('exportDialog.color_space')} value={s.colorSpace} onChange={(e) => update({ colorSpace: e.target.value as ColorSpaceId })}>
            {caps.spaces.map((id) => <option key={id} value={id}>{COLOR_SPACES[id].label}</option>)}
          </select>
        </Row>
        <Row label={tr('exportDialog.size')}>
          <div className="flex flex-wrap items-center gap-2">
            <select className="input" value={s.size.mode} onChange={(e) => setSize(e.target.value as ExportSize['mode'])} aria-label={tr('exportDialog.size_mode')}>
              <option value="original">{tr('exportDialog.original')}</option>
              <option value="longEdge">{tr('exportDialog.long_edge')}</option>
              <option value="shortEdge">{tr('exportDialog.short_edge')}</option>
              <option value="megapixels">{tr('exportDialog.megapixels')}</option>
              <option value="percent">{tr('exportDialog.percentage')}</option>
              <option value="exact">{tr('exportDialog.exact_crop_to_fit')}</option>
            </select>
            {(s.size.mode === 'longEdge' || s.size.mode === 'shortEdge') && (
              <input type="number" className="input w-20" min={16} max={20000} value={s.size.px} aria-label={tr('exportDialog.pixels')}
                onChange={(e) => update({ size: { mode: s.size.mode as 'longEdge', px: num(e.target.value, 16, 20000) } })} />
            )}
            {s.size.mode === 'megapixels' && (
              <input type="number" className="input w-20" min={0.1} max={200} step={0.1} value={s.size.mp} aria-label={tr('exportDialog.megapixels')}
                onChange={(e) => update({ size: { mode: 'megapixels', mp: Math.max(0.1, +e.target.value || 0.1) } })} />
            )}
            {s.size.mode === 'percent' && (
              <input type="number" className="input w-20" min={1} max={400} value={s.size.pct} aria-label={tr('exportDialog.percent')}
                onChange={(e) => update({ size: { mode: 'percent', pct: num(e.target.value, 1, 400) } })} />
            )}
            {s.size.mode === 'exact' && (
              <>
                <input type="number" className="input w-20" min={16} max={20000} value={s.size.width} aria-label={tr('exportDialog.width')}
                  onChange={(e) => update({ size: { ...(s.size as { mode: 'exact'; width: number; height: number }), width: num(e.target.value, 16, 20000) } })} />
                ×
                <input type="number" className="input w-20" min={16} max={20000} value={s.size.height} aria-label={tr('exportDialog.height')}
                  onChange={(e) => update({ size: { ...(s.size as { mode: 'exact'; width: number; height: number }), height: num(e.target.value, 16, 20000) } })} />
              </>
            )}
          </div>
          <label className="mt-1 flex items-center gap-2 text-2xs text-ink-dim"><input type="checkbox" checked={s.allowUpscale} onChange={(e) => update({ allowUpscale: e.target.checked })} /> {tr('exportDialog.allow_enlarging')}</label>
          {sizeOf && <div className="mt-1 text-2xs text-ink-faint">{tr('exportDialog.width_height_px', { width: sizeOf.width, height: sizeOf.height })}</div>}
        </Row>
        <Row label={tr('exportDialog.output_sharpening')}>
          <div className="flex gap-2">
            <select className="input" value={s.sharpen.target} onChange={(e) => update({ sharpen: { ...s.sharpen, target: e.target.value as ExportSettings['sharpen']['target'] } })} aria-label={tr('exportDialog.sharpen_for')}>
              <option value="none">{tr('exportDialog.none')}</option><option value="screen">{tr('exportDialog.screen')}</option><option value="matte">{tr('exportDialog.matte_paper')}</option><option value="glossy">{tr('exportDialog.glossy_paper')}</option>
            </select>
            {s.sharpen.target !== 'none' && (
              <select className="input" value={s.sharpen.amount} onChange={(e) => update({ sharpen: { ...s.sharpen, amount: e.target.value as ExportSettings['sharpen']['amount'] } })} aria-label={tr('exportDialog.sharpening_amount')}>
                <option value="low">{tr('exportDialog.low')}</option><option value="standard">{tr('exportDialog.standard')}</option><option value="high">{tr('exportDialog.high')}</option>
              </select>
            )}
          </div>
        </Row>
      </div>
      <div>
        <Row label={tr('exportDialog.metadata')}>
          <select className="input" aria-label={tr('exportDialog.metadata')} value={s.metadata} disabled={!caps.metadata} onChange={(e) => update({ metadata: e.target.value as MetadataMode })}>
            <option value="keep">{tr('exportDialog.all')}</option>
            <option value="stripGps">{tr('exportDialog.all_except_location_gps')}</option>
            <option value="copyright">{tr('exportDialog.copyright_only')}</option>
            <option value="strip">{tr('exportDialog.none')}</option>
          </select>
        </Row>
        <Row label={tr('exportDialog.author_copyright_exif_xmp')}>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-2xs text-ink-dim">
            <label htmlFor="optic-export-author">{tr('exportDialog.author')}</label>
            <input id="optic-export-author" className="input w-full" autoComplete="name" value={s.author.artist} onChange={(e) => update({ author: { ...s.author, artist: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
            <label htmlFor="optic-export-copyright">{tr('exportDialog.copyright')}</label>
            <input id="optic-export-copyright" className="input w-full" aria-describedby="optic-export-copyright-hint" value={s.author.copyright} onChange={(e) => update({ author: { ...s.author, copyright: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
            <span />
            <span id="optic-export-copyright-hint" className="text-ink-faint">{tr('exportDialog.copyright_example', { year: new Date().getFullYear() })}</span>
          </div>
        </Row>
        {(s.format === 'tiff' || s.format === 'jpeg' || s.format === 'png') && (
          <Row label={tr('exportDialog.print_resolution')}>
            <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="number" className="input w-20" min={36} max={1200} value={s.dpi} aria-label={tr('exportDialog.print_resolution_in_pixels_per_inch')} onChange={(e) => update({ dpi: num(e.target.value, 36, 1200) })} /> {tr('exportDialog.ppi')}</label>
          </Row>
        )}
        <Row label={tr('exportDialog.file_name')}>
          <input className="input w-full font-mono" value={s.fileName} onChange={(e) => update({ fileName: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label={tr('exportDialog.file_name_template')} />
          <div className="mt-1 text-2xs leading-snug text-ink-faint">{tr('exportDialog.filename_date_yyyy_mm_dd_seq')}</div>
        </Row>
        <Row label={tr('exportDialog.watermark')}>
          <label className="mb-1 flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={wm.enabled} onChange={(e) => update({ watermark: { ...wm, enabled: e.target.checked } })} /> {tr('exportDialog.add_a_watermark')}</label>
          {wm.enabled && (
            <div className="space-y-1 text-xs text-ink-dim">
              <div className="flex gap-2">
                <select className="input" value={wm.kind} onChange={(e) => update({ watermark: { ...wm, kind: e.target.value as 'text' | 'image' } })} aria-label={tr('exportDialog.watermark_type')}>
                  <option value="text">{tr('exportDialog.text')}</option><option value="image">{tr('exportDialog.png_image')}</option>
                </select>
                {wm.kind === 'text' ? (
                  <input className="input min-w-0 flex-1" value={wm.text} onChange={(e) => update({ watermark: { ...wm, text: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} aria-label={tr('exportDialog.watermark_text')} />
                ) : (
                  <label className="input flex-1 cursor-pointer truncate">{wm.imageName || tr('exportDialog.choose_png')}
                    <input type="file" accept="image/png" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) update({ watermark: { ...wm, image: new Uint8Array(await f.arrayBuffer()), imageName: f.name } });
                    }} />
                  </label>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className="input" value={wm.position} onChange={(e) => update({ watermark: { ...wm, position: e.target.value as typeof wm.position } })} aria-label={tr('exportDialog.position')}>
                  {[['tl', tr('exportDialog.top_left')], ['tc', tr('exportDialog.top')], ['tr', tr('exportDialog.top_right')], ['cl', tr('exportDialog.left')], ['c', tr('exportDialog.centre')], ['cr', tr('exportDialog.right')], ['bl', tr('exportDialog.bottom_left')], ['bc', tr('exportDialog.bottom')], ['br', tr('exportDialog.bottom_right')]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {wm.kind === 'text' && (
                  <select className="input" value={wm.color} onChange={(e) => update({ watermark: { ...wm, color: e.target.value as 'white' | 'black' } })} aria-label={tr('exportDialog.colour')}>
                    <option value="white">{tr('exportDialog.white')}</option><option value="black">{tr('exportDialog.black')}</option>
                  </select>
                )}
              </div>
              <label className="flex items-center gap-2">{tr('exportDialog.size')} <input type="range" min={1} max={20} value={wm.size} className="flex-1 accent-control" onChange={(e) => update({ watermark: { ...wm, size: +e.target.value } })} /><span className="w-8 tabular-nums">{wm.size}%</span></label>
              <label className="flex items-center gap-2">{tr('exportDialog.opacity')} <input type="range" min={5} max={100} value={wm.opacity} className="flex-1 accent-control" onChange={(e) => update({ watermark: { ...wm, opacity: +e.target.value } })} /><span className="w-8 tabular-nums">{wm.opacity}%</span></label>
              <label className="flex items-center gap-2">{tr('exportDialog.margin')} <input type="range" min={0} max={15} value={wm.margin} className="flex-1 accent-control" onChange={(e) => update({ watermark: { ...wm, margin: +e.target.value } })} /><span className="w-8 tabular-nums">{wm.margin}%</span></label>
            </div>
          )}
        </Row>
        <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={s.sidecar} onChange={(e) => update({ sidecar: e.target.checked })} /> {tr('exportDialog.also_save_the_edit_as')} <code className="text-2xs">{tr('exportDialog.optic_json')}</code></label>
      </div>
    </div>
  );
}

function PresetBar({ presetId, setPreset, s }: { presetId: string; setPreset(id: string, s: ExportSettings): void; s: ExportSettings }) {
  const presets = useExportPresets();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <select className="input min-w-0 flex-1" value={presetId} aria-label={tr('exportDialog.export_preset')} onChange={(e) => {
        const p = presets.all.find((x) => x.id === e.target.value);
        if (p) setPreset(p.id, structuredClone(p.settings));
      }}>
        <option value="" disabled>{tr('exportDialog.custom_settings')}</option>
        <optgroup label={tr('exportDialog.built_in')}>{BUILTIN_EXPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        {presets.user.length > 0 && <optgroup label={tr('exportDialog.my_presets')}>{presets.user.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
      </select>
      <button className="rounded border border-line px-2 py-1 text-2xs hover:bg-hover" onClick={async () => {
        const name = await promptDialog({ title: tr('exportDialog.save_export_preset'), label: tr('exportDialog.preset_name'), confirmLabel: tr('exportDialog.save_preset') });
        if (name) { const p = await presets.save(name, s); setPreset(p.id, s); }
      }}>{tr('exportDialog.save_preset_2')}</button>
      {presets.user.some((p) => p.id === presetId) && (
        <button className="rounded px-2 py-1 text-2xs text-ink-faint hover:text-danger" onClick={async () => {
          if (await confirmDialog({ title: tr('exportDialog.delete_this_export_preset'), confirmLabel: tr('exportDialog.delete_preset'), danger: true })) void presets.remove(presetId).then(() => setPreset('', s));
        }}>{tr('exportDialog.delete')}</button>
      )}
    </div>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl" role="dialog" aria-modal="true" aria-label={title}
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
    useExportJob.getState().set({ running: true, fraction: 0, label: tr('exportDialog.starting'), error: null, controller });
    close();
    const t0 = performance.now();
    try {
      await runExport(image, recipeNow, s, handle, (fraction, label) => useExportJob.getState().set({ fraction, label }), controller.signal, name);
      console.info(`[optic] exported ${name} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      useExportJob.getState().set({ running: false, label: tr('exportDialog.saved'), controller: null });
      setTimeout(() => !useExportJob.getState().running && useExportJob.getState().set({ label: '' }), 3000);
    } catch (e) {
      const err = e as Error;
      const cancelled = err.name === 'AbortError' || controller.signal.aborted;
      if (!cancelled) console.warn('[optic] export failed', err);
      useExportJob.getState().set({ running: false, controller: null, label: '', error: cancelled ? null : err.message });
    }
  };

  return (
    <Shell title={tr('exportDialog.export')} onClose={close}>
      <PresetBar presetId={state.presetId} s={s} setPreset={(id, settings) => setState({ s: settings, presetId: id })} />
      <SettingsForm s={s} update={update} sample={{ w: out.outW, h: out.outH }} />
      <div className="mt-2 truncate text-2xs text-ink-faint" title={name}>{name}</div>
      {job.error && <div className="mt-2 text-xs text-danger">{tr('exportDialog.last_export_failed_error', { error: job.error })}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('exportDialog.cancel')}</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={job.running} onClick={() => void start()}>
          {job.running ? tr('exportDialog.export_running') : tr('exportDialog.export')}
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
    <Shell title={tp('exportDialog.export_photos', ids.length)} onClose={close}>
      <PresetBar presetId={state.presetId} s={s} setPreset={(id, settings) => setState({ s: settings, presetId: id })} />
      <SettingsForm s={s} update={update} sample={first && first.width ? { w: first.width, h: first.height } : undefined} />
      <div className="mt-1 grid gap-x-6 md:grid-cols-2">
        <Row label={tr('exportDialog.destination')}>
          <label className={`flex items-center gap-2 text-xs ${'showDirectoryPicker' in window ? 'text-ink-dim' : 'text-ink-faint'}`}>
            <input type="radio" name="dest" checked={dest === 'folder'} disabled={!('showDirectoryPicker' in window)} onChange={() => setDest('folder')} /> {tr('exportDialog.save_into_a_folder')}</label>
          <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="radio" name="dest" checked={dest === 'zip'} onChange={() => setDest('zip')} /> {tr('exportDialog.download_as_a_zip_streamed_any')}</label>
        </Row>
        <Row label={tr('exportDialog.custom_text')}>
          <input className="input w-full" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label={tr('exportDialog.custom_text_for_the_file_name')} />
        </Row>
      </div>
      {sampleName && <div className="truncate text-2xs text-ink-faint">{tr('exportDialog.first_file_samplename', { sampleName: sampleName })}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('exportDialog.cancel')}</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40" disabled={running || !ids.length} onClick={() => void start()}>
          {running ? tr('exportDialog.an_export_is_running') : tr('exportDialog.export_n', { n: ids.length })}
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
    <div className="fixed bottom-3 end-3 z-40 flex max-h-[70vh] w-[380px] max-w-[calc(100vw-24px)] flex-col rounded-lg border border-line bg-panel text-xs text-ink shadow-2xl" role="region" aria-label={tr('exportDialog.export_queue')}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-medium">
          {job.status === 'done' ? tr('exportDialog.export_finished') : job.status === 'cancelled' ? tr('exportDialog.export_cancelled') : job.status === 'interrupted' ? tr('exportDialog.export_interrupted') : job.status === 'paused' ? tr('exportDialog.export_paused') : tr('exportDialog.exporting')}
        </span>
        <span className="text-ink-faint">{done.length}/{job.items.length}</span>
        <div className="flex-1" />
        <IconButton className="text-ink-faint hover:text-ink" label={tr('exportDialog.hide_the_export_panel_the_export')} onClick={() => useExportQueue.getState().set({ panelOpen: false })}>—</IconButton>
      </div>
      <div className="px-3 py-2">
        <div className="mb-1 h-1.5 overflow-hidden rounded bg-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div className="h-full bg-meter transition-[width]" style={{ width: `${fraction * 100}%` }} />
        </div>
        <div className="flex justify-between text-2xs text-ink-dim">
          <span className="truncate">{job.status === 'running' ? current?.label ?? tr('exportDialog.starting') : `${done.length} exported · ${fmtBytes(total)}${failed.length ? ` · ${failed.length} failed` : ''}`}</span>
          {job.status === 'running' && e !== null && <span className="ms-2 shrink-0">{tr('exportDialog.time_left', { time: fmtTime(e) })}</span>}
        </div>
        <div className="mt-1 text-2xs text-ink-faint">{job.destination === 'folder' ? `To folder “${job.folderName ?? ''}”` : tr('exportDialog.zip_download_when_finished')}{job.presetName ? ` · ${job.presetName}` : ''}</div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-1" aria-label={tr('exportDialog.photos')}>
        {job.items.map((i) => (
          <li key={i.photoId} className="flex items-center gap-2 py-0.5 text-2xs">
            <span className={`w-3 text-center ${i.state === 'done' ? 'text-success' : i.state === 'failed' ? 'text-danger' : 'text-ink-faint'}`} aria-hidden>
              {i.state === 'done' ? '✓' : i.state === 'failed' ? '!' : i.state === 'running' ? '…' : i.state === 'cancelled' ? '–' : '·'}
            </span>
            <span className="min-w-0 flex-1 truncate" title={i.error ?? i.outName ?? i.fileName}>{i.outName ?? i.fileName}</span>
            {i.bytes ? <span className="text-ink-faint">{fmtBytes(i.bytes)}</span> : null}
            {i.error && <span className="max-w-[140px] truncate text-danger" title={i.error}>{i.error}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-3 py-2">
        {job.status === 'running' && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={pauseExport}>{tr('exportDialog.pause')}</button>}
        {(job.status === 'paused' || job.status === 'interrupted') && left > 0 && <button className="rounded bg-accent px-2 py-1 font-medium text-on-accent hover:bg-accent-hi" onClick={() => void resumeExport()}>{tr('exportDialog.resume')}</button>}
        {(job.status === 'running' || job.status === 'paused' || job.status === 'interrupted') && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={cancelExport}>{tr('exportDialog.cancel')}</button>}
        {(job.status === 'done' || job.status === 'cancelled') && failed.length > 0 && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={retryFailed}>{tr('exportDialog.retry_failed')}</button>}
        {(job.status === 'done' || job.status === 'cancelled' || job.status === 'interrupted') && <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={dismissExport}>{tr('exportDialog.close')}</button>}
      </div>
    </div>
  );
}

export { baseSettings };
export { ExportProgress, useExportJob } from './ExportProgress';
