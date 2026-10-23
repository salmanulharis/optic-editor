import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests in a real Chromium (Chrome or Edge: set CHROME_CHANNEL, default chrome) with the
 * GPU enabled, against the Vite dev server (which sends the COOP/COEP headers and exposes
 * window.__optic). Run: npm run test:e2e
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180/',
    browserName: 'chromium',
    channel: process.env.CHROME_CHANNEL ?? 'chrome',
    launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])] },
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  },
  webServer: {
    command: 'npx vite --port 5180 --strictPort',
    url: 'http://localhost:5180/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
