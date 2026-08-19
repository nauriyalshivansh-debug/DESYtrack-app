// iFuelTracker service worker — makes the app installable and offline-capable.
// Strategy: HTML is network-first (so new deploys show up), static assets are
// cache-first (fast + offline), and /api/* is always fetched live (never cached),
// so sample data and the live board are always fresh.
// Note: the marketing landing page lives at "/" and the app (SPA) at "/app".
const CACHE = 'ifueltracker-v3';
const SHELL = ['/', '/app', '/landing.html', '/index.html', '/vendor/qrcode.js',
  '/vendor/jsQR.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Tolerate any single missing shell URL so install never fails outright.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
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

  if (req.mode === 'navigate') {                    // HTML: network-first, cache per-URL
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then((c) =>
          c || caches.match(url.pathname.startsWith('/app') ? '/app' : '/')
        ))
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
