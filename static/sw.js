// userKey is read from the SW registration URL query param (?userkey=...)
// Falls back to an empty string so the bare server header is simply omitted
const userKey = new URL(location).searchParams.get("userkey") || "";

importScripts("/assets/history/config.js");
importScripts("/assets/history/worker.js");
importScripts("/assets/mathematics/bundle.js");
importScripts("/assets/mathematics/config.js");
importScripts(__uv$config.sw || "/assets/mathematics/sw.js");

const uv = new UVServiceWorker();
const dynamic = new Dynamic();

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      if (await dynamic.route(event)) {
        return await dynamic.fetch(event);
      }

      if (event.request.url.startsWith(`${location.origin}/a/`)) {
        return await uv.fetch(event);
      }

      return await fetch(event.request);
    })()
  );
});
