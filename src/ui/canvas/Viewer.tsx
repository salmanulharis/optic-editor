/**
 * The image viewer. Rendering is driven by store subscriptions + requestAnimationFrame (no React
 * re-render per slider tick, no debounce): any recipe/view change marks the frame dirty and the
 * next animation frame renders it.
 *
 * While a pointer is held (slider drag) and expensive spatial effects are on, frames render at half
 * resolution with half-density maps; ~150 ms after release the view is refined to full quality.
 * Compare views render the "Before" recipe beside (side by side) or under (split) the edit.
 * All coordinates are output pixels of the displayed recipe (the cropped, transformed image; in
 * the crop tool, the whole straightened frame).
 */
import { useEffect, useRef, useState } from 'react';
import { pointFromPixel, setRenderer, whiteBalanceFromPixel } from '../../app/actions';
import { addColorPointAt } from '../../app/presetActions';
import { computeGeo } from '../../geometry/transform';
import { effectiveRecipe, type Recipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { CropOverlay } from './CropOverlay';
import { beforeRecipe, displayedRecipe } from './displayed';
import { CompareOverlay, GridOverlay, GuidesOverlay, LineToolOverlay } from './Overlays';
import { type ViewBox, toImage, viewFor } from './viewMath';
import { type ViewState, ViewRenderer } from './viewRenderer';

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;
const REFINE_MS = 150;

/** Effects whose cost justifies half-resolution frames while dragging. */
function heavy(r: Recipe) {
  const e = r.effects, d = r.detail;
  return d.nr.lum > 0 || d.nr.color > 0 || e.texture !== 0 || e.clarity !== 0 || e.dehaze !== 0 || e.halation.amount > 0 || e.bloom.amount > 0 || r.look.microContrast > 0;
}

export function Viewer() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewRenderer | null>(null);
  const dirty = useRef(true);
  const [glError, setGlError] = useState<string | null>(null);
  const [box, setBox] = useState<ViewBox>({ W: 1, H: 1, dpr: 1 });
  const image = useImage((s) => s.image);
  const tool = useUi((s) => s.tool);
  const readout = useUi((s) => s.readout);
  const fps = useUi((s) => s.fps);
  const cropMode = useUi((s) => s.cropMode);
  const compareMode = useUi((s) => s.compareMode);
  const zoom = useUi((s) => s.zoom);
  const nrOrSharpen = useEdit((s) => s.recipe.detail.enabled && (s.recipe.detail.nr.lum > 0 || s.recipe.detail.nr.color > 0 || s.recipe.detail.sharpen.amount > 0));
  const detailDrag = useUi((s) => s.dragging && s.detailFocus);

  // ---- view helpers --------------------------------------------------------
  const boxNow = (): ViewBox => {
    const c = canvasRef.current!;
    return { W: c.width, H: c.height, dpr: c.width / Math.max(1, c.getBoundingClientRect().width) };
  };
  const side = () => useUi.getState().compareMode === 'side' && !useUi.getState().cropMode;
  const lastCropFit = useRef<number | null>(null);

  const computeView = (): (ReturnType<typeof viewFor> & { recipe: Recipe }) | null => {
    const img = useImage.getState().image;
    const canvas = canvasRef.current;
    if (!img || !canvas) return null;
    const ui = useUi.getState();
    const { recipe } = displayedRecipe(img);
    const g = computeGeo(img.model, recipe);
    const r = viewFor(boxNow(), { width: g.outW, height: g.outH }, ui.zoom, ui.center, side());
    // In the crop tool the frame grows and shrinks with the angle: keep the zoom steady while dragging.
    if (ui.cropMode && ui.zoom === 'fit') {
      if (ui.dragging && lastCropFit.current) r.v.scale = r.fit = lastCropFit.current;
      else lastCropFit.current = r.fit;
    }
    if (ui.fitScale !== r.fit) useUi.setState({ fitScale: r.fit });
    return { ...r, recipe };
  };

  /** Client (CSS px) → output pixel, and which half (side by side). */
  const pointerToImage = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const vv = computeView();
    if (!vv) return null;
    const rect = canvas.getBoundingClientRect();
    const b = boxNow();
    let cssX = clientX - rect.left;
    const half = vv.areaW / b.dpr;
    if (side() && cssX > rect.width - half) cssX -= rect.width - half;
    const [x, y] = toImage(vv.v, b, vv.areaW, cssX, clientY - rect.top);
    return { x, y, v: vv.v };
  };

  const setZoomAt = (scale: number, clientX?: number, clientY?: number) => {
    const vv = computeView();
    if (!vv) return;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const b = boxNow();
    const localX = clientX === undefined ? vv.areaW / 2 / b.dpr : (clientX - r.left) - (side() && clientX - r.left > r.width - vv.areaW / b.dpr ? r.width - vv.areaW / b.dpr : 0);
    const ax = localX * b.dpr - vv.areaW / 2;
    const ay = clientY === undefined ? 0 : (clientY - r.top) * b.dpr - b.H / 2;
    const ix = vv.v.cx + ax / vv.v.scale, iy = vv.v.cy + ay / vv.v.scale;
    useUi.getState().set({ zoom: scale, center: { x: ix - ax / scale, y: iy - ay / scale } });
  };

  // ---- GL setup & render loop ------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    let renderer: ViewRenderer;
    try {
      renderer = new ViewRenderer(canvas);
    } catch (e) {
      setGlError((e as Error).message);
      return;
    }
    rendererRef.current = renderer;
    setRenderer(renderer);
    useUi.getState().set({ canvasP3: renderer.caps.p3 });

    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        dirty.current = true;
      }
      setBox({ W: w, H: h, dpr });
    });
    ro.observe(canvas);

    const markDirty = () => { dirty.current = true; };
    let refineTimer = 0;
    let wasDraft = false;
    const unsubs = [
      useEdit.subscribe((s, p) => (s.recipe !== p.recipe || s.copies !== p.copies) && markDirty()),
      useUi.subscribe((s, p) => {
        if (s.zoom !== p.zoom || s.center !== p.center || s.showBefore !== p.showBefore || s.clipOverlay !== p.clipOverlay ||
          s.previewRecipe !== p.previewRecipe || s.visualizePointColor !== p.visualizePointColor || s.analysisTick !== p.analysisTick ||
          s.cropMode !== p.cropMode || s.compareMode !== p.compareMode || s.compareSource !== p.compareSource ||
          s.compareSplit !== p.compareSplit || s.compareVertical !== p.compareVertical || s.compareSwap !== p.compareSwap || s.maskView !== p.maskView) markDirty();
        // Drag ended: refine the half-resolution preview shortly after.
        if (p.dragging && !s.dragging && wasDraft) {
          window.clearTimeout(refineTimer);
          refineTimer = window.setTimeout(markDirty, REFINE_MS);
        }
      }),
    ];

    let raf = 0;
    let lastHist = 0;
    let histPending = false;
    let frames = 0;
    let compileWaitStart = 0;
    let fpsWindow = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const img = useImage.getState().image;
      if (dirty.current && renderer) {
        const ui = useUi.getState();
        const vv = computeView();
        const shown = img ? displayedRecipe(img) : null;
        const recipe = shown?.recipe ?? null;
        const visualize = !!shown?.visualize;
        const compare = img && ui.compareMode !== 'off' && !ui.cropMode && !ui.showBefore
          ? { mode: ui.compareMode as 'split' | 'side', before: beforeRecipe(img).recipe, pos: ui.compareSplit, vertical: ui.compareVertical, swap: ui.compareSwap }
          : null;
        const frame = recipe ? { recipe, overlay: ui.clipOverlay, visualize, maskView: shown?.maskView, compare } : null;
        // Never block a frame on the shader compiler: keep showing the previous frame
        // (for at most ~1 s) until the needed program variant has finished compiling.
        if (frame && !renderer.canRender(frame) && now - compileWaitStart < 1000) {
          if (!compileWaitStart) compileWaitStart = now;
          return;
        }
        compileWaitStart = 0;
        dirty.current = false;
        if (vv) {
          const pv = ui.view;
          if (!pv || pv.scale !== vv.v.scale || pv.cx !== vv.v.cx || pv.cy !== vv.v.cy || pv.areaW !== vv.areaW) {
            useUi.setState({ view: { ...vv.v, areaW: vv.areaW } });
          }
        }
        if (vv && frame && renderer.ready) {
          const draft = ui.dragging && !compare && heavy(recipe!);
          wasDraft = draft;
          renderer.render({ ...frame, view: vv.v, draft }, markDirty);
          histPending = !draft;
          frames++;
        } else renderer.render({ recipe: useEdit.getState().recipe, view: { scale: 1, cx: 0, cy: 0 }, overlay: false }, markDirty);
      }
      // Histogram: a 256 px render + readback, at most ~12×/s while editing.
      if (histPending && now - lastHist > 80 && img && renderer.ready) {
        histPending = false;
        lastHist = now;
        if (!renderer.startHistogram(effectiveRecipe(useEdit.getState().recipe, img.asShot))) histPending = true;
      }
      const hist = renderer.pollHistogram();
      if (hist) useUi.getState().set({ histogram: hist });
      if (now - fpsWindow > 1000) {
        useUi.getState().set({ fps: frames > 1 ? Math.round((frames * 1000) / (now - fpsWindow)) : 0 });
        frames = 0;
        fpsWindow = now;
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(refineTimer);
      ro.disconnect();
      unsubs.forEach((u) => u());
      setRenderer(null);
      renderer.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload the proxy when a new image arrives. Shader compiles for the common pipeline variants
  // are started first, so they run in parallel with the (multi-frame) upload.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    useUi.getState().set({ zoom: 'fit', readout: null, histogram: null, cropMode: false, compareMode: 'off', compareSource: 'original' });
    if (image) {
      const base = effectiveRecipe(useEdit.getState().recipe, image.asShot);
      const lit = { ...base, light: { ...base.light, exposure: base.light.exposure + 0.01 } };
      const all = { ...lit, presence: { ...lit.presence, saturation: 1 }, hsl: { ...lit.hsl, bands: { ...lit.hsl.bands, red: { hue: 0, sat: 1, lum: 0 } } } };
      r.pipeline.prefetch(
        {
          source: { tex: null as unknown as WebGLTexture, region: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, mipmapped: true, linear: true },
          image: image.model,
          target: r.previewTarget(base, false),
        },
        [base, lit, all],
      );
    }
    void r.setImage(image).then(() => { dirty.current = true; });
  }, [image]);

  // A new crop or transform changes the output size: go back to Fit.
  useEffect(() => useEdit.subscribe((s, p) => {
    const a = s.recipe, b = p.recipe;
    if (a.crop !== b.crop && !useUi.getState().cropMode && useUi.getState().zoom !== 'fit') {
      const c1 = a.crop, c2 = b.crop;
      if (c1.w !== c2.w || c1.h !== c2.h || c1.rotate90 !== c2.rotate90) useUi.getState().set({ zoom: 'fit' });
    }
  }), []);

  // ---- interaction --------------------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    let panStart: { x: number; y: number; cx: number; cy: number } | null = null;
    let pinchStart: { dist: number; scale: number; mx: number; my: number } | null = null;
    let moved = false;
    let readoutRaf = 0;

    const onWheel = (e: WheelEvent) => {
      if (!useImage.getState().image) return;
      e.preventDefault();
      const vv = computeView();
      if (!vv) return;
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const k = e.ctrlKey ? 0.01 : 0.0018;
      setZoomAt(vv.v.scale * Math.exp(-e.deltaY * k), e.clientX, e.clientY);
    };

    const onDown = (e: PointerEvent) => {
      if (!useImage.getState().image) return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      const vv = computeView();
      if (!vv) return;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: vv.v.scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        panStart = null;
      } else if (useUi.getState().tool === 'none') {
        panStart = { x: e.clientX, y: e.clientY, cx: vv.v.cx, cy: vv.v.cy };
        if (useUi.getState().zoom === 'fit') useUi.getState().set({ zoom: vv.v.scale, center: { x: vv.v.cx, y: vv.v.cy } });
      }
    };

    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchStart && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        setZoomAt((pinchStart.scale * d) / pinchStart.dist, pinchStart.mx, pinchStart.my);
        moved = true;
        return;
      }
      if (panStart) {
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const scale = useUi.getState().zoom as number;
        const dx = (e.clientX - panStart.x) * dpr, dy = (e.clientY - panStart.y) * dpr;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        useUi.getState().set({ center: { x: panStart.cx - dx / scale, y: panStart.cy - dy / scale } });
      }
      // Pixel readout (once per frame).
      const cx = e.clientX, cy = e.clientY;
      cancelAnimationFrame(readoutRaf);
      readoutRaf = requestAnimationFrame(() => {
        const img = useImage.getState().image;
        const r = rendererRef.current;
        const p = pointerToImage(cx, cy);
        if (!img || !r || !p) return;
        const { recipe } = displayedRecipe(img);
        const out = r.outputSize(recipe);
        if (p.x < 0 || p.y < 0 || p.x >= out.width || p.y >= out.height) {
          if (useUi.getState().readout) useUi.getState().set({ readout: null });
          return;
        }
        const px = r.readPixel(recipe, p.x, p.y, { ...r.previewTarget(recipe, false), dither: false, displaySpace: undefined });
        if (px) useUi.getState().set({ readout: { x: Math.floor(p.x), y: Math.floor(p.y), rgb: [px[0], px[1], px[2]] } });
      });
    };

    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      const wasPan = !!panStart;
      panStart = null;
      const tool = useUi.getState().tool;
      if (!moved && tool !== 'none' && tool !== 'straighten' && tool !== 'guide' && !wasPan) {
        const p = pointerToImage(e.clientX, e.clientY);
        const img = useImage.getState().image;
        const r = rendererRef.current;
        if (p && img && r) {
          const out = r.outputSize(displayedRecipe(img).recipe);
          if (p.x >= 0 && p.y >= 0 && p.x < out.width && p.y < out.height) {
            if (tool === 'wb') whiteBalanceFromPixel(p.x, p.y);
            else if (tool === 'pointColor') addColorPointAt(p.x, p.y);
            else pointFromPixel(tool, p.x, p.y);
            useUi.getState().set({ tool: 'none' });
          }
        }
      }
    };

    const onLeave = () => useUi.getState().set({ readout: null });

    wrap.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    // Safari trackpad pinch
    const onGesture = (e: Event) => e.preventDefault();
    canvas.addEventListener('gesturestart', onGesture);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('gesturestart', onGesture);
      cancelAnimationFrame(readoutRaf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cursor = tool !== 'none' ? 'crosshair' : image ? 'grab' : 'default';
  const toolHint: Record<string, string> = {
    wb: 'Click a neutral grey or white area',
    blackPoint: 'Click the darkest point',
    whitePoint: 'Click the brightest point',
    pointColor: 'Click the colour to adjust',
    straighten: 'Drag along a line that should be level (or vertical)',
    guide: 'Drag along a line that should be vertical or horizontal (2–4 lines)',
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-app">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" style={{ cursor }} />
      {glError && (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-ink-dim">
          WebGL2 with float render targets is required. {glError}
        </div>
      )}
      {image && !cropMode && <GridOverlay box={box} />}
      {image && !cropMode && <GuidesOverlay box={box} />}
      {image && cropMode && <CropOverlay box={box} />}
      {image && (tool === 'straighten' || tool === 'guide') && <LineToolOverlay box={box} />}
      {image && compareMode !== 'off' && !cropMode && <CompareOverlay box={box} />}
      {image && detailDrag && nrOrSharpen && zoom === 'fit' && (
        <div className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-xs text-ink">
          Zoom to 100% to judge sharpening and noise
        </div>
      )}
      {image && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex gap-3 rounded bg-black/50 px-2 py-1 text-[11px] tabular-nums text-ink-dim">
          {readout ? (
            <>
              <span>{readout.x}, {readout.y}</span>
              <span>
                R {Math.round(readout.rgb[0] * 255)} G {Math.round(readout.rgb[1] * 255)} B {Math.round(readout.rgb[2] * 255)}
              </span>
              <span>
                {readout.rgb[0].toFixed(3)} {readout.rgb[1].toFixed(3)} {readout.rgb[2].toFixed(3)}
              </span>
            </>
          ) : (
            <span>{fps ? `${fps} fps` : ' '}</span>
          )}
        </div>
      )}
      {tool !== 'none' && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-xs text-ink">
          {toolHint[tool]} · Esc to cancel
        </div>
      )}
    </div>
  );
}

export type { ViewState };
