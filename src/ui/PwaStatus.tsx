/** "Offline ready" indicator and the update prompt (top bar). */
import { applyUpdate, usePwa } from '../app/pwa';

export function PwaStatus() {
  const offline = usePwa((s) => s.offlineReady);
  const refresh = usePwa((s) => s.needRefresh);
  return (
    <>
      {refresh && (
        <div className="flex items-center gap-2 rounded bg-[#2c3a4a] px-2 py-1 text-[11px] text-[#cfe0f0]" role="status" aria-live="polite">
          New version available
          <button className="rounded bg-accent px-2 py-0.5 font-medium text-on-accent hover:bg-accent-hi" onClick={() => void applyUpdate()}>Reload</button>
          <button className="text-[#9fb4c8] hover:text-strong" aria-label="Later" onClick={() => usePwa.getState().set({ needRefresh: false })}>✕</button>
        </div>
      )}
      {offline && !refresh && (
        <span className="flex items-center gap-1 text-[10px] text-ink-faint" title="Optic is installed for offline use: everything works without a connection (AI models after their first download).">
          <span className="h-1.5 w-1.5 rounded-full bg-[#6cbf6c]" aria-hidden /> Offline ready
        </span>
      )}
    </>
  );
}
