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
      title="Point Color"
      enabled={pc.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('pointColor', on)}
      onReset={() => useEdit.getState().apply((r) => ({ ...r, pointColor: { ...r.pointColor, points: [] } }))}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <ToolButton title="Pick a colour from the image" active={tool === 'pointColor'}
          onClick={() => useUi.getState().set({ tool: tool === 'pointColor' ? 'none' : 'pointColor' })}>
          + Pick
        </ToolButton>
        <ToolButton title="Pick a face: evens out skin hues (uniformity)" onClick={armSkinPick}>Skin</ToolButton>
        <span className="ml-auto text-[10px] text-ink-faint">{pc.points.length}/{MAX_COLOR_POINTS}</span>
      </div>
      {pc.points.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pc.points.map((q, i) => (
            <button key={i} title={`Point ${i + 1}`} onClick={() => setSel(i)}
              onContextMenu={(e) => { e.preventDefault(); remove(i); }}
              className={`h-6 w-6 rounded-full border-2 ${i === idx ? 'border-white' : 'border-[#444]'}`} style={{ background: swatch(q) }} />
          ))}
        </div>
      )}
      {p ? (
        <>
          {slider('hue', 'Hue shift', -100, grad(`oklch(0.7 0.13 ${h - 30})`, `oklch(0.7 0.13 ${h})`, `oklch(0.7 0.13 ${h + 30})`))}
          {slider('sat', 'Saturation', -100, grad(`oklch(0.7 0 ${h})`, `oklch(0.7 0.17 ${h})`))}
          {slider('lum', 'Luminance', -100, grad(`oklch(0.35 0.08 ${h})`, `oklch(0.9 0.06 ${h})`))}
          <div className="mt-1 border-t border-line pt-1">
            {slider('hueRange', 'Hue range', 0, undefined, 40)}
            {slider('satRange', 'Saturation range', 0, undefined, 50)}
            {slider('lumRange', 'Luminance range', 0, undefined, 60)}
            {slider('smoothness', 'Smoothness', 0, undefined, 50)}
            {slider('uniformity', 'Uniformity', 0)}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <Toggle label="Visualize range" checked={visualize} onChange={(v) => useUi.getState().set({ visualizePointColor: v })} />
          </div>
          <button className="text-[11px] text-ink-faint hover:text-[#e07070]" onClick={() => remove(idx)}>Delete point</button>
        </>
      ) : (
        <p className="text-[11px] text-ink-faint">Pick a colour in the image to adjust just that colour range.</p>
      )}
    </Section>
  );
}
