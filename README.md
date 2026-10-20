# Optic — Phases 1–2

Browser-based photo editor for iPhone ProRAW / camera RAW and HEIC / JPEG / PNG / TIFF / WebP / AVIF.
Everything runs client-side; photos never leave the device.

- **Phase 1:** decoding, a GPU colour pipeline, live preview and full-quality export.
- **Phase 2:**
  - colour science: calibration, point colour, colour grading, B&W mixer, 3D LUTs and the look layer
  - the preset system: 64 built-in presets, user presets, `.opticpack` sharing, and a thumbnail browser with hover preview
- **Phases 3–4:** effects (grain, halation…), crop, history, snapshots and the library.

More detail: [docs/COLOR.md](docs/COLOR.md) (calibration, look layer, stage order) and
[docs/PRESETS.md](docs/PRESETS.md) (preset schema, non-RAW scaling, sharing).

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve dist/ (http://localhost:4173)
npm run typecheck
```

**Hosting requirement:** the page must be *cross-origin isolated*. LibRaw-WASM runs with pthreads
(SharedArrayBuffer), and the decoded image is shared between the UI and the export worker
without copying. The dev and preview servers already send these headers (`vite.config.ts`).
Any production host must send them too:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Architecture

```
File ──► decode worker ──► linear float RGB (full res, SharedArrayBuffer) + proxy + thumbnail
                                   │
           Recipe (Zustand) ──►  Pipeline.render(image, recipe)  ──► canvas   (preview: proxy, per frame)
                                   │                               └► tiles   (export: full res, worker)
                                   └► small renders/readbacks: histogram, pixel readout, auto tools
```

### The recipe — single source of truth (`src/recipe/`)

`Recipe` (`schema.ts`) is a versioned, JSON-serialisable description of an edit. The UI only edits the
recipe and never touches pixels. Rendering is a pure function of (image, recipe), which is what
presets, undo and copy/paste build on. `serialize.ts` parses tolerantly and clamps values, and is the
future preset format. Auto tools (Auto WB, Auto Tone, colour-cast estimate, droppers) only write
recipe values, so the sliders move visibly.

Section eye toggles are part of the recipe (`enabled`). `effectiveRecipe()` swaps disabled sections
for their defaults before rendering, so stages never need to know about toggles.

### Decoding (`src/io/decode/`)

| Input | Path |
|---|---|
| DNG (ProRAW classic, Android, any), CR2/CR3, NEF, ARW, RAF, RW2, ORF, … | `rawDecoder.worker.ts` → LibRaw (AHD demosaic; linear DNGs such as ProRAW skip demosaicing) |
| DNG 1.7 with JPEG XL tiles (Compression 52546, newer iPhones) | `dngJxl.ts`: our own tile reader, tiles decoded in parallel by jxl-oxide (16-bit), then assembled |
| HEIC / HEIF (8/10/12-bit) | `heicDecoder.ts` (libheif, high-bit-depth output) |
| JPEG | MozJPEG decode (raw samples, identical in every browser), EXIF orientation applied by us |
| PNG 8/16, TIFF 8/16/32f | @jsquash/png, UTIF |
| WebP, AVIF | browser decoder with colour management disabled |

Format detection sniffs magic bytes, so a DNG named `.jpeg` still opens as RAW.

All decoders output **linear float RGB in the source's own primaries** (camera RGB for RAW), already
upright. Colour metadata travels alongside: a DNG colour profile for RAW (ColorMatrix1/2,
ForwardMatrix1/2, CameraCalibration, AnalogBalance, illuminants, AsShotNeutral, BaselineExposure),
or the RGB→XYZ matrix from the embedded ICC profile for everything else. Any matrix/TRC ICC profile
is parsed (`io/metadata/icc.ts`), including sRGB, Display P3, Adobe RGB, ProPhoto and custom ones.
Files without a profile are treated as sRGB. HEIC/AVIF colour comes from the `colr` box (ICC or nclx).

> libraw-wasm ignores its `gamm` option, so LibRaw always returns BT.709-gamma data. We undo it exactly
> with a port of LibRaw's own `gamma_curve` solver (`libRawGammaInverse`). This was verified by
> measurement; see the comment in `rawDecoder.worker.ts`.

### The pipeline (`src/pipeline/`)

Working space: **scene-linear Rec.2020 (D65), 32-bit float**. Stages run in this order; each is one file
in `stages/`:

| # | Stage | What it does |
|---|---|---|
| 00 | `input` | Samples the source at full-res pixel coordinates and computes the clipping mask (carried in alpha). Optional debanding (8-sample, edge-aware) and deblocking for 8-bit sources. |
| 10 | `whiteBalance` | **One pre-multiplied matrix:** calibration · camera→working · white balance. RAW WB: camera-space multipliers from the DNG model. Non-RAW WB: Bradford adaptation in source RGB. Clipped highlights are neutralised so they don't turn magenta or complementary-tinted. |
| 20 | `cameraToWorking` | ForwardMatrix or interpolated ColorMatrix (RAW, incl. BaselineExposure) or ICC matrix → Rec.2020. Folded into stage 10 since Phase 2; kept as the `until: 'cw'` reference. |
| 25 | `calibration` | Primary hue/sat + colour matrix (in the stage-10 matrix); this stage applies the shadows tint |
| 27 | `colorCast` | Remove colour cast: per-zone (shadows/mids/highlights) OKLab offsets × strength |
| 30 | `exposureTone` | Exposure, luminance-driven shadows/highlights, contrast around 0.18, filmic shoulder that maps the source white exactly to 1.0 (identity for JPEG at default), whites, blacks |
| 40 | `hsl` | 8-band OKLCH mixer, raised-cosine weights between neighbouring bands (no seams) |
| 45 | `pointColor` | Up to 8 sampled colour ranges (hue/chroma/lightness windows), skin uniformity, mask view |
| 50 | `toneCurve` | 4096-entry float LUT (RGB master + R/G/B), applied on a gamma-2.2 encoding |
| 52 | `bwMixer` | Monochrome conversion with per-band weights. Placed before grading so split-tones work. |
| 55 | `colorGrading` | Shadows / midtones / highlights / global wheels in OKLab, blending, balance |
| 60 | `presence` | Vibrance (low-chroma weighted, skin-protected) and saturation in OKLCH |
| 70 | `lut` | 3D LUT (.cube / Hald), tetrahedral interpolation, per-LUT input space, amount 0–200 % |
| 75 | `look` | Highlight roll-off, shadow density, micro-contrast (image-relative blurred luminance map), colour density, warmth bias |
| 90 | `output` | Working → destination, soft gamut compression in OKLCH, transfer function, dither, clip overlay |

**Zero-cost skipping:** each stage has `active(ctx)`. Inactive stages are not compiled into the shader
at all. Programs are cached per active-stage combination and compiled in the background
(`KHR_parallel_shader_compile`), so a frame never waits on the compiler.

**Fusion and ping-pong:** consecutive per-pixel (`point`) stages are fused into one fragment shader.
A `spatial` stage (one that needs neighbouring pixels of the previous result) starts a new pass,
chained through ping-pong RGBA32F framebuffers. In Phase 1 the only spatial work is in stage 00,
so a typical frame is a single full-screen pass.

**Preview vs export use the same code.** The view matrix maps output pixels to full-resolution
image pixels:
- **Preview** renders at canvas resolution from a mipmapped proxy (long edge ≤ 2× canvas × DPR,
  ≤ 4096). At ≥ 100 % zoom it renders from a full-resolution texture of the visible area, uploaded in
  chunks across frames.
- **Export** (`io/encode/exportRender.ts`) runs the same `Pipeline` in a worker on an OffscreenCanvas.
  It renders 1024 px tiles at 1:1, each uploaded with a 32 px margin so spatial filters see real
  neighbours, reads back `RGBA32F`, and quantises to 16-bit. If the browser has no WebGL2 in
  workers, the same function runs on the main thread, yielding between tiles.

The renderer is DOM-free and talks to WebGL2 only through `Pipeline` and `pipeline/gl/`. A WebGPU
backend can implement the same `render(params)` contract against WGSL versions of the stage snippets.

### Colour math notes

- **White balance (RAW)**, `color/whiteBalance.ts`: Kelvin/tint ↔ xy uses Robertson isotemperature lines
  (as in the DNG SDK). ColorMatrix1/2 are interpolated linearly in inverse temperature between the
  calibration illuminants. Converting a camera neutral to xy is a fixed-point iteration, because the
  interpolation weight depends on the answer. "As Shot" uses AsShotNeutral directly. Apple ProRAW
  stores its white balance in AnalogBalance (AsShotNeutral = 1,1,1), which the model includes.
- **White balance (non-RAW):** temperature/tint are relative (−100…+100), mapped to an assumed
  illuminant and applied as Bradford adaptation to D65. (0, 0) is exactly the identity.
- **Gamut compression**, stage 90: bisection in OKLCH finds the largest in-gamut chroma at the pixel's
  lightness and hue. Chroma below 90 % of that boundary is untouched; 90–160 % is compressed smoothly
  into 90–100 %. Compression is skipped when it cannot be needed (non-RAW source in its own space
  with no colour-expanding edits), so default exports keep their colours.
- **Dither**: TPDF ±1 LSB on 8-bit outputs (canvas, and 16→8-bit for JPEG).

### Export (`src/io/encode/`)

- TIFF 16-bit (ZIP + predictor, or uncompressed), PNG 16-bit (own encoder with iCCP + eXIf), JPEG via MozJPEG.
  JPEG quality ≥ 90 uses 4:4:4. JPEG uses the standard quantisation table without trellis, because
  MozJPEG's defaults strip the dither and bring back banding in skies (measured).
- ICC v4 profiles for sRGB / Display P3 / Adobe RGB / ProPhoto are generated in code (`icc.ts`) and embedded.
- EXIF: for a JPEG source with "Keep all", the original APP1 is copied byte-for-byte (maker notes included)
  and patched in place. Other sources get their tags re-serialised. Orientation is always written as 1,
  because pixels are exported upright. "Strip GPS" zeroes the GPS data.
- Default: TIFF 16-bit in Display P3 for RAW. For non-RAW, the source's colour space, and JPEG q95 4:4:4
  for JPEG sources. Filename `{original}_optic.{ext}`. Saves through the File System Access API when
  available, otherwise as a download.

## Adding a pipeline stage

1. Create `src/pipeline/stages/NN_name.ts` exporting a `Stage`:
   ```ts
   export const grainStage: Stage = {
     id: 'grain',                      // prefix for its GLSL function and uniforms
     label: 'Grain',
     kind: 'point',                    // or 'spatial' (gets the previous pass as a sampler)
     glsl: `uniform float grain_amount;
            vec4 grain_apply(vec4 c) { /* … */ return c; }`,
     active: (ctx) => ctx.recipe.effects.grain > 0,   // false ⇒ not compiled in
     uniforms: (ctx) => ({ grain_amount: u.f(ctx.recipe.effects.grain / 100) }),
   };
   ```
   Point stages implement `vec4 <id>_apply(vec4 c)`. Spatial stages implement
   `vec4 <id>_apply(sampler2D prev, ivec2 fc)`. Shared helpers (`toOklab`, `toOklch`, `luma`, `skinMask`,
   `hash12`, …) live in `glslCommon.ts` / `color/oklab.ts`.
2. Insert it at its position in `stages/index.ts`.
3. Add its parameters to `Recipe` (`schema.ts`), with defaults that make `active()` false, plus parsing in
   `serialize.ts`. Bump `RECIPE_VERSION` and add a migration if the change isn't purely additive.
4. Add a panel in `src/ui/panels/` that edits the recipe through `useEdit` (`update` while dragging,
   `commit` on release).
5. If presets should be able to carry it, add the group to `PRESET_GROUPS` and `getGroup` / `setGroup`
   in `schema.ts`.

Preview, histogram, readouts, thumbnails, auto tools and export pick it up automatically.

Rules that bit us (see the comments in `Pipeline.ts`):
- **Always bind every sampler a stage declares.** Use `res.dummy` when there is nothing to bind. Sampler
  uniforms keep their last unit per program; if that unit now holds the render target, WebGL rejects the
  draw (black frame).
- **Upload or create textures on the upload unit (15)**, never on whatever unit happens to be active.
  Stage textures are resolved before the image is bound, for the same reason.
- **Image-wide context** (blurred maps and similar) must be built from `mapSource` (the proxy), so
  preview and export tiles see identical data.

## Using it

- **Open**: button, Ctrl/Cmd+O, or drag a file anywhere onto the window. A progress bar with Cancel is
  shown while decoding.
- **Viewer**: Fit / 100 % / 200 % buttons, wheel or pinch to zoom, drag to pan, `Z` toggles fit/100 %.
- **Before/after**: hold `\` or the toolbar button.
- **Clipping overlay**: `J`, or click the triangles on the histogram.
- **Eyedropper**: `W`, then click a neutral pixel. Black/white point droppers are in the Light panel.
- **Sliders**: drag; double-click the label or track to reset; arrow keys ±1, Shift ±10; mouse wheel
  for fine steps; or type a value.
- **Undo/redo**: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z. One step per slider release.
- **Export**: Ctrl/Cmd+E. The dialog closes and progress shows in the top bar, so you can keep editing.
- **Presets** (left sidebar):
  - Hover a preset (or arrow-key through them) to preview it; click to apply.
  - Amount 0–200 % at the top; right-click for more options; ★ marks a favourite.
- **Treatment**: `V` toggles colour / monochrome; the Color Mixer becomes the B&W mixer.
- **Copy / paste settings**: Ctrl/Cmd+Shift+C / V, with a checklist of groups. **Reset all** is at the
  bottom of the right panel (undoable).
- **Point colour**: *+ Pick* or *Skin*, then click the image; *Visualize range* shows the mask. Right-click a
  point swatch to delete it.

## Verification status

Checked in headless Chromium on an Intel UHD 730 iGPU (ANGLE/D3D11), with a real iPhone 16 Pro Max
ProRAW DNG (12 MP, lossless-JPEG tiles), plus files derived from it and synthetic test files:

- ProRAW decodes in ~1.5 s, upright, with natural As Shot colour (neutral wall, real blacks).
- A synthetic DNG 1.7 with JPEG XL tiles decodes through the fallback path. As Shot for a D65 neutral
  reads 6503 K / +10, matching Lightroom's reading of D65.
- Slider drags render at 58–60 fps. No main-thread task exceeds ~90 ms during decode, drag or export.
- TIFF/PNG/JPEG exports keep the exact original pixel dimensions, embed the ICC profile (P3 v4.3),
  and keep EXIF. JPEG q95 is 4:4:4.
- Rotated JPEG (EXIF orientation 6), P3 JPEG and 16-bit TIFF round-trip correctly.
- +3 EV rolls highlights off smoothly. On a synthetic 8-bit sky with contrast +80 and saturation +60,
  debanding brings 16-bit band steps from 1.68 to 0.12 levels.
- Auto WB on an artificially warmed JPEG returns −34 (the warming was ≈ −39 on this scale).

**Phase 2**, same setup:

- All 64 built-in presets load and render distinct looks on the ProRAW. A contact sheet showed no
  broken, clipped or neon renders.
- With every Phase 2 stage active, slider drags hold 58–60 fps:
  - calibration, 8 point colours, grading, LUT, look with micro-contrast, curve, HSL, presence, colour cast
  - GPU time is ~8.5 ms per frame at a ~1 MP canvas
- Hover preview shows on the next frame (after first compile).
- Preset amount: 0 % equals the pre-preset recipe exactly, and 200 % stays clamped and renders finite.
- A grading-only user preset applied to another photo changes only `colorGrading`.
- Non-RAW scaling: the same preset raises chroma less on a JPEG of the scene than on the ProRAW
  (Velvia ×1.20 vs ×1.44).
- Calibration ±100 on every primary keeps the white wall neutral.
- Monochrome + grading gives a split tone, and Monochrom HC renders the blue wall darker than Neutral.
- LUTs:
  - 65-point `.cube` and Hald PNG import, apply, blend with Amount, and persist across reload.
  - A corrupt `.cube` shows a line-numbered error.
- Phase 1 (v1) recipes migrate.
- Full-resolution export matches the preview: with micro-contrast 80 it adds only +0.3 levels over the
  1.6-level resampling/JPEG baseline.
- `.opticpack` zip round-trips (stored and deflated entries).

**Not yet verified with real files:**
- Android 10-bit HEIC, Canon CR3, Sony ARW, and a real JPEG-XL ProRAW from a newer iPhone. These code
  paths exist, but no sample files were available.
- The 48 MP ProRAW performance target on an M1-class machine.
- The built-in presets were tuned against one indoor portrait plus synthetic charts. They still need a
  pass on landscape, street, night and tungsten photos.

## Known browser limitations

- **Cross-origin isolation is required** (see Setup). Without it, RAW decoding fails (LibRaw needs threads).
- **Display P3 preview** requires `drawingBufferColorSpace` (Chrome/Edge 104+, Safari 16.4+). Otherwise
  the preview is sRGB; exports are unaffected.
- **Float render targets** (`EXT_color_buffer_float`) are required. Every desktop browser and iPad Safari 15+ has them.
- **Export in a worker** needs WebGL2 on OffscreenCanvas (Chrome, Edge, Firefox, Safari 17+). Older browsers
  render on the main thread in small tiles: the UI stays responsive, but the export is slower.
- **WebP and AVIF** go through the browser's decoder, so they are 8-bit. HDR (PQ/HLG) HEIC/AVIF is
  rendered as SDR in Phase 1.
- **Memory**: a 48 MP image is ~576 MB as float RGB. Safari on iPad may refuse images that large.
- **Nested workers** (LibRaw spawns its own worker from our decode worker) need Safari 15.5+.
- **ProRAW extras** (ProfileToneCurve, semantic masks, gain maps) are not applied yet. Optic uses its own
  base tone curve. Applying Apple's ProfileToneCurve would fit as a camera-profile stage.
- **IndexedDB** stores user presets and LUTs. In private windows or with blocked storage they last only for
  the session; favourites and recents use localStorage.
