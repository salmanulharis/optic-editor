# Third-party licences

Optic is built on the open-source libraries, data and on-device AI models listed here. Everything
runs in the browser; no service receives photos. The versions are those in `package-lock.json` at
the time of writing.

## AI models (downloaded on first use, cached for offline use)

The models are not part of the repository or the build. `npm run models:fetch` downloads them into
`public/models/` so a deployment serves them itself. Otherwise the app downloads each one from the
mirror below on first use.

| Model | Used for | Licence | Source | Size |
|---|---|---|---|---|
| U²-Net small (`u2netp.onnx`) | Select Subject / Background | Apache-2.0 | [xuebinqin/U-2-Net](https://github.com/xuebinqin/U-2-Net); mirror [huggingface.co/edgetools/u2netp](https://huggingface.co/edgetools/u2netp) | 4.6 MB |
| Sky segmentation, U²-Net (`skyseg.onnx`) | Select Sky | MIT | [xiongzhu666/Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing); mirror [huggingface.co/JianyuanWang/skyseg](https://huggingface.co/JianyuanWang/skyseg) | 176 MB |
| MediaPipe selfie multiclass segmenter 256×256 | Select Person and parts (hair, face skin, body skin, clothes) | Apache-2.0 | [Google AI Edge, MediaPipe image segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) | 16 MB |
| MediaPipe face landmarker | Person parts: eyes, lips | Apache-2.0 | [Google AI Edge, MediaPipe face landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | 3.8 MB |

The sky and U²-Netp licences are as stated by the upstream projects and their mirrors. Check the
upstream licence files before redistributing the weights commercially.

## Runtime libraries (bundled in the app)

| Package | Version | Licence | Use |
|---|---|---|---|
| [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) | 1.6.0 | ISC (wrapper); LibRaw itself is LGPL-2.1 or CDDL-1.0 | Camera RAW decoding |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.23.5 | LGPL-3.0 | HEIC / HEIF decoding |
| [jxl-oxide-wasm](https://github.com/tirr-c/jxl-oxide) | 0.12.6 | MIT OR Apache-2.0 | JPEG XL tiles in DNG 1.7 |
| [@jsquash/jpeg](https://github.com/jamsinclair/jSquash) (MozJPEG) | 1.6.0 | Apache-2.0; MozJPEG under the IJG / BSD-style licences | JPEG decode / encode |
| [@jsquash/png](https://github.com/jamsinclair/jSquash) | 3.1.1 | Apache-2.0 | PNG decode |
| [@jsquash/avif](https://github.com/jamsinclair/jSquash) (libavif / aom) | 2.1.1 | Apache-2.0; libavif BSD-2-Clause, libaom BSD-2-Clause | AVIF export |
| [@jsquash/jxl](https://github.com/jamsinclair/jSquash) (libjxl) | 1.3.0 | Apache-2.0; libjxl BSD-3-Clause | JPEG XL export |
| [UTIF.js](https://github.com/photopea/UTIF.js) | 3.1.0 | MIT | TIFF decoding |
| [pako](https://github.com/nodeca/pako) | 2.2.0 | MIT AND Zlib | Deflate for UTIF |
| [exifr](https://github.com/MikeKovarik/exifr) | 7.1.3 | MIT | EXIF reading, embedded thumbnails |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.23.2 | MIT | AI model inference (WASM) |
| [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) | 0.10.22-rc.20250304 | Apache-2.0 | Person segmentation, face landmarks |
| [Dexie.js](https://github.com/dexie/Dexie.js) | 4.2.1 | Apache-2.0 | Catalog database (IndexedDB) |
| [Comlink](https://github.com/GoogleChromeLabs/comlink) | 4.4.2 | Apache-2.0 | Worker messaging |
| [Zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT | State |
| [React, React DOM](https://github.com/facebook/react) | 18.3.1 | MIT | UI |
| [Workbox](https://github.com/GoogleChrome/workbox) (core, precaching, routing, strategies, expiration) | 7.4.1 | MIT | Service worker, offline cache |

### LGPL components

LibRaw (LGPL-2.1 option) and libheif (LGPL-3.0) are used unmodified as separate WebAssembly
modules. They are loaded at runtime from their own files (`*.wasm` plus their JavaScript loaders in
the build output), so they can be replaced with compatible builds. Their source is available from the
upstream projects linked above.

## Data

| Data | Licence | Use |
|---|---|---|
| [lensfun](https://github.com/lensfun/lensfun) lens database (subset, `src/io/lens/lensfun-subset.json`) | CC BY-SA 3.0 | Lens profiles for RAW files without embedded corrections |

## Build and test tools (not shipped)

Vite (MIT), @vitejs/plugin-react (MIT), vite-plugin-pwa (MIT), workbox-build / workbox-window (MIT),
TypeScript (Apache-2.0), Tailwind CSS (MIT), PostCSS (MIT), Autoprefixer (MIT), Vitest (MIT),
Playwright / playwright-core (Apache-2.0), axe-core (MPL-2.0), @types/* (MIT).
