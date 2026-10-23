/** Transient UI state: view transform, tools, overlays, readouts. Never part of the recipe. */
import { create } from 'zustand';
import type { PresetGroup, Recipe } from '../recipe/schema';

export type Tool = 'none' | 'wb' | 'blackPoint' | 'whitePoint' | 'pointColor' | 'straighten' | 'guide';
export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';
export type CropGuide = 'thirds' | 'golden' | 'spiral' | 'diagonals' | 'grid' | 'triangles';
export const CROP_GUIDES: CropGuide[] = ['thirds', 'golden', 'spiral', 'diagonals', 'grid', 'triangles'];
export type CompareMode = 'off' | 'split' | 'side';

/** Brush settings (shared by all brush components; each stroke stores its own copy). */
export interface BrushSettings {
  /** Radius as a fraction of the long edge. */
  size: number;
  feather: number;
  flow: number;
  density: number;
  autoMask: boolean;
  erase: boolean;
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  clipHigh: number; // fraction of pixels with any channel clipped high
  clipLow: number;
}

export interface PixelReadout {
  x: number;
  y: number;
  rgb: [number, number, number]; // encoded 0..1
}

interface UiState {
  /** 'fit' or device pixels per image pixel. */
  zoom: 'fit' | number;
  /** Image-pixel coordinate at the viewport centre (used when zoom !== 'fit'). */
  center: { x: number; y: number };
  fitScale: number;
  showBefore: boolean;
  clipOverlay: boolean;
  tool: Tool;
  curveChannel: CurveChannel;
  exportOpen: boolean;
  /** Batch export dialog (the selection). */
  batchExportOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  histogram: Histogram | null;
  readout: PixelReadout | null;
  fps: number;
  canvasP3: boolean;
  /** Recipe shown instead of the edit while hovering a preset (never committed). */
  previewRecipe: Recipe | null;
  /** Point-colour "visualize range" mask view. */
  visualizePointColor: boolean;
  /** A pointer is held down (slider drag, pan…): background work such as thumbnails pauses. */
  dragging: boolean;
  presetView: 'grid' | 'list';
  gradingLayout: '3up' | '1up';
  createPresetOpen: boolean;
  copyPaste: null | 'copy' | 'paste';
  clipboard: { groups: PresetGroup[]; recipe: Recipe; isRaw?: boolean } | null;
  /** Bumped when a background analysis (noise, lens profile, CA) changes the render inputs. */
  analysisTick: number;
  leftTab: 'presets' | 'history';
  /** Crop & straighten tool open (key R): the canvas shows the whole frame with the crop overlay. */
  cropMode: boolean;
  cropGuide: CropGuide;
  /** Compare view (key Y cycles) and what the "Before" side shows. */
  compareMode: CompareMode;
  /** 'original' | 'session' | 'snap:<id>' | 'step:<index>' | 'copy:<id>'. */
  compareSource: string;
  compareSplit: number;
  compareVertical: boolean;
  compareSwap: boolean;
  /** Black-and-white detail mask while Alt-dragging a masking slider. */
  maskView: null | 'sharpen';
  /** Alignment grid over the image while a geometry slider is dragged. */
  geometryGrid: boolean;
  gridDensity: number;
  snapshotDialog: boolean;
  /** A Detail-panel control is being used (hint: zoom to 100 % to judge). */
  detailFocus: boolean;
  /** The view of the last rendered frame (overlays draw with exactly this). */
  view: { scale: number; cx: number; cy: number; areaW: number } | null;
  /** Masking mode (key M): the masks panel and on-canvas mask handles. */
  masksOpen: boolean;
  selectedMask: string | null;
  selectedComp: string | null;
  /** Mask overlay (key O) and its look. */
  maskOverlay: boolean;
  maskOverlayMode: 'color' | 'bw';
  maskOverlayColor: [number, number, number];
  maskOverlayOpacity: number;
  /** Overlay shown temporarily (while painting or dragging a mask handle). */
  maskOverlayTemp: boolean;
  brush: BrushSettings;
  /** Eyedropper for the selected colour-range component. */
  maskPick: boolean;
  set(p: Partial<UiState>): void;
}

export const useUi = create<UiState>((set) => ({
  zoom: 'fit',
  center: { x: 0, y: 0 },
  fitScale: 1,
  showBefore: false,
  clipOverlay: false,
  tool: 'none',
  curveChannel: 'rgb',
  exportOpen: false,
  batchExportOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  histogram: null,
  readout: null,
  fps: 0,
  canvasP3: false,
  previewRecipe: null,
  visualizePointColor: false,
  dragging: false,
  presetView: 'grid',
  gradingLayout: '3up',
  createPresetOpen: false,
  copyPaste: null,
  clipboard: null,
  analysisTick: 0,
  leftTab: 'presets',
  cropMode: false,
  cropGuide: 'thirds',
  compareMode: 'off',
  compareSource: 'original',
  compareSplit: 0.5,
  compareVertical: true,
  compareSwap: false,
  maskView: null,
  geometryGrid: false,
  gridDensity: 8,
  snapshotDialog: false,
  detailFocus: false,
  view: null,
  masksOpen: false,
  selectedMask: null,
  selectedComp: null,
  maskOverlay: false,
  maskOverlayMode: 'color',
  maskOverlayColor: [1, 0.15, 0.15],
  maskOverlayOpacity: 0.5,
  maskOverlayTemp: false,
  brush: { size: 0.03, feather: 50, flow: 100, density: 100, autoMask: false, erase: false },
  maskPick: false,
  set: (p) => set(p),
}));
