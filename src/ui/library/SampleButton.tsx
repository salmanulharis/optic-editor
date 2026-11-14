/**
 * "Try a sample photo" for empty libraries and the end of the tour: downloads the bundled CC0 RAW
 * and opens it in the editor. Hidden when the deployment has no sample. The download state is
 * shared, so whichever button started it, every visible one shows the progress.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { openFile } from '../../app/openFile';
import { type SampleInfo, downloadSample, sampleInfo } from '../../library/sample';
import { useToasts } from '../feedback/toasts';
import { t as tr } from '../../i18n';

const useSampleDownload = create<{ progress: number | null }>(() => ({ progress: null }));

async function startSample(info: SampleInfo) {
  if (useSampleDownload.getState().progress !== null) return;
  useSampleDownload.setState({ progress: 0 });
  try {
    const file = await downloadSample(info, (progress) => useSampleDownload.setState({ progress }));
    openFile(file);
  } catch (e) {
    useToasts.getState().push({
      kind: 'error',
      message: tr('sampleButton.download_failed', { reason: (e as Error).message || tr('sampleButton.no_connection') }),
      action: { label: tr('sampleButton.retry'), run: () => void startSample(info) },
    });
  } finally {
    useSampleDownload.setState({ progress: null });
  }
}

export function SampleButton({ className = '', onStart }: { className?: string; onStart?(): void }) {
  const [info, setInfo] = useState<SampleInfo | null>(null);
  const progress = useSampleDownload((s) => s.progress);
  useEffect(() => { let live = true; void sampleInfo().then((i) => { if (live) setInfo(i); }); return () => { live = false; }; }, []);
  if (!info) return null;
  const busy = progress !== null;
  return (
    <span className={`inline-flex flex-col items-center gap-0.5 ${className}`}>
      <button type="button" className="hit rounded px-2 text-sm text-ink underline-offset-4 hover:underline disabled:opacity-60" disabled={busy}
        onClick={() => { onStart?.(); void startSample(info); }} aria-describedby="sample-credit">
        {busy ? tr('sampleButton.downloading', { pct: Math.round(progress * 100) }) : tr('sampleButton.try_a_sample_photo')}
      </button>
      <span id="sample-credit" className="text-2xs text-ink-faint">{tr('sampleButton.credit', { mb: Math.round(info.bytes / 1e6), credit: info.credit })}
      </span>
    </span>
  );
}
