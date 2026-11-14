import { t as tr } from '../../i18n';
import { defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { Section } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';

export function LookPanel() {
  const k = useEdit((s) => s.recipe.look);
  const s = bindSection('look');
  const slider = (key: 'highlightRolloff' | 'shadowDensity' | 'microContrast' | 'colorDensity', label: string) => (
    <Slider label={label} value={k[key]} min={0} max={100} step={1} defaultValue={0}
      onChange={(v) => s.set({ [key]: v })} onCommit={s.commit} />
  );
  return (
    <Section
      title={tr('lookPanel.look')}
      enabled={k.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('look', on)}
      onReset={() => s.apply({ ...defaultRecipe().look, enabled: k.enabled })}
    >
      {slider('highlightRolloff', tr('lookPanel.highlight_roll_off'))}
      {slider('shadowDensity', tr('lookPanel.shadow_density'))}
      {slider('microContrast', tr('lookPanel.micro_contrast'))}
      {slider('colorDensity', tr('lookPanel.color_density'))}
      <Slider label={tr('lookPanel.warmth_bias')} value={k.warmthBias} min={-100} max={100} step={1} defaultValue={0}
        track={grad('#6c8fd0', '#9a9a9a', '#d6b25a')}
        onChange={(v) => s.set({ warmthBias: v })} onCommit={s.commit} />
    </Section>
  );
}
