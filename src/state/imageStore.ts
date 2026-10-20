/** The loaded image (pixels + colour metadata) and the decode lifecycle. */
import { create } from 'zustand';
import { decodeFile, type DecodeJob } from '../io/decode/decodeClient';
import type { CameraInfo, FloatImage, ImageColor, SourceFormat } from '../io/decode/types';
import type { ExifBlocks } from '../io/metadata/exif';
import { asShotTempTint } from '../pipeline/derive';
import type { ImageModel } from '../pipeline/types';
import { defaultRecipe, defaultsForSource } from '../recipe/schema';
import { loadDoc, useEdit } from './editStore';
import { startAnalysis } from '../app/analysis';

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
  loading: { fraction: number; label: string; fileName: string } | null;
  error: string | null;
  load(file: File, proxyLongEdge: number): Promise<void>;
  cancel(): void;
  clearError(): void;
}

let job: DecodeJob | null = null;
let nextId = 1;

export const useImage = create<ImageState>((set, get) => ({
  image: null,
  loading: null,
  error: null,
  async load(file, proxyLongEdge) {
    job?.cancel();
    set({ loading: { fraction: 0, label: 'Starting', fileName: file.name }, error: null });
    const current = decodeFile(file, proxyLongEdge, (fraction, label) => {
      if (get().loading) set({ loading: { fraction, label, fileName: file.name } });
    });
    job = current;
    // The photo's saved history (if it was edited before) loads while it decodes.
    const docPromise = loadDoc(photoKey(file)).catch(() => null);
    try {
      const { result, exif } = await current.promise;
      if (job !== current) return;
      const model: ImageModel = {
        isRaw: result.isRaw,
        bitDepth: result.bitDepth,
        color: result.color,
        width: result.full.width,
        height: result.full.height,
        key: photoKey(file),
        focal35: result.info.focal35,
        lens: result.lens ?? null,
        analysis: {},
      };
      const asShot = asShotTempTint(model);
      const image: LoadedImage = {
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
        asShot,
      };
      const r = defaultsForSource(result.isRaw);
      r.whiteBalance.temperature = asShot.temperature;
      r.whiteBalance.tint = asShot.tint;
      useEdit.getState().openDoc(model.key, file.name, r, await docPromise);
      set({ image, loading: null });
      startAnalysis(image);
      for (const w of result.warnings) console.info(`[optic] ${w}`);
    } catch (e) {
      if (job !== current) return;
      const err = e as Error;
      if (err.name === 'AbortError') set({ loading: null });
      else {
        console.warn('[optic] decode failed', err);
        set({ loading: null, error: err.message || String(err) });
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
  clearError: () => set({ error: null }),
}));

/** Stable identity of a file across sessions (history, snapshots and grain seed key on it). */
export function photoKey(file: File) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** Defaults for this image: source-type defaults with As Shot white balance filled in. */
export function defaultRecipeFor(img: LoadedImage | null) {
  const r = img ? defaultsForSource(img.isRaw) : defaultRecipe();
  if (img) {
    r.whiteBalance.temperature = img.asShot.temperature;
    r.whiteBalance.tint = img.asShot.tint;
  }
  return r;
}
