import { IDENTITY_CURVE, type Point } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { type CurveChannel, useUi } from '../../state/uiStore';
import { CurveEditor } from '../controls/CurveEditor';
import { Section } from '../controls/Section';

const CHANNELS: Array<[CurveChannel, string, string]> = [
  ['rgb', 'RGB', '#d4d4d4'],
  ['r', 'R', '#e06060'],
  ['g', 'G', '#60c060'],
  ['b', 'B', '#6080e0'],
];

export function CurvePanel() {
  const curve = useEdit((s) => s.recipe.curve);
  const ch = useUi((s) => s.curveChannel);
  const hist = useUi((s) => s.histogram);
  const color = CHANNELS.find((c) => c[0] === ch)![2];
  const bins = hist ? (ch === 'rgb' ? hist.l : hist[ch]) : null;

  const set = (pts: Point[]) => useEdit.getState().update((r) => ({ ...r, curve: { ...r.curve, [ch]: pts } }));

  return (
    <Section
      title="Curve"
      enabled={curve.enabled}
      onToggle={(on) => useEdit.getState().setSectionEnabled('curve', on)}
      onReset={() =>
        useEdit.getState().apply((r) => ({
          ...r,
          curve: { ...r.curve, rgb: [...IDENTITY_CURVE], r: [...IDENTITY_CURVE], g: [...IDENTITY_CURVE], b: [...IDENTITY_CURVE] },
        }))
      }
    >
      <div className="mb-2 flex items-center gap-1">
        {CHANNELS.map(([id, label, c]) => (
          <button
            key={id}
            onClick={() => useUi.getState().set({ curveChannel: id })}
            className={`rounded px-2 py-0.5 text-xs ${ch === id ? 'bg-active text-strong' : 'text-ink-dim hover:text-ink'}`}
          >
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: c }} />
            {label}
          </button>
        ))}
        <button
          className="ml-auto text-[11px] text-ink-faint hover:text-ink"
          onClick={() => useEdit.getState().apply((r) => ({ ...r, curve: { ...r.curve, [ch]: [...IDENTITY_CURVE] } }))}
        >
          Reset {CHANNELS.find((c) => c[0] === ch)![1]}
        </button>
      </div>
      <CurveEditor points={curve[ch]} color={color} onChange={set} onCommit={() => useEdit.getState().commit()} histogram={bins} />
      <p className="mt-1 text-[10px] text-ink-faint">Click to add · drag to move · drag off or double-click to delete</p>
    </Section>
  );
}
