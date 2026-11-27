// Deck Forge service worker: lets the installed app open instantly and work offline.
//  - App files (page, styles, scripts, icons): served fresh from the network when online,
//    from the cache when offline. Updates show up on the next launch.
//  - Card pictures: cached as you view them, so your collection still shows offline.
//  - Card database / tournament / price lookups always go to the network (they're live data;
//    the app keeps its own copies of what it needs in browser storage).
const VERSION = 'v2'; // bump with the ?v= value in index.html on each release
const APP_CACHE = `deck-forge-app-${VERSION}`;
const IMG_CACHE = 'deck-forge-images';
const APP_FILES = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './cards.js', './engine.js', './sim.js', './sample.js', './scanner.js', './meta.js', './matchup.js', './upgrade.js', './app.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const MAX_IMAGES = 600;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('deck-forge-app-') && key !== APP_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Our own files: network first (always up to date), cache as the offline fallback
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(APP_CACHE); c.put(stripVersion(req), res.clone()); }
        return res;
      } catch (e) {
        const hit = await caches.match(stripVersion(req), { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw e;
      }
    })());
    return;
  }

  // Card pictures: cache first, fetched once
  if (url.hostname === 'assets.tcgdex.net' && /\.(webp|png|jpg)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const c = await caches.open(IMG_CACHE);
      const hit = await c.match(req.url);
      if (hit) return hit;
      // Fetch with CORS (the image server allows it) so the cache stores the real, small file
      // instead of an "opaque" response that browsers count as several MB each.
      let res;
      try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); }
      catch (e) { return fetch(req); }
      if (res.ok) { c.put(req.url, res.clone()); trimImages(c); }
      return res;
    })());
    return;
  }

  // Fonts: cache first (they never change)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(APP_CACHE).then(async c => (await c.match(req)) || fetch(req).then(res => { c.put(req, res.clone()); return res; })));
  }
  // Everything else (card database, tournaments, prices, text reader): straight to the network
});

// "style.css?v=123" and "style.css" are the same file for offline purposes
function stripVersion(req) {
  const u = new URL(req.url);
  u.search = '';
  return new Request(u.toString());
}

let trimming = false;
async function trimImages(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]);
  } finally { trimming = false; }
}
