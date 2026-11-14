/**
 * In-app replacements for window.confirm / prompt / alert. Same call shape (a promise of the answer)
 * so call sites keep their logic; the dialogs use the shared Modal (focus trap, Escape, focus
 * return), follow the theme and never block the page. Requests queue and show one at a time.
 */
import { useState } from 'react';
import { create } from 'zustand';
import { t } from '../../i18n';
import { Modal } from '../controls/Modal';

interface ConfirmReq { kind: 'confirm'; title: string; message?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean; resolve(v: boolean): void }
interface PromptReq { kind: 'prompt'; title: string; label: string; initial?: string; confirmLabel?: string; validate?(v: string): string | null; resolve(v: string | null): void }
interface MessageReq { kind: 'message'; title: string; message?: string; items?: string[]; resolve(): void }
type Req = (ConfirmReq | PromptReq | MessageReq) & { id?: number };
let nextId = 1;

const useDialogs = create<{ queue: Req[] }>(() => ({ queue: [] }));

const enqueue = (r: Req) => useDialogs.setState((s) => ({ queue: [...s.queue, { ...r, id: nextId++ }] }));
const finish = () => useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));

/** Ask before an action. Resolves true when confirmed; Escape / Cancel / backdrop resolve false. */
export function confirmDialog(o: { title: string; message?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: 'confirm', ...o, resolve }));
}

/** Ask for a short text (a name). Resolves the trimmed text, or null when cancelled. */
export function promptDialog(o: { title: string; label: string; initial?: string; confirmLabel?: string; validate?(v: string): string | null }): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'prompt', ...o, resolve }));
}

/** Tell the user something (optionally a list, e.g. errors per file). */
export function messageDialog(o: { title: string; message?: string; items?: string[] }): Promise<void> {
  return new Promise((resolve) => enqueue({ kind: 'message', ...o, resolve }));
}

const btn = 'hit rounded px-3 py-1.5 text-xs';
const secondary = `${btn} border border-line text-ink hover:bg-hover`;
const primary = `${btn} bg-accent font-medium text-on-accent hover:bg-accent-hi`;
const danger = `${btn} bg-danger font-medium text-on-accent hover:opacity-90`;

function ConfirmView({ r }: { r: ConfirmReq }) {
  const done = (v: boolean) => { finish(); r.resolve(v); };
  return (
    <Modal layer="z-[55]" title={r.title} onClose={() => done(false)}>
      {r.message && <p className="mb-4 whitespace-pre-line text-xs text-ink-dim">{r.message}</p>}
      <div className="flex justify-end gap-2">
        {/* Destructive actions start on Cancel, so Enter never deletes by accident. */}
        <button type="button" className={secondary} autoFocus={r.danger} onClick={() => done(false)}>{r.cancelLabel ?? t('dialog.cancel')}</button>
        <button type="button" className={r.danger ? danger : primary} autoFocus={!r.danger} onClick={() => done(true)}>{r.confirmLabel}</button>
      </div>
    </Modal>
  );
}

function PromptView({ r }: { r: PromptReq }) {
  const [value, setValue] = useState(r.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const done = (v: string | null) => { finish(); r.resolve(v); };
  const submit = () => {
    const v = value.trim();
    const err = !v ? t('dialog.required') : r.validate?.(v) ?? null;
    if (err) { setError(err); return; }
    done(v);
  };
  return (
    <Modal layer="z-[55]" title={r.title} onClose={() => done(null)}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <label htmlFor="optic-prompt-input" className="mb-1 block text-2xs text-ink-dim">{r.label}</label>
        <input id="optic-prompt-input" className="input w-full" value={value} autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          aria-invalid={!!error} aria-describedby={error ? 'optic-prompt-error' : undefined} />
        <p id="optic-prompt-error" className="mt-1 min-h-[16px] text-2xs text-danger" role={error ? 'alert' : undefined}>{error ?? ''}</p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className={secondary} onClick={() => done(null)}>{t('dialog.cancel')}</button>
          <button type="submit" className={primary}>{r.confirmLabel ?? t('dialog.ok')}</button>
        </div>
      </form>
    </Modal>
  );
}

function MessageView({ r }: { r: MessageReq }) {
  const [copied, setCopied] = useState(false);
  const done = () => { finish(); r.resolve(); };
  const text = [r.message, ...(r.items ?? [])].filter(Boolean).join('\n');
  return (
    <Modal layer="z-[55]" title={r.title} onClose={done}>
      {r.message && <p className="mb-2 whitespace-pre-line text-xs text-ink-dim">{r.message}</p>}
      {!!r.items?.length && (
        <ul className="mb-2 max-h-[50vh] select-text space-y-1 overflow-y-auto rounded border border-line bg-sunk p-2 text-2xs text-ink">
          {r.items.map((it, i) => <li key={i} className="break-words">{it}</li>)}
        </ul>
      )}
      <div className="mt-3 flex justify-end gap-2">
        {!!r.items?.length && navigator.clipboard && (
          <button type="button" className={secondary} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
            {copied ? t('dialog.copied') : t('dialog.copy')}
          </button>
        )}
        <button type="button" className={primary} autoFocus onClick={done}>{t('dialog.close')}</button>
      </div>
    </Modal>
  );
}

/** Renders the current dialog request. Mounted once (desktop and touch layouts). */
export function DialogHost() {
  const r = useDialogs((s) => s.queue[0]);
  if (!r) return null;
  // A fresh component per request (keyed by its id) so state never leaks between dialogs.
  if (r.kind === 'confirm') return <ConfirmView key={r.id} r={r} />;
  if (r.kind === 'prompt') return <PromptView key={r.id} r={r} />;
  return <MessageView key={r.id} r={r} />;
}
