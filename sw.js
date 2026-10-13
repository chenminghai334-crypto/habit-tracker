/* sw.js — 离线缓存 + 通知点击处理 */

const CACHE = 'habit-tracker-v2';
// 改动静态文件后，把上面的版本号 +1，用户端就会自动更新缓存。
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logic.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const habitId = event.notification?.data?.habitId;
  const markDone = event.action === 'done';
  event.notification.close();

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      let client = list.find((c) => c.url.startsWith(self.registration.scope)) || list[0];
      if (!client) {
        client = await self.clients.openWindow('./index.html');
        return;
      }
      if (markDone && habitId) client.postMessage({ type: 'complete', habitId });
      if (client.focus) await client.focus();
    })(),
  );
});
