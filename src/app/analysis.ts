/**
 * Background measurements on a freshly opened photo. Each one fills a field the pipeline reads
 * (ImageModel.analysis / .lens) and bumps `analysisTick` so the view re-renders:
 *  - the noise model (noise reduction thresholds), soon after the photo appears;
 *  - a lensfun profile for raw files without embedded corrections (lens "Auto");
 *  - the lateral-CA estimate, the first time "Auto" chromatic aberration is switched on.
 * They run in idle time, one at a time, so the photo shows up first and the UI stays responsive.
 */
import { analysisWorker } from './analysisClient';
import { lensfunProfile } from '../io/lens/lensfun';
import { derive } from '../pipeline/derive';
import { useEdit } from '../state/editStore';
import { type LoadedImage, defaultRecipeFor, useImage } from '../state/imageStore';
import { useUi } from '../state/uiStore';

const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1500 }); else setTimeout(fn, 200);
};

const bump = () => useUi.getState().set({ analysisTick: useUi.getState().analysisTick + 1 });
const isCurrent = (img: LoadedImage) => useImage.getState().image === img;

let unsubscribeCa: (() => void) | null = null;

export function startAnalysis(img: LoadedImage) {
  idle(() => {
    if (!isCurrent(img)) return;
    const t0 = performance.now();
    // White-balanced green-weighted luminance: raw channels are scaled by their As Shot gains.
    const gains = img.isRaw ? derive(img.model, defaultRecipeFor(img)).wbMul : [1, 1, 1];
    void analysisWorker().noise(img.full, [gains[0], gains[1], gains[2]]).then((n) => {
      if (!isCurrent(img)) return;
      img.model.analysis.noise = n;
      console.info(`[optic] noise model S=${n.S.toExponential(2)} O=${n.O.toExponential(2)} (${Math.round(performance.now() - t0)} ms, worker)`);
      bump();
    }).catch((e) => console.warn('[optic] noise analysis failed', e));
  });
  if (img.isRaw && !img.model.lens && img.info.lens) {
    lensfunProfile(img.info, img.width, img.height)
      .then((p) => {
        if (!p || !isCurrent(img)) return;
        img.model.lens = p;
        console.info(`[optic] lens profile: ${p.name}`);
        bump();
      })
      .catch((e) => console.warn('[optic] lens profile lookup failed', e));
  }
  // Lateral CA is measured only when someone asks for it.
  unsubscribeCa?.();
  const check = () => {
    if (!isCurrent(img) || img.model.analysis.ca !== undefined) return;
    if (!useEdit.getState().recipe.lens.ca.auto) return;
    img.model.analysis.ca = null; // in progress / not measurable
    idle(() => {
      if (!isCurrent(img)) return;
      const t0 = performance.now();
      void analysisWorker().ca(img.full).then((ca) => {
        if (!isCurrent(img)) return;
        img.model.analysis.ca = ca;
        console.info(`[optic] lateral CA estimate ${JSON.stringify(ca)} (${Math.round(performance.now() - t0)} ms, worker)`);
        bump();
      }).catch((e) => console.warn('[optic] CA analysis failed', e));
    });
  };
  unsubscribeCa = useEdit.subscribe((s, p) => { if (s.recipe.lens.ca.auto !== p.recipe.lens.ca.auto) check(); });
  check();
}
