/** RGB + luminance histogram with clipping indicators (click to toggle the J overlay). */
import { useEffect, useRef } from 'react';
import { useUi } from '../../state/uiStore';

const W = 256, H = 96;

export function HistogramView() {
  const ref = useRef<HTMLCanvasElement>(null);
  const hist = useUi((s) => s.histogram);
  const overlay = useUi((s) => s.clipOverlay);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!hist) return;
    let max = 1;
    // Ignore the end bins when scaling so clipped spikes don't flatten the rest.
    for (const ch of [hist.r, hist.g, hist.b, hist.l]) for (let i = 1; i < 255; i++) max = Math.max(max, ch[i]);
    const draw = (bins: Uint32Array, color: string) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo(i, H - Math.min(1, Math.sqrt(bins[i] / max)) * (H - 2));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    ctx.globalCompositeOperation = 'lighter';
    draw(hist.r, 'rgba(200,60,60,0.75)');
    draw(hist.g, 'rgba(60,170,70,0.75)');
    draw(hist.b, 'rgba(60,90,210,0.75)');
    ctx.globalCompositeOperation = 'source-over';
    draw(hist.l, 'rgba(200,200,200,0.18)');
  }, [hist]);

  const lo = (hist?.clipLow ?? 0) > 0.002;
  const hi = (hist?.clipHigh ?? 0) > 0.002;
  const toggle = () => useUi.getState().set({ clipOverlay: !overlay });

  return (
    <div className="relative border-b border-line bg-[#202020] p-2">
      <canvas ref={ref} width={W} height={H} className="h-24 w-full" />
      <button
        title="Shadow clipping (J)"
        onClick={toggle}
        className={`absolute left-2 top-2 h-0 w-0 border-l-[7px] border-r-[7px] border-t-[9px] border-l-transparent border-r-transparent ${
          lo ? 'border-t-[#5b7cff]' : 'border-t-[#555]'
        } ${overlay ? 'opacity-100' : 'opacity-80'}`}
      />
      <button
        title="Highlight clipping (J)"
        onClick={toggle}
        className={`absolute right-2 top-2 h-0 w-0 border-l-[7px] border-r-[7px] border-t-[9px] border-l-transparent border-r-transparent ${
          hi ? 'border-t-[#ff5050]' : 'border-t-[#555]'
        } ${overlay ? 'opacity-100' : 'opacity-80'}`}
      />
      {overlay && <div className="absolute bottom-1 right-2 text-[10px] text-ink-faint">clipping overlay</div>}
    </div>
  );
}
