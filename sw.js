/* Service worker for the public storefront (PWA).
 *
 * Deliberately minimal and privacy-safe:
 *  - /api/*, /admin*, /uploads/* and every non-GET request go straight to the network: no orders, sessions,
 *    credentials, catalogue data or admin pages are ever stored in the cache.
 *  - Page navigations are network-first; only a static offline notice is cached as the fallback, so a customer
 *    never sees stale prices or stock.
 *  - Only the bundled, public site files (/assets: styles, script, fonts, brand photos; /icons) are cached.
 *    The storefront's own stylesheet and script are served stale-while-revalidate so an update is picked up on the next visit.
 */
const CACHE = 'fakhama-static-v3';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/assets/css/plus.css',
  '/assets/js/plus.js',
  '/assets/fonts/el-messiri-arabic-700-normal.woff2',
  '/assets/fonts/el-messiri-arabic-600-normal.woff2',
];
const NEVER_CACHE_PREFIXES = ['/api/', '/admin', '/uploads/'];
const SHELL_ASSET = /^\/assets\/(css|js)\//;
const MAX_RUNTIME_ENTRIES = 90;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('fakhama-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function remember(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy).then(() => cache.keys()).then(keys => {
    const extra = keys.length - (PRECACHE.length + MAX_RUNTIME_ENTRIES);
    return extra > 0 ? Promise.all(keys.slice(PRECACHE.length, PRECACHE.length + extra).map(k => cache.delete(k))) : null;
  })).catch(() => {});
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (SHELL_ASSET.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(hit => {
        const network = fetch(request, { cache: 'no-cache' }).then(response => remember(request, response)).catch(() => hit || Response.error());
        return hit || network;
      })
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(response => remember(request, response)))
    );
  }
});
