import type { Recipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';

/** Helpers to bind a slider to a recipe path: live update while dragging, commit on release. */
export function bindSection<K extends keyof Recipe>(key: K) {
  return {
    set(patch: Partial<Recipe[K]>) {
      useEdit.getState().update((r) => ({ ...r, [key]: { ...(r[key] as object), ...patch } }));
    },
    apply(patch: Partial<Recipe[K]>) {
      useEdit.getState().apply((r) => ({ ...r, [key]: { ...(r[key] as object), ...patch } }));
    },
    commit: () => useEdit.getState().commit(),
  };
}

/** CSS gradient string from a list of CSS colours. */
export const grad = (...stops: string[]) => `linear-gradient(to right, ${stops.join(', ')})`;
