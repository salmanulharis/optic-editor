import { type Page, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SAMPLE = join(process.cwd(), 'sample-files', 'IMG_7040.jpeg');

/** Skip the first-launch tour; fresh storage per test (Playwright gives each test a new context). */
export async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem('optic.settings', JSON.stringify({ onboardingDone: true })));
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __optic?: unknown }).__optic);
}

/** Synthetic JPEGs (sky, grey card, colour patches) written to a temp folder. */
export async function fixtures(page: Page, n = 3): Promise<string[]> {
  const dir = join(tmpdir(), `optic-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const b64 = await page.evaluate(async (i) => {
      const c = new OffscreenCanvas(1200 + i * 100, 900);
      const x = c.getContext('2d')!;
      const g = x.createLinearGradient(0, 0, 0, 500);
      g.addColorStop(0, '#5a8fd8'); g.addColorStop(1, '#bcd6f0');
      x.fillStyle = g; x.fillRect(0, 0, c.width, 500);
      x.fillStyle = '#6b7a3a'; x.fillRect(0, 500, c.width, 400);
      x.fillStyle = '#808080'; x.fillRect(100, 560, 200, 200);
      ['#c0392b', '#f1c40f', '#27ae60', '#2980b9'].forEach((col, k) => { x.fillStyle = col; x.fillRect(400 + k * 160, 580, 140, 140); });
      x.fillStyle = `hsl(${i * 90}, 60%, 60%)`; x.beginPath(); x.arc(900, 250, 90, 0, 7); x.fill();
      const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
      let s = ''; for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]);
      return btoa(s);
    }, i);
    const f = join(dir, `scene_${i}.jpg`);
    writeFileSync(f, Buffer.from(b64, 'base64'));
    out.push(f);
  }
  return out;
}

/** Import files through the dialog and wait until Optic has rendered every preview. */
export async function importFiles(page: Page, files: string[]) {
  await page.locator('input[type=file][multiple]').first().setInputFiles(files);
  await expect(page.getByRole('dialog')).toBeVisible();
  const btn = page.getByRole('button', { name: /^Import \d+ photo/ });
  await expect(btn).toBeEnabled();
  await btn.click();
  await page.waitForFunction((n) => {
    const lib = (window as never as { __optic: { library: { useLibrary: { getState(): { photos: Array<{ previewEmbedded: boolean }> } } } } }).__optic.library.useLibrary.getState();
    return lib.photos.length >= n && lib.photos.every((p) => !p.previewEmbedded);
  }, files.length, { timeout: 180_000, polling: 500 });
  // Background previews done: nothing else competes for the GPU.
}

export async function openFirst(page: Page) {
  await page.getByRole('listbox', { name: 'Photos' }).getByRole('option').first().dblclick();
  // The photo is decoded and its proxy is on the GPU.
  await page.waitForFunction(() => {
    const o = (window as never as { __optic: { image: { useImage: { getState(): { image: unknown } } }; core: { getRenderer(): { ready: boolean } | null } } }).__optic;
    return !!o.image.useImage.getState().image && !!o.core.getRenderer()?.ready;
  }, null, { timeout: 120_000 });
}
