// PB Tourney service worker.
// DESIGN RULE: never trap users on an old version. The page itself (and version.json)
// is always fetched network-first, so deploys land exactly like before — this worker
// only adds installability and an offline fallback. Static assets are cache-first.
const SHELL = 'pbt-shell-v1';
const STATIC = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest', 'legal-style.css'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(STATIC).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;             // Firebase, fonts, CDNs: untouched
  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('version.json');
  if (isPage) {
    // network first, cache as offline fallback
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: url.pathname.endsWith('version.json') ? false : true })));
    return;
  }
  // static: cache first
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
    return r;
  })));
});
