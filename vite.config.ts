import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Plugin, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// LibRaw-WASM is built with pthreads (SharedArrayBuffer), and the decoded image is shared
// between the UI and the export worker through a SharedArrayBuffer. Both require the page to be
// cross-origin isolated, hence the COOP/COEP headers on dev and preview servers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Runtime files the AI masks load by URL (ONNX Runtime's WASM build, MediaPipe's vision WASM):
 * served from node_modules in dev and copied to dist/vendor in a build, so they are same-origin
 * (COEP) and precached by the service worker for offline use.
 */
const VENDOR: Record<string, { dir: string; files: (f: string) => boolean }> = {
  ort: { dir: 'node_modules/onnxruntime-web/dist', files: (f) => /^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(f) },
  mediapipe: { dir: 'node_modules/@mediapipe/tasks-vision/wasm', files: (f) => /^vision_wasm_internal\.(js|wasm)$/.test(f) },
};

function vendorAssets(): Plugin {
  const type = (f: string) => (f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  return {
    name: 'optic-vendor-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/vendor\/(ort|mediapipe)\/([^?]+)/.exec(req.url ?? '');
        const v = m && VENDOR[m[1]];
        if (!m || !v || !v.files(m[2])) return next();
        res.setHeader('Content-Type', type(m[2]));
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.end(readFileSync(resolve(v.dir, m[2])));
      });
    },
    generateBundle() {
      for (const [name, v] of Object.entries(VENDOR)) {
        for (const f of readdirSync(v.dir).filter(v.files)) {
          this.emitFile({ type: 'asset', fileName: `vendor/${name}/${f}`, source: readFileSync(resolve(v.dir, f)) });
        }
      }
    },
  };
}

const RAW_TYPES: Record<string, string[]> = {
  'image/x-adobe-dng': ['.dng'],
  'image/x-canon-cr2': ['.cr2'],
  'image/x-canon-cr3': ['.cr3'],
  'image/x-nikon-nef': ['.nef'],
  'image/x-sony-arw': ['.arw'],
  'image/x-fuji-raf': ['.raf'],
  'image/x-panasonic-rw2': ['.rw2'],
  'image/x-olympus-orf': ['.orf'],
  'image/heic': ['.heic', '.heif', '.hif'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/tiff': ['.tif', '.tiff'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/avif': ['.avif'],
};

/** Installable PWA: manifest, icons, file handling, share target, offline precache (src/sw.ts). */
const pwa = VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'prompt',
  injectRegister: false,
  manifest: {
    id: '/',
    name: 'Optic — RAW photo editor',
    short_name: 'Optic',
    description: 'Edit RAW, HEIC and JPEG photos on your device. Library, presets, masks and export, fully offline. Nothing is uploaded.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    orientation: 'any',
    background_color: '#1c1c1c',
    theme_color: '#1c1c1c',
    categories: ['photo', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/optic.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    file_handlers: [{ action: '/', accept: RAW_TYPES }],
    launch_handler: { client_mode: 'focus-existing' },
    share_target: {
      action: '/share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: { files: [{ name: 'photos', accept: ['image/*', ...Object.values(RAW_TYPES).flat()] }] },
    },
  } as never,
  injectManifest: {
    globPatterns: ['**/*.{js,mjs,css,html,wasm,svg,png,cube,json,webmanifest}'],
    globIgnores: ['**/splash-*.png'],
    // WASM runtimes (ONNX Runtime, MediaPipe, LibRaw) are large but must work offline.
    maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
  },
  devOptions: { enabled: false },
});

export default defineConfig({
  plugins: [react(), vendorAssets(), pwa],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: {
    // Pre-bundled up front: discovering them later (worker / lazy imports) reloads the page.
    include: ['pako', 'utif', 'dexie', 'exifr', 'comlink', 'zustand', '@mediapipe/tasks-vision'],
    // These packages locate their .wasm / nested worker via `new URL(..., import.meta.url)`,
    // which breaks if Vite pre-bundles them.
    exclude: ['libraw-wasm', 'libheif-js', '@jsquash/jpeg', '@jsquash/png', 'jxl-oxide-wasm', 'onnxruntime-web', '@jsquash/avif', '@jsquash/jxl'],
  },
  build: { target: 'es2022' },
});
