/*
 * The service worker template.
 *
 * vite.config.js substitutes the two placeholders below - the cache version, and the
 * list of files that actually exist - and writes sw.js. Two things are deliberate:
 *
 *  - The precache list is generated from the directory, never typed by hand. A hand-written list is
 *    how an app becomes "offline" while quietly needing the network for one stylesheet.
 *  - The cache name is the hash of the shell's contents, so shipping a change retires the old cache
 *    on activate instead of leaving a stale page behind.
 */

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const PASSTHROUGH_RE = /(?:^|\/)(?:robots\.txt|sitemap\.xml|llms\.txt|og-image\.png)$/;

async function cleanResponse(response) {
  if (!response.redirected) return response;
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(
        PRECACHE.map(async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Precache failed for ${url}: ${response.status}`);
          await cache.put(url, await cleanResponse(response));
        })
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache or touch anything cross-origin. This app has no third-party requests at all, and
  // keeping it that way is what makes "works offline" a property rather than a hope.
  if (url.origin !== self.location.origin) return;
  // Crawler and social-preview assets live outside the offline precache so updates reach bots directly.
  if (PASSTHROUGH_RE.test(url.pathname)) return;

  // A navigation is served the exact cached file if one matches (e.g. LICENSE.txt), otherwise the
  // cached shell (index.html), so opening the app or reading the licence with no network works.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(request)
        .then((hit) => hit || caches.match('index.html'))
        .then((hit) => hit || fetch(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic' && !response.redirected) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        });
    })
  );
});
