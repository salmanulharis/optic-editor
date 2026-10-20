# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Optic: a client-side browser photo editor for RAW (Apple ProRAW and other DNGs, CR2/CR3, NEF, ARW, …) and HEIC/JPEG/PNG/TIFF/WebP/AVIF.
Stack: Vite + React 18 + TypeScript (strict), Zustand, WebGL2 float pipeline, Web Workers via Comlink, and WASM codecs (libraw-wasm, jxl-oxide-wasm, libheif-js, @jsquash/jpeg + png, UTIF).
Phases 1–3 of 4 are done:
- Phase 1: the foundation (decode, GPU pipeline, live preview, export).
- Phase 2: colour science plus presets (calibration, point colour, grading, B&W, 3D LUTs, look layer, 64 built-in presets).
- Phase 3: detail (sharpening, noise reduction), effects (texture, clarity, dehaze, grain, halation, bloom, vignette), lens corrections, upright/transform, crop & straighten, history, snapshots, virtual copies and compare views.

The library/catalog, batch export, local/AI masks, PWA and the mobile layout come in Phase 4. New features go in as new stages, recipe fields and panels, not rewrites.
[docs/COLOR.md](docs/COLOR.md), [docs/EFFECTS.md](docs/EFFECTS.md) and [docs/PRESETS.md](docs/PRESETS.md) document the colour model, the Phase 3 tools (including the resolution-independence rules) and the preset format.

## Commands

```bash
npm run dev            # http://localhost:5173 (sends the COOP/COEP headers)
npm run build          # tsc -b && vite build
npm run preview        # serve dist/ on :4173 (also sends COOP/COEP)
npm run typecheck      # tsc -b --noEmit
npm run test:seams     # tiled vs untiled export, every spatial effect at 100; exits 1 on a seam
npm run bench          # 48 MP synthetic: preview fps while dragging, export time
npm run lensfun:subset # regenerate src/io/lens/lensfun-subset.json from the lensfun database
```

`test:seams` and `bench` start Vite programmatically and drive `bench.html` (dev-only page, `src/bench/`) in headless Chrome/Edge via `playwright-core`. Set `CHROME_PATH` or `CHROME_CHANNEL` to choose the browser.
There is no unit test runner or linter. Other verification is done by driving the app in headless Chromium with playwright-core; those scripts are not part of the repo.
In dev builds, `window.__optic` exposes the stores, the preset engine, the geometry actions and the renderer (`main.tsx`, gated on `import.meta.env.DEV`) for that kind of testing.
`sample-files/IMG_7040.jpeg` is really an iPhone 16 Pro Max ProRAW DNG with a `.jpeg` name (detection sniffs magic bytes).
It is a 12 MP lossy-JPEG DNG at ISO 125 with no opcode lists. `sample-files/luts/` has a 65-point `.cube` and a Hald PNG for LUT import tests.

## Hard constraints

- **Cross-origin isolation is required.** LibRaw-WASM uses pthreads (SharedArrayBuffer), and the full-resolution image is allocated in a SharedArrayBuffer (`allocFloat`) and shared with the export worker without copying. Any host must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- WASM packages that locate their `.wasm` or nested worker via `new URL(..., import.meta.url)` must stay in `optimizeDeps.exclude` in `vite.config.ts`.
- **libraw-wasm ignores its `gamm` option.** LibRaw always outputs BT.709-gamma data; `libRawGammaInverse` in `rawDecoder.worker.ts` undoes it exactly. `userMul: [1,1,1,1]` must stay so LibRaw applies no white balance. `bright`, `noAutoBright`, `outputBps` and `outputColor` are honoured (verified empirically). It applies no DNG opcodes, so Optic applies them itself (`dngOpcodes.ts`).
- **WebGL texture-unit hygiene** (each rule fixed a real bug):
  - Every sampler a compiled stage declares must be bound on every draw. Use `res.dummy` when there is nothing to bind. Sampler uniforms keep their last unit per program, and a stale unit holding the render target makes WebGL reject the draw (black output). Helper passes go through `GpuKit.draw`, which binds every declared sampler.
  - Texture creation and uploads use unit 15. Stage textures are resolved before the image texture is bound.
  - RGBA32F/RG32F targets are only filterable with `OES_texture_float_linear`: read them with `texelFetch` (the kit creates them NEAREST otherwise); use 16F for anything sampled bilinearly.
- **v2 recipes must render bit-identically.** Every v3 field defaults to the identity, `migrateV2toV3` adds those defaults, and identity stages are not compiled. Verify after pipeline changes by rendering stored v2 recipes against a baseline.
- **Tiles must not seam.** Padding is a multiple of 4 and export tiles are multiples of 4, so downsampled helper grids (texture: factor 1, 2 or 4 only) align with output pixels in every tile. Large-radius effects use image-wide maps from the proxy, not per-tile blurs. Run `npm run test:seams` after touching spatial stages.
- The main thread must never block for more than about 100 ms. Large GPU uploads are chunked across frames (`uploadRGB` with 128-row chunks), because ANGLE converts RGB float uploads on the CPU. Shader programs, including helper shaders, are prefetched and compiled in the background (`KHR_parallel_shader_compile`), and the viewer skips frames rather than waiting for a compile (`Pipeline.isReady`). The histogram reads back asynchronously (pixel-pack buffer + fence). Image analysis (noise model, CA) runs in idle callbacks and stays under the budget (noise: ~60 ms on 12 MP).
- Export throws on a lost GPU context (out of memory) instead of writing zeros.

## Architecture

### Recipe = single source of truth (`src/recipe/`)
- `Recipe` (`schema.ts`, v3) is versioned and JSON-serialisable. `serialize.ts` migrates older versions step by step (`MIGRATIONS`), then `parseGroups` parses tolerantly and clamps every value. Presets reuse `parseGroups` for their partial recipes.
- v3 sections: `detail` (sharpen, nr), `effects` (texture, clarity, dehaze, grain, halation, bloom, vignette), `lens`, `geometry` (upright, guides, transform sliders, constrainCrop), `crop` (R-normalised rect, angle, aspect label, flips, rotate90).
- `defaultRecipe()` is the identity. `defaultsForSource(isRaw)` is what a freshly opened photo gets: raw files add sharpening 30, colour NR 25 and lens "Auto". `defaultRecipeFor(img)` adds As Shot WB.
- Preset groups (`PRESET_GROUPS`, `getGroup` / `setGroup`) map onto recipe fields:
  - `exposure` and `light` split the Light section, and `bw` = `treatment` + `bwMixer`.
  - `clarity` / `grain` / `glow` / `vignette` each own fields of `effects`; `sharpening` / `noiseReduction` split `detail`.
  - `PHOTO_SPECIFIC_GROUPS` (WB, exposure, NR, lens, geometry, crop) start unticked in the preset and paste dialogs.
- The UI only edits the recipe through `useEdit` (`src/state/editStore.ts`): `update` during a drag, `commit(label?)` on release (one named history step), `apply(fn, label?)` = update + commit. Rendering is a pure function of (image, recipe).
- Section eye toggles live in the recipe (`enabled`). `effectiveRecipe()` replaces disabled sections with their defaults before rendering, so stages never check toggles.
- WB temperature/tint mean different things by source: **Kelvin + DNG tint for RAW**, **relative −100…+100 for non-RAW**.
- Auto tools and droppers (`src/app/actions.ts`, `src/color/autoTools.ts`, `src/app/geometryActions.ts`) only write recipe values. They read pixels from the CPU thumbnail/full image (mapping output → source with `geometry/mapping.ts`), or from small GPU readbacks with `until: '<stageId>'`.

### History (`src/state/editStore.ts`, `describe.ts`)
- Per photo: `copies` (virtual copies), each with `steps` (label, recipe, time, key), `index` and `snapshots`. Undo/redo/jump move `index`; a new commit truncates the steps after it. Repeats of one control within 1.5 s collapse (same `key`). Capped at 500 steps.
- Labels come from `describeChange` (diff of recipes) or from the action (`apply(fn, 'Crop 4:5')`).
- The document is saved to IndexedDB (`docs` store, key `name|size|lastModified`, debounced) and loaded in parallel with decoding (`openDoc`). Stored recipes go through `deserializeRecipe` (migration).

### Decode (`src/io/decode/`)
- All decoders run in workers and output **linear float RGB (interleaved, 3 channels) in the source's own primaries**: camera RGB for RAW, ICC primaries otherwise. Output is already upright, plus a proxy (≤ 4096 px) and a thumbnail (≤ 384 px). Colour metadata travels as `ImageColor`:
  - RAW: a DNG-model `RawColorProfile` (ColorMatrix1/2, ForwardMatrix, CameraCalibration, AnalogBalance, illuminant temperatures, AsShotNeutral, BaselineExposure).
  - Non-RAW: an RGB→XYZ(D65) matrix from any matrix/TRC ICC profile (`io/metadata/icc.ts`), with sRGB as the fallback.
- `rawDecoder.worker.ts` is the RAW path. DNGs are parsed with our own `TiffReader` to get the colour profile and the lens profile (`dngOpcodes.ts`: WarpRectilinear, FixVignetteRadial, GainMap in raw coordinates). DNGs whose main IFD uses Compression 52546 (JPEG XL, newer iPhones) bypass LibRaw: `dngJxl.ts` decodes the tiles in a pool of `jxlTile.worker.ts` workers (jxl-oxide → 16-bit PNG → @jsquash/png) and assembles them.
- `imageDecoder.worker.ts` handles HEIC (libheif, high bit depth via `heif_js_decode_image2`), JPEG (MozJPEG decode, with EXIF orientation applied by us), PNG, TIFF (UTIF, which needs a global `pako`), and WebP/AVIF (browser decode with `colorSpaceConversion: 'none'`).
- `decodeClient.ts` does format detection, worker lifecycle, progress and cancel (terminating the worker).
- After load, `app/analysis.ts` measures the noise model and (on demand) lateral CA into `ImageModel.analysis`, and looks up a lensfun profile (`io/lens/lensfun.ts`, lazy JSON chunk) for raw files without opcodes.

### Geometry (`src/geometry/`)
- Spaces: output O → crop frame R → transformed T → undistorted U → source S. O → U is one projective matrix (`transform.ts`: crop, straighten, quarter turns, flips, upright homography K·R·K⁻¹). U → S is the lens model (`lens.ts`, mirrored in GLSL in stage 05). The source is sampled once.
- One output pixel = one R pixel: crops export at their exact pixel size. `mapping.ts` maps output → source (tools, detail textures, export tile regions) and keeps crops inside the image (`constrainCrop`).
- `upright.ts`: Hough line detection on a GPU Sobel map (`viewRenderer.edgeMap`) and a Nelder–Mead solve that writes the rotate/vertical/horizontal sliders.

### Pipeline (`src/pipeline/`)
- Working space: scene-linear **Rec.2020 D65**. Stages are one file each in `stages/`, ordered by `stages/index.ts`: input 00 → lens 05 → wb 10 → cw 20 → nr 22 → calibration 25 → colorCast 27 → dehaze 28 → tone 30 → texture/clarity 35 → hsl 40 → pointColor 45 → curve 50 → bwMixer 52 → colorGrading 55 → presence 60 → lut 70 → look 75 → halation/bloom 80 → vignette 82 → grain 84 → sharpening 86 → output 90.
  - The B&W mixer runs before grading on purpose (split tones need grading after the grey conversion), and stays at 52 for v2 bit-identity.
- **Stage 10 applies one fused matrix** = calibration · camera→working · WB (`derive.ts`). Stage 20 is never compiled but stays in the list as the `until: 'cw'` reference point. Clipped-highlight handling on the fused path uses `wbMul` / `lumaVec` / `neutralOut`.
- A `Stage` provides `{id, kind, glsl, active(ctx), uniforms(ctx), textures?, prepare?, reach?, maps?, helpers?, skipInMaps?}`. GLSL symbols and uniforms are prefixed with its `id`:
  - `kind: 'source'` defines `<id>_sample(vec2 px)`.
  - `'warp'` (stage 05) is compiled into the first pass behind `HAS_LENS`.
  - `'point'` defines `vec4 <id>_apply(vec4 c)`.
  - `'spatial'` defines `<id>_apply(sampler2D prev, ivec2 fc)`, may run helper passes in `prepare` (through `GpuKit`) and declares its `reach` in target pixels.
- `Pipeline.ts` generates shaders. Inactive stages are omitted entirely (zero cost). Consecutive point stages are fused into one pass; a spatial stage starts a new pass. Intermediate passes render a frame padded by the summed reach (edge-replicated outside the image); only the final pass paints the background.
- **Image-wide maps** (`MapSpec`: look 512 px, dehaze 512, clarity 1024, glow 1024): the pipeline up to `until`, rendered over the whole output frame from `mapSource` (the proxy) at a fixed density per source long edge, then post-processed by `build`. They are cached (2 slots per map) on the uniforms of every upstream stage. Preview, analysis renders and export tiles share them. `draftable` maps drop to half density while dragging.
- `ctx.pxScale` = full-res pixels per target pixel; every radius is a fraction of `ctx.longEdge` (24 MP reference = 6000 px), see docs/EFFECTS.md.
- With a `cache` slot (viewer: `main`, `before`, `draft`), pass outputs and spatial helper results are kept and skipped when their inputs did not change.
- **Alpha carries the source clipping mask** between stages (RAW clipped-highlight neutralisation in stage 10, non-RAW near-white clip handling).
- The `view` matrix maps local fragment coordinates to **output pixels** (the cropped, transformed image); the source texture declares which source region it covers. One renderer serves every use:
  - Preview (`ui/canvas/viewRenderer.ts`) renders at canvas size from a mipmapped RGBA16F proxy (RGBA16F intermediates). At ≥ 100 % zoom it switches to a full-resolution detail texture of the source area behind the visible output. Draft frames render at half resolution while dragging heavy effects; compare views render the Before recipe beside (`origin`) or under (`scissor`) the edit.
  - Histogram, pixel readout, analysis and preset thumbnails use small FBO renders with float readback.
  - Export (`io/encode/exportRender.ts`) renders 1024 px tiles of the output at 1:1 (RGBA32F intermediates). Each tile's source area is the padded tile mapped through the transform, plus a 40 px margin. It reads back RGBA32F and quantises to Uint16.
- The pipeline is DOM-free, so the same code runs in `exportWorker.ts` on an OffscreenCanvas, with a main-thread fallback.
- Defaults that matter for "export never worse than source":
  - The tone stage is the identity for non-RAW at default (the shoulder maps the source white W to 1.0, and W = 1). RAW always gets a gentle base contrast.
  - Output-stage gamut compression (OKLCH bisection) is skipped when a non-RAW source is rendered in its own space with no colour-expanding edits.

### Export (`src/io/encode/`)
- TIFF 16-bit (our own writer, ZIP + predictor), PNG 16-bit (our own encoder using CompressionStream, with iCCP + eXIf), and JPEG via MozJPEG.
- JPEG uses `quant_table: 0` with trellis off. MozJPEG's defaults strip the TPDF dither and reintroduce banding (measured). Quality ≥ 90 uses 4:4:4.
- ICC v4 profiles are generated in code (`buildIcc`). EXIF is written through our own IFD writer (`io/metadata/tiffWriter.ts`).
  - JPEG source + "keep all": the original APP1 is copied verbatim and patched in place (`patchExif`).
  - Otherwise: the tags exifr read are re-serialised.
  - Orientation is always written as 1 (pixels are exported upright).
- `exportClient.ts` asks for the File System Access save handle *before* any await, since it needs the click's user activation. It falls back to `<a download>`. Virtual copies export under their own name.

### Presets (`src/presets/`, `src/state/presetStore.ts`)
- Built-ins are JSON files in `src/presets/builtin/<group>/` (format version 3; version 2 files load unchanged), loaded with `import.meta.glob`. They are the source of truth: edit them directly. Adding a file ships a new built-in. User presets and imported LUTs live in IndexedDB (`src/storage/db.ts`), and `.opticpack` is a plain zip (`src/storage/zip.ts`).
- `applyPreset` records `appliedPreset = {base, target, groups, amount}` in the recipe. The amount slider re-interpolates from it (`interpolate`):
  - curves resampled to 32 points
  - wheels in vector space
  - exactly 0 % / 100 % short-circuit to base / target
- Non-RAW photos get `NON_RAW_SCALE = 0.75` applied to saturation, contrast and calibration changes, then the preset's optional `nonRaw` overrides.
- Hover preview sets `uiStore.previewRecipe` (never committed). `ui/canvas/displayed.ts` decides what the canvas shows: before, preview, edit, crop-tool frame, compare Before, or a mask view.
- LUT data lives in `lutRegistry` (DOM-free), keyed by the id the recipe stores. The export worker receives the LUTs it needs with the job.

## Adding a pipeline stage

1. Create `stages/NN_name.ts` and insert it in `stages/index.ts`.
2. Add recipe fields with defaults that make `active()` false, plus parsing in `serialize.ts` (bump `RECIPE_VERSION` with a migration if the change isn't additive).
3. Add a panel in `src/ui/panels/` using `bindSection`/`useEdit`.
4. For presets / copy-paste, add a group in `PRESET_GROUPS` + `getGroup` / `setGroup` + `GROUP_LABELS`.
5. Spatial: implement `reach`, put helper shaders in `helpers`, and keep radii a fraction of `ctx.longEdge`. Large radius: use a `MapSpec` instead of a per-render blur. Then run `npm run test:seams`.

Preview, export, histogram, thumbnails and auto tools pick up the stage automatically. Shared GLSL helpers live in `pipeline/glslCommon.ts`, `color/oklab.ts` and `pipeline/gl/guidedFilter.ts`.

## Known gaps

- Not yet verified with real Android 10-bit HEIC, CR3, ARW, real JPEG-XL ProRAW, or 48 MP performance on M1/iPad.
- DNG opcode corrections, lensfun profiles, upright and noise reduction were verified on synthetic images (no ultra-wide, building or high-ISO sample yet). GainMaps with 4 CFA phases need a CFAPattern; others fall back to one grey map.
- With every effect on, a full-quality frame at 48 MP costs ~33 ms on an Intel UHD 730 (drags use draft frames at 60 fps).
- Apple's ProfileToneCurve (tag 50940) is not applied; Optic uses its own base tone.
- Built-in presets were tuned against one indoor portrait plus synthetic charts. They still need a pass on landscape, night and tungsten photos.
- WebP/AVIF decode at 8-bit. HDR (PQ/HLG) sources render as SDR.
