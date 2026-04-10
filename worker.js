export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never redirect sw.js — serve it directly with correct headers
    if (url.pathname === "/sw.js" || url.pathname === "/config.js") {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set("Content-Type", "application/javascript");
      response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      response.headers.set("Service-Worker-Allowed", "/");
      return response;
    }

    // Serve all other static assets normally
    return env.ASSETS.fetch(request);
  },
};
