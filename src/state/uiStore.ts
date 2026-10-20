/** Transient UI state: view transform, tools, overlays, readouts. Never part of the recipe. */
import { create } from 'zustand';
import type { PresetGroup, Recipe } from '../recipe/schema';

export type Tool = 'none' | 'wb' | 'blackPoint' | 'whitePoint' | 'pointColor' | 'straighten' | 'guide';
export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';
export type CropGuide = 'thirds' | 'golden' | 'spiral' | 'diagonals' | 'grid' | 'triangles';
export const CROP_GUIDES: CropGuide[] = ['thirds', 'golden', 'spiral', 'diagonals', 'grid', 'triangles'];
export type CompareMode = 'off' | 'split' | 'side';

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
  clipboard: { groups: PresetGroup[]; recipe: Recipe } | null;
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
  set: (p) => set(p),
}));
