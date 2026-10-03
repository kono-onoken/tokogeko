/* とうげこう Service Worker
 * アプリ本体（index.html / manifest / アイコン）をキャッシュして、電波がなくても起動できるようにする。
 * 更新するときは CACHE のバージョン番号を上げる（古いキャッシュは activate で削除される）。
 * GAS など別オリジンへのリクエストは一切さわらない（キャッシュしない）。
 */
const CACHE = 'tokogeko-v2';
const PAGE = './index.html';
const ASSETS = [
  './',
  PAGE,
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tokogeko-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // GAS などは素通し
  event.respondWith(respond(event, req));
});

// キャッシュ優先 + 裏で更新（次回起動時に新しい版になる）
async function respond(event, req) {
  const cache = await caches.open(CACHE);
  const isNav = req.mode === 'navigate';
  const key = isNav ? PAGE : req;
  const cached = await cache.match(key, { ignoreSearch: true });

  const update = fetch(req, { cache: 'no-cache' })
    .then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  return (await update) || new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
