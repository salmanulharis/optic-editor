import type { ColorSpaceId, Mat3 } from '../../color/matrices';
import type { RawColorProfile } from '../../color/whiteBalance';
import type { LensProfile } from '../../geometry/lens';

export type SourceFormat = 'dng' | 'raw' | 'heic' | 'jpeg' | 'png' | 'tiff' | 'webp' | 'avif';

/** Interleaved RGB, scene/display linear, 32-bit float. */
export interface FloatImage {
  width: number;
  height: number;
  data: Float32Array;
}

export type ImageColor =
  | { kind: 'raw'; profile: RawColorProfile }
  | {
      kind: 'display';
      /** Source linear RGB → XYZ (D65-referenced). */
      toXYZ: Mat3;
      /** Recognised standard space, if any (drives the default export space). */
      spaceId: ColorSpaceId | null;
      spaceLabel: string;
    };

export interface CameraInfo {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  /** Seconds. */
  shutter?: number;
  aperture?: number;
  focalLength?: number;
  /** 35 mm-equivalent focal length. */
  focal35?: number;
  date?: string;
}

export interface DecodeResult {
  format: SourceFormat;
  isRaw: boolean;
  /** Bits per channel of the source data (8, 10, 12, 14, 16, 32). */
  bitDepth: number;
  /** Oriented, full-resolution pixels. Backed by a SharedArrayBuffer when cross-origin isolated. */
  full: FloatImage;
  /** Preview proxy (area-downsampled). */
  proxy: FloatImage;
  /** Small analysis thumbnail for auto tools (≤ 384 px). */
  thumb: FloatImage;
  color: ImageColor;
  info: CameraInfo;
  /** Human-readable decoder path, e.g. "LibRaw" or "DNG + JPEG XL tiles". */
  decoder: string;
  warnings: string[];
  /** Lens corrections embedded in the file (DNG opcode lists). */
  lens?: LensProfile | null;
}

export interface DecodeOptions {
  /** Long edge of the preview proxy. */
  proxyLongEdge: number;
}

export type ProgressFn = (fraction: number, label: string) => void;
