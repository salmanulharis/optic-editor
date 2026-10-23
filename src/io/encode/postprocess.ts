/**
 * Export post-processing on the 16-bit encoded image (worker): centre crop to an exact aspect,
 * output sharpening for the medium, and the watermark.
 */
import type { SharpenAmount, SharpenTarget, Watermark } from './exportSettings';

export function cropCenter(rgb: Uint16Array, W: number, H: number, w: number, h: number): Uint16Array {
  if (w === W && h === H) return rgb;
  const x0 = Math.floor((W - w) / 2), y0 = Math.floor((H - h) / 2);
  const out = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) out.set(rgb.subarray(((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + w) * 3), y * w * 3);
  return out;
}

/** Radius (output px) and strength per medium: screens need little, matte paper the most. */
const SHARPEN: Record<Exclude<SharpenTarget, 'none'>, { radius: number; amount: Record<SharpenAmount, number> }> = {
  screen: { radius: 0.6, amount: { low: 0.35, standard: 0.6, high: 0.9 } },
  glossy: { radius: 0.9, amount: { low: 0.45, standard: 0.75, high: 1.1 } },
  matte: { radius: 1.2, amount: { low: 0.6, standard: 1.0, high: 1.4 } },
};

function blur1d(src: Float32Array, dst: Float32Array, w: number, h: number, k: Float32Array, horizontal: boolean) {
  const r = (k.length - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x;
        const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
        acc += src[yy * w + xx] * k[i + r];
      }
      dst[y * w + x] = acc;
    }
  }
}

/**
 * Unsharp mask on luminance (no colour fringes), with a small threshold so noise and smooth
 * gradients are left alone. The luminance difference is added to all three channels.
 */
export function sharpenForOutput(rgb: Uint16Array, w: number, h: number, target: SharpenTarget, amount: SharpenAmount): Uint16Array {
  if (target === 'none') return rgb;
  const { radius, amount: a } = SHARPEN[target];
  const k0 = a[amount];
  const r = Math.max(1, Math.ceil(radius * 3));
  const kernel = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { kernel[i + r] = Math.exp(-(i * i) / (2 * radius * radius)); s += kernel[i + r]; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= s;
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = (0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]) / 65535;
  const t = new Float32Array(n), B = new Float32Array(n);
  blur1d(Y, t, w, h, kernel, true);
  blur1d(t, B, w, h, kernel, false);
  const out = new Uint16Array(rgb.length);
  const thr = 0.004;
  for (let i = 0; i < n; i++) {
    const d = Y[i] - B[i];
    const m = Math.abs(d) < thr ? 0 : d - Math.sign(d) * thr;
    const add = Math.round(k0 * m * 65535);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(65535, Math.max(0, rgb[i * 3 + c] + add));
  }
  return out;
}

const ANCHOR: Record<Watermark['position'], [number, number]> = {
  tl: [0, 0], tc: [0.5, 0], tr: [1, 0], cl: [0, 0.5], c: [0.5, 0.5], cr: [1, 0.5], bl: [0, 1], bc: [0.5, 1], br: [1, 1],
};

/** Composite a text or PNG watermark (8-bit, alpha) into the 16-bit image, in place. */
export async function applyWatermark(rgb: Uint16Array, w: number, h: number, wm: Watermark): Promise<void> {
  if (!wm.enabled || (wm.kind === 'text' ? !wm.text.trim() : !wm.image)) return;
  const long = Math.max(w, h);
  const margin = Math.round((wm.margin / 100) * long);
  let mark: OffscreenCanvas;
  if (wm.kind === 'text') {
    const px = Math.max(8, Math.round((wm.size / 100) * long));
    const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
    const font = `500 ${px}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    probe.font = font;
    const tw = Math.ceil(probe.measureText(wm.text).width) + 4;
    mark = new OffscreenCanvas(Math.min(w, tw), Math.ceil(px * 1.35));
    const ctx = mark.getContext('2d')!;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = wm.color === 'black' ? '#000' : '#fff';
    ctx.fillText(wm.text, 2, mark.height / 2);
  } else {
    const bmp = await createImageBitmap(new Blob([wm.image! as BlobPart], { type: 'image/png' }));
    const tw = Math.max(8, Math.round((wm.size * 5 / 100) * long));
    const th = Math.max(1, Math.round((bmp.height / bmp.width) * tw));
    mark = new OffscreenCanvas(Math.min(w, tw), Math.min(h, th));
    const ctx = mark.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, mark.width, mark.height);
    bmp.close();
  }
  const [ax, ay] = ANCHOR[wm.position];
  const x0 = Math.round(margin + ax * (w - 2 * margin - mark.width));
  const y0 = Math.round(margin + ay * (h - 2 * margin - mark.height));
  const d = mark.getContext('2d')!.getImageData(0, 0, mark.width, mark.height).data;
  const op = Math.max(0, Math.min(1, wm.opacity / 100));
  for (let y = 0; y < mark.height; y++) {
    const yy = y0 + y;
    if (yy < 0 || yy >= h) continue;
    for (let x = 0; x < mark.width; x++) {
      const xx = x0 + x;
      if (xx < 0 || xx >= w) continue;
      const s = (y * mark.width + x) * 4;
      const a = (d[s + 3] / 255) * op;
      if (a <= 0) continue;
      const o = (yy * w + xx) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(rgb[o + c] * (1 - a) + d[s + c] * 257 * a);
    }
  }
}

/** Minimal XMP packet with author and copyright (Dublin Core + XMP Rights). */
export function buildXmp(artist: string, copyright: string): string | null {
  if (!artist && !copyright) return null;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Optic">
${artist ? `<dc:creator><rdf:Seq><rdf:li>${esc(artist)}</rdf:li></rdf:Seq></dc:creator>` : ''}
${copyright ? `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${esc(copyright)}</rdf:li></rdf:Alt></dc:rights><xmpRights:Marked>True</xmpRights:Marked>` : ''}
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}
