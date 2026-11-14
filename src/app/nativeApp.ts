/** The Android app's integration, loaded only inside the app (see native.ts). */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { t } from '../i18n';
import { toast, toastError } from '../ui/feedback/toasts';

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

/** Save a file the app produced to the device (gallery / Downloads), else offer the share sheet. */
export async function saveFile(blob: Blob, name: string): Promise<boolean> {
  const mime = blob.type || 'application/octet-stream';
  try {
    const uri = await writeCache(blob, name);
    try {
      const { location } = await OpticFiles.saveToDevice({ path: uri, name, mime });
      toast(t('native.saved_to', { location }));
      return true;
    } catch (e) {
      console.warn('[optic] MediaStore save failed, sharing instead', e);
    }
    const { Share } = await import('@capacitor/share');
    await Share.share({ title: name, files: [uri], dialogTitle: t('native.save_dialog', { name }) });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!/cancel/i.test(msg)) toastError(t('native.save_failed', { name, msg }));
  }
  return true;
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

/** Read native cache files through the local server and import them. */
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

/** Photos shared to Optic (share sheet / "Open with"). */
async function initIncoming() {
  const take = () => OpticFiles.takeIncoming().then((r) => importNative(r.files)).catch((e) => toastError(t('native.shared_failed', { msg: (e as Error).message })));
  await OpticFiles.addListener('incoming', take);
  // The launch intent is copied in the background; poll briefly for it.
  for (const ms of [300, 1200, 3000]) setTimeout(take, ms);
}

export async function initNativeApp() {
  document.documentElement.classList.add('native-app', `native-${Capacitor.getPlatform()}`);
  // Status / navigation bar icons follow the app theme (light icons on Optic's dark themes).
  const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
  const bars = () => {
    const light = document.documentElement.dataset.theme === 'light';
    SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {});
  };
  bars();
  new MutationObserver(bars).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  void initBackButton();
  void initIncoming();
  void cleanCache();
  requestAnimationFrame(() => setTimeout(() => {
    void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide({ fadeOutDuration: 250 })).catch(() => {});
  }, 50));
}
