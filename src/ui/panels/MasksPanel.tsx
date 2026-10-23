/**
 * Masks (local adjustments): the mask list (visibility, rename, duplicate, invert, reorder, delete),
 * the selected mask's components (add / subtract / intersect) and their settings, the overlay, and
 * the mask's adjustment set with its overall amount.
 */
import { useState } from 'react';
import { useAi } from '../../ai/aiMasks';
import {
  MASK_PRESETS,
  addComponent,
  addMask,
  applyMaskPreset,
  commitMasks,
  deleteComponent,
  deleteMask,
  duplicateMask,
  moveMask,
  resetAdjustments,
  setAdjustment,
  setAllMasksVisible,
  updateComponent,
  updateMask,
  updateParams,
} from '../../app/maskActions';
import { ensureAiMask } from '../../ai/aiMasks';
import {
  ADJUST_RANGES,
  type Mask,
  type MaskComponent,
  type MaskOp,
  type MaskParams,
  type MaskType,
  PART_LABELS,
  PERSON_PARTS,
  type PersonPart,
  type ScalarAdjust,
  TYPE_LABELS,
  aiModelFor,
  isAiType,
} from '../../recipe/masks';
import { useEdit } from '../../state/editStore';
import { useUi } from '../../state/uiStore';
import { type MenuItem, Menu } from '../controls/Menu';
import { Section, Select, SubHead, Toggle, ToolButton } from '../controls/Section';
import { Slider } from '../controls/Slider';
import { grad } from './common';

const OP_LABEL: Record<MaskOp, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };
const OP_SIGN: Record<MaskOp, string> = { add: '+', subtract: '−', intersect: '∩' };

function typeItems(onPick: (t: MaskType, params?: Partial<MaskParams[MaskType]>) => void): MenuItem[] {
  return [
    { label: 'Tools', heading: true },
    { label: 'Linear gradient', onSelect: () => onPick('linear') },
    { label: 'Radial gradient', onSelect: () => onPick('radial') },
    { label: 'Brush', onSelect: () => onPick('brush') },
    { label: 'Ranges', heading: true },
    { label: 'Color range', onSelect: () => onPick('colorRange') },
    { label: 'Luminance range', onSelect: () => onPick('lumRange') },
    { label: 'AI (on-device)', heading: true },
    { label: 'Select subject', onSelect: () => onPick('aiSubject') },
    { label: 'Select sky', onSelect: () => onPick('aiSky') },
    { label: 'Select background', onSelect: () => onPick('aiBackground') },
    ...PERSON_PARTS.map((p) => ({ label: p === 'all' ? 'Select person' : `Person: ${PART_LABELS[p]}`, onSelect: () => onPick('aiPerson', { part: p }) })),
  ];
}

const ADJ_GROUPS: Array<{ title: string; keys: ScalarAdjust[] }> = [
  { title: 'Color', keys: ['temp', 'tint'] },
  { title: 'Light', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: 'Presence', keys: ['texture', 'clarity', 'dehaze', 'hue', 'saturation'] },
  { title: 'Detail', keys: ['sharpness', 'noise'] },
];

const TRACKS: Partial<Record<ScalarAdjust, string>> = {
  temp: grad('#4a7bd6', '#9a9a9a', '#e0b44a'),
  tint: grad('#4caf50', '#9a9a9a', '#d65ad6'),
  hue: grad('#d65ad6', '#e05050', '#e0b44a', '#7ad65a', '#4ad6d6', '#4a7bd6'),
  saturation: grad('#808080', '#e05050'),
};

export function MasksPanel() {
  const masks = useEdit((s) => s.recipe.masks);
  const selected = useUi((s) => s.selectedMask);
  const overlay = useUi((s) => s.maskOverlay);
  const set = useUi.getState().set;
  const sel = masks.find((m) => m.id === selected) ?? null;
  const allHidden = masks.length > 0 && masks.every((m) => !m.visible);
  return (
    <Section title={`Masks${masks.length ? ` (${masks.length})` : ''}`} defaultOpen>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Menu label="+ New mask" items={typeItems((t, p) => addMask(t, p))} ariaLabel="New mask" />
        <Menu label="Presets" items={MASK_PRESETS.map((p) => ({ label: p.name, onSelect: () => applyMaskPreset(p) }))} ariaLabel="Mask presets" />
        <div className="flex-1" />
        <ToolButton active={overlay} onClick={() => set({ maskOverlay: !overlay })} title="Show the selected mask as an overlay (O)">Overlay</ToolButton>
        {masks.length > 0 && (
          <button className="text-[11px] text-ink-faint hover:text-ink" onClick={() => setAllMasksVisible(allHidden)} title={allHidden ? 'Show all masks' : 'Hide all masks'}>
            {allHidden ? 'Show all' : 'Hide all'}
          </button>
        )}
      </div>
      {masks.length === 0 && <p className="mb-1 text-[11px] leading-snug text-ink-faint">Masks apply adjustments to part of the photo. Start with a gradient, a brush, a range or an AI selection.</p>}
      <ul className="mb-2 space-y-0.5" aria-label="Masks">
        {masks.map((m, i) => <MaskRow key={m.id} m={m} i={i} n={masks.length} active={m.id === selected} />)}
      </ul>
      {sel && <MaskEditor key={sel.id} m={sel} />}
    </Section>
  );
}

function MaskRow({ m, i, n, active }: { m: Mask; i: number; n: number; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const set = useUi.getState().set;
  return (
    <li className={`group flex items-center gap-1 rounded px-1.5 py-1 text-xs ${active ? 'bg-active text-strong' : 'text-ink hover:bg-hover'}`}>
      <button className={m.visible ? 'text-ink-dim hover:text-ink' : 'text-ink-faint hover:text-ink'} aria-pressed={m.visible}
        title={m.visible ? 'Hide mask' : 'Show mask'} onClick={() => updateMask(m.id, { visible: !m.visible })}>
        {m.visible ? '◉' : '○'}
      </button>
      {renaming ? (
        <input autoFocus defaultValue={m.name} className="input h-5 min-w-0 flex-1 py-0" aria-label="Mask name"
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { updateMask(m.id, { name: e.currentTarget.value.trim() || m.name }); setRenaming(false); } if (e.key === 'Escape') setRenaming(false); }}
          onBlur={(e) => { updateMask(m.id, { name: e.currentTarget.value.trim() || m.name }); setRenaming(false); }} />
      ) : (
        <button className="min-w-0 flex-1 truncate text-left" onClick={() => set({ selectedMask: m.id, selectedComp: m.components[0]?.id ?? null, masksOpen: true })}
          onDoubleClick={() => setRenaming(true)} title="Click to select, double-click to rename">
          {m.name}{m.invert ? ' (inverted)' : ''}
        </button>
      )}
      <Menu label="⋯" ariaLabel={`${m.name} options`} align="right" className="rounded px-1.5 text-ink-faint hover:bg-active hover:text-ink"
        items={[
          { label: 'Rename', onSelect: () => setRenaming(true) },
          { label: 'Duplicate', onSelect: () => duplicateMask(m.id) },
          { label: m.invert ? 'Un-invert' : 'Invert', onSelect: () => updateMask(m.id, { invert: !m.invert }) },
          { label: 'Move up', disabled: i === 0, onSelect: () => moveMask(m.id, -1) },
          { label: 'Move down', disabled: i === n - 1, onSelect: () => moveMask(m.id, 1) },
          { label: 'Reset adjustments', onSelect: () => resetAdjustments(m.id) },
          { label: 'Delete', onSelect: () => deleteMask(m.id) },
        ]} />
    </li>
  );
}

function MaskEditor({ m }: { m: Mask }) {
  const selComp = useUi((s) => s.selectedComp);
  const comp = m.components.find((c) => c.id === selComp) ?? m.components[0];
  const set = useUi.getState().set;
  const a = m.adjustments;
  return (
    <div className="rounded border border-line p-2">
      <SubHead>Components</SubHead>
      <div className="mb-1.5 flex gap-1">
        {(['add', 'subtract', 'intersect'] as MaskOp[]).map((op) => (
          <Menu key={op} label={`${OP_SIGN[op]} ${OP_LABEL[op]}`} items={typeItems((t, p) => addComponent(m.id, t, op, p))}
            className="rounded border border-line bg-raise px-1.5 py-0.5 text-[11px] text-ink hover:bg-hover" ariaLabel={`${OP_LABEL[op]} a component`} />
        ))}
      </div>
      <ul className="mb-2 space-y-0.5" aria-label="Components">
        {m.components.map((c, i) => (
          <li key={c.id} className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${c.id === comp?.id ? 'bg-hover text-strong' : 'text-ink-dim hover:bg-hover'}`}>
            <span className="w-4 text-center text-ink-faint" title={OP_LABEL[c.op]}>{i === 0 ? '' : OP_SIGN[c.op]}</span>
            <button className="min-w-0 flex-1 truncate text-left" onClick={() => set({ selectedComp: c.id, maskPick: false })}>
              {componentLabel(c)}{c.invert ? ' (inverted)' : ''}
            </button>
            {i > 0 && (
              <select className="rounded bg-transparent text-[10px] text-ink-faint outline-none" value={c.op} aria-label="Combine mode"
                onChange={(e) => updateComponent(m.id, c.id, { op: e.target.value as MaskOp })}>
                <option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
              </select>
            )}
            <button className="text-ink-faint hover:text-ink" title="Invert component" aria-label="Invert component" onClick={() => updateComponent(m.id, c.id, { invert: !c.invert })}>⊘</button>
            <button className="text-ink-faint hover:text-[#e07070]" title="Remove component" aria-label="Remove component" onClick={() => deleteComponent(m.id, c.id)}>✕</button>
          </li>
        ))}
      </ul>
      {comp && <ComponentSettings m={m} c={comp} />}
      <OverlaySettings />
      <SubHead onReset={() => resetAdjustments(m.id)}>Adjustments</SubHead>
      <Slider label="Amount" value={m.amount} min={0} max={200} step={1} defaultValue={100} format={(v) => `${Math.round(v)}%`}
        onChange={(v) => updateMask(m.id, { amount: v }, true)} onCommit={commitMasks} />
      {ADJ_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="mt-1.5 text-[10px] uppercase tracking-wider text-ink-faint">{g.title}</div>
          {g.keys.map((k) => {
            const r = ADJUST_RANGES[k];
            return (
              <Slider key={k} label={r.label} value={a[k]} min={r.min} max={r.max} step={r.step} defaultValue={0} decimals={k === 'exposure' ? 2 : 0}
                track={TRACKS[k]} onChange={(v) => setAdjustment(m.id, k, v)} onCommit={commitMasks} />
            );
          })}
          {g.title === 'Presence' && (
            <>
              <Slider label="Color tint hue" value={a.tintColor.hue} min={0} max={360} step={1} defaultValue={30}
                track={grad('#e05050', '#e0b44a', '#7ad65a', '#4ad6d6', '#4a7bd6', '#d65ad6', '#e05050')}
                onChange={(v) => setAdjustment(m.id, 'tintColor', { ...a.tintColor, hue: v })} onCommit={commitMasks} />
              <Slider label="Color tint amount" value={a.tintColor.amount} min={0} max={100} step={1} defaultValue={0}
                onChange={(v) => setAdjustment(m.id, 'tintColor', { ...a.tintColor, amount: v })} onCommit={commitMasks} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function componentLabel(c: MaskComponent): string {
  if (c.type === 'aiPerson') {
    const p = (c.params as MaskParams['aiPerson']).part;
    return p === 'all' ? 'Person' : `Person: ${PART_LABELS[p]}`;
  }
  if (c.type === 'brush') return `Brush (${(c.params as MaskParams['brush']).strokes.length} strokes)`;
  return TYPE_LABELS[c.type];
}

function OverlaySettings() {
  const mode = useUi((s) => s.maskOverlayMode);
  const color = useUi((s) => s.maskOverlayColor);
  const opacity = useUi((s) => s.maskOverlayOpacity);
  const set = useUi.getState().set;
  const hex = `#${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
  return (
    <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-dim">
      <span>Overlay</span>
      <Select value={mode} options={[['color', 'Color'], ['bw', 'Black & white']]} onChange={(v) => set({ maskOverlayMode: v, maskOverlay: true })} title="Overlay style" />
      {mode === 'color' && (
        <>
          <input type="color" aria-label="Overlay color" value={hex} className="h-5 w-6 cursor-pointer rounded border border-line bg-transparent"
            onChange={(e) => {
              const v = e.target.value;
              set({ maskOverlayColor: [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number], maskOverlay: true });
            }} />
          <input type="range" min={10} max={100} value={Math.round(opacity * 100)} aria-label="Overlay opacity" className="w-16 accent-[#9a9a9a]"
            onChange={(e) => set({ maskOverlayOpacity: +e.target.value / 100, maskOverlay: true })} />
        </>
      )}
    </div>
  );
}

function ComponentSettings({ m, c }: { m: Mask; c: MaskComponent }) {
  const brush = useUi((s) => s.brush);
  const pick = useUi((s) => s.maskPick);
  const ai = useAi((s) => (isAiType(c.type) ? s.status[aiModelFor(c)!] : undefined));
  const set = useUi.getState().set;
  const up = <T extends MaskType>(patch: Partial<MaskParams[T]>) => updateParams<T>(m.id, c.id, patch);
  switch (c.type) {
    case 'linear':
      return <p className="mb-2 text-[11px] text-ink-faint">Drag the handles on the photo: full effect at the solid line, none at the dashed line.</p>;
    case 'radial': {
      const p = c.params as MaskParams['radial'];
      return (
        <div className="mb-2">
          <p className="mb-1 text-[11px] text-ink-faint">Drag the centre to move, the handles to resize, the outer dot to rotate.</p>
          <Slider label="Feather" value={p.feather} min={0} max={100} step={1} defaultValue={50} onChange={(v) => up<'radial'>({ feather: v })} onCommit={commitMasks} />
          <Toggle label="Effect outside the ellipse" checked={c.invert} onChange={(v) => updateComponent(m.id, c.id, { invert: v })} />
        </div>
      );
    }
    case 'brush': {
      const sb = (patch: Partial<typeof brush>) => set({ brush: { ...useUi.getState().brush, ...patch } });
      return (
        <div className="mb-2">
          <div className="mb-1 flex gap-1">
            <ToolButton active={!brush.erase} onClick={() => sb({ erase: false })} title="Paint">Paint</ToolButton>
            <ToolButton active={brush.erase} onClick={() => sb({ erase: true })} title="Erase (or hold Alt while painting)">Erase</ToolButton>
          </div>
          <Slider label="Size" value={Math.round(brush.size * 1000) / 10} min={0.1} max={30} step={0.1} decimals={1} defaultValue={3}
            format={(v) => `${v.toFixed(1)}%`} onChange={(v) => sb({ size: v / 100 })} onCommit={() => {}} />
          <Slider label="Feather" value={brush.feather} min={0} max={100} step={1} defaultValue={50} onChange={(v) => sb({ feather: v })} onCommit={() => {}} />
          <Slider label="Flow" value={brush.flow} min={1} max={100} step={1} defaultValue={100} onChange={(v) => sb({ flow: v })} onCommit={() => {}} />
          <Slider label="Density" value={brush.density} min={1} max={100} step={1} defaultValue={100} onChange={(v) => sb({ density: v })} onCommit={() => {}} />
          <Toggle label="Auto mask (follow edges)" checked={brush.autoMask} onChange={(v) => sb({ autoMask: v })} />
          <p className="text-[11px] text-ink-faint">[ and ] change the size; Alt erases; pen pressure sets the flow.</p>
        </div>
      );
    }
    case 'colorRange': {
      const p = c.params as MaskParams['colorRange'];
      return (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1.5">
            <ToolButton active={pick} onClick={() => set({ maskPick: !pick })} title="Click colours on the photo (Shift-click adds, up to 3)">Pick color</ToolButton>
            {p.samples.map((s, i) => <span key={i} className="h-4 w-4 rounded border border-line" style={{ background: oklabCss(s) }} title={`Sample ${i + 1}`} />)}
            {p.samples.length > 0 && <button className="text-[11px] text-ink-faint hover:text-ink" onClick={() => updateParams<'colorRange'>(m.id, c.id, { samples: [] }, false)}>Clear</button>}
          </div>
          <Slider label="Range" value={p.range} min={0} max={100} step={1} defaultValue={40} onChange={(v) => up<'colorRange'>({ range: v })} onCommit={commitMasks} />
        </div>
      );
    }
    case 'lumRange': {
      const p = c.params as MaskParams['lumRange'];
      return (
        <div className="mb-2">
          <div className="mb-1 h-2 rounded" style={{ background: 'linear-gradient(to right, #000, #fff)' }}>
            <div className="h-2 rounded border border-[#e0b44a]" style={{ marginLeft: `${p.lo}%`, width: `${Math.max(1, p.hi - p.lo)}%` }} />
          </div>
          <Slider label="Range low" value={p.lo} min={0} max={100} step={1} defaultValue={60} onChange={(v) => up<'lumRange'>({ lo: Math.min(v, p.hi) })} onCommit={commitMasks} />
          <Slider label="Range high" value={p.hi} min={0} max={100} step={1} defaultValue={100} onChange={(v) => up<'lumRange'>({ hi: Math.max(v, p.lo) })} onCommit={commitMasks} />
          <Slider label="Smoothness" value={p.smoothness} min={0} max={100} step={1} defaultValue={30} onChange={(v) => up<'lumRange'>({ smoothness: v })} onCommit={commitMasks} />
          <ToolButton active={pick} onClick={() => set({ maskPick: !pick })} title="Click the photo to centre the range on that lightness">Pick luminance</ToolButton>
        </div>
      );
    }
    default: {
      const model = aiModelFor(c)!;
      return (
        <div className="mb-2 text-[11px] text-ink-dim">
          {c.type === 'aiPerson' && (
            <div className="mb-1 flex items-center justify-between">
              <span>Part</span>
              <Select<PersonPart> label="Person part" value={(c.params as MaskParams['aiPerson']).part} options={PERSON_PARTS.map((p) => [p, PART_LABELS[p]])}
                onChange={(v) => {
                  const nc = { ...c, params: { part: v } } as MaskComponent;
                  const nm = aiModelFor(nc)!;
                  updateComponent(m.id, c.id, { params: { part: v }, cacheKey: c.cacheKey?.replace(/ai:[a-zA-Z]+$/, `ai:${nm}`) });
                  void ensureAiMask(nm);
                }} />
            </div>
          )}
          {!ai || ai.state === 'ready' || ai.state === 'idle' ? (
            <p className="text-ink-faint">Computed on this device{ai?.state === 'ready' ? '' : '…'}; edges are refined against the full-resolution photo.</p>
          ) : ai.state === 'error' ? (
            <div>
              <p className="text-[#e09090]">{ai.message}</p>
              <button className="mt-1 text-ink hover:underline" onClick={() => void ensureAiMask(model)}>Try again</button>
            </div>
          ) : (
            <div>
              <div>{ai.message || 'Working'}…</div>
              <div className="mt-1 h-1 overflow-hidden rounded bg-hover"><div className="h-full bg-meter" style={{ width: `${Math.round(ai.progress * 100)}%` }} /></div>
            </div>
          )}
        </div>
      );
    }
  }
}

/** Rough CSS colour for an OKLab sample swatch. */
function oklabCss(s: { L: number; a: number; b: number }) {
  const C = Math.hypot(s.a, s.b), h = (Math.atan2(s.b, s.a) * 180) / Math.PI;
  return `oklch(${Math.min(1, Math.pow(Math.max(0, s.L), 1)) * 100}% ${C} ${h})`;
}
