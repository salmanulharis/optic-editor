import { t as tr } from '../../i18n';
import { useRef, useState } from 'react';
import { type LutInputSpace, defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { deleteLut, importLut, usePresets } from '../../state/presetStore';
import { Section } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection } from './common';
import { confirmDialog } from '../feedback/dialogs';

const SPACES: Array<[LutInputSpace, string]> = [
  ['srgb', tr('lutPanel.srgb_gamma_rec_709')],
  ['p3', tr('lutPanel.display_p3_gamma')],
  ['linear', tr('lutPanel.linear_rec_709')],
  ['logc3', tr('lutPanel.log_arri_logc3')],
  ['applelog', tr('lutPanel.log_apple_log')],
];

export function LutPanel() {
  const l = useEdit((s) => s.recipe.lut);
  const luts = usePresets((s) => s.luts);
  const s = bindSection('lut');
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = luts.find((x) => x.id === l.id);

  const onFile = async (f: File) => {
    setError(null);
    setBusy(true);
    try {
      const lut = await importLut(f);
      s.apply({ id: lut.id, enabled: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={tr('lutPanel.lut')}
      enabled={l.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('lut', on)}
      onReset={() => s.apply({ ...defaultRecipe().lut, enabled: l.enabled })}
    >
      <div className="flex items-center gap-1.5">
        <select className="input min-w-0 flex-1" aria-label={tr('lutPanel.lut')} value={l.id ?? ''} onChange={(e) => s.apply({ id: e.target.value || null })}>
          <option value="">{tr('lutPanel.none')}</option>
          {luts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.size}³)</option>)}
          {l.id && !current && <option value={l.id}>{tr('lutPanel.missing_lut', { id: l.id })}</option>}
        </select>
        <button className="rounded border border-line bg-raise px-2 py-1 text-xs hover:bg-hover disabled:opacity-40"
          disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? '…' : tr('lutPanel.import')}
        </button>
        <input ref={fileRef} type="file" accept=".cube,.png" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
      </div>
      {error && <div className="mt-1 rounded bg-danger-bg px-2 py-1 text-2xs text-ink">{tr('lutPanel.could_not_import_error', { error: error })}</div>}
      {l.id && !current && <div className="mt-1 text-2xs text-warn">{tr('lutPanel.this_lut_is_not_in_your')}</div>}
      <label className="mt-2 block text-2xs text-ink-dim">{tr('lutPanel.input_space')}</label>
      <select className="input mt-0.5 w-full" aria-label={tr('lutPanel.lut_input_space')} value={l.inputSpace} onChange={(e) => s.apply({ inputSpace: e.target.value as LutInputSpace })}>
        {SPACES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <div className="mt-1">
        <Slider label={tr('lutPanel.amount')} value={l.amount} min={0} max={200} step={1} defaultValue={100}
          format={(v) => `${Math.round(v)}%`}
          onChange={(v) => s.set({ amount: v })} onCommit={s.commit} />
      </div>
      {current && current.source !== 'builtin' && (
        <button className="mt-1 text-2xs text-ink-faint hover:text-danger"
          onClick={async () => { if (await confirmDialog({ title: tr('lutPanel.delete_the_lut_name', { name: current.name }), message: tr('lutPanel.it_is_removed_from_my_luts'), confirmLabel: tr('lutPanel.delete_lut'), danger: true })) { void deleteLut(current.id); s.apply({ id: null }); } }}>{tr('lutPanel.delete_this_lut_from_my_luts')}</button>
      )}
    </Section>
  );
}
