import { t as tr } from '../../i18n';
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
    <ToolButton title={tr('lightPanel.label_dropper', { label: label })} active={tool === t} onClick={() => useUi.getState().set({ tool: tool === t ? 'none' : t })}>
      {label}
    </ToolButton>
  );

  return (
    <Section
      title={tr('lightPanel.light')}
      enabled={l.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('light', on)}
      onReset={() => s.apply({ ...defaultRecipe().light, deband: l.deband, deblock: l.deblock })}
    >
      <div className="mb-2 flex gap-1.5">
        <ToolButton title={tr('lightPanel.auto_tone_exposure_contrast_whites_blacks')} onClick={autoTone}>{tr('lightPanel.auto')}</ToolButton>
        {dropper('blackPoint', tr('lightPanel.black_pt'))}
        {dropper('whitePoint', tr('lightPanel.white_pt'))}
      </div>
      <Slider label={tr('lightPanel.exposure')} value={l.exposure} min={-5} max={5} step={0.05} decimals={2} defaultValue={0}
        onChange={(v) => s.set({ exposure: v })} onCommit={s.commit} />
      {tone('contrast', tr('lightPanel.contrast'))}
      {tone('highlights', tr('lightPanel.highlights'))}
      {tone('shadows', tr('lightPanel.shadows'))}
      {tone('whites', tr('lightPanel.whites'))}
      {tone('blacks', tr('lightPanel.blacks'))}
      {image && !image.isRaw && (
        <div className="mt-2 border-t border-line pt-1">
          <Toggle
            label={l.deband === 'auto' ? tr('lightPanel.debanding_auto') : tr('lightPanel.debanding')}
            hint={tr('lightPanel.edge_aware_smoothing_of_8_bit')}
            checked={debandOn}
            onChange={(v) => s.apply({ deband: v === lowBit ? 'auto' : v ? 'on' : 'off' })}
          />
          <Toggle
            label={tr('lightPanel.jpeg_artifact_reduction')}
            hint={tr('lightPanel.mild_deblocking_for_heavily_compressed_images')}
            checked={l.deblock}
            onChange={(v) => s.apply({ deblock: v })}
          />
        </div>
      )}
    </Section>
  );
}
