/**
 * Decode a catalog photo outside the editor (previews, batch tools, batch export): the same
 * decoders, the same image model and the same analysis (noise model, lensfun profile, CA estimate)
 * as an opened photo, so a batch export of an unopened photo matches what the editor would export.
 */
import { analysisWorker } from '../app/analysisClient';
import { decodeFile } from '../io/decode/decodeClient';
import { lensfunProfile } from '../io/lens/lensfun';
import { derive } from '../pipeline/derive';
import type { Recipe } from '../recipe/schema';
import { type LoadedImage, buildLoadedImage, defaultRecipeFor } from '../state/imageStore';
import type { PhotoRecord } from './db';
import { readFile } from './opfs';

/** The original file of a catalog photo (asks for permission again for referenced files). */
export async function photoFile(p: PhotoRecord, interactive = false): Promise<File> {
  if (p.storage === 'opfs') {
    const f = p.opfsPath ? await readFile(p.opfsPath) : null;
    if (!f) throw new Error(`${p.fileName}: the stored copy is missing`);
    return new File([f], p.fileName, { type: f.type, lastModified: p.lastModified });
  }
  const h = p.handle as (FileSystemFileHandle & { queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> }) | undefined;
  if (!h) throw new Error(`${p.fileName}: the original is not available`);
  let perm = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
  if (perm !== 'granted' && interactive) perm = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
  if (perm !== 'granted') throw new Error(`${p.fileName}: permission to read the original is needed (open it once to grant access)`);
  try {
    return await h.getFile();
  } catch {
    throw new Error(`${p.fileName}: the original was moved or deleted`);
  }
}

export async function decodePhoto(p: PhotoRecord, proxyEdge: number, recipe?: Recipe | null, signal?: AbortSignal): Promise<LoadedImage> {
  const file = await photoFile(p);
  const job = decodeFile(file, proxyEdge, () => {});
  signal?.addEventListener('abort', () => job.cancel());
  const { result, exif } = await job.promise;
  const img = buildLoadedImage(file, p.key, result, exif);
  const gains = img.isRaw ? derive(img.model, defaultRecipeFor(img)).wbMul : [1, 1, 1];
  img.model.analysis.noise = await analysisWorker().noise(img.full, [gains[0], gains[1], gains[2]]);
  if (img.isRaw && !img.model.lens && img.info.lens) {
    img.model.lens = await lensfunProfile(img.info, img.width, img.height).catch(() => null);
  }
  if (recipe?.lens.ca.auto) img.model.analysis.ca = await analysisWorker().ca(img.full);
  return img;
}
