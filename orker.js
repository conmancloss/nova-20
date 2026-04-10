export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Stub API routes — no Node/Redis on Cloudflare Workers
    if (url.pathname === "/api/broadcast" && request.method === "GET") {
      return Response.json({ text: "", date: "", publishedBy: "" });
    }
    if (url.pathname === "/api/blocked" && request.method === "GET") {
      return Response.json([]);
    }
    if (url.pathname === "/api/views" && request.method === "GET") {
      return Response.json({ total: 0, today: 0 });
    }
    if (url.pathname === "/api/views" && request.method === "POST") {
      return Response.json({ total: 0, today: 0 });
    }
    if (url.pathname === "/api/info") {
      return Response.json({ version: "5.2.5" });
    }

    // Serve all static assets (including /sw.js, /config.js, etc.)
    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status !== 404) return assetRes;

    // Fallback: serve index.html for SPA routing
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
  }
};
