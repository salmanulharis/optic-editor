/**
 * App settings (this device): default export preset, the starting detail settings for RAW and
 * non-RAW photos, preview quality, theme, motion, language, onboarding. Saved in localStorage.
 */
import { create } from 'zustand';
import { lsGet, lsSet } from '../storage/db';

export type Theme = 'dark' | 'darker' | 'light';
export type PreviewQuality = 'performance' | 'balanced' | 'quality';

export interface DetailDefaults {
  sharpen: number; // 0…150
  colorNr: number; // 0…100
  lumNr: number; // 0…100
  lensAuto: boolean;
}

export interface Settings {
  defaultExportPreset: string;
  raw: DetailDefaults;
  nonRaw: DetailDefaults;
  previewQuality: PreviewQuality;
  theme: Theme;
  reducedMotion: 'system' | 'on' | 'off';
  language: string;
  onboardingDone: boolean;
  /** Show the frame rate in the viewer. */
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultExportPreset: '',
  raw: { sharpen: 30, colorNr: 25, lumNr: 0, lensAuto: true },
  nonRaw: { sharpen: 0, colorNr: 0, lumNr: 0, lensAuto: false },
  previewQuality: 'balanced',
  theme: 'dark',
  reducedMotion: 'system',
  language: 'en',
  onboardingDone: false,
  showFps: true,
};

const KEY = 'optic.settings';

interface SettingsState extends Settings {
  set(p: Partial<Settings>): void;
  reset(): void;
}

const load = (): Settings => {
  const s = lsGet<Partial<Settings>>(KEY, {});
  return { ...DEFAULT_SETTINGS, ...s, raw: { ...DEFAULT_SETTINGS.raw, ...(s.raw ?? {}) }, nonRaw: { ...DEFAULT_SETTINGS.nonRaw, ...(s.nonRaw ?? {}) } };
};

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  set(p) {
    set(p);
    const { set: _s, reset: _r, ...data } = get();
    lsSet(KEY, data);
  },
  reset() {
    set({ ...DEFAULT_SETTINGS, onboardingDone: true });
    lsSet(KEY, { ...DEFAULT_SETTINGS, onboardingDone: true });
  },
}));
