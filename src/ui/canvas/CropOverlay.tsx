/**
 * Crop & straighten overlay (crop tool, key R). The canvas shows the whole straightened frame; the
 * crop rectangle is drawn on top in the same coordinates:
 *  - drag inside to move, drag a handle to resize (aspect kept unless Freeform),
 *  - drag outside the rectangle to rotate (straighten),
 *  - the rectangle never leaves the image (moves and resizes stop at the edge, rotation shrinks it),
 *  - composition guides inside (O cycles), and the output size in pixels below.
 */
import { useRef } from 'react';
import { aspectLabel, setStraighten } from '../../app/geometryActions';
import { cropInside } from '../../geometry/mapping';
import { aspectValue, computeGeo, cropToolFrame } from '../../geometry/transform';
import type { Recipe } from '../../recipe/schema';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { type CropGuide, useUi } from '../../state/uiStore';
import { type ViewBox, toScreen } from './viewMath';

type Drag =
  | { kind: 'move'; x: number; y: number; start: Recipe['crop'] }
  | { kind: 'resize'; hx: number; hy: number; x: number; y: number; start: Recipe['crop'] }
  | { kind: 'rotate'; a0: number; angle0: number; cx: number; cy: number };

const PHI = 0.6180339887;

function guideLines(g: CropGuide, x: number, y: number, w: number, h: number): string {
  const L = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1}L${x2},${y2}`;
  const at = (fx: number[], fy: number[]) => [...fx.map((f) => L(x + w * f, y, x + w * f, y + h)), ...fy.map((f) => L(x, y + h * f, x + w, y + h * f))].join('');
  switch (g) {
    case 'thirds': return at([1 / 3, 2 / 3], [1 / 3, 2 / 3]);
    case 'golden': return at([1 - PHI, PHI], [1 - PHI, PHI]);
    case 'grid': return at([...Array(7)].map((_, i) => (i + 1) / 8), [...Array(7)].map((_, i) => (i + 1) / 8));
    case 'diagonals': {
      const m = Math.min(w, h);
      return [L(x, y, x + m, y + m), L(x + w, y, x + w - m, y + m), L(x, y + h, x + m, y + h - m), L(x + w, y + h, x + w - m, y + h - m)].join('');
    }
    case 'triangles': {
      // Diagonal plus the perpendiculars from the two other corners.
      const d2 = w * w + h * h;
      const foot = (px: number, py: number) => { const t = (px * w + py * h) / d2; return [x + w * t, y + h * t]; };
      const [ax, ay] = foot(w, 0), [bx, by] = foot(0, h);
      return [L(x, y, x + w, y + h), L(x + w, y, ax, ay), L(x, y + h, bx, by)].join('');
    }
    case 'spiral': {
      // Golden spiral: quarter arcs in successively smaller golden rectangles.
      let rx = x, ry = y, rw = w, rh = h, d = '';
      for (let i = 0; i < 9; i++) {
        const k = i % 4;
        if (rw >= rh) {
          const s = rh;
          if (k === 0) { d += `M${rx + s},${ry + s}A${s},${s} 0 0 1 ${rx},${ry}`; rx += s; rw -= s; }
          else { d += `M${rx + rw - s},${ry}A${s},${s} 0 0 1 ${rx + rw},${ry + s}`; rw -= s; }
        } else {
          const s = rw;
          if (k === 1) { d += `M${rx},${ry}A${s},${s} 0 0 1 ${rx + s},${ry + s}`; ry += s; rh -= s; }
          else { d += `M${rx + s},${ry + rh}A${s},${s} 0 0 1 ${rx},${ry + rh - s}`; rh -= s; }
        }
        if (rw < 2 || rh < 2) break;
      }
      return d;
    }
  }
}

export function CropOverlay({ box }: { box: ViewBox }) {
  const view = useUi((s) => s.view);
  const guide = useUi((s) => s.cropGuide);
  const recipe = useEdit((s) => s.recipe);
  const img = useImage((s) => s.image);
  const drag = useRef<Drag | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  if (!view || !img) return null;
  const crop = recipe.crop;
  const frame = cropToolFrame(img.model, recipe);
  const g = computeGeo(img.model, { geometry: recipe.geometry, crop: frame });
  const { Wr, Hr } = g;
  // R-normalised → CSS.
  const css = (nx: number, ny: number) => toScreen(view, box, view.areaW, (nx - frame.x) * Wr, (ny - frame.y) * Hr);
  const [x0, y0] = css(crop.x, crop.y);
  const [x1, y1] = css(crop.x + crop.w, crop.y + crop.h);
  const w = x1 - x0, h = y1 - y0;
  const cssToNorm = (dx: number, dy: number) => [(dx * box.dpr) / view.scale / Wr, (dy * box.dpr) / view.scale / Hr];
  const aspect = aspectValue(crop.aspect, img.model);

  const local = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };

  /** Largest fraction t ∈ [0, 1] of the way from `a` to `b` that keeps the crop inside the image. */
  const limit = (a: Recipe['crop'], b: Recipe['crop']) => {
    const r = useEdit.getState().recipe;
    if (cropInside(img.model, r, b)) return b;
    const mixC = (t: number) => ({ ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (cropInside(img.model, r, mixC(m))) lo = m; else hi = m; }
    return mixC(lo);
  };

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const [px, py] = local(e);
    const near = (a: number, b: number) => Math.abs(a - b) < 10;
    const hx = near(px, x0) ? -1 : near(px, x1) ? 1 : 0;
    const hy = near(py, y0) ? -1 : near(py, y1) ? 1 : 0;
    const inside = px > x0 && px < x1 && py > y0 && py < y1;
    const onEdgeX = py > y0 - 10 && py < y1 + 10, onEdgeY = px > x0 - 10 && px < x1 + 10;
    if ((hx && onEdgeX) || (hy && onEdgeY)) drag.current = { kind: 'resize', hx: onEdgeX ? hx : 0, hy: onEdgeY ? hy : 0, x: px, y: py, start: crop };
    else if (inside) drag.current = { kind: 'move', x: px, y: py, start: crop };
    else {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      drag.current = { kind: 'rotate', a0: Math.atan2(py - cy, px - cx), angle0: crop.angle, cx, cy };
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [px, py] = local(e);
    if (d.kind === 'rotate') {
      let da = ((Math.atan2(py - d.cy, px - d.cx) - d.a0) * 180) / Math.PI;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      setStraighten(d.angle0 + da);
      return;
    }
    const [dx, dy] = cssToNorm(px - d.x, py - d.y);
    const s = d.start;
    let next: Recipe['crop'];
    if (d.kind === 'move') next = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
      if (d.hx < 0) l += dx; if (d.hx > 0) r += dx;
      if (d.hy < 0) t += dy; if (d.hy > 0) b += dy;
      const min = 24 / ((view.scale / box.dpr) * Math.max(Wr, Hr));
      if (r - l < min) { if (d.hx < 0) l = r - min; else r = l + min; }
      if (b - t < min) { if (d.hy < 0) t = b - min; else b = t + min; }
      if (aspect) {
        // Keep the aspect (in pixels): the dragged dimension leads; edges grow about the centre.
        const wPx = (r - l) * Wr, hPx = (b - t) * Hr;
        if (d.hx && d.hy) {
          const useW = Math.abs(dx * Wr) >= Math.abs(dy * Hr);
          if (useW) { const nh = wPx / aspect / Hr; if (d.hy < 0) t = b - nh; else b = t + nh; }
          else { const nw = (hPx * aspect) / Wr; if (d.hx < 0) l = r - nw; else r = l + nw; }
        } else if (d.hx) {
          const nh = wPx / aspect / Hr, cy = (s.y + s.y + s.h) / 2;
          t = cy - nh / 2; b = cy + nh / 2;
        } else {
          const nw = (hPx * aspect) / Wr, cx = (s.x + s.x + s.w) / 2;
          l = cx - nw / 2; r = cx + nw / 2;
        }
      }
      next = { ...s, x: l, y: t, w: r - l, h: b - t };
    }
    useEdit.getState().update((rc) => ({ ...rc, crop: limit(s, next) }));
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'rotate') setStraighten(useEdit.getState().recipe.crop.angle, true);
    else useEdit.getState().commit(`Crop ${aspectLabel(useEdit.getState().recipe.crop.aspect)}`);
  };

  const W = box.W / box.dpr, H = box.H / box.dpr;
  const size = (() => {
    const og = computeGeo(img.model, recipe);
    return `${og.outW} × ${og.outH} · ${((og.outW * og.outH) / 1e6).toFixed(1)} MP`;
  })();
  const handles: Array<[number, number]> = [[x0, y0], [(x0 + x1) / 2, y0], [x1, y0], [x1, (y0 + y1) / 2], [x1, y1], [(x0 + x1) / 2, y1], [x0, y1], [x0, (y0 + y1) / 2]];
  return (
    <svg ref={svg} className="absolute inset-0 h-full w-full touch-none select-none" style={{ cursor: 'move' }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <path d={`M0,0H${W}V${H}H0Z M${x0},${y0}V${y1}H${x1}V${y0}Z`} fill="rgba(0,0,0,0.6)" fillRule="evenodd" style={{ cursor: 'grab' }} />
      <path d={guideLines(guide, x0, y0, w, h)} stroke="rgba(255,255,255,0.55)" strokeWidth={0.75} fill="none" pointerEvents="none" />
      <rect x={x0} y={y0} width={w} height={h} fill="none" stroke="white" strokeWidth={1} pointerEvents="none" />
      {handles.map(([hx, hy], i) => (
        <rect key={i} x={hx - 4} y={hy - 4} width={8} height={8} fill="white" stroke="black" strokeWidth={0.75}
          style={{ cursor: i % 4 === 0 ? 'nwse-resize' : i % 4 === 2 ? 'nesw-resize' : i % 4 === 1 ? 'ns-resize' : 'ew-resize' }} />
      ))}
      <text x={(x0 + x1) / 2} y={Math.min(H - 6, y1 + 18)} textAnchor="middle" fill="white" fontSize={11} style={{ paintOrder: 'stroke', stroke: 'black', strokeWidth: 3 }} pointerEvents="none">
        {size}{crop.angle ? ` · ${crop.angle > 0 ? '+' : ''}${crop.angle.toFixed(2)}°` : ''}
      </text>
    </svg>
  );
}
