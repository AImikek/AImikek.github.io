// Tasks service worker. Page is network-first (deploys land instantly), with a cached
// copy as the offline fallback. Static files, Firebase SDK and fonts are cache-first so
// the app opens with no connection.
const SHELL = 'tasks-v2026-10-20.1547';
const STATIC = ['./', 'index.html', 'firebase-config.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest'];
const CACHE_ORIGINS = ['https://www.gstatic.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(STATIC).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('version.json')) return; // always straight from the network
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  const cacheable = sameOrigin || CACHE_ORIGINS.includes(url.origin);
  if (!cacheable) return; // Firebase database/auth traffic: untouched
  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/tasks/') || url.pathname.endsWith('/tasks');
  if (isPage) {
    // Ask the server every time (revalidate, never trust the 10-minute HTTP cache GitHub Pages sets)
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {}); return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./') || caches.match('index.html'))));
    return;
  }
  const revalidate = sameOrigin && /firebase-config\.js|manifest\.webmanifest/.test(url.pathname);
  if (revalidate) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {}); } return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {}); }
    return r;
  })));
});
