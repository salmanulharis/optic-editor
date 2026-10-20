import { autoTone } from '../../app/actions';
import { defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { Section, Toggle, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection } from './common';

export function LightPanel() {
  const l = useEdit((s) => s.recipe.light);
  const image = useImage((s) => s.image);
  const tool = useUi((s) => s.tool);
  const s = bindSection('light');
  const lowBit = !!image && !image.isRaw && image.bitDepth <= 8;
  const debandOn = l.deband === 'on' || (l.deband === 'auto' && lowBit);
  const tone = (key: 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks', label: string) => (
    <Slider label={label} value={l[key]} min={-100} max={100} step={1} defaultValue={0}
      onChange={(v) => s.set({ [key]: v })} onCommit={s.commit} />
  );
  const dropper = (t: 'blackPoint' | 'whitePoint', label: string) => (
    <ToolButton title={`${label} dropper`} active={tool === t} onClick={() => useUi.getState().set({ tool: tool === t ? 'none' : t })}>
      {label}
    </ToolButton>
  );

  return (
    <Section
      title="Light"
      enabled={l.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('light', on)}
      onReset={() => s.apply({ ...defaultRecipe().light, deband: l.deband, deblock: l.deblock })}
    >
      <div className="mb-2 flex gap-1.5">
        <ToolButton title="Auto tone (exposure, contrast, whites, blacks)" onClick={autoTone}>Auto</ToolButton>
        {dropper('blackPoint', 'Black pt')}
        {dropper('whitePoint', 'White pt')}
      </div>
      <Slider label="Exposure" value={l.exposure} min={-5} max={5} step={0.05} decimals={2} defaultValue={0}
        onChange={(v) => s.set({ exposure: v })} onCommit={s.commit} />
      {tone('contrast', 'Contrast')}
      {tone('highlights', 'Highlights')}
      {tone('shadows', 'Shadows')}
      {tone('whites', 'Whites')}
      {tone('blacks', 'Blacks')}
      {image && !image.isRaw && (
        <div className="mt-2 border-t border-line pt-1">
          <Toggle
            label={`Debanding${l.deband === 'auto' ? ' (auto)' : ''}`}
            hint="Edge-aware smoothing of 8-bit gradients before strong edits"
            checked={debandOn}
            onChange={(v) => s.apply({ deband: v === lowBit ? 'auto' : v ? 'on' : 'off' })}
          />
          <Toggle
            label="JPEG artifact reduction"
            hint="Mild deblocking for heavily compressed images"
            checked={l.deblock}
            onChange={(v) => s.apply({ deblock: v })}
          />
        </div>
      )}
    </Section>
  );
}
