/**
 * Opening catalog photos in the editor, and keeping the catalog in step with edits: every save of
 * the open photo's document is mirrored into its record (recipe, edited flag, copies, preset) and,
 * once the edits pause, its cached previews are re-rendered.
 */
import { proxyLongEdge } from '../app/openFile';
import { maskRegistry } from '../pipeline/maskRegistry';
import { applyPreset } from '../presets/apply';
import { onDocSaved } from '../state/editStore';
import { useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { useLibrary } from '../state/libraryStore';
import { usePresets } from '../state/presetStore';
import { photoFile } from './decode';
import { enqueuePreviews, mirrorDoc } from './previews';

export async function openPhoto(id: string) {
  const lib = useLibrary.getState();
  const rec = lib.byId.get(id);
  if (!rec) return;
  lib.set({ view: 'editor', active: id, ...(lib.selection.has(id) ? {} : { selection: new Set([id]), anchor: id }) });
  if (useImage.getState().photoId === id && useImage.getState().image) return;
  let file: File;
  try {
    file = await photoFile(rec, true);
  } catch (e) {
    useImage.setState({ error: (e as Error).message });
    return;
  }
  // AI bitmaps of other photos are not needed any more.
  maskRegistry.retainOnly(rec.key);
  await usePresets.getState().init();
  const pending = rec.pendingPreset ? usePresets.getState().byId(rec.pendingPreset.id) : undefined;
  await useImage.getState().load(file, proxyLongEdge(), {
    key: rec.key,
    photoId: id,
    initial: pending ? (r, img) => applyPreset(r, pending, img.isRaw, rec.pendingPreset!.amount) : undefined,
  });
  if (pending) {
    await useLibrary.getState().patch([id], () => ({ pendingPreset: null }));
    useEdit.getState().commit(`Preset: ${pending.name} (${Math.round(rec.pendingPreset!.amount)}%)`);
  }
  const { ensureAiForRecipe } = await import('../app/maskActions');
  ensureAiForRecipe(useEdit.getState().recipe);
}

/** Open the next / previous photo of the visible list. */
export function openRelative(step: number, list: { id: string }[]) {
  const cur = useLibrary.getState().active;
  const i = list.findIndex((p) => p.id === cur);
  const n = list[Math.min(list.length - 1, Math.max(0, i + step))];
  if (n && n.id !== cur) void openPhoto(n.id);
}

let refresh: number | undefined;
let started = false;

export function startLibrarySync() {
  if (started) return;
  started = true;
  onDocSaved((doc) => {
    void mirrorDoc(doc);
    const open = useImage.getState();
    const rec = useLibrary.getState().photos.find((p) => p.key === doc.key);
    if (!rec || open.photoId !== rec.id) return;
    window.clearTimeout(refresh);
    refresh = window.setTimeout(() => enqueuePreviews([rec.id], true), 2000);
  });
}
