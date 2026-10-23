import { describe, expect, it } from 'vitest';
import { applyPreset, removePreset, setPresetAmount } from '../../src/presets/apply';
import type { Preset } from '../../src/presets/types';
import { MAX_COMPONENTS, MAX_MASKS, newComponent, newMask, parseMasks } from '../../src/recipe/masks';
import { PRESET_GROUPS, RECIPE_VERSION, defaultRecipe, getGroup, setGroup } from '../../src/recipe/schema';
import { deserializeRecipe, migrate, serializeRecipe } from '../../src/recipe/serialize';
import { describeChange } from '../../src/state/describe';

/** A v1 recipe as Phase 1 stored it (no Phase 2–4 groups). */
const V1 = {
  version: 1,
  whiteBalance: { enabled: true, mode: 'custom', temperature: 5200, tint: 4 },
  light: { enabled: true, exposure: 0.35, contrast: 12, highlights: -20, shadows: 15, whites: 0, blacks: -3 },
  hsl: { enabled: true, bands: { red: { hue: 5, sat: 10, lum: 0 } } },
  curve: { enabled: true, rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.56 }, { x: 1, y: 1 }] },
  presence: { enabled: true, vibrance: 20, saturation: -5 },
  output: { colorSpace: 'srgb' },
};

describe('recipe migrations', () => {
  it('is at version 4', () => expect(RECIPE_VERSION).toBe(4));

  it('migrates v1 step by step to the current version, keeping every v1 value', () => {
    const r = deserializeRecipe(V1);
    expect(r.version).toBe(RECIPE_VERSION);
    expect(r.light.exposure).toBe(0.35);
    expect(r.light.highlights).toBe(-20);
    expect(r.whiteBalance.temperature).toBe(5200);
    expect(r.hsl.bands.red).toEqual({ hue: 5, sat: 10, lum: 0 });
    expect(r.curve.rgb).toHaveLength(3);
    expect(r.output.colorSpace).toBe('srgb');
  });

  it('gives every later group its identity default (renders as before)', () => {
    const r = deserializeRecipe(V1);
    const d = defaultRecipe();
    for (const k of ['look', 'colorGrading', 'calibration', 'lut', 'detail', 'effects', 'lens', 'geometry', 'crop'] as const) expect(r[k]).toEqual(d[k]);
    expect(r.treatment).toBe('color');
    expect(r.appliedPreset).toBeNull();
    expect(r.masks).toEqual([]);
  });

  it('migrates v2 and v3 by adding only defaults', () => {
    const v3 = { ...JSON.parse(serializeRecipe(defaultRecipe())), version: 3 };
    delete v3.masks;
    v3.effects.grain.amount = 30;
    const m = migrate(v3);
    expect(m.version).toBe(4);
    expect(m.masks).toEqual([]);
    const r = deserializeRecipe(v3);
    expect(r.effects.grain.amount).toBe(30);
    const v2 = { ...v3, version: 2 };
    delete v2.detail; delete v2.effects; delete v2.lens; delete v2.geometry; delete v2.crop;
    const r2 = deserializeRecipe(v2);
    expect(r2.detail).toEqual(defaultRecipe().detail);
    expect(r2.crop).toEqual(defaultRecipe().crop);
  });

  it('rejects recipes from a newer version', () => {
    expect(() => deserializeRecipe({ version: RECIPE_VERSION + 1 })).toThrow(/newer/);
  });

  it('round-trips a v4 recipe with masks', () => {
    const r = defaultRecipe();
    r.masks = [newMask('Sky', [newComponent('aiSky'), newComponent('lumRange', 'intersect', { lo: 50, hi: 100 })], { exposure: -0.7 })];
    const back = deserializeRecipe(serializeRecipe(r));
    expect(back).toEqual(r);
  });

  it('parses masks tolerantly and clamps values', () => {
    const masks = parseMasks([
      { name: 'x', amount: 999, components: [{ type: 'radial', op: 'weird', params: { feather: 400, rx: -3 } }, { type: 'nonsense' }], adjustments: { exposure: 12, noise: -50 } },
    ]);
    expect(masks).toHaveLength(1);
    expect(masks[0].amount).toBe(200);
    expect(masks[0].components).toHaveLength(1);
    expect(masks[0].components[0].op).toBe('add');
    expect((masks[0].components[0].params as { feather: number }).feather).toBe(100);
    expect(masks[0].adjustments.exposure).toBe(4);
    expect(masks[0].adjustments.noise).toBe(0);
  });

  it('caps masks and components', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `m${i}`, components: [{ type: 'linear' }, { type: 'radial' }, { type: 'lumRange' }] }));
    const masks = parseMasks(many);
    expect(masks.length).toBeLessThanOrEqual(MAX_MASKS);
    expect(masks.reduce((s, m) => s + m.components.length, 0)).toBeLessThanOrEqual(MAX_COMPONENTS);
  });
});

describe('preset groups', () => {
  it('has a masks group that copies masks', () => {
    expect(PRESET_GROUPS).toContain('masks');
    const a = defaultRecipe();
    a.masks = [newMask('m', [newComponent('linear')], { exposure: 1 })];
    const b = setGroup(defaultRecipe(), 'masks', getGroup(a, 'masks'));
    expect(b.masks).toEqual(a.masks);
    expect(b.masks).not.toBe(a.masks);
  });

  it('applies a preset at 0 % as the identity and 100 % as the target', () => {
    const p: Preset = { id: 'p', name: 'P', group: 'Test', version: 3, includes: ['light'], settings: { light: { contrast: 40, highlights: -30 } } } as unknown as Preset;
    const base = defaultRecipe();
    const at0 = applyPreset(base, p, true, 0);
    expect(at0.light).toEqual(base.light);
    const at100 = applyPreset(base, p, true, 100);
    expect(at100.light.contrast).toBe(40);
    const half = setPresetAmount(at100, 50);
    expect(half.light.contrast).toBeCloseTo(20, 5);
    expect(removePreset(half).light).toEqual(base.light);
  });
});

describe('history labels', () => {
  it('names mask edits', () => {
    const a = defaultRecipe();
    const m = newMask('Sky', [newComponent('aiSky')]);
    const b = { ...a, masks: [m] };
    expect(describeChange(a, b).label).toBe('New mask: Sky');
    const c = { ...b, masks: [{ ...m, adjustments: { ...m.adjustments, exposure: -0.5 } }] };
    expect(describeChange(b, c).label).toBe('Sky: Exposure -0.50');
  });
});
