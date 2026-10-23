# Optic

A photo editor and library that runs entirely in the browser: RAW (Apple ProRAW and other DNGs,
CR2/CR3, NEF, ARW, RAF, RW2, ORF, …), HEIC, JPEG, PNG, TIFF, WebP and AVIF. Photos never leave the
device. There are no uploads, no accounts and no analytics. Optic installs as an offline app on
desktop, iPhone and iPad.

- **Library**:
  - import files and folders, copied into the browser's private storage or referenced in place;
  - duplicate detection;
  - ratings, flags, colour labels and keywords;
  - filters, collections and smart collections;
  - a virtualised grid that stays smooth with 10 000+ photos.
- **Editing**:
  - float-linear GPU pipeline; white balance, light, curves, colour mixer, point colour, grading
    and calibration;
  - LUTs, a look layer and 64 built-in presets;
  - detail, effects, lens corrections, upright, crop;
  - history, snapshots, virtual copies and compare views.
- **Local adjustments**:
  - linear and radial gradients, brush with auto-mask and pen pressure, colour and luminance
    ranges;
  - on-device AI masks: subject, sky, background, person and its parts;
  - add / subtract / intersect; up to 16 masks per photo.
- **Batch**: sync settings and Auto Sync, presets, auto white balance and tone, match look, reset.
  Each is one undo step per photo.
- **Export**:
  - formats: TIFF / PNG 16-bit, JPEG, AVIF 10-bit, JPEG XL;
  - export presets, sizes, output sharpening, metadata and copyright, watermarks, file-name
    templates;
  - to a folder or a streamed ZIP, through a resumable queue.
- **Touch layout** for iPhone and iPad: bottom sheets, swipe sliders, gestures, Apple Pencil
  brushes.

Documentation:
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): features, shortcuts, workflow tips.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): pipeline, recipe versions, storage, workers, PWA.
- [docs/COLOR.md](docs/COLOR.md), [docs/EFFECTS.md](docs/EFFECTS.md),
  [docs/PRESETS.md](docs/PRESETS.md).
- [LICENSES.md](LICENSES.md): third-party libraries and AI models.

## Develop

Node 20 or later.

```bash
npm install
npm run dev            # http://localhost:5173 (sends the COOP/COEP headers)
npm run build          # type-check + production build in dist/ (with the service worker)
npm run preview        # serve dist/ on http://localhost:4173
npm run typecheck
npm test               # unit tests (Vitest)
npm run test:e2e       # end-to-end tests (Playwright, real Chrome/Edge with GPU; CHROME_CHANNEL=msedge for Edge)
npm run test:seams     # tiled vs untiled export, every spatial effect and mask kind
npm run bench          # preview frame rate and 48 MP export time
npm run models:fetch   # optional: download the AI models into public/models (see below)
npm run icons          # regenerate the PWA icons and splash screens from public/icons/optic.svg
```

The first end-to-end test uses `sample-files/IMG_7040.jpeg` (a ProRAW DNG kept locally). It is
skipped when that file is missing.

## Deploy

`npm run build` produces a static site in `dist/`. Any static host works if it sends two headers on
every response. Optic needs **cross-origin isolation**: the RAW decoder uses threads
(SharedArrayBuffer), and decoded photos are shared with workers without copying.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

| Host | Setup |
|---|---|
| **Vercel** | Import the repository. `vercel.json` sets the build, the headers, caching and the single-page-app rewrite. |
| **Netlify** | Import the repository. `netlify.toml` sets the build and the single-page-app redirect; `public/_headers` (copied into `dist/`) sets the headers. |
| **Cloudflare Pages** | Build command `npm run build`, output directory `dist`. `public/_headers` sets the headers, and Pages serves `index.html` for unknown paths. |
| **Anything else** (nginx, S3 + CloudFront, Caddy, …) | Serve `dist/` with the two headers above. Serve `sw.js` and `manifest.webmanifest` with `Cache-Control: no-cache`, and fall back to `index.html` for unknown GET paths. |

Hosts that cannot set headers (for example GitHub Pages) are not supported. The service worker adds
the headers to pages it serves from its cache, but the very first visit must already be isolated.

### AI models

The AI masks use four permissively licensed models (Apache-2.0 / MIT; see
[LICENSES.md](LICENSES.md)). They are downloaded on first use only, with a progress bar, and then
cached for offline use. By default they come from public mirrors (Hugging Face, Google). To serve
them from your own deployment instead, run `npm run models:fetch` before `npm run build`. That puts
them in `public/models/` (about 200 MB, mostly the sky model), and the app tries `/models/<file>`
first.

## Browser support

- **Chrome and Edge** (desktop): tested, including the automated test suite. Everything works,
  including folder import, "Reference in place", saving exports straight into a folder, and file
  handling.
- **Safari on macOS, iPhone and iPad**: designed for (touch layout, OPFS through synchronous access
  handles, ZIP export, iOS memory limits, splash screens), but not yet verified on real devices.
  Safari has no File System Access, so originals are always copied into Optic and batch exports
  download as a ZIP.
- **Firefox**: not tested.

WebGL 2 with float render targets (`EXT_color_buffer_float`) is required.

## Privacy

All processing happens on the device. Network requests are limited to:
- the app's own files;
- AI model files, the first time each AI mask is used.

No photo, edit or metadata is ever sent anywhere.
