const CACHE_NAME = 'yarnl-cache-v2';

// Core app files — use network-first so updates are immediate
const CORE_FILES = ['/app.js', '/styles.css', '/index.html', '/'];

// Install — no pre-cache; cache builds from actual requests
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Activate — clean up old caches and take control immediately
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — network-first for core app files, stale-while-revalidate for others
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls and auth — always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  // Core app files — network-first so updates load immediately
  if (CORE_FILES.includes(url.pathname)) {
    e.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        fetch(e.request).then((response) => {
          if (response.ok) cache.put(e.request, response.clone());
          return response;
        }).catch(() => cache.match(e.request))
      )
    );
    return;
  }

  // Everything else — stale-while-revalidate (PDF.js, fonts, icons, etc.)
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
