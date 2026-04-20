// public/sw.js — CHUWA HR Service Worker
const CACHE_NAME = 'chuwa-hr-v1';
const STATIC_ASSETS = [
  '/',
  '/dashboard.html',
  '/login.html',
  '/css/style.css',
  '/js/layout.js',
  '/manifest.json',
];

// 安裝：快取靜態資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 啟動：清除舊快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 攔截請求：API 不快取，靜態資源優先用快取
self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/')) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// 推播通知接收
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body:     data.body || '',
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-72.png',
    vibrate:  [200, 100, 200],
    data:     { url: data.url || '/dashboard.html' },
    actions:  data.actions || [],
    tag:      data.tag || 'chuwa-notification',
    renotify: true,
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'CHUWA HR', options)
  );
});

// 點擊通知
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
