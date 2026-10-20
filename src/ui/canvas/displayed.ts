/**
 * Which recipe the canvas shows right now: before / hover-preview / edit, the crop tool's whole
 * frame, the point-colour and detail mask views, and the "Before" side of a compare view.
 */
import { cropToolFrame } from '../../geometry/transform';
import { defaultRecipe, effectiveRecipe, type Recipe } from '../../recipe/schema';
import { activeCopy, useEdit } from '../../state/editStore';
import { type LoadedImage, defaultRecipeFor } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';

/** The compare "Before" recipe and its label (aligned to the current crop and transform). */
export function beforeRecipe(img: LoadedImage): { recipe: Recipe; label: string } {
  const ui = useUi.getState();
  const e = useEdit.getState();
  const src = ui.compareSource;
  let r: Recipe = defaultRecipeFor(img), label = 'Original';
  if (src === 'session' && e.sessionStart) { r = e.sessionStart; label = 'As opened'; }
  else if (src.startsWith('snap:')) {
    const s = activeCopy(e).snapshots.find((x) => x.id === src.slice(5));
    if (s) { r = s.recipe; label = s.name; }
  } else if (src.startsWith('step:')) {
    const c = activeCopy(e);
    const st = c.steps[+src.slice(5)];
    if (st) { r = st.recipe; label = `Step ${+src.slice(5) + 1}: ${st.label}`; }
  } else if (src.startsWith('copy:')) {
    const c = e.copies.find((x) => x.id === src.slice(5));
    if (c) { r = c.steps[c.index].recipe; label = c.name; }
  }
  // Same framing as the edit, so both sides line up.
  const now = e.recipe;
  return { recipe: effectiveRecipe({ ...r, crop: now.crop, geometry: now.geometry }, img.asShot), label };
}

export function displayedRecipe(img: LoadedImage): { recipe: Recipe; visualize: boolean; maskView?: 'sharpen' } {
  const ui = useUi.getState();
  if (ui.showBefore) return { recipe: beforeRecipe(img).recipe, visualize: false };
  let r = effectiveRecipe(ui.previewRecipe ?? useEdit.getState().recipe, img.asShot);
  if (ui.cropMode) {
    // The whole straightened frame, with the crop drawn on top; the post-crop vignette would mislead.
    r = { ...r, crop: cropToolFrame(img.model, r), effects: { ...r.effects, vignette: { ...r.effects.vignette, amount: 0 } } };
  }
  if (ui.maskView) return { recipe: r, visualize: false, maskView: ui.maskView };
  if (!ui.visualizePointColor) return { recipe: r, visualize: false };
  // Mask view: everything after the point-colour stage is neutralised so the grey is the mask.
  const d = defaultRecipe();
  return {
    recipe: { ...r, curve: d.curve, treatment: 'color', colorGrading: d.colorGrading, presence: d.presence, lut: d.lut, look: d.look },
    visualize: true,
  };
}
