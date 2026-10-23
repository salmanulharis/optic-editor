/** The loaded image (pixels + colour metadata) and the decode lifecycle. */
import { create } from 'zustand';
import { decodeFile, type DecodeJob } from '../io/decode/decodeClient';
import type { CameraInfo, DecodeResult, FloatImage, ImageColor, SourceFormat } from '../io/decode/types';
import type { ExifBlocks } from '../io/metadata/exif';
import { asShotTempTint } from '../pipeline/derive';
import type { ImageModel } from '../pipeline/types';
import { type Recipe, defaultRecipe, defaultsForSource } from '../recipe/schema';
import { loadDoc, useEdit } from './editStore';
import { startAnalysis } from '../app/analysis';
import { useSettings } from './settingsStore';
import { isIOS } from '../ui/mobile/layout';

export interface LoadedImage {
  id: number;
  file: File;
  fileName: string;
  format: SourceFormat;
  isRaw: boolean;
  bitDepth: number;
  width: number;
  height: number;
  full: FloatImage;
  proxy: FloatImage;
  thumb: FloatImage;
  color: ImageColor;
  info: CameraInfo;
  exif: ExifBlocks | null;
  decoder: string;
  warnings: string[];
  /** Stable object handed to the pipeline. */
  model: ImageModel;
  asShot: { temperature: number; tint: number };
}

interface ImageState {
  image: LoadedImage | null;
  /** Catalog id of the open photo (null for a photo outside the library). */
  photoId: string | null;
  loading: { fraction: number; label: string; fileName: string } | null;
  error: string | null;
  load(file: File, proxyLongEdge: number, opts?: LoadOptions): Promise<void>;
  cancel(): void;
  close(): void;
  clearError(): void;
}

let job: DecodeJob | null = null;
let nextId = 1;

/** Build the loaded-image object (and its pipeline model) from a decode result. */
export function buildLoadedImage(file: File, key: string, result: DecodeResult, exif: ExifBlocks | null): LoadedImage {
  const model: ImageModel = {
    isRaw: result.isRaw,
    bitDepth: result.bitDepth,
    color: result.color,
    width: result.full.width,
    height: result.full.height,
    key,
    focal35: result.info.focal35,
    lens: result.lens ?? null,
    analysis: {},
  };
  return {
    id: nextId++,
    file,
    fileName: file.name,
    format: result.format,
    isRaw: result.isRaw,
    bitDepth: result.bitDepth,
    width: result.full.width,
    height: result.full.height,
    full: result.full,
    proxy: result.proxy,
    thumb: result.thumb,
    color: result.color,
    info: result.info,
    exif,
    decoder: result.decoder,
    warnings: result.warnings,
    model,
    asShot: asShotTempTint(model),
  };
}

export interface LoadOptions {
  /** Catalog identity (edit document key); defaults to the file's name, size and date. */
  key?: string;
  /** Catalog photo id, when opened from the library. */
  photoId?: string | null;
  /** Recipe for a photo opened for the first time (e.g. preset chosen at import). */
  initial?: (defaults: Recipe, img: LoadedImage) => Recipe;
}

export const useImage = create<ImageState>((set, get) => ({
  image: null,
  photoId: null,
  loading: null,
  error: null,
  async load(file, proxyLongEdge, opts = {}) {
    job?.cancel();
    const key = opts.key ?? photoKey(file);
    set({ loading: { fraction: 0, label: 'Starting', fileName: file.name }, error: null });
    const current = decodeFile(file, proxyLongEdge, (fraction, label) => {
      if (get().loading) set({ loading: { fraction, label, fileName: file.name } });
    });
    job = current;
    // The photo's saved history (if it was edited before) loads while it decodes.
    const docPromise = loadDoc(key).catch(() => null);
    try {
      const { result, exif } = await current.promise;
      if (job !== current) return;
      const image = buildLoadedImage(file, key, result, exif);
      let r = defaultRecipeFor(image);
      const stored = await docPromise;
      if (!stored && opts.initial) r = opts.initial(r, image);
      useEdit.getState().openDoc(key, file.name, r, stored);
      set({ image, photoId: opts.photoId ?? null, loading: null });
      const mp = (image.width * image.height) / 1e6;
      if (isIOS() && mp > 30) set({ error: `${file.name}: a ${Math.round(mp)} MP photo uses most of this device's memory. Editing works; exports are processed in small tiles, and closing other tabs helps.` });
      startAnalysis(image);
      for (const w of result.warnings) console.info(`[optic] ${w}`);
    } catch (e) {
      if (job !== current) return;
      const err = e as Error;
      if (err.name === 'AbortError') set({ loading: null });
      else {
        console.warn('[optic] decode failed', err);
        set({ loading: null, error: `${file.name}: ${friendlyDecodeError(err)}` });
      }
    } finally {
      if (job === current) job = null;
    }
  },
  cancel() {
    job?.cancel();
    job = null;
    set({ loading: null });
  },
  close() {
    job?.cancel();
    job = null;
    set({ image: null, photoId: null, loading: null });
  },
  clearError: () => set({ error: null }),
}));

/** Turn decoder / allocation failures into a message a person can act on. */
export function friendlyDecodeError(err: Error): string {
  const m = err.message || String(err);
  if (/allocat|out of memory|RangeError|Array buffer|memory access/i.test(m) || err.name === 'RangeError') {
    return 'not enough memory to open this photo on this device. Close other tabs or apps and try again.';
  }
  if (/Unsupported file type/i.test(m)) return 'this file type is not supported.';
  if (/worker|terminated/i.test(m)) return `the decoder stopped unexpectedly (${m}). The file may be damaged.`;
  return `could not be read: ${m}. The file may be damaged or in an unsupported variant.`;
}

/** Stable identity of a file across sessions (history, snapshots and grain seed key on it). */
export function photoKey(file: File) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** Defaults for this image: source-type defaults with As Shot white balance filled in. */
export function defaultRecipeFor(img: LoadedImage | null) {
  const r = img ? defaultsForSource(img.isRaw) : defaultRecipe();
  if (img) {
    // The starting detail settings chosen in Settings (RAW vs. non-RAW).
    const d = img.isRaw ? useSettings.getState().raw : useSettings.getState().nonRaw;
    r.detail.sharpen = { ...r.detail.sharpen, amount: d.sharpen };
    r.detail.nr = { ...r.detail.nr, color: d.colorNr, lum: d.lumNr };
    r.lens.auto = d.lensAuto;
  }
  if (img) {
    r.whiteBalance.temperature = img.asShot.temperature;
    r.whiteBalance.tint = img.asShot.tint;
  }
  return r;
}
