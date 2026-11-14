import { t as tr } from '../../i18n';
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
import { confirmDialog } from '../feedback/dialogs';

function CopyThumb({ copy }: { copy: VirtualCopy }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const img = useImage((s) => s.image);
  const dragging = useUi((s) => s.dragging);
  const recipe = copy.steps[copy.index].recipe;
  useEffect(() => {
    if (!img || dragging) return;
    let cancelled = false;
    let t = window.setTimeout(function draw() {
      if (cancelled) return;
      const r = getRenderer();
      const rec = effectiveRecipe(recipe, img.asShot);
      // Wait for the proxy upload (several frames for large photos) and the shader compile.
      if (!r || !r.ready || !r.thumbnailReady(rec)) { t = window.setTimeout(draw, 200); return; }
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
      title={p.fileName} aria-label={tr('filmstrip.open_filename', { fileName: p.fileName })} aria-current={active}
      onClick={(ev) => {
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) useLibrary.getState().select(p.id, ev.shiftKey ? 'range' : 'toggle');
        else void openPhoto(p.id);
      }}>
      {url ? <img src={url} alt="" draggable={false} className={`max-h-full max-w-full object-contain ${p.flag === -1 ? 'opacity-40' : ''}`} /> : <span className="text-2xs text-ink-faint">…</span>}
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
    <div ref={ref} dir="ltr" className="relative h-[80px] min-w-0 flex-1 overflow-x-auto overflow-y-hidden" role="group" aria-labelledby="strip-photos"
      onScroll={(e) => { const left = e.currentTarget.scrollLeft; setBox((b) => ({ ...b, left })); }}
      onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
      <div style={{ width: list.length * STRIP_W, height: 1 }} />
      {cells}
    </div>
  );
}

/** Small vertical label in front of a filmstrip group. */
function StripLabel({ children, id }: { children: string; id: string }) {
  return (
    <span id={id} className="shrink-0 select-none text-2xs font-medium uppercase tracking-wider text-ink-faint [writing-mode:vertical-rl] rotate-180">
      {children}
    </span>
  );
}

/** Buttons on a version tile: visible on hover, on keyboard focus, and always on touch screens. */
const tileAction = 'hit absolute top-0.5 hidden rounded bg-black/70 px-1 text-2xs text-white group-hover:inline-flex group-focus-within:inline-flex [@media(pointer:coarse)]:inline-flex';

export function Filmstrip() {
  const copies = useEdit((s) => s.copies);
  const active = useEdit((s) => s.active);
  const image = useImage((s) => s.image);
  const [renaming, setRenaming] = useState<string | null>(null);
  const e = useEdit.getState();
  if (!image) return <div className="flex h-[92px] shrink-0 items-center gap-2 border-t border-line bg-panel px-2"><StripLabel id="strip-photos">{tr('filmstrip.photos')}</StripLabel><LibraryStrip /></div>;
  const remove = async (c: VirtualCopy) => {
    const ok = await confirmDialog({
      title: tr('filmstrip.delete_name', { name: c.name }),
      message: tr('filmstrip.this_version_and_its_history_are'),
      confirmLabel: tr('filmstrip.delete_version'),
      danger: true,
    });
    if (ok) e.deleteCopy(c.id);
  };
  return (
    <div className="flex h-[92px] shrink-0 items-center gap-2 border-t border-line bg-panel px-2">
      <StripLabel id="strip-versions">{tr('filmstrip.versions')}</StripLabel>
      <div className="relative flex gap-2" role="group" aria-labelledby="strip-versions">
        {copies.map((c, i) => (
          <div key={c.id}
            className={`group relative flex h-[76px] w-[96px] shrink-0 flex-col overflow-hidden rounded border ${c.id === active ? 'border-ink-dim' : 'border-line hover:border-edge'}`}
            style={i > 0 ? { boxShadow: '-3px -3px 0 -1px rgb(var(--c-sunk)), -3px -3px 0 0 rgb(var(--c-edge))' } : undefined}>
            <button type="button" className="min-h-0 flex-1 bg-sunk" aria-pressed={c.id === active}
              aria-label={c.id === active ? tr('filmstrip.version_editing', { name: c.name }) : tr('filmstrip.version_edit', { name: c.name })}
              title={c.name}
              onClick={() => e.switchCopy(c.id)}
              onKeyDown={(ev) => { if (ev.key === 'F2') { ev.preventDefault(); setRenaming(c.id); } }}>
              <CopyThumb copy={c} />
            </button>
            {renaming === c.id ? (
              <input autoFocus defaultValue={c.name} aria-label={tr('filmstrip.version_name')} className="input h-4 rounded-none px-1 py-0 text-2xs"
                onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { e.renameCopy(c.id, ev.currentTarget.value); setRenaming(null); } if (ev.key === 'Escape') setRenaming(null); }}
                onBlur={(ev) => { e.renameCopy(c.id, ev.currentTarget.value); setRenaming(null); }} />
            ) : (
              <div className="truncate px-1 text-2xs text-ink-dim" onDoubleClick={() => setRenaming(c.id)}>{c.name}</div>
            )}
            {c.id !== active && (
              <button type="button" className={`${tileAction} end-0.5`} aria-label={tr('filmstrip.compare_side_by_side_with_name', { name: c.name })} title={tr('filmstrip.compare_side_by_side_with_this')}
                onClick={() => useUi.getState().set({ compareSource: `copy:${c.id}`, compareMode: 'side' })}>⇆</button>
            )}
            {copies.length > 1 && (
              <button type="button" className={`${tileAction} start-0.5`} aria-label={tr('filmstrip.delete_name_2', { name: c.name })} title={tr('filmstrip.delete_this_version')}
                onClick={() => void remove(c)}>✕</button>
            )}
          </div>
        ))}
      </div>
      <button className="h-[76px] shrink-0 rounded border border-dashed border-line px-2 text-2xs text-ink-dim hover:border-edge hover:text-ink"
        title={tr('filmstrip.create_a_virtual_copy_a_second')} onClick={() => e.createVirtualCopy()}>{tr('filmstrip.virtual')}<br />{tr('filmstrip.copy')}</button>
      <span className="h-14 w-px shrink-0 bg-line" aria-hidden />
      <StripLabel id="strip-photos">{tr('filmstrip.photos')}</StripLabel>
      <LibraryStrip />
    </div>
  );
}
