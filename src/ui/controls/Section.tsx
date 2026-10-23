import { type ReactNode, useState } from 'react';

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
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line">
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          className="flex flex-1 items-center gap-1.5 text-left text-xs font-medium uppercase tracking-wider text-ink"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className={`inline-block text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          {title}
        </button>
        {onReset && (
          <button className="text-ink-faint hover:text-ink" onClick={onReset} title={`Reset ${title}`} aria-label={`Reset ${title}`}>
            <ResetIcon />
          </button>
        )}
        {onToggle && (
          <button
            className={enabled ? 'text-ink-dim hover:text-ink' : 'text-ink-faint hover:text-ink'}
            onClick={() => onToggle(!enabled)}
            title={enabled ? `Turn ${title} off` : `Turn ${title} on`}
            aria-pressed={enabled}
          >
            <Eye off={!enabled} />
          </button>
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
      <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">{children}</span>
      {onReset && (
        <button className="text-ink-faint hover:text-ink" onClick={onReset} title="Reset" aria-label="Reset">
          <ResetIcon />
        </button>
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
      <input type="checkbox" className="accent-[#9a9a9a]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
