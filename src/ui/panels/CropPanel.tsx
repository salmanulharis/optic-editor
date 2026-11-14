import { useState } from 'react';
import { cropSizeLabel, flip, resetCrop, rotate90, setCropAspect, setStraighten, swapCropAspect } from '../../app/geometryActions';
import { useEdit } from '../../state/editStore';
import { type CropGuide, CROP_GUIDES, useUi } from '../../state/uiStore';
import { Section, Select, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { t as tr } from '../../i18n';

export const ASPECTS: Array<[string, string]> = [
  ['original', tr('cropPanel.original')],
  ['free', tr('cropPanel.freeform')],
  ['1:1', '1 : 1'],
  ['4:5', '4 : 5'],
  ['5:4', '5 : 4'],
  ['3:2', '3 : 2'],
  ['2:3', '2 : 3'],
  ['4:3', '4 : 3'],
  ['16:9', '16 : 9'],
  ['9:16', '9 : 16'],
  ['6:7', '6 : 7 (medium format)'],
  ['65:24', '65 : 24 (XPan)'],
  ['2.39:1', '2.39 : 1 (cinema)'],
];

const GUIDE_LABEL: Record<CropGuide, string> = { get thirds() { return tr('cropPanel.thirds'); }, get golden() { return tr('cropPanel.golden_ratio'); }, get spiral() { return tr('cropPanel.golden_spiral'); }, get diagonals() { return tr('cropPanel.diagonals'); }, get grid() { return tr('cropPanel.grid'); }, get triangles() { return tr('cropPanel.triangles'); } };

/** Crop & straighten controls, shown while the crop tool (R) is open. */
export function CropPanel() {
  const c = useEdit((s) => s.recipe.crop);
  const recipe = useEdit((s) => s.recipe);
  const tool = useUi((s) => s.tool);
  const guide = useUi((s) => s.cropGuide);
  const [custom, setCustom] = useState<[number, number]>([3, 2]);
  const known = ASPECTS.some(([k]) => k === c.aspect);
  return (
    <Section title={tr('cropPanel.crop_straighten')}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-dim">
        <span className="w-12">{tr('cropPanel.aspect')}</span>
        <Select
          label={tr('cropPanel.aspect_ratio')}
          value={known ? c.aspect : 'custom'}
          options={[...ASPECTS, ['custom', c.aspect.startsWith('custom:') ? `Custom ${c.aspect.slice(7).replace(':', ' : ')}` : 'Custom…']]}
          onChange={(v) => (v === 'custom' ? setCropAspect(`custom:${custom[0]}:${custom[1]}`) : setCropAspect(v))}
        />
        <ToolButton title={tr('cropPanel.swap_orientation_x')} onClick={swapCropAspect}>⇄</ToolButton>
      </div>
      {!known && (
        <div className="mb-1.5 flex items-center gap-1 text-xs text-ink-dim">
          <span className="w-12">{tr('cropPanel.custom')}</span>
          <input className="input w-12" type="number" min={1} value={custom[0]} onChange={(e) => setCustom([+e.target.value || 1, custom[1]])} />
          :
          <input className="input w-12" type="number" min={1} value={custom[1]} onChange={(e) => setCustom([custom[0], +e.target.value || 1])} />
          <ToolButton title={tr('cropPanel.apply')} onClick={() => setCropAspect(`custom:${custom[0]}:${custom[1]}`)}>{tr('cropPanel.set')}</ToolButton>
        </div>
      )}
      <Slider label={tr('cropPanel.angle')} value={c.angle} min={-45} max={45} step={0.01} decimals={2} defaultValue={0}
        onChange={(v) => setStraighten(v)} onCommit={() => setStraighten(useEdit.getState().recipe.crop.angle, true)} />
      <div className="mt-1.5 flex flex-wrap gap-1">
        <ToolButton title={tr('cropPanel.draw_along_a_line_that_should')} active={tool === 'straighten'}
          onClick={() => useUi.getState().set({ tool: tool === 'straighten' ? 'none' : 'straighten' })}>{tr('cropPanel.straighten')}</ToolButton>
        <ToolButton title={tr('cropPanel.rotate_left')} onClick={() => rotate90(-1)}>⟲ 90°</ToolButton>
        <ToolButton title={tr('cropPanel.rotate_right')} onClick={() => rotate90(1)}>⟳ 90°</ToolButton>
        <ToolButton title={tr('cropPanel.flip_horizontal')} active={c.flipH} onClick={() => flip('h')}>{tr('cropPanel.flip_h')}</ToolButton>
        <ToolButton title={tr('cropPanel.flip_vertical')} active={c.flipV} onClick={() => flip('v')}>{tr('cropPanel.flip_v')}</ToolButton>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-dim">
        <span className="w-12">{tr('cropPanel.guides')}</span>
        <Select<CropGuide> value={guide} options={CROP_GUIDES.map((g) => [g, GUIDE_LABEL[g]])} onChange={(v) => useUi.getState().set({ cropGuide: v })} title={tr('cropPanel.cycle_with_o')} />
      </div>
      <div className="mt-2 text-2xs tabular-nums text-ink">{cropSizeLabel(recipe)}</div>
      <div className="mt-2 flex justify-between">
        <button className="text-2xs text-ink-faint hover:text-ink" onClick={resetCrop}>{tr('cropPanel.reset_crop')}</button>
        <button className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hi" onClick={() => useUi.getState().set({ cropMode: false, tool: 'none' })}>{tr('cropPanel.done')}</button>
      </div>
    </Section>
  );
}
