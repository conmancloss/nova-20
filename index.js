import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createBareServer } from "@nebula-services/bare-server-node";
import chalk from "chalk";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import basicAuth from "express-basic-auth";
import mime from "mime";
import fetch from "node-fetch";
import config from "./config.js";

console.log(chalk.yellow("🚀 Starting Nova server..."));

const __dirname = process.cwd();
const server = http.createServer();
const app = express();
const bareServer = createBareServer("/ca/");
const PORT = process.env.PORT || 8080;
const cache = new Map();
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

app.use(compression({ level: 6, threshold: 1024 }));

const IMMUTABLE_EXTS = new Set([".js",".css",".woff",".woff2",".ttf",".webp",".png",".jpg",".jpeg",".svg",".ico",".gif"]);
const NO_CACHE_FILES = new Set(["nova.css","nova.js","index.html","admin.html","whats-new.json","info.json"]);

function setCacheHeaders(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  if (NO_CACHE_FILES.has(base)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (IMMUTABLE_EXTS.has(ext)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else if (ext === ".json") {
    res.setHeader("Cache-Control", "public, max-age=600");
  }
}

if (config.challenge !== false) {
  console.log(chalk.green("🔒 Password protection enabled"));
  Object.entries(config.users).forEach(([u, p]) => console.log(chalk.blue(`  ${u} / ${p}`)));
  app.use(basicAuth({ users: config.users, challenge: true }));
}

app.get("/e/*", async (req, res, next) => {
  try {
    if (cache.has(req.path)) {
      const { data, contentType, timestamp } = cache.get(req.path);
      if (Date.now() - timestamp < CACHE_TTL) {
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.send(data);
      }
      cache.delete(req.path);
    }
    const baseUrls = {
      "/e/1/": "https://raw.githubusercontent.com/qrs/x/fixy/",
      "/e/2/": "https://raw.githubusercontent.com/3v1/V5-Assets/main/",
      "/e/3/": "https://raw.githubusercontent.com/3v1/V5-Retro/master/",
    };
    let reqTarget;
    for (const [prefix, baseUrl] of Object.entries(baseUrls)) {
      if (req.path.startsWith(prefix)) { reqTarget = baseUrl + req.path.slice(prefix.length); break; }
    }
    if (!reqTarget) return next();
    const asset = await fetch(reqTarget);
    if (!asset.ok) return next();
    const data = Buffer.from(await asset.arrayBuffer());
    const ext = path.extname(reqTarget);
    const contentType = [".unityweb"].includes(ext) ? "application/octet-stream" : mime.getType(ext);
    cache.set(req.path, { data, contentType, timestamp: Date.now() });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(data);
  } catch (err) {
    console.error("Asset fetch error:", err);
    next(err);
  }
});

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/sw.js", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});

// ══════════════════════════════════════════════════════════════════════════════
//  UPSTASH REDIS  — persistent storage that works on Vercel
//  Keys used:
//    nova:admins               → JSON array of admin accounts (passwords included)
//    nova:activity             → JSON array of last 100 activity log entries
//    nova:views:total          → integer, all-time page view count
//    nova:views:day:YYYY-MM-DD → integer, views for that specific day
//    nova:broadcast            → { text, date, publishedBy } | null
//    nova:broadcast-history    → JSON array of last 50 broadcast/block entries
//    nova:blocked              → JSON array of { url, reason, date, blockedBy }
// ══════════════════════════════════════════════════════════════════════════════
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Upstash env vars missing");
  const r = await fetch(
    `${REDIS_URL}/${args.map(a => encodeURIComponent(String(a))).join("/")}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function kget(key) {
  const raw = await redis("GET", key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function kset(key, value) {
  return redis("SET", key, JSON.stringify(value));
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// Seed default owner on cold start
async function seedAdmins() {
  const admins = await kget("nova:admins");
  if (!admins || !Array.isArray(admins) || !admins.find(a => a.role === "owner")) {
    const base = Array.isArray(admins) ? admins : [];
    base.unshift({ user: "admin", pass: "1234", role: "owner", added: todayStr() });
    await kset("nova:admins", base);
    console.log(chalk.cyan("  Seeded default admin (admin / 1234)"));
  }
}
seedAdmins().catch(e => console.error("Seed error:", e.message));

async function appendActivity(entry) {
  const log = (await kget("nova:activity")) || [];
  const now = new Date();
  log.unshift({
    msg:   entry.msg,
    color: entry.color || "blue",
    time:  now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date:  now.toISOString().slice(0, 10),
  });
  if (log.length > 100) log.length = 100;
  await kset("nova:activity", log);
}

// ── View counter ──────────────────────────────────────────────────────────────
app.post("/api/views", async (_req, res) => {
  try {
    const today = todayStr();
    const total      = await redis("INCR", "nova:views:total");
    const todayCount = await redis("INCR", `nova:views:day:${today}`);
    await redis("EXPIRE", `nova:views:day:${today}`, 70 * 24 * 60 * 60);
    res.setHeader("Cache-Control", "no-store");
    res.json({ total: Number(total), today: Number(todayCount), date: today });
  } catch (e) {
    console.error("Views POST:", e.message);
    res.status(500).json({ error: "Storage unavailable" });
  }
});

app.get("/api/views", async (_req, res) => {
  try {
    const today = todayStr();
    const [total, todayCount] = await Promise.all([
      redis("GET", "nova:views:total"),
      redis("GET", `nova:views:day:${today}`),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ total: Number(total) || 0, today: Number(todayCount) || 0, date: today });
  } catch (e) {
    res.status(500).json({ error: "Storage unavailable" });
  }
});

app.get("/api/views/history", async (_req, res) => {
  try {
    const history = {};
    const base = new Date();
    const keys = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      keys.push(`nova:views:day:${d.toISOString().slice(0,10)}`);
    }
    const values = await redis("MGET", ...keys);
    const arr = Array.isArray(values) ? values : [values];
    keys.forEach((k, i) => {
      if (arr[i] != null) history[k.replace("nova:views:day:", "")] = Number(arr[i]);
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(history);
  } catch (e) {
    res.status(500).json({});
  }
});

app.post("/api/views/reset", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    const base = new Date();
    const delKeys = ["nova:views:total"];
    for (let i = 0; i < 60; i++) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      delKeys.push(`nova:views:day:${d.toISOString().slice(0,10)}`);
    }
    await redis("DEL", ...delKeys);
    await appendActivity({ msg: "View counter reset by " + user, color: "red" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API ─────────────────────────────────────────────────────────────────
app.post("/api/admin/login", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await kget("nova:admins") || [];
    const found = admins.find(a => a.user === user && a.pass === pass);
    if (!found) return res.status(401).json({ error: "Invalid credentials" });
    await appendActivity({ msg: "Login by " + user, color: "green" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, role: found.role, user: found.user });
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.get("/api/admin/accounts", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json(admins.map(a => ({ user: a.user, role: a.role, added: a.added })));
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/admin/accounts", async (req, res) => {
  try {
    const { user, pass, newUser, newPass, newRole } = req.body || {};
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    if (!newUser || !newPass) return res.status(400).json({ error: "Username and password required" });
    if (newPass.length < 4)   return res.status(400).json({ error: "Password too short (min 4)" });
    if (admins.find(a => a.user === newUser)) return res.status(409).json({ error: "Username already exists" });
    const role = ["admin","viewer"].includes(newRole) ? newRole : "admin";
    admins.push({ user: newUser, pass: newPass, role, added: todayStr() });
    await kset("nova:admins", admins);
    await appendActivity({ msg: `Admin added: ${newUser} (${role}) by ${user}`, color: "green" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/accounts/:target", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const target = req.params.target;
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    const tgt = admins.find(a => a.user === target);
    if (!tgt)                 return res.status(404).json({ error: "User not found" });
    if (tgt.role === "owner") return res.status(403).json({ error: "Cannot remove owner" });
    await kset("nova:admins", admins.filter(a => a.user !== target));
    await appendActivity({ msg: `Admin removed: ${target} by ${user}`, color: "red" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/password", async (req, res) => {
  try {
    const { user, pass, newPass } = req.body || {};
    const admins = await kget("nova:admins") || [];
    const me = admins.find(a => a.user === user && a.pass === pass && a.role === "owner");
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!newPass || newPass.length < 4) return res.status(400).json({ error: "Password too short (min 4)" });
    me.pass = newPass;
    await kset("nova:admins", admins);
    await appendActivity({ msg: "Password changed by " + user, color: "yellow" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/activity", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json((await kget("nova:activity")) || []);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/admin/factory-reset", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    const base = new Date();
    const delKeys = ["nova:views:total", "nova:activity"];
    for (let i = 0; i < 60; i++) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      delKeys.push(`nova:views:day:${d.toISOString().slice(0,10)}`);
    }
    await redis("DEL", ...delKeys);
    await kset("nova:admins", [{ user: "admin", pass: "1234", role: "owner", added: todayStr() }]);
    await appendActivity({ msg: "Factory reset by " + user, color: "red" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Broadcast / Announcement ──────────────────────────────────────────────────
//  nova:broadcast → { text, date, publishedBy } | null

// Public — any visitor polls this to show the banner
app.get("/api/broadcast", async (_req, res) => {
  try {
    const msg = await kget("nova:broadcast");
    res.setHeader("Cache-Control", "no-store");
    res.json(msg || { text: "", date: "", publishedBy: "" });
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// Admin — publish a new announcement
app.post("/api/broadcast", async (req, res) => {
  try {
    const { user, pass, text } = req.body || {};
    const admins = await kget("nova:admins") || [];
    const me = admins.find(a => a.user === user && a.pass === pass);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (typeof text !== "string") return res.status(400).json({ error: "text required" });
    const trimmed = text.trim().slice(0, 300);
    if (trimmed) {
      const entry = { text: trimmed, date: todayStr(), publishedBy: user };
      await kset("nova:broadcast", entry);
      // Keep a history log (last 20)
      const hist = (await kget("nova:broadcast-history")) || [];
      hist.unshift({ ...entry, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      if (hist.length > 20) hist.length = 20;
      await kset("nova:broadcast-history", hist);
      await appendActivity({ msg: `Broadcast published by ${user}: "${trimmed.slice(0,60)}${trimmed.length>60?"…":""}"`, color: "yellow" });
    } else {
      await redis("DEL", "nova:broadcast");
      await appendActivity({ msg: `Broadcast cleared by ${user}`, color: "yellow" });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — get broadcast history
app.get("/api/broadcast/history", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json((await kget("nova:broadcast-history")) || []);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Blocked URLs ──────────────────────────────────────────────────────────────
//  nova:blocked → JSON array of { url, reason, date, blockedBy }
//  Public GET so the client-side proxy can check before navigating

// Public — client polls this before any proxy navigation
app.get("/api/blocked", async (_req, res) => {
  try {
    const list = (await kget("nova:blocked")) || [];
    res.setHeader("Cache-Control", "no-store");
    // Only send url + reason to the public (no admin metadata)
    res.json(list.map(b => ({ url: b.url, reason: b.reason || "" })));
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// Admin — add a blocked URL
app.post("/api/blocked", async (req, res) => {
  try {
    const { user, pass, url, reason } = req.body || {};
    const admins = await kget("nova:admins") || [];
    const me = admins.find(a => a.user === user && a.pass === pass);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
    const cleanUrl = url.trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!cleanUrl) return res.status(400).json({ error: "Invalid URL" });
    const list = (await kget("nova:blocked")) || [];
    if (list.find(b => b.url === cleanUrl)) return res.status(409).json({ error: "Already blocked" });
    const entry = {
      url: cleanUrl,
      reason: (reason || "").trim().slice(0, 100),
      date: todayStr(),
      blockedBy: user,
    };
    list.push(entry);
    await kset("nova:blocked", list);
    // Also log in activity
    await appendActivity({ msg: `URL blocked by ${user}: ${cleanUrl}${entry.reason ? ` (${entry.reason})` : ""}`, color: "red" });
    // Announce via broadcast history so it's visible in admin
    const bHist = (await kget("nova:broadcast-history")) || [];
    bHist.unshift({
      text: `🚫 URL blocked: ${cleanUrl}${entry.reason ? " — " + entry.reason : ""}`,
      date: todayStr(),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      publishedBy: user,
      type: "block",
    });
    if (bHist.length > 50) bHist.length = 50;
    await kset("nova:broadcast-history", bHist);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — remove a blocked URL
app.delete("/api/blocked", async (req, res) => {
  try {
    const { user, pass, url } = req.body || {};
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const cleanUrl = (url || "").trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    let list = (await kget("nova:blocked")) || [];
    const before = list.length;
    list = list.filter(b => b.url !== cleanUrl);
    if (list.length === before) return res.status(404).json({ error: "URL not found in block list" });
    await kset("nova:blocked", list);
    await appendActivity({ msg: `URL unblocked by ${user}: ${cleanUrl}`, color: "green" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — get full blocked list with metadata
app.get("/api/blocked/admin", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await kget("nova:admins") || [];
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json((await kget("nova:blocked")) || []);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "static"), {
  etag: true, lastModified: true,
  setHeaders(res, filePath) { setCacheHeaders(res, filePath); },
}));

app.use("/ca", cors({ origin: true }));

const routes = [
  { path: "/b",         file: "apps.html"  },
  { path: "/play.html", file: "games.html" },
  { path: "/c",         file: "settings.html" },
  { path: "/d",         file: "tabs.html"  },
  { path: "/admin",     file: "admin.html" },
  { path: "/",          file: "index.html" },
];
routes.forEach(({ path: p, file }) => {
  app.get(p, (_req, res) => {
    const fp = path.join(__dirname, "static", file);
    setCacheHeaders(res, fp);
    res.sendFile(fp);
  });
});

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, "static", "404.html")));
app.use((err, _req, res, _next) => { console.error(err.stack); res.status(500).sendFile(path.join(__dirname, "static", "404.html")); });

server.on("request",  (req, res)          => bareServer.shouldRoute(req) ? bareServer.routeRequest(req, res)          : app(req, res));
server.on("upgrade",  (req, socket, head) => bareServer.shouldRoute(req) ? bareServer.routeUpgrade(req, socket, head) : socket.end());

server.on("listening", () => {
  console.log(chalk.green(`\n🌍 Nova → http://localhost:${PORT}`));
  console.log(chalk.cyan(`   Storage : Upstash Redis (works on Vercel)`));
  console.log(chalk.cyan(`   Proxy   : UV → /a/  |  Bare → /ca/`));
  if (!REDIS_URL) console.log(chalk.red("   ⚠️  UPSTASH_REDIS_REST_URL not set — storage will fail"));
});

server.listen({ port: PORT });
