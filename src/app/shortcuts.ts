/**
 * Every keyboard shortcut, for the shortcuts overlay (?). The handlers live in keyboard.ts (and the
 * components named below); keep this list in step with them.
 */
export interface Shortcut {
  keys: string;
  action: string;
  group: string;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

export const SHORTCUTS: Shortcut[] = [
  { group: 'General', keys: '?', action: 'Show / hide this list' },
  { group: 'General', keys: 'G', action: 'Library grid' },
  { group: 'General', keys: 'E', action: 'Edit the selected photo' },
  { group: 'General', keys: `${MOD}+Shift+I`, action: 'Import photos' },
  { group: 'General', keys: `${MOD}+O`, action: 'Open a photo (imports it)' },
  { group: 'General', keys: `${MOD}+E`, action: 'Export the photo' },
  { group: 'General', keys: `${MOD}+,`, action: 'Settings' },
  { group: 'General', keys: 'Esc', action: 'Close a dialog / leave a tool' },
  { group: 'Library', keys: '0 – 5', action: 'Rating' },
  { group: 'Library', keys: 'P / X / U', action: 'Pick / reject / unflag' },
  { group: 'Library', keys: '6 / 7 / 8 / 9', action: 'Red / yellow / green / blue label' },
  { group: 'Library', keys: 'Arrows', action: 'Move the focus (Shift: extend the selection)' },
  { group: 'Library', keys: 'Enter', action: 'Open the focused photo' },
  { group: 'Library', keys: `${MOD}+A`, action: 'Select all' },
  { group: 'Library', keys: 'Click / Shift-click / ' + MOD + '-click', action: 'Select / range / add to the selection' },
  { group: 'Library', keys: 'I', action: 'Info panel' },
  { group: 'Library', keys: 'Delete', action: 'Remove from the library (asks first)' },
  { group: 'Editor', keys: '← / →', action: 'Previous / next photo' },
  { group: 'Editor', keys: `${MOD}+Z`, action: 'Undo' },
  { group: 'Editor', keys: `${MOD}+Shift+Z / ${MOD}+Y`, action: 'Redo' },
  { group: 'Editor', keys: '\\ (hold)', action: 'Before / after' },
  { group: 'Editor', keys: 'Y', action: 'Compare: split / side by side / off' },
  { group: 'Editor', keys: 'Z', action: 'Fit / 100 %' },
  { group: 'Editor', keys: 'V', action: 'Color / black & white' },
  { group: 'Editor', keys: 'J', action: 'Clipping overlay' },
  { group: 'Editor', keys: 'W', action: 'White-balance picker' },
  { group: 'Editor', keys: `${MOD}+Shift+C / V`, action: 'Copy / paste settings (to the selection)' },
  { group: 'Editor', keys: `${MOD}+Shift+S`, action: 'New snapshot' },
  { group: 'Crop', keys: 'R', action: 'Crop & straighten' },
  { group: 'Crop', keys: 'X', action: 'Swap the crop orientation' },
  { group: 'Crop', keys: 'O', action: 'Cycle crop guides' },
  { group: 'Crop', keys: 'Enter', action: 'Apply the crop' },
  { group: 'Masks', keys: 'M', action: 'Masks (local adjustments)' },
  { group: 'Masks', keys: 'O', action: 'Mask overlay' },
  { group: 'Masks', keys: '[ / ]', action: 'Brush size' },
  { group: 'Masks', keys: 'Alt (hold)', action: 'Erase while painting' },
  { group: 'Masks', keys: 'Space (hold)', action: 'Pan while a brush is active' },
  { group: 'Sliders', keys: '← / → (Shift ×10)', action: 'Adjust the focused slider' },
  { group: 'Sliders', keys: 'Double-click', action: 'Reset to default' },
  { group: 'Touch', keys: 'Pinch / two fingers', action: 'Zoom and pan' },
  { group: 'Touch', keys: 'Double-tap', action: 'Fit / 100 %' },
  { group: 'Touch', keys: 'Press and hold', action: 'Before / after' },
  { group: 'Touch', keys: 'Two-finger tap / three-finger tap', action: 'Undo / redo' },
  { group: 'Touch', keys: 'Swipe a slider row', action: 'Adjust; double-tap to reset' },
];
