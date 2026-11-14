/**
 * Size limits for Lightroom preset files. In a module of their own so the preset store can check
 * zip entries before inflating them without loading the converter.
 */

/** Presets are a few kB; anything bigger is not a preset. */
export const MAX_PRESET_BYTES = 2 * 1024 * 1024;
/** Lightroom Mobile "DNG presets" are whole photos. */
export const MAX_DNG_BYTES = 200 * 1024 * 1024;

export const isDng = (name: string) => /\.dng$/i.test(name);
export const lightroomLimit = (name: string) => (isDng(name) ? MAX_DNG_BYTES : MAX_PRESET_BYTES);
