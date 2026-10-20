/**
 * Colour-grading wheel: drag the puck for hue (angle) and saturation (radius); Shift-drag for fine
 * control; double-click to reset. Hue follows OKLCH hue (0° = pinkish red, counter-clockwise), the
 * same hue the grading stage uses, and the wheel is painted with CSS oklch() so it shows it.
 */
import { useRef } from 'react';
import type { Wheel } from '../../recipe/schema';

interface Props {
  value: Wheel;
  size: number;
  label: string;
  onChange(w: Wheel): void;
  onCommit(): void;
}

// CSS conic gradients start at the top and run clockwise: angle θ shows hue (90° − θ).
const CONIC = `conic-gradient(${Array.from({ length: 13 }, (_, i) => {
  const theta = i * 30;
  return `oklch(0.72 0.14 ${(((90 - theta) % 360) + 360) % 360}) ${theta}deg`;
}).join(', ')})`;

export function ColorWheel({ value, size, label, onChange, onCommit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; hue: number; sat: number } | null>(null);
  const R = size / 2;
  const h = (value.hue * Math.PI) / 180;
  const px = R + Math.cos(h) * (value.sat / 100) * (R - 6);
  const py = R - Math.sin(h) * (value.sat / 100) * (R - 6);

  const fromPointer = (clientX: number, clientY: number, fine: boolean) => {
    const r = ref.current!.getBoundingClientRect();
    let dx = clientX - (r.left + R), dy = clientY - (r.top + R);
    if (fine && drag.current) {
      // Fine control: move the puck at 1/5 of the pointer speed from where the drag started.
      const d = drag.current;
      const sh = (d.hue * Math.PI) / 180, sr = (d.sat / 100) * (R - 6);
      dx = Math.cos(sh) * sr + (clientX - d.x) * 0.2;
      dy = -Math.sin(sh) * sr + (clientY - d.y) * 0.2;
    }
    let hue = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const sat = Math.min(100, (Math.hypot(dx, dy) / (R - 6)) * 100);
    onChange({ ...value, hue: Math.round(hue), sat: Math.round(sat) });
  };

  return (
    <div className="flex flex-col items-center">
      <div
        ref={ref}
        role="slider"
        aria-label={`${label} wheel`}
        aria-valuetext={`hue ${Math.round(value.hue)}°, saturation ${Math.round(value.sat)}`}
        tabIndex={0}
        className="relative cursor-crosshair touch-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-[#888]"
        style={{ width: size, height: size, background: `radial-gradient(circle closest-side, #8a8a8a 0%, rgba(138,138,138,0) 100%), ${CONIC}` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, hue: value.hue, sat: value.sat };
          if (!e.shiftKey) fromPointer(e.clientX, e.clientY, false);
        }}
        onPointerMove={(e) => drag.current && fromPointer(e.clientX, e.clientY, e.shiftKey)}
        onPointerUp={() => { drag.current = null; onCommit(); }}
        onDoubleClick={() => { onChange({ hue: 0, sat: 0, lum: value.lum }); onCommit(); }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          let { hue, sat } = value;
          if (e.key === 'ArrowLeft') hue = (hue + 360 - step) % 360;
          else if (e.key === 'ArrowRight') hue = (hue + step) % 360;
          else if (e.key === 'ArrowUp') sat = Math.min(100, sat + step);
          else if (e.key === 'ArrowDown') sat = Math.max(0, sat - step);
          else return;
          e.preventDefault();
          e.stopPropagation();
          onChange({ ...value, hue, sat });
          onCommit();
        }}
      >
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/40" />
        <div
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: px, top: py, background: value.sat ? `oklch(0.72 ${0.04 + value.sat * 0.0012} ${value.hue})` : '#8a8a8a' }}
        />
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-ink-faint">
        {label} · {Math.round(value.hue)}° · {Math.round(value.sat)}
      </div>
    </div>
  );
}
