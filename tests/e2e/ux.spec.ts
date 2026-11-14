/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Page, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, importFiles, openFirst, start } from './helpers';

const O = 'window.__optic';

async function axe(page: Page, include = 'body') {
  await page.addScriptTag({ path: join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js') });
  return page.evaluate(async (include) => {
    const r = await (window as any).axe.run(include, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
    return r.violations.map((v: any) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
  }, include);
}

test('accessibility: library, editor, export and settings pass axe (WCAG 2.2 A/AA)', async ({ page }) => {
  await start(page);
  expect(await axe(page)).toEqual([]);
  await importFiles(page, await fixtures(page, 2));
  expect(await axe(page)).toEqual([]);
  await openFirst(page);
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Control+e');
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('accessibility: touch layout passes axe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  expect(await axe(page)).toEqual([]);
});

test('Reset all is instant and offers Undo in a toast', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);
  await page.evaluate(`${O}.edit.useEdit.getState().apply((r) => ({ ...r, light: { ...r.light, exposure: 0.7 } }))`);
  await page.getByRole('button', { name: 'Reset all' }).click();
  expect(await page.evaluate(`${O}.edit.useEdit.getState().recipe.light.exposure`)).toBe(0);
  const toast = page.getByText('All adjustments reset');
  await expect(toast).toBeVisible();
  // The toast's own Undo (the toolbar has one too).
  await toast.locator('..').getByRole('button', { name: 'Undo' }).click();
  expect(await page.evaluate(`${O}.edit.useEdit.getState().recipe.light.exposure`)).toBe(0.7);
  await expect(toast).toBeHidden();
});

test('in-app confirm and name dialogs replace the browser pop-ups', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 2));
  // Removing photos asks in an in-app dialog; Cancel is focused first (destructive action).
  await page.getByRole('listbox', { name: 'Photos' }).getByRole('option').first().click();
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('dialog', { name: 'Remove 1 photo from Optic?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(await page.evaluate(`${O}.library.useLibrary.getState().photos.length`)).toBe(2);
  // New collection: an empty name is refused with a message next to the field.
  await page.getByRole('button', { name: 'New collection' }).click();
  const prompt = page.getByRole('dialog', { name: 'New collection' });
  await expect(prompt).toBeVisible();
  await prompt.getByLabel('Collection name').fill('   ');
  await prompt.getByRole('button', { name: 'Create' }).click();
  await expect(prompt.getByRole('alert')).toHaveText('Enter a name.');
  await prompt.getByLabel('Collection name').fill('Trip');
  await prompt.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('dialog', { name: /Add the 1 selected photo to “Trip”\?/ }).getByRole('button', { name: 'Not now' }).click();
  expect(await page.evaluate(`${O}.library.useLibrary.getState().collections.map((c) => c.name)`)).toContain('Trip');
});

test('layout: presets drawer below 1024 px, F hides the panels, the top bar never overflows', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);
  for (const w of [900, 1023, 1024, 1279, 1440, 1920]) {
    await page.setViewportSize({ width: w, height: 800 });
    const over = await page.evaluate(() => { const h = document.querySelector('header')!; return h.scrollWidth - h.clientWidth; });
    expect(over, `top bar at ${w}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 960, height: 760 });
  await expect(page.getByRole('complementary', { name: 'Presets and history' })).toHaveCount(0);
  const presets = page.getByRole('button', { name: 'Presets', exact: true });
  await presets.click();
  const drawer = page.getByRole('dialog', { name: 'Presets and history' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(presets).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.locator('canvas').first().click();
  await page.keyboard.press('f');
  await expect(page.getByRole('complementary', { name: 'Adjustments' })).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__optic);
  expect(await page.evaluate(`${O}.ui.useUi.getState().panelsHidden`)).toBe(true);
});

test('tooltips appear on keyboard focus and close with Escape', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);
  const reset = page.getByRole('button', { name: 'Reset Light' });
  await reset.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveText('Reset Light');
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});

test('"Follow the system" theme follows the operating system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await start(page);
  await page.evaluate(() => (window as any).__optic && import('/src/state/settingsStore.ts').then((m) => m.useSettings.getState().set({ theme: 'system' })));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')).toBe('dark');
});

test('one section at a time: opening a section closes the others', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);
  await page.getByLabel('One section at a time').check();
  const header = (name: string) => page.getByRole('complementary', { name: 'Adjustments' }).getByRole('button', { name, exact: true });
  await header('Light').click();
  await expect(header('Light')).toHaveAttribute('aria-expanded', 'true');
  await expect(header('White Balance')).toHaveAttribute('aria-expanded', 'false');
  await header('Presence').click();
  await expect(header('Presence')).toHaveAttribute('aria-expanded', 'true');
  await expect(header('Light')).toHaveAttribute('aria-expanded', 'false');
});

test('"Try a sample photo" opens the CC0 sample in the editor', async ({ page }) => {
  test.skip(!existsSync(join(process.cwd(), 'public', 'samples', 'sample.json')), 'needs npm run sample:fetch');
  await start(page);
  await page.getByRole('button', { name: 'Try a sample photo →' }).click();
  await page.waitForFunction(() => !!(window as any).__optic.image.useImage.getState().image, null, { timeout: 120_000 });
  expect(await page.evaluate(`${O}.image.useImage.getState().image.isRaw`)).toBe(true);
});

test('languages set the page direction (test languages exist in development builds only)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('optic.settings', JSON.stringify({ onboardingDone: true, language: 'ar-XB' })));
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__optic);
  expect(await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang])).toEqual(['rtl', 'ar-XB']);
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe('rtl');
});
