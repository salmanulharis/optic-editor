/**
 * AI masks for the open photo: one RGBA8 bitmap per model (≈ 1024 px long edge, in the undistorted
 * source frame), kept in the mask registry for the renderer and in IndexedDB so a reload does not
 * re-run the model. Models are loaded lazily on first use (runModels.ts) and cached for offline use.
 * Everything runs on this device.
 */
import { create } from 'zustand';
import { type AiModelId, aiCacheKey } from '../recipe/masks';
import { maskRegistry, type MaskBitmap } from '../pipeline/maskRegistry';
import { dbGet, dbPut } from '../storage/db';
import { useImage } from '../state/imageStore';
import { useUi } from '../state/uiStore';

export type AiState = 'idle' | 'loading' | 'running' | 'ready' | 'error';

interface AiStatus {
  state: AiState;
  /** 0…1 while the model downloads. */
  progress: number;
  message: string;
}

interface AiStore {
  status: Partial<Record<AiModelId, AiStatus>>;
  set(model: AiModelId, s: Partial<AiStatus>): void;
}

export const useAi = create<AiStore>((set, get) => ({
  status: {},
  set(model, s) {
    const cur = get().status[model] ?? { state: 'idle', progress: 0, message: '' };
    set({ status: { ...get().status, [model]: { ...cur, ...s } } });
  },
}));

const inflight = new Map<string, Promise<void>>();

/** Make sure the open photo's bitmap for `model` is in the registry (cache, else run the model). */
export function ensureAiMask(model: AiModelId): Promise<void> {
  const img = useImage.getState().image;
  if (!img) return Promise.resolve();
  const key = aiCacheKey(img.model.key, model);
  if (maskRegistry.has(key)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const st = useAi.getState();
    try {
      const cached = await dbGet<MaskBitmap>('aimasks', key);
      if (cached?.data?.length) {
        maskRegistry.set({ ...cached, data: new Uint8Array(cached.data) });
        st.set(model, { state: 'ready', progress: 1, message: '' });
        return;
      }
      st.set(model, { state: 'loading', progress: 0, message: 'Loading model' });
      const { runAiModel } = await import('./runModels');
      const bmp = await runAiModel(model, img, (progress, message) => st.set(model, { state: progress < 1 ? 'loading' : 'running', progress, message }));
      if (useImage.getState().image?.model.key !== img.model.key) return;
      const b: MaskBitmap = { key, ...bmp };
      maskRegistry.set(b);
      st.set(model, { state: 'ready', progress: 1, message: '' });
      dbPut('aimasks', b).catch((e) => console.warn('[optic] AI mask not cached', e));
    } catch (e) {
      console.warn(`[optic] AI mask (${model}) failed`, e);
      st.set(model, { state: 'error', progress: 0, message: (e as Error).message || String(e) });
    } finally {
      inflight.delete(key);
      // Repaint: the bitmap feeds the next frame.
      useUi.getState().set({ analysisTick: useUi.getState().analysisTick + 1 });
    }
  })();
  inflight.set(key, job);
  return job;
}
