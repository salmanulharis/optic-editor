import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// LibRaw-WASM is built with pthreads (SharedArrayBuffer), and the decoded image is shared
// between the UI and the export worker through a SharedArrayBuffer. Both require the page to be
// cross-origin isolated, hence the COOP/COEP headers on dev and preview servers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: {
    // These packages locate their .wasm / nested worker via `new URL(..., import.meta.url)`,
    // which breaks if Vite pre-bundles them.
    exclude: ['libraw-wasm', 'libheif-js', '@jsquash/jpeg', '@jsquash/png', 'jxl-oxide-wasm'],
  },
  build: { target: 'es2022' },
});
