import { useRef, useState } from 'react';
import { type LutInputSpace, defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { deleteLut, importLut, usePresets } from '../../state/presetStore';
import { Section } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection } from './common';

const SPACES: Array<[LutInputSpace, string]> = [
  ['srgb', 'sRGB gamma (Rec.709)'],
  ['p3', 'Display P3 gamma'],
  ['linear', 'Linear (Rec.709)'],
  ['logc3', 'Log (ARRI LogC3)'],
  ['applelog', 'Log (Apple Log)'],
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
      title="LUT"
      enabled={l.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('lut', on)}
      onReset={() => s.apply({ ...defaultRecipe().lut, enabled: l.enabled })}
    >
      <div className="flex items-center gap-1.5">
        <select className="input min-w-0 flex-1" value={l.id ?? ''} onChange={(e) => s.apply({ id: e.target.value || null })}>
          <option value="">None</option>
          {luts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.size}³)</option>)}
          {l.id && !current && <option value={l.id}>Missing LUT ({l.id})</option>}
        </select>
        <button className="rounded border border-line bg-[#2d2d2d] px-2 py-1 text-xs hover:bg-[#333] disabled:opacity-40"
          disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? '…' : 'Import'}
        </button>
        <input ref={fileRef} type="file" accept=".cube,.png" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
      </div>
      {error && <div className="mt-1 rounded bg-[#3a2424] px-2 py-1 text-[11px] text-[#f0b0b0]">Could not import: {error}</div>}
      {l.id && !current && <div className="mt-1 text-[11px] text-[#e0b070]">This LUT is not in your library; it is ignored.</div>}
      <label className="mt-2 block text-[11px] text-ink-dim">Input space</label>
      <select className="input mt-0.5 w-full" value={l.inputSpace} onChange={(e) => s.apply({ inputSpace: e.target.value as LutInputSpace })}>
        {SPACES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <div className="mt-1">
        <Slider label="Amount" value={l.amount} min={0} max={200} step={1} defaultValue={100}
          format={(v) => `${Math.round(v)}%`}
          onChange={(v) => s.set({ amount: v })} onCommit={s.commit} />
      </div>
      {current && current.source !== 'builtin' && (
        <button className="mt-1 text-[11px] text-ink-faint hover:text-[#e07070]"
          onClick={() => { if (confirm(`Delete LUT "${current.name}" from your library?`)) { void deleteLut(current.id); s.apply({ id: null }); } }}>
          Delete this LUT from My LUTs
        </button>
      )}
    </Section>
  );
}
