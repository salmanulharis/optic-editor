#!/usr/bin/env node
/**
 * Release APK: web build → Capacitor sync → Gradle assembleRelease → release/optic-<version>.apk
 *   npm run android:apk
 * Signing: android/keystore.properties (see docs/MOBILE.md); without it the debug key is used.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd });
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

if (!process.argv.includes('--skip-web')) {
  run('npm run build');
  run('npx cap sync android');
}
run(`${process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'} assembleRelease`, 'android');

const dir = 'android/app/build/outputs/apk/release';
const apk = readdirSync(dir).find((f) => f.endsWith('.apk'));
if (!apk) throw new Error(`no APK in ${dir}`);
mkdirSync('release', { recursive: true });
copyFileSync(`${dir}/${apk}`, `release/optic-${version}.apk`);
console.log(`\nAPK: release/optic-${version}.apk`);
