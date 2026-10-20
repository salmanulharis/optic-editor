/**
 * Built-in presets: every JSON file under this folder (one preset per file, grouped in
 * sub-folders). Bundled at build time; read-only at runtime (duplicate to edit).
 */
import type { Preset } from '../types';
import { BUILTIN_GROUP_ORDER } from '../types';

const files = import.meta.glob('./**/*.json', { eager: true, import: 'default' }) as Record<string, Preset>;

export const BUILTIN_PRESETS: Preset[] = Object.entries(files)
  .map(([path, p]) => ({ ...p, builtin: true, _order: path }))
  .sort((a, b) => {
    const ga = BUILTIN_GROUP_ORDER.indexOf(a.group), gb = BUILTIN_GROUP_ORDER.indexOf(b.group);
    return ga - gb || a._order.localeCompare(b._order);
  })
  .map(({ _order: _o, ...p }) => p);

/** LUTs shipped in /public/luts, loaded on startup. */
export const BUNDLED_LUTS = [
  { id: 'optic-warm-film-33', name: 'Optic Warm Film (sample, 33)', url: '/luts/optic-warm-film-33.cube' },
  { id: 'optic-teal-orange-33', name: 'Optic Teal/Orange (sample, 33)', url: '/luts/optic-teal-orange-33.cube' },
];
