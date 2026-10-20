import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';

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
  ]).then(([edit, image, presets, ui, apply, serialize, actions, core, schema, geometryActions, transform, mapping]) => {
    (window as unknown as Record<string, unknown>).__optic = { edit, image, presets, ui, apply, serialize, actions, core, schema, geometryActions, transform, mapping };
  });
}
