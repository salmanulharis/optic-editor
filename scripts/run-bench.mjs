#!/usr/bin/env node
/**
 * Runs bench.html in headless Chromium (GPU enabled) against a Vite dev server started here.
 *
 *   npm run test:seams   tiled (512 px) vs untiled export of a 4096 px synthetic image with every
 *                        spatial effect at full strength; exits 1 unless the max difference < 1/1024
 *   npm run bench        48 MP synthetic: preview frame rate while dragging (default recipe, all
 *                        Phase 3 effects, draft mode) and full-resolution export time
 *
 * Browser: playwright-core with CHROME_PATH, or an installed Chrome / Edge (CHROME_CHANNEL,
 * default: chrome, then msedge).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const mode = process.argv[2] === 'bench' ? 'bench' : 'seams';

async function launch() {
  const args = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])];
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH, args });
  const channels = process.env.CHROME_CHANNEL ? [process.env.CHROME_CHANNEL] : ['chrome', 'msedge'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, args });
    } catch { /* try the next one */ }
  }
  throw new Error('No Chrome or Edge found: set CHROME_PATH to a Chromium-based browser executable.');
}

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`;
const browser = await launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => m.text().startsWith('[bench]') && console.log(m.text().slice(8)));
  console.log(`Browser: ${browser.version()}`);
  await page.goto(`${base}bench.html`);
  await page.waitForFunction(() => !!window.__bench);
  if (mode === 'seams') {
    const r = await page.evaluate(() => window.__bench.seamTest(4096, 512));
    failed = !r.pass;
    console.log(r.pass ? 'PASS' : 'FAIL', JSON.stringify(r));
  } else {
    const r = await page.evaluate(() => window.__bench.bench());
    console.log(JSON.stringify(r, null, 2));
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
