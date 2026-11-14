/**
 * Preset import feedback shared by the desktop preset browser and the touch layout: the import
 * runner (progress, summary), the live status line and the per-file import report (what each
 * Lightroom preset became and what could not be converted).
 */
import { useState } from 'react';
import { useT } from '../../i18n';
import { type ImportSummary, type LightroomReportRow, importFiles, notConvertedText } from '../../state/presetStore';
import { Modal } from './Dialogs';

/** Everything the preset Import button accepts. */
export const PRESET_IMPORT_ACCEPT = '.json,.opticpack,.zip,.cube,.png,.xmp,.lrtemplate,.dng';

const needsDetails = (r: ImportSummary) =>
  r.errors.length > 0 || r.report.some((row) => row.status !== 'converted' || row.updated || row.notSaved);

export function summaryText(r: ImportSummary, t: ReturnType<typeof useT>): string {
  if (!r.report.length) {
    // No Lightroom files: the summary Optic has always shown.
    return `${t('presets.import.summary', { presets: r.presets, luts: r.luts })}${r.errors.length ? ` · ${r.errors.join('; ')}` : ''}`;
  }
  const parts = [t('presets.import.summaryLr', { n: r.lightroom })];
  const other = r.presets - r.lightroom;
  if (other > 0 || r.luts > 0) parts.push(t('presets.import.summary', { presets: other, luts: r.luts }));
  const failed = r.report.filter((row) => row.status === 'failed').length + r.errors.length;
  if (failed) parts.push(t('presets.import.failed', { n: failed }));
  if (r.report.some((row) => row.status === 'partial')) parts.push(t('presets.import.partial'));
  if (r.report.some((row) => row.notSaved)) parts.push(t('presets.import.notSaved'));
  return parts.join(' ');
}

/**
 * Runs an import with progress. `onDone` receives the group of the first converted Lightroom
 * preset, so the caller can reveal the new presets.
 */
export function usePresetImport(onDone?: (group: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    setSummary(null);
    setProgress({ done: 0, total: files.length });
    try {
      const r = await importFiles(files, { onProgress: (done, total) => setProgress({ done, total }) });
      setSummary(r);
      onDone?.(r.report.find((row) => row.group)?.group ?? null);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  return {
    busy,
    progress,
    summary,
    reportOpen,
    run,
    openReport: () => setReportOpen(true),
    closeReport: () => setReportOpen(false),
    dismiss: () => { setSummary(null); setReportOpen(false); },
  };
}

export type PresetImport = ReturnType<typeof usePresetImport>;

/** The status line under the import button: progress, then the summary (announced politely). */
export function ImportStatus({ imp, className = '' }: { imp: PresetImport; className?: string }) {
  const t = useT();
  const text = imp.progress
    ? t('presets.import.progress', { done: Math.min(imp.progress.done + 1, imp.progress.total), total: imp.progress.total })
    : imp.summary
      ? summaryText(imp.summary, t)
      : '';
  return (
    <div role="status" aria-live="polite" className={text ? className : 'sr-only'}>
      {text && (
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words">{text}</span>
          {imp.summary && needsDetails(imp.summary) && (
            <button className="shrink-0 underline hover:text-ink" onClick={imp.openReport}>{t('presets.import.details')}</button>
          )}
          {imp.summary && (
            <button className="shrink-0 hover:text-ink" onClick={imp.dismiss} aria-label={t('presets.import.dismiss')} title={t('presets.import.dismiss')}>✕</button>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_ICON: Record<LightroomReportRow['status'], string> = { converted: '✓', partial: '◐', failed: '✕', duplicate: '–' };

/** Per-file report. Focus goes to Close on open and back to the Details button on close (Modal). */
export function ImportReportDialog({ imp }: { imp: PresetImport }) {
  const t = useT();
  const r = imp.summary;
  if (!imp.reportOpen || !r) return null;
  return (
    <Modal title={t('lr.report.title')} onClose={imp.closeReport}>
      <p className="mb-2 text-[11px] text-ink-dim">{t('lr.report.help')}</p>
      <ul className="max-h-[55vh] space-y-1.5 overflow-y-auto text-xs" aria-label={t('lr.report.title')}>
        {r.report.map((row, i) => (
          <li key={`${row.file}-${i}`} className="rounded border border-line px-2 py-1.5">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-strong" title={row.file}>{row.name ?? row.file}</span>
              <span className="shrink-0 text-ink-dim">
                <span aria-hidden>{STATUS_ICON[row.status]} </span>
                {t(`lr.report.${row.status}`)}
              </span>
            </div>
            {row.name && <div className="truncate text-[11px] text-ink-faint">{row.file}</div>}
            {row.updated && <div className="text-[11px] text-ink-dim">{t('lr.report.updated')}</div>}
            {row.notSaved && <div className="text-[11px] text-ink">{t('lr.report.notSaved')}</div>}
            {row.error && <div className="text-[11px] text-ink-dim">{t(`lr.error.${row.error}`)}</div>}
            {row.legacy && <div className="text-[11px] text-ink-dim">{t('lr.error.legacy')}</div>}
            {!!row.notConverted?.length && (
              <div className="text-[11px] text-ink-dim">{t('lr.report.notConverted', { list: notConvertedText(row.notConverted) })}</div>
            )}
          </li>
        ))}
        {r.errors.length > 0 && (
          <li className="rounded border border-line px-2 py-1.5">
            <div className="mb-0.5 text-strong">{t('lr.report.other')}</div>
            {r.errors.map((e, i) => <div key={i} className="break-words text-[11px] text-ink-dim">{e}</div>)}
          </li>
        )}
      </ul>
      <div className="mt-3 flex justify-end">
        <button autoFocus className="rounded bg-hover px-3 py-1 text-xs text-ink hover:bg-active" onClick={imp.closeReport}>
          {t('lr.report.close')}
        </button>
      </div>
    </Modal>
  );
}
