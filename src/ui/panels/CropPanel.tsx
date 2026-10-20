import { useState } from 'react';
import { cropSizeLabel, flip, resetCrop, rotate90, setCropAspect, setStraighten, swapCropAspect } from '../../app/geometryActions';
import { useEdit } from '../../state/editStore';
import { type CropGuide, CROP_GUIDES, useUi } from '../../state/uiStore';
import { Section, Select, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';

export const ASPECTS: Array<[string, string]> = [
  ['original', 'Original'],
  ['free', 'Freeform'],
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

const GUIDE_LABEL: Record<CropGuide, string> = { thirds: 'Thirds', golden: 'Golden ratio', spiral: 'Golden spiral', diagonals: 'Diagonals', grid: 'Grid', triangles: 'Triangles' };

/** Crop & straighten controls, shown while the crop tool (R) is open. */
export function CropPanel() {
  const c = useEdit((s) => s.recipe.crop);
  const recipe = useEdit((s) => s.recipe);
  const tool = useUi((s) => s.tool);
  const guide = useUi((s) => s.cropGuide);
  const [custom, setCustom] = useState<[number, number]>([3, 2]);
  const known = ASPECTS.some(([k]) => k === c.aspect);
  return (
    <Section title="Crop & Straighten">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-dim">
        <span className="w-12">Aspect</span>
        <Select
          value={known ? c.aspect : 'custom'}
          options={[...ASPECTS, ['custom', c.aspect.startsWith('custom:') ? `Custom ${c.aspect.slice(7).replace(':', ' : ')}` : 'Custom…']]}
          onChange={(v) => (v === 'custom' ? setCropAspect(`custom:${custom[0]}:${custom[1]}`) : setCropAspect(v))}
        />
        <ToolButton title="Swap orientation (X)" onClick={swapCropAspect}>⇄</ToolButton>
      </div>
      {!known && (
        <div className="mb-1.5 flex items-center gap-1 text-xs text-ink-dim">
          <span className="w-12">Custom</span>
          <input className="input w-12" type="number" min={1} value={custom[0]} onChange={(e) => setCustom([+e.target.value || 1, custom[1]])} />
          :
          <input className="input w-12" type="number" min={1} value={custom[1]} onChange={(e) => setCustom([custom[0], +e.target.value || 1])} />
          <ToolButton title="Apply" onClick={() => setCropAspect(`custom:${custom[0]}:${custom[1]}`)}>Set</ToolButton>
        </div>
      )}
      <Slider label="Angle" value={c.angle} min={-45} max={45} step={0.01} decimals={2} defaultValue={0}
        onChange={(v) => setStraighten(v)} onCommit={() => setStraighten(useEdit.getState().recipe.crop.angle, true)} />
      <div className="mt-1.5 flex flex-wrap gap-1">
        <ToolButton title="Draw along a line that should be level" active={tool === 'straighten'}
          onClick={() => useUi.getState().set({ tool: tool === 'straighten' ? 'none' : 'straighten' })}>Straighten</ToolButton>
        <ToolButton title="Rotate left" onClick={() => rotate90(-1)}>⟲ 90°</ToolButton>
        <ToolButton title="Rotate right" onClick={() => rotate90(1)}>⟳ 90°</ToolButton>
        <ToolButton title="Flip horizontal" active={c.flipH} onClick={() => flip('h')}>Flip H</ToolButton>
        <ToolButton title="Flip vertical" active={c.flipV} onClick={() => flip('v')}>Flip V</ToolButton>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-dim">
        <span className="w-12">Guides</span>
        <Select<CropGuide> value={guide} options={CROP_GUIDES.map((g) => [g, GUIDE_LABEL[g]])} onChange={(v) => useUi.getState().set({ cropGuide: v })} title="Cycle with O" />
      </div>
      <div className="mt-2 text-[11px] tabular-nums text-ink">{cropSizeLabel(recipe)}</div>
      <div className="mt-2 flex justify-between">
        <button className="text-[11px] text-ink-faint hover:text-ink" onClick={resetCrop}>Reset crop</button>
        <button className="rounded bg-[#e0e0e0] px-3 py-1 text-xs font-medium text-black hover:bg-white" onClick={() => useUi.getState().set({ cropMode: false, tool: 'none' })}>
          Done
        </button>
      </div>
    </Section>
  );
}
