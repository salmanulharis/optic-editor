/**
 * DNG opcode lists (OpcodeList1/2/3): the lens corrections a camera or phone embeds in the file.
 * We read the three that describe the lens and leave the rest (bad pixels, etc.) to the decoder:
 *  - WarpRectilinear (1): distortion and lateral CA, per colour plane.
 *  - FixVignetteRadial (3): a radial vignetting gain.
 *  - GainMap (9): a spatially varying gain (lens shading), per plane or per CFA phase.
 * Opcode data is always big-endian, whatever the TIFF byte order.
 */
import type { DngVignette, DngWarp, GainMap, LensProfile } from '../../geometry/lens';
import type { Ifd, TiffReader } from '../metadata/tiffReader';

const TAG_OPCODE_LISTS = [51008, 51009, 51022];
const TAG_CFA_REPEAT = 33421;
const TAG_CFA_PATTERN = 33422;

interface RawGainMap extends Omit<GainMap, 'planes' | 'data'> {
  plane: number;
  planes: number;
  rowPitch: number;
  colPitch: number;
  mapPlanes: number;
  data: Float32Array;
}

function parseList(bytes: Uint8Array): { warp?: DngWarp; vignette?: DngVignette; gains: RawGainMap[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { warp?: DngWarp; vignette?: DngVignette; gains: RawGainMap[] } = { gains: [] };
  const n = dv.getUint32(0);
  let p = 4;
  for (let i = 0; i < n && p + 16 <= bytes.length; i++) {
    const id = dv.getUint32(p), len = dv.getUint32(p + 12);
    const q = p + 16;
    p = q + len;
    if (p > bytes.length) break;
    if (id === 1) {
      const planes = dv.getUint32(q);
      const list: DngWarp['planes'] = [];
      for (let k = 0; k < planes; k++) {
        const d = (j: number) => dv.getFloat64(q + 4 + (k * 6 + j) * 8);
        list.push({ kr: [d(0), d(1), d(2), d(3)], kt: [d(4), d(5)] });
      }
      const c = q + 4 + planes * 48;
      out.warp = { planes: list, cx: dv.getFloat64(c), cy: dv.getFloat64(c + 8) };
    } else if (id === 3) {
      const d = (j: number) => dv.getFloat64(q + j * 8);
      out.vignette = { k: [d(0), d(1), d(2), d(3), d(4)], cx: d(5), cy: d(6) };
    } else if (id === 9) {
      const u = (j: number) => dv.getUint32(q + j * 4);
      const f = (j: number) => dv.getFloat64(q + 40 + j * 8);
      const pointsV = u(8), pointsH = u(9), mapPlanes = dv.getUint32(q + 72);
      const count = pointsV * pointsH * mapPlanes;
      if (!count || q + 76 + count * 4 > p) continue;
      const data = new Float32Array(count);
      for (let k = 0; k < count; k++) data[k] = dv.getFloat32(q + 76 + k * 4);
      out.gains.push({
        top: u(0), left: u(1), bottom: u(2), right: u(3), plane: u(4), planes: u(5), rowPitch: u(6), colPitch: u(7),
        pointsV, pointsH, spacingV: f(0), spacingH: f(1), originV: f(2), originH: f(3), mapPlanes, data,
      });
    }
  }
  return out;
}

const sameGrid = (a: RawGainMap, b: RawGainMap) =>
  a.pointsV === b.pointsV && a.pointsH === b.pointsH && a.spacingV === b.spacingV && a.spacingH === b.spacingH &&
  Math.abs(a.originV - b.originV) < 1e-9 && Math.abs(a.originH - b.originH) < 1e-9;

/** Merge the file's gain maps into one map with 1 or 3 (R, G, B) planes. */
function mergeGains(gains: RawGainMap[], cfa: number[] | null): GainMap | undefined {
  if (!gains.length) return undefined;
  const g0 = gains[0];
  const base = {
    top: Math.min(...gains.map((g) => g.top)), left: Math.min(...gains.map((g) => g.left)),
    bottom: Math.max(...gains.map((g) => g.bottom)), right: Math.max(...gains.map((g) => g.right)),
    pointsV: g0.pointsV, pointsH: g0.pointsH, spacingV: g0.spacingV, spacingH: g0.spacingH, originV: g0.originV, originH: g0.originH,
  };
  const n = g0.pointsV * g0.pointsH;
  // One map carrying all three planes.
  if (gains.length === 1 && g0.mapPlanes >= 3) {
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = g0.data[i * g0.mapPlanes + c];
    return { ...base, planes: 3, data };
  }
  const grid = gains.filter((g) => sameGrid(g, g0) && g.mapPlanes === 1);
  const rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const cnt = [0, 0, 0];
  const add = (c: number, g: RawGainMap) => { for (let i = 0; i < n; i++) rgb[c][i] += g.data[i]; cnt[c]++; };
  const cfaMaps = grid.filter((g) => g.rowPitch === 2 && g.colPitch === 2);
  if (cfaMaps.length >= 3 && cfa && cfa.length === 4) {
    // Bayer phases: the map's top/left parity selects the CFA position, CFAPattern its colour.
    for (const g of cfaMaps) {
      const colour = cfa[(g.top & 1) * 2 + (g.left & 1)];
      if (colour <= 2) add(colour, g);
    }
  } else if (grid.length >= 3 && new Set(grid.map((g) => g.plane)).size >= 3) {
    for (const g of grid) if (g.plane <= 2) add(g.plane, g);
  }
  if (cnt.every((c) => c > 0)) {
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = rgb[c][i] / cnt[c];
    return { ...base, planes: 3, data };
  }
  // Fall back to a single grey map (all channels).
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = g0.data[i * g0.mapPlanes];
  return { ...base, top: g0.top, left: g0.left, bottom: g0.bottom, right: g0.right, planes: 1, data: mono };
}

/**
 * Read the lens profile from a DNG's opcode lists (main raw IFD first, then IFD0).
 * `sWidth/sHeight` is the decoded, oriented image size; opcode coordinates are in the
 * pre-orientation image of the same size.
 */
export function dngLensProfile(r: TiffReader, mainIfd: Ifd | null, orientation: number, sWidth: number, sHeight: number, name: string): LensProfile | null {
  const swap = orientation >= 5;
  const rawW = swap ? sHeight : sWidth, rawH = swap ? sWidth : sHeight;
  let warp: DngWarp | undefined, vignette: DngVignette | undefined;
  const gains: RawGainMap[] = [];
  for (const ifd of [mainIfd, r.ifds[0]]) {
    if (!ifd) continue;
    for (const tag of TAG_OPCODE_LISTS) {
      const bytes = r.raw(ifd, tag);
      if (!bytes || bytes.length < 4) continue;
      try {
        const res = parseList(bytes);
        warp ??= res.warp;
        vignette ??= res.vignette;
        if (!gains.length) gains.push(...res.gains);
      } catch (e) {
        console.warn('[optic] unreadable DNG opcode list', tag, e);
      }
    }
    if (warp || vignette || gains.length) break;
  }
  if (!warp && !vignette && !gains.length) return null;
  const dims = mainIfd ? r.get(mainIfd, TAG_CFA_REPEAT) : undefined;
  const pat = mainIfd ? r.get(mainIfd, TAG_CFA_PATTERN) : undefined;
  const cfa = dims && dims[0] === 2 && dims[1] === 2 && pat && pat.length === 4 ? pat : null;
  // Identity warps (some files carry one) are dropped so they cost nothing.
  if (warp && warp.planes.every((p) => p.kr[0] === 1 && !p.kr[1] && !p.kr[2] && !p.kr[3] && !p.kt[0] && !p.kt[1])) warp = undefined;
  if (vignette && vignette.k.every((k) => k === 0)) vignette = undefined;
  if (!warp && !vignette && !gains.length) return null;
  return { source: 'dng', name, rawW, rawH, orientation, warp, vignette, gainMap: mergeGains(gains, cfa) };
}
