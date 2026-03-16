import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createBareServer } from "@nebula-services/bare-server-node";
import chalk from "chalk";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
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

// ── Persistent HTTP/HTTPS agents for connection reuse (faster asset fetching) ──
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 20000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 20000 });
function agentFor(url) { return url.startsWith("https") ? httpsAgent : httpAgent; }

// ── Realistic browser headers — helps bypass bot-detection on Google etc. ──────
const BROWSER_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua":       '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile":   "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest":  "document",
  "sec-fetch-mode":  "navigate",
  "sec-fetch-site":  "none",
  "sec-fetch-user":  "?1",
  "upgrade-insecure-requests": "1",
  "DNT": "1",
};

app.use(compression({ level: 6, threshold: 512, filter: (req, res) => {
  if (req.headers["x-no-compression"]) return false;
  return compression.filter(req, res);
} }));

const IMMUTABLE_EXTS = new Set([".js",".css",".woff",".woff2",".ttf",".webp",".png",".jpg",".jpeg",".svg",".ico",".gif"]);
const NO_CACHE_FILES = new Set(["nova.css","nova.js","index.html","admin.html","whats-new.json","info.json","linkhook.js","apps.json","games.json"]);

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
    const asset = await fetch(reqTarget, {
      agent: agentFor(reqTarget),
      headers: { ...BROWSER_HEADERS, "sec-fetch-dest": "script", "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" },
      compress: true,
    });
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

// Serve proxy files at root paths (service worker scope requires root)
app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "static", "proxy", "sw.js"));
});
app.get("/config.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "static", "proxy", "config.js"));
});
// Also serve at /proxy/config.js for playground
app.get("/proxy/config.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "static", "proxy", "config.js"));
});
// Serve js/ files at their legacy root paths too
app.get("/playground.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "js", "playground.js"));
});
app.get("/store.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "js", "store.js"));
});
app.get("/ui.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "js", "ui.js"));
});
// Serve css/js at their old root paths for backwards compat
app.get("/nova.css", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "static", "css", "nova.css"));
});
app.get("/nova.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "static", "js", "nova.js"));
});

// ══════════════════════════════════════════════════════════════════════════════
//  UPSTASH REDIS  — persistent storage
//  Keys:
//    nova:admins               → [{ user, pass, role, added, lastLogin?, loginCount? }]
//    nova:log                  → { activity:[...], bcHistory:[...] }
//    nova:views:total          → integer
//    nova:views:day:YYYY-MM-DD → integer
//    nova:broadcast            → { text, date, publishedBy, color?, expiresAt? } | null
//    nova:blocked              → [{ url, reason, date, blockedBy, expiresAt?, type? }]
//    nova:security             → { loginAttempts:{}, lockouts:{}, ipBans:[],
//                                  sessions:{}, settings:{} }
//    nova:settings             → { branding:{}, customCSS, customJS, blockPage:{},
//                                  webhooks:{}, autoLogoutMins, adminPath }
//    nova:scheduled            → [{ id, text, publishAt, color, createdBy }]
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

// ── In-memory caches ──────────────────────────────────────────────────────────
let _adminsCache = null;
async function getAdmins() {
  if (_adminsCache) return _adminsCache;
  _adminsCache = (await kget("nova:admins")) || [];
  return _adminsCache;
}
async function setAdmins(list) {
  _adminsCache = list;
  return kset("nova:admins", list);
}

let _blockedCache = null;
async function getBlocked() {
  if (_blockedCache) return _blockedCache;
  _blockedCache = (await kget("nova:blocked")) || [];
  return _blockedCache;
}
async function setBlocked(list) {
  _blockedCache = list;
  return kset("nova:blocked", list);
}

let _broadcastCache = undefined;
async function getBroadcast() {
  if (_broadcastCache !== undefined) return _broadcastCache;
  _broadcastCache = await kget("nova:broadcast");
  return _broadcastCache;
}
async function setBroadcast(val) {
  _broadcastCache = val;
  if (val) return kset("nova:broadcast", val);
  return redis("DEL", "nova:broadcast");
}

let _logCache = null;
async function getLog() {
  if (_logCache) return _logCache;
  const raw = await kget("nova:log");
  if (raw && raw.activity) {
    _logCache = raw;
  } else {
    const [activity, bcHistory] = await Promise.all([
      kget("nova:activity"),
      kget("nova:broadcast-history"),
    ]);
    _logCache = {
      activity:  Array.isArray(activity)  ? activity  : [],
      bcHistory: Array.isArray(bcHistory) ? bcHistory : [],
    };
  }
  return _logCache;
}
function saveLog() { return kset("nova:log", _logCache); }

let _secCache = null;
async function getSecurity() {
  if (_secCache) return _secCache;
  const raw = await kget("nova:security");
  _secCache = raw || { loginAttempts: {}, lockouts: {}, ipBans: [], sessions: {}, settings: { maxAttempts: 5, lockoutMins: 15, sessionTimeoutMins: 60, requireMinPassLen: 6 } };
  return _secCache;
}
async function setSecurity(obj) {
  _secCache = obj;
  return kset("nova:security", obj);
}

let _settingsCache = null;
async function getSettings() {
  if (_settingsCache) return _settingsCache;
  const raw = await kget("nova:settings");
  _settingsCache = raw || {
    branding: { siteName: "Nova", adminTitle: "Nova Admin" },
    customCSS: "",
    customJS: "",
    blockPage: { title: "Access Blocked", message: "This URL has been blocked by an administrator.", showReason: true },
    webhooks: { discord: "", slack: "" },
    autoLogoutMins: 60,
    maintenanceMode: false,
  };
  return _settingsCache;
}
async function saveSettings(obj) {
  _settingsCache = obj;
  return kset("nova:settings", obj);
}

let _scheduledCache = null;
async function getScheduled() {
  if (_scheduledCache) return _scheduledCache;
  _scheduledCache = (await kget("nova:scheduled")) || [];
  return _scheduledCache;
}
async function saveScheduled(list) {
  _scheduledCache = list;
  return kset("nova:scheduled", list);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildActivityEntry(entry) {
  const now = new Date();
  return {
    msg:   entry.msg,
    color: entry.color || "blue",
    time:  now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date:  now.toISOString().slice(0, 10),
    ts:    now.getTime(),
  };
}

async function appendActivity(entry) {
  const log = await getLog();
  log.activity.unshift(buildActivityEntry(entry));
  if (log.activity.length > 200) log.activity.length = 200;
  return saveLog();
}

function getClientIP(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

// Fire webhook (Discord or Slack) non-blocking
async function fireWebhook(type, payload) {
  try {
    const settings = await getSettings();
    const url = type === "discord" ? settings.webhooks?.discord : settings.webhooks?.slack;
    if (!url) return;
    const body = type === "discord"
      ? JSON.stringify({ content: payload })
      : JSON.stringify({ text: payload });
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  } catch {}
}

// Check and auto-publish scheduled broadcasts
async function checkScheduled() {
  try {
    const list = await getScheduled();
    const now = Date.now();
    const due = list.filter(s => s.publishAt <= now);
    if (!due.length) return;
    const remaining = list.filter(s => s.publishAt > now);
    for (const item of due) {
      const entry = { text: item.text, date: todayStr(), publishedBy: item.createdBy + " (scheduled)", color: item.color || "yellow" };
      await setBroadcast(entry);
      const log = await getLog();
      log.bcHistory.unshift({ ...entry, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), type: "scheduled" });
      if (log.bcHistory.length > 50) log.bcHistory.length = 50;
      log.activity.unshift(buildActivityEntry({ msg: `Scheduled broadcast published: "${item.text.slice(0, 60)}"`, color: "yellow" }));
      await saveLog();
      fireWebhook("discord", `📢 Scheduled broadcast: ${item.text}`);
    }
    await saveScheduled(remaining);
  } catch {}
}

// Check broadcast expiry
async function checkBroadcastExpiry() {
  try {
    const bc = await getBroadcast();
    if (bc && bc.expiresAt && Date.now() > bc.expiresAt) {
      await setBroadcast(null);
      await appendActivity({ msg: "Broadcast auto-expired", color: "yellow" });
    }
  } catch {}
}

// Check blocked URL expiry
async function checkBlockedExpiry() {
  try {
    const list = await getBlocked();
    const now = Date.now();
    const active = list.filter(b => !b.expiresAt || b.expiresAt > now);
    if (active.length !== list.length) {
      await setBlocked(active);
      await appendActivity({ msg: `${list.length - active.length} temporary block(s) auto-expired`, color: "green" });
    }
  } catch {}
}

// Run periodic checks every 60 seconds
setInterval(() => {
  checkScheduled().catch(() => {});
  checkBroadcastExpiry().catch(() => {});
  checkBlockedExpiry().catch(() => {});
}, 60_000);

// Seed default owner on cold start
async function seedAdmins() {
  const admins = await getAdmins();
  if (!admins.length || !admins.find(a => a.role === "owner")) {
    const base = admins.length ? admins : [];
    base.unshift({ user: "admin", pass: "1234", role: "owner", added: todayStr() });
    await setAdmins(base);
    console.log(chalk.cyan("  Seeded default admin (admin / 1234)"));
  }
}
seedAdmins().catch(e => console.error("Seed error:", e.message));

// ── Session management ────────────────────────────────────────────────────────
function makeSessionToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function createSession(user, role, ip) {
  const sec = await getSecurity();
  const token = makeSessionToken();
  const timeoutMins = sec.settings?.sessionTimeoutMins || 60;
  sec.sessions[token] = { user, role, ip, createdAt: Date.now(), expiresAt: Date.now() + timeoutMins * 60_000, lastActive: Date.now() };
  // Prune old sessions
  const now = Date.now();
  for (const [t, s] of Object.entries(sec.sessions)) {
    if (s.expiresAt < now) delete sec.sessions[t];
  }
  await setSecurity(sec);
  return token;
}

async function validateSession(token) {
  if (!token) return null;
  const sec = await getSecurity();
  const s = sec.sessions[token];
  if (!s) return null;
  if (s.expiresAt < Date.now()) { delete sec.sessions[token]; await setSecurity(sec); return null; }
  // Refresh last active
  s.lastActive = Date.now();
  return s;
}

async function destroySession(token) {
  try {
    const sec = await getSecurity();
    delete sec.sessions[token];
    await setSecurity(sec);
  } catch {}
}

// Auth middleware — supports both legacy user/pass and new session token
async function authAdmin(req, allowViewer = false) {
  // Try session token first
  const token = req.headers["x-session-token"] || (req.body && req.body._token) || req.query._token;
  if (token) {
    const session = await validateSession(token);
    if (!session) return null;
    if (!allowViewer && session.role === "viewer") return null;
    return session;
  }
  // Fall back to legacy user/pass
  const user = (req.body && req.body.user) || req.query.user;
  const pass = (req.body && req.body.pass) || req.query.pass;
  if (!user || !pass) return null;
  const admins = await getAdmins();
  const found = admins.find(a => a.user === user && a.pass === pass);
  if (!found) return null;
  if (!allowViewer && found.role === "viewer") return null;
  return { user: found.user, role: found.role };
}

// ── Login / Rate limiting ─────────────────────────────────────────────────────
app.post("/api/admin/login", async (req, res) => {
  const ip = getClientIP(req);
  try {
    const { user, pass } = req.body || {};
    const sec = await getSecurity();
    const maxAttempts = sec.settings?.maxAttempts || 5;
    const lockoutMins = sec.settings?.lockoutMins || 15;

    // Check IP ban
    const banned = (sec.ipBans || []).find(b => b.ip === ip && (!b.expiresAt || b.expiresAt > Date.now()));
    if (banned) return res.status(403).json({ error: "Your IP is banned.", reason: banned.reason || "" });

    // Check lockout (by username)
    const lockKey = `user:${user}`;
    const lockout = sec.lockouts[lockKey];
    if (lockout && lockout.until > Date.now()) {
      const minsLeft = Math.ceil((lockout.until - Date.now()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${minsLeft} minute(s).` });
    }

    const admins = await getAdmins();
    const found = admins.find(a => a.user === user && a.pass === pass);

    if (!found) {
      // Track failed attempts
      if (!sec.loginAttempts[lockKey]) sec.loginAttempts[lockKey] = { count: 0, firstAt: Date.now() };
      sec.loginAttempts[lockKey].count++;
      sec.loginAttempts[lockKey].lastIp = ip;

      if (sec.loginAttempts[lockKey].count >= maxAttempts) {
        sec.lockouts[lockKey] = { until: Date.now() + lockoutMins * 60_000, ip };
        delete sec.loginAttempts[lockKey];
        await setSecurity(sec);
        appendActivity({ msg: `Account \"${user}\" locked after ${maxAttempts} failed attempts from ${ip}`, color: "red" }).catch(() => {});
        return res.status(429).json({ error: `Too many failed attempts. Account locked for ${lockoutMins} minutes.` });
      }
      await setSecurity(sec);
      return res.status(401).json({ error: "Invalid credentials", attemptsLeft: maxAttempts - sec.loginAttempts[lockKey].count });
    }

    // Success — clear attempts, create session
    delete sec.loginAttempts[lockKey];
    delete sec.lockouts[lockKey];
    await setSecurity(sec);

    // Update last login
    found.lastLogin = new Date().toISOString();
    found.loginCount = (found.loginCount || 0) + 1;
    await setAdmins(admins);

    const token = await createSession(found.user, found.role, ip);
    appendActivity({ msg: `Login by ${user} from ${ip}`, color: "green" }).catch(() => {});

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, role: found.role, user: found.user, token });
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/admin/logout", async (req, res) => {
  const token = req.headers["x-session-token"] || (req.body && req.body._token);
  if (token) await destroySession(token);
  res.json({ ok: true });
});

// ── Sessions panel ────────────────────────────────────────────────────────────
app.get("/api/admin/sessions", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const sec = await getSecurity();
    const now = Date.now();
    const active = Object.entries(sec.sessions || {})
      .filter(([, s]) => s.expiresAt > now)
      .map(([token, s]) => ({ token: token.slice(0, 8) + "…", user: s.user, role: s.role, ip: s.ip, createdAt: s.createdAt, lastActive: s.lastActive, expiresAt: s.expiresAt }));
    res.json(active);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/sessions/:tokenPrefix", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const prefix = req.params.tokenPrefix;
    const sec = await getSecurity();
    const toDelete = Object.keys(sec.sessions).filter(t => t.startsWith(prefix));
    toDelete.forEach(t => delete sec.sessions[t]);
    await setSecurity(sec);
    res.json({ ok: true, removed: toDelete.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IP Bans ───────────────────────────────────────────────────────────────────
app.get("/api/admin/ipbans", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const sec = await getSecurity();
    res.json(sec.ipBans || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/ipbans", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { ip, reason, durationHours } = req.body || {};
    if (!ip) return res.status(400).json({ error: "IP required" });
    const sec = await getSecurity();
    if (!sec.ipBans) sec.ipBans = [];
    const existing = sec.ipBans.find(b => b.ip === ip);
    if (existing) return res.status(409).json({ error: "IP already banned" });
    const ban = {
      ip,
      reason: (reason || "").slice(0, 200),
      bannedBy: me.user,
      bannedAt: Date.now(),
      expiresAt: durationHours ? Date.now() + durationHours * 3600_000 : null,
    };
    sec.ipBans.push(ban);
    await setSecurity(sec);
    appendActivity({ msg: `IP banned: ${ip} by ${me.user}${reason ? " — " + reason : ""}`, color: "red" }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/ipbans/:ip", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const ip = decodeURIComponent(req.params.ip);
    const sec = await getSecurity();
    sec.ipBans = (sec.ipBans || []).filter(b => b.ip !== ip);
    await setSecurity(sec);
    appendActivity({ msg: `IP unbanned: ${ip} by ${me.user}`, color: "green" }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Login attempt log + unlock ────────────────────────────────────────────────
app.get("/api/admin/lockouts", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const sec = await getSecurity();
    res.json({ lockouts: sec.lockouts || {}, attempts: sec.loginAttempts || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/lockouts/:username", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const username = decodeURIComponent(req.params.username);
    const sec = await getSecurity();
    delete sec.lockouts[`user:${username}`];
    delete sec.loginAttempts[`user:${username}`];
    await setSecurity(sec);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Security settings ─────────────────────────────────────────────────────────
app.get("/api/admin/security-settings", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const sec = await getSecurity();
    res.json(sec.settings || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/security-settings", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const { maxAttempts, lockoutMins, sessionTimeoutMins, requireMinPassLen } = req.body || {};
    const sec = await getSecurity();
    if (!sec.settings) sec.settings = {};
    if (maxAttempts)         sec.settings.maxAttempts = Math.max(1, Math.min(20, Number(maxAttempts)));
    if (lockoutMins)         sec.settings.lockoutMins = Math.max(1, Math.min(1440, Number(lockoutMins)));
    if (sessionTimeoutMins)  sec.settings.sessionTimeoutMins = Math.max(5, Math.min(10080, Number(sessionTimeoutMins)));
    if (requireMinPassLen)   sec.settings.requireMinPassLen = Math.max(4, Math.min(32, Number(requireMinPassLen)));
    await setSecurity(sec);
    appendActivity({ msg: `Security settings updated by ${me.user}`, color: "yellow" }).catch(() => {});
    res.json({ ok: true, settings: sec.settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Accounts ──────────────────────────────────────────────────────────────────
app.get("/api/admin/accounts", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const admins = await getAdmins();
    res.setHeader("Cache-Control", "no-store");
    res.json(admins.map(a => ({ user: a.user, role: a.role, added: a.added, lastLogin: a.lastLogin || null, loginCount: a.loginCount || 0 })));
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/admin/accounts", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const { newUser, newPass, newRole } = req.body || {};
    const sec = await getSecurity();
    const minLen = sec.settings?.requireMinPassLen || 6;
    if (!newUser || !newPass) return res.status(400).json({ error: "Username and password required" });
    if (newPass.length < minLen) return res.status(400).json({ error: `Password too short (min ${minLen})` });
    const admins = await getAdmins();
    if (admins.find(a => a.user === newUser)) return res.status(409).json({ error: "Username already exists" });
    const role = ["admin","viewer"].includes(newRole) ? newRole : "admin";
    admins.push({ user: newUser, pass: newPass, role, added: todayStr() });
    await Promise.all([
      setAdmins(admins),
      appendActivity({ msg: `Admin added: ${newUser} (${role}) by ${me.user}`, color: "green" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/accounts/:target", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const target = req.params.target;
    const admins = await getAdmins();
    const tgt = admins.find(a => a.user === target);
    if (!tgt) return res.status(404).json({ error: "User not found" });
    if (tgt.role === "owner") return res.status(403).json({ error: "Cannot remove owner" });
    await Promise.all([
      setAdmins(admins.filter(a => a.user !== target)),
      appendActivity({ msg: `Admin removed: ${target} by ${me.user}`, color: "red" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/password", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { newPass } = req.body || {};
    const sec = await getSecurity();
    const minLen = sec.settings?.requireMinPassLen || 6;
    if (!newPass || newPass.length < minLen) return res.status(400).json({ error: `Password too short (min ${minLen})` });
    const admins = await getAdmins();
    const user = admins.find(a => a.user === me.user);
    if (!user) return res.status(404).json({ error: "Account not found" });
    user.pass = newPass;
    await Promise.all([
      setAdmins(admins),
      appendActivity({ msg: `Password changed by ${me.user}`, color: "yellow" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Activity ──────────────────────────────────────────────────────────────────
app.get("/api/admin/activity", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { filter, search, limit } = req.query;
    let log = (await getLog()).activity || [];
    if (filter && filter !== "all") log = log.filter(e => e.color === filter);
    if (search) { const s = search.toLowerCase(); log = log.filter(e => e.msg.toLowerCase().includes(s)); }
    if (limit) log = log.slice(0, Number(limit));
    res.setHeader("Cache-Control", "no-store");
    res.json(log);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Factory reset ─────────────────────────────────────────────────────────────
app.post("/api/admin/factory-reset", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const base = new Date();
    const delKeys = ["nova:views:total", "nova:activity", "nova:log", "nova:security", "nova:scheduled"];
    for (let i = 0; i < 60; i++) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      delKeys.push(`nova:views:day:${d.toISOString().slice(0,10)}`);
    }
    const fresh = [{ user: "admin", pass: "1234", role: "owner", added: todayStr() }];
    _adminsCache = fresh; _blockedCache = []; _broadcastCache = null;
    _logCache = { activity: [], bcHistory: [] }; _secCache = null; _scheduledCache = [];
    delKeys.push("nova:log");
    await Promise.all([redis("DEL", ...delKeys), setAdmins(fresh), saveLog()]);
    appendActivity({ msg: `Factory reset by ${me.user}`, color: "red" }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── View counter ──────────────────────────────────────────────────────────────
app.post("/api/views", async (_req, res) => {
  try {
    const today = todayStr();
    const dayKey = `nova:views:day:${today}`;
    const [total, todayCount] = await Promise.all([
      redis("INCR", "nova:views:total"),
      redis("INCR", dayKey),
    ]);
    redis("EXPIRE", dayKey, 70 * 24 * 60 * 60).catch(() => {});
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
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
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
  } catch (e) { res.status(500).json({}); }
});

app.post("/api/views/reset", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const base = new Date();
    const delKeys = ["nova:views:total"];
    for (let i = 0; i < 60; i++) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      delKeys.push(`nova:views:day:${d.toISOString().slice(0,10)}`);
    }
    await redis("DEL", ...delKeys);
    await appendActivity({ msg: `View counter reset by ${me.user}`, color: "red" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
// Public endpoint — check for expiry on every read
app.get("/api/broadcast", async (_req, res) => {
  try {
    await checkBroadcastExpiry();
    // Also check if maintenance mode is on
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      const bc = await getBroadcast();
      if (!bc || !bc.text) {
        const maint = { text: "🔧 Nova is currently under maintenance.", date: todayStr(), publishedBy: "system", color: "red" };
        res.setHeader("Cache-Control", "no-store");
        return res.json(maint);
      }
    }
    const msg = await getBroadcast();
    res.setHeader("Cache-Control", "no-store");
    res.json(msg || { text: "", date: "", publishedBy: "" });
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/broadcast", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { text, color, expiryHours } = req.body || {};
    if (typeof text !== "string") return res.status(400).json({ error: "text required" });
    const trimmed = text.trim().slice(0, 300);
    const log = await getLog();
    if (trimmed) {
      const entry = {
        text: trimmed,
        date: todayStr(),
        publishedBy: me.user,
        color: color || "yellow",
        expiresAt: expiryHours ? Date.now() + Number(expiryHours) * 3600_000 : null,
      };
      const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      log.bcHistory.unshift({ ...entry, time: now });
      if (log.bcHistory.length > 50) log.bcHistory.length = 50;
      log.activity.unshift(buildActivityEntry({ msg: `Broadcast published by ${me.user}: "${trimmed.slice(0,60)}${trimmed.length>60?"…":""}"`, color: "yellow" }));
      if (log.activity.length > 200) log.activity.length = 200;
      await Promise.all([setBroadcast(entry), saveLog()]);
      fireWebhook("discord", `📢 Broadcast by ${me.user}: ${trimmed}`);
    } else {
      log.activity.unshift(buildActivityEntry({ msg: `Broadcast cleared by ${me.user}`, color: "yellow" }));
      if (log.activity.length > 200) log.activity.length = 200;
      await Promise.all([setBroadcast(null), saveLog()]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/broadcast/history", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json((await getLog()).bcHistory || []);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Scheduled broadcasts ──────────────────────────────────────────────────────
app.get("/api/scheduled", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    res.json(await getScheduled());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scheduled", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { text, publishAt, color } = req.body || {};
    if (!text || !publishAt) return res.status(400).json({ error: "text and publishAt required" });
    const ts = new Date(publishAt).getTime();
    if (isNaN(ts) || ts < Date.now()) return res.status(400).json({ error: "publishAt must be a future date/time" });
    const list = await getScheduled();
    const item = { id: Date.now().toString(36), text: text.slice(0, 300), publishAt: ts, color: color || "yellow", createdBy: me.user, createdAt: Date.now() };
    list.push(item);
    await saveScheduled(list);
    appendActivity({ msg: `Scheduled broadcast queued by ${me.user}: "${text.slice(0,60)}"`, color: "yellow" }).catch(() => {});
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/scheduled/:id", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const list = await getScheduled();
    const newList = list.filter(s => s.id !== req.params.id);
    if (newList.length === list.length) return res.status(404).json({ error: "Not found" });
    await saveScheduled(newList);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Blocked URLs ──────────────────────────────────────────────────────────────
// Public — served from cache, checks expiry
app.get("/api/blocked", async (_req, res) => {
  try {
    await checkBlockedExpiry();
    const list = await getBlocked();
    res.setHeader("Cache-Control", "no-store");
    res.json(list.map(b => ({ url: b.url, reason: b.reason || "", type: b.type || "exact" })));
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/blocked", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { url, reason, expiryHours, blockType } = req.body || {};
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
    const cleanUrl = url.trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!cleanUrl) return res.status(400).json({ error: "Invalid URL" });
    const list = await getBlocked();
    if (list.find(b => b.url === cleanUrl)) return res.status(409).json({ error: "Already blocked" });
    const entry = {
      url: cleanUrl,
      reason: (reason || "").trim().slice(0, 200),
      type: ["exact","wildcard","keyword"].includes(blockType) ? blockType : "exact",
      date: todayStr(),
      blockedBy: me.user,
      expiresAt: expiryHours ? Date.now() + Number(expiryHours) * 3600_000 : null,
    };
    list.push(entry);
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const log = await getLog();
    log.bcHistory.unshift({
      text: `🚫 URL blocked: ${cleanUrl}${entry.reason ? " — " + entry.reason : ""}`,
      date: todayStr(), time: now, publishedBy: me.user, type: "block",
    });
    if (log.bcHistory.length > 50) log.bcHistory.length = 50;
    log.activity.unshift(buildActivityEntry({ msg: `URL blocked by ${me.user}: ${cleanUrl}${entry.reason ? ` (${entry.reason})` : ""}`, color: "red" }));
    if (log.activity.length > 200) log.activity.length = 200;
    await Promise.all([setBlocked(list), saveLog()]);
    fireWebhook("discord", `🚫 URL blocked by ${me.user}: ${cleanUrl}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk block
app.post("/api/blocked/bulk", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { urls, reason } = req.body || {};
    if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: "urls array required" });
    const list = await getBlocked();
    let added = 0, skipped = 0;
    for (const rawUrl of urls.slice(0, 500)) {
      const cleanUrl = String(rawUrl).trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      if (!cleanUrl || list.find(b => b.url === cleanUrl)) { skipped++; continue; }
      list.push({ url: cleanUrl, reason: (reason || "Bulk import").slice(0, 200), type: "exact", date: todayStr(), blockedBy: me.user, expiresAt: null });
      added++;
    }
    await setBlocked(list);
    appendActivity({ msg: `Bulk block: ${added} added, ${skipped} skipped by ${me.user}`, color: "red" }).catch(() => {});
    res.json({ ok: true, added, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/blocked", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    const { url } = req.body || {};
    const cleanUrl = (url || "").trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const list = await getBlocked();
    const newList = list.filter(b => b.url !== cleanUrl);
    if (newList.length === list.length) return res.status(404).json({ error: "URL not found" });
    await Promise.all([
      setBlocked(newList),
      appendActivity({ msg: `URL unblocked by ${me.user}: ${cleanUrl}`, color: "green" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/blocked/admin", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json(await getBlocked());
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Settings ──────────────────────────────────────────────────────────────────
// ── Info / Version ────────────────────────────────────────────────────────────
// Public — serves static info.json but overrides version from DB if set
app.get("/api/info", async (_req, res) => {
  try {
    const staticInfo = JSON.parse(fs.readFileSync(path.join(__dirname, "static", "info.json"), "utf8"));
    const dbVersion = await kget("nova:version");
    if (dbVersion) staticInfo.version = dbVersion;
    res.setHeader("Cache-Control", "no-store");
    res.json(staticInfo);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — update version number stored in DB
app.post("/api/admin/version", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const { version } = req.body || {};
    if (!version || typeof version !== "string") return res.status(400).json({ error: "version string required" });
    const trimmed = version.trim().slice(0, 50);
    if (!trimmed) return res.status(400).json({ error: "version cannot be empty" });
    await kset("nova:version", trimmed);
    appendActivity({ msg: `Version updated to ${trimmed} by ${me.user}`, color: "blue" }).catch(() => {});
    res.json({ ok: true, version: trimmed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/settings", async (req, res) => {
  try {
    const me = await authAdmin(req, true);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    res.json(await getSettings());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/settings", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const settings = await getSettings();
    const { branding, customCSS, customJS, blockPage, webhooks, autoLogoutMins, maintenanceMode } = req.body || {};
    if (branding)       Object.assign(settings.branding, branding);
    if (customCSS !== undefined) settings.customCSS = String(customCSS).slice(0, 50000);
    if (customJS !== undefined)  settings.customJS  = String(customJS).slice(0, 50000);
    if (blockPage)      Object.assign(settings.blockPage, blockPage);
    if (webhooks)       Object.assign(settings.webhooks, webhooks);
    if (autoLogoutMins !== undefined) settings.autoLogoutMins = Math.max(5, Math.min(10080, Number(autoLogoutMins)));
    if (maintenanceMode !== undefined) settings.maintenanceMode = Boolean(maintenanceMode);
    await saveSettings(settings);
    appendActivity({ msg: `Site settings updated by ${me.user}`, color: "blue" }).catch(() => {});
    res.json({ ok: true, settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public endpoint for custom CSS/JS injection on main site
app.get("/api/custom-inject", async (_req, res) => {
  try {
    const settings = await getSettings();
    res.setHeader("Cache-Control", "no-store");
    res.json({ css: settings.customCSS || "", js: settings.customJS || "" });
  } catch (e) { res.json({ css: "", js: "" }); }
});

// Public endpoint for block page config
app.get("/api/block-page-config", async (_req, res) => {
  try {
    const settings = await getSettings();
    res.setHeader("Cache-Control", "no-store");
    res.json(settings.blockPage || {});
  } catch (e) { res.json({}); }
});

// ── Backup / Restore ──────────────────────────────────────────────────────────
app.get("/api/admin/backup", async (req, res) => {
  try {
    const me = await authAdmin(req);
    if (!me || me.role !== "owner") return res.status(401).json({ error: "Unauthorized" });
    const [admins, blocked, log, settings, scheduled] = await Promise.all([
      getAdmins(), getBlocked(), getLog(), getSettings(), getScheduled(),
    ]);
    const backup = {
      version: 2,
      exportedAt: new Date().toISOString(),
      exportedBy: me.user,
      admins: admins.map(a => ({ ...a, pass: undefined })), // strip passwords
      blocked,
      log,
      settings,
      scheduled,
    };
    res.setHeader("Content-Disposition", `attachment; filename="nova-backup-${todayStr()}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.json(backup);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "static"), {
  etag: true, lastModified: true,
  setHeaders(res, filePath) { setCacheHeaders(res, filePath); },
}));

app.use("/ca", cors({ origin: true }));

const routes = [
  { path: "/b",         file: "html/apps.html"  },
  { path: "/play.html", file: "html/games.html" },
  { path: "/c",         file: "html/settings.html" },
  { path: "/d",         file: "html/tabs.html"  },
  { path: "/admin",     file: "html/admin.html" },
  { path: "/404",       file: "html/404.html" },
  { path: "/",          file: "index.html" },
];
routes.forEach(({ path: p, file }) => {
  app.get(p, (_req, res) => {
    const fp = path.join(__dirname, "static", file);
    setCacheHeaders(res, fp);
    res.sendFile(fp);
  });
});

const PAGE_404 = path.join(__dirname, "static", "html", "404.html");
const PAGE_404_EXISTS = fs.existsSync(PAGE_404);
app.use((_req, res) => {
  if (PAGE_404_EXISTS) return res.status(404).sendFile(PAGE_404);
  res.status(404).send("404 — Not Found");
});
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  if (PAGE_404_EXISTS) return res.status(500).sendFile(PAGE_404);
  res.status(500).send("500 — Server Error");
});

server.on("request",  (req, res) => {
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=30, max=200");
  req.on("error", err => { if (err.code !== "ECONNRESET") console.error("req error:", err.message); });
  res.on("error", err => { if (err.code !== "ECONNRESET") console.error("res error:", err.message); });
  bareServer.shouldRoute(req) ? bareServer.routeRequest(req, res) : app(req, res);
});
server.on("upgrade", (req, socket, head) => {
  socket.on("error", err => { if (err.code !== "ECONNRESET") console.error("socket error:", err.message); });
  bareServer.shouldRoute(req) ? bareServer.routeUpgrade(req, socket, head) : socket.end();
});
server.on("error", err => {
  if (err.code === "ECONNRESET" || err.code === "ECONNABORTED" || err.message === "aborted") return;
  console.error("Server error:", err);
});
process.on("uncaughtException", err => {
  if (err.code === "ECONNRESET" || err.message === "aborted") return;
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", reason => {
  if (reason?.code === "ECONNRESET" || reason?.message === "aborted") return;
  console.error("Unhandled rejection:", reason);
});

server.on("listening", () => {
  console.log(chalk.green(`\n🌍 Nova → http://localhost:${PORT}`));
  console.log(chalk.cyan(`   Storage : Upstash Redis`));
  console.log(chalk.cyan(`   Proxy   : UV → /a/  |  Bare → /ca/`));
  if (!REDIS_URL) console.log(chalk.red("   ⚠️  UPSTASH_REDIS_REST_URL not set — storage will fail"));
});

server.keepAliveTimeout = 30000;
server.headersTimeout   = 35000;
server.listen({ port: PORT });
