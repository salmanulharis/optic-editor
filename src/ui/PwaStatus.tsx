import { t as tr } from '../i18n';
/** "Offline ready" indicator and the update prompt (top bar). */
import { applyUpdate, usePwa } from '../app/pwa';

export function PwaStatus() {
  const offline = usePwa((s) => s.offlineReady);
  const refresh = usePwa((s) => s.needRefresh);
  return (
    <>
      {refresh && (
        <div className="flex items-center gap-2 rounded bg-info-bg px-2 py-1 text-2xs text-ink" role="status" aria-live="polite">{tr('pwaStatus.new_version_available')}<button className="rounded bg-accent px-2 py-0.5 font-medium text-on-accent hover:bg-accent-hi" onClick={() => void applyUpdate()}>{tr('pwaStatus.reload')}</button>
          <button className="text-info hover:text-strong" aria-label={tr('pwaStatus.later')} onClick={() => usePwa.getState().set({ needRefresh: false })}>✕</button>
        </div>
      )}
      {offline && !refresh && (
        <span className="flex items-center gap-1 text-2xs text-ink-faint" title={tr('pwaStatus.optic_is_installed_for_offline_use')}>
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden /> {tr('pwaStatus.offline_ready')}</span>
      )}
    </>
  );
}
