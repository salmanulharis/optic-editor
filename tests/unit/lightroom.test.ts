import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPreset } from '../../src/presets/apply';
import { adobeHueToOklch, convertCrs, parametricPoints, parseCurve } from '../../src/presets/lightroom/convert';
import { dngXmp } from '../../src/presets/lightroom/dng';
import {
  LIGHTROOM_GROUP,
  LightroomImportError,
  MAX_PRESET_BYTES,
  baseName,
  importLightroomFile,
} from '../../src/presets/lightroom/index';
import { readLrTemplate } from '../../src/presets/lightroom/lrtemplate';
import { decodeText, readXmpCrs } from '../../src/presets/lightroom/xmp';
import { workingToOklab } from '../../src/color/oklab';
import { WORKING_TO_XYZ, inv, mul, mulVec, toXYZ_D65 } from '../../src/color/matrices';
import { tempTintToRelative } from '../../src/color/whiteBalance';
import { ZipLimitError, readZip, writeZip } from '../../src/storage/zip';
import { defaultRecipe } from '../../src/recipe/schema';

const FIX = join(process.cwd(), 'tests', 'unit', 'fixtures', 'lightroom');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));
const enc = new TextEncoder();

/** A minimal little-endian TIFF/DNG whose IFD 0 holds only an XMLPacket (tag 700). */
function dngWithXmp(xmp: string | null): Uint8Array {
  const data = xmp ? enc.encode(xmp) : new Uint8Array(0);
  const entries = xmp ? 1 : 0;
  const ifdSize = 2 + entries * 12 + 4;
  const buf = new Uint8Array(8 + ifdSize + data.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0], 0);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries, true);
  if (xmp) {
    dv.setUint16(10, 700, true);
    dv.setUint16(12, 1, true);
    dv.setUint32(14, data.length, true);
    dv.setUint32(18, 8 + ifdSize, true);
  }
  buf.set(data, 8 + ifdSize);
  return buf;
}

const preset = (crsAttrs: string, body = '', type = 'Normal') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${type ? `crs:PresetType="${type}"` : ''} ${crsAttrs}>${body}</rdf:Description>
</rdf:RDF></x:xmpmeta>`;

const SRGB_TO_WORKING = mul(inv(WORKING_TO_XYZ), toXYZ_D65('srgb'));
const oklchHueOfSrgb = (rgb: [number, number, number]) => {
  const [, a, b] = workingToOklab(mulVec(SRGB_TO_WORKING, rgb));
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};

describe('XMP reader', () => {
  it('reads attributes, language alternatives, sequences and struct properties', () => {
    const crs = readXmpCrs(decodeText(fixture('moody-fade.xmp')));
    expect(crs.get('Contrast2012')).toBe('+15');
    expect(crs.get('Name')).toBe('Moody Fade'); // x-default, not the German alternative
    expect(crs.get('Group')).toBe('Test Pack');
    expect(crs.get('Copyright')).toBe('Synthetic test fixture & not a real pack');
    expect(crs.get('ToneCurvePV2012')).toEqual(['0, 20', '64, 60', '192, 200', '255, 245']);
    expect(crs.get('Look.Name')).toBe('Adobe Portrait');
    expect(crs.get('MaskGroupBasedCorrections')).toHaveLength(1);
  });

  it('never lets values nested in structs (masks, profile parameters) leak into the top level', () => {
    const crs = readXmpCrs(decodeText(fixture('moody-fade.xmp')));
    expect(crs.get('Exposure2012')).toBe('+0.30'); // not the profile's +9.99
    expect(crs.get('Contrast2012')).toBe('+15'); // not the mask's +99
    expect(crs.has('LocalExposure2012')).toBe(false);
  });

  it('reads element-form values, single quotes, entities and UTF-16 files', () => {
    const xmp = preset(`crs:Vibrance='+12'`, '<crs:Saturation>-7</crs:Saturation><crs:Name><rdf:Alt><rdf:li xml:lang="x-default">A &lt;b&gt; &#x263A;</rdf:li></rdf:Alt></crs:Name>');
    const utf16 = new Uint8Array(2 + xmp.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < xmp.length; i++) { utf16[2 + i * 2] = xmp.charCodeAt(i) & 0xff; utf16[3 + i * 2] = xmp.charCodeAt(i) >> 8; }
    for (const text of [xmp, decodeText(utf16)]) {
      const crs = readXmpCrs(text);
      expect(crs.get('Vibrance')).toBe('+12');
      expect(crs.get('Saturation')).toBe('-7');
      expect(crs.get('Name')).toBe('A <b> ☺');
    }
  });

  it('returns nothing for XMP without Camera Raw settings', () => {
    expect(readXmpCrs('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"/></rdf:RDF></x:xmpmeta>').size).toBe(0);
  });
});

describe('.lrtemplate reader', () => {
  it('parses the Lua table, the ZSTR title and flat tone curves', () => {
    const t = readLrTemplate(decodeText(fixture('warm-matte.lrtemplate')));
    expect(t.title).toBe('Warm Matte');
    expect(t.type).toBe('Develop');
    expect(t.uuid).toBe('0A6F3D2C9B8E4F1A8C7D6E5F4A3B2C1D');
    expect(t.settings.get('Contrast2012')).toBe('-20');
    expect(t.settings.get('ToneCurvePV2012')).toEqual(['0, 0', '255, 255']);
  });

  it('handles bracketed keys, long strings, escapes and comments; rejects code', () => {
    const t = readLrTemplate('s = { title = "A \\"q\\"", value = { settings = { ["Clarity2012"] = 7, Note = [[x]], --[[ c ]] Dehaze = -3; } } }');
    expect(t.title).toBe('A "q"');
    expect(t.settings.get('Clarity2012')).toBe('7');
    expect(t.settings.get('Dehaze')).toBe('-3');
    expect(() => readLrTemplate('s = { value = os.execute("x") }')).toThrow();
    expect(() => readLrTemplate('s = { value = { settings = { ')).toThrow();
  });
});

describe('Lightroom → Optic conversion', () => {
  const moody = importLightroomFile('moody-fade.xmp', fixture('moody-fade.xmp'));

  it('maps the basic panel, presence and effects one to one', () => {
    const s = moody.preset.settings as Record<string, any>;
    expect(s.light).toEqual({ exposure: 0.3, contrast: 15, highlights: -40, shadows: 25, whites: -10, blacks: 12 });
    expect(s.presence).toEqual({ vibrance: -8, saturation: -5 });
    expect(s.effects.texture).toBe(5);
    expect(s.effects.clarity).toBe(10);
    expect(s.effects.dehaze).toBe(3);
    expect(s.effects.grain).toEqual({ amount: 20, size: 30, roughness: 60, color: 0, type: 'custom' });
    expect(s.effects.vignette).toEqual({ amount: -15, midpoint: 40, roundness: 10, feather: 70, highlights: 0, style: 'highlight' });
    expect(s.calibration).toEqual({ red: { hue: 10, sat: 5 }, green: { hue: 0, sat: 0 }, blue: { hue: 0, sat: 15 }, shadowTint: -3 });
  });

  it('maps the colour mixer bands and keeps B&W off for a colour preset', () => {
    const s = moody.preset.settings as Record<string, any>;
    expect(s.hsl.bands.green).toEqual({ hue: 20, sat: -40, lum: 0 });
    expect(s.hsl.bands.blue).toEqual({ hue: -10, sat: -15, lum: -20 });
    expect(s.treatment).toBe('color');
  });

  it('maps the point curves (0…255 → 0…1)', () => {
    const c = (moody.preset.settings as Record<string, any>).curve;
    expect(c.rgb[0]).toEqual({ x: 0, y: 0.0784 });
    expect(c.rgb.at(-1)).toEqual({ x: 1, y: 0.9608 });
    expect(c.r).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(c.b[0].y).toBeCloseTo(10 / 255, 3);
  });

  it('converts split toning + colour grading, with hues moved to OKLCH', () => {
    const g = (moody.preset.settings as Record<string, any>).colorGrading;
    expect(g.shadows.sat).toBe(15);
    expect(g.shadows.lum).toBe(-5);
    expect(g.shadows.hue).toBeCloseTo(adobeHueToOklch(210), 1);
    expect(g.highlights.hue).toBeCloseTo(adobeHueToOklch(40), 1);
    expect(g.highlights.lum).toBe(4);
    expect(g.blending).toBe(60);
    expect(g.balance).toBe(20);
  });

  it('reports the profile and the masks it could not convert', () => {
    expect(moody.notConverted).toContainEqual({ code: 'profile', detail: 'Adobe Portrait' });
    expect(moody.notConverted).toContainEqual({ code: 'masks', detail: '1' });
    expect(moody.kind).toBe('preset');
    expect(moody.preset.name).toBe('Moody Fade');
    expect(moody.preset.group).toBe('Test Pack');
    expect(moody.preset.tags).toEqual(['lightroom']);
  });

  it('includes exactly the groups the preset owns', () => {
    expect(moody.preset.includes).toEqual(['exposure', 'light', 'curve', 'hsl', 'bw', 'colorGrading', 'calibration', 'presence', 'clarity', 'grain', 'vignette']);
  });

  it('applies through the normal preset engine on RAW and non-RAW photos', () => {
    const raw = applyPreset(defaultRecipe(), moody.preset, true);
    expect(raw.light.contrast).toBe(15);
    expect(raw.effects.grain.amount).toBe(20);
    expect(raw.appliedPreset?.id).toBe(moody.preset.id);
    const half = applyPreset(defaultRecipe(), moody.preset, true, 50);
    expect(half.light.highlights).toBe(-20);
  });

  it('adobeHueToOklch lands on the OKLCH hue of the matching sRGB primary', () => {
    expect(adobeHueToOklch(0)).toBeCloseTo(oklchHueOfSrgb([1, 0, 0]), 3);
    expect(adobeHueToOklch(120)).toBeCloseTo(oklchHueOfSrgb([0, 1, 0]), 3);
    expect(adobeHueToOklch(240)).toBeCloseTo(oklchHueOfSrgb([0, 0, 1]), 3);
    expect(adobeHueToOklch(360)).toBeCloseTo(adobeHueToOklch(0), 6);
  });
});

describe('white balance', () => {
  const wb = (attrs: string) => importLightroomFile('wb.xmp', enc.encode(preset(attrs)));

  it('keeps Kelvin for RAW and stores the relative equivalent for non-RAW photos', () => {
    const r = importLightroomFile('warm-matte.xmp', fixture('warm-matte.xmp'));
    expect(r.preset.settings.whiteBalance).toEqual({ mode: 'custom', temperature: 5000, tint: 12 });
    const rel = tempTintToRelative(5000, 12);
    expect(r.preset.nonRaw?.whiteBalance).toEqual({ mode: 'custom', temperature: Math.round(rel.temperature * 10) / 10, tint: Math.round(rel.tint * 10) / 10 });
    const jpeg = applyPreset(defaultRecipe(), r.preset, false);
    expect(Math.abs(jpeg.whiteBalance.temperature)).toBeLessThanOrEqual(100);
  });

  it('maps named white balances to the same Kelvin values', () => {
    expect(wb('crs:WhiteBalance="Daylight"').preset.settings.whiteBalance).toEqual({ mode: 'daylight', temperature: 5500, tint: 10 });
  });

  it('takes relative (JPEG) white balance as is for non-RAW', () => {
    const r = wb('crs:WhiteBalance="Custom" crs:IncrementalTemperature="+15" crs:IncrementalTint="-5"');
    expect(r.preset.nonRaw?.whiteBalance).toEqual({ mode: 'custom', temperature: 15, tint: -5 });
    // A warmer relative setting means a higher Kelvin value on RAW (as in Lightroom).
    expect((r.preset.settings.whiteBalance as { temperature: number }).temperature).toBeGreaterThan(6504);
  });

  it('reports Auto and leaves As Shot alone', () => {
    const auto = importLightroomFile('a.xmp', enc.encode(preset('crs:WhiteBalance="Auto" crs:Vibrance="5"')));
    expect(auto.notConverted.map((n) => n.code)).toContain('autoWb');
    expect(auto.preset.includes).toEqual(['presence']);
    const shot = importLightroomFile('b.xmp', enc.encode(preset('crs:WhiteBalance="As Shot" crs:Vibrance="5"')));
    expect(shot.preset.includes).toEqual(['presence']);
  });
});

describe('formats', () => {
  it('an .lrtemplate, an .xmp and a DNG preset with the same settings give the same preset', () => {
    const xmp = importLightroomFile('warm-matte.xmp', fixture('warm-matte.xmp'));
    const lrt = importLightroomFile('warm-matte.lrtemplate', fixture('warm-matte.lrtemplate'));
    expect(lrt.preset).toEqual(xmp.preset);
    expect(lrt.format).toBe('lrtemplate');
    // A DNG is a snapshot of a photo's settings, so photo-specific groups (white balance) are left out.
    const dng = importLightroomFile('Warm Matte.dng', dngWithXmp(decodeText(fixture('warm-matte.xmp'))));
    expect(dng.kind).toBe('snapshot');
    expect(dng.preset.includes).toEqual(xmp.preset.includes.filter((g) => g !== 'whiteBalance'));
    expect(dng.notConverted).toContainEqual({ code: 'photoSpecific', detail: 'whiteBalance' });
    expect(dng.preset.settings.light).toEqual(xmp.preset.settings.light);
  });

  it('turns the parametric curve into monotone points', () => {
    const c = (importLightroomFile('warm-matte.xmp', fixture('warm-matte.xmp')).preset.settings.curve as { rgb: Array<{ x: number; y: number }> }).rgb;
    expect(c).toHaveLength(17);
    const at = (x: number) => c.find((p) => Math.abs(p.x - x) < 1e-6)!.y;
    expect(at(0.125)).toBeGreaterThan(0.125); // shadows +30 lift
    expect(at(0.875)).toBeLessThan(0.875); // highlights −20
    for (let i = 1; i < c.length; i++) expect(c[i].y).toBeGreaterThanOrEqual(c[i - 1].y);
  });

  it('finds the XMP in a DNG by tag 700 and by scanning', () => {
    const xmp = decodeText(fixture('warm-matte.xmp'));
    expect(dngXmp(dngWithXmp(xmp))).toContain('Warm Matte');
    const junk = new Uint8Array([1, 2, 3, ...enc.encode(`garbage ${xmp.slice(xmp.indexOf('<x:xmpmeta'))} tail`)]);
    expect(dngXmp(junk)).toContain('Warm Matte');
  });

  it('gives stable ids, so importing a preset again updates it', () => {
    const a = importLightroomFile('moody-fade.xmp', fixture('moody-fade.xmp'));
    const b = importLightroomFile('copy of moody.xmp', fixture('moody-fade.xmp'));
    expect(a.preset.id).toBe(b.preset.id);
    expect(a.preset.id).toMatch(/^lr-[0-9a-f]{14}$/);
    const noUuid1 = importLightroomFile('x.xmp', enc.encode(preset('crs:Vibrance="5"')));
    const noUuid2 = importLightroomFile('x.xmp', enc.encode(preset('crs:Vibrance="6"')));
    expect(noUuid1.preset.id).not.toBe(noUuid2.preset.id);
  });

  it('names presets after the file and the group after the zip folder when the preset has none', () => {
    const r = importLightroomFile('Pack/Film/Kodak 2.xmp', enc.encode(preset('crs:Vibrance="5"')), { group: 'Film' });
    expect(r.preset.name).toBe('Kodak 2');
    expect(r.preset.group).toBe('Film');
    expect(importLightroomFile('y.xmp', enc.encode(preset('crs:Vibrance="5"'))).preset.group).toBe(LIGHTROOM_GROUP);
    expect(baseName('a\\b\\c.lrtemplate')).toBe('c');
  });
});

describe('photo sidecars (snapshots)', () => {
  it('drops neutral groups and photo-specific groups, and reports crop and retouching', () => {
    const sidecar = preset(
      'crs:WhiteBalance="Custom" crs:Temperature="5600" crs:Tint="+3" crs:Exposure2012="+0.70" crs:Contrast2012="0" crs:Highlights2012="0" crs:Shadows2012="0" crs:Whites2012="0" crs:Blacks2012="0" crs:Vibrance="+25" crs:Saturation="0" crs:Clarity2012="0" crs:Texture="0" crs:Dehaze="0" crs:LuminanceSmoothing="0" crs:ColorNoiseReduction="25" crs:HasCrop="True" crs:CropAngle="1.5"',
      '<crs:RetouchInfo><rdf:Seq><rdf:li>centerX = 0.5, centerY = 0.5, radius = 0.01</rdf:li></rdf:Seq></crs:RetouchInfo>',
      '',
    );
    const r = importLightroomFile('IMG_0001.xmp', enc.encode(sidecar));
    expect(r.kind).toBe('snapshot');
    expect(r.preset.includes).toEqual(['presence']);
    const codes = r.notConverted.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['crop', 'retouch', 'photoSpecific']));
    expect(r.notConverted.find((n) => n.code === 'photoSpecific')?.detail).toBe('whiteBalance, exposure, noiseReduction');
  });
});

describe('edge cases and errors', () => {
  const code = (f: () => unknown) => {
    try { f(); } catch (e) { return e instanceof LightroomImportError ? e.code : `other: ${String(e)}`; }
    return 'no error';
  };

  it('rejects profiles, non-presets, damaged and oversized files with a specific code', () => {
    expect(code(() => importLightroomFile('p.xmp', enc.encode(preset('crs:Name="X"', '<crs:RGBTable>ab</crs:RGBTable>', 'Look'))))).toBe('isProfile');
    expect(code(() => importLightroomFile('d.xmp', enc.encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description/></rdf:RDF></x:xmpmeta>')))).toBe('notPreset');
    expect(code(() => importLightroomFile('t.xmp', enc.encode('hello world')))).toBe('unreadable');
    expect(code(() => importLightroomFile('t.lrtemplate', enc.encode('s = { value = ')))).toBe('unreadable');
    expect(code(() => importLightroomFile('e.lrtemplate', enc.encode('s = { type = "Export", value = { settings = {} } }')))).toBe('notDevelop');
    expect(code(() => importLightroomFile('big.xmp', new Uint8Array(MAX_PRESET_BYTES + 1)))).toBe('tooLarge');
    expect(code(() => importLightroomFile('photo.dng', dngWithXmp(null)))).toBe('noXmpInDng');
  });

  it('reports when nothing in the preset can be converted', () => {
    const onlyMasks = preset('', '<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:What="Correction"/></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>');
    try {
      importLightroomFile('m.xmp', enc.encode(onlyMasks));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LightroomImportError);
      expect((e as LightroomImportError).code).toBe('nothingToConvert');
      expect((e as LightroomImportError).notConverted.map((n) => n.code)).toContain('masks');
    }
  });

  it('marks Lightroom 3 presets and converts what still applies', () => {
    const r = importLightroomFile('old.xmp', enc.encode(preset('crs:ProcessVersion="5.7" crs:Exposure="+0.50" crs:Brightness="+60" crs:Clarity="+20" crs:Vibrance="+5"')));
    expect(r.legacyProcess).toBe(true);
    expect(r.notConverted.map((n) => n.code)).toContain('legacyTone');
    expect(r.preset.settings.light).toEqual({ exposure: 0.5 });
    expect((r.preset.settings.effects as { clarity: number }).clarity).toBe(20);
  });

  it('cleans up curves: sorted, de-duplicated, clamped, dense ones resampled', () => {
    expect(parseCurve(['255, 300', '0, -5', '0, 3', 'junk'])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(parseCurve(['10, 10'])).toBeNull();
    const dense = Array.from({ length: 40 }, (_, i) => `${Math.round((i * 255) / 39)}, ${Math.round((i * 255) / 39)}`);
    expect(parseCurve(dense)).toHaveLength(16);
  });

  it('parametric curve: zero sliders give no curve; extremes stay monotone and in range', () => {
    expect(parametricPoints({ shadows: 0, darks: 0, lights: 0, highlights: 0, s1: 25, s2: 50, s3: 75 })).toBeNull();
    const p = parametricPoints({ shadows: 100, darks: -100, lights: 100, highlights: -100, s1: 90, s2: 10, s3: 50 })!;
    for (let i = 1; i < p.length; i++) expect(p[i].y).toBeGreaterThanOrEqual(p[i - 1].y);
    expect(p.every((q) => q.y >= 0 && q.y <= 1)).toBe(true);
  });

  it('maps lens, geometry, detail and B&W fields', () => {
    const c = convertCrs(new Map(Object.entries({
      LensProfileEnable: '1', AutoLateralCA: '1', LensManualDistortionAmount: '+12', DefringePurpleAmount: '4',
      PerspectiveUpright: '5', PerspectiveVertical: '-20', PerspectiveScale: '110',
      Sharpness: '60', SharpenRadius: '+1.2', LuminanceSmoothing: '30',
      ConvertToGrayscale: 'True', GrayMixerBlue: '-30',
    })), 'preset');
    const s = c.settings as Record<string, any>;
    expect(s.lens.auto).toBe(true);
    expect(s.lens.ca.auto).toBe(true);
    expect(s.lens.distortion).toBe(12);
    expect(s.lens.defringe.purpleAmount).toBe(20);
    expect(s.geometry.upright).toBe('off');
    expect(s.geometry.vertical).toBe(-20);
    expect(s.geometry.scale).toBe(110);
    expect(c.notConverted.map((n) => n.code)).toContain('guidedUpright');
    expect(s.detail.sharpen).toEqual({ amount: 60, radius: 1.2, detail: 25, masking: 0 });
    expect(s.detail.nr.lum).toBe(30);
    expect(s.treatment).toBe('monochrome');
    expect(s.bwMixer.blue).toBe(-30);
  });
});

describe('untouched curves', () => {
  it('a linear curve with zero parametric sliders does not reset the user’s curve', () => {
    const r = importLightroomFile('lin.xmp', enc.encode(preset(
      'crs:Vibrance="5" crs:ParametricShadows="0" crs:ParametricDarks="0" crs:ParametricLights="0" crs:ParametricHighlights="0"',
      '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
    )));
    expect(r.preset.includes).toEqual(['presence']);
    expect(r.preset.settings.curve).toBeUndefined();
  });
});

describe('zip limits (readZip)', () => {
  /** A one-entry zip whose entry is deflated, with `declared` as the stated uncompressed size. */
  async function deflateZip(name: string, data: Uint8Array, declared = data.length): Promise<Uint8Array> {
    const comp = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length + comp.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true);
    lv.setUint32(18, comp.length, true); lv.setUint32(22, declared, true); lv.setUint16(26, n.length, true);
    local.set(n, 30); local.set(comp, 30 + n.length);
    const cd = new Uint8Array(46 + n.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true);
    cv.setUint32(20, comp.length, true); cv.setUint32(24, declared, true); cv.setUint16(28, n.length, true); cv.setUint32(42, 0, true);
    cd.set(n, 46);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, cd.length, true); ev.setUint32(16, local.length, true);
    const out = new Uint8Array(local.length + cd.length + eocd.length);
    out.set(local); out.set(cd, local.length); out.set(eocd, local.length + cd.length);
    return out;
  }

  it('rejects too many entries before reading any', async () => {
    const zip = writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.xmp`, data: enc.encode('x') })));
    await expect(readZip(zip, { maxEntries: 4 })).rejects.toBeInstanceOf(ZipLimitError);
  });

  it('skips entries without inflating them', async () => {
    const zip = writeZip([{ name: 'keep.xmp', data: enc.encode('a') }, { name: '__MACOSX/._keep.xmp', data: enc.encode('b') }]);
    const seen: string[] = [];
    const out = await readZip(zip, { include: (name) => { seen.push(name); return !name.startsWith('__MACOSX'); } });
    expect(out.map((e) => e.name)).toEqual(['keep.xmp']);
    expect(seen).toHaveLength(2);
  });

  it('stops a zip bomb that lies about its size', async () => {
    const bomb = await deflateZip('bomb.xmp', new Uint8Array(4 * 1024 * 1024), 10);
    expect(bomb.length).toBeLessThan(20_000);
    await expect(readZip(bomb, { maxTotalBytes: 1024 * 1024 })).rejects.toBeInstanceOf(ZipLimitError);
    // Without limits the behaviour is unchanged.
    expect((await readZip(bomb))[0].data.length).toBe(4 * 1024 * 1024);
  });
});
