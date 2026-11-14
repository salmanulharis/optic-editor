import { t as tr } from '../../i18n';
/** Thumbnail badges and small metadata controls shared by the grid, filmstrip and info panel. */
import { LABEL_CSS, type PhotoRecord } from '../../library/db';
import { formatGroup } from '../../state/libraryStore';
import { tp } from '../../i18n/format';

export function Stars({ n, onSet, size = 'text-2xs' }: { n: number; onSet?(n: number): void; size?: string }) {
  return (
    <span className={`inline-flex ${size} leading-none`} role={onSet ? 'radiogroup' : undefined} aria-label={tr('photoBadges.rating_n_of_5', { n: n })}>
      {[1, 2, 3, 4, 5].map((i) => onSet ? (
        <button key={i} type="button" role="radio" aria-checked={n === i} aria-label={tp('photoBadges.stars', i)}
          className={`px-[1px] ${i <= n ? 'text-star' : 'text-ink-faint hover:text-ink-dim'}`}
          onClick={(e) => { e.stopPropagation(); onSet(n === i ? 0 : i); }}>★</button>
      ) : (
        <span key={i} className={i <= n ? 'text-amber-300' : 'text-white/40'} aria-hidden>★</span>
      ))}
    </span>
  );
}

export function PhotoBadges({ p, compact = false }: { p: PhotoRecord; compact?: boolean }) {
  return (
    <>
      <div className="pointer-events-none absolute start-1 top-1 flex gap-1">
        <span className="rounded bg-black/65 px-1 text-2xs font-medium uppercase tracking-wider text-white/90">{formatGroup(p)}</span>
        {p.edited && <span className="rounded bg-black/65 px-1 text-2xs text-white/90" title={tr('photoBadges.edited')}>✎</span>}
        {p.copies > 0 && <span className="rounded bg-black/65 px-1 text-2xs text-white/90" title={tp('photoBadges.virtual_copies', p.copies)}>⧉{p.copies + 1}</span>}
        {p.error && <span className="rounded bg-red-800 px-1 text-2xs text-white" title={p.error}>!</span>}
      </div>
      <div className="pointer-events-none absolute end-1 top-1 flex gap-1">
        {p.flag === 1 && <span className="rounded bg-black/65 px-1 text-2xs text-white" title={tr('photoBadges.pick')}>⚑</span>}
        {p.flag === -1 && <span className="rounded bg-black/65 px-1 text-2xs text-red-300" title={tr('photoBadges.rejected')}>✕</span>}
        {p.label && <span className="mt-[3px] h-2.5 w-2.5 rounded-full border border-black/60" style={{ background: LABEL_CSS[p.label] }} title={tr('photoBadges.label_label', { label: p.label })} />}
      </div>
      {!compact && p.rating > 0 && (
        <div className="pointer-events-none absolute bottom-1 start-1 rounded bg-black/55 px-1"><Stars n={p.rating} size="text-2xs" /></div>
      )}
    </>
  );
}
