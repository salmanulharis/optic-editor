/** Global keyboard shortcuts. */
import { useEffect } from 'react';
import { useEdit } from '../state/editStore';
import { useImage } from '../state/imageStore';
import { CROP_GUIDES, useUi } from '../state/uiStore';
import { swapCropAspect } from './geometryActions';

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
