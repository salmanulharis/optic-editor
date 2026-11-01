/**
 * Native shell integration (Capacitor: Android APK, iOS IPA). Everything here is a no-op in the
 * browser, so the web / PWA build behaves exactly as before.
 *
 *  - Files the app produces (exports, ZIPs, preset packs) cannot be "downloaded" inside a WebView:
 *    they are written to the app cache in chunks, then saved to the gallery / Downloads (Android,
 *    `OpticFiles` plugin in MainActivity) or offered through the share sheet (iOS: Save Image,
 *    Save to Files, AirDrop, …).
 *  - The Android back button closes the open sheet / dialog, then leaves the editor, then exits.
 *  - The splash screen hides once the first frame is up; haptics replace `navigator.vibrate`
 *    (not available on iOS).
 *
 * The native projects add the cross-origin isolation headers to every local response
 * (android/.../IsolatingWebViewClient.java, ios/App/App/CrossOriginIsolation.swift), so
 * SharedArrayBuffer and the threaded RAW decoder work like on the web.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export const isNative = (): boolean => Capacitor.isNativePlatform();
export const isAndroidApp = (): boolean => Capacitor.getPlatform() === 'android';
export const isIOSApp = (): boolean => Capacitor.getPlatform() === 'ios';

interface IncomingFile { path: string; name: string; mime?: string }
interface OpticFilesPlugin {
  /** Copy a cache file into MediaStore (Pictures/Optic or Download/Optic). */
  saveToDevice(o: { path: string; name: string; mime: string }): Promise<{ location: string }>;
  /** Photos shared to / opened with the app since the last call (copied into the cache). */
  takeIncoming(): Promise<{ files: IncomingFile[] }>;
  addListener(event: 'incoming', f: () => void): Promise<{ remove(): Promise<void> }>;
}
const OpticFiles = registerPlugin<OpticFilesPlugin>('OpticFiles');

const CHUNK = 3 * 1024 * 1024; // multiple of 3: base64 chunks concatenate cleanly

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Write a blob into the app cache (chunked: ZIP exports can be gigabytes). Returns its file URI. */
async function writeCache(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const path = `exports/${Date.now()}-${name}`;
  for (let off = 0; off < Math.max(blob.size, 1); off += CHUNK) {
    const data = toBase64(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
    if (off === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
  }
  return (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
}

/** Remove cached exports from earlier sessions (the share sheet may still read the latest). */
async function cleanCache() {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { files } = await Filesystem.readdir({ path: 'exports', directory: Directory.Cache });
    const old = Date.now() - 24 * 3600 * 1000;
    for (const f of files) if ((f.mtime ?? 0) < old) await Filesystem.deleteFile({ path: `exports/${f.name}`, directory: Directory.Cache });
  } catch { /* nothing cached yet */ }
}

/** Save a file produced by the app. Returns false in the browser (caller downloads instead). */
export async function saveFileNative(blob: Blob, name: string): Promise<boolean> {
  if (!isNative()) return false;
  const mime = blob.type || 'application/octet-stream';
  try {
    const uri = await writeCache(blob, name);
    if (isAndroidApp()) {
      try {
        const { location } = await OpticFiles.saveToDevice({ path: uri, name, mime });
        toast(`Saved to ${location}`);
        return true;
      } catch (e) {
        console.warn('[optic] MediaStore save failed, sharing instead', e);
      }
    }
    const { Share } = await import('@capacitor/share');
    await Share.share({ title: name, files: [uri], dialogTitle: `Save ${name}` });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!/cancel/i.test(msg)) toast(`Could not save ${name}: ${msg}`, true);
  }
  return true;
}

/** A short message at the bottom of the screen (above the tab bar). */
export function toast(text: string, error = false) {
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.cssText = `position:fixed;left:50%;bottom:calc(72px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;max-width:min(90vw,480px);padding:8px 14px;border-radius:10px;font:500 13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);transition:opacity .3s;background:${error ? '#3a2020' : 'rgb(var(--c-raise))'};color:${error ? '#f4c4c4' : 'rgb(var(--c-strong))'};border:1px solid rgba(255,255,255,.08)`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 3000);
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

/**
 * Android back button: close the topmost dialog / bottom sheet (whatever handles Escape), else
 * go from the editor back to the library, else leave the app.
 */
async function initBackButton() {
  const { App } = await import('@capacitor/app');
  const { useLibrary } = await import('../state/libraryStore');
  await App.addListener('backButton', () => {
    // Each dialog / sheet closes on Escape from its own role="dialog" element; the last is on top.
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    const top = dialogs[dialogs.length - 1];
    if (top) {
      top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return;
    }
    const lib = useLibrary.getState();
    if (lib.view === 'editor') { lib.set({ view: 'library' }); return; }
    void App.minimizeApp();
  });
}

/** Read native files (cache or Documents/Inbox) through the local server and import them. */
async function importNative(files: IncomingFile[]) {
  if (!files.length) return;
  const list = await Promise.all(files.map(async (f) => {
    const blob = await (await fetch(Capacitor.convertFileSrc(f.path))).blob();
    const file = new File([blob], f.name, { type: f.mime || blob.type, lastModified: Date.now() });
    return { file, path: f.name };
  }));
  const { ingest } = await import('./pwa');
  ingest(list);
}

/** Photos shared to Optic (Android share sheet / "Open with") and files opened in it (iOS "Open in"). */
async function initIncoming() {
  if (isAndroidApp()) {
    const take = () => OpticFiles.takeIncoming().then((r) => importNative(r.files)).catch((e) => toast(`Could not open the shared photo: ${(e as Error).message}`, true));
    await OpticFiles.addListener('incoming', take);
    // The launch intent is copied in the background; poll briefly for it.
    for (const ms of [300, 1200, 3000]) setTimeout(take, ms);
  }
  if (isIOSApp()) {
    const { App } = await import('@capacitor/app');
    const open = (url: string) => {
      if (!url.startsWith('file:')) return;
      const name = decodeURIComponent(url.split('/').pop() ?? 'photo.jpg');
      void importNative([{ path: url, name }]).catch((e) => toast(`Could not open ${name}: ${(e as Error).message}`, true));
    };
    await App.addListener('appUrlOpen', (e) => open(e.url));
    const launch = await App.getLaunchUrl();
    if (launch?.url) open(launch.url);
  }
}

export async function initNative() {
  if (!isNative()) return;
  document.documentElement.classList.add('native-app', `native-${Capacitor.getPlatform()}`);
  if (!globalThis.crossOriginIsolated) console.warn('[optic] native shell is not cross-origin isolated: check the header injection');
  // Status / navigation bar icons follow the app theme (light icons on Optic's dark themes).
  const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
  const bars = () => {
    const light = document.documentElement.dataset.theme === 'light';
    SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {});
  };
  bars();
  new MutationObserver(bars).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (isAndroidApp()) void initBackButton();
  void initIncoming();
  void cleanCache();
  requestAnimationFrame(() => setTimeout(() => {
    void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide({ fadeOutDuration: 250 })).catch(() => {});
  }, 50));
}
