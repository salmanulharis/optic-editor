import { t as tr } from '../../i18n';
/**
 * Info panel for the focused photo: preview, rating / flag / label / keywords, file facts,
 * histogram (of the cached preview), what the edit changes, and the full EXIF of the original.
 */
import { useEffect, useState } from 'react';
import { addKeywords, removeKeyword, setFlag, setRating, toggleLabel } from '../../library/actions';
import { COLOR_LABELS, LABEL_CSS, type PhotoRecord } from '../../library/db';
import { photoFile } from '../../library/decode';
import { usePhotoImage } from '../../library/previews';
import { deserializeRecipe } from '../../recipe/serialize';
import { defaultRecipe } from '../../recipe/schema';
import { recipeSummary } from '../../state/describe';
import { formatGroup, useLibrary } from '../../state/libraryStore';
import { Stars } from './PhotoBadges';
import { IconButton } from '../controls/IconButton';
import { tp } from '../../i18n/format';
import { context2d, createCanvas } from '../../io/canvas';

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const fmtDate = (t: number) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function Histogram({ url }: { url: string | null }) {
  const [bins, setBins] = useState<number[][] | null>(null);
  useEffect(() => {
    if (!url) { setBins(null); return; }
    let live = true;
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 256 / Math.max(img.width, img.height));
      const c = createCanvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
      const ctx = context2d(c, { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const h = [new Array(64).fill(0), new Array(64).fill(0), new Array(64).fill(0)];
      for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < 3; ch++) h[ch][d[i + ch] >> 2]++;
      if (live) setBins(h);
    };
    img.src = url;
    return () => { live = false; };
  }, [url]);
  if (!bins) return null;
  const max = Math.max(...bins.flat().slice(1, -1), 1);
  const path = (b: number[]) => `M0,40 ${b.map((v, i) => `L${(i / 63) * 200},${40 - Math.min(40, (v / max) * 40)}`).join(' ')} L200,40 Z`;
  return (
    <svg viewBox="0 0 200 40" className="mb-2 h-12 w-full" role="img" aria-label={tr('infoPanel.histogram')}>
      <path d={path(bins[0])} fill="rgba(230,80,80,0.5)" />
      <path d={path(bins[1])} fill="rgba(80,200,80,0.5)" style={{ mixBlendMode: 'screen' }} />
      <path d={path(bins[2])} fill="rgba(80,120,240,0.5)" style={{ mixBlendMode: 'screen' }} />
    </svg>
  );
}

function FullExif({ p }: { p: PhotoRecord }) {
  const [rows, setRows] = useState<Array<[string, string]> | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null);
    void (async () => {
      try {
        // exifr is loaded only when the full EXIF list is opened.
        const [f, { default: exifr }] = await Promise.all([photoFile(p), import('exifr')]);
        const all = (await exifr.parse(f, { tiff: true, exif: true, gps: true, ifd1: false, iptc: true, xmp: false, icc: false, makerNote: false, mergeOutput: true })) as Record<string, unknown> | undefined;
        const out = Object.entries(all ?? {})
          .filter(([, v]) => v !== undefined && v !== null && !(v instanceof Uint8Array))
          .map(([k, v]): [string, string] => [k, v instanceof Date ? v.toLocaleString() : Array.isArray(v) ? v.join(', ') : String(v)]);
        if (live) setRows(out);
      } catch (e) {
        if (live) setRows([['Error', (e as Error).message]]);
      }
    })();
    return () => { live = false; };
  }, [p, open]);
  return (
    <details className="mt-2" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-2xs font-medium uppercase tracking-wider text-ink-faint">{tr('infoPanel.full_exif')}</summary>
      {open && !rows && <div className="py-1 text-2xs text-ink-faint">{tr('infoPanel.reading')}</div>}
      {rows && (
        <table className="mt-1 w-full text-2xs">
          <tbody>
            {rows.map(([k, v]) => <tr key={k}><td className="pe-2 align-top text-ink-faint">{k}</td><td className="break-all text-ink-dim">{v}</td></tr>)}
          </tbody>
        </table>
      )}
    </details>
  );
}

export function InfoPanel() {
  const active = useLibrary((s) => s.active);
  const p = useLibrary((s) => (s.active ? s.byId.get(s.active) : undefined));
  const n = useLibrary((s) => s.selection.size);
  const url = usePhotoImage(p, 'thumb');
  const [kw, setKw] = useState('');
  if (!p) return <aside className="w-72 shrink-0 border-s border-line bg-panel p-3 text-xs text-ink-faint">{tr('infoPanel.select_a_photo_to_see_its')}</aside>;
  let summary: string[] = [];
  try { summary = p.recipe ? recipeSummary(deserializeRecipe(p.recipe), defaultRecipe()) : []; } catch { summary = []; }
  const facts: Array<[string, string]> = [
    ['File', p.fileName],
    ['Type', `${formatGroup(p)}${p.storage === 'handle' ? ' · referenced' : ' · stored in Optic'}`],
    ['Size', `${p.width && p.height ? `${p.width} × ${p.height} · ` : ''}${fmtBytes(p.size)}`],
    ['Captured', fmtDate(p.captureDate)],
    ['Imported', fmtDate(p.importDate)],
    ['Edited', fmtDate(p.editDate)],
    ['Camera', p.camera || '—'],
    ['Lens', p.lens || '—'],
    ['Exposure', [p.shutter ? (p.shutter >= 0.5 ? `${p.shutter} s` : `1/${Math.round(1 / p.shutter)} s`) : '', p.aperture ? `ƒ/${p.aperture}` : '', p.iso ? `ISO ${p.iso}` : '', p.focal ? `${p.focal} mm` : ''].filter(Boolean).join(' · ') || '—'],
  ];
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-s border-line bg-panel p-3 text-xs" aria-label={tr('infoPanel.photo_information')}>
      {n > 1 && <div className="mb-2 rounded bg-hover px-2 py-1 text-2xs text-ink-dim">{tr('infoPanel.n_photos_selected_rating_flag_label', { n: n })}</div>}
      {url && <img src={url} alt="" className="mb-2 max-h-48 w-full object-contain" />}
      <Histogram url={url} />
      <div className="mb-2 flex items-center justify-between">
        <Stars n={p.rating} onSet={(r) => void setRating(r)} size="text-base" />
        <div className="flex gap-1">
          <IconButton className={`px-1.5 ${p.flag === 1 ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`} label={tr('infoPanel.pick')} shortcut="P" aria-pressed={p.flag === 1} onClick={() => void setFlag(p.flag === 1 ? 0 : 1)}>⚑</IconButton>
          <IconButton className={`px-1.5 ${p.flag === -1 ? 'bg-active text-danger' : 'text-ink-dim hover:text-ink'}`} label={tr('infoPanel.reject')} shortcut="X" aria-pressed={p.flag === -1} onClick={() => void setFlag(p.flag === -1 ? 0 : -1)}>✕</IconButton>
        </div>
      </div>
      <div className="mb-2 flex gap-2" role="group" aria-label={tr('infoPanel.color_label')}>
        {COLOR_LABELS.map((l, i) => (
          <button key={l} type="button" aria-pressed={p.label === l} title={`${l}${i < 4 ? ` (${i + 6})` : ''}`}
            aria-label={tr('infoPanel.l_label', { l: l })}
            className={`h-5 w-5 rounded-full border-2 ${p.label === l ? 'border-strong' : 'border-transparent opacity-70 hover:opacity-100'}`}
            style={{ background: LABEL_CSS[l] }} onClick={() => void toggleLabel(l)} />
        ))}
      </div>
      <div className="mb-3">
        <div className="mb-1 flex flex-wrap gap-1">
          {p.keywords.map((k) => (
            <span key={k} className="flex items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-2xs text-ink">
              {k}<IconButton className="text-ink-faint hover:text-ink" label={tr('infoPanel.remove_keyword_k', { k: k })} onClick={() => void removeKeyword(k)}>✕</IconButton>
            </span>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (kw.trim()) { void addKeywords(kw.split(',')); setKw(''); } }}>
          <input className="input w-full" placeholder={tr('infoPanel.add_keywords_comma_separated')} value={kw} onChange={(e) => setKw(e.target.value)} aria-label={tr('infoPanel.add_keywords')}
            onKeyDown={(e) => e.stopPropagation()} />
        </form>
      </div>
      <table className="mb-2 w-full text-2xs"><tbody>
        {facts.map(([k, v]) => <tr key={k}><td className="w-20 pe-2 align-top text-ink-faint">{k}</td><td className="break-words text-ink-dim">{v}</td></tr>)}
      </tbody></table>
      {p.error && <div className="mb-2 rounded border border-danger/40 bg-danger-bg px-2 py-1 text-2xs text-ink">{p.error}</div>}
      <div className="text-2xs font-medium uppercase tracking-wider text-ink-faint">{tr('infoPanel.edits')}</div>
      {summary.length ? (
        <ul className="mb-1 list-inside list-disc text-2xs text-ink-dim">{summary.slice(0, 40).map((s) => <li key={s}>{s}</li>)}</ul>
      ) : <div className="mb-1 text-2xs text-ink-faint">{p.recipe ? tr('infoPanel.default_settings') : tr('infoPanel.not_edited')}</div>}
      {p.copies > 0 && <div className="text-2xs text-ink-faint">{tp('photoBadges.virtual_copies', p.copies)}</div>}
      <FullExif key={active} p={p} />
    </aside>
  );
}
