#!/usr/bin/env node
/**
 * Downloads the "Try a sample photo" RAW into public/samples so a deployment serves it itself.
 * Optional: without it the sample button is simply not shown. The browser cannot fetch the file
 * from raw.pixls.us directly (no CORS headers, and Optic is cross-origin isolated), hence the copy.
 *
 * Source: raw.pixls.us, Apple iPhone XS, IMG_1105.dng. Licence: CC0 1.0 (public domain
 * dedication), as stated on raw.pixls.us. See LICENSES.md.
 *   npm run sample:fetch
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SAMPLE = {
  file: 'iphone-xs-sample.dng',
  url: 'https://raw.pixls.us/download/data/Apple/iPhone%20XS/IMG_1105.dng',
  name: 'Sample (iPhone XS RAW).dng',
  credit: 'raw.pixls.us · CC0 1.0',
};

const dir = 'public/samples';
const dest = `${dir}/${SAMPLE.file}`;
mkdirSync(dir, { recursive: true });

if (existsSync(dest) && statSync(dest).size > 1_000_000) {
  console.log(`✓ ${SAMPLE.file} (already there)`);
} else {
  process.stdout.write(`↓ ${SAMPLE.file}… `);
  const res = await fetch(SAMPLE.url, { headers: { 'user-agent': 'optic-sample-fetch' } });
  if (!res.ok || !res.body) { console.error(`failed: HTTP ${res.status}`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const size = statSync(dest).size;
  // A DNG starts with a TIFF header ("II*\0" or "MM\0*"); anything else is an error page.
  const head = readFileSync(dest).subarray(0, 4).toString('latin1');
  if (size < 1_000_000 || !(head === 'II*\0' || head === 'MM\0*')) { console.error('failed: not a DNG'); process.exit(1); }
  console.log(`done (${(size / 1e6).toFixed(1)} MB)`);
}

// The app reads this manifest to decide whether to offer the sample (and what to call it).
writeFileSync(`${dir}/sample.json`, JSON.stringify({ file: SAMPLE.file, name: SAMPLE.name, credit: SAMPLE.credit, bytes: statSync(dest).size }, null, 2));
