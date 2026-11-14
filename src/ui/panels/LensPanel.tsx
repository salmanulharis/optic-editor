import { defaultRecipe, type Recipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { Section, SubHead, Toggle } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';
import { t as tr } from '../../i18n';

type Lens = Recipe['lens'];

const PURPLE_TRACK = grad('oklch(0.6 0.15 250)', 'oklch(0.6 0.18 300)', 'oklch(0.6 0.18 350)');
const GREEN_TRACK = grad('oklch(0.75 0.15 95)', 'oklch(0.7 0.16 135)', 'oklch(0.7 0.12 175)');

/** Lens corrections: the file's own profile (DNG opcodes / lensfun), manual distortion, vignetting, CA, defringe. */
export function LensPanel() {
  const l = useEdit((s) => s.recipe.lens);
  const image = useImage((s) => s.image);
  useUi((s) => s.analysisTick); // profile and CA estimate arrive in the background
  const s = bindSection('lens');
  const d = defaultRecipe().lens;
  const cur = () => useEdit.getState().recipe.lens;
  const sub = <K extends 'vignetting' | 'ca' | 'defringe'>(k: K, patch: Partial<Lens[K]>) => s.set({ [k]: { ...cur()[k], ...patch } } as Partial<Lens>);
  const profile = image?.model.lens;
  const ca = image?.model.analysis.ca;
  const sl = (label: string, value: number, set: (v: number) => void, opts: { min?: number; max?: number; def?: number; track?: string } = {}) => (
    <Slider label={label} value={value} min={opts.min ?? 0} max={opts.max ?? 100} step={1} defaultValue={opts.def ?? 0} track={opts.track} onChange={set} onCommit={s.commit} />
  );
  return (
    <Section
      title={tr('lensPanel.lens_corrections')}
      enabled={l.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('lens', on)}
      onReset={() => s.apply({ ...d, auto: !!image?.isRaw, enabled: l.enabled })}
      defaultOpen={false}
    >
      <Toggle
        label={tr('lensPanel.auto_from_file')}
        hint={tr('lensPanel.the_lens_corrections_embedded_in_the')}
        checked={l.auto}
        onChange={(v) => s.apply({ auto: v })}
      />
      <div className="mb-1 truncate text-2xs text-ink-faint" title={profile?.name}>
        {profile ? profile.name : image?.isRaw ? tr('lensPanel.no_profile_in_the_file_or') : tr('lensPanel.jpeg_heic_are_corrected_in_camera')}
      </div>
      {sl(tr('lensPanel.distortion'), l.distortion, (v) => s.set({ distortion: v }), { min: -100 })}
      <SubHead onReset={() => s.apply({ vignetting: { ...d.vignetting } })}>{tr('lensPanel.vignetting')}</SubHead>
      {sl(tr('lensPanel.amount'), l.vignetting.amount, (v) => sub('vignetting', { amount: v }), { min: -100 })}
      {sl(tr('lensPanel.midpoint'), l.vignetting.midpoint, (v) => sub('vignetting', { midpoint: v }), { def: d.vignetting.midpoint })}
      <SubHead onReset={() => s.apply({ ca: { ...d.ca } })}>{tr('lensPanel.chromatic_aberration')}</SubHead>
      <Toggle
        label={l.ca.auto && ca === null ? tr('lensPanel.auto_measuring') : tr('lensPanel.auto_ca')}
        hint={tr('lensPanel.measures_lateral_ca_on_the_photo')}
        checked={l.ca.auto}
        onChange={(v) => s.apply({ ca: { ...cur().ca, auto: v } })}
      />
      {sl(tr('lensPanel.red_cyan'), l.ca.redCyan, (v) => sub('ca', { redCyan: v }), { min: -100, track: grad('#2fc0c0', '#9a9a9a', '#d04040') })}
      {sl(tr('lensPanel.blue_yellow'), l.ca.blueYellow, (v) => sub('ca', { blueYellow: v }), { min: -100, track: grad('#d0c040', '#9a9a9a', '#4060d0') })}
      <SubHead onReset={() => s.apply({ defringe: { ...d.defringe } })}>{tr('lensPanel.defringe')}</SubHead>
      {sl(tr('lensPanel.purple_amount'), l.defringe.purpleAmount, (v) => sub('defringe', { purpleAmount: v }))}
      {sl(tr('lensPanel.purple_hue_from'), l.defringe.purpleHue[0], (v) => sub('defringe', { purpleHue: [Math.min(v, cur().defringe.purpleHue[1] - 5), cur().defringe.purpleHue[1]] }), { def: d.defringe.purpleHue[0], track: PURPLE_TRACK })}
      {sl(tr('lensPanel.purple_hue_to'), l.defringe.purpleHue[1], (v) => sub('defringe', { purpleHue: [cur().defringe.purpleHue[0], Math.max(v, cur().defringe.purpleHue[0] + 5)] }), { def: d.defringe.purpleHue[1], track: PURPLE_TRACK })}
      {sl(tr('lensPanel.green_amount'), l.defringe.greenAmount, (v) => sub('defringe', { greenAmount: v }))}
      {sl(tr('lensPanel.green_hue_from'), l.defringe.greenHue[0], (v) => sub('defringe', { greenHue: [Math.min(v, cur().defringe.greenHue[1] - 5), cur().defringe.greenHue[1]] }), { def: d.defringe.greenHue[0], track: GREEN_TRACK })}
      {sl(tr('lensPanel.green_hue_to'), l.defringe.greenHue[1], (v) => sub('defringe', { greenHue: [cur().defringe.greenHue[0], Math.max(v, cur().defringe.greenHue[0] + 5)] }), { def: d.defringe.greenHue[1], track: GREEN_TRACK })}
    </Section>
  );
}
