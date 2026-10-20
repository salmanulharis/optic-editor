import { useEffect } from 'react';
import { applyUpright, clearGuides, constrainIfAsked } from '../../app/geometryActions';
import { defaultRecipe, type Recipe, type UprightMode } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useUi } from '../../state/uiStore';
import { Section, SubHead, Toggle, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection } from './common';

type Geometry = Recipe['geometry'];

const MODES: Array<[UprightMode, string, string]> = [
  ['off', 'Off', 'No upright correction'],
  ['auto', 'Auto', 'Balanced level, perspective and aspect'],
  ['level', 'Level', 'Level horizontal lines'],
  ['vertical', 'Vertical', 'Level and make vertical lines parallel'],
  ['full', 'Full', 'Level, vertical and horizontal perspective'],
  ['guided', 'Guided', 'Draw 2–4 lines that should be vertical or horizontal'],
];

/**
 * Transform: upright (writes the sliders below, never a black box), guided upright lines, manual
 * perspective / rotate / aspect / scale / offset, and "Constrain crop". A grid appears over the
 * image while a slider here is dragged.
 */
export function GeometryPanel() {
  const g = useEdit((s) => s.recipe.geometry);
  const tool = useUi((s) => s.tool);
  const s = bindSection('geometry');
  const d = defaultRecipe().geometry;

  useEffect(() => {
    const up = () => useUi.getState().geometryGrid && useUi.getState().set({ geometryGrid: false });
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  // Slider edits set upright to manual adjustments, then keep the crop inside when asked.
  const commit = () => {
    useEdit.getState().update(constrainIfAsked);
    useEdit.getState().commit();
  };
  const sl = (key: keyof Pick<Geometry, 'vertical' | 'horizontal' | 'rotate' | 'aspect' | 'scale' | 'offsetX' | 'offsetY'>, label: string, min: number, max: number, step = 1, decimals = 0) => (
    <Slider label={label} value={g[key]} min={min} max={max} step={step} decimals={decimals} defaultValue={d[key]}
      onChange={(v) => s.set({ [key]: v })} onCommit={commit} />
  );
  return (
    <Section
      title="Transform"
      enabled={g.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('geometry', on)}
      onReset={() => s.apply({ ...d, enabled: g.enabled })}
      defaultOpen={false}
    >
      <SubHead>Upright</SubHead>
      <div className="mb-1 grid grid-cols-3 gap-1">
        {MODES.map(([m, label, hint]) => (
          <ToolButton key={m} title={hint} active={g.upright === m} onClick={() => applyUpright(m)}>{label}</ToolButton>
        ))}
      </div>
      {g.upright === 'guided' && (
        <div className="mb-1 flex items-center gap-1.5">
          <ToolButton title="Draw guide lines on the photo (2–4)" active={tool === 'guide'} onClick={() => useUi.getState().set({ tool: tool === 'guide' ? 'none' : 'guide' })}>
            {tool === 'guide' ? 'Drawing…' : 'Draw lines'}
          </ToolButton>
          <ToolButton title="Remove the guide lines" onClick={clearGuides}>Clear</ToolButton>
          <span className="text-[11px] text-ink-faint">{g.guides.length} / 4</span>
        </div>
      )}
      <div onPointerDownCapture={() => useUi.getState().set({ geometryGrid: true })}>
        <SubHead>Transform</SubHead>
        {sl('vertical', 'Vertical', -100, 100)}
        {sl('horizontal', 'Horizontal', -100, 100)}
        {sl('rotate', 'Rotate', -45, 45, 0.01, 2)}
        {sl('aspect', 'Aspect', -100, 100)}
        {sl('scale', 'Scale', 50, 150)}
        {sl('offsetX', 'X offset', -100, 100)}
        {sl('offsetY', 'Y offset', -100, 100)}
      </div>
      <Toggle
        label="Constrain crop"
        hint="Crop away the blank edges the transform creates"
        checked={g.constrainCrop}
        onChange={(v) => useEdit.getState().apply((r) => constrainIfAsked({ ...r, geometry: { ...r.geometry, constrainCrop: v } }))}
      />
    </Section>
  );
}
