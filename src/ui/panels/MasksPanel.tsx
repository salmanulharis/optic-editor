import { t as tr } from '../../i18n';
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
import { IconButton } from '../controls/IconButton';

const OP_LABEL: Record<MaskOp, string> = { get add() { return tr('masksPanel.add'); }, get subtract() { return tr('masksPanel.subtract'); }, get intersect() { return tr('masksPanel.intersect'); } };
const OP_SIGN: Record<MaskOp, string> = { add: '+', subtract: '−', intersect: '∩' };

function typeItems(onPick: (t: MaskType, params?: Partial<MaskParams[MaskType]>) => void): MenuItem[] {
  return [
    { label: tr('masksPanel.tools'), heading: true },
    { label: tr('masksPanel.linear_gradient'), onSelect: () => onPick('linear') },
    { label: tr('masksPanel.radial_gradient'), onSelect: () => onPick('radial') },
    { label: tr('masksPanel.brush'), onSelect: () => onPick('brush') },
    { label: tr('masksPanel.ranges'), heading: true },
    { label: tr('masksPanel.color_range'), onSelect: () => onPick('colorRange') },
    { label: tr('masksPanel.luminance_range'), onSelect: () => onPick('lumRange') },
    { label: tr('masksPanel.ai_on_device'), heading: true },
    { label: tr('masksPanel.select_subject'), onSelect: () => onPick('aiSubject') },
    { label: tr('masksPanel.select_sky'), onSelect: () => onPick('aiSky') },
    { label: tr('masksPanel.select_background'), onSelect: () => onPick('aiBackground') },
    ...PERSON_PARTS.map((p) => ({ label: p === 'all' ? tr('masksPanel.select_person') : `Person: ${PART_LABELS[p]}`, onSelect: () => onPick('aiPerson', { part: p }) })),
  ];
}

const ADJ_GROUPS: Array<{ title: string; keys: ScalarAdjust[] }> = [
  { title: tr('masksPanel.color'), keys: ['temp', 'tint'] },
  { title: tr('masksPanel.light'), keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: tr('masksPanel.presence'), keys: ['texture', 'clarity', 'dehaze', 'hue', 'saturation'] },
  { title: tr('masksPanel.detail'), keys: ['sharpness', 'noise'] },
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
    <Section title={masks.length ? tr('masksPanel.masks_n', { n: masks.length }) : tr('masksPanel.masks')} defaultOpen>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Menu label={tr('masksPanel.new_mask')} items={typeItems((t, p) => addMask(t, p))} ariaLabel={tr('masksPanel.new_mask_2')} />
        <Menu label={tr('masksPanel.presets')} items={MASK_PRESETS.map((p) => ({ label: p.name, onSelect: () => applyMaskPreset(p) }))} ariaLabel={tr('masksPanel.mask_presets')} />
        <div className="flex-1" />
        <ToolButton active={overlay} onClick={() => set({ maskOverlay: !overlay })} title={tr('masksPanel.show_the_selected_mask_as_an')}>{tr('masksPanel.overlay')}</ToolButton>
        {masks.length > 0 && (
          <button className="text-2xs text-ink-faint hover:text-ink" onClick={() => setAllMasksVisible(allHidden)} title={allHidden ? tr('masksPanel.show_all_masks') : tr('masksPanel.hide_all_masks')}>
            {allHidden ? tr('masksPanel.show_all') : tr('masksPanel.hide_all')}
          </button>
        )}
      </div>
      {masks.length === 0 && <p className="mb-1 text-xs leading-snug text-ink-faint">{tr('masksPanel.masks_apply_adjustments_to_part_of')}</p>}
      <ul className="mb-2 space-y-0.5" aria-label={tr('masksPanel.masks')}>
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
        title={m.visible ? tr('masksPanel.hide_mask') : tr('masksPanel.show_mask')} onClick={() => updateMask(m.id, { visible: !m.visible })}>
        {m.visible ? '◉' : '○'}
      </button>
      {renaming ? (
        <input autoFocus defaultValue={m.name} className="input h-5 min-w-0 flex-1 py-0" aria-label={tr('masksPanel.mask_name')}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { updateMask(m.id, { name: e.currentTarget.value.trim() || m.name }); setRenaming(false); } if (e.key === 'Escape') setRenaming(false); }}
          onBlur={(e) => { updateMask(m.id, { name: e.currentTarget.value.trim() || m.name }); setRenaming(false); }} />
      ) : (
        <button className="min-w-0 flex-1 truncate text-start" onClick={() => set({ selectedMask: m.id, selectedComp: m.components[0]?.id ?? null, masksOpen: true })}
          onDoubleClick={() => setRenaming(true)} title={tr('masksPanel.click_to_select_double_click_to')}>
          {m.name}{m.invert ? tr('masksPanel.inverted') : ''}
        </button>
      )}
      <Menu label="⋯" ariaLabel={tr('masksPanel.name_options', { name: m.name })} align="right" className="rounded px-1.5 text-ink-faint hover:bg-active hover:text-ink"
        items={[
          { label: tr('masksPanel.rename'), onSelect: () => setRenaming(true) },
          { label: tr('masksPanel.duplicate'), onSelect: () => duplicateMask(m.id) },
          { label: m.invert ? tr('masksPanel.un_invert') : tr('masksPanel.invert'), onSelect: () => updateMask(m.id, { invert: !m.invert }) },
          { label: tr('masksPanel.move_up'), disabled: i === 0, onSelect: () => moveMask(m.id, -1) },
          { label: tr('masksPanel.move_down'), disabled: i === n - 1, onSelect: () => moveMask(m.id, 1) },
          { label: tr('masksPanel.reset_adjustments'), onSelect: () => resetAdjustments(m.id) },
          { label: tr('masksPanel.delete'), onSelect: () => deleteMask(m.id) },
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
      <SubHead>{tr('masksPanel.components')}</SubHead>
      <div className="mb-1.5 flex gap-1">
        {(['add', 'subtract', 'intersect'] as MaskOp[]).map((op) => (
          <Menu key={op} label={tr('masksPanel.op_op2', { op: OP_SIGN[op], op2: OP_LABEL[op] })} items={typeItems((t, p) => addComponent(m.id, t, op, p))}
            className="rounded border border-line bg-raise px-1.5 py-0.5 text-2xs text-ink hover:bg-hover" ariaLabel={tr('masksPanel.op_a_component', { op: OP_LABEL[op] })} />
        ))}
      </div>
      <ul className="mb-2 space-y-0.5" aria-label={tr('masksPanel.components')}>
        {m.components.map((c, i) => (
          <li key={c.id} className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs ${c.id === comp?.id ? 'bg-hover text-strong' : 'text-ink-dim hover:bg-hover'}`}>
            <span className="w-4 text-center text-ink-faint" title={OP_LABEL[c.op]}>{i === 0 ? '' : OP_SIGN[c.op]}</span>
            <button className="min-w-0 flex-1 truncate text-start" onClick={() => set({ selectedComp: c.id, maskPick: false })}>
              {componentLabel(c)}{c.invert ? tr('masksPanel.inverted') : ''}
            </button>
            {i > 0 && (
              <select className="rounded bg-transparent text-2xs text-ink-faint outline-none" value={c.op} aria-label={tr('masksPanel.combine_mode')}
                onChange={(e) => updateComponent(m.id, c.id, { op: e.target.value as MaskOp })}>
                <option value="add">{tr('masksPanel.add')}</option><option value="subtract">{tr('masksPanel.subtract')}</option><option value="intersect">{tr('masksPanel.intersect')}</option>
              </select>
            )}
            <IconButton className="text-ink-faint hover:text-ink" label={c.invert ? tr('masksPanel.invert_component_on') : tr('masksPanel.invert_component')} aria-pressed={!!c.invert} onClick={() => updateComponent(m.id, c.id, { invert: !c.invert })}>⊘</IconButton>
            <IconButton className="text-ink-faint hover:text-danger" label={tr('masksPanel.remove_component')} onClick={() => deleteComponent(m.id, c.id)}>✕</IconButton>
          </li>
        ))}
      </ul>
      {comp && <ComponentSettings m={m} c={comp} />}
      <OverlaySettings />
      <SubHead onReset={() => resetAdjustments(m.id)}>{tr('masksPanel.adjustments')}</SubHead>
      <Slider label={tr('masksPanel.amount')} value={m.amount} min={0} max={200} step={1} defaultValue={100} format={(v) => `${Math.round(v)}%`}
        onChange={(v) => updateMask(m.id, { amount: v }, true)} onCommit={commitMasks} />
      {ADJ_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="mt-1.5 text-2xs uppercase tracking-wider text-ink-faint">{g.title}</div>
          {g.keys.map((k) => {
            const r = ADJUST_RANGES[k];
            return (
              <Slider key={k} label={r.label} value={a[k]} min={r.min} max={r.max} step={r.step} defaultValue={0} decimals={k === 'exposure' ? 2 : 0}
                track={TRACKS[k]} onChange={(v) => setAdjustment(m.id, k, v)} onCommit={commitMasks} />
            );
          })}
          {g.title === 'Presence' && (
            <>
              <Slider label={tr('masksPanel.color_tint_hue')} value={a.tintColor.hue} min={0} max={360} step={1} defaultValue={30}
                track={grad('#e05050', '#e0b44a', '#7ad65a', '#4ad6d6', '#4a7bd6', '#d65ad6', '#e05050')}
                onChange={(v) => setAdjustment(m.id, 'tintColor', { ...a.tintColor, hue: v })} onCommit={commitMasks} />
              <Slider label={tr('masksPanel.color_tint_amount')} value={a.tintColor.amount} min={0} max={100} step={1} defaultValue={0}
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
    <div className="mb-1 flex items-center gap-2 text-2xs text-ink-dim">
      <span>{tr('masksPanel.overlay')}</span>
      <Select value={mode} options={[['color', tr('masksPanel.color')], ['bw', tr('masksPanel.black_white')]]} onChange={(v) => set({ maskOverlayMode: v, maskOverlay: true })} title={tr('masksPanel.overlay_style')} />
      {mode === 'color' && (
        <>
          <input type="color" aria-label={tr('masksPanel.overlay_color')} value={hex} className="h-5 w-6 cursor-pointer rounded border border-line bg-transparent"
            onChange={(e) => {
              const v = e.target.value;
              set({ maskOverlayColor: [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number], maskOverlay: true });
            }} />
          <input type="range" min={10} max={100} value={Math.round(opacity * 100)} aria-label={tr('masksPanel.overlay_opacity')} className="w-16 accent-control"
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
      return <p className="mb-2 text-xs text-ink-faint">{tr('masksPanel.drag_the_handles_on_the_photo')}</p>;
    case 'radial': {
      const p = c.params as MaskParams['radial'];
      return (
        <div className="mb-2">
          <p className="mb-1 text-xs text-ink-faint">{tr('masksPanel.drag_the_centre_to_move_the')}</p>
          <Slider label={tr('masksPanel.feather')} value={p.feather} min={0} max={100} step={1} defaultValue={50} onChange={(v) => up<'radial'>({ feather: v })} onCommit={commitMasks} />
          <Toggle label={tr('masksPanel.effect_outside_the_ellipse')} checked={c.invert} onChange={(v) => updateComponent(m.id, c.id, { invert: v })} />
        </div>
      );
    }
    case 'brush': {
      const sb = (patch: Partial<typeof brush>) => set({ brush: { ...useUi.getState().brush, ...patch } });
      return (
        <div className="mb-2">
          <div className="mb-1 flex gap-1">
            <ToolButton active={!brush.erase} onClick={() => sb({ erase: false })} title={tr('masksPanel.paint')}>{tr('masksPanel.paint')}</ToolButton>
            <ToolButton active={brush.erase} onClick={() => sb({ erase: true })} title={tr('masksPanel.erase_or_hold_alt_while_painting')}>{tr('masksPanel.erase')}</ToolButton>
          </div>
          <Slider label={tr('masksPanel.size')} value={Math.round(brush.size * 1000) / 10} min={0.1} max={30} step={0.1} decimals={1} defaultValue={3}
            format={(v) => `${v.toFixed(1)}%`} onChange={(v) => sb({ size: v / 100 })} onCommit={() => {}} />
          <Slider label={tr('masksPanel.feather')} value={brush.feather} min={0} max={100} step={1} defaultValue={50} onChange={(v) => sb({ feather: v })} onCommit={() => {}} />
          <Slider label={tr('masksPanel.flow')} value={brush.flow} min={1} max={100} step={1} defaultValue={100} onChange={(v) => sb({ flow: v })} onCommit={() => {}} />
          <Slider label={tr('masksPanel.density')} value={brush.density} min={1} max={100} step={1} defaultValue={100} onChange={(v) => sb({ density: v })} onCommit={() => {}} />
          <Toggle label={tr('masksPanel.auto_mask_follow_edges')} checked={brush.autoMask} onChange={(v) => sb({ autoMask: v })} />
          <p className="text-xs text-ink-faint">{tr('masksPanel.and_change_the_size_alt_erases')}</p>
        </div>
      );
    }
    case 'colorRange': {
      const p = c.params as MaskParams['colorRange'];
      return (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1.5">
            <ToolButton active={pick} onClick={() => set({ maskPick: !pick })} title={tr('masksPanel.click_colours_on_the_photo_shift')}>{tr('masksPanel.pick_color')}</ToolButton>
            {p.samples.map((s, i) => <span key={i} className="h-4 w-4 rounded border border-line" style={{ background: oklabCss(s) }} title={tr('masksPanel.sample_i', { i: i + 1 })} />)}
            {p.samples.length > 0 && <button className="text-2xs text-ink-faint hover:text-ink" onClick={() => updateParams<'colorRange'>(m.id, c.id, { samples: [] }, false)}>{tr('masksPanel.clear')}</button>}
          </div>
          <Slider label={tr('masksPanel.range')} value={p.range} min={0} max={100} step={1} defaultValue={40} onChange={(v) => up<'colorRange'>({ range: v })} onCommit={commitMasks} />
        </div>
      );
    }
    case 'lumRange': {
      const p = c.params as MaskParams['lumRange'];
      return (
        <div className="mb-2">
          <div className="mb-1 h-2 rounded" style={{ background: 'linear-gradient(to right, #000, #fff)' }}>
            <div className="h-2 rounded border border-warn" style={{ marginLeft: `${p.lo}%`, width: `${Math.max(1, p.hi - p.lo)}%` }} />
          </div>
          <Slider label={tr('masksPanel.range_low')} value={p.lo} min={0} max={100} step={1} defaultValue={60} onChange={(v) => up<'lumRange'>({ lo: Math.min(v, p.hi) })} onCommit={commitMasks} />
          <Slider label={tr('masksPanel.range_high')} value={p.hi} min={0} max={100} step={1} defaultValue={100} onChange={(v) => up<'lumRange'>({ hi: Math.max(v, p.lo) })} onCommit={commitMasks} />
          <Slider label={tr('masksPanel.smoothness')} value={p.smoothness} min={0} max={100} step={1} defaultValue={30} onChange={(v) => up<'lumRange'>({ smoothness: v })} onCommit={commitMasks} />
          <ToolButton active={pick} onClick={() => set({ maskPick: !pick })} title={tr('masksPanel.click_the_photo_to_centre_the')}>{tr('masksPanel.pick_luminance')}</ToolButton>
        </div>
      );
    }
    default: {
      const model = aiModelFor(c)!;
      return (
        <div className="mb-2 text-2xs text-ink-dim">
          {c.type === 'aiPerson' && (
            <div className="mb-1 flex items-center justify-between">
              <span>{tr('masksPanel.part')}</span>
              <Select<PersonPart> label={tr('masksPanel.person_part')} value={(c.params as MaskParams['aiPerson']).part} options={PERSON_PARTS.map((p) => [p, PART_LABELS[p]])}
                onChange={(v) => {
                  const nc = { ...c, params: { part: v } } as MaskComponent;
                  const nm = aiModelFor(nc)!;
                  updateComponent(m.id, c.id, { params: { part: v }, cacheKey: c.cacheKey?.replace(/ai:[a-zA-Z]+$/, `ai:${nm}`) });
                  void ensureAiMask(nm);
                }} />
            </div>
          )}
          {!ai || ai.state === 'ready' || ai.state === 'idle' ? (
            <p className="text-ink-faint">{tr('masksPanel.computed_on_this_device')}{ai?.state === 'ready' ? '' : '…'}{tr('masksPanel.edges_are_refined_against_the_full')}</p>
          ) : ai.state === 'error' ? (
            <div>
              <p className="text-danger">{ai.message}</p>
              <button className="mt-1 text-ink hover:underline" onClick={() => void ensureAiMask(model)}>{tr('masksPanel.try_again')}</button>
            </div>
          ) : (
            <div>
              <div>{ai.message || tr('masksPanel.working')}…</div>
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
