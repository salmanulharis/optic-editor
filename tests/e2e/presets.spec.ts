/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures, importFiles, openFirst, start } from './helpers';

const O = 'window.__optic';
const LR = join(process.cwd(), 'tests', 'unit', 'fixtures', 'lightroom');

/** A camera-profile XMP (not a preset), written to a temp folder. */
function profileFile(): string {
  const dir = join(tmpdir(), `optic-lr-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'Some Profile.xmp');
  writeFileSync(f, `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PresetType="Look" crs:UUID="AB"><crs:RGBTable>00</crs:RGBTable></rdf:Description>
  </rdf:RDF></x:xmpmeta>`);
  return f;
}

test('Lightroom presets: import, report, apply with amount, export as an Optic pack', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);

  // Import a Lightroom preset and a profile through the preset browser's Import button.
  await page.locator('input[type=file][accept*=".lrtemplate"]').setInputFiles([join(LR, 'moody-fade.xmp'), profileFile()]);
  const status = page.getByRole('status').filter({ hasText: 'from Lightroom' });
  await expect(status).toContainText('Imported 1 preset(s) from Lightroom.');
  await expect(status).toContainText('1 failed.');
  await expect(status).toContainText('Some settings were not converted.');

  // The report lists both files, with reasons, and is keyboard accessible.
  await status.getByRole('button', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import report' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Moody Fade');
  await expect(dialog).toContainText('Partly converted');
  await expect(dialog).toContainText('camera profile (Adobe Portrait), 1 mask(s)');
  await expect(dialog).toContainText('This is a camera profile, not a preset.');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.addScriptTag({ path: join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js') });
  const violations = await page.evaluate(async () => {
    const r = await (window as any).axe.run('[role="dialog"]', { runOnly: ['wcag2a', 'wcag2aa'] });
    return r.violations.map((v: any) => `${v.id}: ${v.nodes.length}`);
  });
  expect(violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(status.getByRole('button', { name: 'Details' })).toBeFocused(); // focus returns to the opener

  // The new group is open; applying the preset goes through the normal preset engine.
  const tile = page.locator('[data-preset^="lr-"]', { hasText: 'Moody Fade' });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('title', /Converted from Lightroom \(moody-fade\.xmp\)\. Not converted: camera profile \(Adobe Portrait\)/);
  await tile.click();
  // A JPEG: contrast gets Optic's usual non-RAW scaling (15 × 0.75); highlights apply as is.
  expect(await page.evaluate(`${O}.edit.useEdit.getState().recipe.light.contrast`)).toBe(11.25);
  expect(await page.evaluate(`${O}.edit.useEdit.getState().recipe.light.highlights`)).toBe(-40);
  expect(await page.evaluate(`${O}.edit.useEdit.getState().recipe.appliedPreset.name`)).toBe('Moody Fade');
  await page.evaluate(`(() => { ${O}.actions.setAmountLive(50); ${O}.actions.commitAmount(); })()`);
  expect(await page.evaluate(`${O}.edit.useEdit.getState().recipe.light.highlights`)).toBe(-20);

  // Importing the same preset again updates it instead of adding a copy.
  await page.locator('input[type=file][accept*=".lrtemplate"]').setInputFiles([join(LR, 'moody-fade.xmp')]);
  await expect(page.getByRole('status').filter({ hasText: 'from Lightroom' })).toContainText('Imported 1 preset(s) from Lightroom.');
  expect(await page.evaluate(`${O}.presets.usePresets.getState().user.filter((p) => p.name === 'Moody Fade').length`)).toBe(1);

  // Converted presets export as plain Optic presets.
  await page.evaluate(`window.showSaveFilePicker = undefined`);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export pack' }).click();
  const pack = readFileSync(await (await download).path()).toString('latin1');
  expect(pack).toMatch(/presets\/lr-[0-9a-f]{14}\.json/);
  expect(pack).toContain('"name": "Moody Fade"');
});

test('Lightroom preset packs: zip folders become groups, duplicates and Mac junk are skipped', async ({ page }) => {
  await start(page);
  const files = {
    'Film Pack/XMP/Moody.xmp': readFileSync(join(LR, 'moody-fade.xmp')).toString('base64'),
    'Film Pack/XMP/Warm Matte.xmp': readFileSync(join(LR, 'warm-matte.xmp')).toString('base64'),
    'Film Pack/LRTEMPLATE/Warm Matte.lrtemplate': readFileSync(join(LR, 'warm-matte.lrtemplate')).toString('base64'),
    '__MACOSX/Film Pack/XMP/._Moody.xmp': Buffer.from('junk').toString('base64'),
  };
  const r = await page.evaluate(async (files) => {
    const { writeZip } = await import('/src/storage/zip.ts');
    const bin = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const zip = writeZip(Object.entries(files).map(([name, b64]) => ({ name, data: bin(b64) })));
    const o = (window as any).__optic;
    await o.presets.usePresets.getState().init();
    return o.presets.importFiles([new File([zip], 'Film Pack.zip')]);
  }, files);
  expect(r.lightroom).toBe(2);
  expect(r.errors).toEqual([]);
  expect(r.report.map((row: any) => [row.file, row.status, row.group ?? null])).toEqual([
    ['Moody.xmp', 'partial', 'Test Pack'], // the preset names its own group
    ['Warm Matte.xmp', 'converted', 'Film Pack'], // else the nearest meaningful folder
    ['Warm Matte.lrtemplate', 'duplicate', null],
  ]);
});

test('zips: oversized entries are reported without being unpacked, nested zips are reported', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async (xmpB64) => {
    const { writeZip } = await import('/src/storage/zip.ts');
    const xmp = Uint8Array.from(atob(xmpB64), (c) => c.charCodeAt(0));
    const zip = writeZip([
      { name: 'Pack/Warm.xmp', data: xmp },
      { name: 'Pack/Huge.xmp', data: new Uint8Array(3 * 1024 * 1024) },
      { name: 'Pack/Inner.zip', data: new Uint8Array(10) },
    ]);
    const o = (window as any).__optic;
    await o.presets.usePresets.getState().init();
    return o.presets.importFiles([new File([zip], 'Pack.zip')]);
  }, readFileSync(join(LR, 'warm-matte.xmp')).toString('base64'));
  expect(r.lightroom).toBe(1);
  expect(r.report.map((row: any) => [row.file, row.status, row.error ?? null])).toEqual([
    ['Huge.xmp', 'failed', 'tooLarge'],
    ['Warm.xmp', 'converted', null],
  ]);
  expect(r.errors).toEqual(['Pack/Inner.zip: zips inside zips are skipped; unzip it first.']);
});

test('a preset that browser storage refuses is reported as not saved', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);
  // Simulate a full disk: every IndexedDB write fails with QuotaExceededError.
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('full', 'QuotaExceededError'); };
  });
  await page.locator('input[type=file][accept*=".lrtemplate"]').setInputFiles([join(LR, 'warm-matte.xmp')]);
  const status = page.getByRole('status').filter({ hasText: 'from Lightroom' });
  await expect(status).toContainText('Browser storage is full');
  await status.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('dialog', { name: 'Import report' })).toContainText('Not saved: browser storage is full.');
  // Still usable in this session.
  await expect(page.locator('[data-preset^="lr-"]', { hasText: 'Warm Matte' })).toHaveCount(1);
});

test('a 200-preset pack imports without blocking the main thread', async ({ page }) => {
  await start(page);
  const xmp = readFileSync(join(LR, 'moody-fade.xmp'), 'utf8');
  const r = await page.evaluate(async (xmp) => {
    const { writeZip } = await import('/src/storage/zip.ts');
    const enc = new TextEncoder();
    const entries = Array.from({ length: 200 }, (_, i) => ({
      name: `Big Pack/Preset ${i}.xmp`,
      data: enc.encode(xmp.replace('5B1C6E0F0F0B4B3D9C1E2A7F8E9D0C1B', `UUID${i}`).replace('>Moody Fade<', `>Preset ${i}<`)),
    }));
    const zip = writeZip(entries);
    const o = (window as any).__optic;
    await o.presets.usePresets.getState().init();
    const long: number[] = [];
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
    obs.observe({ type: 'longtask', buffered: false });
    const t0 = performance.now();
    const res = await o.presets.importFiles([new File([zip], 'Big Pack.zip')]);
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    obs.disconnect();
    return { n: res.lightroom, ms, maxTask: Math.max(0, ...long) };
  }, xmp);
  expect(r.n).toBe(200);
  expect(r.maxTask).toBeLessThan(100);
});

test('presets dropped on the preset browser import as presets; photos dropped elsewhere still import as photos', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);
  const xmp = readFileSync(join(LR, 'warm-matte.xmp')).toString('base64');
  /** Dispatch a file drop (dragenter → dragover → drop) on the element matching `selector`. */
  const drop = (selector: string, name: string, b64: string, type: string) => page.evaluate(([selector, name, b64, type]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type }));
    const el = document.querySelector(selector)!;
    for (const kind of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [selector, name, b64, type]);

  await drop('[data-preset]', 'warm-matte.xmp', xmp, 'application/rdf+xml');
  await expect(page.getByRole('status').filter({ hasText: 'from Lightroom' })).toContainText('Imported 1 preset(s) from Lightroom.');
  await expect(page.getByRole('dialog')).toHaveCount(0); // no photo import dialog
  await expect(page.getByText('Drop to import')).toHaveCount(0); // the app's drop overlay was cleared

  // Back in the library, a dropped photo still goes to the photo import dialog.
  await page.keyboard.press('g');
  const jpeg = readFileSync((await fixtures(page, 1))[0]).toString('base64');
  await drop('body', 'dropped.jpg', jpeg, 'image/jpeg');
  // (The same synthetic image as before, so the dialog also flags it as a duplicate.)
  await expect(page.getByRole('dialog', { name: 'Import 1 photo' })).toBeVisible();
});

test('touch layout: the preset strip imports Lightroom presets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await page.getByRole('listbox', { name: 'Photos' }).getByRole('option').first().dblclick();
  await page.waitForFunction(() => !!(window as any).__optic.image.useImage.getState().image, null, { timeout: 120_000 });
  await page.getByRole('button', { name: 'Presets' }).click();
  const importTile = page.getByRole('button', { name: 'Import presets' });
  await expect(importTile).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await importTile.click();
  await (await chooser).setFiles([join(LR, 'warm-matte.xmp')]);
  await expect(page.getByRole('status').filter({ hasText: 'from Lightroom' })).toContainText('Imported 1 preset(s) from Lightroom.');
  // The strip switches to the new group and shows the preset.
  await expect(page.getByRole('tab', { name: 'Lightroom imports', selected: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Warm Matte' })).toBeVisible();
});
