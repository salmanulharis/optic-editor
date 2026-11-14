import { t as tr } from '../../i18n';
import { useState } from 'react';
import { armSkinPick } from '../../app/presetActions';
import { MAX_COLOR_POINTS, type ColorPoint } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useUi } from '../../state/uiStore';
import { Section, Toggle, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { grad } from './common';

const swatch = (p: ColorPoint) => `oklch(${Math.min(1, p.target.L)} ${p.target.C} ${p.target.h})`;

export function PointColorPanel() {
  const pc = useEdit((s) => s.recipe.pointColor);
  const tool = useUi((s) => s.tool);
  const visualize = useUi((s) => s.visualizePointColor);
  const [sel, setSel] = useState(0);
  const idx = Math.min(sel, pc.points.length - 1);
  const p = pc.points[idx];

  const setPoint = (patch: Partial<ColorPoint>) =>
    useEdit.getState().update((r) => ({
      ...r,
      pointColor: { ...r.pointColor, points: r.pointColor.points.map((q, i) => (i === idx ? { ...q, ...patch } : q)) },
    }));
  const commit = () => useEdit.getState().commit();
  const remove = (i: number) =>
    useEdit.getState().apply((r) => ({ ...r, pointColor: { ...r.pointColor, points: r.pointColor.points.filter((_, j) => j !== i) } }));
  const h = p?.target.h ?? 0;
  const slider = (key: keyof Omit<ColorPoint, 'target'>, label: string, min: number, track?: string, def = 0) => (
    <Slider key={key} label={label} value={p[key]} min={min} max={100} step={1} defaultValue={def} track={track}
      onChange={(v) => setPoint({ [key]: v })} onCommit={commit} />
  );

  return (
    <Section
      title={tr('pointColorPanel.point_color')}
      enabled={pc.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('pointColor', on)}
      onReset={() => useEdit.getState().apply((r) => ({ ...r, pointColor: { ...r.pointColor, points: [] } }))}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <ToolButton title={tr('pointColorPanel.pick_a_colour_from_the_image')} active={tool === 'pointColor'}
          onClick={() => useUi.getState().set({ tool: tool === 'pointColor' ? 'none' : 'pointColor' })}>{tr('pointColorPanel.pick')}</ToolButton>
        <ToolButton title={tr('pointColorPanel.pick_a_face_evens_out_skin')} onClick={armSkinPick}>{tr('pointColorPanel.skin')}</ToolButton>
        <span className="ms-auto text-2xs text-ink-faint">{pc.points.length}/{MAX_COLOR_POINTS}</span>
      </div>
      {pc.points.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pc.points.map((q, i) => (
            <button key={i} title={tr('pointColorPanel.point_i', { i: i + 1 })} onClick={() => setSel(i)}
              onContextMenu={(e) => { e.preventDefault(); remove(i); }}
              className={`h-6 w-6 rounded-full border-2 ${i === idx ? 'border-white' : 'border-edge'}`} style={{ background: swatch(q) }} />
          ))}
        </div>
      )}
      {p ? (
        <>
          {slider('hue', tr('pointColorPanel.hue_shift'), -100, grad(`oklch(0.7 0.13 ${h - 30})`, `oklch(0.7 0.13 ${h})`, `oklch(0.7 0.13 ${h + 30})`))}
          {slider('sat', tr('pointColorPanel.saturation'), -100, grad(`oklch(0.7 0 ${h})`, `oklch(0.7 0.17 ${h})`))}
          {slider('lum', tr('pointColorPanel.luminance'), -100, grad(`oklch(0.35 0.08 ${h})`, `oklch(0.9 0.06 ${h})`))}
          <div className="mt-1 border-t border-line pt-1">
            {slider('hueRange', tr('pointColorPanel.hue_range'), 0, undefined, 40)}
            {slider('satRange', tr('pointColorPanel.saturation_range'), 0, undefined, 50)}
            {slider('lumRange', tr('pointColorPanel.luminance_range'), 0, undefined, 60)}
            {slider('smoothness', tr('pointColorPanel.smoothness'), 0, undefined, 50)}
            {slider('uniformity', tr('pointColorPanel.uniformity'), 0)}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <Toggle label={tr('pointColorPanel.visualize_range')} checked={visualize} onChange={(v) => useUi.getState().set({ visualizePointColor: v })} />
          </div>
          <button className="text-2xs text-ink-faint hover:text-danger" onClick={() => remove(idx)}>{tr('pointColorPanel.delete_point')}</button>
        </>
      ) : (
        <p className="text-xs text-ink-faint">{tr('pointColorPanel.pick_a_colour_in_the_image')}</p>
      )}
    </Section>
  );
}
