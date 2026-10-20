import type { PresetGroup } from '../recipe/schema';

/**
 * Preset file format (JSON, version 3; version 2 files load unchanged). See docs/PRESETS.md.
 * `settings` and `nonRaw` are partial recipes in the recipe's JSON shape; only the groups listed
 * in `includes` are read from them.
 */
export interface Preset {
  id: string;
  name: string;
  group: string;
  version: 2 | 3;
  description?: string;
  tags?: string[];
  includes: PresetGroup[];
  settings: Record<string, unknown>;
  /** Explicit overrides for non-RAW photos (applied after the automatic non-RAW scaling). */
  nonRaw?: Record<string, unknown>;
  /** Id of a LUT to apply (bundled or from "My LUTs"). */
  lut?: string;
  /** Runtime only: true for presets shipped with the app (read-only). */
  builtin?: boolean;
}

export const BUILTIN_GROUP_ORDER = [
  'Hasselblad-inspired',
  'Leica-inspired',
  'Zeiss-inspired',
  'Film',
  'Black & White',
  'Cinematic',
];
