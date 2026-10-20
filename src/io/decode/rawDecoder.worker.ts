/**
 * RAW decode worker: DNG (incl. Apple ProRAW), CR2/CR3, NEF, ARW, RAF, RW2, ORF, …
 *
 * Output is linear *camera* RGB, 32-bit float, normalised so sensor saturation = 1.0, upright.
 * White balance, BaselineExposure and the camera matrix are NOT applied here: they are pipeline
 * stages driven by the recipe, so the user can change them without re-decoding.
 */
import * as Comlink from 'comlink';
import LibRaw from 'libraw-wasm';
import { TiffReader } from '../metadata/tiffReader';
import { COMPRESSION_JXL, TAG, dngColorProfile, isDng, isTiffLike, libRawColorProfile, mainImageIfd } from './dng';
import { decodeDngJxl } from './dngJxl';
import { dngLensProfile } from './dngOpcodes';
import type { LensProfile } from '../../geometry/lens';
import { allocFloat, applyOrientation, makeDerivatives } from './imageOps';
import type { CameraInfo, DecodeOptions, DecodeResult, FloatImage, ProgressFn } from './types';
import type { RawColorProfile } from '../../color/whiteBalance';

/**
 * LibRaw settings for camera RGB: no WB (unit multipliers), raw colour (no matrix), no
 * auto-brightening, 16-bit, true white level (no adjust_maximum), AHD demosaic.
 * Linear (already demosaiced) DNGs such as ProRAW skip demosaicing inside LibRaw automatically.
 *
 * NOTE: libraw-wasm ignores the `gamm` setting (verified: every value gives identical output), so
 * LibRaw always applies its default BT.709-style curve (power 0.45, toe slope 4.5). We undo it
 * exactly with `libRawGammaInverse` below to get back to scene-linear data.
 */
const LIBRAW_SETTINGS = {
  outputColor: 0,
  outputBps: 16,
  noAutoBright: true,
  useCameraWb: false,
  useAutoWb: false,
  userMul: [1, 1, 1, 1] as [number, number, number, number],
  highlight: 0,
  adjustMaximumThr: 0,
  userQual: 3, // AHD
  userFlip: -1,
};

/**
 * Inverse of LibRaw's gamma_curve(pwr, ts, mode 2): solve the curve's constants the same way
 * LibRaw does (bisection for a C1-continuous joint between the linear toe and the power segment),
 * then build a 16-bit code → linear LUT. With auto-bright off, code 65536 corresponds to white.
 */
function libRawGammaInverse(pwr = 0.45, ts = 4.5, maxCode = 65535): Float32Array {
  const g = [pwr, ts, 0, 0, 0];
  const bnd = [0, 0];
  bnd[g[1] >= 1 ? 1 : 0] = 1;
  if (g[1] && (g[1] - 1) * (g[0] - 1) <= 0) {
    for (let i = 0; i < 48; i++) {
      g[2] = (bnd[0] + bnd[1]) / 2;
      bnd[(Math.pow(g[2] / g[1], -g[0]) - 1) / g[0] - 1 / g[2] > -1 ? 1 : 0] = g[2];
    }
    g[3] = g[2] / g[1];
    g[4] = g[2] * (1 / g[0] - 1);
  }
  const lut = new Float32Array(maxCode + 1);
  for (let i = 0; i <= maxCode; i++) {
    const e = i / (maxCode + 1);
    lut[i] = e < g[2] ? e / g[1] : Math.pow((e + g[4]) / (1 + g[4]), 1 / g[0]);
  }
  return lut;
}

async function decodeWithLibRaw(bytes: Uint8Array, progress: ProgressFn) {
  const raw = new LibRaw();
  try {
    progress(0.08, 'Opening RAW');
    await raw.open(bytes.slice(), LIBRAW_SETTINGS);
    const meta = await raw.metadata(true);
    progress(0.25, 'Demosaicing');
    const img = await raw.imageData();
    if (!img || !meta) throw new Error('LibRaw returned no image');
    progress(0.75, 'Converting to float');
    const n = img.width * img.height;
    const out = allocFloat(n * 3);
    const src = img.data;
    const lut = libRawGammaInverse(0.45, 4.5, img.bits === 8 ? 255 : 65535);
    if (img.colors === 3) for (let i = 0; i < n * 3; i++) out[i] = lut[src[i]];
    else for (let i = 0; i < n; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = lut[src[i * img.colors]];
    return { image: { width: img.width, height: img.height, data: out } as FloatImage, meta };
  } finally {
    raw.dispose();
  }
}

const api = {
  async decode(bytes: Uint8Array, fileName: string, opts: DecodeOptions, onProgress: ProgressFn): Promise<DecodeResult> {
    const progress: ProgressFn = (f, l) => void onProgress(f, l);
    const warnings: string[] = [];
    let image: FloatImage;
    let profile: RawColorProfile | null = null;
    let info: CameraInfo = {};
    let decoder = 'LibRaw';
    let bitDepth = 14;
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

    let dng: TiffReader | null = null;
    if (isTiffLike(bytes)) {
      try {
        const r = new TiffReader(bytes);
        if (isDng(r)) dng = r;
      } catch { /* not a parseable TIFF container (e.g. some vendor RAWs) */ }
    }

    const mainIfd = dng ? mainImageIfd(dng) : null;
    const compression = dng && mainIfd ? dng.get(mainIfd, TAG.Compression)?.[0] : undefined;

    if (dng && mainIfd && compression === COMPRESSION_JXL) {
      decoder = 'DNG + JPEG XL tiles';
      progress(0.05, 'Reading DNG');
      image = await decodeDngJxl(dng, mainIfd, progress);
      const orientation = dng.get(dng.ifds[0], TAG.Orientation)?.[0] ?? 1;
      progress(0.86, 'Orienting');
      image = applyOrientation(image, orientation);
      bitDepth = dng.get(mainIfd, TAG.BitsPerSample)?.[0] ?? 16;
    } else {
      const { image: img, meta } = await decodeWithLibRaw(bytes, progress);
      image = img;
      info = {
        make: meta.camera_make || undefined,
        model: meta.camera_model || undefined,
        iso: meta.iso_speed || undefined,
        shutter: meta.shutter || undefined,
        aperture: meta.aperture || undefined,
        focalLength: meta.focal_len || undefined,
        lens: meta.lens?.Lens || undefined,
      };
      bitDepth = meta.color_data?.raw_bps || 14;
      if (!dng) {
        const c = meta.color_data;
        if (!c?.cam_xyz) throw new Error('This RAW file has no colour matrix LibRaw knows about');
        profile = libRawColorProfile(c.cam_xyz, c.cam_mul, c.pre_mul);
      }
    }

    let lens: LensProfile | null = null;
    if (dng) {
      profile = dngColorProfile(dng);
      if (mainIfd) bitDepth = dng.get(mainIfd, TAG.BitsPerSample)?.[0] ?? bitDepth;
      // LibRaw (without the DNG SDK) applies no opcodes, so the file's lens corrections are ours to do.
      const orientation = dng.get(dng.ifds[0], TAG.Orientation)?.[0] ?? 1;
      lens = dngLensProfile(dng, mainIfd, orientation, image.width, image.height, 'Lens corrections from file');
    }
    if (!profile) throw new Error('No colour profile');
    if (ext !== 'dng' && dng) warnings.push('File is a DNG with a non-.dng extension');

    progress(0.9, 'Building preview');
    const { proxy, thumb } = makeDerivatives(image, opts.proxyLongEdge);
    progress(1, 'Done');
    const result: DecodeResult = {
      format: dng ? 'dng' : 'raw',
      isRaw: true,
      bitDepth,
      full: image,
      proxy,
      thumb,
      color: { kind: 'raw', profile },
      info,
      decoder,
      warnings,
      lens,
    };
    // Shared buffers are visible to every thread already; only plain ArrayBuffers are transferred.
    const transfers = [image.data.buffer, proxy.data.buffer, thumb.data.buffer].filter((b): b is ArrayBuffer => !(b instanceof SharedArrayBuffer));
    return Comlink.transfer(result, transfers);
  },
};

export type RawDecoderApi = typeof api;
Comlink.expose(api);
