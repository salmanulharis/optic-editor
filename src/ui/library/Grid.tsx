/**
 * The library grid: virtualised (only the rows in view plus a margin are mounted), so it scrolls
 * smoothly with tens of thousands of photos. Click selects, Shift-click extends, Ctrl/Cmd-click
 * toggles, double-click (or E / Enter) opens in the editor; arrow keys move the focus.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PhotoRecord } from '../../library/db';
import { openPhoto } from '../../library/open';
import { usePhotoImage } from '../../library/previews';
import { useLibrary, useVisiblePhotos } from '../../state/libraryStore';
import { PhotoBadges } from './PhotoBadges';
import { haptic } from '../../app/native';

const GAP = 6;
const LABEL_H = 18;

const Cell = memo(function Cell({ p, size, selected, active, onPick }: { p: PhotoRecord; size: number; selected: boolean; active: boolean; onPick(e: React.MouseEvent, p: PhotoRecord): void }) {
  const url = usePhotoImage(p, size > 300 ? 'preview' : 'thumb');
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${p.fileName}${p.rating ? `, ${p.rating} stars` : ''}${p.flag === 1 ? ', picked' : p.flag === -1 ? ', rejected' : ''}`}
      className={`group relative flex flex-col overflow-hidden rounded ${selected ? 'bg-active ring-2 ring-edge' : 'bg-sunk hover:bg-hover'} ${active ? 'outline outline-2 outline-offset-1 outline-strong' : ''}`}
      style={{ width: size, height: size + LABEL_H }}
      onClick={(e) => onPick(e, p)}
      onDoubleClick={() => void openPhoto(p.id)}
      draggable
      onDragStart={(e) => {
        // Drag onto a collection in the sidebar to add the selection (or this photo) to it.
        if (!useLibrary.getState().selection.has(p.id)) useLibrary.getState().select(p.id);
        e.dataTransfer.setData('application/x-optic-photos', [...useLibrary.getState().selection].join(','));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-1.5">
        {url ? (
          <img src={url} alt="" decoding="async" draggable={false} className={`max-h-full max-w-full object-contain shadow ${p.flag === -1 ? 'opacity-40' : ''}`} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-faint">{p.error ? 'Unreadable' : '…'}</div>
        )}
        <PhotoBadges p={p} />
      </div>
      <div className="truncate px-1.5 text-[10px] leading-[18px] text-ink-dim">{p.fileName}</div>
    </div>
  );
});

/**
 * `touch`: tap opens the photo; a long press starts (and then each tap extends) a multi-selection.
 */
export function Grid({ touch = false }: { touch?: boolean }) {
  const list = useVisiblePhotos();
  const size = useLibrary((s) => s.thumbSize);
  const selection = useLibrary((s) => s.selection);
  const active = useLibrary((s) => s.active);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600, top: 0 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setBox((b) => ({ ...b, w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cellW = size + GAP, cellH = size + LABEL_H + GAP;
  const cols = Math.max(1, Math.floor((box.w - GAP) / cellW));
  const rows = Math.ceil(list.length / cols);
  const first = Math.max(0, Math.floor(box.top / cellH) - 2);
  const last = Math.min(rows, Math.ceil((box.top + box.h) / cellH) + 2);
  const padX = Math.max(GAP, (box.w - cols * cellW + GAP) / 2);

  // Keep the focused photo in view (keyboard navigation, opening from the filmstrip).
  useEffect(() => {
    const el = ref.current;
    const i = list.findIndex((p) => p.id === active);
    if (!el || i < 0) return;
    const y = Math.floor(i / cols) * cellH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + cellH > el.scrollTop + el.clientHeight) el.scrollTop = y + cellH - el.clientHeight;
  }, [active, cols, cellH, list]);

  const longPress = useRef<{ t: number; id: string; fired: boolean } | null>(null);
  const onPick = (e: React.MouseEvent, p: PhotoRecord) => {
    ref.current?.focus({ preventScroll: true });
    if (touch) {
      if (longPress.current?.fired) { longPress.current = null; return; }
      if (useLibrary.getState().selection.size > 0) useLibrary.getState().select(p.id, 'toggle');
      else void openPhoto(p.id);
      return;
    }
    useLibrary.getState().select(p.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'only');
  };
  const onTouchDown = (e: React.PointerEvent) => {
    if (!touch || e.pointerType !== 'touch') return;
    const cell = (e.target as HTMLElement).closest('[data-photo]') as HTMLElement | null;
    if (!cell) return;
    const id = cell.dataset.photo!;
    const lp = { t: performance.now(), id, fired: false };
    longPress.current = lp;
    window.setTimeout(() => {
      if (longPress.current !== lp) return;
      lp.fired = true;
      useLibrary.getState().select(id, 'toggle');
      haptic('medium');
    }, 480);
  };
  const cancelLongPress = () => { if (longPress.current && !longPress.current.fired) longPress.current = null; };

  const onKey = (e: React.KeyboardEvent) => {
    const i = list.findIndex((p) => p.id === active);
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      const n = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i + move)))];
      if (n) useLibrary.getState().select(n.id, e.shiftKey ? 'range' : 'only');
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      void openPhoto(active);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const n = e.key === 'Home' ? list[0] : list[list.length - 1];
      if (n) useLibrary.getState().select(n.id, 'only');
    }
  };

  const cells = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < cols; c++) {
      const p = list[r * cols + c];
      if (!p) break;
      cells.push(
        <div key={p.id} data-photo={p.id} className="absolute" style={{ left: padX + c * cellW, top: GAP + r * cellH }}>
          <Cell p={p} size={size} selected={selection.has(p.id)} active={p.id === active} onPick={onPick} />
        </div>,
      );
    }
  }

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Photos"
      aria-multiselectable="true"
      tabIndex={0}
      className="relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-edge"
      onScroll={(e) => { cancelLongPress(); const top = e.currentTarget.scrollTop; setBox((b) => ({ ...b, top })); }}
      onPointerDown={onTouchDown}
      onPointerUp={() => { if (longPress.current && !longPress.current.fired) longPress.current = null; }}
      onContextMenu={(e) => touch && e.preventDefault()}
      onKeyDown={onKey}
      onClick={(e) => { if (e.target === e.currentTarget) useLibrary.getState().set({ selection: new Set() }); }}
    >
      <div style={{ height: rows * cellH + GAP }} />
      {cells}
    </div>
  );
}
