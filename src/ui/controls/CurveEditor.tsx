/**
 * Curve editor: click to add a point, drag to move, drag far outside or double-click to delete.
 * End points can move but not be deleted. Monotone cubic interpolation (same as the renderer).
 */
import { useMemo, useRef, useState } from 'react';
import { monotoneCubic } from '../../recipe/curve';
import type { Point } from '../../recipe/schema';

interface Props {
  points: Point[];
  color: string;
  onChange(pts: Point[]): void;
  onCommit(): void;
  /** Optional luminance histogram (256 bins) drawn behind the curve. */
  histogram?: Uint32Array | null;
}

const SIZE = 256;
const PAD = 6;
const HIT = 9;
const DELETE_DIST = 40;

export function CurveEditor({ points: propPoints, color, onChange: emit, onCommit, histogram }: Props) {
  // Handlers read the latest points from a ref: a point added on pointerdown must be visible to
  // the very next pointermove, before React has re-rendered with the new props.
  const latest = useRef(propPoints);
  latest.current = propPoints;
  const points = propPoints;
  const onChange = (pts: Point[]) => { latest.current = pts; emit(pts); };
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDragState] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const setDrag = (d: number | null) => { dragRef.current = d; setDragState(d); };
  const pending = useRef<{ removed: boolean }>({ removed: false });

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const s = (SIZE + PAD * 2) / r.width;
    return { x: ((e.clientX - r.left) * s - PAD) / SIZE, y: 1 - ((e.clientY - r.top) * s - PAD) / SIZE };
  };

  const path = useMemo(() => {
    const f = monotoneCubic(points);
    let d = '';
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      const y = Math.min(1, Math.max(0, f(x)));
      d += `${i ? 'L' : 'M'}${(PAD + x * SIZE).toFixed(1)},${(PAD + (1 - y) * SIZE).toFixed(1)}`;
    }
    return d;
  }, [points]);

  const histPath = useMemo(() => {
    if (!histogram) return '';
    let max = 1;
    for (let i = 2; i < 254; i++) max = Math.max(max, histogram[i]);
    let d = `M${PAD},${PAD + SIZE}`;
    for (let i = 0; i < 256; i++) {
      const h = Math.min(1, histogram[i] / max) * SIZE * 0.9;
      d += `L${(PAD + (i / 255) * SIZE).toFixed(1)},${(PAD + SIZE - h).toFixed(1)}`;
    }
    return `${d}L${PAD + SIZE},${PAD + SIZE}Z`;
  }, [histogram]);

  const hitTest = (p: Point) => {
    const points = latest.current;
    const r = svgRef.current!.getBoundingClientRect();
    const pxPerUnit = (r.width * SIZE) / (SIZE + PAD * 2);
    let best = -1, bestD = Infinity;
    points.forEach((q, i) => {
      const d = Math.hypot((q.x - p.x) * pxPerUnit, (q.y - p.y) * pxPerUnit);
      if (d < bestD) { bestD = d; best = i; }
    });
    return bestD <= HIT ? best : -1;
  };

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
      className="w-full touch-none select-none rounded bg-sunk"
      onPointerDown={(e) => {
        const p = toLocal(e);
        let i = hitTest(p);
        if (i < 0) {
          // Add a point (between the end points only).
          if (p.x <= points[0].x || p.x >= points[points.length - 1].x) return;
          const f = monotoneCubic(points);
          const np = { x: clamp01(p.x), y: clamp01(Math.abs(p.y - f(p.x)) < 0.05 ? f(p.x) : p.y) };
          const next = [...points, np].sort((a, b) => a.x - b.x);
          i = next.indexOf(np);
          onChange(next);
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        pending.current.removed = false;
        setDrag(i);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (d === null) return;
        const points = latest.current;
        const p = toLocal(e);
        const isEnd = d === 0 || d === points.length - 1;
        const outside = Math.max(-p.x, p.x - 1, -p.y, p.y - 1) * SIZE > DELETE_DIST;
        if (outside && !isEnd) {
          pending.current.removed = true;
          onChange(points.filter((_, j) => j !== d));
          setDrag(null);
          return;
        }
        const lo = d > 0 ? points[d - 1].x + 0.01 : 0;
        const hi = d < points.length - 1 ? points[d + 1].x - 0.01 : 1;
        const next = points.slice();
        next[d] = { x: Math.min(hi, Math.max(lo, clamp01(p.x))), y: clamp01(p.y) };
        onChange(next);
      }}
      onPointerUp={() => {
        if (dragRef.current !== null || pending.current.removed) onCommit();
        setDrag(null);
      }}
      onDoubleClick={(e) => {
        const i = hitTest(toLocal(e));
        const pts = latest.current;
        if (i > 0 && i < pts.length - 1) {
          onChange(pts.filter((_, j) => j !== i));
          onCommit();
        }
      }}
    >
      {histPath && <path d={histPath} fill="#3a3a3a" />}
      {[1, 2, 3].map((k) => (
        <g key={k} stroke="#333" strokeWidth="1">
          <line x1={PAD + (k * SIZE) / 4} y1={PAD} x2={PAD + (k * SIZE) / 4} y2={PAD + SIZE} />
          <line x1={PAD} y1={PAD + (k * SIZE) / 4} x2={PAD + SIZE} y2={PAD + (k * SIZE) / 4} />
        </g>
      ))}
      <rect x={PAD} y={PAD} width={SIZE} height={SIZE} fill="none" stroke="#3d3d3d" />
      <line x1={PAD} y1={PAD + SIZE} x2={PAD + SIZE} y2={PAD} stroke="#444" strokeDasharray="3 4" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={PAD + p.x * SIZE}
          cy={PAD + (1 - p.y) * SIZE}
          r={drag === i ? 5 : 4}
          fill={drag === i ? color : '#1f1f1f'}
          stroke={color}
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}
