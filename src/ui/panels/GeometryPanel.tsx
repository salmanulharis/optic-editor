import { useEffect } from 'react';
import { applyUpright, clearGuides, constrainIfAsked } from '../../app/geometryActions';
import { defaultRecipe, type Recipe, type UprightMode } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useUi } from '../../state/uiStore';
import { Section, SubHead, Toggle, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection } from './common';
import { t as tr } from '../../i18n';

type Geometry = Recipe['geometry'];

/** Upright modes: [mode, label, help]; translated when shown. */
const MODE_IDS: UprightMode[] = ['off', 'auto', 'level', 'vertical', 'full', 'guided'];
const modes = (): Array<[UprightMode, string, string]> => MODE_IDS.map((m) => [m, tr(`geometryPanel.upright.${m}`), tr(`geometryPanel.upright.${m}.help`)]);

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
      title={tr('geometryPanel.transform')}
      enabled={g.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('geometry', on)}
      onReset={() => s.apply({ ...d, enabled: g.enabled })}
      defaultOpen={false}
    >
      <SubHead>{tr('geometryPanel.upright')}</SubHead>
      <div className="mb-1 grid grid-cols-3 gap-1">
        {modes().map(([m, label, hint]) => (
          <ToolButton key={m} title={hint} active={g.upright === m} onClick={() => applyUpright(m)}>{label}</ToolButton>
        ))}
      </div>
      {g.upright === 'guided' && (
        <div className="mb-1 flex items-center gap-1.5">
          <ToolButton title={tr('geometryPanel.draw_guide_lines_on_the_photo')} active={tool === 'guide'} onClick={() => useUi.getState().set({ tool: tool === 'guide' ? 'none' : 'guide' })}>
            {tool === 'guide' ? tr('geometryPanel.drawing') : tr('geometryPanel.draw_lines')}
          </ToolButton>
          <ToolButton title={tr('geometryPanel.remove_the_guide_lines')} onClick={clearGuides}>{tr('geometryPanel.clear')}</ToolButton>
          <span className="text-2xs text-ink-faint">{g.guides.length} / 4</span>
        </div>
      )}
      <div onPointerDownCapture={() => useUi.getState().set({ geometryGrid: true })}>
        <SubHead>{tr('geometryPanel.transform')}</SubHead>
        {sl('vertical', tr('geometryPanel.vertical'), -100, 100)}
        {sl('horizontal', tr('geometryPanel.horizontal'), -100, 100)}
        {sl('rotate', tr('geometryPanel.rotate'), -45, 45, 0.01, 2)}
        {sl('aspect', tr('geometryPanel.aspect'), -100, 100)}
        {sl('scale', tr('geometryPanel.scale'), 50, 150)}
        {sl('offsetX', tr('geometryPanel.x_offset'), -100, 100)}
        {sl('offsetY', tr('geometryPanel.y_offset'), -100, 100)}
      </div>
      <Toggle
        label={tr('geometryPanel.constrain_crop')}
        hint={tr('geometryPanel.crop_away_the_blank_edges_the')}
        checked={g.constrainCrop}
        onChange={(v) => useEdit.getState().apply((r) => constrainIfAsked({ ...r, geometry: { ...r.geometry, constrainCrop: v } }))}
      />
    </Section>
  );
}
