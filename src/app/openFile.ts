import { useImage } from '../state/imageStore';

/** Proxy long edge = min(original, 2 × canvas CSS size × DPR, 4096); the worker caps at the original. */
export function proxyLongEdge(): number {
  const canvas = document.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const css = canvas ? Math.max(canvas.clientWidth, canvas.clientHeight) : Math.max(window.innerWidth, window.innerHeight);
  return Math.min(4096, Math.ceil(2 * css * dpr));
}

export function openFile(file: File) {
  void useImage.getState().load(file, proxyLongEdge());
}
