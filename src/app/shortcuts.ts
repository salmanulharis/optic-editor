/**
 * Every keyboard shortcut, for the shortcuts overlay (?). The handlers live in keyboard.ts (and the
 * components named below); keep this list in step with them.
 */
import { t } from '../i18n';

export interface Shortcut {
  keys: string;
  action: string;
  group: string;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

export const SHORTCUTS: Shortcut[] = [
  { group: t('shortcuts.general'), keys: '?', action: t('shortcuts.show_hide_this_list') },
  { group: t('shortcuts.general'), keys: 'G', action: t('shortcuts.library_grid') },
  { group: t('shortcuts.general'), keys: 'E', action: t('shortcuts.edit_the_selected_photo') },
  { group: t('shortcuts.general'), keys: `${MOD}+Shift+I`, action: t('shortcuts.import_photos') },
  { group: t('shortcuts.general'), keys: `${MOD}+O`, action: t('shortcuts.open_a_photo_imports_it') },
  { group: t('shortcuts.general'), keys: `${MOD}+E`, action: t('shortcuts.export_the_photo') },
  { group: t('shortcuts.general'), keys: `${MOD}+,`, action: t('shortcuts.settings') },
  { group: t('shortcuts.general'), keys: t('shortcuts.esc'), action: t('shortcuts.close_a_dialog_leave_a_tool') },
  { group: t('shortcuts.library'), keys: '0 – 5', action: t('shortcuts.rating') },
  { group: t('shortcuts.library'), keys: 'P / X / U', action: t('shortcuts.pick_reject_unflag') },
  { group: t('shortcuts.library'), keys: '6 / 7 / 8 / 9', action: t('shortcuts.red_yellow_green_blue_label') },
  { group: t('shortcuts.library'), keys: t('shortcuts.arrows'), action: t('shortcuts.move_the_focus_shift_extend_the') },
  { group: t('shortcuts.library'), keys: t('shortcuts.enter'), action: t('shortcuts.open_the_focused_photo') },
  { group: t('shortcuts.library'), keys: `${MOD}+A`, action: t('shortcuts.select_all') },
  { group: t('shortcuts.library'), keys: t('shortcuts.click_shift_click') + MOD + '-click', action: t('shortcuts.select_range_add_to_the_selection') },
  { group: t('shortcuts.library'), keys: 'I', action: t('shortcuts.info_panel') },
  { group: t('shortcuts.library'), keys: t('shortcuts.delete'), action: t('shortcuts.remove_from_the_library_asks_first') },
  { group: t('shortcuts.editor'), keys: '← / →', action: t('shortcuts.previous_next_photo') },
  { group: t('shortcuts.editor'), keys: `${MOD}+Z`, action: t('shortcuts.undo') },
  { group: t('shortcuts.editor'), keys: `${MOD}+Shift+Z / ${MOD}+Y`, action: t('shortcuts.redo') },
  { group: t('shortcuts.editor'), keys: 'F', action: t('shortcuts.hide_show_the_side_panels') },
  { group: t('shortcuts.editor'), keys: t('shortcuts.keys.backslash_hold'), action: t('shortcuts.before_after') },
  { group: t('shortcuts.editor'), keys: 'Y', action: t('shortcuts.compare_split_side_by_side_off') },
  { group: t('shortcuts.editor'), keys: 'Z', action: t('shortcuts.fit_100') },
  { group: t('shortcuts.editor'), keys: 'V', action: t('shortcuts.color_black_white') },
  { group: t('shortcuts.editor'), keys: 'J', action: t('shortcuts.clipping_overlay') },
  { group: t('shortcuts.editor'), keys: 'W', action: t('shortcuts.white_balance_picker') },
  { group: t('shortcuts.editor'), keys: `${MOD}+Shift+C / V`, action: t('shortcuts.copy_paste_settings_to_the_selection') },
  { group: t('shortcuts.editor'), keys: `${MOD}+Shift+S`, action: t('shortcuts.new_snapshot') },
  { group: t('shortcuts.crop'), keys: 'R', action: t('shortcuts.crop_straighten') },
  { group: t('shortcuts.crop'), keys: 'X', action: t('shortcuts.swap_the_crop_orientation') },
  { group: t('shortcuts.crop'), keys: 'O', action: t('shortcuts.cycle_crop_guides') },
  { group: t('shortcuts.crop'), keys: t('shortcuts.enter'), action: t('shortcuts.apply_the_crop') },
  { group: t('shortcuts.masks'), keys: 'M', action: t('shortcuts.masks_local_adjustments') },
  { group: t('shortcuts.masks'), keys: 'O', action: t('shortcuts.mask_overlay') },
  { group: t('shortcuts.masks'), keys: '[ / ]', action: t('shortcuts.brush_size') },
  { group: t('shortcuts.masks'), keys: t('shortcuts.alt_hold'), action: t('shortcuts.erase_while_painting') },
  { group: t('shortcuts.masks'), keys: t('shortcuts.space_hold'), action: t('shortcuts.pan_while_a_brush_is_active') },
  { group: t('shortcuts.sliders'), keys: t('shortcuts.keys.arrows_shift'), action: t('shortcuts.adjust_the_focused_slider') },
  { group: t('shortcuts.sliders'), keys: t('shortcuts.double_click'), action: t('shortcuts.reset_to_default') },
  { group: t('shortcuts.touch'), keys: t('shortcuts.pinch_two_fingers'), action: t('shortcuts.zoom_and_pan') },
  { group: t('shortcuts.touch'), keys: t('shortcuts.double_tap'), action: t('shortcuts.fit_100') },
  { group: t('shortcuts.touch'), keys: t('shortcuts.press_and_hold'), action: t('shortcuts.before_after') },
  { group: t('shortcuts.touch'), keys: t('shortcuts.two_finger_tap_three_finger_tap'), action: t('shortcuts.undo_redo') },
  { group: t('shortcuts.touch'), keys: t('shortcuts.swipe_a_slider_row'), action: t('shortcuts.adjust_double_tap_to_reset') },
];
