#!/usr/bin/env node
/**
 * App icons and splash screens for the Android / iOS apps, from public/icons/optic.svg.
 * Renders the sources into assets/ (headless Chrome / Edge via playwright-core), then
 * @capacitor/assets writes every density into android/ and ios/:
 *   npm run native:assets
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const BG = '#1c1c1c';
const svg = readFileSync('public/icons/optic.svg', 'utf8');
mkdirSync('assets', { recursive: true });
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'msedge' }).catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage();

// Variants of the logo: the full-bleed tile (iOS masks the corners itself), the glyph alone and
// the tile background alone (the two layers of an Android adaptive icon).
const SVG = {
  tile: svg.replace(/rx="\d+"/, 'rx="0"'),
  glyph: svg.replace(/<rect [^>]*\/>/, ''),
  back: svg.replace(/rx="\d+"/, 'rx="0"').replace(/<circle[\s\S]*<\/svg>/, '</svg>'),
  logo: svg,
};

async function render(file, w, h, { bg = 'transparent', logo = 1, art = 'logo' } = {}) {
  const svg = SVG[art];
  const size = Math.round(Math.min(w, h) * logo);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;background:${bg}">
    <div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
  writeFileSync(file, await page.screenshot({ omitBackground: bg === 'transparent', type: 'png' }));
}

// iOS icon: full-bleed square, no transparency (the system rounds the corners).
await render('assets/icon-only.png', 1024, 1024, { bg: BG, art: 'tile' });
// Android adaptive icon: the ring inside the 66 % safe zone over the gradient layer.
await render('assets/icon-foreground.png', 1024, 1024, { art: 'glyph', logo: 0.88 });
await render('assets/icon-background.png', 1024, 1024, { bg: BG, art: 'back' });
await render('assets/splash.png', 2732, 2732, { bg: BG, logo: 0.2 });
await render('assets/splash-dark.png', 2732, 2732, { bg: BG, logo: 0.2 });
await browser.close();

execSync(
  `npx --yes @capacitor/assets@3 generate --android --ios --iconBackgroundColor "${BG}" --iconBackgroundColorDark "${BG}" --splashBackgroundColor "${BG}" --splashBackgroundColorDark "${BG}"`,
  { stdio: 'inherit' },
);
console.log('native icons and splash screens written to android/ and ios/');
