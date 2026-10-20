/**
 * Benchmark & seam-test page (bench.html, dev server only).
 *
 *  - Seam test: a 4096 px synthetic image with every spatial effect at full strength, exported
 *    tiled (512 px tiles) and untiled (one tile); the maximum difference must stay below 1/1024.
 *  - Benchmark: a 48 MP synthetic image in a real ViewRenderer: preview frame rate while a slider
 *    is dragged (default recipe, every Phase 3 effect on with an upstream and a downstream slider,
 *    and in draft mode), and the full-resolution export render time.
 * Results are shown on the page and returned by window.__bench.* for scripts/bench.mjs.
 */
import { toXYZ_D65 } from '../color/matrices';
import { renderFullResolution } from '../io/encode/exportRender';
import type { FloatImage } from '../io/decode/types';
import type { ImageModel, OutputTarget } from '../pipeline/types';
import { type Recipe, defaultRecipe } from '../recipe/schema';
import type { LoadedImage } from '../state/imageStore';
import { ViewRenderer } from '../ui/canvas/viewRenderer';
import { proxyOf, syntheticImage } from './synthetic';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += `${s}\n`; console.info(`[bench] ${s}`); };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function model(W: number, H: number): ImageModel {
  return {
    isRaw: false,
    bitDepth: 16,
    color: { kind: 'display', toXYZ: toXYZ_D65('srgb'), spaceId: 'srgb', spaceLabel: 'sRGB' },
    width: W,
    height: H,
    key: `synthetic-${W}x${H}`,
    lens: null,
    analysis: { noise: { S: 2e-4, O: 1e-5 } },
  };
}

/** The seam-test recipe: every spatial / map-based effect at full strength. */
export function seamRecipe(): Recipe {
  const r = defaultRecipe();
  r.detail.nr = { lum: 100, lumDetail: 50, lumContrast: 0, color: 100, colorDetail: 50, colorSmooth: 100 };
  r.detail.sharpen = { amount: 100, radius: 1.5, detail: 50, masking: 20 };
  r.effects.texture = 100;
  r.effects.clarity = 100;
  r.effects.dehaze = 100;
  r.effects.bloom = { amount: 100, threshold: 50, radius: 60, warmth: 20 };
  r.effects.halation = { amount: 80, threshold: 60, radius: 40, hue: 15 };
  r.effects.grain = { amount: 40, size: 30, roughness: 50, color: 20, type: 'custom' };
  r.effects.vignette = { ...r.effects.vignette, amount: -40 };
  r.look.microContrast = 40;
  return r;
}

/** Every Phase 3 effect on at typical strengths (benchmark). */
export function allEffects(): Recipe {
  const r = seamRecipe();
  r.detail.nr = { ...r.detail.nr, lum: 40, color: 40 };
  r.effects = { ...r.effects, texture: 30, clarity: 30, dehaze: 25 };
  r.lens = { ...r.lens, distortion: 10, vignetting: { amount: 20, midpoint: 50 }, ca: { auto: false, redCyan: 20, blueYellow: 10 }, defringe: { ...r.lens.defringe, purpleAmount: 20 } };
  r.crop = { ...r.crop, x: 0.05, y: 0.05, w: 0.9, h: 0.9, angle: 1.5 };
  return r;
}

const TARGET: OutputTarget = { mode: 'encoded', space: 'srgb', dither: false, clipOverlay: false };

export async function seamTest(size = 4096, tile = 512) {
  log(`Seam test: ${size}² synthetic, tiles of ${tile} vs untiled…`);
  const full = syntheticImage(size, size);
  const input = { full, proxy: proxyOf(full, 2048), luts: [], image: model(size, size), recipe: seamRecipe(), target: TARGET };
  // The untiled reference first: it needs the most GPU memory.
  const t0 = performance.now();
  const whole = await renderFullResolution(document.createElement('canvas'), input, () => {}, tick, { tile: size });
  const t1 = performance.now();
  const tiled = await renderFullResolution(document.createElement('canvas'), input, () => {}, tick, { tile });
  const t2 = performance.now();
  let max = 0, at = 0;
  for (let i = 0; i < tiled.data.length; i++) {
    const d = Math.abs(tiled.data[i] - whole.data[i]);
    if (d > max) { max = d; at = i; }
  }
  const p = (at / 3) | 0;
  // Control: the effects must actually change the image (a zero seam diff of a no-op is no proof).
  const plain = await renderFullResolution(document.createElement('canvas'), { ...input, recipe: defaultRecipe() }, () => {}, tick, { tile: 1024 });
  let effect = 0;
  for (let i = 0; i < plain.data.length; i++) effect += Math.abs(plain.data[i] - whole.data[i]);
  const res = {
    size, tile,
    meanEffect: effect / plain.data.length / 65535,
    maxDiff: max / 65535,
    maxDiffCodes16: max,
    at: { x: p % tiled.width, y: Math.floor(p / tiled.width) },
    threshold: 1 / 1024,
    pass: max / 65535 < 1 / 1024 && effect / plain.data.length / 65535 > 0.01,
    untiledMs: Math.round(t1 - t0),
    tiledMs: Math.round(t2 - t1),
  };
  log(`  effects change the image by ${(res.meanEffect * 100).toFixed(1)} % on average (control)`);
  log(`  max |tiled − untiled| = ${res.maxDiff.toExponential(3)} (${max} / 65535) at ${res.at.x}, ${res.at.y} → ${res.pass ? 'PASS' : 'FAIL'} (limit ${res.threshold.toExponential(3)})`);
  return res;
}

async function measureFps(r: ViewRenderer, recipeAt: (i: number) => Recipe, frames: number, draft = false): Promise<number> {
  const gl = r.gl;
  const px = new Uint8Array(4);
  const view = () => {
    const o = r.outputSize(recipeAt(0));
    const s = Math.min(r.canvas.width / o.width, r.canvas.height / o.height) * 0.96;
    return { scale: s, cx: o.width / 2, cy: o.height / 2 };
  };
  // Warm up: compile every program variant first.
  for (let i = 0; i < 400 && !r.canRender({ recipe: recipeAt(0), overlay: false }); i++) await new Promise((res) => setTimeout(res, 25));
  for (let i = 0; i < 4; i++) { r.render({ recipe: recipeAt(i), view: view(), overlay: false, draft }, () => {}); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const t0 = performance.now();
  let cpu = 0;
  for (let i = 0; i < frames; i++) {
    const c0 = performance.now();
    r.render({ recipe: recipeAt(i), view: view(), overlay: false, draft }, () => {});
    cpu += performance.now() - c0;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait for the GPU: honest frame time
    await new Promise<void>((res) => requestAnimationFrame(() => res()));
  }
  lastCpuMs = cpu / frames;
  return (frames * 1000) / (performance.now() - t0);
}
let lastCpuMs = 0;

export async function bench(W = 8064, H = 6048) {
  log(`Benchmark: ${W} × ${H} (${((W * H) / 1e6).toFixed(1)} MP) synthetic…`);
  const tg = performance.now();
  const full: FloatImage = syntheticImage(W, H);
  const proxy = proxyOf(full, 2560);
  log(`  generated in ${Math.round(performance.now() - tg)} ms`);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
  canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
  const r = new ViewRenderer(canvas);
  const m = model(W, H);
  const img = { id: 1, width: W, height: H, full, proxy, thumb: proxy, model: m, isRaw: false, bitDepth: 16 } as unknown as LoadedImage;
  await r.setImage(img);
  const base = defaultRecipe();
  const all = allEffects();
  const fps: Record<string, number> = {};
  const drag = (rec: Recipe, f: (r: Recipe, v: number) => Recipe) => (i: number) => f(rec, Math.sin(i / 6));
  fps.default = await measureFps(r, drag(base, (rc, v) => ({ ...rc, light: { ...rc.light, exposure: v * 0.5 } })), 90);
  fps.allEffectsDragGrain = await measureFps(r, drag(all, (rc, v) => ({ ...rc, effects: { ...rc.effects, grain: { ...rc.effects.grain, amount: 40 + 20 * v } } })), 90);
  fps.allEffectsDragExposure = await measureFps(r, drag(all, (rc, v) => ({ ...rc, light: { ...rc.light, exposure: v * 0.5 } })), 90);
  fps.allEffectsDragExposureDraft = await measureFps(r, drag(all, (rc, v) => ({ ...rc, light: { ...rc.light, exposure: v * 0.5 } })), 90, true);
  for (const [k, v] of Object.entries(fps)) log(`  preview ${k}: ${v.toFixed(1)} fps (canvas ${canvas.width}×${canvas.height})`);
  r.dispose();
  const te = performance.now();
  const res = await renderFullResolution(document.createElement('canvas'), { full, proxy, luts: [], image: m, recipe: all, target: TARGET }, () => {}, tick);
  const exportMs = Math.round(performance.now() - te);
  log(`  export render (all effects, ${res.width}×${res.height}): ${(exportMs / 1000).toFixed(1)} s`);
  const exportBase = performance.now();
  await renderFullResolution(document.createElement('canvas'), { full, proxy, luts: [], image: m, recipe: base, target: TARGET }, () => {}, tick);
  const exportBaseMs = Math.round(performance.now() - exportBase);
  log(`  export render (default recipe): ${(exportBaseMs / 1000).toFixed(1)} s`);
  const gl = (canvas.getContext('webgl2') as WebGL2RenderingContext);
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  return { megapixels: (W * H) / 1e6, canvas: [canvas.width, canvas.height], fps, exportMs, exportBaseMs, gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown' };
}

let profImage: { full: FloatImage; proxy: FloatImage } | null = null;

/** Drag-exposure frame rate for recipe variants (deep-merged patches onto allEffects()). */
export async function profile(patches: Record<string, unknown>, W = 8064, H = 6048, frames = 40) {
  profImage ??= (() => { const full = syntheticImage(W, H); return { full, proxy: proxyOf(full, 2560) }; })();
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
  const r = new ViewRenderer(canvas);
  const img = { id: 1, width: W, height: H, ...profImage, thumb: profImage.proxy, model: model(W, H), isRaw: false, bitDepth: 16 } as unknown as LoadedImage;
  await r.setImage(img);
  const merge = (a: unknown, b: unknown): unknown => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
    const o = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b)) o[k] = merge(o[k], v);
    return o;
  };
  const out: Record<string, number> = {};
  for (const [name, patch] of Object.entries(patches)) {
    const rec = merge(allEffects(), patch) as Recipe;
    out[name] = await measureFps(r, (i) => ({ ...rec, light: { ...rec.light, exposure: Math.sin(i / 6) * 0.5 } }), frames);
    out[`${name}:cpuMs`] = lastCpuMs;
    log(`  ${name}: ${out[name].toFixed(1)} fps (CPU ${lastCpuMs.toFixed(1)} ms / frame)`);
  }
  r.dispose();
  return out;
}

(window as unknown as Record<string, unknown>).__bench = { seamTest, bench, profile };
document.getElementById('seam')!.onclick = () => void seamTest();
document.getElementById('run')!.onclick = () => void bench();
log('Ready. Run the seam test or the benchmark.');
