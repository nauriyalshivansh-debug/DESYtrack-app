// DESYtrack service worker — makes the app installable and offline-capable.
// Strategy: HTML is network-first (so new deploys show up), static assets are
// cache-first (fast + offline), and /api/* is always fetched live (never cached),
// so sample data and the live board are always fresh.
const CACHE = 'desytrack-v2';
const SHELL = ['/', '/index.html', '/vendor/qrcode.js', '/vendor/jsQR.js',
  '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never touch writes
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;     // always live data from the network

  if (req.mode === 'navigate') {                    // HTML: network-first, cache fallback
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('/index.html', cp)); return r; })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: cache-first, then network (and cache what we fetch).
  e.respondWith(
    caches.match(req).then((c) => c || fetch(req).then((r) => {
      const cp = r.clone(); caches.open(CACHE).then((cc) => cc.put(req, cp)); return r;
    }))
  );
});
