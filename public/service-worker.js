const CACHE_VERSION = 'v3';
const CACHE_NAME = `yarnl-${CACHE_VERSION}`;

// Install — take over immediately
self.addEventListener('install', () => self.skipWaiting());

// Activate — clean up old caches, claim clients
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
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
