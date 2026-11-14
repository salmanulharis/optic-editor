/**
 * "Try a sample photo": a CC0 RAW served by the deployment itself (public/samples, filled by
 * `npm run sample:fetch`). Downloaded on first use (the service worker then keeps it for offline
 * use) and imported like any other file, so duplicate detection reuses it on the next try.
 */

export interface SampleInfo {
  file: string;
  name: string;
  credit: string;
  bytes: number;
}

let probe: Promise<SampleInfo | null> | null = null;

/** The sample's manifest, or null when this deployment has no sample. Checked once per session. */
export function sampleInfo(): Promise<SampleInfo | null> {
  probe ??= fetch('/samples/sample.json')
    .then(async (r) => {
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      const j = (await r.json()) as Partial<SampleInfo>;
      return typeof j.file === 'string' && typeof j.name === 'string' ? { file: j.file, name: j.name, credit: j.credit ?? '', bytes: j.bytes ?? 0 } : null;
    })
    .catch(() => null);
  return probe;
}

/** Download the sample (reporting 0…1 progress) and return it as a File ready to import. */
export async function downloadSample(info: SampleInfo, onProgress: (f: number) => void): Promise<File> {
  const res = await fetch(`/samples/${info.file}`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || info.bytes;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  // A fixed lastModified keeps the catalog key stable, so a second try reuses the imported photo.
  return new File(parts as BlobPart[], info.name, { type: 'image/x-adobe-dng', lastModified: Date.UTC(2019, 8, 8) });
}
