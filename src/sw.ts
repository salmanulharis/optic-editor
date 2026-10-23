/**
 * Service worker (Workbox, injectManifest):
 *  - precaches the app shell, every WASM module (decoders, encoders, ONNX Runtime, MediaPipe), the
 *    built-in presets and LUTs, so Optic works fully offline after the first visit;
 *  - adds the cross-origin isolation headers (COOP / COEP / CORP) to everything it serves, so
 *    SharedArrayBuffer keeps working when pages come from the cache (and on hosts that cannot set
 *    headers);
 *  - caches AI models on first download (they are also kept in Cache Storage by the app);
 *  - receives photos shared from other apps (Web Share Target) and hands them to the app;
 *  - waits for the user to accept an update ("New version available — Reload").
 */
import { addPlugins, cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

type Ev = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEv = Ev & { request: Request; respondWith(r: Response | Promise<Response>): void };
interface SW {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(o?: unknown): Promise<Array<{ postMessage(m: unknown): void }>> };
  addEventListener(t: 'message', f: (e: MessageEvent) => void): void;
  addEventListener(t: 'fetch', f: (e: FetchEv) => void): void;
  addEventListener(t: 'activate', f: (e: Ev) => void): void;
}
declare const self: SW;

const SHARE_CACHE = 'optic-shared';

/** COOP / COEP / CORP on a response (a copy: cached responses are immutable). */
function isolate(r: Response): Response {
  if (r.status === 0 || r.type === 'opaque') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

const isolatePlugin = { fetchDidSucceed: async ({ response }: { response: Response }) => response, cachedResponseWillBeUsed: async ({ cachedResponse }: { cachedResponse?: Response }) => (cachedResponse ? isolate(cachedResponse) : cachedResponse) };

cleanupOutdatedCaches();
// Workers and WASM served from the precache need the headers too.
addPlugins([isolatePlugin]);
precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/^v$/, /^share$/, /^t$/] });

// Single-page app: every navigation gets the cached index.html (with isolation headers).
const shell = createHandlerBoundToURL('/index.html');
registerRoute(new NavigationRoute(async (o) => isolate(await shell(o)), { denylist: [/^\/share-target/, /^\/bench/] }));

// AI models (same origin or the public mirrors): cache on first use, keep for offline.
registerRoute(
  ({ url }) => url.pathname.startsWith('/models/') || url.hostname.endsWith('huggingface.co') || url.hostname.endsWith('hf.co') || url.hostname === 'storage.googleapis.com',
  new CacheFirst({ cacheName: 'optic-model-files', plugins: [new ExpirationPlugin({ maxEntries: 12 }), isolatePlugin] }),
);

// Share target: photos shared from the Photos app / Files arrive as a POST.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/share-target' && e.request.method === 'POST') {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('photos').filter((f): f is File => f instanceof File);
      const cache = await caches.open(SHARE_CACHE);
      await Promise.all(files.map((f, i) => cache.put(`/shared/${Date.now()}-${i}/${encodeURIComponent(f.name)}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name), 'x-last-modified': String(f.lastModified) } }))));
      return Response.redirect('/?share=1', 303);
    })());
    return;
  }
});

self.addEventListener('message', (e) => {
  if ((e.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
