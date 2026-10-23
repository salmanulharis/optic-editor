/**
 * Export settings and export presets: format, colour space, size, output sharpening, metadata,
 * file-name template, watermark and author / copyright. Shared by single and batch export.
 */
import type { ColorSpaceId } from '../../color/matrices';
import type { MetadataMode } from '../metadata/exif';

export type ExportFormat = 'tiff' | 'jpeg' | 'png' | 'avif' | 'jxl';

export type ExportSize =
  | { mode: 'original' }
  | { mode: 'longEdge'; px: number }
  | { mode: 'shortEdge'; px: number }
  | { mode: 'megapixels'; mp: number }
  | { mode: 'percent'; pct: number }
  /** Exactly W × H: centre-cropped to that aspect ratio, then resized (social formats). */
  | { mode: 'exact'; width: number; height: number };

export type SharpenTarget = 'none' | 'screen' | 'matte' | 'glossy';
export type SharpenAmount = 'low' | 'standard' | 'high';
export type WatermarkPosition = 'tl' | 'tc' | 'tr' | 'cl' | 'c' | 'cr' | 'bl' | 'bc' | 'br';

export interface Watermark {
  enabled: boolean;
  kind: 'text' | 'image';
  text: string;
  /** PNG bytes (image watermark). */
  image: Uint8Array | null;
  imageName: string;
  position: WatermarkPosition;
  /** Width (image) or text height × 8 as a percentage of the output's long edge. */
  size: number;
  opacity: number; // 0…100
  margin: number; // % of the long edge
  color: 'white' | 'black';
}

export interface ExportSettings {
  format: ExportFormat;
  quality: number;
  colorSpace: ColorSpaceId;
  size: ExportSize;
  /** Upscaling is never done unless allowed. */
  allowUpscale: boolean;
  metadata: MetadataMode;
  tiffCompression: 'deflate' | 'none';
  sharpen: { target: SharpenTarget; amount: SharpenAmount };
  watermark: Watermark;
  author: { artist: string; copyright: string };
  dpi: number;
  fileName: string;
  /** Also write the recipe as `<name>.optic.json` next to the image. */
  sidecar: boolean;
}

export const EXPORT_SPACES: ColorSpaceId[] = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto'];

export const EXT: Record<ExportFormat, string> = { tiff: 'tif', jpeg: 'jpg', png: 'png', avif: 'avif', jxl: 'jxl' };
export const MIME: Record<ExportFormat, string> = { tiff: 'image/tiff', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif', jxl: 'image/jxl' };
export const FORMAT_LABEL: Record<ExportFormat, string> = { tiff: 'TIFF 16-bit', jpeg: 'JPEG', png: 'PNG 16-bit', avif: 'AVIF 10-bit', jxl: 'JPEG XL' };

/** What each format can carry with the encoders available in the browser. */
export const FORMAT_CAPS: Record<ExportFormat, { quality: boolean; spaces: ColorSpaceId[]; metadata: boolean }> = {
  tiff: { quality: false, spaces: EXPORT_SPACES, metadata: true },
  jpeg: { quality: true, spaces: EXPORT_SPACES, metadata: true },
  png: { quality: false, spaces: EXPORT_SPACES, metadata: true },
  // The AVIF / JPEG XL encoders write neither ICC profiles nor EXIF: sRGB only, no metadata.
  avif: { quality: true, spaces: ['srgb'], metadata: false },
  jxl: { quality: true, spaces: ['srgb'], metadata: false },
};

export const NO_WATERMARK: Watermark = { enabled: false, kind: 'text', text: '© ', image: null, imageName: '', position: 'br', size: 3, opacity: 70, margin: 2, color: 'white' };

export function baseSettings(): ExportSettings {
  return {
    format: 'jpeg',
    quality: 92,
    colorSpace: 'srgb',
    size: { mode: 'original' },
    allowUpscale: false,
    metadata: 'keep',
    tiffCompression: 'deflate',
    sharpen: { target: 'none', amount: 'standard' },
    watermark: { ...NO_WATERMARK },
    author: { artist: '', copyright: '' },
    dpi: 300,
    fileName: '{filename}',
    sidecar: false,
  };
}

export interface ExportPreset {
  id: string;
  name: string;
  builtin?: boolean;
  settings: ExportSettings;
}

const preset = (id: string, name: string, p: Partial<ExportSettings>): ExportPreset => ({ id, name, builtin: true, settings: { ...baseSettings(), ...p } });

export const BUILTIN_EXPORT_PRESETS: ExportPreset[] = [
  preset('full-tiff', 'Full quality TIFF', { format: 'tiff', colorSpace: 'display-p3', fileName: '{filename}' }),
  preset('full-jpeg', 'Full quality JPEG', { format: 'jpeg', quality: 95, colorSpace: 'display-p3', fileName: '{filename}' }),
  preset('ig-45', 'Instagram 4:5 (1080×1350, sRGB)', {
    format: 'jpeg', quality: 90, colorSpace: 'srgb', size: { mode: 'exact', width: 1080, height: 1350 },
    sharpen: { target: 'screen', amount: 'standard' }, metadata: 'copyright', fileName: '{filename}_ig',
  }),
  preset('ig-2160', 'Instagram portrait 2160px', {
    format: 'jpeg', quality: 90, colorSpace: 'srgb', size: { mode: 'longEdge', px: 2160 },
    sharpen: { target: 'screen', amount: 'standard' }, metadata: 'copyright', fileName: '{filename}_ig2160',
  }),
  preset('web-2048', 'Web 2048px', {
    format: 'jpeg', quality: 85, colorSpace: 'srgb', size: { mode: 'longEdge', px: 2048 },
    sharpen: { target: 'screen', amount: 'standard' }, metadata: 'stripGps', fileName: '{filename}_web',
  }),
  preset('print-300', 'Print 300dpi TIFF', {
    format: 'tiff', colorSpace: 'adobe-rgb', sharpen: { target: 'matte', amount: 'standard' }, dpi: 300, fileName: '{filename}_print',
  }),
];

/** Output pixel size for a rendered W × H. */
export function outputSize(w: number, h: number, s: ExportSize, allowUpscale = false): { width: number; height: number; cropW: number; cropH: number } {
  let cropW = w, cropH = h;
  let k = 1;
  switch (s.mode) {
    case 'longEdge': k = s.px / Math.max(w, h); break;
    case 'shortEdge': k = s.px / Math.min(w, h); break;
    case 'megapixels': k = Math.sqrt((s.mp * 1e6) / (w * h)); break;
    case 'percent': k = s.pct / 100; break;
    case 'exact': {
      const a = s.width / s.height;
      if (w / h > a) cropW = Math.round(h * a); else cropH = Math.round(w / a);
      k = s.width / cropW;
      if (!allowUpscale && k > 1) {
        // Smaller than the target: keep the crop's own size (no upscaling).
        return { width: cropW, height: cropH, cropW, cropH };
      }
      return { width: s.width, height: s.height, cropW, cropH };
    }
  }
  if (!allowUpscale) k = Math.min(1, k);
  return { width: Math.max(1, Math.round(cropW * k)), height: Math.max(1, Math.round(cropH * k)), cropW, cropH };
}

export interface NameTokens {
  filename: string;
  date: number;
  seq: number;
  preset: string;
  rating: number;
  camera: string;
  custom: string;
  copy?: string;
}

/**
 * File name from a template: {filename} {date:YYYY-MM-DD} {seq:001} {preset} {rating} {camera}
 * {custom} {copy}. Characters that are invalid in file names are replaced.
 */
export function applyTemplate(template: string, t: NameTokens): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const d = new Date(t.date || Date.now());
  const date = (fmt: string) => fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, String(d.getFullYear()).slice(2))
    .replace(/MM/g, pad(d.getMonth() + 1, 2))
    .replace(/DD/g, pad(d.getDate(), 2))
    .replace(/HH/g, pad(d.getHours(), 2))
    .replace(/mm/g, pad(d.getMinutes(), 2))
    .replace(/ss/g, pad(d.getSeconds(), 2));
  const out = (template || '{filename}').replace(/\{(\w+)(?::([^}]*))?\}/g, (_m, name: string, arg?: string) => {
    switch (name) {
      case 'filename': return t.filename.replace(/\.[^.]+$/, '');
      case 'date': return date(arg || 'YYYY-MM-DD');
      case 'seq': return pad(t.seq, Math.max(1, (arg || '001').length));
      case 'preset': return t.preset;
      case 'rating': return String(t.rating);
      case 'camera': return t.camera;
      case 'custom': return t.custom;
      case 'copy': return t.copy ?? '';
      default: return '';
    }
  });
  return out.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim() || 'export';
}

/** The default single-photo export name: "IMG_7040_optic.jpg" (virtual copies: "IMG_7040 (B&W)_optic.jpg"). */
export function exportFileName(original: string, format: ExportFormat, copyName = '') {
  const base = original.replace(/\.[^.]+$/, '');
  return `${copyName ? `${base} (${copyName})` : base}_optic.${EXT[format]}`;
}

/** Settings as stored (watermark image bytes included); tolerant of older or partial objects. */
export function normalizeSettings(s: Partial<ExportSettings> | undefined): ExportSettings {
  const b = baseSettings();
  if (!s) return b;
  return {
    ...b,
    ...s,
    sharpen: { ...b.sharpen, ...(s.sharpen ?? {}) },
    watermark: { ...b.watermark, ...(s.watermark ?? {}) },
    author: { ...b.author, ...(s.author ?? {}) },
  };
}
