import { t as tr } from '../../i18n';
import { type ReactNode, useState } from 'react';
import { IconButton } from './IconButton';
import { useSectionGroup } from '../layout/SectionGroup';

interface Props {
  title: string;
  enabled?: boolean;
  onToggle?(on: boolean): void;
  onReset?(): void;
  children: ReactNode;
  defaultOpen?: boolean;
}

const Eye = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M3 3l18 18" />}
  </svg>
);

const ResetIcon = () => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

/** Collapsible panel section with an on/off (eye) toggle and a reset button. */
export function Section({ title, enabled = true, onToggle, onReset, children, defaultOpen = true }: Props) {
  const group = useSectionGroup();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  // In a solo group only one section is open; otherwise each section keeps its own state.
  const open = group?.solo ? group.openId === title : localOpen;
  const setOpen = (next: boolean) => {
    if (group?.solo) group.setOpen(next ? title : null);
    else setLocalOpen(next);
    if (next) group?.noteOpened(title);
  };
  return (
    <section className="border-b border-line">
      <header className="flex items-center gap-1 px-3 py-1">
        <button
          className="flex min-h-[28px] flex-1 items-center gap-1.5 text-start text-xs font-medium uppercase tracking-wider text-ink"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span aria-hidden className={`inline-block text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          {title}
        </button>
        {onReset && (
          <IconButton className="text-ink-faint hover:text-ink" onClick={onReset} label={tr('section.reset_title', { title: title })}>
            <ResetIcon />
          </IconButton>
        )}
        {onToggle && (
          <IconButton
            className={enabled ? 'text-ink-dim hover:text-ink' : 'text-ink-faint hover:text-ink'}
            onClick={() => onToggle(!enabled)}
            label={enabled ? `Turn ${title} off` : `Turn ${title} on`}
          >
            <Eye off={!enabled} />
          </IconButton>
        )}
      </header>
      {open && <div className={`px-3 pb-3 ${enabled ? '' : 'opacity-50'}`}>{children}</div>}
    </section>
  );
}

/** Sub-heading inside a section (e.g. "Noise reduction" inside Detail), with an optional reset. */
export function SubHead({ children, onReset }: { children: ReactNode; onReset?(): void }) {
  return (
    <div className="mb-0.5 mt-2.5 flex items-center justify-between first:mt-0">
      <span className="text-2xs font-medium uppercase tracking-wider text-ink-faint">{children}</span>
      {onReset && (
        <IconButton className="text-ink-faint hover:text-ink" onClick={onReset} label={typeof children === 'string' ? `Reset ${children}` : tr('section.reset')}>
          <ResetIcon />
        </IconButton>
      )}
    </div>
  );
}

/** Small select styled like the other controls. */
export function Select<T extends string>({ value, options, onChange, title, label }: { value: T; options: Array<[T, string]>; onChange(v: T): void; title?: string; label?: string }) {
  return (
    <select
      title={title}
      aria-label={label ?? title}
      className="rounded border border-line bg-raise px-1.5 py-0.5 text-xs text-ink outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function ToolButton(props: { active?: boolean; onClick(): void; children: ReactNode; title: string; className?: string }) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      className={`rounded border px-2 py-1 text-xs ${
        props.active ? 'border-edge bg-active text-strong' : 'border-line bg-raise text-ink hover:bg-hover'
      } ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-1 text-xs text-ink-dim" title={hint}>
      <span>{label}</span>
      <input type="checkbox" className="accent-control" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
