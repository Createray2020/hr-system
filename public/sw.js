// public/sw.js — CHUWA HR Service Worker
//
// 策略(Phase 1.4.6 修):
//   - HTML / navigation:network-first(3s timeout、failure fallback cache)
//     deploy 後員工首次拉頁面就拿新版、不需要 unregister SW
//   - 其他資源(JS / CSS / image / font):stale-while-revalidate
//     先回 cache(快)、背景更新、下次 reload 拿新
//   - API:不攔截、永遠走 network
//
// 版本機制:CACHE_NAME 帶 VERSION、SW 本身改動時 bump VERSION 觸發
// install 新 cache + activate 清舊。前端 HTML/JS/CSS 改動不需 bump
// (network-first 會自動拿新、SWR 背景同步)。
const VERSION = '2026-05-05-2040';
const CACHE_NAME = `chuwa-hr-${VERSION}`;
const STATIC_ASSETS = [
  '/', '/dashboard.html', '/login.html',
  '/css/style.css', '/js/layout.js', '/manifest.json',
];

// 安裝:逐個 add + try/catch、單檔失敗不整批失敗(修 addAll latent bug)
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(STATIC_ASSETS.map(async url => {
      try { await cache.add(url); }
      catch (e) { console.error('[SW] precache fail:', url, e); }
    }));
  })());
  self.skipWaiting();
});

// 啟動:清非當前版本的舊 cache + claim 已開的 client tab
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// fetch:依資源類型分流
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // API 不攔截
  if (url.pathname.startsWith('/api/')) return;

  // Navigation / HTML → network-first(3s timeout、fallback cache)
  // mode==='navigate' 涵蓋頁面導航;Accept: text/html 涵蓋 SPA-style fetch
  const isHtml = req.mode === 'navigate' ||
                 (req.headers.get('Accept') || '').includes('text/html');
  if (isHtml) {
    event.respondWith(networkFirstWithTimeout(req, 3000));
    return;
  }

  // 其他資源 → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirstWithTimeout(req, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fresh = await fetch(req, { signal: controller.signal });
    clearTimeout(timer);
    // 順手更新 cache(部分瀏覽器 navigation 不自動寫)
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // 最後 fallback /dashboard.html offline shell
    return (await caches.match('/dashboard.html')) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

// 推播通知接收
self.addEventListener('push', event => {
  console.log('[SW] 收到推播:', event.data?.text()?.slice(0, 80));
  if (!event.data) { console.log('[SW] 推播無資料'); return; }

  let data;
  try {
    data = event.data.json();
  } catch(e) {
    data = { title: 'CHUWA HR', body: event.data.text() };
  }

  const options = {
    body:               data.body || '',
    icon:               '/icons/icon-192.png',
    badge:              '/icons/icon-72.png',
    vibrate:            [200, 100, 200],
    data:               { url: data.url || '/dashboard.html' },
    tag:                data.tag || 'chuwa-notification',
    renotify:           true,
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'CHUWA HR', options)
      .then(() => console.log('[SW] 通知已顯示:', data.title))
      .catch(e => console.error('[SW] 通知顯示失敗:', e))
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
