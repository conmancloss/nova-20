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
        const res = await uv.fetch(event);
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("text/html")) {
          try {
            const status = res.status || 200;
            if (status < 200 || status > 599) return res;
            const text = await res.text();
            const patched = text.replace(/\s+target\s*=\s*["']_blank["']/gi, ' target="_self"');
            const headers = new Headers(res.headers);
            headers.delete("content-length");
            return new Response(patched, { status, statusText: res.statusText || "OK", headers });
          } catch (_) {
            return res;
          }
        }
        return res;
      }

      return await fetch(event.request);
    })()
  );
});
