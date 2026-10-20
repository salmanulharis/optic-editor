import type { ColorSpaceId } from '../../color/matrices';
import type { MetadataMode } from '../metadata/exif';

export type ExportFormat = 'tiff' | 'jpeg' | 'png';
export type ExportSize = { mode: 'original' } | { mode: 'longEdge'; px: number } | { mode: 'percent'; pct: number };

export interface ExportSettings {
  format: ExportFormat;
  quality: number;
  colorSpace: ColorSpaceId;
  size: ExportSize;
  metadata: MetadataMode;
  tiffCompression: 'deflate' | 'none';
}

export const EXPORT_SPACES: ColorSpaceId[] = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto'];

export const EXT: Record<ExportFormat, string> = { tiff: 'tif', jpeg: 'jpg', png: 'png' };
export const MIME: Record<ExportFormat, string> = { tiff: 'image/tiff', jpeg: 'image/jpeg', png: 'image/png' };

export function outputSize(w: number, h: number, s: ExportSize): { width: number; height: number } {
  let k = 1;
  if (s.mode === 'longEdge') k = Math.min(1, s.px / Math.max(w, h));
  if (s.mode === 'percent') k = Math.min(1, s.pct / 100);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export function exportFileName(original: string, format: ExportFormat) {
  const base = original.replace(/\.[^.]+$/, '');
  return `${base}_optic.${EXT[format]}`;
}
