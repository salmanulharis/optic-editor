#!/usr/bin/env node
/**
 * Renders public/icons/optic.svg into the PWA icons, the Apple touch icon, favicons and the iOS
 * splash screens (headless Chrome / Edge via playwright-core). Run after changing the logo:
 *   node scripts/build-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const svg = readFileSync('public/icons/optic.svg', 'utf8');
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'msedge' }).catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage();

async function render(file, w, h, { pad = 0, bg = 'transparent', logo = 1 } = {}) {
  const size = Math.round(Math.min(w, h) * logo * (1 - 2 * pad));
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;background:${bg}">
    <div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
  writeFileSync(file, await page.screenshot({ omitBackground: bg === 'transparent', type: 'png' }));
}

await render('public/icons/icon-192.png', 192, 192);
await render('public/icons/icon-512.png', 512, 512);
// Maskable: the logo inside the 80 % safe zone on a full-bleed background.
await render('public/icons/maskable-512.png', 512, 512, { bg: '#1c1c1c', pad: 0.1 });
await render('public/icons/apple-touch-icon.png', 180, 180, { bg: '#1c1c1c' });
await render('public/icons/favicon-32.png', 32, 32);
// iOS splash screens (portrait, device pixels): iPhone 15/16 Pro (Max), iPhone SE, iPad Air / Pro.
const SPLASH = [[1179, 2556], [1290, 2796], [1206, 2622], [1320, 2868], [750, 1334], [1640, 2360], [2048, 2732], [1668, 2388]];
for (const [w, h] of SPLASH) {
  await render(`public/icons/splash-${w}x${h}.png`, w, h, { bg: '#1c1c1c', logo: 0.28 });
  await render(`public/icons/splash-${h}x${w}.png`, h, w, { bg: '#1c1c1c', logo: 0.28 });
}
await browser.close();
console.log('icons written to public/icons');
