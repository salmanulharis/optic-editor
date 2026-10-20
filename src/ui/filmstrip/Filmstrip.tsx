/**
 * Filmstrip of the open photo's virtual copies (a stack: the original and its copies, each its own
 * recipe, history and snapshots). Click to switch, ⇆ to compare side by side with the current copy,
 * double-click the name to rename. Thumbnails render on the GPU when idle.
 */
import { useEffect, useRef, useState } from 'react';
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

export function Filmstrip() {
  const copies = useEdit((s) => s.copies);
  const active = useEdit((s) => s.active);
  const image = useImage((s) => s.image);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!image) return null;
  const e = useEdit.getState();
  return (
    <div className="flex h-[92px] shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-panel px-2">
      <div className="relative flex gap-2">
        {copies.map((c, i) => (
          <div key={c.id}
            className={`group relative flex h-[76px] w-[96px] shrink-0 cursor-pointer flex-col overflow-hidden rounded border ${c.id === active ? 'border-[#bbb]' : 'border-line hover:border-[#555]'}`}
            style={i > 0 ? { boxShadow: '-3px -3px 0 -1px #2a2a2a, -3px -3px 0 0 #444' } : undefined}
            onClick={() => e.switchCopy(c.id)}
            title={c.name}>
            <div className="min-h-0 flex-1 bg-[#1a1a1a]"><CopyThumb copy={c} /></div>
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
      <button className="h-[76px] shrink-0 rounded border border-dashed border-line px-2 text-[11px] text-ink-dim hover:border-[#555] hover:text-ink"
        title="Create a virtual copy: a second, independent edit of this photo" onClick={() => e.createVirtualCopy()}>
        + Virtual<br />copy
      </button>
    </div>
  );
}
