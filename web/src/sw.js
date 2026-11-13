// The service worker (scripts/sw-plugin.ts fills in the manifest). An update waits for the user; an old build's cache stays while a page of it is open.
/* eslint-disable no-restricted-globals */
const MANIFEST = self.__MANIFEST__;
const BUILD = self.__BUILD__;
const PREFIX = "cv-tools-";
const CACHE = PREFIX + BUILD;
const scope = new URL(self.registration.scope);
const byUrl = new Map(MANIFEST.map((e) => [new URL(e.url, scope).href, e]));
/** Build of each open page, from its "hello" message. */
const pageBuilds = new Map();

async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** False when the body does not have the manifest's hash. */
async function store(cache, entry, response) {
  const body = await response.blob();
  const rev = (await sha256(body)).slice(0, 16);
  if (rev !== entry.rev && rev !== entry.rawRev) return false;
  await cache.put(new URL(entry.url, scope).href, new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
  return true;
}

async function fetchInto(cache, entry) {
  const response = await fetch(new URL(entry.url, scope).href, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${entry.url}: HTTP ${response.status}`);
  if (!(await store(cache, entry, response))) throw new Error(`${entry.url}: content does not match build ${BUILD}`);
}

/** An unchanged file (same URL and hash) from the cache of an earlier build. */
async function reuse(cache, entry) {
  const url = new URL(entry.url, scope).href;
  for (const name of await caches.keys()) {
    if (name === CACHE || !name.startsWith(PREFIX)) continue;
    const old = await (await caches.open(name)).match(url);
    const rev = old ? (await sha256(await old.clone().blob())).slice(0, 16) : "";
    if (old && (rev === entry.rev || rev === entry.rawRev)) {
      await cache.put(url, old);
      return true;
    }
  }
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const entry of MANIFEST) {
        if (await reuse(cache, entry)) continue;
        // Lazy files (Pyodide, the engine) are copied when unchanged, so the update works offline too.
        if (!entry.lazy) await fetchInto(cache, entry);
      }
      // Nothing to replace on a first install; an update waits for the page to ask.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

/** Keeps everything while a page's build is unknown or an update is pending. */
async function cleanup() {
  if (self.registration.installing || self.registration.waiting) return;
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const live = new Set(pages.map((c) => c.id));
  for (const id of [...pageBuilds.keys()]) if (!live.has(id)) pageBuilds.delete(id);
  if (pages.some((c) => !pageBuilds.has(c.id))) return;
  const needed = new Set([BUILD, ...pageBuilds.values()]);
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && !needed.has(name.slice(PREFIX.length))) await caches.delete(name);
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanup());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  url.hash = "";
  url.search = "";
  if (request.mode === "navigate" && url.href === new URL("index.html", scope).href) url.href = scope.href;
  const entry = byUrl.get(url.href);
  event.respondWith(
    (async () => {
      let hit = entry ? await (await caches.open(CACHE)).match(url.href) : undefined;
      // Not a file of this build: an old page asks for its own build's files, which old caches hold.
      if (!hit && !entry && request.mode !== "navigate") hit = await caches.match(url.href);
      if (hit) return hit;
      let response;
      try {
        response = await fetch(request);
      } catch (e) {
        // Offline: an unchanged copy from an earlier build will do.
        const cache = await caches.open(CACHE);
        if (entry && (await reuse(cache, entry))) return cache.match(url.href);
        throw e;
      }
      if (entry && response.ok && response.type === "basic") {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => store(cache, entry, copy)).catch(() => {}));
      }
      return response;
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "warm" || data?.type === "warm") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE);
        for (const entry of MANIFEST) {
          if (!entry.warm || (await cache.match(new URL(entry.url, scope).href))) continue;
          try {
            await fetchInto(cache, entry);
          } catch {
            // Offline, missing or from another build: try again on the next visit.
          }
        }
        event.source?.postMessage({ type: "warm-done", build: BUILD });
      })(),
    );
  } else if (data?.type === "hello" && event.source) {
    pageBuilds.set(event.source.id, data.build);
    event.waitUntil(cleanup());
  } else if (data?.type === "skip-waiting") {
    self.skipWaiting();
  }
});
