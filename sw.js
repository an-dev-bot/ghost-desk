// Service worker: keeps the app itself available offline (portfolio and history work without internet).
// It only caches the app's own files and the fonts. Price requests are never intercepted or stored,
// so a URL that carries an API key (Finnhub) never ends up in any cache.

const VERSION = "g1-2026-11-23o";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/store.js",
  "js/core/money.js", "js/core/engine.js", "js/core/hours.js", "js/core/stats.js", "js/core/achievements.js",
  "js/core/candles.js", "js/core/backup.js", "js/core/sanitize.js", "js/core/bots.js", "js/core/cheats.js", "js/core/rich.js", "js/core/replay.js", "js/sim/world.js", "js/sim/fun.js", "js/sim/rewind.js",
  "js/sources/http.js", "js/sources/dex.js", "js/sources/crypto.js", "js/sources/stocks.js", "js/sources/twelve.js", "js/sources/fx.js",
  "js/ui/format.js", "js/ui/chart.js", "js/ui/effects.js", "js/ui/swipe.js", "js/ui/notify.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/badge-96.png",
];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes("/tests/")) return; // tests always hit the network
    e.respondWith(appFile(e, req, req.mode === "navigate"));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(font(req));
  }
  // Everything else (price APIs) goes straight to the network, never cached.
});

async function appFile(e, req, nav) {
  const cache = await caches.open(VERSION);
  const key = nav ? "index.html" : req;
  const hit = await cache.match(key, { ignoreSearch: nav });
  const net = fetch(req).then(r => {
    if (r.ok && r.type === "basic") cache.put(nav ? "index.html" : req, r.clone());
    return r;
  }).catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  return (await net) || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function font(req) {
  const cache = await caches.open(VERSION + "-fonts");
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok || r.type === "opaque") cache.put(req, r.clone());
    return r;
  } catch {
    return new Response("", { status: 504 });
  }
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./#inicio");
  })());
});
