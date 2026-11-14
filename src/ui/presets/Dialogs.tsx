import { t as tr } from '../../i18n';
import { useState } from 'react';
import { copySettings, pasteSettings, presetFromRecipe } from '../../app/presetActions';
import { PHOTO_SPECIFIC_GROUPS, PRESET_GROUPS, type PresetGroup } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { usePresets } from '../../state/presetStore';
import { useUi } from '../../state/uiStore';

/** The shared modal shell (moved to controls/Modal.tsx; re-exported for existing imports). */
import { Modal } from '../controls/Modal';
export { Modal };

export function GroupChecklist({ value, onChange, enabled }: { value: PresetGroup[]; onChange(v: PresetGroup[]): void; enabled?: PresetGroup[] }) {
  return (
    <div className="grid grid-cols-1 gap-0.5">
      {PRESET_GROUPS.map((g) => {
        const disabled = enabled ? !enabled.includes(g) : false;
        return (
          <label key={g} className={`flex items-center gap-2 text-xs ${disabled ? 'text-ink-faint' : 'text-ink-dim'}`}>
            <input type="checkbox" className="accent-control" disabled={disabled} checked={value.includes(g) && !disabled}
              onChange={(e) => onChange(e.target.checked ? [...value, g] : value.filter((x) => x !== g))} />
            {tr(`groups.${g}`)}
          </label>
        );
      })}
      <div className="mt-1 flex gap-2 text-2xs">
        <button className="text-ink-faint hover:text-ink" onClick={() => onChange(PRESET_GROUPS.filter((g) => !enabled || enabled.includes(g)))}>{tr('dialogs.all')}</button>
        <button className="text-ink-faint hover:text-ink" onClick={() => onChange([])}>{tr('dialogs.none')}</button>
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
    <Modal title={tr('dialogs.create_preset')} onClose={close}>
      <label htmlFor="optic-preset-name" className="block text-2xs uppercase tracking-wider text-ink-faint">{tr('dialogs.name')}</label>
      <input id="optic-preset-name" autoFocus className="input mb-2 mt-0.5 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('dialogs.my_look')} />
      <label htmlFor="optic-preset-group" className="block text-2xs uppercase tracking-wider text-ink-faint">{tr('dialogs.group')}</label>
      <input id="optic-preset-group" className="input mb-2 mt-0.5 w-full" list="optic-preset-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
      <datalist id="optic-preset-groups">{existing.map((g) => <option key={g} value={g} />)}</datalist>
      <div className="mb-1 text-2xs uppercase tracking-wider text-ink-faint">{tr('dialogs.include')}</div>
      <GroupChecklist value={groups} onChange={setGroups} />
      <label className="mt-3 flex items-center gap-2 text-xs text-ink-dim" title={tr('dialogs.store_these_exact_values_for_jpeg')}>
        <input type="checkbox" className="accent-control" checked={nonRaw} onChange={(e) => setNonRaw(e.target.checked)} />{tr('dialogs.save_a_separate_non_raw_variant')}</label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('dialogs.cancel')}</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40"
          disabled={!groups.length} onClick={save}>{tr('dialogs.save_preset')}</button>
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
    <Modal title={mode === 'copy' ? tr('dialogs.copy_settings') : tr('dialogs.paste_settings')} onClose={close}>
      {mode === 'paste' && !clip ? (
        <p className="text-xs text-ink-dim">{tr('dialogs.nothing_copied_yet_use_copy_settings')}</p>
      ) : (
        <GroupChecklist value={groups} onChange={setGroups} enabled={enabled} />
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-line px-3 py-1.5 text-xs hover:bg-hover" onClick={close}>{tr('dialogs.cancel')}</button>
        <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hi disabled:opacity-40"
          disabled={!groups.length || (mode === 'paste' && !clip)}
          onClick={() => { if (mode === 'copy') copySettings(groups); else pasteSettings(groups); close(); }}>
          {mode === 'copy' ? tr('dialogs.copy') : tr('dialogs.paste')}
        </button>
      </div>
    </Modal>
  );
}
