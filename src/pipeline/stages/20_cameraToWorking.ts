/**
 * Stage 20 — source → working space (linear Rec.2020 D65).
 * RAW: the DNG camera matrix (ForwardMatrix or inverted, interpolated ColorMatrix) incl.
 * BaselineExposure. Non-RAW: the embedded ICC profile's RGB→XYZ, then XYZ→Rec.2020.
 *
 * Since Phase 2 this matrix is pre-multiplied into stage 10 (`derive.fused`), so this stage is
 * never compiled in. It stays in the list as the reference point for `until: 'cw'` readbacks
 * ("working-space values before any tone or colour work").
 */
import type { Stage } from '../types';

export const cameraToWorkingStage: Stage = {
  id: 'cw',
  label: 'Camera → working (fused into stage 10)',
  kind: 'point',
  glsl: '',
  active: () => false,
  uniforms: () => ({}),
};
