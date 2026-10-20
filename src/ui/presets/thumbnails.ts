/**
 * Preset thumbnails rendered on the current photo, on the GPU, in a background queue:
 *  - visible tiles first (IntersectionObserver marks them), at most one render per frame;
 *  - paused while a pointer is held (slider drag, pan) or a render would wait on the compiler,
 *    so the main canvas keeps its frame rate;
 *  - cached per photo (cleared when a new photo loads).
 * Thumbnails show the preset applied at 100 % on top of the current edit.
 */
import { useEffect, useState } from 'react';
import { getRenderer } from '../../app/actions';
import { presetPreviewRecipe } from '../../app/presetActions';
import type { Preset } from '../../presets/types';
import { effectiveRecipe } from '../../recipe/schema';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';

const cache = new Map<string, string>(); // presetId → object URL (for the current photo)
const visible = new Map<string, Preset>();
const known = new Map<string, Preset>();
const listeners = new Map<string, Set<(url: string) => void>>();
let imageId = 0;
let running = false;
let busy = false;

function reset() {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

async function renderOne(p: Preset) {
  const r = getRenderer();
  const img = useImage.getState().image;
  if (!r || !img) return false;
  const recipe = effectiveRecipe(presetPreviewRecipe(p), img.asShot);
  if (!r.thumbnailReady(recipe)) return false;
  const data = r.thumbnail(recipe, 256);
  if (!data) return false;
  const canvas = new OffscreenCanvas(data.width, data.height);
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  if (img.id !== imageId) return true;
  const url = URL.createObjectURL(blob);
  cache.set(p.id, url);
  listeners.get(p.id)?.forEach((f) => f(url));
  return true;
}

function tick() {
  requestAnimationFrame(tick);
  const img = useImage.getState().image;
  if (!img) return;
  if (img.id !== imageId) { reset(); imageId = img.id; }
  if (busy || useUi.getState().dragging || document.hidden) return;
  // Visible tiles first; then the rest of the library in the background.
  let next: Preset | undefined;
  for (const p of visible.values()) if (!cache.has(p.id)) { next = p; break; }
  if (!next) for (const p of known.values()) if (!cache.has(p.id)) { next = p; break; }
  if (!next) return;
  busy = true;
  renderOne(next).catch((e) => console.warn('[optic] thumbnail failed', e)).finally(() => { busy = false; });
}

function start() {
  if (running) return;
  running = true;
  requestAnimationFrame(tick);
}

/** Thumbnail URL for a preset (null until rendered); `el` is observed for visibility priority. */
export function useThumbnail(p: Preset, el: React.RefObject<HTMLElement | null>): string | null {
  const imgId = useImage((s) => s.image?.id ?? 0);
  const [url, setUrl] = useState<string | null>(() => cache.get(p.id) ?? null);
  useEffect(() => {
    start();
    known.set(p.id, p);
    setUrl(imgId === imageId ? cache.get(p.id) ?? null : null);
    const set = listeners.get(p.id) ?? new Set();
    set.add(setUrl);
    listeners.set(p.id, set);
    const node = el.current;
    const io = node
      ? new IntersectionObserver(([e]) => { if (e.isIntersecting) visible.set(p.id, p); else visible.delete(p.id); })
      : null;
    if (node && io) io.observe(node);
    return () => {
      set.delete(setUrl);
      io?.disconnect();
      visible.delete(p.id);
    };
  }, [p, el, imgId]);
  return url;
}

/** Drop a preset's cached thumbnail (e.g. after editing a user preset). */
export function invalidateThumbnail(id: string) {
  const u = cache.get(id);
  if (u) URL.revokeObjectURL(u);
  cache.delete(id);
}
