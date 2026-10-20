/**
 * Adjustment slider.
 *  - Drag the track; release commits one undo step.
 *  - Double-click the label or the track to reset to default.
 *  - Arrow keys ±step, Shift+arrow ±10 steps; mouse wheel for fine adjustment.
 *  - Optional gradient track (temperature, tint, HSL colours) and non-linear position mapping.
 */
import { useCallback, useEffect, useRef } from 'react';
import { NumberInput } from './NumberInput';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Keyboard / wheel increment in value units. */
  step: number;
  defaultValue: number;
  decimals?: number;
  onChange(v: number): void;
  onCommit(): void;
  /** CSS background for the track. */
  track?: string;
  /** Map value ↔ track position (0…1) for non-linear sliders. */
  toPos?(v: number): number;
  fromPos?(p: number): number;
  format?(v: number): string;
  disabled?: boolean;
}

export function Slider(props: SliderProps) {
  const { label, value, min, max, step, defaultValue, decimals = 0, onChange, onCommit, track, disabled } = props;
  const toPos = props.toPos ?? ((v: number) => (v - min) / (max - min));
  const fromPos = props.fromPos ?? ((p: number) => min + p * (max - min));
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const wheelTimer = useRef<number | undefined>(undefined);

  const quantize = useCallback(
    (v: number) => {
      const q = Math.pow(10, decimals);
      return Math.min(max, Math.max(min, Math.round(v * q) / q));
    },
    [decimals, min, max],
  );

  const setFromPointer = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onChange(quantize(fromPos(p)));
  };

  const reset = () => {
    onChange(defaultValue);
    onCommit();
  };

  // Wheel needs a non-passive listener so the panel doesn't scroll while adjusting.
  const latest = useRef({ value, step, quantize, onChange, onCommit });
  latest.current = { value, step, quantize, onChange, onCommit };
  useEffect(() => {
    const el = trackRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const l = latest.current;
      const dir = e.deltaY < 0 || e.deltaX > 0 ? 1 : -1;
      l.onChange(l.quantize(l.value + dir * l.step * (e.shiftKey ? 10 : 1)));
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => latest.current.onCommit(), 400);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(wheelTimer.current);
    };
  }, []);

  const pos = Math.min(1, Math.max(0, toPos(value)));
  const zeroPos = Math.min(1, Math.max(0, toPos(Math.min(max, Math.max(min, defaultValue)))));
  const text = props.format ? props.format(value) : undefined;

  return (
    <div className={`group select-none py-[3px] ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between">
        <span
          className="text-xs text-ink-dim cursor-default"
          onDoubleClick={reset}
          title="Double-click to reset"
        >
          {label}
        </span>
        {text !== undefined ? (
          <span className="text-xs tabular-nums text-ink">{text}</span>
        ) : (
          <NumberInput
            ariaLabel={label}
            value={value}
            min={min}
            max={max}
            decimals={decimals}
            onCommit={(v) => { onChange(quantize(v)); onCommit(); }}
          />
        )}
      </div>
      <div
        ref={trackRef}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        className="relative mt-1 h-4 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[#666] rounded touch-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
          dragging.current = true;
          setFromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && setFromPointer(e.clientX)}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit();
        }}
        onPointerCancel={() => {
          dragging.current = false;
          onCommit();
        }}
        onDoubleClick={reset}
        onKeyDown={(e) => {
          const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          e.stopPropagation();
          onChange(quantize(value + dir * step * (e.shiftKey ? 10 : 1)));
          onCommit();
        }}
      >
        <div
          className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
          style={{ background: track ?? '#3a3a3a' }}
        />
        {!track && (
          <div
            className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-[#8a8a8a] rounded-full"
            style={{ left: `${Math.min(pos, zeroPos) * 100}%`, width: `${Math.abs(pos - zeroPos) * 100}%` }}
          />
        )}
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#1c1c1c] bg-[#cfcfcf] shadow group-hover:bg-white"
          style={{ left: `${pos * 100}%` }}
        />
      </div>
    </div>
  );
}
