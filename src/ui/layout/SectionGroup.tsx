/**
 * Groups panel sections (the editor's adjustments column) for "one section at a time": while it
 * is on, opening a section closes the others. Sections outside a group keep their own state.
 */
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react';
import { useUi } from '../../state/uiStore';
import { t as tr } from '../../i18n';

interface Group {
  solo: boolean;
  openId: string | null;
  setOpen(id: string | null): void;
  /** Remembers the last section the user opened (it stays open when solo mode is turned on). */
  noteOpened(id: string): void;
}

const Ctx = createContext<Group | null>(null);

export function SectionGroup({ children }: { children: ReactNode }) {
  const solo = useUi((s) => s.soloSections);
  const [openId, setOpenId] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => { if (solo) setOpenId(last.current); }, [solo]);
  return (
    <Ctx.Provider value={{ solo, openId, setOpen: setOpenId, noteOpened: (id) => { last.current = id; } }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSectionGroup = () => useContext(Ctx);

/** The switch shown at the top of the adjustments column. */
export function SoloToggle() {
  const solo = useUi((s) => s.soloSections);
  return (
    <label className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-ink-dim">
      <input type="checkbox" className="accent-control" checked={solo} onChange={(e) => useUi.getState().set({ soloSections: e.target.checked })} />{tr('sectionGroup.one_section_at_a_time')}</label>
  );
}
