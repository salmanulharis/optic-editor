/** Thumbnail badges and small metadata controls shared by the grid, filmstrip and info panel. */
import { LABEL_CSS, type PhotoRecord } from '../../library/db';
import { formatGroup } from '../../state/libraryStore';

export function Stars({ n, onSet, size = 'text-[11px]' }: { n: number; onSet?(n: number): void; size?: string }) {
  return (
    <span className={`inline-flex ${size} leading-none`} role={onSet ? 'radiogroup' : undefined} aria-label={`Rating ${n} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => onSet ? (
        <button key={i} type="button" role="radio" aria-checked={n === i} aria-label={`${i} star${i > 1 ? 's' : ''}`}
          className={`px-[1px] ${i <= n ? 'text-[#f2c94c]' : 'text-ink-faint hover:text-ink-dim'}`}
          onClick={(e) => { e.stopPropagation(); onSet(n === i ? 0 : i); }}>★</button>
      ) : (
        <span key={i} className={i <= n ? 'text-[#f2c94c]' : 'text-[#777]'} aria-hidden>★</span>
      ))}
    </span>
  );
}

export function PhotoBadges({ p, compact = false }: { p: PhotoRecord; compact?: boolean }) {
  return (
    <>
      <div className="pointer-events-none absolute left-1 top-1 flex gap-1">
        <span className="rounded bg-black/65 px-1 text-[9px] font-medium uppercase tracking-wider text-[#eee]">{formatGroup(p)}</span>
        {p.edited && <span className="rounded bg-black/65 px-1 text-[9px] text-[#eee]" title="Edited">✎</span>}
        {p.copies > 0 && <span className="rounded bg-black/65 px-1 text-[9px] text-[#eee]" title={`${p.copies} virtual cop${p.copies > 1 ? 'ies' : 'y'}`}>⧉{p.copies + 1}</span>}
        {p.error && <span className="rounded bg-[#7a2a2a] px-1 text-[9px] text-white" title={p.error}>!</span>}
      </div>
      <div className="pointer-events-none absolute right-1 top-1 flex gap-1">
        {p.flag === 1 && <span className="rounded bg-black/65 px-1 text-[10px] text-white" title="Pick">⚑</span>}
        {p.flag === -1 && <span className="rounded bg-black/65 px-1 text-[10px] text-[#e07070]" title="Rejected">✕</span>}
        {p.label && <span className="mt-[3px] h-2.5 w-2.5 rounded-full border border-black/60" style={{ background: LABEL_CSS[p.label] }} title={`${p.label} label`} />}
      </div>
      {!compact && p.rating > 0 && (
        <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/55 px-1"><Stars n={p.rating} size="text-[10px]" /></div>
      )}
    </>
  );
}
