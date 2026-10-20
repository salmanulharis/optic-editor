/**
 * SVG overlays on the canvas, drawn with the exact view of the last rendered frame (ui.view):
 *  - GridOverlay: alignment grid while a geometry slider is dragged.
 *  - GuidesOverlay: the guided-upright lines (stored in undistorted source coordinates).
 *  - LineToolOverlay: draw a line for the straighten tool or a new guided-upright line.
 *  - CompareOverlay: split divider (draggable) and Before / After labels.
 */
import { useRef, useState } from 'react';
import { addGuide, setStraighten } from '../../app/geometryActions';
import { computeGeo, project } from '../../geometry/transform';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { beforeRecipe, displayedRecipe } from './displayed';
import { type ViewBox, toImage, toScreen } from './viewMath';

/** Output rectangle of the displayed image in CSS pixels. */
function useFrame(box: ViewBox) {
  const view = useUi((s) => s.view);
  useEdit((s) => s.recipe);
  useUi((s) => s.cropMode);
  const img = useImage((s) => s.image);
  if (!view || !img) return null;
  const { recipe } = displayedRecipe(img);
  const g = computeGeo(img.model, recipe);
  const [x0, y0] = toScreen(view, box, view.areaW, 0, 0);
  const [x1, y1] = toScreen(view, box, view.areaW, g.outW, g.outH);
  return { view, img, recipe, geo: g, x0, y0, x1, y1 };
}

export function GridOverlay({ box }: { box: ViewBox }) {
  const on = useUi((s) => s.geometryGrid || s.tool === 'guide');
  const n = useUi((s) => s.gridDensity);
  const f = useFrame(box);
  if (!on || !f) return null;
  const lines = [];
  for (let i = 1; i < n; i++) {
    const x = f.x0 + ((f.x1 - f.x0) * i) / n, y = f.y0 + ((f.y1 - f.y0) * i) / n;
    lines.push(<line key={`v${i}`} x1={x} y1={f.y0} x2={x} y2={f.y1} />, <line key={`h${i}`} x1={f.x0} y1={y} x2={f.x1} y2={y} />);
  }
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full">
      <g stroke="rgba(255,255,255,0.35)" strokeWidth={1} shapeRendering="crispEdges">{lines}</g>
    </svg>
  );
}

export function GuidesOverlay({ box }: { box: ViewBox }) {
  const guides = useEdit((s) => s.recipe.geometry.guides);
  const upright = useEdit((s) => s.recipe.geometry.upright);
  const tool = useUi((s) => s.tool);
  const f = useFrame(box);
  if (!f || !guides.length || (upright !== 'guided' && tool !== 'guide')) return null;
  const toCss = (ux: number, uy: number) => {
    const [ox, oy] = project(f.geo.uToO, ux * f.img.width, uy * f.img.height);
    return toScreen(f.view, box, f.view.areaW, ox, oy);
  };
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full">
      {guides.map((g, i) => {
        const [ax, ay] = toCss(g.x1, g.y1), [bx, by] = toCss(g.x2, g.y2);
        return (
          <g key={i}>
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="black" strokeOpacity={0.6} strokeWidth={3} />
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#f2c94c" strokeWidth={1.5} />
            <circle cx={ax} cy={ay} r={3} fill="#f2c94c" />
            <circle cx={bx} cy={by} r={3} fill="#f2c94c" />
          </g>
        );
      })}
    </svg>
  );
}

/** Deviation (degrees, −45…45) of a direction from the nearest horizontal / vertical axis. */
function axisDeviation(dx: number, dy: number) {
  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  a = ((a % 90) + 90) % 90;
  return a > 45 ? a - 90 : a;
}

export function LineToolOverlay({ box }: { box: ViewBox }) {
  const tool = useUi((s) => s.tool);
  const f = useFrame(box);
  const [line, setLine] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (!f) return null;
  const local = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const finish = () => {
    if (!line) return;
    setLine(null);
    const len = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
    if (len < 12) return;
    const [ax, ay] = toImage(f.view, box, f.view.areaW, ...line.a);
    const [bx, by] = toImage(f.view, box, f.view.areaW, ...line.b);
    const ua = project(f.geo.oToU, ax, ay), ub = project(f.geo.oToU, bx, by);
    if (tool === 'straighten') {
      // Level the line in the transformed frame: the crop angle is the opposite of its tilt there.
      const ta = project(f.geo.uToT, ua[0], ua[1]), tb = project(f.geo.uToT, ub[0], ub[1]);
      setStraighten(-axisDeviation(tb[0] - ta[0], tb[1] - ta[1]), true);
      useUi.getState().set({ tool: 'none' });
    } else {
      addGuide({ x1: ua[0] / f.img.width, y1: ua[1] / f.img.height, x2: ub[0] / f.img.width, y2: ub[1] / f.img.height });
    }
  };
  return (
    <svg
      ref={ref}
      className="absolute inset-0 h-full w-full touch-none select-none"
      style={{ cursor: 'crosshair' }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = local(e); setLine({ a: p, b: p }); }}
      onPointerMove={(e) => line && setLine({ ...line, b: local(e) })}
      onPointerUp={finish}
      onPointerCancel={() => setLine(null)}
    >
      {line && (
        <>
          <line x1={line.a[0]} y1={line.a[1]} x2={line.b[0]} y2={line.b[1]} stroke="black" strokeOpacity={0.6} strokeWidth={3} />
          <line x1={line.a[0]} y1={line.a[1]} x2={line.b[0]} y2={line.b[1]} stroke={tool === 'guide' ? '#f2c94c' : 'white'} strokeWidth={1.5} />
        </>
      )}
    </svg>
  );
}

export function CompareOverlay(_props: { box: ViewBox }) {
  const mode = useUi((s) => s.compareMode);
  const pos = useUi((s) => s.compareSplit);
  const vertical = useUi((s) => s.compareVertical);
  const swap = useUi((s) => s.compareSwap);
  useUi((s) => s.compareSource);
  useEdit((s) => s.copies);
  const img = useImage((s) => s.image);
  const ref = useRef<HTMLDivElement>(null);
  if (!img) return null;
  const before = `Before · ${beforeRecipe(img).label}`;
  const after = 'After';
  const label = (text: string, cls: string) => (
    <span className={`pointer-events-none absolute rounded bg-black/60 px-2 py-0.5 text-[11px] text-ink ${cls}`}>{text}</span>
  );
  if (mode === 'side') {
    return (
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-y-0 left-1/2 w-px bg-black/70" />
        {label(swap ? after : before, 'left-2 top-2')}
        {label(swap ? before : after, 'left-[calc(50%+8px)] top-2')}
      </div>
    );
  }
  const drag = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const t = vertical ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    useUi.getState().set({ compareSplit: Math.min(0.98, Math.max(0.02, t)) });
  };
  const first = swap ? after : before, second = swap ? before : after;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <div
        className={`pointer-events-auto absolute touch-none ${vertical ? 'inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize' : 'inset-x-0 h-3 -translate-y-1/2 cursor-ns-resize'}`}
        style={vertical ? { left: `${pos * 100}%` } : { top: `${pos * 100}%` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); }}
        onPointerMove={(e) => e.buttons && drag(e)}
      >
        <div className={vertical ? 'mx-auto h-full w-px bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]' : 'my-auto h-px w-full translate-y-[5px] bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]'} />
      </div>
      {vertical ? (
        <>
          {label(first, 'left-2 top-2')}
          {label(second, 'right-2 top-2')}
        </>
      ) : (
        <>
          {label(first, 'left-2 top-2')}
          {label(second, 'bottom-10 left-2')}
        </>
      )}
    </div>
  );
}
