import type { StageContext } from './types';

/**
 * Size of an image-wide map: the output frame at `edge` texels per source long edge (so a crop
 * keeps the same texel density, and every effect radius stays a fraction of the source).
 */
export function mapDims(ctx: Pick<StageContext, 'geo' | 'longEdge'>, edge: number): { w: number; h: number } {
  const k = edge / ctx.longEdge;
  return { w: Math.max(8, Math.round(ctx.geo.outW * k)), h: Math.max(8, Math.round(ctx.geo.outH * k)) };
}
