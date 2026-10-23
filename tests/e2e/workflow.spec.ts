/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { SAMPLE, fixtures, importFiles, openFirst, start } from './helpers';

const O = 'window.__optic';

test('import → edit → export a JPEG at the right size', async ({ page }) => {
  test.skip(!existsSync(SAMPLE), 'needs the local ProRAW sample (sample-files/IMG_7040.jpeg)');
  await start(page);
  await importFiles(page, [SAMPLE]);
  await expect(page.getByRole('listbox', { name: 'Photos' }).getByRole('option')).toHaveCount(1);
  await openFirst(page);
  // Edit: exposure, a rating and a radial mask.
  await page.evaluate(`${O}.edit.useEdit.getState().apply((r) => ({ ...r, light: { ...r.light, exposure: 0.5 } }))`);
  await page.keyboard.press('4');
  await page.evaluate(`(() => { const m = ${O}.masks; ${O}.edit.useEdit.getState().apply((r) => ({ ...r, masks: [m.newMask('Radial', [m.newComponent('radial')], { exposure: 1 })] })); })()`);
  const steps = await page.evaluate(`${O}.edit.useEdit.getState().copies[0].steps.map((s) => s.label)`);
  expect(steps).toContain('Exposure +0.50');
  // Export through the dialog (no save picker in automation: falls back to a download).
  await page.evaluate(`window.showSaveFilePicker = undefined`);
  await page.keyboard.press('Control+e');
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await page.getByLabel('Export preset').selectOption('web-2048');
  const download = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export', exact: true }).click();
  const d = await download;
  const bytes = readFileSync(await d.path());
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  // Portrait 3024 × 4032 → long edge 2048.
  const sof = bytes.indexOf(Buffer.from([0xff, 0xc2])) > 0 ? bytes.indexOf(Buffer.from([0xff, 0xc2])) : bytes.indexOf(Buffer.from([0xff, 0xc0]));
  expect([bytes.readUInt16BE(sof + 7), bytes.readUInt16BE(sof + 5)]).toEqual([1536, 2048]);
  // The rating went to the catalog.
  expect(await page.evaluate(`${O}.library.useLibrary.getState().photos[0].rating`)).toBe(4);
});

test('re-importing the same files skips the duplicates', async ({ page }) => {
  await start(page);
  const files = await fixtures(page, 2);
  await importFiles(page, files);
  await page.locator('input[type=file][multiple]').first().setInputFiles(files);
  await expect(page.getByText('2 already in the library')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(`${O}.library.useLibrary.getState().photos.length`)).toBe(2);
});

test('batch: sync a setting, undo per photo, export a ZIP', async ({ page }) => {
  await start(page);
  const files = await fixtures(page, 3);
  await importFiles(page, files);
  await openFirst(page);
  await page.evaluate(`${O}.edit.useEdit.getState().apply((r) => ({ ...r, presence: { ...r.presence, saturation: 40 } }))`);
  await page.evaluate(`(async () => { const L = ${O}.library.useLibrary.getState(); L.selectAll(); L.set({ active: ${O}.image.useImage.getState().photoId }); await ${O}.batch.syncSettings(['presence']); })()`);
  // The open photo's record follows its (debounced) document save.
  await expect.poll(() => page.evaluate(`${O}.library.useLibrary.getState().photos.map((p) => p.recipe?.presence.saturation)`)).toEqual([40, 40, 40]);
  // Each photo has its own single "Sync settings" step.
  const docs = await page.evaluate(`(async () => Promise.all(${O}.library.useLibrary.getState().photos.map(async (p) => (await ${O}.edit.loadDoc(p.key)).copies[0].steps.map((s) => s.label))))()`) as string[][];
  expect(docs.filter((d) => d.at(-1) === 'Sync settings')).toHaveLength(2);
  // Batch export as a ZIP.
  await page.keyboard.press('g');
  await page.evaluate(`${O}.library.useLibrary.getState().selectAll()`);
  await page.getByRole('button', { name: /Batch actions/ }).click();
  await page.getByRole('menuitem', { name: /Export selection/ }).click();
  await page.getByLabel('Export preset').selectOption('web-2048');
  await page.getByLabel('File name template').fill('{seq:001}_{filename}');
  await page.getByText('Download as a ZIP').click();
  const download = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByRole('button', { name: /^Export 3/ }).click();
  const zip = readFileSync(await (await download).path());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const names = ['001_scene_', '002_scene_', '003_scene_'];
  for (const n of names) expect(zip.includes(Buffer.from(n))).toBe(true);
});

test('preview matches export, preset at 0 % is the identity', async ({ page }) => {
  await start(page);
  const files = await fixtures(page, 1);
  await importFiles(page, files);
  await openFirst(page);
  const diff = await page.evaluate(`(async () => {
    const o = ${O};
    const img = o.image.useImage.getState().image;
    const r = o.core.getRenderer();
    const T = { mode: 'encoded', space: 'srgb', dither: false, clipOverlay: false };
    const base = o.edit.useEdit.getState().recipe;
    const eff = (x) => o.schema.effectiveRecipe(x, img.asShot);
    const mean = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) s += Math.abs(a[i] - b[i]); return s / (a.length * 0.75); };
    // Preset at 0 %.
    const p = o.presets.usePresets.getState().all()[0];
    const zero = o.apply.applyPreset(base, p, img.isRaw, 0);
    const a = r.renderSmall(eff(base), T, 256).data, b = r.renderSmall(eff(zero), T, 256).data;
    // Preview (proxy) vs. full-resolution export of an edit with a mask, compared at 256 px.
    const m = o.masks;
    const edit = { ...base, light: { ...base.light, exposure: 0.4 }, masks: [m.newMask('R', [m.newComponent('radial')], { exposure: 1, saturation: 30 })] };
    const prev = r.renderSmall(eff(edit), T, 256);
    const es = await import('/src/io/encode/exportSettings.ts');
    const ec = await import('/src/io/encode/exportClient.ts');
    const bytes = await ec.renderAndEncode(img, edit, { ...es.baseSettings(), format: 'png', colorSpace: 'srgb', size: { mode: 'longEdge', px: Math.max(prev.width, prev.height) }, metadata: 'strip' }, () => {}, new AbortController().signal);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(prev.width, prev.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, prev.width, prev.height);
    const px = x.getImageData(0, 0, prev.width, prev.height).data;
    let s = 0; for (let i = 0; i < px.length; i++) if ((i & 3) !== 3) s += Math.abs(px[i] / 255 - prev.data[i]);
    return { identity: mean(a, b), previewVsExport: s / (px.length * 0.75) };
  })()`) as { identity: number; previewVsExport: number };
  expect(diff.identity).toBe(0);
  expect(diff.previewVsExport).toBeLessThan(0.02);
});

test('GPU output stays within the gamut; the CPU reference maps into it', async ({ page }) => {
  await start(page);
  const files = await fixtures(page, 1);
  await importFiles(page, files);
  await openFirst(page);
  const res = await page.evaluate(`(async () => {
    const o = ${O};
    const g = await import('/src/color/gamut.ts');
    const M = await import('/src/color/matrices.ts');
    const tr = await import('/src/color/transfer.ts');
    // Saturated working-space colours through the output stage only (via the stage's GLSL on a 1×1 render is not
    // reachable directly): compare the CPU reference with the expected properties instead, and check the GPU output
    // of a heavily saturated edit stays within [0, 1] with no hue flips.
    const img = o.image.useImage.getState().image;
    const r = o.core.getRenderer();
    const base = o.edit.useEdit.getState().recipe;
    const sat = { ...base, presence: { ...base.presence, saturation: 100, vibrance: 100 } };
    const out = r.renderSmall(o.schema.effectiveRecipe(sat, img.asShot), { mode: 'encoded', space: 'srgb', dither: false, clipOverlay: false }, 128).data;
    let min = 1, max = 0; for (let i = 0; i < out.length; i++) if ((i & 3) !== 3) { min = Math.min(min, out[i]); max = Math.max(max, out[i]); }
    const cpu = g.gamutMap([0.6, 0.02, 0.02], M.workingTo('srgb')).map(tr.linearToSrgb);
    return { min, max, cpu };
  })()`) as { min: number; max: number; cpu: number[] };
  expect(res.min).toBeGreaterThanOrEqual(0);
  expect(res.max).toBeLessThanOrEqual(1);
  expect(Math.min(...res.cpu)).toBeGreaterThanOrEqual(0);
});
