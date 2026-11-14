import { useEffect } from 'react';
import { defaultRecipe, defaultsForSource } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { Section, SubHead } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection } from './common';
import { t as tr } from '../../i18n';

/**
 * Detail: output sharpening and noise reduction. Hold Alt (Option) while dragging Masking to see
 * the edge mask (white = sharpened). Both act at a fine scale, so the panel reminds you to zoom to
 * 100 % to judge them.
 */
export function DetailPanel() {
  const d = useEdit((s) => s.recipe.detail);
  const image = useImage((s) => s.image);
  const zoom = useUi((s) => s.zoom);
  const s = bindSection('detail');
  const raw = defaultsForSource(!!image?.isRaw).detail;

  // Mask view / hint state ends with the pointer, wherever it is released.
  useEffect(() => {
    const up = () => {
      const ui = useUi.getState();
      if (ui.maskView || ui.detailFocus) ui.set({ maskView: null, detailFocus: false });
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, []);

  const sharpen = (patch: Partial<typeof d.sharpen>) => s.set({ sharpen: { ...useEdit.getState().recipe.detail.sharpen, ...patch } });
  const nr = (patch: Partial<typeof d.nr>) => s.set({ nr: { ...useEdit.getState().recipe.detail.nr, ...patch } });
  const sl = (label: string, value: number, def: number, set: (v: number) => void, min = 0, max = 100, step = 1, decimals = 0) => (
    <Slider label={label} value={value} min={min} max={max} step={step} decimals={decimals} defaultValue={def} onChange={set} onCommit={s.commit} />
  );

  return (
    <Section
      title={tr('detailPanel.detail')}
      enabled={d.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('detail', on)}
      onReset={() => s.apply({ ...raw, enabled: d.enabled })}
    >
      <div onPointerDownCapture={() => useUi.getState().set({ detailFocus: true })}>
        {zoom !== 'fit' && zoom >= 1 ? null : <div className="mb-1 text-2xs text-ink-faint">{tr('detailPanel.zoom_to_100_to_judge_sharpening')}</div>}
        <SubHead onReset={() => s.apply({ sharpen: { ...raw.sharpen } })}>{tr('detailPanel.sharpening')}</SubHead>
        {sl(tr('detailPanel.amount'), d.sharpen.amount, raw.sharpen.amount, (v) => sharpen({ amount: v }), 0, 150)}
        {sl(tr('detailPanel.radius'), d.sharpen.radius, raw.sharpen.radius, (v) => sharpen({ radius: v }), 0.5, 3, 0.1, 1)}
        {sl(tr('detailPanel.detail'), d.sharpen.detail, raw.sharpen.detail, (v) => sharpen({ detail: v }))}
        <div
          title={tr('detailPanel.hold_alt_option_while_dragging_to')}
          onPointerDownCapture={(e) => { if (e.altKey) useUi.getState().set({ maskView: 'sharpen' }); }}
        >
          {sl(tr('detailPanel.masking'), d.sharpen.masking, 0, (v) => sharpen({ masking: v }))}
        </div>
        <SubHead onReset={() => s.apply({ nr: { ...raw.nr } })}>{tr('detailPanel.noise_reduction')}</SubHead>
        {sl(tr('detailPanel.luminance'), d.nr.lum, raw.nr.lum, (v) => nr({ lum: v }))}
        {sl(tr('detailPanel.detail'), d.nr.lumDetail, defaultRecipe().detail.nr.lumDetail, (v) => nr({ lumDetail: v }))}
        {sl(tr('detailPanel.contrast'), d.nr.lumContrast, 0, (v) => nr({ lumContrast: v }))}
        {sl(tr('detailPanel.color'), d.nr.color, raw.nr.color, (v) => nr({ color: v }))}
        {sl(tr('detailPanel.color_detail'), d.nr.colorDetail, defaultRecipe().detail.nr.colorDetail, (v) => nr({ colorDetail: v }))}
        {sl(tr('detailPanel.smoothness'), d.nr.colorSmooth, defaultRecipe().detail.nr.colorSmooth, (v) => nr({ colorSmooth: v }))}
      </div>
    </Section>
  );
}
