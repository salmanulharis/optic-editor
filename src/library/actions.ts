/** Library actions on photo metadata and records (ratings, flags, labels, keywords, removal). */
import { useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { setMeta, targetIds, useLibrary } from '../state/libraryStore';
import { catalog, type ColorLabel, type Flag } from './db';
import { removeEntry } from './opfs';

export const setRating = (n: number, ids = targetIds()) => setMeta(ids, { rating: Math.max(0, Math.min(5, n)) });
export const setFlag = (f: Flag, ids = targetIds()) => setMeta(ids, { flag: f });

/** Toggle a colour label (setting the label a photo already has clears it). */
export function toggleLabel(l: ColorLabel, ids = targetIds()) {
  const lib = useLibrary.getState();
  const all = ids.every((id) => lib.byId.get(id)?.label === l);
  return setMeta(ids, { label: all ? null : l });
}

export function addKeywords(words: string[], ids = targetIds()) {
  const clean = words.map((w) => w.trim()).filter(Boolean);
  return useLibrary.getState().patch(ids, (p) => ({ keywords: [...new Set([...p.keywords, ...clean])] }));
}

export function removeKeyword(word: string, ids = targetIds()) {
  return useLibrary.getState().patch(ids, (p) => ({ keywords: p.keywords.filter((k) => k !== word) }));
}

/**
 * Remove photos from the library: their records, edit documents and cached previews, and the
 * copies Optic stored (files referenced in place are never touched). Asks first.
 */
export async function removePhotos(ids: string[], ask = true): Promise<boolean> {
  if (!ids.length) return false;
  const lib = useLibrary.getState();
  const recs = ids.map((id) => lib.byId.get(id)).filter((p) => !!p);
  const copies = recs.filter((p) => p.storage === 'opfs').length;
  if (ask && !confirm(`Remove ${recs.length} photo${recs.length > 1 ? 's' : ''} from Optic?\n\nTheir edits and previews are deleted${copies ? `, and so are the ${copies} cop${copies > 1 ? 'ies' : 'y'} stored in Optic (the files you imported from are not touched)` : ''}.`)) return false;
  const open = useImage.getState();
  if (open.photoId && ids.includes(open.photoId)) {
    open.close();
    useEdit.getState().reset(useEdit.getState().recipe);
    lib.set({ view: 'library' });
  }
  await lib.remove(ids);
  await catalog.docs.bulkDelete(recs.map((p) => p.key)).catch(() => {});
  for (const p of recs) {
    await removeEntry(`previews/${p.id}`);
    if (p.storage === 'opfs') await removeEntry(`originals/${p.id}`);
  }
  return true;
}
