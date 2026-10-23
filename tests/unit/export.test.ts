import { describe, expect, it } from 'vitest';
import { computeGeo } from '../../src/geometry/transform';
import { applyTemplate, outputSize } from '../../src/io/encode/exportSettings';
import { resampleU16 } from '../../src/io/encode/exportRender';
import { cropCenter } from '../../src/io/encode/postprocess';
import { defaultRecipe } from '../../src/recipe/schema';
import { readZip, writeZip } from '../../src/storage/zip';

const img = { width: 8064, height: 6048 }; // 48 MP

describe('export dimensions', () => {
  it('exports the full resolution by default', () => {
    const g = computeGeo(img, defaultRecipe());
    expect([g.outW, g.outH]).toEqual([8064, 6048]);
    expect(outputSize(g.outW, g.outH, { mode: 'original' })).toMatchObject({ width: 8064, height: 6048 });
  });

  it('exports a crop at its exact pixel size', () => {
    const r = defaultRecipe();
    r.crop = { ...r.crop, x: 0.1, y: 0.2, w: 0.5, h: 0.25 };
    const g = computeGeo(img, r);
    expect([g.outW, g.outH]).toEqual([4032, 1512]);
  });

  it('swaps dimensions for quarter turns', () => {
    const r = defaultRecipe();
    r.crop = { ...r.crop, rotate90: 1 };
    const g = computeGeo(img, r);
    expect([g.outW, g.outH]).toEqual([6048, 8064]);
  });

  it('resizes by long edge, short edge, megapixels and percent without enlarging', () => {
    expect(outputSize(8064, 6048, { mode: 'longEdge', px: 2048 })).toMatchObject({ width: 2048, height: 1536 });
    expect(outputSize(8064, 6048, { mode: 'shortEdge', px: 1080 })).toMatchObject({ width: 1440, height: 1080 });
    const mp = outputSize(8064, 6048, { mode: 'megapixels', mp: 12 });
    expect((mp.width * mp.height) / 1e6).toBeCloseTo(12, 1);
    expect(outputSize(8064, 6048, { mode: 'percent', pct: 25 })).toMatchObject({ width: 2016, height: 1512 });
    expect(outputSize(1000, 800, { mode: 'longEdge', px: 4000 })).toMatchObject({ width: 1000, height: 800 });
    expect(outputSize(1000, 800, { mode: 'longEdge', px: 4000 }, true)).toMatchObject({ width: 4000, height: 3200 });
  });

  it('crops to an exact aspect (Instagram 4:5) then resizes', () => {
    const s = outputSize(8064, 6048, { mode: 'exact', width: 1080, height: 1350 });
    expect(s).toEqual({ width: 1080, height: 1350, cropW: 4838, cropH: 6048 });
    const small = outputSize(1600, 1200, { mode: 'exact', width: 1080, height: 1350 });
    expect([small.width, small.height]).toEqual([960, 1200]);
  });

  it('area-resamples 16-bit pixels and centre-crops', () => {
    const W = 4, H = 2;
    const src = new Uint16Array(W * H * 3);
    for (let i = 0; i < W * H; i++) src.fill(i < 4 ? 1000 : 3000, i * 3, i * 3 + 3);
    const half = resampleU16(src, W, H, 2, 1);
    expect(Array.from(half)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    const c = cropCenter(src, W, H, 2, 2);
    expect(c.length).toBe(12);
  });
});

describe('file-name templates', () => {
  const tokens = { filename: 'IMG_7040.DNG', date: new Date(2026, 9, 23, 14, 5, 9).getTime(), seq: 7, preset: 'Web 2048px', rating: 4, camera: 'iPhone 16 Pro Max', custom: 'Trip', copy: '' };
  it('fills every token', () => {
    expect(applyTemplate('{date:YYYY-MM-DD}_{seq:001}_{filename}', tokens)).toBe('2026-10-23_007_IMG_7040');
    expect(applyTemplate('{custom} {rating}★ {camera} {preset}', tokens)).toBe('Trip 4★ iPhone 16 Pro Max Web 2048px');
    expect(applyTemplate('{date:YYYYMMDD-HHmmss}', tokens)).toBe('20261023-140509');
  });
  it('replaces characters that are invalid in file names', () => {
    expect(applyTemplate('{custom}', { ...tokens, custom: 'a/b:c*?' })).toBe('a_b_c_');
  });
});

describe('zip', () => {
  it('round-trips stored entries', async () => {
    const files = [{ name: 'a.json', data: new TextEncoder().encode('{"x":1}') }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3, 255]) }];
    const back = await readZip(writeZip(files));
    expect(back.map((f) => f.name)).toEqual(['a.json', 'dir/b.bin']);
    expect(Array.from(back[1].data)).toEqual([1, 2, 3, 255]);
  });
});
