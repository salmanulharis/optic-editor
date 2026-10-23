/**
 * The editor's filmstrip: the open photo's virtual copies (a stack: the original and its copies,
 * each its own recipe, history and snapshots; click to switch, ⇆ to compare side by side, double-
 * click the name to rename; GPU thumbnails when idle), then the library's visible photos
 * (virtualised; click to open, ← → move through them).
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PhotoRecord } from '../../library/db';
import { openPhoto } from '../../library/open';
import { usePhotoImage } from '../../library/previews';
import { useLibrary, useVisiblePhotos } from '../../state/libraryStore';
import { PhotoBadges } from '../library/PhotoBadges';
import { getRenderer } from '../../app/actions';
import { effectiveRecipe } from '../../recipe/schema';
import { type VirtualCopy, useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';

function CopyThumb({ copy }: { copy: VirtualCopy }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const img = useImage((s) => s.image);
  const dragging = useUi((s) => s.dragging);
  const recipe = copy.steps[copy.index].recipe;
  useEffect(() => {
    if (!img || dragging) return;
    let cancelled = false;
    const t = window.setTimeout(function draw() {
      const r = getRenderer();
      if (cancelled || !r || !r.ready) return;
      const rec = effectiveRecipe(recipe, img.asShot);
      if (!r.thumbnailReady(rec)) { window.setTimeout(draw, 200); return; }
      const data = r.thumbnail(rec, 160);
      const c = ref.current;
      if (!data || !c) return;
      c.width = data.width;
      c.height = data.height;
      c.getContext('2d')!.putImageData(data, 0, 0);
    }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [img, recipe, dragging]);
  return <canvas ref={ref} className="h-full w-full object-contain" />;
}

const STRIP_W = 84;

const StripCell = memo(function StripCell({ p, active, selected }: { p: PhotoRecord; active: boolean; selected: boolean }) {
  const url = usePhotoImage(p, 'thumb');
  return (
    <button
      className={`relative flex h-[76px] w-[78px] shrink-0 items-center justify-center overflow-hidden rounded border ${active ? 'border-strong' : selected ? 'border-edge' : 'border-line hover:border-edge'} bg-sunk`}
      title={p.fileName} aria-label={`Open ${p.fileName}`} aria-current={active}
      onClick={(ev) => {
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) useLibrary.getState().select(p.id, ev.shiftKey ? 'range' : 'toggle');
        else void openPhoto(p.id);
      }}>
      {url ? <img src={url} alt="" draggable={false} className={`max-h-full max-w-full object-contain ${p.flag === -1 ? 'opacity-40' : ''}`} /> : <span className="text-[10px] text-ink-faint">…</span>}
      <PhotoBadges p={p} compact />
    </button>
  );
});

/** The library strip, virtualised horizontally. */
function LibraryStrip() {
  const list = useVisiblePhotos();
  const active = useLibrary((s) => s.active);
  const selection = useLibrary((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 600, left: 0 });
  const empty = !list.length;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox((b) => ({ ...b, w: el.clientWidth })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);
  useEffect(() => {
    const el = ref.current;
    const i = list.findIndex((p) => p.id === active);
    if (!el || i < 0) return;
    const x = i * STRIP_W;
    if (x < el.scrollLeft || x + STRIP_W > el.scrollLeft + el.clientWidth) el.scrollLeft = x - el.clientWidth / 2 + STRIP_W / 2;
  }, [active, list]);
  if (empty) return null;
  const first = Math.max(0, Math.floor(box.left / STRIP_W) - 4);
  const last = Math.min(list.length, Math.ceil((box.left + box.w) / STRIP_W) + 4);
  const cells = [];
  for (let i = first; i < last; i++) {
    const p = list[i];
    cells.push(<div key={p.id} className="absolute top-0" style={{ left: i * STRIP_W }}><StripCell p={p} active={p.id === active} selected={selection.has(p.id)} /></div>);
  }
  return (
    <div ref={ref} className="relative h-[80px] min-w-0 flex-1 overflow-x-auto overflow-y-hidden" aria-label="Library photos"
      onScroll={(e) => { const left = e.currentTarget.scrollLeft; setBox((b) => ({ ...b, left })); }}
      onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
      <div style={{ width: list.length * STRIP_W, height: 1 }} />
      {cells}
    </div>
  );
}

export function Filmstrip() {
  const copies = useEdit((s) => s.copies);
  const active = useEdit((s) => s.active);
  const image = useImage((s) => s.image);
  const [renaming, setRenaming] = useState<string | null>(null);
  const e = useEdit.getState();
  if (!image) return <div className="flex h-[92px] shrink-0 items-center gap-2 border-t border-line bg-panel px-2"><LibraryStrip /></div>;
  return (
    <div className="flex h-[92px] shrink-0 items-center gap-2 border-t border-line bg-panel px-2">
      <div className="relative flex gap-2">
        {copies.map((c, i) => (
          <div key={c.id}
            className={`group relative flex h-[76px] w-[96px] shrink-0 cursor-pointer flex-col overflow-hidden rounded border ${c.id === active ? 'border-ink-dim' : 'border-line hover:border-edge'}`}
            style={i > 0 ? { boxShadow: '-3px -3px 0 -1px #2a2a2a, -3px -3px 0 0 #444' } : undefined}
            onClick={() => e.switchCopy(c.id)}
            title={c.name}>
            <div className="min-h-0 flex-1 bg-sunk"><CopyThumb copy={c} /></div>
            {renaming === c.id ? (
              <input autoFocus defaultValue={c.name} className="input h-4 rounded-none px-1 py-0 text-[10px]" onClick={(ev) => ev.stopPropagation()}
                onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { e.renameCopy(c.id, ev.currentTarget.value); setRenaming(null); } if (ev.key === 'Escape') setRenaming(null); }}
                onBlur={(ev) => { e.renameCopy(c.id, ev.currentTarget.value); setRenaming(null); }} />
            ) : (
              <div className="truncate px-1 text-[10px] text-ink-dim" onDoubleClick={(ev) => { ev.stopPropagation(); setRenaming(c.id); }}>{c.name}</div>
            )}
            {c.id !== active && (
              <button className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 px-1 text-[10px] text-ink group-hover:block" title="Compare side by side with this copy"
                onClick={(ev) => { ev.stopPropagation(); useUi.getState().set({ compareSource: `copy:${c.id}`, compareMode: 'side' }); }}>⇆</button>
            )}
            {copies.length > 1 && (
              <button className="absolute left-0.5 top-0.5 hidden rounded bg-black/70 px-1 text-[10px] text-ink group-hover:block" title="Delete this copy"
                onClick={(ev) => { ev.stopPropagation(); if (confirm(`Delete “${c.name}” and its history?`)) e.deleteCopy(c.id); }}>✕</button>
            )}
          </div>
        ))}
      </div>
      <button className="h-[76px] shrink-0 rounded border border-dashed border-line px-2 text-[11px] text-ink-dim hover:border-edge hover:text-ink"
        title="Create a virtual copy: a second, independent edit of this photo" onClick={() => e.createVirtualCopy()}>
        + Virtual<br />copy
      </button>
      <span className="h-14 w-px shrink-0 bg-line" aria-hidden />
      <LibraryStrip />
    </div>
  );
}
