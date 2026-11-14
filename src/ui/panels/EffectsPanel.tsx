import { t as tr } from '../../i18n';
import { defaultRecipe, type GrainType, type Recipe, type VignetteStyle } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { Section, Select, SubHead } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';

type Effects = Recipe['effects'];

/** Grain types: amount / size / roughness of typical film stocks and formats. */
export const GRAIN_TYPES: Record<Exclude<GrainType, 'custom'>, { label: string; amount: number; size: number; roughness: number }> = {
  fine: { label: tr('effectsPanel.fine_iso_100'), amount: 15, size: 12, roughness: 30 },
  medium: { label: tr('effectsPanel.medium_iso_400'), amount: 25, size: 25, roughness: 50 },
  coarse: { label: tr('effectsPanel.coarse_iso_3200'), amount: 45, size: 55, roughness: 70 },
  '35mm': { label: tr('effectsPanel.35mm'), amount: 30, size: 35, roughness: 55 },
  mediumFormat: { label: tr('effectsPanel.medium_format'), amount: 18, size: 15, roughness: 40 },
};

const HUE_TRACK = grad('#ff3b30', '#ff9500', '#ffcc00', '#ff2d55');
const WARM_TRACK = grad('#6c8fd0', '#9a9a9a', '#d6b25a');

/** Effects: texture, clarity, dehaze, grain, halation, bloom and the post-crop vignette. */
export function EffectsPanel() {
  const e = useEdit((s) => s.recipe.effects);
  const s = bindSection('effects');
  const d = defaultRecipe().effects;
  const cur = () => useEdit.getState().recipe.effects;
  const sub = <K extends 'grain' | 'halation' | 'bloom' | 'vignette'>(k: K, patch: Partial<Effects[K]>) => s.set({ [k]: { ...cur()[k], ...patch } } as Partial<Effects>);
  const sl = (label: string, value: number, set: (v: number) => void, opts: { min?: number; max?: number; def?: number; track?: string } = {}) => (
    <Slider label={label} value={value} min={opts.min ?? 0} max={opts.max ?? 100} step={1} defaultValue={opts.def ?? 0} track={opts.track} onChange={set} onCommit={s.commit} />
  );
  return (
    <Section
      title={tr('effectsPanel.effects')}
      enabled={e.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('effects', on)}
      onReset={() => s.apply({ ...d, enabled: e.enabled })}
    >
      {sl(tr('effectsPanel.texture'), e.texture, (v) => s.set({ texture: v }), { min: -100 })}
      {sl(tr('effectsPanel.clarity'), e.clarity, (v) => s.set({ clarity: v }), { min: -100 })}
      {sl(tr('effectsPanel.dehaze'), e.dehaze, (v) => s.set({ dehaze: v }), { min: -100 })}

      <SubHead onReset={() => s.apply({ grain: { ...d.grain } })}>{tr('effectsPanel.grain')}</SubHead>
      <div className="mb-1 flex items-center justify-between text-xs text-ink-dim">
        <span>{tr('effectsPanel.type')}</span>
        <Select<GrainType>
          label={tr('effectsPanel.grain_type')}
          value={e.grain.type}
          options={[['custom', tr('effectsPanel.custom')], ...Object.entries(GRAIN_TYPES).map(([k, v]) => [k, v.label] as [GrainType, string])]}
          onChange={(t) => {
            if (t === 'custom') return s.apply({ grain: { ...cur().grain, type: t } });
            const g = GRAIN_TYPES[t];
            s.apply({ grain: { ...cur().grain, type: t, amount: g.amount, size: g.size, roughness: g.roughness } });
          }}
        />
      </div>
      {sl(tr('effectsPanel.amount'), e.grain.amount, (v) => sub('grain', { amount: v, type: 'custom' }))}
      {sl(tr('effectsPanel.size'), e.grain.size, (v) => sub('grain', { size: v, type: 'custom' }), { def: d.grain.size })}
      {sl(tr('effectsPanel.roughness'), e.grain.roughness, (v) => sub('grain', { roughness: v, type: 'custom' }), { def: d.grain.roughness })}
      {sl(tr('effectsPanel.color'), e.grain.color, (v) => sub('grain', { color: v }))}

      <SubHead onReset={() => s.apply({ halation: { ...d.halation } })}>{tr('effectsPanel.halation')}</SubHead>
      {sl(tr('effectsPanel.amount'), e.halation.amount, (v) => sub('halation', { amount: v }))}
      {sl(tr('effectsPanel.threshold'), e.halation.threshold, (v) => sub('halation', { threshold: v }), { def: d.halation.threshold })}
      {sl(tr('effectsPanel.radius'), e.halation.radius, (v) => sub('halation', { radius: v }), { def: d.halation.radius })}
      {sl(tr('effectsPanel.hue'), e.halation.hue, (v) => sub('halation', { hue: v }), { max: 60, def: d.halation.hue, track: HUE_TRACK })}

      <SubHead onReset={() => s.apply({ bloom: { ...d.bloom } })}>{tr('effectsPanel.bloom')}</SubHead>
      {sl(tr('effectsPanel.amount'), e.bloom.amount, (v) => sub('bloom', { amount: v }))}
      {sl(tr('effectsPanel.threshold'), e.bloom.threshold, (v) => sub('bloom', { threshold: v }), { def: d.bloom.threshold })}
      {sl(tr('effectsPanel.radius'), e.bloom.radius, (v) => sub('bloom', { radius: v }), { def: d.bloom.radius })}
      {sl(tr('effectsPanel.warmth'), e.bloom.warmth, (v) => sub('bloom', { warmth: v }), { min: -100, track: WARM_TRACK })}

      <SubHead onReset={() => s.apply({ vignette: { ...d.vignette } })}>{tr('effectsPanel.post_crop_vignette')}</SubHead>
      <div className="mb-1 flex items-center justify-between text-xs text-ink-dim">
        <span>{tr('effectsPanel.style')}</span>
        <Select<VignetteStyle>
          label={tr('effectsPanel.vignette_style')}
          value={e.vignette.style}
          options={[['highlight', tr('effectsPanel.highlight_priority')], ['color', tr('effectsPanel.color_priority')], ['paint', tr('effectsPanel.paint_overlay')]]}
          onChange={(v) => s.apply({ vignette: { ...cur().vignette, style: v } })}
        />
      </div>
      {sl(tr('effectsPanel.amount'), e.vignette.amount, (v) => sub('vignette', { amount: v }), { min: -100 })}
      {sl(tr('effectsPanel.midpoint'), e.vignette.midpoint, (v) => sub('vignette', { midpoint: v }), { def: d.vignette.midpoint })}
      {sl(tr('effectsPanel.roundness'), e.vignette.roundness, (v) => sub('vignette', { roundness: v }), { min: -100 })}
      {sl(tr('effectsPanel.feather'), e.vignette.feather, (v) => sub('vignette', { feather: v }), { def: d.vignette.feather })}
      {sl(tr('effectsPanel.highlights'), e.vignette.highlights, (v) => sub('vignette', { highlights: v }))}
    </Section>
  );
}
