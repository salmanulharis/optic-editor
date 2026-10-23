import { autoWhiteBalance, estimateColorCast } from '../../app/actions';
import { WB_PRESETS } from '../../color/whiteBalance';
import { type WbMode, defaultRecipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { Section, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';

const TEMP_TRACK = grad('#3f6fd8', '#9fb4d8', '#d8cfa0', '#e0b640');
const TINT_TRACK = grad('#3fae4a', '#b8c8b0', '#c8b0c4', '#c84fc0');

// Kelvin slider is linear in mired (perceptually even); left = blue/low K like Lightroom.
const M_MIN = 1e6 / 2000, M_MAX = 1e6 / 50000;
const kToPos = (k: number) => (M_MIN - 1e6 / k) / (M_MIN - M_MAX);
const posToK = (p: number) => 1e6 / (M_MIN - p * (M_MIN - M_MAX));

export function WhiteBalancePanel() {
  const image = useImage((s) => s.image);
  const wb = useEdit((s) => s.recipe.whiteBalance);
  const tool = useUi((s) => s.tool);
  const s = bindSection('whiteBalance');
  const isRaw = !!image?.isRaw;
  const asShot = image?.asShot ?? { temperature: 0, tint: 0 };

  const setMode = (mode: WbMode) => {
    if (mode === 'auto') return autoWhiteBalance();
    if (mode === 'asShot') return s.apply({ mode, ...asShot });
    const p = WB_PRESETS[mode];
    if (p) return s.apply({ mode, temperature: p.temperature, tint: p.tint });
    s.apply({ mode });
  };

  const onCast = (v: number) => {
    if (v > 0 && !useEdit.getState().recipe.whiteBalance.castEstimate) {
      const est = estimateColorCast();
      s.set({ castStrength: v, castEstimate: est });
    } else s.set({ castStrength: v });
  };

  return (
    <Section
      title="White Balance"
      enabled={wb.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('whiteBalance', on)}
      onReset={() => s.apply({ ...defaultRecipe().whiteBalance, ...asShot })}
    >
      <div className="mb-2 flex items-center gap-2">
        <select
          aria-label="White balance mode"
          className="flex-1 rounded border border-line bg-raise px-1.5 py-1 text-xs text-ink outline-none"
          value={wb.mode}
          onChange={(e) => setMode(e.target.value as WbMode)}
        >
          <option value="asShot">As Shot</option>
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
          {isRaw && Object.entries(WB_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
        <ToolButton
          title="White balance eyedropper (W)"
          active={tool === 'wb'}
          onClick={() => useUi.getState().set({ tool: tool === 'wb' ? 'none' : 'wb' })}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M14 4l6 6-2 2-6-6zM12 6l-8 8v4h4l8-8" />
          </svg>
        </ToolButton>
        <ToolButton title="Auto white balance" onClick={autoWhiteBalance}>Auto</ToolButton>
      </div>
      {isRaw ? (
        <>
          <Slider
            label="Temp"
            value={wb.temperature}
            min={2000}
            max={50000}
            step={50}
            defaultValue={asShot.temperature}
            track={TEMP_TRACK}
            toPos={kToPos}
            fromPos={(p) => Math.round(posToK(p) / 10) * 10}
            onChange={(v) => s.set({ temperature: v, mode: 'custom' })}
            onCommit={s.commit}
          />
          <Slider
            label="Tint"
            value={wb.tint}
            min={-150}
            max={150}
            step={1}
            defaultValue={asShot.tint}
            track={TINT_TRACK}
            onChange={(v) => s.set({ tint: v, mode: 'custom' })}
            onCommit={s.commit}
          />
        </>
      ) : (
        <>
          <Slider label="Temp" value={wb.temperature} min={-100} max={100} step={1} defaultValue={0} track={TEMP_TRACK}
            onChange={(v) => s.set({ temperature: v, mode: 'custom' })} onCommit={s.commit} />
          <Slider label="Tint" value={wb.tint} min={-100} max={100} step={1} defaultValue={0} track={TINT_TRACK}
            onChange={(v) => s.set({ tint: v, mode: 'custom' })} onCommit={s.commit} />
        </>
      )}
      <div className="mt-2 border-t border-line pt-2">
        <Slider label="Remove color cast" value={wb.castStrength} min={0} max={100} step={1} defaultValue={0}
          onChange={onCast} onCommit={s.commit} />
        {wb.castEstimate && (
          <button className="mt-1 text-[11px] text-ink-faint hover:text-ink" onClick={() => s.apply({ castEstimate: estimateColorCast() })}>
            Re-estimate cast
          </button>
        )}
      </div>
    </Section>
  );
}
