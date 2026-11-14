/**
 * Export progress for the top bar (single-photo export, or the batch queue as a pill that reopens
 * its panel). Kept apart from ExportDialog.tsx so the dialogs can load only when opened.
 */
import { create } from 'zustand';
import { useExportQueue } from '../../library/exportQueue';

export interface ExportJobState {
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
