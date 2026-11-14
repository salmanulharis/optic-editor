/**
 * Android app integration (Capacitor). Everything here is a no-op in the browser, so the web / PWA
 * build behaves exactly as before.
 *
 *  - Files the app produces (exports, ZIPs, preset packs) cannot be "downloaded" inside a WebView:
 *    they are written to the app cache in chunks, then saved to the gallery / Downloads
 *    (`OpticFiles` plugin, MediaStore), or offered through the share sheet on Android 7–9.
 *  - Photos picked, shared to Optic or opened with it are read natively (`pickPhotos`,
 *    `takeIncoming`), so file names, MIME types and sizes are reliable.
 *  - The back button closes the open sheet / dialog, then leaves the editor, then exits.
 *  - The splash screen hides once the first frame is up; haptics use the native engine.
 *
 * This module is in the main chunk, so it stays small: the integration lives in nativeApp.ts,
 * which is loaded only inside the app.
 *
 * Android WebView never makes a page cross-origin isolated, whatever headers it gets (measured on
 * WebView 124: shared memory cannot be posted to workers). The app therefore runs non-isolated:
 * `SharedArrayBuffer` is undefined and the decoders run single-threaded. Code must never reference
 * `SharedArrayBuffer` unguarded (see `transferable` in io/decode/imageOps.ts).
 */
import { Capacitor } from '@capacitor/core';

export const isNative = (): boolean => Capacitor.isNativePlatform();
export const isAndroidApp = (): boolean => Capacitor.getPlatform() === 'android';

/** Save a file produced by the app. Returns false in the browser (caller downloads instead). */
export async function saveFileNative(blob: Blob, name: string): Promise<boolean> {
  if (!isNative()) return false;
  return (await import('./nativeApp')).saveFile(blob, name);
}

/** A light haptic tick (slider detents, long-press). */
export function haptic(strength: 'light' | 'medium' = 'light') {
  if (isNative()) {
    void import('@capacitor/haptics').then(({ Haptics, ImpactStyle }) =>
      Haptics.impact({ style: strength === 'light' ? ImpactStyle.Light : ImpactStyle.Medium })).catch(() => {});
    return;
  }
  try { navigator.vibrate?.(strength === 'light' ? 8 : 12); } catch { /* no vibration */ }
}

/** Set up the app (system bars, back button, shared photos, splash screen); nothing in the browser. */
export async function initNative() {
  if (!isNative()) return;
  await (await import('./nativeApp')).initNativeApp();
}
