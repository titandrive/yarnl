const CACHE_NAME = 'yarnl-cache-v6';

// Install — pre-cache static assets only (not HTML)
// skipWaiting ensures new SW activates immediately (no stuck "waiting" state)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled([
        cache.add('/app.js'),
        cache.add('/styles.css'),
        cache.add('/manifest.json'),
      ])
    )
  );
  self.skipWaiting();
});

// Activate — clean up old caches and take control of all tabs immediately
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - HTML navigation requests: network-first (always fresh, fall back to cache offline)
// - Static assets: stale-while-revalidate (fast loads, updated in background)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls and auth — always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  // HTML navigation requests — network-first
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((response) => {
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, response.clone()));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets — stale-while-revalidate
  e.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(e.request, { ignoreSearch: true }).then((cached) => {
        const fetched = fetch(e.request).then((response) => {
          if (response.ok) {
            cache.put(e.request, response.clone());
          }
          return response;
        }).catch(() => cached);
        return cached || fetched;
      })
    )
  );
});
