import { useEffect, useState } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  decimals: number;
  onCommit(v: number): void;
  className?: string;
  ariaLabel?: string;
}

/** Editable number field: commits on Enter or blur, Escape reverts, clamps to range. */
export function NumberInput({ value, min, max, decimals, onCommit, className, ariaLabel }: Props) {
  const fmt = (v: number) => (decimals ? v.toFixed(decimals) : String(Math.round(v)));
  const [text, setText] = useState(fmt(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const v = parseFloat(text.replace(',', '.'));
    if (Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v)));
    else setText(fmt(value));
  };

  return (
    <input
      aria-label={ariaLabel}
      className={`w-12 bg-transparent text-right text-xs tabular-nums text-ink outline-none focus:bg-[#1c1c1c] focus:ring-1 focus:ring-edge rounded px-0.5 ${className ?? ''}`}
      value={text}
      inputMode="decimal"
      onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setText(fmt(value)); setEditing(false); e.currentTarget.blur(); }
      }}
    />
  );
}
