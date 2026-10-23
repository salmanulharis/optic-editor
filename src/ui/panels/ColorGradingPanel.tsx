import { useState } from 'react';
import { defaultRecipe, type Recipe, type Wheel } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useUi } from '../../state/uiStore';
import { ColorWheel } from '../controls/ColorWheel';
import { Section } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { bindSection, grad } from './common';

type WheelKey = 'shadows' | 'midtones' | 'highlights' | 'global';
const WHEELS: Array<[WheelKey, string]> = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights'], ['global', 'Global']];

export function ColorGradingPanel() {
  const g = useEdit((s) => s.recipe.colorGrading);
  const layout = useUi((s) => s.gradingLayout);
  const [one, setOne] = useState<WheelKey>('midtones');
  const s = bindSection('colorGrading');
  const setWheel = (k: WheelKey, w: Wheel) => s.set({ [k]: w } as Partial<Recipe['colorGrading']>);

  const wheelBlock = (k: WheelKey, label: string, size: number) => (
    <div key={k} className="flex flex-col items-center">
      <ColorWheel value={g[k]} size={size} label={label} onChange={(w) => setWheel(k, w)} onCommit={s.commit} />
      <div className="w-full px-1">
        <Slider label="Lum" value={g[k].lum} min={-100} max={100} step={1} defaultValue={0} track={grad('#222', '#ddd')}
          onChange={(v) => setWheel(k, { ...g[k], lum: v })} onCommit={s.commit} />
      </div>
    </div>
  );

  return (
    <Section
      title="Color Grading"
      enabled={g.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('colorGrading', on)}
      onReset={() => s.apply({ ...defaultRecipe().colorGrading, enabled: g.enabled })}
    >
      <div className="mb-2 flex items-center justify-end gap-1 text-[11px]">
        {(['3up', '1up'] as const).map((l) => (
          <button key={l} onClick={() => useUi.getState().set({ gradingLayout: l })}
            className={`rounded px-1.5 py-0.5 ${layout === l ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}>
            {l === '3up' ? '3-up' : '1-up'}
          </button>
        ))}
      </div>
      {layout === '3up' ? (
        <>
          <div className="grid grid-cols-3 gap-1">{WHEELS.slice(0, 3).map(([k, l]) => wheelBlock(k, l, 74))}</div>
          <div className="mx-auto mt-1 w-1/2">{wheelBlock('global', 'Global', 74)}</div>
        </>
      ) : (
        <>
          <div className="mb-2 flex rounded border border-line text-[11px]">
            {WHEELS.map(([k, l]) => (
              <button key={k} onClick={() => setOne(k)} className={`flex-1 py-1 ${one === k ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}>{l}</button>
            ))}
          </div>
          {wheelBlock(one, WHEELS.find((w) => w[0] === one)![1], 168)}
        </>
      )}
      <div className="mt-2 border-t border-line pt-2">
        <Slider label="Blending" value={g.blending} min={0} max={100} step={1} defaultValue={50}
          onChange={(v) => s.set({ blending: v })} onCommit={s.commit} />
        <Slider label="Balance" value={g.balance} min={-100} max={100} step={1} defaultValue={0}
          onChange={(v) => s.set({ balance: v })} onCommit={s.commit} />
      </div>
    </Section>
  );
}
