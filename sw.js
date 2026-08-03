/* Jukugo service worker: precache the app shell so it works fully offline.
 * Bump CACHE whenever any cached file changes (forces clients to refresh). */
var CACHE = "jukugo-2026-08-03.9";
var ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./data.js",
  "./styles.css",
  "./config.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  // Only handle our own same-origin GETs. OpenAI (and any other cross-origin)
  // requests pass straight through to the network, never cached.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // Navigations: serve the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(function () { return caches.match("./index.html"); }));
    return;
  }

  // Everything else: cache-first, then network (and cache the result).
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    });
  }));
});
