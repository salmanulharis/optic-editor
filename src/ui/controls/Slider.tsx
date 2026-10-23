/**
 * Adjustment slider.
 *  - Drag the track; release commits one undo step.
 *  - Double-click the label or the track to reset to default.
 *  - Arrow keys ±step, Shift+arrow ±10 steps; mouse wheel for fine adjustment.
 *  - Optional gradient track (temperature, tint, HSL colours) and non-linear position mapping.
 *  - Touch: swipe horizontally anywhere on the row to adjust (relative, so a thumb never covers
 *    the value), double-tap to reset, a haptic tick when crossing the default; vertical swipes
 *    still scroll the panel. Larger hit targets on coarse pointers.
 *  - Screen readers: role="slider" with the value text announced.
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
  const rowRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const swipe = useRef<null | { id: number; x: number; y: number; v: number; mode: 'undecided' | 'h' }>(null);
  const lastTap = useRef(0);
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
    change(quantize(fromPos(p)));
  };

  const reset = () => {
    onChange(defaultValue);
    onCommit();
    tick();
  };
  const tick = () => { try { navigator.vibrate?.(8); } catch { /* no vibration */ } };
  /** Haptic tick when a drag crosses (or lands on) the default value. */
  const change = (v: number) => {
    const prev = latest.current.value;
    if (v !== prev && (v === defaultValue || Math.sign(prev - defaultValue) !== Math.sign(v - defaultValue))) tick();
    onChange(v);
  };

  // Touch: horizontal swipes anywhere on the row adjust relatively; vertical ones scroll.
  const onRowDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || disabled) return;
    if ((e.target as HTMLElement).closest('input,button')) return;
    const now = performance.now();
    if (now - lastTap.current < 300) { lastTap.current = 0; reset(); return; }
    lastTap.current = now;
    swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, v: value, mode: 'undecided' };
  };
  const onRowMove = (e: React.PointerEvent) => {
    const sw = swipe.current;
    if (!sw || sw.id !== e.pointerId) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (sw.mode === 'undecided') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe.current = null; return; }
      if (Math.abs(dx) < 8) return;
      sw.mode = 'h';
      lastTap.current = 0;
      rowRef.current?.setPointerCapture(e.pointerId);
    }
    const w = rowRef.current?.getBoundingClientRect().width || 300;
    const p0 = toPos(sw.v);
    // Half the row width spans the whole range: fine control under a thumb.
    change(quantize(fromPos(Math.min(1, Math.max(0, p0 + (dx / w) * 0.5)))));
  };
  const onRowUp = (e: React.PointerEvent) => {
    const sw = swipe.current;
    if (!sw || sw.id !== e.pointerId) return;
    swipe.current = null;
    if (sw.mode === 'h') onCommit();
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

  const valueText = text ?? (decimals ? value.toFixed(decimals) : String(Math.round(value)));
  return (
    <div ref={rowRef} className={`group select-none py-[3px] [@media(pointer:coarse)]:py-1.5 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
      style={{ touchAction: 'pan-y' }} onPointerDown={onRowDown} onPointerMove={onRowMove} onPointerUp={onRowUp} onPointerCancel={onRowUp}>
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
        aria-valuetext={valueText}
        tabIndex={0}
        className="relative mt-1 h-4 cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ink-dim touch-none [@media(pointer:coarse)]:h-7"
        onPointerDown={(e) => {
          // Touch uses the row swipe (relative); mouse and pen grab the track.
          if (e.button !== 0 || e.pointerType === 'touch') return;
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
          change(quantize(value + dir * step * (e.shiftKey ? 10 : 1)));
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
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#1c1c1c] bg-[#cfcfcf] shadow group-hover:bg-accent-hi [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5"
          style={{ left: `${pos * 100}%` }}
        />
      </div>
    </div>
  );
}
