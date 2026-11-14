/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Page, expect, test } from '@playwright/test';
import { join } from 'node:path';
import { fixtures, importFiles, openFirst, start } from './helpers';

/** Tab / Shift+Tab many times and check focus never leaves the dialog. */
async function expectFocusTrapped(page: Page, name: string | RegExp) {
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
  }
}

async function axeDialog(page: Page) {
  await page.addScriptTag({ path: join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js') });
  return page.evaluate(async () => {
    const r = await (window as any).axe.run('[role="dialog"]', { runOnly: ['wcag2a', 'wcag2aa'] });
    return r.violations.map((v: any) => `${v.id}: ${v.nodes.length}`);
  });
}

test('dialogs load on demand, trap focus, close with Escape and return focus', async ({ page }) => {
  await start(page);
  await importFiles(page, await fixtures(page, 1));
  await openFirst(page);

  // Settings (lazy chunk).
  await page.keyboard.press('Control+,');
  await expectFocusTrapped(page, 'Settings');
  expect(await axeDialog(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();

  // Keyboard shortcuts (lazy chunk).
  await page.keyboard.press('?');
  await expectFocusTrapped(page, 'Keyboard shortcuts');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();

  // Export (lazy chunk; Shell gained a focus trap).
  await page.keyboard.press('Control+e');
  await expectFocusTrapped(page, 'Export');
  expect(await axeDialog(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden();

  // Snapshot (gained aria-modal and a focus trap).
  await page.keyboard.press('Control+Shift+S');
  await expectFocusTrapped(page, 'Create snapshot');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Create snapshot' })).toBeHidden();

  // The shared Modal (Create preset): focus moves in, stays in, and returns to the opener.
  const create = page.getByRole('button', { name: '+ Create' });
  await create.focus();
  await page.keyboard.press('Enter');
  await expectFocusTrapped(page, 'Create preset');
  expect(await axeDialog(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Create preset' })).toBeHidden();
  await expect(create).toBeFocused();
});

test('photo import dialog traps focus', async ({ page }) => {
  await start(page);
  await page.locator('input[type=file][multiple]').first().setInputFiles(await fixtures(page, 2));
  await expectFocusTrapped(page, /^Import 2 photos/);
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('first-launch tour loads on demand', async ({ page }) => {
  // No onboardingDone flag: the tour chunk loads and the dialog opens.
  await page.goto('/');
  const tour = page.getByRole('dialog', { name: 'Welcome to Optic' });
  await expect(tour).toBeVisible();
  await expect(tour).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await expect(tour).toBeHidden();
});
