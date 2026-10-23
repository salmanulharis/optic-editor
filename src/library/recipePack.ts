/**
 * Recipe packs: the edits (full edit documents: history, snapshots, virtual copies) and metadata
 * of selected photos, without the images, so they can move to another device. Photos are matched
 * on import by content hash, then by file name and size. Single `.optic.json` sidecars (written by
 * export) can be imported too: their recipe becomes a new history step.
 */
import { downloadBlob } from '../io/encode/exportClient';
import { deserializeRecipe, serializeRecipe } from '../recipe/serialize';
import { type DocRecord, activeCopy, loadDoc, saveDoc, useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { useLibrary } from '../state/libraryStore';
import { readZip, writeZip } from '../storage/zip';
import type { PhotoRecord } from './db';
import { enqueuePreviews } from './previews';

interface PackEntry {
  optic: 'edit';
  version: 1;
  fileName: string;
  size: number;
  hash: string;
  meta: Pick<PhotoRecord, 'rating' | 'flag' | 'label' | 'keywords'>;
  doc: DocRecord;
}

export async function exportRecipePack(ids: string[]) {
  const lib = useLibrary.getState();
  const files = [];
  for (const id of ids) {
    const p = lib.byId.get(id);
    if (!p) continue;
    const doc = await loadDoc(p.key);
    if (!doc) continue;
    const entry: PackEntry = {
      optic: 'edit', version: 1, fileName: p.fileName, size: p.size, hash: p.hash,
      meta: { rating: p.rating, flag: p.flag, label: p.label, keywords: p.keywords },
      doc: JSON.parse(JSON.stringify(doc)),
    };
    files.push({ name: `${p.hash.slice(0, 16)}_${p.fileName}.json`, data: new TextEncoder().encode(JSON.stringify(entry)) });
  }
  if (!files.length) { alert('None of the selected photos has edits yet.'); return; }
  downloadBlob(new Blob([writeZip(files) as BlobPart], { type: 'application/zip' }), `optic-edits-${new Date().toISOString().slice(0, 10)}.opticedits`);
}

function match(fileName: string, size: number, hash?: string): PhotoRecord | undefined {
  const photos = useLibrary.getState().photos;
  return (hash ? photos.find((p) => p.hash === hash) : undefined) ?? photos.find((p) => p.fileName === fileName && p.size === size) ?? photos.find((p) => p.fileName === fileName);
}

/** Import a recipe pack or `.optic.json` sidecars. Returns how many photos were updated. */
export async function importEdits(files: File[]): Promise<{ applied: number; unmatched: string[] }> {
  let applied = 0;
  const unmatched: string[] = [];
  const touched: string[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const entries = f.name.endsWith('.json') ? [{ name: f.name, data: bytes }] : await readZip(bytes);
    for (const e of entries) {
      let j: Record<string, unknown>;
      try { j = JSON.parse(new TextDecoder().decode(e.data)); } catch { continue; }
      if (j.optic === 'edit') {
        const pe = j as unknown as PackEntry;
        const p = match(pe.fileName, pe.size, pe.hash);
        if (!p) { unmatched.push(pe.fileName); continue; }
        // Stored recipes are migrated like any other (packs from older versions).
        const doc: DocRecord = {
          ...pe.doc,
          key: p.key,
          fileName: p.fileName,
          updated: Date.now(),
          copies: pe.doc.copies.map((c) => ({ ...c, steps: c.steps.map((s) => ({ ...s, recipe: deserializeRecipe(s.recipe) })), snapshots: c.snapshots.map((s) => ({ ...s, recipe: deserializeRecipe(s.recipe) })) })),
        };
        await saveDoc(doc);
        await useLibrary.getState().patch([p.id], () => ({ ...pe.meta }));
        touched.push(p.id);
        applied++;
      } else if (j.optic === 'recipe') {
        const p = match(String(j.file ?? ''), -1);
        if (!p) { unmatched.push(String(j.file ?? e.name)); continue; }
        const recipe = deserializeRecipe(j.recipe);
        const open = useImage.getState();
        if (open.photoId === p.id) useEdit.getState().apply(() => recipe, 'Imported edit');
        else {
          const doc = await loadDoc(p.key);
          if (!doc) { unmatched.push(`${p.fileName} (open it once first)`); continue; }
          const c = activeCopy(doc);
          const steps = [...c.steps.slice(0, c.index + 1), { label: 'Imported edit', recipe, t: Date.now(), key: `import:${Date.now()}` }];
          await saveDoc({ ...doc, updated: Date.now(), copies: doc.copies.map((x) => (x.id === c.id ? { ...c, steps, index: steps.length - 1 } : x)) });
        }
        touched.push(p.id);
        applied++;
      }
    }
  }
  // The open photo reloads its document only when opened again: reopen it if it was replaced.
  const open = useImage.getState();
  if (open.photoId && touched.includes(open.photoId)) {
    const p = useLibrary.getState().byId.get(open.photoId);
    const doc = p ? await loadDoc(p.key) : null;
    if (doc && open.image) useEdit.getState().openDoc(p!.key, p!.fileName, useEdit.getState().recipe, doc);
  }
  enqueuePreviews(touched.filter((id) => id !== open.photoId));
  return { applied, unmatched };
}

export const recipeJson = (r: Parameters<typeof serializeRecipe>[0]) => serializeRecipe(r);
