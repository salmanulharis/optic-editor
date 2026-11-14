/**
 * Icon-only button: always has an accessible name, a hit area of at least 24 × 24 px (44 × 44 on
 * touch screens, see `.hit` in index.css) and a tooltip that also works for keyboard and touch.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title' | 'children'> & {
  /** Accessible name and tooltip text. */
  label: string;
  /** Keyboard shortcut shown in the tooltip and exposed as aria-keyshortcuts (e.g. "Ctrl+Z"). */
  shortcut?: string;
  children: ReactNode;
};

export function IconButton({ label, shortcut, children, className = '', type = 'button', ...rest }: Props) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type={type}
        aria-label={label}
        aria-keyshortcuts={shortcut ? toAriaShortcut(shortcut) : undefined}
        className={`hit rounded ${className}`}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** "Ctrl/Cmd+Shift+Z" → "Control+Shift+Z Meta+Shift+Z" (the aria-keyshortcuts syntax). */
function toAriaShortcut(s: string): string {
  const one = (k: string) => k.replace(/\bCtrl\b/g, 'Control').replace(/\bCmd\b/g, 'Meta').replace(/\bAlt\b/g, 'Alt');
  if (s.includes('Ctrl/Cmd')) return [one(s.replace('Ctrl/Cmd', 'Ctrl')), one(s.replace('Ctrl/Cmd', 'Cmd'))].join(' ');
  return one(s);
}
