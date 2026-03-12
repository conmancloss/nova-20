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

// ── In-memory caches (cut repeated Redis reads to near zero) ──────────────────
// nova:admins — read on every authenticated request but almost never changes
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

// nova:blocked — polled by every visitor every 2 min; rarely changes
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

// nova:broadcast — polled by every visitor every 60s; rarely changes
let _broadcastCache = undefined; // undefined = not yet loaded
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

// ── Activity + broadcast-history: both cached in memory ──────────────────────
// Merged into one key (nova:log) so every write is 1 SET instead of 2 GET+SET pairs.
let _logCache = null;

async function getLog() {
  if (_logCache) return _logCache;
  const raw = await kget("nova:log");
  if (raw && raw.activity) {
    _logCache = raw;
  } else {
    // First run or old schema: migrate existing separate keys in one MGET
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

function saveLog() {
  return kset("nova:log", _logCache);
}

function buildActivityEntry(entry) {
  const now = new Date();
  return {
    msg:   entry.msg,
    color: entry.color || "blue",
    time:  now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date:  now.toISOString().slice(0, 10),
  };
}

async function appendActivity(entry) {
  const log = await getLog();
  log.activity.unshift(buildActivityEntry(entry));
  if (log.activity.length > 100) log.activity.length = 100;
  return saveLog();
}

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

// ── View counter ──────────────────────────────────────────────────────────────
app.post("/api/views", async (_req, res) => {
  try {
    const today = todayStr();
    const dayKey = `nova:views:day:${today}`;
    // Run INCR calls in parallel, fire EXPIRE without waiting (saves 1 round trip)
    const [total, todayCount] = await Promise.all([
      redis("INCR", "nova:views:total"),
      redis("INCR", dayKey),
    ]);
    redis("EXPIRE", dayKey, 70 * 24 * 60 * 60).catch(() => {}); // fire-and-forget
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
    const admins = await getAdmins();
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
app.get("/api/admin/accounts", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json(admins.map(a => ({ user: a.user, role: a.role, added: a.added })));
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/admin/accounts", async (req, res) => {
  try {
    const { user, pass, newUser, newPass, newRole } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    if (!newUser || !newPass) return res.status(400).json({ error: "Username and password required" });
    if (newPass.length < 4)   return res.status(400).json({ error: "Password too short (min 4)" });
    if (admins.find(a => a.user === newUser)) return res.status(409).json({ error: "Username already exists" });
    const role = ["admin","viewer"].includes(newRole) ? newRole : "admin";
    admins.push({ user: newUser, pass: newPass, role, added: todayStr() });
    await Promise.all([
      setAdmins(admins),
      appendActivity({ msg: `Admin added: ${newUser} (${role}) by ${user}`, color: "green" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/accounts/:target", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const target = req.params.target;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    const tgt = admins.find(a => a.user === target);
    if (!tgt)                 return res.status(404).json({ error: "User not found" });
    if (tgt.role === "owner") return res.status(403).json({ error: "Cannot remove owner" });
    await Promise.all([
      setAdmins(admins.filter(a => a.user !== target)),
      appendActivity({ msg: `Admin removed: ${target} by ${user}`, color: "red" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/password", async (req, res) => {
  try {
    const { user, pass, newPass } = req.body || {};
    const admins = await getAdmins();
    const me = admins.find(a => a.user === user && a.pass === pass);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!newPass || newPass.length < 4) return res.status(400).json({ error: "Password too short (min 4)" });
    me.pass = newPass;
    await Promise.all([
      setAdmins(admins),
      appendActivity({ msg: "Password changed by " + user, color: "yellow" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/activity", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json((await getLog()).activity || []);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

app.post("/api/admin/factory-reset", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized" });
    const base = new Date();
    const delKeys = ["nova:views:total", "nova:activity"];
    for (let i = 0; i < 60; i++) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      delKeys.push(`nova:views:day:${d.toISOString().slice(0,10)}`);
    }
    const fresh = [{ user: "admin", pass: "1234", role: "owner", added: todayStr() }];
    _adminsCache = fresh; _blockedCache = []; _broadcastCache = null; _logCache = { activity: [], bcHistory: [] };
    delKeys.push("nova:log");
    await Promise.all([
      redis("DEL", ...delKeys),
      setAdmins(fresh),
      saveLog(),
    ]);
    appendActivity({ msg: "Factory reset by " + user, color: "red" }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 1 — SECURITY & AUTH
//  Keys:
//    nova:login-attempts   → { [user]: { count, lockedUntil } }
//    nova:sessions         → { [token]: { user, role, ip, ua, created, lastSeen } }
//    nova:ip-bans          → [{ ip, reason, bannedBy, date, expiresAt }]
//    nova:security-settings → { lockoutThreshold, lockoutMinutes, sessionTimeoutMinutes, secretAdminPath, twoFaEnabled }
//    nova:totp-secrets     → { [user]: secret }  (base32 stored, never exposed)
//    nova:login-log        → [{ user, ip, ua, date, time, success, reason }]
// ══════════════════════════════════════════════════════════════════════════════

// ── In-memory caches ────────────────────────────────────────────────────────
let _loginAttemptsCache = null;
let _sessionsCache = null;
let _ipBansCache = null;
let _secSettingsCache = null;
let _loginLogCache = null;

async function getLoginAttempts() {
  if (_loginAttemptsCache) return _loginAttemptsCache;
  _loginAttemptsCache = (await kget("nova:login-attempts")) || {};
  return _loginAttemptsCache;
}
async function setLoginAttempts(obj) {
  _loginAttemptsCache = obj;
  return kset("nova:login-attempts", obj);
}

async function getSessions() {
  if (_sessionsCache) return _sessionsCache;
  _sessionsCache = (await kget("nova:sessions")) || {};
  return _sessionsCache;
}
async function setSessions(obj) {
  _sessionsCache = obj;
  return kset("nova:sessions", obj);
}

async function getIpBans() {
  if (_ipBansCache) return _ipBansCache;
  _ipBansCache = (await kget("nova:ip-bans")) || [];
  return _ipBansCache;
}
async function setIpBans(list) {
  _ipBansCache = list;
  return kset("nova:ip-bans", list);
}

async function getSecSettings() {
  if (_secSettingsCache) return _secSettingsCache;
  const defaults = { lockoutThreshold: 5, lockoutMinutes: 15, sessionTimeoutMinutes: 60, secretAdminPath: "/admin", twoFaEnabled: false };
  const stored = await kget("nova:security-settings");
  _secSettingsCache = { ...defaults, ...(stored || {}) };
  return _secSettingsCache;
}
async function setSecSettings(obj) {
  _secSettingsCache = obj;
  return kset("nova:security-settings", obj);
}

async function getLoginLog() {
  if (_loginLogCache) return _loginLogCache;
  _loginLogCache = (await kget("nova:login-log")) || [];
  return _loginLogCache;
}
async function appendLoginLog(entry) {
  const log = await getLoginLog();
  const now = new Date();
  log.unshift({ ...entry, date: now.toISOString().slice(0,10), time: now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) });
  if (log.length > 200) log.length = 200;
  _loginLogCache = log;
  return kset("nova:login-log", log);
}

// ── TOTP helpers (no external lib — pure RFC 6238 implementation) ─────────────
function base32Decode(base32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const output = [];
  for (const ch of base32.replace(/=/g,"").toUpperCase()) {
    const idx = chars.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

async function hmacSha1(key, data) {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha1", key).update(data).digest();
}

async function totpGenerate(secret, window = 0) {
  const key = base32Decode(secret);
  const t = Math.floor(Date.now() / 1000 / 30) + window;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(t));
  const hmac = await hmacSha1(key, buf);
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return String(code).padStart(6, "0");
}

async function totpVerify(secret, token) {
  for (const w of [-1, 0, 1]) {
    if (await totpGenerate(secret, w) === String(token).replace(/\s/g,"")) return true;
  }
  return false;
}

function generateSecret(length = 16) {
  const { randomBytes } = require("node:crypto");
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = randomBytes(length);
  return Array.from(bytes).map(b => chars[b % 32]).join("");
}

function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

// ── IP ban middleware ────────────────────────────────────────────────────────
async function ipBanCheck(req, res, next) {
  try {
    const ip = getClientIp(req);
    const bans = await getIpBans();
    const now = Date.now();
    const ban = bans.find(b => b.ip === ip && (!b.expiresAt || new Date(b.expiresAt).getTime() > now));
    if (ban) {
      return res.status(403).json({ error: "Your IP is banned", reason: ban.reason || "", expiresAt: ban.expiresAt || null });
    }
  } catch (e) { /* don't crash on ban check */ }
  next();
}
app.use("/api/admin/login", ipBanCheck);

// ── Security Settings ────────────────────────────────────────────────────────
app.get("/api/admin/security-settings", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const s = await getSecSettings();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...s, secretAdminPath: s.secretAdminPath || "/admin" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/security-settings", async (req, res) => {
  try {
    const { user, pass, ...updates } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && a.role === "owner"))
      return res.status(401).json({ error: "Unauthorized — owner only" });
    const current = await getSecSettings();
    const next = { ...current };
    if (typeof updates.lockoutThreshold === "number") next.lockoutThreshold = Math.max(1, Math.min(20, updates.lockoutThreshold));
    if (typeof updates.lockoutMinutes === "number") next.lockoutMinutes = Math.max(1, Math.min(1440, updates.lockoutMinutes));
    if (typeof updates.sessionTimeoutMinutes === "number") next.sessionTimeoutMinutes = Math.max(5, Math.min(1440, updates.sessionTimeoutMinutes));
    if (typeof updates.secretAdminPath === "string") next.secretAdminPath = updates.secretAdminPath.trim() || "/admin";
    if (typeof updates.twoFaEnabled === "boolean") next.twoFaEnabled = updates.twoFaEnabled;
    await setSecSettings(next);
    await appendActivity({ msg: `Security settings updated by ${user}`, color: "yellow" });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Login log ────────────────────────────────────────────────────────────────
app.get("/api/admin/login-log", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json(await getLoginLog());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IP Bans ──────────────────────────────────────────────────────────────────
app.get("/api/admin/ip-bans", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json(await getIpBans());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/ip-bans", async (req, res) => {
  try {
    const { user, pass, ip, reason, expiresAt } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && (a.role === "owner" || a.role === "admin")))
      return res.status(401).json({ error: "Unauthorized" });
    if (!ip) return res.status(400).json({ error: "IP required" });
    const bans = await getIpBans();
    if (bans.find(b => b.ip === ip)) return res.status(409).json({ error: "IP already banned" });
    bans.push({ ip, reason: (reason||"").trim().slice(0,100), bannedBy: user, date: todayStr(), expiresAt: expiresAt || null });
    await Promise.all([setIpBans(bans), appendActivity({ msg: `IP banned by ${user}: ${ip}${reason?" ("+reason+")":""}`, color: "red" })]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/ip-bans", async (req, res) => {
  try {
    const { user, pass, ip } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const bans = await getIpBans();
    const before = bans.length;
    const next = bans.filter(b => b.ip !== ip);
    if (next.length === before) return res.status(404).json({ error: "IP not found" });
    await Promise.all([setIpBans(next), appendActivity({ msg: `IP unbanned by ${user}: ${ip}`, color: "green" })]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Sessions ─────────────────────────────────────────────────────────────────
app.get("/api/admin/sessions", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const sessions = await getSessions();
    const now = Date.now();
    const settings = await getSecSettings();
    const timeoutMs = (settings.sessionTimeoutMinutes || 60) * 60 * 1000;
    // Filter out expired sessions
    const active = Object.entries(sessions)
      .filter(([,s]) => now - new Date(s.lastSeen).getTime() < timeoutMs)
      .map(([token, s]) => ({ token, ...s }));
    res.setHeader("Cache-Control", "no-store");
    res.json(active);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/sessions/:token", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && (a.role === "owner" || a.role === "admin")))
      return res.status(401).json({ error: "Unauthorized" });
    const sessions = await getSessions();
    const token = req.params.token;
    if (!sessions[token]) return res.status(404).json({ error: "Session not found" });
    const targetUser = sessions[token].user;
    delete sessions[token];
    await Promise.all([setSessions(sessions), appendActivity({ msg: `Session force-logged-out by ${user}: ${targetUser}`, color: "red" })]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/sessions/heartbeat", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Token required" });
    const sessions = await getSessions();
    if (!sessions[token]) return res.status(401).json({ error: "Session not found" });
    sessions[token].lastSeen = new Date().toISOString();
    await setSessions(sessions);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 2FA / TOTP ────────────────────────────────────────────────────────────────
app.post("/api/admin/totp/setup", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const { randomBytes } = await import("node:crypto");
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const secret = Array.from(randomBytes(16)).map(b => chars[b % 32]).join("");
    // Store secret temporarily (admin must verify before it's activated)
    const secrets = (await kget("nova:totp-pending")) || {};
    secrets[user] = secret;
    await kset("nova:totp-pending", secrets);
    const issuer = "Nova Admin";
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    res.json({ secret, otpauthUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/totp/verify", async (req, res) => {
  try {
    const { user, pass, token } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const pending = (await kget("nova:totp-pending")) || {};
    const secret = pending[user];
    if (!secret) return res.status(400).json({ error: "No pending TOTP setup" });
    const valid = await totpVerify(secret, token);
    if (!valid) return res.status(400).json({ error: "Invalid code" });
    // Activate
    const secrets = (await kget("nova:totp-secrets")) || {};
    secrets[user] = secret;
    delete pending[user];
    await Promise.all([
      kset("nova:totp-secrets", secrets),
      kset("nova:totp-pending", pending),
      appendActivity({ msg: `2FA enabled by ${user}`, color: "green" }),
    ]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/totp/disable", async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const secrets = (await kget("nova:totp-secrets")) || {};
    delete secrets[user];
    await Promise.all([
      kset("nova:totp-secrets", secrets),
      appendActivity({ msg: `2FA disabled by ${user}`, color: "yellow" }),
    ]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Unlock a locked account ──────────────────────────────────────────────────
app.post("/api/admin/unlock", async (req, res) => {
  try {
    const { user, pass, targetUser } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass && (a.role === "owner" || a.role === "admin")))
      return res.status(401).json({ error: "Unauthorized" });
    const attempts = await getLoginAttempts();
    delete attempts[targetUser];
    await Promise.all([setLoginAttempts(attempts), appendActivity({ msg: `Account unlocked by ${user}: ${targetUser}`, color: "green" })]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Override login to add lockout, session tracking, IP ban, 2FA ─────────────
// Remove old login route and replace below
app.post("/api/admin/login", async (req, res) => {
  try {
    const { user, pass, totpToken } = req.body || {};
    const ip = getClientIp(req);
    const ua = (req.headers["user-agent"] || "").slice(0, 200);
    const settings = await getSecSettings();
    const threshold = settings.lockoutThreshold || 5;
    const lockoutMs = (settings.lockoutMinutes || 15) * 60 * 1000;

    // Check attempts
    const attempts = await getLoginAttempts();
    const rec = attempts[user] || { count: 0 };
    if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
      const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      await appendLoginLog({ user: user || "?", ip, ua, success: false, reason: "locked" }).catch(()=>{});
      return res.status(429).json({ error: `Account locked. Try again in ${mins} minute${mins!==1?"s":""}` });
    }

    const admins = await getAdmins();
    const found = admins.find(a => a.user === user && a.pass === pass);
    if (!found) {
      rec.count = (rec.count || 0) + 1;
      if (rec.count >= threshold) {
        rec.lockedUntil = Date.now() + lockoutMs;
        rec.count = 0;
      }
      attempts[user] = rec;
      await Promise.all([
        setLoginAttempts(attempts),
        appendLoginLog({ user: user||"?", ip, ua, success: false, reason: "bad credentials" }),
        appendActivity({ msg: `Failed login attempt for "${user||"?"}" from ${ip}`, color: "red" }),
      ]).catch(()=>{});
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check 2FA if enabled for this user
    const secrets = (await kget("nova:totp-secrets")) || {};
    if (secrets[user]) {
      if (!totpToken) return res.status(401).json({ error: "2FA code required", requires2fa: true });
      const valid = await totpVerify(secrets[user], totpToken);
      if (!valid) {
        await appendLoginLog({ user, ip, ua, success: false, reason: "invalid 2FA" }).catch(()=>{});
        return res.status(401).json({ error: "Invalid 2FA code" });
      }
    }

    // Clear lockout on success
    if (attempts[user]) { delete attempts[user]; await setLoginAttempts(attempts).catch(()=>{}); }

    // Create session token
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(24).toString("hex");
    const sessions = await getSessions();
    // Prune old sessions for this user (max 5 concurrent)
    const userSessions = Object.entries(sessions).filter(([,s]) => s.user === user);
    if (userSessions.length >= 5) {
      userSessions.sort((a,b) => new Date(a[1].lastSeen) - new Date(b[1].lastSeen));
      delete sessions[userSessions[0][0]];
    }
    sessions[token] = { user, role: found.role, ip, ua, created: new Date().toISOString(), lastSeen: new Date().toISOString() };
    await Promise.all([
      setSessions(sessions),
      appendLoginLog({ user, ip, ua, success: true, reason: "" }),
      appendActivity({ msg: `Login by ${user} from ${ip}`, color: "green" }),
    ]).catch(()=>{});

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, role: found.role, user: found.user, sessionToken: token });
  } catch(e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Broadcast / Announcement ──────────────────────────────────────────────────
//  nova:broadcast → { text, date, publishedBy } | null

// Public — any visitor polls this to show the banner (served from cache, 0 Redis calls)
app.get("/api/broadcast", async (_req, res) => {
  try {
    const msg = await getBroadcast();
    res.setHeader("Cache-Control", "no-store");
    res.json(msg || { text: "", date: "", publishedBy: "" });
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// Admin — publish a new announcement
app.post("/api/broadcast", async (req, res) => {
  try {
    const { user, pass, text } = req.body || {};
    const admins = await getAdmins();
    const me = admins.find(a => a.user === user && a.pass === pass);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (typeof text !== "string") return res.status(400).json({ error: "text required" });
    const trimmed = text.trim().slice(0, 300);
    const log = await getLog();
    if (trimmed) {
      const entry = { text: trimmed, date: todayStr(), publishedBy: user };
      const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      log.bcHistory.unshift({ ...entry, time: now });
      if (log.bcHistory.length > 20) log.bcHistory.length = 20;
      log.activity.unshift(buildActivityEntry({ msg: `Broadcast published by ${user}: "${trimmed.slice(0,60)}${trimmed.length>60?"…":""}"`, color: "yellow" }));
      if (log.activity.length > 100) log.activity.length = 100;
      await Promise.all([setBroadcast(entry), saveLog()]);
    } else {
      log.activity.unshift(buildActivityEntry({ msg: `Broadcast cleared by ${user}`, color: "yellow" }));
      if (log.activity.length > 100) log.activity.length = 100;
      await Promise.all([setBroadcast(null), saveLog()]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — get broadcast history
app.get("/api/broadcast/history", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json((await getLog()).bcHistory || []);
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// ── Blocked URLs ──────────────────────────────────────────────────────────────
//  nova:blocked → JSON array of { url, reason, date, blockedBy }
//  Public GET so the client-side proxy can check before navigating

// Public — served from cache, 0 Redis calls after first load
app.get("/api/blocked", async (_req, res) => {
  try {
    const list = await getBlocked();
    res.setHeader("Cache-Control", "no-store");
    res.json(list.map(b => ({ url: b.url, reason: b.reason || "" })));
  } catch (e) { res.status(500).json({ error: "Storage unavailable" }); }
});

// Admin — add a blocked URL
app.post("/api/blocked", async (req, res) => {
  try {
    const { user, pass, url, reason } = req.body || {};
    const admins = await getAdmins();
    const me = admins.find(a => a.user === user && a.pass === pass);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
    const cleanUrl = url.trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!cleanUrl) return res.status(400).json({ error: "Invalid URL" });
    const list = await getBlocked();
    if (list.find(b => b.url === cleanUrl)) return res.status(409).json({ error: "Already blocked" });
    const entry = {
      url: cleanUrl,
      reason: (reason || "").trim().slice(0, 100),
      date: todayStr(),
      blockedBy: user,
    };
    list.push(entry);
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const log = await getLog();
    log.bcHistory.unshift({
      text: `🚫 URL blocked: ${cleanUrl}${entry.reason ? " — " + entry.reason : ""}`,
      date: todayStr(), time: now, publishedBy: user, type: "block",
    });
    if (log.bcHistory.length > 50) log.bcHistory.length = 50;
    log.activity.unshift(buildActivityEntry({ msg: `URL blocked by ${user}: ${cleanUrl}${entry.reason ? ` (${entry.reason})` : ""}`, color: "red" }));
    if (log.activity.length > 100) log.activity.length = 100;
    await Promise.all([setBlocked(list), saveLog()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — remove a blocked URL
app.delete("/api/blocked", async (req, res) => {
  try {
    const { user, pass, url } = req.body || {};
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    const cleanUrl = (url || "").trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const list = await getBlocked();
    const before = list.length;
    const newList = list.filter(b => b.url !== cleanUrl);
    if (newList.length === before) return res.status(404).json({ error: "URL not found in block list" });
    await Promise.all([
      setBlocked(newList),
      appendActivity({ msg: `URL unblocked by ${user}: ${cleanUrl}`, color: "green" }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — get full blocked list with metadata
app.get("/api/blocked/admin", async (req, res) => {
  try {
    const { user, pass } = req.query;
    const admins = await getAdmins();
    if (!admins.find(a => a.user === user && a.pass === pass))
      return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "no-store");
    res.json(await getBlocked());
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
