import { useState } from 'react';
import { normalizeRows } from '../../color/calibration';
import { IDENTITY_MATRIX, defaultRecipe, type PrimaryAdjust, type Recipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { NumberInput } from '../controls/NumberInput';
import { Section } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';
import { t as tr } from '../../i18n';

// Hue tracks: the primary rotated −30°…+30° (OKLCH hues of Rec.2020 R / G / B ≈ 29°, 145°, 265°).
const PRIMARIES: Array<['red' | 'green' | 'blue', string, number]> = [['red', 'Red', 29], ['green', 'Green', 145], ['blue', 'Blue', 265]];

export function CalibrationPanel() {
  const c = useEdit((s) => s.recipe.calibration);
  const s = bindSection('calibration');
  const [advanced, setAdvanced] = useState(false);
  const setPrimary = (k: 'red' | 'green' | 'blue', p: PrimaryAdjust) => s.set({ [k]: p } as Partial<Recipe['calibration']>);
  const m = c.matrix ?? IDENTITY_MATRIX;

  return (
    <Section
      title={tr('calibrationPanel.calibration')}
      enabled={c.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('calibration', on)}
      onReset={() => s.apply({ ...defaultRecipe().calibration, enabled: c.enabled })}
    >
      <Slider label={tr('calibrationPanel.shadows_tint')} value={c.shadowTint} min={-100} max={100} step={1} defaultValue={0}
        track={grad('#3fae4a', '#8a8a8a', '#c84fc0')}
        onChange={(v) => s.set({ shadowTint: v })} onCommit={s.commit} />
      {PRIMARIES.map(([k, label, h]) => (
        <div key={k} className="mt-2">
          <div className="mb-0.5 text-2xs font-medium text-ink-dim">{tr('calibrationPanel.label_primary', { label: label })}</div>
          <Slider label={tr('calibrationPanel.hue')} value={c[k].hue} min={-100} max={100} step={1} defaultValue={0}
            track={grad(`oklch(0.65 0.17 ${h - 30})`, `oklch(0.65 0.17 ${h})`, `oklch(0.65 0.17 ${h + 30})`)}
            onChange={(v) => setPrimary(k, { ...c[k], hue: v })} onCommit={s.commit} />
          <Slider label={tr('calibrationPanel.saturation')} value={c[k].sat} min={-100} max={100} step={1} defaultValue={0}
            track={grad(`oklch(0.65 0.03 ${h})`, `oklch(0.65 0.2 ${h})`)}
            onChange={(v) => setPrimary(k, { ...c[k], sat: v })} onCommit={s.commit} />
        </div>
      ))}
      <button className="mt-3 text-2xs text-ink-faint hover:text-ink" onClick={() => setAdvanced(!advanced)}>
        {advanced ? '▾' : '▸'} {tr('calibrationPanel.advanced_color_matrix')}</button>
      {advanced && (
        <div className="mt-1">
          <p className="mb-1 text-xs text-ink-faint">{tr('calibrationPanel.output_rgb_m_input_rgb_working')}</p>
          <div className="grid grid-cols-3 gap-1">
            {m.map((v, i) => (
              <div key={i} className="rounded border border-line bg-raise px-1">
                <NumberInput value={v} min={-4} max={4} decimals={3} ariaLabel={tr('calibrationPanel.matrix_cell', { row: Math.floor(i / 3) + 1, col: (i % 3) + 1 })}
                  className="w-full"
                  onCommit={(x) => {
                    const next = m.slice();
                    next[i] = x;
                    s.apply({ matrix: normalizeRows(next) as number[] });
                  }} />
              </div>
            ))}
          </div>
          <button className="mt-1 text-2xs text-ink-faint hover:text-ink" onClick={() => s.apply({ matrix: null })}>{tr('calibrationPanel.reset_matrix')}</button>
        </div>
      )}
    </Section>
  );
}
