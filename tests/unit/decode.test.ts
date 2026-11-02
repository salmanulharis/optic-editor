import { afterEach, describe, expect, it } from 'vitest';
import { allocFloat, transferable } from '../../src/io/decode/imageOps';

// Android WebView (and any host without COOP/COEP) never defines SharedArrayBuffer. The decode
// workers used `b instanceof SharedArrayBuffer`, which threw a ReferenceError there and made every
// photo "unreadable".
const SAB = globalThis.SharedArrayBuffer;
afterEach(() => { (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = SAB; });

describe('decode buffers without cross-origin isolation', () => {
  it('lists transferable buffers when SharedArrayBuffer is undefined', () => {
    delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
    const a = new Float32Array(4), b = new Float32Array(8);
    expect(transferable([a.buffer, b.buffer])).toEqual([a.buffer, b.buffer]);
    expect(allocFloat(16).buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('keeps shared buffers out of the transfer list', () => {
    const shared = new SharedArrayBuffer(16), plain = new ArrayBuffer(16);
    expect(transferable([shared, plain])).toEqual([plain]);
  });
});
