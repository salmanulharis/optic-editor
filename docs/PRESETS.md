# Optic presets

A preset is a small JSON file that sets some **groups** of the edit recipe. It never touches the
groups it doesn't list, so white balance, exposure, noise reduction, lens corrections, transform and
crop stay yours unless a preset explicitly includes them.

## File format (version 3)

```json
{
  "id": "hb-natural",
  "name": "Natural",
  "group": "Hasselblad-inspired",
  "version": 3,
  "description": "Accurate, smooth, restrained medium-format colour.",
  "tags": ["natural", "portrait", "skin"],
  "includes": ["light", "look", "curve", "hsl", "pointColor", "calibration", "presence", "grain"],
  "settings": {
    "light": { "contrast": 5 },
    "look": { "highlightRolloff": 75, "shadowDensity": 15, "microContrast": 8, "colorDensity": 20, "warmthBias": 3 },
    "curve": { "rgb": [{ "x": 0, "y": 0 }, { "x": 0.25, "y": 0.235 }, { "x": 0.5, "y": 0.5 }, { "x": 0.75, "y": 0.76 }, { "x": 1, "y": 1 }] },
    "hsl": { "bands": { "yellow": { "hue": 8 }, "green": { "sat": 6 } } },
    "pointColor": { "points": [{ "target": { "L": 0.68, "C": 0.075, "h": 55 }, "hueRange": 22, "uniformity": 30 }] },
    "calibration": { "green": { "hue": 0, "sat": 10 } },
    "presence": { "vibrance": 6 },
    "effects": { "grain": { "amount": 12, "size": 14, "roughness": 35 } }
  },
  "nonRaw": { "presence": { "vibrance": 4 } },
  "lut": "optional-lut-id"
}
```

| Field | Meaning |
|---|---|
| `id` | Unique id. Imported presets get a fresh id. |
| `name`, `group`, `description`, `tags` | Shown in the browser; search matches name, description, tags and group. |
| `version` | Preset format version (2). |
| `includes` | The groups this preset owns (see below). Only these are read from `settings`. |
| `settings` | A partial recipe in the recipe's own JSON shape. Within an included group, missing fields take their **neutral defaults**, because a preset fully defines each group it owns. |
| `nonRaw` | Optional explicit values for JPEG / HEIC / PNG photos, applied after the automatic scaling (below). |
| `lut` | Optional LUT id (a bundled LUT or one from *My LUTs*). Implies the `lut` group. `settings.lut` can set `inputSpace` and `amount`. |

### Groups

| Group | Recipe fields |
|---|---|
| `whiteBalance` | `whiteBalance` (Kelvin/tint on RAW, relative −100…+100 on non-RAW, so rarely useful in a shared preset) |
| `exposure` | `light.exposure` only |
| `light` | `light.contrast / highlights / shadows / whites / blacks` (never exposure) |
| `look` | `look.*` (highlight roll-off, shadow density, micro-contrast, colour density, warmth bias) |
| `curve` | `curve.rgb / r / g / b` (points in gamma-2.2 space, 0…1) |
| `hsl` | `hsl.bands.<band>.hue / sat / lum` |
| `bw` | `treatment` (`"color"` / `"monochrome"`) and `bwMixer.<band>`, `bwMixer.mix` |
| `pointColor` | `pointColor.points[]` (≤ 8; target colour in OKLCH, `h` in degrees) |
| `colorGrading` | `colorGrading.shadows / midtones / highlights / global` (`hue` 0–360 in OKLCH, `sat` 0–100, `lum` ±100), `blending`, `balance` |
| `calibration` | `calibration.red / green / blue` (`hue`, `sat` ±100), `shadowTint`, optional `matrix` (9 numbers, row-major; rows are normalised to sum to 1) |
| `presence` | `presence.vibrance / saturation / protectSkin` |
| `lut` | `lut.id / inputSpace / amount` |
| `clarity` | `effects.texture / clarity / dehaze` |
| `grain` | `effects.grain.amount / size / roughness / color / type` |
| `glow` | `effects.halation` and `effects.bloom` |
| `vignette` | `effects.vignette` (post-crop) |
| `sharpening` | `detail.sharpen` |
| `noiseReduction` | `detail.nr` (photo-specific) |
| `lens` | `lens` (photo-specific) |
| `geometry` | `geometry`: upright, guides and transform sliders (photo-specific) |
| `crop` | `crop` (photo-specific) |

The Phase 3 effect groups share the recipe's `effects` section: a preset that includes `grain` only
reads and writes `effects.grain`. See [EFFECTS.md](EFFECTS.md) for what each value does.

Version 2 files (Phase 2) load unchanged; their old `effects` placeholder is ignored.

Every value is validated and clamped on load, so a hand-edited file can't produce out-of-range
settings.

## Applying, amount and editing

- **Applying** records the photo's current values for the preset's groups (the *base*) and the
  preset's values (the *target*) in `recipe.appliedPreset`, then writes the interpolated result.
- **Amount (0–200 %)** re-interpolates between base and target in real time:
  - Numbers: linear.
  - Curves: both resampled to 32 points with the renderer's monotone cubic, then point-wise.
  - Colour wheels: in hue/saturation *vector* space, so 350° → 10° goes through red, not round the wheel.
  - Point colours: matched by index.
  - LUT: its amount ramps from 0 when the photo had no LUT.
  - A monochrome preset below 100 % blends grey with colour via `bwMixer.mix`.

  Exactly 0 % restores the base and exactly 100 % gives the target. Above 100 % extrapolates, with
  values clamped to their ranges and the output stage's gamut compression keeping colours in gamut.
- **Applying another preset** first restores the previous preset's base, so presets replace each other
  rather than stacking.
- **Manual edits** afterwards are kept. The chip shows *Name (edited)* when any of the preset's groups
  differs from what the preset and amount would produce. **Reset** re-applies the preset at the current
  amount, discarding those manual changes; **Remove** restores the base.
- Moving **Amount** after manual edits re-interpolates the preset's groups, which also discards those
  edits. Adjust the amount first, then fine-tune.

## Non-RAW scaling

JPEG, HEIC and PNG photos already carry the camera's own look (tone curve, saturation), so applying
a RAW-tuned preset at full strength over-cooks them. For non-RAW photos Optic scales the preset's
changes **relative to neutral** by `NON_RAW_SCALE = 0.75` (`src/presets/apply.ts`) for:

- calibration (primary hue/saturation, shadows tint, and the matrix toward identity)
- vibrance and saturation, and HSL saturation
- light contrast, and the tone curves (pulled 25 % toward the diagonal)
- colour-grading saturation, and look colour density

Then the preset's optional `nonRaw` block is applied on top as explicit values. Use it when a look
needs a hand-tuned JPEG version. Example: `film-velvia` sets `"nonRaw": { "presence": { "vibrance": 8, "saturation": 12 } }`.

When you save your own preset with *Save a separate non-RAW variant*, the same values are stored in
`nonRaw`, so JPEGs get exactly your settings and no automatic scaling.

## Creating and sharing

- **+ Create** (preset browser): name, group, and a checklist of groups. The photo-specific groups
  (white balance, exposure, noise reduction, lens corrections, transform, crop) are unchecked by
  default; tick them explicitly to include them. Copy / paste settings uses the same defaults. Presets are saved in IndexedDB under *My Presets* (or your group).
- **Right-click a preset:** Apply, Apply at 50 %, Duplicate as my preset (built-ins are read-only),
  Rename / Delete (your presets), Export JSON.
- **Import** accepts `.json` presets, `.opticpack` bundles, `.cube` / Hald `.png` LUTs, and
  Lightroom / Camera Raw presets (below), on their own or in a `.zip`. Files can also be dropped on
  the preset browser.
- **Export pack** writes an `.opticpack`: a standard zip with `presets/<id>.json` and the `.cube` files of
  any user LUTs they reference (`luts/<id>.cube`). On import, LUTs get new ids and the presets are
  re-pointed at them. Packs zipped with other tools work too (stored or deflate entries).

## Lightroom and Camera Raw presets

`src/presets/lightroom/` converts Lightroom presets into ordinary version 3 Optic presets. It is
pure TypeScript with no DOM, lazy-loaded on the first Lightroom file, and unit-tested in
`tests/unit/lightroom.test.ts` (fixtures in `tests/unit/fixtures/lightroom/`).

| Input | Reader | Treated as |
|---|---|---|
| `.xmp` with `crs:PresetType` (Lightroom Classic 7.3+, Lightroom, Camera Raw) | `xmp.ts`: a small tokenizer, top-level `rdf:Description` only, never resolves entities | **preset**: every group with a field present is included |
| `.xmp` without `crs:PresetType` (a photo's sidecar) | `xmp.ts` | **snapshot** (see below) |
| `.lrtemplate` (Lightroom 7.2 and older) | `lrtemplate.ts`: a Lua-table literal parser (never evaluated); `type` must be `Develop` | **preset** |
| `.dng` (Lightroom Mobile "DNG presets") | `dng.ts`: TIFF tag 700, else a scan for `<x:xmpmeta` | **snapshot** |

A **snapshot** holds all of a photo's settings, so `convert.ts` drops groups that are still neutral
and skips the photo-specific groups (white balance, exposure, noise reduction, lens, geometry), like
Optic's copy / paste defaults. They are reported as "photo-specific settings".

**Mapping** (`convert.ts`). Most of Lightroom's ranges and defaults are Optic's, so these are 1:1:
- Basic: `Exposure2012` → `exposure`; `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012` → `light`.
- Mixer and B&W: `HueAdjustment*` / `SaturationAdjustment*` / `LuminanceAdjustment*` → `hsl`; `ConvertToGrayscale` + `GrayMixer*` → `bw`.
- Colour: calibration (`RedHue` … `ShadowTint`), `Vibrance` / `Saturation`.
- Effects: `Texture` / `Clarity2012` / `Dehaze`; grain (`GrainFrequency` → roughness); `PostCropVignette*` (style 1/2/3 → highlight / color / paint).
- Detail: sharpening and noise reduction.
- Lens: `LensProfileEnable` → `auto`, `AutoLateralCA`, manual distortion and vignetting, defringe (amounts × 5: Lightroom's run 0–20).
- Geometry: the `Perspective*` sliders, and `PerspectiveUpright` (0–4 as documented by ExifTool; Guided is reported).

**Converted rather than copied:**
- **White balance:** Kelvin presets keep Kelvin in `settings` and get the relative equivalent in `nonRaw` (`tempTintToRelative`); JPEG presets (`IncrementalTemperature/Tint`) work the other way round. Named settings (Daylight …) use `WB_PRESETS`, which has Lightroom's values. *As Shot* is left alone. *Auto* is reported, because Optic computes Auto on the photo.
- **Tone curve:** `ToneCurvePV2012[Red|Green|Blue]` points ÷ 255. An untouched curve (all linear, parametric sliders at 0) is left out, so it never resets the photo's own curve. The parametric curve (`Parametric*` and its splits) is approximated: each region's centre moves by up to half the region's width. It is baked into 17 monotone points and applied before the point curve.
- **Colour grading:** `ColorGrade*` and pre-2020 `SplitToning*` (Blending 100 when only split toning is present). Hues go from Lightroom's HSV-style wheel to OKLCH through the saturated sRGB colour of that hue (`adobeHueToOklch`). Balance has the same sign.
- **Process version 2010 and older:** `Exposure`, `Clarity` and `ToneCurve` are used; Brightness / Fill Light / Recovery are reported.

**Not converted (reported):** camera profiles (`Look`, `CameraProfile`, `RGBTable`), masks, spot
removal / red eye, crop, point colour, HDR settings, lens blur, Auto tone, Guided Upright.

**Storage:** converted presets are normal user presets.
- **Id:** `lr-<hash of crs:UUID>` (or of name + settings when there is no UUID), so re-importing a preset replaces it, and the same preset in two formats within one import is skipped as a duplicate.
- **Group:** the preset's `crs:Group`, else the nearest meaningful folder in the zip (generic folders like `XMP`, `LRTEMPLATE` or `DNG` are skipped), else *Lightroom imports*.
- **Tag and description:** the tag is `lightroom`; the description names the file and what was not converted.

**Limits** (`lightroom/limits.ts`, enforced through `readZip`'s limits before or while inflating):
- 2 MB per `.xmp` / `.lrtemplate` and 200 MB per DNG; an entry over its limit is reported and never inflated.
- Zips: up to 300 MB packed and 300 MB unpacked (decompression stops at the budget even if an entry lies about its size), and up to 1,000 entries (checked from the directory before reading).
- macOS `__MACOSX/` and `._*` entries are skipped, and zips inside zips are reported.
- If browser storage refuses a preset (full), the report marks it *Not saved*; it stays usable until a reload.

Results are approximate by design: Optic's tone, curve and grading models are its own. Applying a
converted preset goes through the normal engine, including the non-RAW scaling and the Amount slider.

## Built-in presets

64 presets live in `src/presets/builtin/<group>/<id>.json`: Hasselblad-inspired (10), Leica-inspired
(12), Zeiss-inspired (10), Film (16), Black & White (8) and Cinematic (8). Brand names are "inspired
by" labels only; the preset names are neutral. The Film, Black & White and Cinematic presets
include Phase 3 effects (grain, halation / bloom, vignette, texture / clarity), e.g. Portra 400-like:
fine grain 22 and a slight bloom; Cinestill 800T-like: halation 48 and medium grain; Tri-X-like:
coarse grain and a vignette; Bleach bypass: texture and clarity. They are bundled at build time with
`import.meta.glob`, so adding a JSON file there is all it takes to ship a new built-in.

The bundled sample LUTs are in `public/luts/` (registered in `src/presets/builtin/index.ts`).
`sample-files/luts/` holds a 65-point `.cube` and a level-8 Hald CLUT for testing imports.
