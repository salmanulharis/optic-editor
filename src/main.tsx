import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';
import { initTheme } from './app/theme';

initTheme();

if (!globalThis.crossOriginIsolated) {
  console.warn('[optic] Page is not cross-origin isolated: RAW decoding (LibRaw threads) and zero-copy sharing are unavailable.');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only handle for automated browser tests (not present in production builds).
if (import.meta.env.DEV) {
  void Promise.all([
    import('./state/editStore'),
    import('./state/imageStore'),
    import('./state/presetStore'),
    import('./state/uiStore'),
    import('./presets/apply'),
    import('./recipe/serialize'),
    import('./app/presetActions'),
    import('./app/actions'),
    import('./recipe/schema'),
    import('./app/geometryActions'),
    import('./geometry/transform'),
    import('./geometry/mapping'),
    import('./app/maskActions'),
    import('./ai/aiMasks'),
    import('./recipe/masks'),
    import('./pipeline/maskRegistry'),
    import('./state/libraryStore'),
    import('./library/batch'),
    import('./library/importer'),
    import('./library/previews'),
    import('./library/open'),
  ]).then(([edit, image, presets, ui, apply, serialize, actions, core, schema, geometryActions, transform, mapping, maskActions, ai, masks, maskRegistry, library, batch, importer, previews, open]) => {
    (window as unknown as Record<string, unknown>).__optic = {
      edit, image, presets, ui, apply, serialize, actions, core, schema, geometryActions, transform, mapping, maskActions, ai, masks, maskRegistry,
      library, batch, importer, previews, open,
    };
  });
}
