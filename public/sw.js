/* FleetIQ service worker (DEC-43, ARCH §6.9). Plain JS, no dependency.
 *
 * WHAT IS CACHED (and nothing else):
 *   1. /_next/static/*   the app's own hashed scripts, styles and fonts (cache-first). Public build output, no user data.
 *   2. /offline          the signed-out-safe offline shell: a static page that draws the driver screens from the phone's own
 *                        IndexedDB (network-first, the cached copy is used only when the network fails).
 *   3. the app icon / favicon.
 * WHAT IS NEVER CACHED:
 *   - /api/*             (the offline queue's endpoint, snapshot, anything with a person's data)
 *   - any non-GET request, any cross-origin request (signed photo upload / read URLs live on the storage host)
 *   - React Server Component payloads (?_rsc=, RSC / Next-Router-* headers) and every normal page navigation: those HTML/RSC
 *     responses contain the signed-in person's own data, and the phone may be shared by drivers.
 * A driver page that cannot be reached because the phone is offline is answered with a redirect to /offline?next=<path>.
 */
var VERSION = "v1";
var STATIC_CACHE = "fleetiq-static-" + VERSION;
var SHELL_CACHE = "fleetiq-shell-" + VERSION;
var SHELL_URL = "/offline";
var DRIVER_PATHS = /^\/(my-allocations|home|this-phone)(\/|$)/;

/** What the worker does with a request: "static" | "shell" | "navigation" | "never". Exposed for the unit test. */
function classify(url, method, mode, headers, origin) {
  if (method !== "GET") return "never";
  if (url.origin !== origin) return "never";
  var path = url.pathname;
  if (path.indexOf("/api/") === 0) return "never";
  if (
    url.searchParams.has("_rsc") ||
    headers.get("RSC") ||
    headers.get("Next-Router-State-Tree") ||
    headers.get("Next-Router-Prefetch")
  )
    return "never";
  if (path.indexOf("/_next/static/") === 0) return "static";
  if (
    path === "/favicon.ico" ||
    path === "/icon.svg" ||
    path === "/apple-touch-icon.png"
  )
    return "static";
  if (path === SHELL_URL) return "shell";
  if (mode === "navigate") return "navigation";
  return "never";
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      var keys = await caches.keys();
      await Promise.all(
        keys
          .filter(function (k) {
            return (
              (k.indexOf("fleetiq-static-") === 0 && k !== STATIC_CACHE) ||
              (k.indexOf("fleetiq-shell-") === 0 && k !== SHELL_CACHE)
            );
          })
          .map(function (k) {
            return caches.delete(k);
          }),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url = new URL(request.url);
  var kind = classify(
    url,
    request.method,
    request.mode,
    request.headers,
    self.location.origin,
  );
  if (kind === "static") {
    event.respondWith(
      (async function () {
        var cache = await caches.open(STATIC_CACHE);
        var hit = await cache.match(request);
        if (hit) return hit;
        var res = await fetch(request);
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      })(),
    );
  } else if (kind === "shell") {
    event.respondWith(
      (async function () {
        var cache = await caches.open(SHELL_CACHE);
        try {
          var res = await fetch(request);
          if (res && res.ok && res.type === "basic")
            cache.put(SHELL_URL, res.clone());
          return res;
        } catch (e) {
          var hit = await cache.match(SHELL_URL);
          if (hit) return hit;
          throw e;
        }
      })(),
    );
  } else if (kind === "navigation" && DRIVER_PATHS.test(url.pathname)) {
    event.respondWith(
      (async function () {
        try {
          return await fetch(request);
        } catch (e) {
          var cache = await caches.open(SHELL_CACHE);
          if (await cache.match(SHELL_URL))
            return Response.redirect(
              SHELL_URL + "?next=" + encodeURIComponent(url.pathname),
              302,
            );
          throw e;
        }
      })(),
    );
  }
  // anything else: the browser handles it, untouched
});

/** The page asks the worker to keep the offline shell and the scripts it needs, while the phone has a connection. */
self.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "warm") return;
  event.waitUntil(
    (async function () {
      try {
        var shell = await caches.open(SHELL_CACHE);
        var res = await fetch(SHELL_URL, { cache: "reload" });
        if (!res.ok) return;
        await shell.put(SHELL_URL, res.clone());
        var html = await res.text();
        var found = html.match(/\/_next\/static\/[^"'\\\s<>)]+/g) || [];
        var seen = {};
        var cache = await caches.open(STATIC_CACHE);
        for (var i = 0; i < found.length; i++) {
          var u = found[i];
          if (seen[u]) continue;
          seen[u] = true;
          if (await cache.match(u)) continue;
          try {
            var r = await fetch(u);
            if (r.ok) await cache.put(u, r);
          } catch (e) {
            /* offline again: the next warm-up finishes the job */
          }
        }
      } catch (e) {
        /* offline: nothing to warm */
      }
    })(),
  );
});

self.fleetiqSw = { classify: classify };
