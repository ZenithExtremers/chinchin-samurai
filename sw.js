/* ちんちん侍：オフラインでも開けるようにするキャッシュ。
   版を上げたら CACHE の番号も上げる（古いキャッシュは消える） */
const CACHE = 'chinchin-samurai-v1.4.0';
const ASSETS = ['./', './index.html', './voices.js', './online.js', './firebase-config.js', './CHANGELOG.md', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 自分のサイトのファイルだけ：まずネット、つながらなければキャッシュ（Firebase などはそのまま通す）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // ブラウザに残った古いファイルを使わず、毎回サーバーに新しい版がないか確かめる
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
