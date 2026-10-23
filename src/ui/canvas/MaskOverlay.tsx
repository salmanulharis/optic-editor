/**
 * On-canvas editing of the selected mask component: linear-gradient lines, radial-gradient ellipse
 * (move, resize, rotate, feather), brush painting (pen pressure, Alt erases, [ ] size), and the
 * colour / luminance-range eyedroppers. Mask geometry lives in the undistorted source frame U, so
 * every point goes output pixel ↔ U through the displayed recipe's geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { appendStroke, commitMasks, sampleColorRange, sampleLuminance, updateParams } from '../../app/maskActions';
import { computeGeo, project } from '../../geometry/transform';
import type { BrushStroke, MaskComponent, MaskParams } from '../../recipe/masks';
import { useEdit } from '../../state/editStore';
import { useImage } from '../../state/imageStore';
import { useUi } from '../../state/uiStore';
import { displayedRecipe } from './displayed';
import { type ViewBox, toImage, toScreen } from './viewMath';

type Pt = [number, number];

export function MaskOverlay({ box }: { box: ViewBox }) {
  const open = useUi((s) => s.masksOpen);
  const maskId = useUi((s) => s.selectedMask);
  const compId = useUi((s) => s.selectedComp);
  const view = useUi((s) => s.view);
  const pick = useUi((s) => s.maskPick);
  const brush = useUi((s) => s.brush);
  const masks = useEdit((s) => s.recipe.masks);
  useEdit((s) => s.recipe.crop);
  useEdit((s) => s.recipe.geometry);
  const img = useImage((s) => s.image);
  const ref = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [altDown, setAltDown] = useState(false);
  const drag = useRef<null | { kind: string; start: Pt; orig: MaskParams[keyof MaskParams] }>(null);
  const stroke = useRef<BrushStroke | null>(null);
  const raf = useRef(0);
  const touches = useRef(new Set<number>());

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === ' ' && !(e.target instanceof HTMLInputElement)) setSpaceDown(true);
      if (e.key === 'Alt') setAltDown(true);
    };
    const ku = (e: KeyboardEvent) => { if (e.key === ' ') setSpaceDown(false); if (e.key === 'Alt') setAltDown(false); };
    const blur = () => { setSpaceDown(false); setAltDown(false); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur); };
  }, []);

  const m = masks.find((x) => x.id === maskId);
  const c: MaskComponent | undefined = m?.components.find((x) => x.id === compId) ?? m?.components[0];
  if (!open || !img || !view || !m || !c) return null;
  const { recipe } = displayedRecipe(img);
  const geo = computeGeo(img.model, recipe);
  const W = img.width, H = img.height;
  const areaW = view.areaW;
  /** U-normalised → CSS. */
  const toCss = (x: number, y: number): Pt => {
    const [ox, oy] = project(geo.uToO, x * W, y * H);
    return toScreen(view, box, areaW, ox, oy);
  };
  /** CSS → U-normalised. */
  const fromCss = (x: number, y: number): Pt => {
    const [ox, oy] = toImage(view, box, areaW, x, y);
    const [ux, uy] = project(geo.oToU, ox, oy);
    return [ux / W, uy / H];
  };
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** CSS pixels per U pixel at the view (geometry scale included). */
  const cssPerU = (() => {
    const a = toCss(0.5, 0.5), b = toCss(0.5 + 1 / W, 0.5);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  })();
  const longEdge = Math.max(W, H);

  const startDrag = (kind: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, start: local(e), orig: structuredClone(c.params) };
    useUi.getState().set({ maskOverlayTemp: true });
  };

  const onMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (c.type === 'brush') setCursor(p);
    if (stroke.current) {
      const [ux, uy] = fromCss(...p);
      const pts = stroke.current.points;
      const lx = pts[pts.length - 3], ly = pts[pts.length - 2];
      // Spacing ≈ 1/6 of the radius keeps the path smooth without thousands of points.
      if (Math.hypot((ux - lx) * W, (uy - ly) * H) < (stroke.current.size * longEdge) / 6) return;
      pts.push(ux, uy, e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 1);
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => stroke.current && appendStroke(m.id, c.id, { ...stroke.current, points: [...stroke.current.points] }, true));
      return;
    }
    const d = drag.current;
    if (!d) return;
    const [ux, uy] = fromCss(...p);
    const [sx, sy] = fromCss(...d.start);
    const dx = ux - sx, dy = uy - sy;
    if (c.type === 'linear') {
      const o = d.orig as MaskParams['linear'];
      if (d.kind === 'p1') updateParams<'linear'>(m.id, c.id, { x1: ux, y1: uy });
      else if (d.kind === 'p2') updateParams<'linear'>(m.id, c.id, { x2: ux, y2: uy });
      else updateParams<'linear'>(m.id, c.id, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
    } else if (c.type === 'radial') {
      const o = d.orig as MaskParams['radial'];
      const a = (o.angle * Math.PI) / 180;
      // Pointer relative to the centre in U pixels, in the ellipse's rotated frame.
      const qx = (ux - o.cx) * W, qy = (uy - o.cy) * H;
      const rx = qx * Math.cos(a) + qy * Math.sin(a), ry = -qx * Math.sin(a) + qy * Math.cos(a);
      if (d.kind === 'move') updateParams<'radial'>(m.id, c.id, { cx: o.cx + dx, cy: o.cy + dy });
      else if (d.kind === 'rx') updateParams<'radial'>(m.id, c.id, e.shiftKey ? { rx: Math.max(2, Math.abs(rx)) / W, ry: (Math.max(2, Math.abs(rx)) / W) * W / H } : { rx: Math.max(2, Math.abs(rx)) / W });
      else if (d.kind === 'ry') updateParams<'radial'>(m.id, c.id, { ry: Math.max(2, Math.abs(ry)) / H });
      else if (d.kind === 'rot') updateParams<'radial'>(m.id, c.id, { angle: Math.round((Math.atan2(qy, qx) * 180) / Math.PI * 10) / 10 });
      else if (d.kind === 'feather') {
        const r = Math.hypot(rx / (o.rx * W), ry / (o.ry * H));
        updateParams<'radial'>(m.id, c.id, { feather: Math.round(Math.min(100, Math.max(0, (1 - r) * 100))) });
      }
    }
  };

  const onUp = (e?: React.PointerEvent) => {
    if (e?.pointerType === 'touch') touches.current.delete(e.pointerId);
    cancelAnimationFrame(raf.current);
    if (stroke.current) {
      const s = stroke.current;
      stroke.current = null;
      appendStroke(m.id, c.id, { ...s, points: [...s.points] }, true);
      commitMasks();
    } else if (drag.current) {
      drag.current = null;
      commitMasks();
    }
    useUi.getState().set({ maskOverlayTemp: false });
  };

  const onDownBackground = (e: React.PointerEvent) => {
    if (spaceDown || e.button === 1) return;
    if (e.pointerType === 'touch') {
      touches.current.add(e.pointerId);
      // A second finger is a gesture, not paint: drop the stroke just started.
      if (touches.current.size > 1 && stroke.current) {
        stroke.current = null;
        cancelAnimationFrame(raf.current);
        useEdit.getState().update(() => useEdit.getState().committed);
        useUi.getState().set({ maskOverlayTemp: false });
        return;
      }
      if (touches.current.size > 1) return;
    }
    const p = local(e);
    if (pick) {
      const [ox, oy] = toImage(view, box, areaW, ...p);
      // Click replaces the colour, Shift-click adds one (up to three) and keeps the picker active.
      if (c.type === 'colorRange') sampleColorRange(m.id, c.id, ox, oy, !e.shiftKey);
      else if (c.type === 'lumRange') {
        const L = sampleLuminance(ox, oy);
        if (L !== null) {
          const q = c.params as MaskParams['lumRange'];
          const half = Math.max(5, (q.hi - q.lo) / 2);
          updateParams<'lumRange'>(m.id, c.id, { lo: Math.max(0, L - half), hi: Math.min(100, L + half) }, false);
        }
      }
      if (!e.shiftKey) useUi.getState().set({ maskPick: false });
      return;
    }
    if (c.type === 'brush' && e.button === 0) {
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const [ux, uy] = fromCss(...p);
      const b = useUi.getState().brush;
      stroke.current = {
        erase: b.erase || e.altKey, size: b.size, feather: b.feather, flow: b.flow, density: b.density, autoMask: b.autoMask,
        points: [ux, uy, e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 1],
      };
      appendStroke(m.id, c.id, { ...stroke.current, points: [...stroke.current.points] }, false);
      useUi.getState().set({ maskOverlayTemp: true });
    }
  };

  // ---- drawing ----------------------------------------------------------
  const handle = (p: Pt, kind: string, title: string, fill = '#fff') => (
    <circle cx={p[0]} cy={p[1]} r={6} fill={fill} stroke="#000" strokeOpacity={0.7} strokeWidth={1.5} style={{ cursor: 'grab', pointerEvents: 'all' }}
      onPointerDown={startDrag(kind)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <title>{title}</title>
    </circle>
  );
  const shapes: JSX.Element[] = [];
  if (c.type === 'linear') {
    const q = c.params as MaskParams['linear'];
    const p1 = toCss(q.x1, q.y1), p2 = toCss(q.x2, q.y2);
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = (-dy / len) * 3000, ny = (dx / len) * 3000;
    const line = (p: Pt, dash?: string) => (
      <g key={`${p[0]},${dash}`}>
        <line x1={p[0] - nx} y1={p[1] - ny} x2={p[0] + nx} y2={p[1] + ny} stroke="#000" strokeOpacity={0.5} strokeWidth={3} />
        <line x1={p[0] - nx} y1={p[1] - ny} x2={p[0] + nx} y2={p[1] + ny} stroke="#fff" strokeWidth={1.25} strokeDasharray={dash} />
      </g>
    );
    const mid: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    shapes.push(line(p1), line(p2, '6 5'), line(mid, '2 6'));
    shapes.push(<line key="axis" x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} stroke="#fff" strokeOpacity={0.5} strokeWidth={1} />);
    shapes.push(<g key="h">{handle(p1, 'p1', 'Start: full effect')}{handle(p2, 'p2', 'End: no effect')}{handle(mid, 'move', 'Move', '#f2c94c')}</g>);
  } else if (c.type === 'radial') {
    const q = c.params as MaskParams['radial'];
    const a = (q.angle * Math.PI) / 180;
    const ellipse = (k: number) => {
      const pts: string[] = [];
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        const ex = Math.cos(t) * q.rx * W * k, ey = Math.sin(t) * q.ry * H * k;
        const ux = q.cx + (ex * Math.cos(a) - ey * Math.sin(a)) / W, uy = q.cy + (ex * Math.sin(a) + ey * Math.cos(a)) / H;
        pts.push(toCss(ux, uy).join(','));
      }
      return pts.join(' ');
    };
    const at = (ex: number, ey: number) => toCss(q.cx + (ex * Math.cos(a) - ey * Math.sin(a)) / W, q.cy + (ex * Math.sin(a) + ey * Math.cos(a)) / H);
    const inner = Math.max(0.02, 1 - q.feather / 100);
    shapes.push(
      <polyline key="o" points={ellipse(1)} fill="none" stroke="#000" strokeOpacity={0.5} strokeWidth={3} />,
      <polyline key="o2" points={ellipse(1)} fill="none" stroke="#fff" strokeWidth={1.25} />,
      <polyline key="i" points={ellipse(inner)} fill="none" stroke="#fff" strokeOpacity={0.8} strokeWidth={1} strokeDasharray="5 4" />,
      <g key="h">
        {handle(toCss(q.cx, q.cy), 'move', 'Move', '#f2c94c')}
        {handle(at(q.rx * W, 0), 'rx', 'Width (Shift: circle)')}
        {handle(at(0, q.ry * H), 'ry', 'Height')}
        {handle(at(q.rx * W * 1.18, 0), 'rot', 'Rotate', '#9ad')}
        {handle(at(0, -q.ry * H * inner), 'feather', 'Feather', '#ccc')}
      </g>,
    );
  }
  const brushR = c.type === 'brush' ? brush.size * longEdge * cssPerU : 0;
  const painting = c.type === 'brush' && !spaceDown;
  const picking = pick && (c.type === 'colorRange' || c.type === 'lumRange');
  const interactive = painting || picking;
  return (
    <svg
      ref={ref}
      className={`absolute inset-0 h-full w-full touch-none select-none ${interactive ? '' : 'pointer-events-none'}`}
      style={{ cursor: picking ? 'crosshair' : painting ? 'none' : undefined }}
      onPointerDown={interactive ? onDownBackground : undefined}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setCursor(null)}
      aria-label="Mask editing area"
    >
      {shapes}
      {painting && cursor && (
        <g pointerEvents="none">
          <circle cx={cursor[0]} cy={cursor[1]} r={brushR} fill="none" stroke="#000" strokeOpacity={0.6} strokeWidth={2.5} />
          <circle cx={cursor[0]} cy={cursor[1]} r={brushR} fill="none" stroke={brush.erase || altDown ? '#ff8080' : '#fff'} strokeWidth={1} />
          <circle cx={cursor[0]} cy={cursor[1]} r={brushR * Math.max(0.02, 1 - brush.feather / 100)} fill="none" stroke="#fff" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="3 3" />
        </g>
      )}
    </svg>
  );
}
