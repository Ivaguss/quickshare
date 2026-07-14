// Минимальный service worker — нужен, чтобы приложение можно было «установить» как PWA.
// Кэшируем только оболочку; данные всегда берём с сервера (это буфer обмена в реальном времени).
const CACHE = 'quickshare-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API и WebSocket — только сеть, без кэша.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  // Оболочка — сеть с откатом на кэш (чтобы обновления подхватывались).
  e.respondWith(
    fetch(e.request).then((r) => {
      if (e.request.method === 'GET' && r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
