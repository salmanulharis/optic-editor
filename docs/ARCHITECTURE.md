# Optic architecture

Optic is a client-side photo editor and library: Vite + React 18 + TypeScript (strict), Zustand
stores, a WebGL2 float pipeline, workers through Comlink, and WASM codecs. This document describes
how the parts fit together. Two companion documents cover specific areas:
- [COLOR.md](COLOR.md): the colour model.
- [EFFECTS.md](EFFECTS.md): the Phase 3 tools and the resolution-independence rules.

```
              ┌─────────── Library (Dexie catalog + OPFS) ───────────┐
 import ──►   │ originals · previews · records · docs (history)       │ ◄── batch edits, sync
              └──────────────┬───────────────────────────────────────┘
                             │ open
 file ──► decode worker ──► linear float RGB (SharedArrayBuffer) + proxy + thumbnail
                             │
       Recipe (Zustand) ──► Pipeline.render(image, recipe) ──► canvas     (preview, per frame)
                             │                               └► tiles      (export worker, full res)
                             │                               └► previews   (render worker, 2560 px)
                             └► small renders: histogram, readouts, auto tools, AI mask input
```

## Hard constraints

- **Cross-origin isolation.** Every response must carry these headers:

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

  LibRaw-WASM uses threads (SharedArrayBuffer), and the decoded image lives in a SharedArrayBuffer
  that workers read without copying. Where the headers are set:
  - the Vite dev and preview servers;
  - `public/_headers` (Netlify, Cloudflare Pages) and `vercel.json`;
  - the service worker, which adds them to everything it serves from cache.
- **The main thread never blocks for more than ~100 ms.** These all run in workers: decoding,
  import hashing, metadata and quick previews, image analysis, preview rendering, export rendering
  and encoding, AI inference (ONNX) and OPFS writes. MediaPipe runs on the main thread with small
  inputs (about 30 ms).
- **Old recipes render bit-identically.** Each recipe version's additions default to the identity,
  and identity stages are not compiled. This was verified by hashing full-resolution renders of
  stored v2 / v3 recipes on the Phase 3 code and on the current code.

## The recipe (`src/recipe/`)

`Recipe` (`schema.ts`) is the complete, JSON-serialisable description of an edit. Rendering is a
pure function of (image, recipe). The UI edits it only through `useEdit` (`state/editStore.ts`):
- `update` while dragging;
- `commit(label?)` on release, which records one named history step;
- `apply(fn, label?)`, which does both.

| Version | Phase | Adds |
|---|---|---|
| 1 | 1 | WB, light, HSL, curve, presence, output |
| 2 | 2 | look, treatment + B&W mixer, point colour, colour grading, calibration, LUT, applied preset |
| 3 | 3 | detail, effects, lens, geometry, crop |
| 4 | 4 | `masks` (local adjustments) |

`serialize.ts` upgrades step by step: `MIGRATIONS[n]` turns version n JSON into n+1. It then parses
tolerantly: unknown fields are dropped, missing fields get their defaults and values are clamped.
v3 → v4 adds `masks: []`, which leaves stage 78 out of the shader. Recipes from a newer version are
rejected with a clear error. The tests in `tests/unit/recipe.test.ts` cover every migration.

Photo metadata (rating, flag, colour label, keywords) belongs to the photo, not the edit. It lives
in the catalog record and in recipe packs, and is never part of a recipe or a preset.

### Masks (`recipe/masks.ts`)

```
masks: Array<{ id, name, visible, invert, amount (0–200 %),
               components: Array<{ id, op: add|subtract|intersect, type, invert, params, cacheKey? }>,
               adjustments: { temp, tint, exposure, contrast, highlights, shadows, whites, blacks,
                              texture, clarity, dehaze, hue, saturation, tintColor: {hue, amount},
                              sharpness, noise } }>
```

Geometry is stored in the **undistorted source frame U** (see `geometry/transform.ts`), normalised
to 0…1. Masks therefore follow crop, straighten, upright and transform automatically.

| Component | Stored as |
|---|---|
| Linear / radial gradient | Parameters |
| Brush | Strokes as vector paths: `(x, y, pressure)` per point, plus size, feather, flow, density and auto-mask |
| Colour / luminance range | OKLab targets and ranges |
| AI masks | A `cacheKey` (photo key + model) pointing to a ~1024 px bitmap in the mask registry, computed again when missing |

The shader budget is 16 masks, 32 components and 12 brush components.

## The pipeline (`src/pipeline/`)

Working space: scene-linear Rec.2020 D65. Each stage is one file in `stages/`, ordered by
`stages/index.ts`. Stages are `source` (00), `warp` (05, compiled into the first pass), `point`
(fused into one fragment shader) or `spatial` (starts a new pass and may run helper passes in
`prepare`). Inactive stages are not compiled. See [COLOR.md](COLOR.md) and [EFFECTS.md](EFFECTS.md)
for each stage. Phase 4 adds:

**Stage 78 `loc` (local adjustments)** is spatial, placed after the look layer and before the
glow, vignette and grain effects.

1. **Helper passes over the padded intermediate frame:**
   - lightness, only when the detail adjustments or AI refinement need it;
   - for each AI bitmap, a fast guided filter. Its statistics live on a grid 1, 2 or 4 times coarser
     than the frame, so tiles stay aligned and seamless. The guide is the image's full-resolution
     lightness, which is how AI edges follow hair at 100 %.
   - **one multiple-render-target draw** (`GpuKit.drawMRT`) that evaluates all 16 masks into four
     RGBA16F targets:
     - gradients analytically in U (output pixel → U through `geo.oToU`);
     - colour and luminance ranges in OKLab;
     - brushes from an image-wide map;
     - AI from the refined coefficients.

     The shader uses constant indices only: dynamically indexed local arrays spilled registers on an
     Intel GPU (measured).
2. **The final pass** applies each mask's adjustments in display-linear light: WB as luminance-
   preserving gains, exposure, tone EV offsets, clarity from an image-wide guided-filter base,
   dehaze from a dark-channel map, then hue, saturation and tint in OKLab. Sharpness and noise
   reduction use small in-shader kernels; texture uses a Gaussian helper. Any gain above white rolls
   off instead of clipping. The mask overlay (colour or B&W) is drawn here too.
3. **Brush map** (`locBrush`, 2048 px per source long edge): rendered `until: 'lens'`, so editing
   the colour does not re-rasterise strokes. Strokes are rasterised on the GPU with premultiplied
   blending, scissored to their bounds, three brush components per RGBA target. A base raster holds
   everything except each component's last stroke, so painting only draws the new stroke.
4. **`prepKey`** (a new optional `Stage` hook): the helper passes depend on the masks' geometry, not
   on their adjustment sliders. Dragging a mask slider therefore re-runs only the final pass
   (60 fps with 16 masks on an Intel UHD 730).
5. **Seams**: the seam test (`npm run test:seams`) includes masks of every spatial kind, and the
   difference between tiled and untiled export is exactly 0.

Other pipeline additions:
- `StageResources.aiMask(key)`
- `PassInput.view` (frame pixel → output pixel, for helpers that need image coordinates)
- `OutputTarget.maskOverlay`
- `pipeline/maskRegistry.ts`, the DOM-free bitmap registry (like `lutRegistry`). Export and preview
  workers receive the bitmaps they need with the job.

## Storage

| Store | What | Notes |
|---|---|---|
| **Catalog DB** `optic-catalog` (Dexie, `library/db.ts`) | `photos` (records), `docs` (edit documents: history, snapshots, virtual copies), `collections`, `exportPresets`, `exportQueue`, `kv` | Records hold the file reference, content hash, EXIF summary, rating / flag / label / keywords / collections, a mirror of the main copy's current recipe (filters, info panel), preview versions |
| **OPFS** (`library/opfs.ts`) | `originals/<id>/<name>` (Copy into Optic), `previews/<id>/{thumb,preview}`, `exports/current.zip` | Writes go through `opfs.worker.ts` (sync access handles: Safari and Firefox support them in workers) |
| **Legacy IDB** `optic` (`storage/db.ts`) | user presets, imported LUTs, `aimasks` (computed AI bitmaps), Phase 1–3 `docs` (read once as a fallback) | |
| **Cache Storage** | `optic-models-v1` (AI models), `optic-shared` (Web Share Target hand-off), Workbox precache | |
| **localStorage** | settings (`state/settingsStore.ts`), favourites, offline-ready flag | Per-device conveniences only |

Edits are saved with a 400 ms debounce and flushed on `pagehide` / `visibilitychange`. The library
writes through on every change. `navigator.storage.persist()` is requested on start-up, and its
state is shown in Settings.

## Library (`src/library/`, `state/libraryStore.ts`)

- **Import** (`importer.ts`):
  - files come from the pickers (File System Access where available), `<input webkitdirectory>`,
    or drag and drop (handles or `webkitGetAsEntry` for folders);
  - the dialog shows thumbnails, duplicates and options;
  - a background queue processes one file at a time:
    1. hash and duplicate check;
    2. copy to OPFS, or keep the handle;
    3. metadata and quick preview (embedded camera JPEG, or the browser decode), done in the
       `import.worker.ts` pool;
    4. add the catalog record;
    5. queue Optic's own render.
- **Previews** (`previews.ts`):
  - one photo at a time: decode (`decode.ts`, same decoders and analysis as the editor), then
    render 2560 + 512 px in `render.worker.ts`, then write to OPFS;
  - paused while the user drags, while the editor decodes and while an export runs;
  - the open photo is re-rendered from its proxy 2 s after edits pause;
  - a preset chosen at import is applied on first decode, because it needs the photo's As Shot WB.
- **State**: the whole catalog is in memory; 10 000 records take a few MB. `visiblePhotos()`
  filters and sorts the list, memoised (2 ms for 10 000). The grid and the filmstrip are virtualised;
  only the rows in view are mounted (60 fps scroll with 10 000 photos).
- **Opening a photo** (`open.ts`): resolves the file (OPFS, or the handle with a permission prompt),
  loads it with the catalog key as the document identity, applies a pending preset, and recomputes
  missing AI bitmaps. `onDocSaved` mirrors every document save into the record.
- **Batch editing** (`batch.ts`):
  - `editPhotos(ids, label, fn)` applies one history step per photo: through `useEdit` for the open
    photo, through the stored document for the others, decoding when pixels are needed.
  - Built on it: sync, paste, presets, auto WB and tone, match look (median log luminance before
    exposure, plus the WB offset from each photo's neutral estimate in mireds, converted between
    Kelvin and relative WB), and reset.
  - Auto Sync repeats committed changes of the open photo on the selection. It ignores undo, redo
    and the batch's own edits.
  - AI cache keys are re-keyed for each target photo.

## Export (`src/io/encode/`, `library/exportQueue.ts`)

- `renderAndEncode()` sends the full-resolution image (shared memory) plus the proxy (for image-wide
  maps), LUTs and AI bitmaps to `exportWorker.ts`, which:
  1. renders tiles (1024 px; 512 on iOS);
  2. crops to an exact aspect if asked;
  3. area-resamples;
  4. applies output sharpening (luminance unsharp mask per medium);
  5. composites the watermark;
  6. encodes:

  | Format | Encoder | Embeds |
  |---|---|---|
  | TIFF 16 | Own writer | ICC, EXIF, dpi, XMP |
  | PNG 16 | Own writer | iCCP, eXIf, pHYs, iTXt XMP |
  | JPEG | MozJPEG | ICC, EXIF, XMP |
  | AVIF 10-bit | libavif | sRGB only, no metadata |
  | JPEG XL | libjxl | sRGB only, no metadata |
- Metadata modes: all / no GPS / copyright only / none, plus author and copyright fields (EXIF
  Artist / Copyright and XMP `dc:creator` / `dc:rights`).
- **Batch queue**:
  - one photo at a time; the worker and its GPU context are released after each photo, so memory
    stays flat (measured over 8 × 48 MP);
  - destination: a folder (File System Access), or a ZIP streamed into OPFS (`storage/zipStream.ts`,
    with ZIP64) and downloaded at the end;
  - pause, cancel, retry failed, ETA and summary;
  - the job, including the ZIP's entry list, is saved after every photo, and a reload offers to
    resume it.
- Recipe sidecars (`.optic.json`) and recipe packs (`library/recipePack.ts`, zip of edit documents
  plus metadata, matched by content hash) move edits between devices.

## AI masks (`src/ai/`)

| Model | Runtime | Bitmap channels |
|---|---|---|
| Subject (U²-Netp) | ONNX Runtime Web in `ai.worker.ts` (single thread: threaded WASM stalls inside a module worker), 320 × 320 | R subject |
| Sky (U²-Net sky) | Same | R sky |
| Person (MediaPipe selfie multiclass) | Main thread, CPU delegate | R person, G hair, B face skin, A body skin |
| Person parts (multiclass + face landmarker; eye and lip contours rasterised with soft edges) | Main thread, CPU delegate | R clothes, G eyes, B lips |

The model input is the photo rendered with neutral settings in the U frame (lens corrections on, no
crop or transform). Each bitmap therefore stays valid under any later geometry edit. Models are
fetched on first use (`/models/<file>`, else the public mirror), with progress, into Cache Storage.
Bitmaps are cached in IndexedDB per photo and model. Model licences: [LICENSES.md](../LICENSES.md).

## PWA (`src/sw.ts`, `app/pwa.ts`, `vite.config.ts`)

`vite-plugin-pwa` in injectManifest mode.
- **Manifest**:
  - icons and maskable icon, standalone display;
  - `file_handlers` for RAW, HEIC, JPEG, TIFF, PNG, WebP and AVIF;
  - `share_target` (multipart POST of `photos`).
- **Service worker**:
  - precaches the shell and every WASM runtime (`vendor/ort`, `vendor/mediapipe` are emitted by a
    small Vite plugin), presets and LUTs: ~54 MB;
  - adds the isolation headers to everything it serves;
  - caches model files on first use;
  - stashes shared files for the app;
  - waits for the user before updating.
- **App side**: the "offline ready" state, the update prompt (asks first while an export runs),
  `launchQueue` for files opened from the OS, the share hand-off, and the storage persistence
  request. Apple splash screens are generated by `scripts/build-icons.mjs`.

## UI

- **Desktop**: top bar, library (sidebar, filter bar, grid, info panel) or editor (presets and
  history | viewer + filmstrip | panels).
- **Mobile** (`ui/mobile/`): used below 900 px wide, or on phones in landscape.
  - full-bleed viewer, a bottom tab bar, panels in a bottom sheet;
  - sliders adjust by relative horizontal swipes, double-tap resets, a haptic tick marks the
    default value;
  - viewer gestures: pinch and pan together, double-tap for Fit / 100 %, press-and-hold for before,
    two- and three-finger taps for undo and redo;
  - on iOS, a smaller proxy (2560 px) and export tiles (512 px).
- **Settings** (`ui/SettingsDialog.tsx`, `state/settingsStore.ts`):
  - default export preset, defaults for new RAW and non-RAW photos, preview quality;
  - GPU information, storage, AI models;
  - theme: dark, darker or light neutral grey; colours are CSS-variable tokens
    (`tailwind.config.js`, `index.css`), and the canvas background follows the theme;
  - reduced motion, language (`i18n/`, English first).
- **Shortcuts overlay** (`?`, `app/shortcuts.ts`) and a first-launch tour (`ui/Overlays.tsx`).
- **WebGL context loss**: the viewer rebuilds its renderer when the context is restored. Edits live
  in the store, so nothing is lost.

## Workers

| Worker | Job |
|---|---|
| `io/decode/rawDecoder.worker.ts`, `imageDecoder.worker.ts`, `jxlTile.worker.ts` | Decoding |
| `io/encode/exportWorker.ts` | Full-resolution render + encode |
| `library/render.worker.ts` | Library previews, batch analysis renders |
| `library/import.worker.ts` (pool) | Hash, metadata, quick previews |
| `library/opfs.worker.ts` | OPFS writes |
| `app/analysis.worker.ts` | Noise model, lateral CA |
| `ai/ai.worker.ts` | ONNX inference |

## Tests

| Command | What |
|---|---|
| `npm test` | Vitest unit tests: recipe migrations and parsing, masks, presets at 0 / 100 %, history labels, colour maths (matrices, transfer, OKLab, white balance), the CPU reference of the gamut compression (`color/gamut.ts`), export dimensions, file-name templates, zip |
| `npm run test:e2e` | Playwright in Chrome / Edge with the GPU: import → edit → export (dimensions checked), duplicates, batch sync with per-photo history, ZIP export, preview = export with masks, preset 0 % = identity, gamut |
| `npm run test:seams` | Tiled vs untiled export with every spatial effect and every mask kind |
| `npm run bench` | Preview frame rates (including 16 masks) and 48 MP export time |
