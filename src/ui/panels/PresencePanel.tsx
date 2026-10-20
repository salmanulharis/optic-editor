import { defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { Section, Toggle } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';

const SAT_TRACK = grad('#808080', 'oklch(0.7 0.16 30)', 'oklch(0.75 0.16 140)', 'oklch(0.65 0.18 260)');

export function PresencePanel() {
  const p = useEdit((s) => s.recipe.presence);
  const s = bindSection('presence');
  return (
    <Section
      title="Presence"
      enabled={p.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('presence', on)}
      onReset={() => s.apply({ ...defaultRecipe().presence })}
    >
      <Slider label="Vibrance" value={p.vibrance} min={-100} max={100} step={1} defaultValue={0} track={SAT_TRACK}
        onChange={(v) => s.set({ vibrance: v })} onCommit={s.commit} />
      <Slider label="Saturation" value={p.saturation} min={-100} max={100} step={1} defaultValue={0} track={SAT_TRACK}
        onChange={(v) => s.set({ saturation: v })} onCommit={s.commit} />
      <Toggle
        label="Protect skin tones"
        hint="Keep skin hues stable under saturation and colour-mixer changes"
        checked={p.protectSkin}
        onChange={(v) => s.apply({ protectSkin: v })}
      />
    </Section>
  );
}
