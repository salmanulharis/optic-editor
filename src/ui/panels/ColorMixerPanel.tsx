import { useState } from 'react';
import { HSL_CENTERS_DEG } from '../../pipeline/stages/40_hsl';
import { HSL_BANDS, type HslAdjust, type HslBand, defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { autoBwMix } from '../../app/presetActions';
import { Section } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { grad } from './common';

type Prop = keyof HslAdjust;
const TABS: Array<[Prop, string]> = [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']];
const NAMES: Record<HslBand, string> = {
  red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta',
};

/** Track gradients drawn with CSS oklch() so they show the actual colours being adjusted. */
function track(prop: Prop, i: number) {
  const h = HSL_CENTERS_DEG[i];
  if (prop === 'hue') return grad(`oklch(0.72 0.14 ${h - 30})`, `oklch(0.72 0.14 ${h})`, `oklch(0.72 0.14 ${h + 30})`);
  if (prop === 'sat') return grad(`oklch(0.72 0 ${h})`, `oklch(0.72 0.17 ${h})`);
  return grad(`oklch(0.35 0.1 ${h})`, `oklch(0.9 0.08 ${h})`);
}

export function ColorMixerPanel() {
  const mono = useEdit((s) => s.recipe.treatment === 'monochrome');
  return mono ? <BwMixerPanel /> : <HslPanel />;
}

/** B&W mixer: each colour band's contribution to the grey (−100…+100). */
function BwMixerPanel() {
  const m = useEdit((s) => s.recipe.bwMixer);
  const set = (patch: Partial<typeof m>) => useEdit.getState().update((r) => ({ ...r, bwMixer: { ...r.bwMixer, ...patch } }));
  const commit = () => useEdit.getState().commit();
  return (
    <Section
      title="B&W Mixer"
      enabled={m.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('bwMixer', on)}
      onReset={() => useEdit.getState().apply((r) => ({ ...r, bwMixer: { ...defaultRecipe().bwMixer, enabled: r.bwMixer.enabled } }))}
    >
      <div className="mb-2 flex justify-end">
        <button className="rounded border border-line bg-[#2d2d2d] px-2 py-1 text-xs hover:bg-[#333]" onClick={autoBwMix}>Auto mix</button>
      </div>
      {HSL_BANDS.map((b, i) => (
        <Slider key={b} label={NAMES[b]} value={m[b]} min={-100} max={100} step={1} defaultValue={0}
          track={grad('#202020', `oklch(0.62 0.12 ${HSL_CENTERS_DEG[i]})`, '#e8e8e8')}
          onChange={(v) => set({ [b]: v })} onCommit={commit} />
      ))}
      <div className="mt-1 border-t border-line pt-1">
        <Slider label="Monochrome amount" value={m.mix} min={0} max={100} step={1} defaultValue={100}
          format={(v) => `${Math.round(v)}%`} onChange={(v) => set({ mix: v })} onCommit={commit} />
      </div>
    </Section>
  );
}

function HslPanel() {
  const hsl = useEdit((s) => s.recipe.hsl);
  const [tab, setTab] = useState<Prop>('sat');
  const set = (band: HslBand, v: number) =>
    useEdit.getState().update((r) => ({
      ...r,
      hsl: { ...r.hsl, bands: { ...r.hsl.bands, [band]: { ...r.hsl.bands[band], [tab]: v } } },
    }));
  const commit = () => useEdit.getState().commit();

  return (
    <Section
      title="Color Mixer"
      enabled={hsl.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('hsl', on)}
      onReset={() => useEdit.getState().apply((r) => ({ ...r, hsl: { ...defaultRecipe().hsl, enabled: r.hsl.enabled } }))}
    >
      <div className="mb-2 flex rounded border border-line text-xs">
        {TABS.map(([p, label]) => (
          <button
            key={p}
            className={`flex-1 py-1 ${tab === p ? 'bg-[#3a3a3a] text-white' : 'text-ink-dim hover:text-ink'}`}
            onClick={() => setTab(p)}
          >
            {label}
          </button>
        ))}
      </div>
      {HSL_BANDS.map((b, i) => (
        <Slider
          key={`${tab}-${b}`}
          label={NAMES[b]}
          value={hsl.bands[b][tab]}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          track={track(tab, i)}
          onChange={(v) => set(b, v)}
          onCommit={commit}
        />
      ))}
    </Section>
  );
}
