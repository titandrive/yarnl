// Minimal service worker — required for PWA install prompt
// No offline caching, just passes through to network
self.addEventListener('fetch', () => {});
