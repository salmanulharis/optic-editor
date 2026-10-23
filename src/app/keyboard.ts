/** Global keyboard shortcuts. */
import { useEffect } from 'react';
import { useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { CROP_GUIDES, useUi } from '../state/uiStore';
import { swapCropAspect } from './geometryActions';
import { removePhotos, setFlag, setRating, toggleLabel } from '../library/actions';
import { COLOR_LABELS } from '../library/db';
import { openPhoto, openRelative } from '../library/open';
import { targetIds, useLibrary, visiblePhotos } from '../state/libraryStore';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

/** Focus is in a field that takes typed text (checkboxes, buttons and sliders don't count). */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  ((t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type)) || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

export function useKeyboard() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const ui = useUi.getState();
      if (mod && e.key.toLowerCase() === 'z') {
        if (isTyping(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) useEdit.getState().redo();
        else useEdit.getState().undo();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        if (isTyping(e.target) || !useImage.getState().image) return;
        e.preventDefault();
        ui.set({ snapshotDialog: true });
        return;
      }
      if (mod && e.shiftKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'v')) {
        if (isTyping(e.target) || !useImage.getState().image) return;
        e.preventDefault();
        ui.set({ copyPaste: e.key.toLowerCase() === 'c' ? 'copy' : 'paste' });
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); useEdit.getState().redo(); return; }
      if (mod && e.key === ',') { e.preventDefault(); ui.set({ settingsOpen: true }); return; }
      if (e.key === '?' && !isTyping(e.target)) { e.preventDefault(); ui.set({ shortcutsOpen: !ui.shortcutsOpen }); return; }
      const lib = useLibrary.getState();
      if (mod && e.key.toLowerCase() === 'a' && lib.view === 'library') {
        if (isTyping(e.target)) return;
        e.preventDefault();
        lib.selectAll();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        (document.querySelector('[data-import-files]') as HTMLButtonElement | null)?.click();
        return;
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (useImage.getState().image) ui.set({ exportOpen: true });
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        (document.querySelector('input[type=file]') as HTMLInputElement | null)?.click();
        return;
      }
      if (mod || isTyping(e.target)) return;
      // Library keys work in both views: the grid's selection, or the photo in the editor.
      if (!e.altKey && /^[0-5]$/.test(e.key) && lib.active) { void setRating(+e.key); return; }
      if (!e.altKey && /^[6-9]$/.test(e.key) && lib.active) { void toggleLabel(COLOR_LABELS[+e.key - 6]); return; }
      if ((e.key === 'p' || e.key === 'P') && lib.active) { void setFlag(1); return; }
      if ((e.key === 'u' || e.key === 'U') && lib.active) { void setFlag(0); return; }
      if ((e.key === 'x' || e.key === 'X') && !ui.cropMode && lib.active) { void setFlag(-1); return; }
      if (e.key === 'g' || e.key === 'G') { lib.set({ view: 'library' }); return; }
      if ((e.key === 'e' || e.key === 'E') && lib.view === 'library') {
        const id = lib.active ?? targetIds()[0];
        if (id) void openPhoto(id);
        return;
      }
      if (lib.view === 'library') {
        if (e.key === 'i' || e.key === 'I') lib.set({ infoOpen: !lib.infoOpen });
        else if (e.key === 'Delete' || e.key === 'Backspace') void removePhotos(targetIds());
        else if (e.key === 'Escape') lib.set({ selection: new Set() });
        return;
      }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !ui.cropMode && !ui.masksOpen) {
        e.preventDefault();
        openRelative(e.key === 'ArrowRight' ? 1 : -1, visiblePhotos(lib));
        return;
      }
      if (e.key === '\\') {
        if (!e.repeat) ui.set({ showBefore: true });
        e.preventDefault();
      } else if (e.key === 'v' || e.key === 'V') {
        if (useImage.getState().image) useEdit.getState().apply((r) => ({ ...r, treatment: r.treatment === 'monochrome' ? 'color' : 'monochrome', bwMixer: { ...r.bwMixer, enabled: true } }));
      } else if (e.key === 'j' || e.key === 'J') {
        ui.set({ clipOverlay: !ui.clipOverlay });
      } else if (e.key === 'w' || e.key === 'W') {
        if (useImage.getState().image) ui.set({ tool: ui.tool === 'wb' ? 'none' : 'wb' });
      } else if (e.key === 'r' || e.key === 'R') {
        if (useImage.getState().image) ui.set({ cropMode: !ui.cropMode, tool: 'none' });
      } else if ((e.key === 'x' || e.key === 'X') && ui.cropMode) {
        swapCropAspect();
      } else if ((e.key === 'o' || e.key === 'O') && ui.cropMode) {
        ui.set({ cropGuide: CROP_GUIDES[(CROP_GUIDES.indexOf(ui.cropGuide) + 1) % CROP_GUIDES.length] });
      } else if (e.key === 'o' || e.key === 'O') {
        ui.set({ maskOverlay: !ui.maskOverlay });
      } else if (e.key === 'm' || e.key === 'M') {
        if (useImage.getState().image) ui.set({ masksOpen: !ui.masksOpen, cropMode: false, tool: 'none', maskPick: false });
      } else if ((e.key === '[' || e.key === ']') && ui.masksOpen) {
        const k = e.key === ']' ? 1.15 : 1 / 1.15;
        ui.set({ brush: { ...ui.brush, size: Math.min(0.3, Math.max(0.001, ui.brush.size * k)) } });
      } else if (e.key === 'y' || e.key === 'Y') {
        if (useImage.getState().image) ui.set({ compareMode: ui.compareMode === 'off' ? 'split' : ui.compareMode === 'split' ? 'side' : 'off' });
      } else if (e.key === 'Enter' && ui.cropMode) {
        ui.set({ cropMode: false, tool: 'none' });
      } else if (e.key === 'Escape') {
        if (ui.exportOpen) ui.set({ exportOpen: false });
        else if (ui.previewRecipe) ui.set({ previewRecipe: null });
        else if (ui.tool !== 'none') ui.set({ tool: 'none' });
        else if (ui.cropMode) ui.set({ cropMode: false });
        else if (ui.compareMode !== 'off') ui.set({ compareMode: 'off' });
        else if (ui.maskPick) ui.set({ maskPick: false });
        else if (ui.masksOpen) ui.set({ masksOpen: false });
        else ui.set({ tool: 'none', visualizePointColor: false });
      } else if (e.key === 'z' || e.key === 'Z') {
        const img = useImage.getState().image;
        if (!img) return;
        if (ui.zoom === 'fit') ui.set({ zoom: 1, center: { x: img.width / 2, y: img.height / 2 } });
        else ui.set({ zoom: 'fit' });
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === '\\') useUi.getState().set({ showBefore: false });
    };
    const blur = () => useUi.getState().set({ showBefore: false });
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
}
