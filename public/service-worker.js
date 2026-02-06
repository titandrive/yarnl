const CACHE_NAME = 'yarnl-cache';

// Install — no pre-cache; stale-while-revalidate builds cache from actual requests
self.addEventListener('install', () => {
  // No skipWaiting — new SW waits for old one to release clients naturally
});

// Activate — clean up old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
    // No clients.claim — avoids disrupting bfcache and running pages
  );
});

// Fetch — stale-while-revalidate for static assets, network-only for API
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls and auth — always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  // Serve from cache, update in background
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
