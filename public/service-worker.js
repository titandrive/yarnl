const CACHE_NAME = 'yarnl-cache-v4';

// Install — pre-cache critical assets for instant PWA loads
// skipWaiting ensures new SW activates immediately (no stuck "waiting" state)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled([
        cache.add('/'),
        cache.add('/app.js'),
        cache.add('/styles.css'),
        cache.add('/manifest.json'),
      ])
    )
  );
  self.skipWaiting();
});

// Activate — clean up old caches
// Note: no clients.claim() — new SW only controls pages opened after activation.
// This avoids disrupting the current session and improves bfcache eligibility.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
});

// Fetch — stale-while-revalidate for all cacheable requests
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls and auth — always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  // Stale-while-revalidate: serve cached immediately, update in background
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
