import { type ReactNode, useState } from 'react';
import { copySettings, pasteSettings, presetFromRecipe } from '../../app/presetActions';
import { GROUP_LABELS, PHOTO_SPECIFIC_GROUPS, PRESET_GROUPS, type PresetGroup } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { usePresets } from '../../state/presetStore';
import { useUi } from '../../state/uiStore';

export function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className="w-full max-w-md rounded-lg border border-line bg-panel p-4 text-ink shadow-2xl"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <h2 className="mb-3 text-sm font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function GroupChecklist({ value, onChange, enabled }: { value: PresetGroup[]; onChange(v: PresetGroup[]): void; enabled?: PresetGroup[] }) {
  return (
    <div className="grid grid-cols-1 gap-0.5">
      {PRESET_GROUPS.map((g) => {
        const disabled = enabled ? !enabled.includes(g) : false;
        return (
          <label key={g} className={`flex items-center gap-2 text-xs ${disabled ? 'text-ink-faint' : 'text-ink-dim'}`}>
            <input type="checkbox" className="accent-[#9a9a9a]" disabled={disabled} checked={value.includes(g) && !disabled}
              onChange={(e) => onChange(e.target.checked ? [...value, g] : value.filter((x) => x !== g))} />
            {GROUP_LABELS[g]}
          </label>
        );
      })}
      <div className="mt-1 flex gap-2 text-[11px]">
        <button className="text-ink-faint hover:text-ink" onClick={() => onChange(PRESET_GROUPS.filter((g) => !enabled || enabled.includes(g)))}>All</button>
        <button className="text-ink-faint hover:text-ink" onClick={() => onChange([])}>None</button>
      </div>
    </div>
  );
}

/** Photo-specific groups (white balance, exposure, noise reduction, lens, geometry, crop) start unticked. */
export const DEFAULT_PRESET_GROUPS = PRESET_GROUPS.filter((g) => !PHOTO_SPECIFIC_GROUPS.includes(g));

export function CreatePresetDialog() {
  const open = useUi((s) => s.createPresetOpen);
  const user = usePresets((s) => s.user);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('My Presets');
  const [groups, setGroups] = useState<PresetGroup[]>(DEFAULT_PRESET_GROUPS);
  const [nonRaw, setNonRaw] = useState(false);
  if (!open) return null;
  const close = () => useUi.getState().set({ createPresetOpen: false });
  const existing = [...new Set(['My Presets', ...user.map((p) => p.group)])];
  const save = async () => {
    const p = presetFromRecipe(useEdit.getState().recipe, { name: name.trim() || 'Untitled', group: group.trim(), groups, nonRawVariant: nonRaw });
    await usePresets.getState().saveUser(p);
    setName('');
    close();
  };
  return (
    <Modal title="Create preset" onClose={close}>
      <label className="block text-[11px] uppercase tracking-wider text-ink-faint">Name</label>
      <input autoFocus className="input mb-2 mt-0.5 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="My look" />
      <label className="block text-[11px] uppercase tracking-wider text-ink-faint">Group</label>
      <input className="input mb-2 mt-0.5 w-full" list="optic-preset-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
      <datalist id="optic-preset-groups">{existing.map((g) => <option key={g} value={g} />)}</datalist>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Include</div>
      <GroupChecklist value={groups} onChange={setGroups} />
      <label className="mt-3 flex items-center gap-2 text-xs text-ink-dim" title="Store these exact values for JPEG/HEIC/PNG instead of the automatic 75 % scaling">
        <input type="checkbox" className="accent-[#9a9a9a]" checked={nonRaw} onChange={(e) => setNonRaw(e.target.checked)} />
        Save a separate non-RAW variant (exact values, no automatic scaling)
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>Cancel</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40"
          disabled={!groups.length} onClick={save}>Save preset</button>
      </div>
    </Modal>
  );
}

export function CopyPasteDialog() {
  const mode = useUi((s) => s.copyPaste);
  const clip = useUi((s) => s.clipboard);
  const [groups, setGroups] = useState<PresetGroup[]>(DEFAULT_PRESET_GROUPS);
  if (!mode) return null;
  const close = () => useUi.getState().set({ copyPaste: null });
  const enabled = mode === 'paste' ? clip?.groups : undefined;
  return (
    <Modal title={mode === 'copy' ? 'Copy settings' : 'Paste settings'} onClose={close}>
      {mode === 'paste' && !clip ? (
        <p className="text-xs text-ink-dim">Nothing copied yet. Use Copy settings (Ctrl/Cmd+Shift+C) first.</p>
      ) : (
        <GroupChecklist value={groups} onChange={setGroups} enabled={enabled} />
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>Cancel</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40"
          disabled={!groups.length || (mode === 'paste' && !clip)}
          onClick={() => { if (mode === 'copy') copySettings(groups); else pasteSettings(groups); close(); }}>
          {mode === 'copy' ? 'Copy' : 'Paste'}
        </button>
      </div>
    </Modal>
  );
}
