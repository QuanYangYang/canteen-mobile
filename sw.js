/* 离线缓存：应用壳 + 本地 vendor；不缓存任何业务数据。 */
const CACHE = 'canteen-mobile-20261114071326-03d4f241';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './parser.js',
  './workbook.js',
  './manifest.webmanifest',
  './vendor/xlsx.bundle.js',
  './vendor/cpexcel.js',
  './vendor/fflate.umd.js',
  './icons/logo-192.png',
  './icons/logo-512.png',
  './icons/logo.jpg',
];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('canteen-mobile-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((client) => client.postMessage({ type: 'SW_ACTIVATED', build: CACHE })))
  );
});

function isNetworkFirst(pathname) {
  return /\/(?:app|parser|workbook)\.js$/.test(pathname) ||
    /\/styles\.css$/.test(pathname) ||
    /\/index\.html$/.test(pathname) ||
    pathname.endsWith('/');
}

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function putCache(request, response) {
  if (!response || !response.ok) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch (e) { /* 容量/隐私模式失败时不影响网络响应 */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  /* 版本文件只走网络，避免被缓存成旧版本。 */
  if (url.pathname.endsWith('/version.json')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetchWithTimeout(req, 2500);
        if (fresh && fresh.ok) {
          await putCache(new Request('./index.html'), fresh);
          return fresh;
        }
      } catch (e) { /* 离线或超时 */ }
      const cached = await caches.match('./index.html');
      return cached || new Response('离线页面尚未缓存，请联网后重新打开。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }

  if (isNetworkFirst(url.pathname)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetchWithTimeout(req, 2500);
        if (fresh && fresh.ok) {
          await putCache(req, fresh);
          return fresh;
        }
      } catch (e) { /* 回退缓存 */ }
      return (await caches.match(req)) || new Response('', { status: 503 });
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      await putCache(req, fresh);
      return fresh;
    } catch (e) {
      return new Response('', { status: 503 });
    }
  })());
});
