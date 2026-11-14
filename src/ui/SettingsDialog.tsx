import { t as tr } from '../i18n';
/**
 * Settings: appearance, defaults for new photos, default export preset, preview quality, graphics
 * information, storage (usage, persistence, cache clean-up that never touches originals) and the
 * on-device AI models with their licences.
 */
import { useEffect, useRef, useState } from 'react';
import { MODEL_CACHE, MODELS, cachedModels, type ModelId } from '../ai/models';
import { getRenderer } from '../app/actions';
import { requestPersistence, usePwa } from '../app/pwa';
import { LANGUAGES, useT } from '../i18n';
import { BUILTIN_EXPORT_PRESETS } from '../io/encode/exportSettings';
import { catalog } from '../library/db';
import { dirSize, removeEntry } from '../library/opfs';
import { enqueuePreviews } from '../library/previews';
import { maskRegistry } from '../pipeline/maskRegistry';
import { type DetailDefaults, type PreviewQuality, type Theme, useSettings } from '../state/settingsStore';
import { useLibrary } from '../state/libraryStore';
import { useUi } from '../state/uiStore';
import { dbGetAll, dbDelete } from '../storage/db';
import { useFocusTrap } from './focusTrap';
import { confirmDialog } from './feedback/dialogs';
import { IconButton } from './controls/IconButton';

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 border-b border-line pb-1 text-2xs font-medium uppercase tracking-wider text-ink-faint">{title}</h3>
      <div className="space-y-2 text-xs text-ink-dim">{children}</div>
    </section>
  );
}

function Row({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor={htmlFor} className="min-w-[160px]">{label}</label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function DefaultsEditor({ which }: { which: 'raw' | 'nonRaw' }) {
  const d = useSettings((s) => s[which]);
  const t = useT();
  const set = (p: Partial<DetailDefaults>) => useSettings.getState().set({ [which]: { ...useSettings.getState()[which], ...p } } as never);
  const num = (k: 'sharpen' | 'colorNr' | 'lumNr', max: number, label: string) => (
    <Row label={label} htmlFor={`${which}-${k}`}>
      <input id={`${which}-${k}`} type="range" min={0} max={max} value={d[k]} className="w-32 accent-edge" onChange={(e) => set({ [k]: +e.target.value })} />
      <span className="w-8 text-end tabular-nums text-ink">{d[k]}</span>
    </Row>
  );
  return (
    <div className="rounded border border-line p-2">
      <div className="mb-1 font-medium text-ink">{which === 'raw' ? t('settings.raw') : t('settings.nonRaw')}</div>
      {num('sharpen', 150, t('settings.sharpen'))}
      {num('colorNr', 100, t('settings.colorNr'))}
      {num('lumNr', 100, t('settings.lumNr'))}
      <label className="mt-2 flex min-h-[24px] items-center gap-2"><input type="checkbox" checked={d.lensAuto} onChange={(e) => set({ lensAuto: e.target.checked })} /> {t('settings.lensAuto')}</label>
    </div>
  );
}

function GpuInfo() {
  const [info, setInfo] = useState<Array<[string, string]>>([]);
  useEffect(() => {
    const r = getRenderer();
    const gl = r?.gl;
    const rows: Array<[string, string]> = [];
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      rows.push([tr('settingsDialog.renderer'), dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))]);
      rows.push([tr('settingsDialog.api'), 'WebGL 2 (float pipeline)']);
      rows.push([tr('settingsDialog.max_texture'), `${r.caps.maxTextureSize} px`]);
      rows.push([tr('settingsDialog.float_filtering'), r.caps.floatLinear ? tr('settingsDialog.yes') : tr('settingsDialog.no_texelfetch_fallback')]);
      rows.push([tr('settingsDialog.wide_gamut_display'), r.caps.p3 ? 'Display P3' : 'sRGB']);
    } else rows.push([tr('settingsDialog.renderer'), tr('settingsDialog.open_a_photo_to_see_gpu')]);
    rows.push([tr('settingsDialog.webgpu'), 'gpu' in navigator ? tr('settingsDialog.available') : tr('settingsDialog.not_available')]);
    rows.push([tr('settingsDialog.cross_origin_isolated'), crossOriginIsolated ? tr('settingsDialog.yes_threads_shared_memory') : tr('settingsDialog.no')]);
    rows.push([tr('settingsDialog.cpu_threads'), String(navigator.hardwareConcurrency || '?')]);
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (mem) rows.push([tr('settingsDialog.device_memory'), `≥ ${mem} GB`]);
    setInfo(rows);
  }, []);
  return (
    <table className="w-full"><tbody>
      {info.map(([k, v]) => <tr key={k}><td className="w-40 py-0.5 pe-2 text-ink-faint">{k}</td><td className="break-all text-ink">{v}</td></tr>)}
    </tbody></table>
  );
}

function StoragePanel() {
  const t = useT();
  const persisted = usePwa((s) => s.persisted);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [sizes, setSizes] = useState<{ originals: number; previews: number; models: number } | null>(null);
  const [models, setModels] = useState<ModelId[]>([]);
  const refresh = async () => {
    const e = await navigator.storage?.estimate?.();
    if (e) setEst({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
    let modelBytes = 0;
    try {
      const c = await caches.open(MODEL_CACHE);
      for (const r of await c.keys()) modelBytes += (await (await c.match(r))?.blob())?.size ?? 0;
    } catch { /* no cache storage */ }
    setSizes({ originals: await dirSize('originals'), previews: await dirSize('previews'), models: modelBytes });
    setModels(await cachedModels());
  };
  useEffect(() => { void refresh(); void requestPersistence(); }, []);
  const clearPreviews = async () => {
    if (!(await confirmDialog({ title: tr('settingsDialog.clear_the_preview_cache'), message: tr('settingsDialog.previews_are_rendered_again_in_the'), confirmLabel: tr('settingsDialog.clear_previews') }))) return;
    await removeEntry('previews');
    const lib = useLibrary.getState();
    await lib.patch(lib.photos.map((p) => p.id), () => ({ thumb: 0, preview: 0 }));
    enqueuePreviews(lib.photos.map((p) => p.id));
    void refresh();
  };
  const clearModels = async () => {
    if (!(await confirmDialog({ title: tr('settingsDialog.remove_the_downloaded_ai_models'), message: tr('settingsDialog.they_download_again_the_next_time'), confirmLabel: tr('settingsDialog.remove_models') }))) return;
    await caches.delete(MODEL_CACHE);
    await caches.delete('optic-model-files');
    void refresh();
  };
  const clearMasks = async () => {
    if (!(await confirmDialog({ title: tr('settingsDialog.clear_computed_ai_masks'), message: tr('settingsDialog.they_are_computed_again_when_a'), confirmLabel: tr('settingsDialog.clear_masks') }))) return;
    for (const m of await dbGetAll<{ key: string }>('aimasks')) await dbDelete('aimasks', m.key);
    for (const m of maskRegistry.all()) maskRegistry.delete(m.key);
    void refresh();
  };
  return (
    <>
      {est && (
        <div>
          <div>{t('settings.storage.used', { used: fmt(est.usage), quota: fmt(est.quota) })}</div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-hover"><div className="h-full bg-meter" style={{ width: `${Math.min(100, (est.usage / Math.max(1, est.quota)) * 100)}%` }} /></div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span>{persisted ? t('settings.storage.persisted') : t('settings.storage.notPersisted')}</span>
        {!persisted && <button className="rounded border border-line px-2 py-0.5 hover:bg-hover" onClick={() => void requestPersistence()}>{t('settings.storage.ask')}</button>}
      </div>
      {sizes && (
        <table className="w-full"><tbody>
          <tr><td className="py-0.5 text-ink-faint">{t('settings.storage.originals')}</td><td className="text-end text-ink">{fmt(sizes.originals)}</td></tr>
          <tr><td className="py-0.5 text-ink-faint">{t('settings.storage.previews')}</td><td className="text-end text-ink">{fmt(sizes.previews)}</td></tr>
          <tr><td className="py-0.5 text-ink-faint">{t('settings.storage.models')}</td><td className="text-end text-ink">{fmt(sizes.models)}</td></tr>
        </tbody></table>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={() => void clearPreviews()}>{t('settings.storage.clearPreviews')}</button>
        <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={() => void clearMasks()}>{t('settings.storage.clearMasks')}</button>
        <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={() => void clearModels()}>{t('settings.storage.clearModels')}</button>
      </div>
      <p className="text-ink-faint">{t('settings.storage.note')}</p>
      <div className="mt-2">
        <div className="mb-1 font-medium text-ink">{t('settings.ai')}</div>
        <table className="w-full"><tbody>
          {Object.values(MODELS).map((m) => (
            <tr key={m.id}>
              <td className="py-0.5 pe-2">{m.name}</td>
              <td className="pe-2 text-ink-faint">{m.license}</td>
              <td className="pe-2 text-end tabular-nums text-ink-faint">{fmt(m.bytes)}</td>
              <td className="text-end">{models.includes(m.id) ? tr('settingsDialog.offline') : '—'}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </>
  );
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const s = useSettings();
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [userPresets, setUserPresets] = useState<Array<{ id: string; name: string }>>([]);
  useFocusTrap(ref, open);
  useEffect(() => { if (open) void catalog.exportPresets.toArray().then((l) => setUserPresets(l.map((p) => ({ id: p.id, name: p.name })))); }, [open]);
  if (!open) return null;
  const close = () => useUi.getState().set({ settingsOpen: false });
  const set = useSettings.getState().set;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="flex max-h-[94dvh] w-full max-w-2xl flex-col rounded-lg border border-line bg-panel text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <div className="flex items-center border-b border-line px-4 py-3">
          <h2 id="settings-title" className="text-sm font-medium">{t('settings.title')}</h2>
          <div className="flex-1" />
          <IconButton className="text-ink-dim hover:text-ink" onClick={close} label={tr('settingsDialog.close')} shortcut="Esc">✕</IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <Section title={t('settings.general')}>
            <Row label={t('settings.theme')} htmlFor="set-theme">
              <select id="set-theme" className="input" value={s.theme} onChange={(e) => set({ theme: e.target.value as Theme })}>
                <option value="dark">{t('settings.theme.dark')}</option>
                <option value="darker">{t('settings.theme.darker')}</option>
                <option value="light">{t('settings.theme.light')}</option>
                <option value="system">{t('settings.theme.system')}</option>
              </select>
            </Row>
            <Row label={t('settings.language')} htmlFor="set-lang">
              <select id="set-lang" className="input" value={s.language} aria-describedby="set-lang-hint" onChange={(e) => { set({ language: e.target.value }); window.location.reload(); }}>
                {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <span id="set-lang-hint" className="ms-2 text-2xs text-ink-faint">{t('settings.language.reload')}</span>
            </Row>
            <Row label={t('settings.motion')} htmlFor="set-motion">
              <select id="set-motion" className="input" value={s.reducedMotion} onChange={(e) => set({ reducedMotion: e.target.value as 'system' | 'on' | 'off' })}>
                <option value="system">{t('settings.motion.system')}</option>
                <option value="on">{t('settings.motion.on')}</option>
                <option value="off">{t('settings.motion.off')}</option>
              </select>
            </Row>
            <label className="flex items-center gap-2"><input type="checkbox" checked={s.showFps} onChange={(e) => set({ showFps: e.target.checked })} /> {t('settings.fps')}</label>
          </Section>
          <Section title={t('settings.defaults')}>
            <p className="text-ink-faint">{t('settings.defaults.hint')}</p>
            <div className="grid gap-2 sm:grid-cols-2"><DefaultsEditor which="raw" /><DefaultsEditor which="nonRaw" /></div>
          </Section>
          <Section title={t('settings.export')}>
            <Row label={t('settings.exportPreset')} htmlFor="set-export">
              <select id="set-export" className="input max-w-[260px]" value={s.defaultExportPreset} onChange={(e) => set({ defaultExportPreset: e.target.value })}>
                <option value="">{t('settings.exportPreset.last')}</option>
                {BUILTIN_EXPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                {userPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Row>
          </Section>
          <Section title={t('settings.performance')}>
            <Row label={t('settings.quality')} htmlFor="set-quality">
              <select id="set-quality" className="input" value={s.previewQuality} onChange={(e) => set({ previewQuality: e.target.value as PreviewQuality })}>
                <option value="performance">{t('settings.quality.performance')}</option>
                <option value="balanced">{t('settings.quality.balanced')}</option>
                <option value="quality">{t('settings.quality.quality')}</option>
              </select>
            </Row>
          </Section>
          {/* Diagnostics for bug reports: collapsed so they don't compete with real settings. */}
          <details className="group mb-5">
            <summary className="mb-2 flex cursor-pointer list-none items-center gap-1.5 border-b border-line pb-1 text-2xs font-medium uppercase tracking-wider text-ink-faint hover:text-ink">
              <span aria-hidden className="transition-transform group-open:rotate-90">▸</span>{t('settings.gpu')}
            </summary>
            <div className="text-xs text-ink-dim"><GpuInfo /></div>
          </details>
          <Section title={t('settings.storage')}><StoragePanel /></Section>
          <Section title={t('settings.about')}>
            <p>{tr('settingsDialog.optic_everything_runs_on_this_device')}</p>
            <div className="flex flex-wrap gap-2">
              <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={() => { close(); set({ onboardingDone: false }); }}>{t('settings.tour')}</button>
              <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={() => useUi.getState().set({ settingsOpen: false, shortcutsOpen: true })}>{tr('settingsDialog.keyboard_shortcuts')}</button>
              <button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={async () => { if (await confirmDialog({ title: tr('settingsDialog.reset_all_settings_to_their_defaults'), message: tr('settingsDialog.your_photos_edits_and_presets_are'), confirmLabel: tr('settingsDialog.reset_settings'), danger: true })) useSettings.getState().reset(); }}>{t('settings.reset')}</button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
