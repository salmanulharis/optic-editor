# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Optic: a client-side browser photo editor for RAW (Apple ProRAW and other DNGs, CR2/CR3, NEF, ARW, …) and HEIC/JPEG/PNG/TIFF/WebP/AVIF.
Stack: Vite + React 18 + TypeScript (strict), Zustand, WebGL2 float pipeline, Web Workers via Comlink, and WASM codecs (libraw-wasm, jxl-oxide-wasm, libheif-js, @jsquash/jpeg + png, UTIF).
All four phases are done:
- Phase 1: the foundation (decode, GPU pipeline, live preview, export).
- Phase 2: colour science plus presets (calibration, point colour, grading, B&W, 3D LUTs, look layer, 64 built-in presets).
- Phase 3: detail (sharpening, noise reduction), effects (texture, clarity, dehaze, grain, halation, bloom, vignette), lens corrections, upright/transform, crop & straighten, history, snapshots, virtual copies and compare views.

- Phase 4: library/catalog (Dexie + OPFS), import, batch editing, the batch export queue, local adjustments with AI masks (recipe v4, stage 78), PWA/offline, the touch layout, settings, the shortcuts overlay and the test suites.

New features go in as new stages, recipe fields and panels, not rewrites.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the overview (storage, workers, library, export, AI, PWA). [docs/COLOR.md](docs/COLOR.md), [docs/EFFECTS.md](docs/EFFECTS.md) and [docs/PRESETS.md](docs/PRESETS.md) document the colour model, the Phase 3 tools (including the resolution-independence rules) and the preset format. [docs/USER_GUIDE.md](docs/USER_GUIDE.md) is for users; [LICENSES.md](LICENSES.md) lists libraries and AI models.

## Commands

```bash
npm run dev            # http://localhost:5173 (sends the COOP/COEP headers)
npm run build          # tsc -b && vite build
npm run preview        # serve dist/ on :4173 (also sends COOP/COEP)
npm run typecheck      # tsc -b --noEmit
npm test               # Vitest unit tests (tests/unit: migrations, colour maths, gamut, export dims, zip)
npm run test:e2e       # Playwright (tests/e2e) in real Chrome/Edge with GPU; CHROME_CHANNEL=msedge for Edge
npm run test:seams     # tiled vs untiled export, every spatial effect and mask kind at 100; exits 1 on a seam
npm run bench          # 48 MP synthetic: preview fps while dragging (incl. 16 masks), export time
npm run lensfun:subset # regenerate src/io/lens/lensfun-subset.json from the lensfun database
npm run models:fetch   # optional: AI models into public/models (gitignored) for self-hosting
npm run icons          # PWA icons + Apple splash screens from public/icons/optic.svg
```

`test:seams` and `bench` start Vite programmatically and drive `bench.html` (dev-only page, `src/bench/`) in headless Chrome/Edge via `playwright-core`. Set `CHROME_PATH` or `CHROME_CHANNEL` to choose the browser.
There is no linter. Ad-hoc verification drives the app in headless Chromium/Edge with playwright-core.
In dev builds, `window.__optic` exposes the stores (edit, image, ui, library, presets), the preset engine, the mask and geometry actions, batch, importer, previews, open and the renderer (`main.tsx`, gated on `import.meta.env.DEV`). Use these handles in tests: a page-side `import('/src/...')` can return a second module instance, because Vite adds `?t=` to edited modules.
- Dev only: React StrictMode's double mount logs "glGetProgramiv: Program object expected" warnings. Production builds log none.
- A first-launch tour opens until `optic.settings.onboardingDone` is set in localStorage (tests set it).
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
- **Older recipes must render bit-identically.** Every later field defaults to the identity: `migrateV2toV3` adds the v3 defaults and `migrateV3toV4` adds `masks: []`. Identity stages are not compiled. Verify after pipeline changes by hashing full-resolution renders of stored v2/v3 recipes against a baseline, for example from a `git worktree` of the previous commit.
- **Tiles must not seam.** Padding is a multiple of 4 and export tiles are multiples of 4, so downsampled helper grids (texture: factor 1, 2 or 4 only) align with output pixels in every tile. Large-radius effects use image-wide maps from the proxy, not per-tile blurs. Run `npm run test:seams` after touching spatial stages.
- The main thread must never block for more than about 100 ms. Large GPU uploads are chunked across frames (`uploadRGB` with 128-row chunks), because ANGLE converts RGB float uploads on the CPU. Shader programs, including helper shaders, are prefetched and compiled in the background (`KHR_parallel_shader_compile`), and the viewer skips frames rather than waiting for a compile (`Pipeline.isReady`). The histogram reads back asynchronously (pixel-pack buffer + fence). Image analysis (noise model, CA) runs in idle callbacks and stays under the budget (noise: ~60 ms on 12 MP).
  - Phase 4 keeps it that way. These run in workers:
    - import hashing, metadata and quick previews (`library/import.worker.ts`, pooled)
    - noise and CA analysis (`app/analysis.worker.ts`)
    - library preview renders (`library/render.worker.ts`)
    - OPFS writes (`library/opfs.worker.ts`)
    - ONNX inference (`ai/ai.worker.ts`)

    A bulk import of 150 photos measured zero long tasks.
- Export throws on a lost GPU context (out of memory) instead of writing zeros. The viewer rebuilds its renderer on `webglcontextrestored` (`glGen` in `Viewer.tsx`).
- **Shader budgets for masks**: at most 16 masks, 32 components and 12 brush components (`recipe/masks.ts`). Mask GLSL uses constant indices only: dynamically indexed local arrays spilled registers on Intel (measured 25 vs 15 ms).
- **ONNX Runtime runs single-threaded** in its worker: threaded WASM spawns nested workers that stall inside a module worker. Its WASM and MediaPipe's are served from `/vendor/` by a Vite plugin (`vite.config.ts`).
- Comlink-transferred buffers are detached: read `.length` before `appendFile` / `writeFile`. A ZIP offset bug came from this.
- React's event `currentTarget` is null inside a deferred `setState` updater: read the values first. A grid scroll crash came from this.

## Architecture

### Recipe = single source of truth (`src/recipe/`)
- `Recipe` (`schema.ts`, v3) is versioned and JSON-serialisable. `serialize.ts` migrates older versions step by step (`MIGRATIONS`), then `parseGroups` parses tolerantly and clamps every value. Presets reuse `parseGroups` for their partial recipes.
- v3 sections: `detail` (sharpen, nr), `effects` (texture, clarity, dehaze, grain, halation, bloom, vignette), `lens`, `geometry` (upright, guides, transform sliders, constrainCrop), `crop` (R-normalised rect, angle, aspect label, flips, rotate90).
- v4: `masks` (`recipe/masks.ts`). Components live in the undistorted frame U (0…1), so they follow geometry:
  - gradients as parameters
  - brush strokes as paths (x, y, pressure)
  - colour / luminance ranges in OKLab
  - AI components by `cacheKey` (photo key + model) into `pipeline/maskRegistry.ts`

  `masks` is a preset / sync group, but photo-specific (unticked by default). Rating, flag, label and keywords live on the catalog record, never in the recipe.
- `defaultRecipe()` is the identity. `defaultsForSource(isRaw)` is what a freshly opened photo gets: raw files add sharpening 30, colour NR 25 and lens "Auto". `defaultRecipeFor(img)` adds As Shot WB.
- Preset groups (`PRESET_GROUPS`, `getGroup` / `setGroup`) map onto recipe fields:
  - `exposure` and `light` split the Light section, and `bw` = `treatment` + `bwMixer`.
  - `clarity` / `grain` / `glow` / `vignette` each own fields of `effects`; `sharpening` / `noiseReduction` split `detail`.
  - `PHOTO_SPECIFIC_GROUPS` (WB, exposure, NR, lens, geometry, crop) start unticked in the preset and paste dialogs.
- The UI only edits the recipe through `useEdit` (`src/state/editStore.ts`): `update` during a drag, `commit(label?)` on release (one named history step), `apply(fn, label?)` = update + commit. Rendering is a pure function of (image, recipe).
- Section eye toggles live in the recipe (`enabled`). `effectiveRecipe()` replaces disabled sections with their defaults before rendering, so stages never check toggles.
- WB temperature/tint mean different things by source: **Kelvin + DNG tint for RAW**, **relative −100…+100 for non-RAW**. Batch sync and match look convert between them (`relativeToTempTint` / `tempTintToRelative`).
- `defaultRecipeFor(img)` also applies the Settings defaults for new RAW / non-RAW photos (sharpening, noise reduction, lens auto).
- Auto tools and droppers (`src/app/actions.ts`, `src/color/autoTools.ts`, `src/app/geometryActions.ts`) only write recipe values. They read pixels from the CPU thumbnail/full image (mapping output → source with `geometry/mapping.ts`), or from small GPU readbacks with `until: '<stageId>'`.

### History (`src/state/editStore.ts`, `describe.ts`)
- Per photo: `copies` (virtual copies), each with `steps` (label, recipe, time, key), `index` and `snapshots`. Undo/redo/jump move `index`; a new commit truncates the steps after it. Repeats of one control within 1.5 s collapse (same `key`). Capped at 500 steps.
- Labels come from `describeChange` (diff of recipes) or from the action (`apply(fn, 'Crop 4:5')`).
- The document is saved to the catalog DB (`catalog.docs`, keyed by the photo's `key`) and loaded in parallel with decoding (`openDoc`).
  - Saves are debounced by 400 ms and flushed on pagehide.
  - Phase 1–3 documents in the old `optic` / `docs` store are read as a fallback.
  - Stored recipes go through `deserializeRecipe` (migration).
  - `onDocSaved` lets the library mirror the main copy's recipe into the photo record.
- A catalog photo's `key` is fixed at import (`name|size|lastModified` of the imported file). Pass it to `useImage.load(file, edge, { key, photoId })`: OPFS copies have a new lastModified.

### Decode (`src/io/decode/`)
- All decoders run in workers and output **linear float RGB (interleaved, 3 channels) in the source's own primaries**: camera RGB for RAW, ICC primaries otherwise. Output is already upright, plus a proxy (≤ 4096 px) and a thumbnail (≤ 384 px). Colour metadata travels as `ImageColor`:
  - RAW: a DNG-model `RawColorProfile` (ColorMatrix1/2, ForwardMatrix, CameraCalibration, AnalogBalance, illuminant temperatures, AsShotNeutral, BaselineExposure).
  - Non-RAW: an RGB→XYZ(D65) matrix from any matrix/TRC ICC profile (`io/metadata/icc.ts`), with sRGB as the fallback.
- `rawDecoder.worker.ts` is the RAW path. DNGs are parsed with our own `TiffReader` to get the colour profile and the lens profile (`dngOpcodes.ts`: WarpRectilinear, FixVignetteRadial, GainMap in raw coordinates). DNGs whose main IFD uses Compression 52546 (JPEG XL, newer iPhones) bypass LibRaw: `dngJxl.ts` decodes the tiles in a pool of `jxlTile.worker.ts` workers (jxl-oxide → 16-bit PNG → @jsquash/png) and assembles them.
- `imageDecoder.worker.ts` handles HEIC (libheif, high bit depth via `heif_js_decode_image2`), JPEG (MozJPEG decode, with EXIF orientation applied by us), PNG, TIFF (UTIF, which needs a global `pako`), and WebP/AVIF (browser decode with `colorSpaceConversion: 'none'`).
- `decodeClient.ts` does format detection, worker lifecycle, progress and cancel (terminating the worker).
- After load, `app/analysis.ts` measures the noise model and (on demand) lateral CA into `ImageModel.analysis`, and looks up a lensfun profile (`io/lens/lensfun.ts`, lazy JSON chunk) for raw files without opcodes.

### Library (`src/library/`, `state/libraryStore.ts`)
- **Catalog**: Dexie DB `optic-catalog` (`library/db.ts`) with tables `photos`, `docs`, `collections`, `exportPresets`, `exportQueue` and `kv`. Originals and previews live in OPFS (`originals/<id>/<name>`, `previews/<id>/{thumb,preview}`), written through `opfs.worker.ts` (sync access handles).
- **Import** (`importer.ts`): dialog → queue → hash and duplicate check → copy or keep the handle → quick preview (embedded JPEG or browser decode) → record → `enqueuePreviews`.
  - Optic's own 2560 / 512 px previews render in `previews.ts`, paused while dragging, decoding or exporting.
  - A preset chosen at import is stored as `pendingPreset` and applied on first decode, because it needs As Shot WB.
- The whole catalog is in memory; `visiblePhotos()` does source → filter → sort, memoised. The grid and the filmstrip are virtualised.
  - Zustand selectors must return stable values: a `.filter()` inside a selector causes an infinite render loop.
- **Batch** (`batch.ts`): `editPhotos(ids, label, fn)` adds one history step per photo. The open photo goes through `useEdit`, others through their documents; `needPixels` decodes. Sync, paste, presets, auto WB / tone, match look, reset and Auto Sync are built on it.
- **Export queue** (`exportQueue.ts`):
  - one photo at a time
  - destination: a folder (FSA) or a streamed ZIP in OPFS (`storage/zipStream.ts`, ZIP64)
  - saved after each photo, so it can resume
  - recipe packs and `.optic.json` sidecars live in `recipePack.ts`

### AI masks (`src/ai/`)
- `ensureAiMask(model)` reads the IDB cache (`aimasks`) or runs the model:
  - subject / sky: ONNX U²-Net in `ai.worker.ts`
  - person / parts: MediaPipe on the main thread
- The input is the photo with neutral settings in the U frame (`runModels.ts`). The output is an RGBA8 bitmap of about 1024 px, with channels per `aiChannelFor`.
- Models are listed in `ai/models.ts` (licences in LICENSES.md) and cached in Cache Storage `optic-models-v1`.

### Geometry (`src/geometry/`)
- Spaces: output O → crop frame R → transformed T → undistorted U → source S. O → U is one projective matrix (`transform.ts`: crop, straighten, quarter turns, flips, upright homography K·R·K⁻¹). U → S is the lens model (`lens.ts`, mirrored in GLSL in stage 05). The source is sampled once.
- One output pixel = one R pixel: crops export at their exact pixel size. `mapping.ts` maps output → source (tools, detail textures, export tile regions) and keeps crops inside the image (`constrainCrop`).
- `upright.ts`: Hough line detection on a GPU Sobel map (`viewRenderer.edgeMap`) and a Nelder–Mead solve that writes the rotate/vertical/horizontal sliders.

### Pipeline (`src/pipeline/`)
- Working space: scene-linear **Rec.2020 D65**. Stages are one file each in `stages/`, ordered by `stages/index.ts`: input 00 → lens 05 → wb 10 → cw 20 → nr 22 → calibration 25 → colorCast 27 → dehaze 28 → tone 30 → texture/clarity 35 → hsl 40 → pointColor 45 → curve 50 → bwMixer 52 → colorGrading 55 → presence 60 → lut 70 → look 75 → halation/bloom 80 → vignette 82 → grain 84 → sharpening 86 → output 90.
  - The B&W mixer runs before grading on purpose (split tones need grading after the grey conversion), and stays at 52 for v2 bit-identity.
  - Stage 78 `loc` (local adjustments, spatial) sits between look 75 and halation/bloom 80.
    - Helper passes build all masks in one MRT draw (`GpuKit.drawMRT`) from:
      - gradients, analytic in U
      - ranges, in OKLab
      - the brush map (`locBrush`, rendered `until: 'lens'`; a base raster is cached so painting draws only the new stroke)
      - AI bitmaps, refined by a fast guided filter on a grid of factor 1, 2 or 4
    - The final pass applies each mask's adjustments in display-linear light.
    - The optional `Stage.prepKey` keeps the helper passes cached while only mask sliders change.
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
- The pipeline is DOM-free, so the same code runs in `exportWorker.ts` and `library/render.worker.ts` on an OffscreenCanvas, with a main-thread fallback.
- Defaults that matter for "export never worse than source":
  - The tone stage is the identity for non-RAW at default (the shoulder maps the source white W to 1.0, and W = 1). RAW always gets a gentle base contrast.
  - Output-stage gamut compression (OKLCH bisection) is skipped when a non-RAW source is rendered in its own space with no colour-expanding edits.

### Export (`src/io/encode/`)
- Formats:
  - TIFF 16-bit (our own writer, ZIP + predictor)
  - PNG 16-bit (our own encoder using CompressionStream, with iCCP + eXIf + pHYs + XMP)
  - JPEG via MozJPEG
  - AVIF 10-bit (@jsquash/avif, 16-bit input)
  - JPEG XL (@jsquash/jxl, 8-bit)

  AVIF and JPEG XL carry no ICC or EXIF (encoder limits), so they are sRGB-only. No HEIC encoder exists.
- `exportSettings.ts` defines:
  - sizes, including exact W × H (a centre crop)
  - output sharpening
  - metadata modes: keep / stripGps / copyright / strip
  - author + copyright (EXIF + XMP), dpi
  - file-name template tokens, watermark
  - the built-in export presets

  Post-processing runs in `postprocess.ts` (in the worker).
- JPEG uses `quant_table: 0` with trellis off. MozJPEG's defaults strip the TPDF dither and reintroduce banding (measured). Quality ≥ 90 uses 4:4:4.
- ICC v4 profiles are generated in code (`buildIcc`). EXIF is written through our own IFD writer (`io/metadata/tiffWriter.ts`).
  - JPEG source + "keep all": the original APP1 is copied verbatim and patched in place (`patchExif`).
  - Otherwise: the tags exifr read are re-serialised.
  - Orientation is always written as 1 (pixels are exported upright).
- `exportClient.ts` asks for the File System Access save handle *before* any await, since it needs the click's user activation. It falls back to `<a download>`. Virtual copies export under their own name.

### PWA, mobile, settings
- **PWA**: `vite-plugin-pwa` in injectManifest mode, with `src/sw.ts`. The service worker:
  - precaches about 54 MB, including the WASM runtimes;
  - adds COOP / COEP / CORP to everything it serves;
  - caches model files;
  - handles the Web Share Target (`/share-target` POST → Cache Storage → `/?share=1`);
  - waits for the user's update prompt (`app/pwa.ts`).

  The manifest has `file_handlers` and `share_target`. Deploy headers live in `public/_headers`, `vercel.json` and `netlify.toml`.
- **Touch layout** (`ui/mobile/`), used below 900 px wide or on a phone in landscape:
  - bottom tabs + `BottomSheet`
  - slider touch: relative row swipe, double-tap reset, a haptic tick at the default
  - viewer gestures in `Viewer.tsx`
  - on iOS: proxy ≤ 2560, export tiles 512
- **Settings** (`state/settingsStore.ts`, localStorage): theme, defaults for new photos, preview quality, default export preset.
  - Themes use CSS-variable tokens (`index.css`, `tailwind.config.js`): use `bg-panel`, `text-ink`, `bg-hover`, …, not hex.
  - i18n lives in `src/i18n/` (English).
  - The shortcut list is `app/shortcuts.ts`; keep it in step with `keyboard.ts`.

### Presets (`src/presets/`, `src/state/presetStore.ts`)
- Built-ins are JSON files in `src/presets/builtin/<category>/` (`bw`, `cinematic`, `film`, `hasselblad`, `leica`, `zeiss`; browser categories ordered by `BUILTIN_GROUP_ORDER`, not the recipe `PRESET_GROUPS`), format version 3 (version 2 files load unchanged), loaded with `import.meta.glob` in `builtin/index.ts`. They are the source of truth: edit them directly. Adding a file ships a new built-in. User presets and imported LUTs live in IndexedDB (`src/storage/db.ts`), and `.opticpack` is a plain zip (`src/storage/zip.ts`).
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

- The Safari / iPhone / iPad paths (touch layout, OPFS sync handles, share target, iOS memory caps, 48 MP tiled export) were built but only tested in desktop Chromium with mobile emulation.
- The sky model marks large, pale, smooth areas (indoor walls) as sky. Background previews of photos that are not open use cached AI bitmaps only (no inference).
- Preview with 16 masks: dragging a mask slider holds 60 fps; global drags with many masks drop to about 20–40 fps on an Intel UHD 730 (draft frames help).

- Not yet verified with real Android 10-bit HEIC, CR3, ARW, real JPEG-XL ProRAW, or 48 MP performance on M1/iPad.
- DNG opcode corrections, lensfun profiles, upright and noise reduction were verified on synthetic images (no ultra-wide, building or high-ISO sample yet). GainMaps with 4 CFA phases need a CFAPattern; others fall back to one grey map.
- With every effect on, a full-quality frame at 48 MP costs ~33 ms on an Intel UHD 730 (drags use draft frames at 60 fps).
- Apple's ProfileToneCurve (tag 50940) is not applied; Optic uses its own base tone.
- Built-in presets were tuned against one indoor portrait plus synthetic charts. They still need a pass on landscape, night and tungsten photos.
- WebP/AVIF decode at 8-bit. HDR (PQ/HLG) sources render as SDR.
