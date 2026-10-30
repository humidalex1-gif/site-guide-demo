/* Service worker: lets the guide work with weak or no signal inside the factory.
   - App files come from the network when it answers within 3 seconds (so
     updates show at once), otherwise from the saved copy.
   - Photos are cached the first time they load. The app also asks for every
     photo of the open site in advance (see "warm-photos" below).
   After changing the list of app files, bump VERSION so phones pick it up. */
const VERSION = "v3";
const APP_CACHE = "sg-app-" + VERSION;
const PHOTO_CACHE = "sg-photos";

const APP_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "data/i18n.js",
  "data/sites.js",
  "manifest.webmanifest",
  "assets/icon.svg"
];

self.addEventListener("install", (e) => {
  // "reload": skip the browser's own cache so a new version never saves stale files
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sg-app-") && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isPhoto = (url) => url.pathname.includes("/photos/");

// cache first, fetch only if missing; missing photos (404) are not stored
async function photo(req) {
  const cache = await caches.open(PHOTO_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

// latest version from the network when it answers within 3 s, otherwise the saved copy
async function appFile(e) {
  const cache = await caches.open(APP_CACHE);
  // ?site=…&here=… links (QR codes) all use the same cached page
  const key = e.request.mode === "navigate" ? e.request.url.split("?")[0] : e.request;
  // "no-cache": always ask the server (GitHub Pages lets browsers keep files 10 min)
  const fresh = fetch(e.request, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  e.waitUntil(fresh.catch(() => {})); // keep updating the cache even if we answer from it
  const slow = new Promise((resolve) => setTimeout(resolve, 3000));
  const res = await Promise.race([fresh.catch(() => null), slow]);
  if (res && res.ok) return res;
  return (await cache.match(key)) || fresh;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(isPhoto(url) ? photo(e.request) : appFile(e));
});

// the app sends the photo paths for the open site; fetch any not cached yet
self.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "warm-photos") return;
  e.waitUntil(Promise.all(e.data.urls.map((u) => photo(new Request(u)).catch(() => {}))));
});
