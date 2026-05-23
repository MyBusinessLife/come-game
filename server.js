/* CAG POS API (AlwaysData / MySQL) - v1
 *
 * Features:
 * - JWT auth (Bearer token)
 * - CORS restricted to configured origins (ex: https://mybusinesslife.fr)
 * - Password migration: if users.password is plaintext, it is upgraded to bcrypt on first successful login
 * - CRUD: products, offers (with offer_products join)
 * - Financial dashboard summary + sales listing/details
 *
 * IMPORTANT: Do not expose your DB credentials in the frontend (Webflow). They only live here, server-side.
 */

"use strict";

const path = require("path");
const fs = require("fs");
// Load env from the same directory as this file (useful on AlwaysData where cwd may differ).
require("dotenv").config({ path: path.join(__dirname, ".env") });

const fastify = require("fastify")({
  logger: true,
  trustProxy: true,
});

const cors = require("@fastify/cors");
const helmet = require("@fastify/helmet");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const QRCode = require("qrcode");

function env(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function envBool(name, fallback) {
  const v = env(name, fallback ? "1" : "0");
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function parseCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function clampHour(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

const CFG = {
  // AlwaysData may expose either HOST or IP. Prefer HOST, then IP.
  // Default to IPv6 any ("::") because AlwaysData expects an IPv6 listener.
  host: env("HOST", env("IP", "::")),
  port: Number(env("PORT", "3000")),
  apiPrefix: env("API_PREFIX", "/api").replace(/\/+$/, ""),
  jwtSecret: env("JWT_SECRET", ""),
  jwtExpires: env("JWT_EXPIRES", "12h"),
  publicBaseUrl: env("PUBLIC_BASE_URL", "https://cag.mybusinesslife.fr").replace(/\/+$/, ""),
  migratePlaintextPasswords: envBool("MIGRATE_PLAINTEXT_PASSWORDS", false),
  migratePlaintextPasswordsOverwrite: envBool("MIGRATE_PLAINTEXT_PASSWORDS_OVERWRITE", false),
  businessDayStartHour: clampHour(env("BUSINESS_DAY_START_HOUR", "12"), 12),
  businessDayEndHour: clampHour(env("BUSINESS_DAY_END_HOUR", "3"), 3),
  corsOrigins: parseCsv(env("CORS_ORIGINS", "https://mybusinesslife.fr,https://www.mybusinesslife.fr")),
  enforceRoles: envBool("ENFORCE_ROLES", true),
  writeRoles: parseCsv(env("WRITE_ROLES", "admin,manager")).map((r) => r.toLowerCase()),
  db: {
    host: env("DB_HOST", ""),
    port: Number(env("DB_PORT", "3306")),
    name: env("DB_NAME", ""),
    user: env("DB_USER", ""),
    password: env("DB_PASSWORD", ""),
    connectionLimit: Number(env("DB_CONN_LIMIT", "10")),
  },
};

const BUSINESS_START_TIME = `${String(CFG.businessDayStartHour).padStart(2, "0")}:00:00`;
const BUSINESS_END_TIME = `${String(CFG.businessDayEndHour).padStart(2, "0")}:00:00`;
const BUSINESS_CROSSES_MIDNIGHT = CFG.businessDayStartHour >= CFG.businessDayEndHour;

if (!CFG.jwtSecret) {
  // Fail closed: no secret means no auth.
  throw new Error("Missing JWT_SECRET env var");
}
if (!CFG.db.host || !CFG.db.name || !CFG.db.user) {
  throw new Error("Missing DB_* env vars (DB_HOST, DB_NAME, DB_USER, DB_PASSWORD)");
}

const pool = mysql.createPool({
  host: CFG.db.host,
  port: CFG.db.port,
  user: CFG.db.user,
  password: CFG.db.password,
  database: CFG.db.name,
  waitForConnections: true,
  connectionLimit: CFG.db.connectionLimit,
  timezone: "Z",
  decimalNumbers: true,
});

function getConnectionWithTimeout(ms) {
  const waitMs = Number.isFinite(Number(ms)) ? Math.max(500, Number(ms)) : 4000;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      const err = new Error(`DB pool acquire timeout (${waitMs}ms)`);
      err.code = "DB_POOL_TIMEOUT";
      reject(err);
    }, waitMs);

    pool
      .getConnection()
      .then((conn) => {
        if (done) {
          conn.release();
          return;
        }
        clearTimeout(timer);
        resolve(conn);
      })
      .catch((err) => {
        if (done) return;
        clearTimeout(timer);
        reject(err);
      });
  });
}

fastify.decorate("db", pool);

let HAS_PASSWORD_HASH_COLUMN = false;
let POS_SYNC_TABLE_READY = false;
let LINK_PAGES_TABLE_READY = false;
const POS_SCHEMA = {
  sales: new Set(),
  salesDetails: new Set(),
  products: new Set(),
};

fastify.register(helmet, {
  global: true,
  // Dashboard assets are loaded from Webflow on another origin.
  // `same-origin` can block JS/CSS loading in modern browsers.
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

fastify.register(cors, {
  origin: (origin, cb) => {
    // Allow server-to-server or curl without Origin header.
    if (!origin) return cb(null, true);
    // If origin isn't allowed, we simply disable CORS headers.
    // Browsers will then block XHR/fetch automatically, without breaking script/css loads.
    if (CFG.corsOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// ---- STATIC (optional) ----
// If `cag-pos-dashboard.js/css` are deployed next to server.js (or one directory above),
// you can load them from the same AlwaysData domain:
// - https://<site>/cag-pos-dashboard.js
// - https://<site>/cag-pos-dashboard.css
function resolveAsset(fileName) {
  const candidates = [
    path.join(__dirname, fileName),
    path.join(__dirname, "..", fileName),
  ];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {
      // continue
    }
  }
  return null;
}

const ASSET_PATHS = {
  js: resolveAsset("cag-pos-dashboard.js"),
  css: resolveAsset("cag-pos-dashboard.css"),
};

const POS_ASSET_PATHS = {
  index: resolveAsset("pos-app/index.html"),
  js: resolveAsset("pos-app/app.js"),
  css: resolveAsset("pos-app/app.css"),
  sw: resolveAsset("pos-app/sw.js"),
  manifest: resolveAsset("pos-app/manifest.webmanifest"),
  iconMain: resolveAsset("pos-app/icons/icon.svg"),
  iconMaskable: resolveAsset("pos-app/icons/icon-maskable.svg"),
};

function sendAsset(reply, kind) {
  const p = ASSET_PATHS[kind];
  if (!p) return sendError(reply, 404, "Asset not found", { kind });
  const buf = fs.readFileSync(p);
  reply.header("Cache-Control", "public, max-age=300");
  if (kind === "js") reply.type("application/javascript; charset=utf-8").send(buf);
  else reply.type("text/css; charset=utf-8").send(buf);
}

fastify.get("/cag-pos-dashboard.js", async (_req, reply) => sendAsset(reply, "js"));
fastify.get("/cag-pos-dashboard.css", async (_req, reply) => sendAsset(reply, "css"));

function sendPosAsset(reply, kind) {
  const p = POS_ASSET_PATHS[kind];
  if (!p) return sendError(reply, 404, "POS asset not found", { kind });
  const buf = fs.readFileSync(p);
  if (kind === "index") {
    reply.header("Cache-Control", "no-cache");
    reply.type("text/html; charset=utf-8").send(buf);
    return;
  }
  if (kind === "js") {
    reply.header("Cache-Control", "public, max-age=300");
    reply.type("application/javascript; charset=utf-8").send(buf);
    return;
  }
  if (kind === "css") {
    reply.header("Cache-Control", "public, max-age=300");
    reply.type("text/css; charset=utf-8").send(buf);
    return;
  }
  if (kind === "sw") {
    reply.header("Cache-Control", "no-cache");
    reply.header("Service-Worker-Allowed", "/");
    reply.type("application/javascript; charset=utf-8").send(buf);
    return;
  }
  if (kind === "manifest") {
    reply.header("Cache-Control", "public, max-age=300");
    reply.type("application/manifest+json; charset=utf-8").send(buf);
    return;
  }
  if (kind === "iconMain" || kind === "iconMaskable") {
    reply.header("Cache-Control", "public, max-age=86400");
    reply.type("image/svg+xml").send(buf);
    return;
  }
  return sendError(reply, 404, "Unsupported POS asset kind", { kind });
}

fastify.get("/pos", async (_req, reply) => sendPosAsset(reply, "index"));
fastify.get("/pos/", async (_req, reply) => sendPosAsset(reply, "index"));
fastify.get("/pos/index.html", async (_req, reply) => sendPosAsset(reply, "index"));
fastify.get("/pos/app.js", async (_req, reply) => sendPosAsset(reply, "js"));
fastify.get("/pos/app.css", async (_req, reply) => sendPosAsset(reply, "css"));
fastify.get("/pos/sw.js", async (_req, reply) => sendPosAsset(reply, "sw"));
fastify.get("/pos/manifest.webmanifest", async (_req, reply) => sendPosAsset(reply, "manifest"));
fastify.get("/pos/icons/icon.svg", async (_req, reply) => sendPosAsset(reply, "iconMain"));
fastify.get("/pos/icons/icon-maskable.svg", async (_req, reply) => sendPosAsset(reply, "iconMaskable"));

function sendError(reply, status, message, extra) {
  reply.code(status).send(Object.assign({ message }, extra || {}));
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDaysIso(iso, deltaDays) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function rangeToSql(fromIso, toIso) {
  if (!isISODate(fromIso) || !isISODate(toIso)) return null;
  const from = `${fromIso} ${BUSINESS_START_TIME}`;
  const endDay = BUSINESS_CROSSES_MIDNIGHT ? addDaysIso(toIso, 1) : toIso;
  const toExcl = `${endDay} ${BUSINESS_END_TIME}`;
  return { from, toExcl, businessStartTime: BUSINESS_START_TIME, businessEndTime: BUSINESS_END_TIME };
}

function businessWindowSql(columnExpr) {
  if (BUSINESS_CROSSES_MIDNIGHT) {
    return `(TIME(${columnExpr}) >= '${BUSINESS_START_TIME}' OR TIME(${columnExpr}) < '${BUSINESS_END_TIME}')`;
  }
  return `(TIME(${columnExpr}) >= '${BUSINESS_START_TIME}' AND TIME(${columnExpr}) < '${BUSINESS_END_TIME}')`;
}

function businessDateSql(columnExpr) {
  if (BUSINESS_CROSSES_MIDNIGHT) {
    return `CASE
      WHEN TIME(${columnExpr}) < '${BUSINESS_END_TIME}' THEN DATE_SUB(DATE(${columnExpr}), INTERVAL 1 DAY)
      ELSE DATE(${columnExpr})
    END`;
  }
  return `DATE(${columnExpr})`;
}

function normalizeCategory(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function parseRoles(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "object") return Object.keys(raw);
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(String);
    if (j && typeof j === "object") return Object.keys(j);
  } catch (_) {
    // ignore
  }
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function hasWriteRole(user) {
  if (!CFG.enforceRoles) return true;
  const roles = parseRoles(user && user.roles).map((r) => String(r).toLowerCase());
  const set = new Set(roles);
  return CFG.writeRoles.some((r) => set.has(r));
}

function passwordLooksHashed(pw) {
  if (typeof pw !== "string" || !pw) return false;
  // bcrypt
  if (pw.startsWith("$2a$") || pw.startsWith("$2b$") || pw.startsWith("$2y$")) return true;
  // argon2 formats (if you ever migrate later)
  if (pw.startsWith("$argon2id$") || pw.startsWith("$argon2i$")) return true;
  return false;
}

async function getUserByUsername(username) {
  const sql = HAS_PASSWORD_HASH_COLUMN
    ? `SELECT id_user, username, password, password_hash, roles, last_login, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`
    : `SELECT id_user, username, password, roles, last_login, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`;
  const [rows] = await pool.query(sql, [username]);
  return rows && rows[0] ? rows[0] : null;
}

async function getUserById(idUser) {
  const [rows] = await pool.query(
    `SELECT id_user, username, roles, last_login, is_active
     FROM users
     WHERE id_user = ?
     LIMIT 1`,
    [idUser]
  );
  return rows && rows[0] ? rows[0] : null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id_user: u.id_user,
    username: u.username,
    roles: u.roles,
    last_login: u.last_login,
    is_active: u.is_active,
  };
}

function getBearerToken(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function requireAuth(req, reply) {
  const token = getBearerToken(req);
  if (!token) return sendError(reply, 401, "Unauthorized");
  let payload;
  try {
    payload = jwt.verify(token, CFG.jwtSecret);
  } catch (_) {
    return sendError(reply, 401, "Unauthorized");
  }
  const idUser = payload && (payload.sub || payload.id_user || payload.idUser);
  if (!idUser) return sendError(reply, 401, "Unauthorized");
  const user = await getUserById(idUser);
  if (!user || String(user.is_active) === "0") return sendError(reply, 401, "Unauthorized");
  req.cagUser = user;
}

function requireWrite(req, reply) {
  if (!hasWriteRole(req.cagUser)) return sendError(reply, 403, "Forbidden");
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function toMysqlUtcDateTime(input) {
  const d = input ? new Date(input) : new Date();
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

function asPositiveNumber(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function sanitizeText(v, maxLen) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.slice(0, maxLen);
}

function sanitizeNullableText(v, maxLen) {
  const s = sanitizeText(v, maxLen);
  return s || null;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeImageUrl(v) {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, 1024);
}

function slugify(value) {
  const base = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "page-clients";
}

function sanitizeSlug(value) {
  const raw = sanitizeText(value, 96).toLowerCase();
  if (!raw) return "";
  return slugify(raw).slice(0, 96);
}

function sanitizeEmail(value) {
  const email = sanitizeText(value, 254);
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error("Invalid email");
    err.statusCode = 400;
    throw err;
  }
  return email;
}

function sanitizePhone(value) {
  const phone = sanitizeText(value, 64);
  if (!phone) return null;
  if (!/^[0-9+().\s-]{6,64}$/.test(phone)) {
    const err = new Error("Invalid phone");
    err.statusCode = 400;
    throw err;
  }
  return phone;
}

function normalizeHttpUrl(value) {
  const raw = sanitizeText(value, 1024);
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    const err = new Error("Invalid URL");
    err.statusCode = 400;
    throw err;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const err = new Error("Invalid URL protocol");
    err.statusCode = 400;
    throw err;
  }
  return parsed.toString().slice(0, 1024);
}

function normalizeSocialLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  const out = [];
  for (const raw of rawLinks.slice(0, 20)) {
    const item = raw || {};
    const url = normalizeHttpUrl(item.url);
    if (!url) continue;
    const kind = sanitizeText(item.kind, 32).toLowerCase() || "custom";
    const label = sanitizeText(item.label, 80) || linkKindLabel(kind);
    out.push({
      kind,
      label,
      url,
    });
  }
  return out;
}

function linkKindLabel(kind) {
  const map = {
    website: "Site web",
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    youtube: "YouTube",
    linkedin: "LinkedIn",
    x: "X",
    twitter: "X",
    snapchat: "Snapchat",
    whatsapp: "WhatsApp",
    google: "Google",
    reviews: "Avis Google",
    maps: "Itinéraire",
    discord: "Discord",
  };
  return map[String(kind || "").toLowerCase()] || "Lien";
}

function parseLinksJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function publicBaseUrl(req) {
  if (CFG.publicBaseUrl) return CFG.publicBaseUrl;
  const proto = (req.headers && (req.headers["x-forwarded-proto"] || req.protocol)) || "https";
  const host = req.headers && req.headers.host ? req.headers.host : "cag.mybusinesslife.fr";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function pagePublicUrl(req, slug) {
  return `${publicBaseUrl(req)}/links/${encodeURIComponent(String(slug || ""))}`;
}

function pageQrPublicUrl(req, slug) {
  return `${publicBaseUrl(req)}/qr/${encodeURIComponent(String(slug || ""))}.png`;
}

function safePublicHref(value) {
  const raw = String(value || "").trim();
  if (!raw) return "#";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:" || parsed.protocol === "tel:") {
      return raw;
    }
  } catch (_) {
    // keep fallback
  }
  return "#";
}

function sanitizeClientSaleUid(v) {
  const raw = sanitizeText(v, 128);
  if (!raw) return "";
  if (!/^[a-zA-Z0-9._:-]{6,128}$/.test(raw)) return "";
  return raw;
}

function normalizePaymentMethod(v) {
  const method = sanitizeText(v, 32).toLowerCase();
  if (!method) return "unknown";
  const allowed = new Set(["cash", "card", "mobile", "transfer", "check", "mixed", "unknown"]);
  return allowed.has(method) ? method : "unknown";
}

function parseSaleItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    const e = new Error("Missing items");
    e.statusCode = 400;
    throw e;
  }
  const out = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i] || {};
    const productId = Number(item.productId != null ? item.productId : item.product_id);
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice != null ? item.unitPrice : item.price);
    if (!Number.isInteger(productId) || productId <= 0) {
      const e = new Error(`Invalid productId for item #${i + 1}`);
      e.statusCode = 400;
      throw e;
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
      const e = new Error(`Invalid quantity for item #${i + 1}`);
      e.statusCode = 400;
      throw e;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100000000) {
      const e = new Error(`Invalid unitPrice for item #${i + 1}`);
      e.statusCode = 400;
      throw e;
    }
    const lineTotalRaw = item.totalPrice != null ? Number(item.totalPrice) : unitPrice * quantity;
    const lineTotal = round2(lineTotalRaw);
    if (!Number.isFinite(lineTotal) || lineTotal < 0 || lineTotal > 100000000) {
      const e = new Error(`Invalid totalPrice for item #${i + 1}`);
      e.statusCode = 400;
      throw e;
    }
    out.push({
      productId,
      quantity,
      unitPrice: round2(unitPrice),
      totalPrice: lineTotal,
      productName: sanitizeText(item.productName != null ? item.productName : item.product_name, 160),
    });
  }
  return out;
}

function normalizeSalePayload(rawBody) {
  const body = rawBody || {};
  const items = parseSaleItems(body.items);
  const subtotal = round2(items.reduce((acc, x) => acc + x.totalPrice, 0));
  const discountAmount = round2(asPositiveNumber(body.discountAmount != null ? body.discountAmount : body.discount_amount, 0));
  const taxAmount = round2(asPositiveNumber(body.taxAmount != null ? body.taxAmount : body.tax_amount, 0));
  const computedTotal = round2(Math.max(0, subtotal - discountAmount + taxAmount));
  const receivedAmount = round2(asPositiveNumber(body.receivedAmount != null ? body.receivedAmount : body.received_amount, 0));
  const explicitChange = asPositiveNumber(body.changeAmount != null ? body.changeAmount : body.change_amount, null);
  const changeAmount = round2(explicitChange == null ? Math.max(0, receivedAmount - computedTotal) : explicitChange);
  const clientSaleUid =
    sanitizeClientSaleUid(body.clientSaleUid != null ? body.clientSaleUid : body.client_sale_uid) ||
    `uid-${crypto.randomUUID()}`;
  const createdAtSql = toMysqlUtcDateTime(body.createdAt != null ? body.createdAt : body.created_at) || toMysqlUtcDateTime(null);

  return {
    clientSaleUid,
    deviceId: sanitizeText(body.deviceId != null ? body.deviceId : body.device_id, 80),
    paymentMethod: normalizePaymentMethod(body.paymentMethod != null ? body.paymentMethod : body.payment_method),
    notes: sanitizeText(body.notes, 600),
    items,
    subtotal,
    discountAmount,
    taxAmount,
    totalAmount: computedTotal,
    receivedAmount,
    changeAmount,
    createdAtSql,
  };
}

function hasTableColumn(tableKey, columnName) {
  const set = POS_SCHEMA[tableKey];
  if (!set || !(set instanceof Set)) return false;
  return set.has(columnName);
}

function productImageSelectSql(alias) {
  return hasTableColumn("products", "image_url") ? `${alias}.image_url AS image_url` : `NULL AS image_url`;
}

async function loadColumns(tableName) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM ${tableName}`);
  return new Set((rows || []).map((r) => String(r.Field || "")));
}

async function refreshPosSchema() {
  try {
    POS_SCHEMA.sales = await loadColumns("sales");
  } catch (_) {
    POS_SCHEMA.sales = new Set();
  }
  try {
    POS_SCHEMA.salesDetails = await loadColumns("sales_details");
  } catch (_) {
    POS_SCHEMA.salesDetails = new Set();
  }
  try {
    POS_SCHEMA.products = await loadColumns("products");
  } catch (_) {
    POS_SCHEMA.products = new Set();
  }
}

async function ensurePosSyncTable(conn) {
  if (POS_SYNC_TABLE_READY) return;
  await conn.query(
    `CREATE TABLE IF NOT EXISTS pos_sales_sync (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_sale_uid VARCHAR(128) NOT NULL,
      sale_id BIGINT UNSIGNED NULL,
      user_id BIGINT UNSIGNED NULL,
      device_id VARCHAR(80) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY ux_pos_sales_sync_uid (client_sale_uid),
      KEY idx_pos_sales_sync_sale_id (sale_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  POS_SYNC_TABLE_READY = true;
}

async function ensureLinkPagesTable() {
  if (LINK_PAGES_TABLE_READY) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS customer_link_pages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      slug VARCHAR(96) NOT NULL,
      title VARCHAR(160) NOT NULL,
      subtitle VARCHAR(220) NULL,
      description TEXT NULL,
      email VARCHAR(254) NULL,
      phone VARCHAR(64) NULL,
      links_json LONGTEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT UNSIGNED NULL,
      updated_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY ux_customer_link_pages_slug (slug),
      KEY idx_customer_link_pages_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  LINK_PAGES_TABLE_READY = true;
}

async function uniqueLinkPageSlug(baseSlug, exceptId) {
  const base = sanitizeSlug(baseSlug) || "page-clients";
  let candidate = base;
  for (let i = 2; i < 1000; i += 1) {
    const values = [candidate];
    let extra = "";
    if (exceptId != null) {
      extra = " AND id <> ?";
      values.push(Number(exceptId));
    }
    const [rows] = await pool.query(
      `SELECT id FROM customer_link_pages WHERE slug = ?${extra} LIMIT 1`,
      values
    );
    if (!rows || !rows.length) return candidate;
    const suffix = `-${i}`;
    candidate = `${base.slice(0, 96 - suffix.length)}${suffix}`;
  }
  return `${base.slice(0, 86)}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeLinkPagePayload(body, options) {
  const opts = options || {};
  const source = body || {};
  const title = sanitizeText(source.title, 160);
  if (!opts.partial && !title) {
    const err = new Error("Title is required");
    err.statusCode = 400;
    throw err;
  }

  const out = {};
  if (!opts.partial || source.title !== undefined) out.title = title;
  if (!opts.partial || source.subtitle !== undefined) out.subtitle = sanitizeNullableText(source.subtitle, 220);
  if (!opts.partial || source.description !== undefined) out.description = sanitizeNullableText(source.description, 1200);
  if (!opts.partial || source.email !== undefined) out.email = sanitizeEmail(source.email);
  if (!opts.partial || source.phone !== undefined) out.phone = sanitizePhone(source.phone);
  if (!opts.partial || source.links !== undefined) out.links = normalizeSocialLinks(source.links);
  if (!opts.partial || source.isActive !== undefined || source.is_active !== undefined) {
    const rawActive = source.isActive !== undefined ? source.isActive : source.is_active;
    out.isActive = rawActive === undefined ? true : !(rawActive === false || rawActive === "false" || rawActive === "0" || rawActive === 0);
  }
  if (source.slug !== undefined) out.slug = sanitizeSlug(source.slug);
  return out;
}

function linkPageHasContactContent(page) {
  return !!(
    (page && page.email) ||
    (page && page.phone) ||
    (page && Array.isArray(page.links) && page.links.length)
  );
}

function linkPageFromRow(row, req) {
  const links = parseLinksJson(row.links_json);
  return {
    id: Number(row.id),
    slug: row.slug || "",
    title: row.title || "",
    subtitle: row.subtitle || "",
    description: row.description || "",
    email: row.email || "",
    phone: row.phone || "",
    links,
    isActive: !(row.is_active === 0 || row.is_active === "0"),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    publicUrl: pagePublicUrl(req, row.slug),
    qrUrl: pageQrPublicUrl(req, row.slug),
  };
}

async function getLinkPageById(id) {
  await ensureLinkPagesTable();
  const [rows] = await pool.query(`SELECT * FROM customer_link_pages WHERE id = ? LIMIT 1`, [id]);
  return rows && rows[0] ? rows[0] : null;
}

async function getActiveLinkPageBySlug(slug) {
  await ensureLinkPagesTable();
  const [rows] = await pool.query(
    `SELECT * FROM customer_link_pages WHERE slug = ? AND is_active = 1 LIMIT 1`,
    [slug]
  );
  return rows && rows[0] ? rows[0] : null;
}

async function sendQrPng(reply, value, fileName) {
  const png = await QRCode.toBuffer(value, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 1600,
    margin: 1,
    color: {
      dark: "#111827ff",
      light: "#00000000",
    },
  });
  reply
    .header("Cache-Control", "public, max-age=300")
    .header("Content-Disposition", `attachment; filename="${fileName}"`)
    .type("image/png")
    .send(png);
}

function renderPublicLinkPage(page) {
  const links = Array.isArray(page.links) ? page.links : [];
  const contactLinks = [];
  if (page.phone) contactLinks.push({ kind: "phone", label: "Téléphone", url: `tel:${String(page.phone).replace(/\s+/g, "")}` });
  if (page.email) contactLinks.push({ kind: "email", label: "Email", url: `mailto:${page.email}` });
  const allLinks = contactLinks.concat(links);
  const initials = String(page.title || "CAG")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();

  const buttons = allLinks
    .map((link) => {
      const label = escapeHtml(link.label || linkKindLabel(link.kind));
      const url = escapeHtml(safePublicHref(link.url));
      const kind = escapeHtml(link.kind || "custom");
      return `<a class="client-link" data-kind="${kind}" href="${url}" target="${kind === "phone" || kind === "email" ? "_self" : "_blank"}" rel="noopener">${label}<span>Ouvrir</span></a>`;
    })
    .join("");

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)} - Liens utiles</title>
  <meta name="description" content="${escapeHtml(page.description || page.subtitle || "Liens utiles, email et téléphone.")}">
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#5b6475; --line:rgba(17,24,39,.12); --teal:#0ea5a4; --orange:#f97316; --bg:#f7f9fb; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:var(--ink); background:linear-gradient(180deg,#ffffff 0%,var(--bg) 100%); }
    main { min-height:100vh; display:grid; place-items:center; padding:28px 16px; }
    .page { width:min(520px,100%); }
    .brand { display:flex; align-items:center; gap:14px; margin-bottom:20px; }
    .mark { width:58px; height:58px; border-radius:14px; display:grid; place-items:center; background:linear-gradient(135deg,var(--teal),var(--orange)); color:#fff; font-weight:900; letter-spacing:.04em; box-shadow:0 18px 42px rgba(17,24,39,.16); }
    h1 { margin:0; font-size:clamp(30px,8vw,48px); line-height:1; letter-spacing:0; }
    .subtitle { margin:8px 0 0; color:var(--muted); font-size:16px; line-height:1.45; }
    .panel { border:1px solid var(--line); border-radius:8px; background:rgba(255,255,255,.86); box-shadow:0 20px 60px rgba(17,24,39,.12); padding:16px; }
    .desc { margin:0 0 14px; color:#2f3747; line-height:1.55; }
    .links { display:grid; gap:10px; }
    .client-link { min-height:56px; display:flex; align-items:center; justify-content:space-between; gap:14px; padding:14px 15px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); text-decoration:none; font-weight:800; transition:transform .14s ease, border-color .14s ease, box-shadow .14s ease; }
    .client-link:hover { transform:translateY(-1px); border-color:rgba(14,165,164,.48); box-shadow:0 12px 30px rgba(17,24,39,.12); }
    .client-link span { color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
    .empty { color:var(--muted); padding:18px; text-align:center; }
    footer { margin-top:16px; color:var(--muted); text-align:center; font-size:12px; }
    @media (max-width:460px) { main { padding:18px 12px; } .brand { align-items:flex-start; flex-direction:column; } .panel { padding:12px; } }
  </style>
</head>
<body>
  <main>
    <section class="page" aria-label="Liens utiles">
      <div class="brand">
        <div class="mark">${escapeHtml(initials || "CAG")}</div>
        <div>
          <h1>${escapeHtml(page.title)}</h1>
          ${page.subtitle ? `<p class="subtitle">${escapeHtml(page.subtitle)}</p>` : ""}
        </div>
      </div>
      <div class="panel">
        ${page.description ? `<p class="desc">${escapeHtml(page.description)}</p>` : ""}
        <div class="links">${buttons || '<div class="empty">Aucun lien disponible pour le moment.</div>'}</div>
      </div>
      <footer>C&G • Liens clients</footer>
    </section>
  </main>
</body>
</html>`;
}

async function reserveClientSaleUid(conn, sale, userId) {
  if (!sale.clientSaleUid) return { duplicate: false, existingSaleId: null };
  await ensurePosSyncTable(conn);
  try {
    await conn.query(
      `INSERT INTO pos_sales_sync (client_sale_uid, sale_id, user_id, device_id, created_at)
       VALUES (?, NULL, ?, ?, ?)`,
      [sale.clientSaleUid, userId || null, sale.deviceId || null, sale.createdAtSql]
    );
    return { duplicate: false, existingSaleId: null };
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      const [rows] = await conn.query(
        `SELECT sale_id FROM pos_sales_sync WHERE client_sale_uid = ? LIMIT 1`,
        [sale.clientSaleUid]
      );
      const existing = rows && rows[0] ? rows[0].sale_id : null;
      return { duplicate: true, existingSaleId: existing == null ? null : Number(existing) };
    }
    throw err;
  }
}

async function attachSaleIdToUid(conn, sale, userId, saleId) {
  if (!sale.clientSaleUid) return;
  await conn.query(
    `UPDATE pos_sales_sync
     SET sale_id = COALESCE(sale_id, ?),
         user_id = COALESCE(user_id, ?),
         device_id = COALESCE(device_id, ?)
     WHERE client_sale_uid = ?`,
    [saleId, userId, sale.deviceId || null, sale.clientSaleUid]
  );
}

function buildSqlInsert(tableName, cols) {
  const c = cols.map((name) => `\`${name}\``).join(", ");
  const p = cols.map(() => "?").join(", ");
  return `INSERT INTO ${tableName} (${c}) VALUES (${p})`;
}

function buildSaleNotes(sale) {
  const parts = [];
  if (sale.notes) parts.push(sale.notes);
  parts.push(
    `POS pay=${sale.paymentMethod} subtotal=${sale.subtotal.toFixed(2)} discount=${sale.discountAmount.toFixed(2)} tax=${sale.taxAmount.toFixed(2)} total=${sale.totalAmount.toFixed(2)} received=${sale.receivedAmount.toFixed(2)} change=${sale.changeAmount.toFixed(2)} uid=${sale.clientSaleUid}`
  );
  if (sale.deviceId) parts.push(`device=${sale.deviceId}`);
  return parts.join(" | ").slice(0, 1000);
}

async function insertPosSale(conn, userId, sale) {
  const reservation = await reserveClientSaleUid(conn, sale, userId);
  if (reservation.duplicate) {
    if (reservation.existingSaleId == null) {
      const err = new Error("Sale is already syncing, retry shortly");
      err.statusCode = 409;
      throw err;
    }
    return { status: "duplicate", saleId: reservation.existingSaleId };
  }

  const saleCols = [];
  const saleVals = [];
  if (hasTableColumn("sales", "total_amount")) {
    saleCols.push("total_amount");
    saleVals.push(sale.totalAmount);
  }
  if (hasTableColumn("sales", "notes")) {
    saleCols.push("notes");
    saleVals.push(buildSaleNotes(sale));
  }
  if (hasTableColumn("sales", "user_id")) {
    saleCols.push("user_id");
    saleVals.push(userId);
  }
  if (hasTableColumn("sales", "last_updated")) {
    saleCols.push("last_updated");
    saleVals.push(sale.createdAtSql);
  }
  if (hasTableColumn("sales", "created_at")) {
    saleCols.push("created_at");
    saleVals.push(sale.createdAtSql);
  }
  if (hasTableColumn("sales", "is_synced")) {
    saleCols.push("is_synced");
    saleVals.push(0);
  }
  if (!saleCols.length) {
    const err = new Error("Unsupported sales schema");
    err.statusCode = 500;
    throw err;
  }

  const [saleRes] = await conn.query(buildSqlInsert("sales", saleCols), saleVals);
  const saleId = Number(saleRes && saleRes.insertId ? saleRes.insertId : 0);
  if (!saleId) {
    const err = new Error("Could not create sale");
    err.statusCode = 500;
    throw err;
  }

  if (!hasTableColumn("salesDetails", "sale_id") || !hasTableColumn("salesDetails", "product_id")) {
    const err = new Error("Unsupported sales_details schema");
    err.statusCode = 500;
    throw err;
  }

  for (const item of sale.items) {
    const detailCols = ["sale_id", "product_id"];
    const detailVals = [saleId, item.productId];
    if (hasTableColumn("salesDetails", "quantity")) {
      detailCols.push("quantity");
      detailVals.push(item.quantity);
    }
    if (hasTableColumn("salesDetails", "price")) {
      detailCols.push("price");
      detailVals.push(item.unitPrice);
    }
    if (hasTableColumn("salesDetails", "total_price")) {
      detailCols.push("total_price");
      detailVals.push(item.totalPrice);
    }
    if (hasTableColumn("salesDetails", "last_updated")) {
      detailCols.push("last_updated");
      detailVals.push(sale.createdAtSql);
    }
    if (hasTableColumn("salesDetails", "created_at")) {
      detailCols.push("created_at");
      detailVals.push(sale.createdAtSql);
    }
    if (hasTableColumn("salesDetails", "is_synced")) {
      detailCols.push("is_synced");
      detailVals.push(0);
    }
    await conn.query(buildSqlInsert("sales_details", detailCols), detailVals);

    if (hasTableColumn("products", "quantity")) {
      const updates = [
        "quantity = CASE WHEN quantity IS NULL THEN NULL ELSE GREATEST(0, quantity - ?) END",
      ];
      const values = [item.quantity];
      if (hasTableColumn("products", "last_updated")) updates.push("last_updated = ?");
      if (hasTableColumn("products", "last_updated")) values.push(sale.createdAtSql);
      if (hasTableColumn("products", "is_synced")) updates.push("is_synced = 0");
      values.push(item.productId);
      await conn.query(`UPDATE products SET ${updates.join(", ")} WHERE id_product = ?`, values);
    }
  }

  await attachSaleIdToUid(conn, sale, userId, saleId);
  return { status: "created", saleId };
}

async function createPosSaleForUser(user, rawSale) {
  const sale = normalizeSalePayload(rawSale);
  const userId = Number(user && user.id_user);
  if (!Number.isInteger(userId) || userId <= 0) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await insertPosSale(conn, userId, sale);
    await conn.commit();
    return {
      status: result.status,
      saleId: result.saleId,
      clientSaleUid: sale.clientSaleUid,
      totalAmount: sale.totalAmount,
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Health check
fastify.get(CFG.apiPrefix + "/health", async () => {
  return { ok: true };
});

// ---- PUBLIC CLIENT LINK PAGES ----
fastify.get("/links/:slug", async (req, reply) => {
  const slug = sanitizeSlug(req.params && req.params.slug);
  if (!slug) return sendError(reply, 404, "Not found");
  const row = await getActiveLinkPageBySlug(slug);
  if (!row) return sendError(reply, 404, "Not found");
  const page = linkPageFromRow(row, req);
  reply.header("Cache-Control", "public, max-age=120").type("text/html; charset=utf-8").send(renderPublicLinkPage(page));
});

fastify.get("/qr/:slug.png", async (req, reply) => {
  const slug = sanitizeSlug(req.params && req.params.slug);
  if (!slug) return sendError(reply, 404, "Not found");
  const row = await getActiveLinkPageBySlug(slug);
  if (!row) return sendError(reply, 404, "Not found");
  const publicUrl = pagePublicUrl(req, row.slug);
  return sendQrPng(reply, publicUrl, `qr-${row.slug}.png`);
});

// ---- AUTH ----
fastify.post(CFG.apiPrefix + "/auth/login", async (req, reply) => {
  const body = req.body || {};
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) return sendError(reply, 400, "Missing username/password");

  const user = await getUserByUsername(username);
  // Do not reveal if user exists.
  if (!user || String(user.is_active) === "0") return sendError(reply, 401, "Invalid credentials");

  const stored = user.password || "";
  const storedHash = HAS_PASSWORD_HASH_COLUMN ? user.password_hash || "" : "";
  let ok = false;
  try {
    if (passwordLooksHashed(storedHash)) ok = await bcrypt.compare(password, storedHash);
    else if (passwordLooksHashed(stored)) ok = await bcrypt.compare(password, stored);
    else ok = stored === password;
  } catch (_) {
    ok = false;
  }
  if (!ok) return sendError(reply, 401, "Invalid credentials");

  // Upgrade plaintext password to bcrypt on first successful login.
  if (CFG.migratePlaintextPasswords && HAS_PASSWORD_HASH_COLUMN && !passwordLooksHashed(storedHash)) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`UPDATE users SET password_hash = ? WHERE id_user = ?`, [hash, user.id_user]);
  } else if (CFG.migratePlaintextPasswords && !HAS_PASSWORD_HASH_COLUMN && CFG.migratePlaintextPasswordsOverwrite && !passwordLooksHashed(stored)) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`UPDATE users SET password = ? WHERE id_user = ?`, [hash, user.id_user]);
  }

  await pool.query(`UPDATE users SET last_login = NOW() WHERE id_user = ?`, [user.id_user]);

  const token = jwt.sign(
    {
      sub: user.id_user,
      username: user.username,
    },
    CFG.jwtSecret,
    { expiresIn: CFG.jwtExpires }
  );

  reply.send({ token, user: publicUser(user) });
});

fastify.get(
  CFG.apiPrefix + "/auth/me",
  {
    preHandler: requireAuth,
  },
  async (req) => {
    return { user: publicUser(req.cagUser) };
  }
);

// ---- CLIENT LINK PAGES (ADMIN / MANAGER) ----
fastify.get(
  CFG.apiPrefix + "/link-pages",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req) => {
    await ensureLinkPagesTable();
    const q = sanitizeText(req.query && req.query.q, 120);
    const limit = clampInt(req.query && req.query.limit, 1, 100, 50);
    const offset = clampInt(req.query && req.query.offset, 0, 100000, 0);
    const values = [];
    let where = "";
    if (q) {
      where = "WHERE title LIKE ? OR slug LIKE ? OR email LIKE ? OR phone LIKE ?";
      const like = `%${q}%`;
      values.push(like, like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT SQL_CALC_FOUND_ROWS *
       FROM customer_link_pages
       ${where}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      values.concat([limit, offset])
    );
    const [countRows] = await pool.query(`SELECT FOUND_ROWS() AS total`);
    const total = countRows && countRows[0] ? Number(countRows[0].total) : rows.length;
    return {
      items: (rows || []).map((row) => linkPageFromRow(row, req)),
      total,
    };
  }
);

fastify.post(
  CFG.apiPrefix + "/link-pages",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    await ensureLinkPagesTable();
    const payload = normalizeLinkPagePayload(req.body || {});
    if (!linkPageHasContactContent(payload)) return sendError(reply, 400, "At least one contact method or link is required");
    const slug = await uniqueLinkPageSlug(payload.slug || payload.title);
    const userId = Number(req.cagUser && req.cagUser.id_user) || null;
    const [res] = await pool.query(
      `INSERT INTO customer_link_pages
       (slug, title, subtitle, description, email, phone, links_json, is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        payload.title,
        payload.subtitle,
        payload.description,
        payload.email,
        payload.phone,
        JSON.stringify(payload.links || []),
        payload.isActive ? 1 : 0,
        userId,
        userId,
      ]
    );
    const row = await getLinkPageById(res.insertId);
    reply.code(201).send({ page: linkPageFromRow(row, req) });
  }
);

fastify.get(
  CFG.apiPrefix + "/link-pages/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = Number(req.params && req.params.id);
    if (!Number.isInteger(id) || id <= 0) return sendError(reply, 400, "Invalid id");
    const row = await getLinkPageById(id);
    if (!row) return sendError(reply, 404, "Not found");
    return { page: linkPageFromRow(row, req) };
  }
);

fastify.patch(
  CFG.apiPrefix + "/link-pages/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = Number(req.params && req.params.id);
    if (!Number.isInteger(id) || id <= 0) return sendError(reply, 400, "Invalid id");
    const existing = await getLinkPageById(id);
    if (!existing) return sendError(reply, 404, "Not found");

    const payload = normalizeLinkPagePayload(req.body || {}, { partial: true });
    const mergedForValidation = {
      email: payload.email !== undefined ? payload.email : existing.email,
      phone: payload.phone !== undefined ? payload.phone : existing.phone,
      links: payload.links !== undefined ? payload.links : parseLinksJson(existing.links_json),
    };
    if (!linkPageHasContactContent(mergedForValidation)) {
      return sendError(reply, 400, "At least one contact method or link is required");
    }
    const fields = [];
    const values = [];
    if (payload.slug !== undefined) {
      const slugSource = payload.slug || payload.title || existing.title;
      fields.push("slug = ?");
      values.push(await uniqueLinkPageSlug(slugSource, id));
    }
    if (payload.title !== undefined) {
      if (!payload.title) return sendError(reply, 400, "Title is required");
      fields.push("title = ?");
      values.push(payload.title);
    }
    if (payload.subtitle !== undefined) {
      fields.push("subtitle = ?");
      values.push(payload.subtitle);
    }
    if (payload.description !== undefined) {
      fields.push("description = ?");
      values.push(payload.description);
    }
    if (payload.email !== undefined) {
      fields.push("email = ?");
      values.push(payload.email);
    }
    if (payload.phone !== undefined) {
      fields.push("phone = ?");
      values.push(payload.phone);
    }
    if (payload.links !== undefined) {
      fields.push("links_json = ?");
      values.push(JSON.stringify(payload.links));
    }
    if (payload.isActive !== undefined) {
      fields.push("is_active = ?");
      values.push(payload.isActive ? 1 : 0);
    }
    fields.push("updated_by = ?");
    values.push(Number(req.cagUser && req.cagUser.id_user) || null);

    if (!fields.length) return sendError(reply, 400, "No changes");
    values.push(id);
    await pool.query(`UPDATE customer_link_pages SET ${fields.join(", ")} WHERE id = ?`, values);
    const row = await getLinkPageById(id);
    return { page: linkPageFromRow(row, req) };
  }
);

fastify.delete(
  CFG.apiPrefix + "/link-pages/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = Number(req.params && req.params.id);
    if (!Number.isInteger(id) || id <= 0) return sendError(reply, 400, "Invalid id");
    const row = await getLinkPageById(id);
    if (!row) return sendError(reply, 404, "Not found");
    await pool.query(
      `UPDATE customer_link_pages SET is_active = 0, updated_by = ? WHERE id = ?`,
      [Number(req.cagUser && req.cagUser.id_user) || null, id]
    );
    return { ok: true };
  }
);

fastify.get(
  CFG.apiPrefix + "/link-pages/:id/qr.png",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = Number(req.params && req.params.id);
    if (!Number.isInteger(id) || id <= 0) return sendError(reply, 400, "Invalid id");
    const row = await getLinkPageById(id);
    if (!row) return sendError(reply, 404, "Not found");
    const publicUrl = pagePublicUrl(req, row.slug);
    return sendQrPng(reply, publicUrl, `qr-${row.slug}.png`);
  }
);

// ---- POS (OFFLINE-FIRST) ----
fastify.get(
  CFG.apiPrefix + "/pos/bootstrap",
  {
    preHandler: requireAuth,
  },
  async (req) => {
    const limit = clampInt(req.query && req.query.limit, 1, 5000, 2500);
    const category = normalizeCategory(req.query && req.query.category);
    const imageSelect = productImageSelectSql("p");
    const values = [];
    const where = category ? "WHERE p.productType = ?" : "";
    if (category) values.push(category);
    values.push(limit);

    const [rows] = await pool.query(
      `SELECT
         p.id_product,
         p.barcode,
         p.reference,
         p.name,
         p.description,
         p.quantity,
         p.purchasePrice,
         p.price,
         p.productType,
         ${imageSelect},
         p.last_updated
       FROM products p
       ${where}
       ORDER BY p.name ASC
       LIMIT ?`,
      values
    );

    let offerRows = [];
    try {
      const [offers] = await pool.query(
        `SELECT
           o.id_offer,
           o.name,
           o.quantity,
           o.price,
           o.last_updated,
           GROUP_CONCAT(op.product_id ORDER BY op.product_id) AS product_ids
         FROM product_offers o
         LEFT JOIN product_offers_products op ON op.offer_id = o.id_offer
         GROUP BY o.id_offer
         ORDER BY o.last_updated DESC
         LIMIT 1000`
      );
      offerRows = offers || [];
    } catch (_) {
      // Keep bootstrap resilient if offers tables are unavailable.
      offerRows = [];
    }

    return {
      generatedAt: new Date().toISOString(),
      category,
      products: (rows || []).map((p) => ({
        id_product: Number(p.id_product),
        barcode: p.barcode || "",
        reference: p.reference || "",
        name: p.name || "",
        description: p.description || "",
        quantity: p.quantity == null ? null : Number(p.quantity),
        purchasePrice: p.purchasePrice == null ? null : Number(p.purchasePrice),
        price: p.price == null ? 0 : Number(p.price),
        productType: p.productType || "",
        image_url: typeof p.image_url === "string" ? p.image_url : "",
        last_updated: p.last_updated || null,
      })),
      offers: (offerRows || []).map((o) => ({
        id_offer: Number(o.id_offer),
        name: o.name || "",
        quantity: o.quantity == null ? null : Number(o.quantity),
        price: o.price == null ? null : Number(o.price),
        last_updated: o.last_updated || null,
        productIds: o.product_ids
          ? String(o.product_ids)
              .split(",")
              .map((x) => Number(x))
              .filter((x) => Number.isFinite(x))
          : [],
      })),
    };
  }
);

fastify.post(
  CFG.apiPrefix + "/pos/sales",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    try {
      const result = await createPosSaleForUser(req.cagUser, req.body || {});
      reply.code(result.status === "created" ? 201 : 200).send({
        ok: true,
        status: result.status,
        saleId: result.saleId,
        clientSaleUid: result.clientSaleUid,
        totalAmount: result.totalAmount,
      });
    } catch (e) {
      const status = Number(e && e.statusCode) || 500;
      return sendError(reply, status, status >= 500 ? "Could not create POS sale" : String(e.message || "Error"));
    }
  }
);

fastify.post(
  CFG.apiPrefix + "/pos/sync",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    const body = req.body || {};
    const sales = Array.isArray(body.sales) ? body.sales : [];
    if (!sales.length) return sendError(reply, 400, "Missing sales array");
    if (sales.length > 100) return sendError(reply, 400, "Too many sales in one sync batch (max 100)");

    const results = [];
    for (let i = 0; i < sales.length; i += 1) {
      const raw = sales[i] || {};
      const clientSaleUid = sanitizeClientSaleUid(raw.clientSaleUid != null ? raw.clientSaleUid : raw.client_sale_uid);
      try {
        const r = await createPosSaleForUser(req.cagUser, raw);
        results.push({
          index: i,
          clientSaleUid: r.clientSaleUid,
          status: r.status,
          saleId: r.saleId,
          totalAmount: r.totalAmount,
        });
      } catch (e) {
        const statusCode = Number(e && e.statusCode) || 500;
        results.push({
          index: i,
          clientSaleUid,
          status: "failed",
          message: statusCode >= 500 ? "Server error" : String(e.message || "Error"),
          statusCode,
          retryable: statusCode >= 500 || statusCode === 409,
        });
      }
    }

    const okCount = results.filter((x) => x.status === "created" || x.status === "duplicate").length;
    const failCount = results.length - okCount;

    reply.send({
      ok: failCount === 0,
      summary: {
        total: results.length,
        synced: okCount,
        failed: failCount,
      },
      results,
    });
  }
);

// ---- DASHBOARD ----
fastify.get(
  CFG.apiPrefix + "/dashboard/summary",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    const fromIso = req.query && req.query.from;
    const toIso = req.query && req.query.to;
    const category = normalizeCategory(req.query && req.query.category);
    const r = rangeToSql(fromIso, toIso);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");
    const salesRangeWhere = `s.last_updated >= ? AND s.last_updated < ? AND ${businessWindowSql("s.last_updated")}`;
    const businessDateExpr = businessDateSql("s.last_updated");
    const hourOrderExpr = `CASE
      WHEN HOUR(s.last_updated) < ${CFG.businessDayEndHour} THEN HOUR(s.last_updated) + 24
      ELSE HOUR(s.last_updated)
    END`;

    let kpis = { revenue: 0, salesCount: 0 };
    let profit = 0;
    let seriesRows = [];
    let byHourRows = [];
    let byWeekdayRows = [];

    if (category) {
      const [kpiRows] = await pool.query(
        `SELECT
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
           COUNT(DISTINCT s.id_sale) AS salesCount
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?`,
        [r.from, r.toExcl, category]
      );
      kpis = kpiRows && kpiRows[0] ? kpiRows[0] : { revenue: 0, salesCount: 0 };

      const [profitRows] = await pool.query(
        `SELECT
           COALESCE(SUM(
             (COALESCE(sd.total_price, sd.price * sd.quantity) - (COALESCE(p.purchasePrice, 0) * sd.quantity))
           ), 0) AS profit
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?`,
        [r.from, r.toExcl, category]
      );
      profit = profitRows && profitRows[0] ? profitRows[0].profit : 0;

      const [series] = await pool.query(
        `SELECT
           ${businessDateExpr} AS date,
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
           COUNT(DISTINCT s.id_sale) AS salesCount,
           COALESCE(
             SUM(COALESCE(sd.total_price, sd.price * sd.quantity)) / NULLIF(COUNT(DISTINCT s.id_sale), 0),
             0
           ) AS avgTicket
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
         GROUP BY ${businessDateExpr}
         ORDER BY ${businessDateExpr} ASC`,
        [r.from, r.toExcl, category]
      );
      seriesRows = series || [];

      const [hourRows] = await pool.query(
        `SELECT
           HOUR(s.last_updated) AS hour,
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
           COUNT(DISTINCT s.id_sale) AS salesCount
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
         GROUP BY HOUR(s.last_updated)
         ORDER BY ${hourOrderExpr} ASC`,
        [r.from, r.toExcl, category]
      );
      byHourRows = hourRows || [];

      const [weekdayRows] = await pool.query(
        `SELECT
           WEEKDAY(${businessDateExpr}) AS weekday,
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
           COUNT(DISTINCT s.id_sale) AS salesCount
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
         GROUP BY WEEKDAY(${businessDateExpr})
         ORDER BY WEEKDAY(${businessDateExpr}) ASC`,
        [r.from, r.toExcl, category]
      );
      byWeekdayRows = weekdayRows || [];
    } else {
      const [kpiRows] = await pool.query(
        `SELECT
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount
         FROM sales s
         WHERE ${salesRangeWhere}`,
        [r.from, r.toExcl]
      );
      kpis = kpiRows && kpiRows[0] ? kpiRows[0] : { revenue: 0, salesCount: 0 };

      const [profitRows] = await pool.query(
        `SELECT
           COALESCE(SUM(
             (COALESCE(sd.total_price, sd.price * sd.quantity) - (COALESCE(p.purchasePrice, 0) * sd.quantity))
           ), 0) AS profit
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         LEFT JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}`,
        [r.from, r.toExcl]
      );
      profit = profitRows && profitRows[0] ? profitRows[0].profit : 0;

      const [series] = await pool.query(
        `SELECT
           ${businessDateExpr} AS date,
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount,
           COALESCE(AVG(s.total_amount), 0) AS avgTicket
         FROM sales s
         WHERE ${salesRangeWhere}
         GROUP BY ${businessDateExpr}
         ORDER BY ${businessDateExpr} ASC`,
        [r.from, r.toExcl]
      );
      seriesRows = series || [];

      const [hourRows] = await pool.query(
        `SELECT
           HOUR(s.last_updated) AS hour,
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount
         FROM sales s
         WHERE ${salesRangeWhere}
         GROUP BY HOUR(s.last_updated)
         ORDER BY ${hourOrderExpr} ASC`,
        [r.from, r.toExcl]
      );
      byHourRows = hourRows || [];

      const [weekdayRows] = await pool.query(
        `SELECT
           WEEKDAY(${businessDateExpr}) AS weekday,
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount
         FROM sales s
         WHERE ${salesRangeWhere}
         GROUP BY WEEKDAY(${businessDateExpr})
         ORDER BY WEEKDAY(${businessDateExpr}) ASC`,
        [r.from, r.toExcl]
      );
      byWeekdayRows = weekdayRows || [];
    }

    const [productResultRows] = await pool.query(
      `SELECT
         p.id_product AS id,
         COALESCE(p.name, CONCAT('Produit #', sd.product_id)) AS name,
         COALESCE(p.productType, '') AS category,
         COUNT(DISTINCT s.id_sale) AS salesCount,
         COALESCE(SUM(sd.quantity), 0) AS qty,
         COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
         COALESCE(SUM(COALESCE(p.purchasePrice, 0) * sd.quantity), 0) AS cost,
         COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity) - (COALESCE(p.purchasePrice, 0) * sd.quantity)), 0) AS profit
       FROM sales_details sd
       JOIN sales s ON s.id_sale = sd.sale_id
       LEFT JOIN products p ON p.id_product = sd.product_id
       WHERE ${salesRangeWhere}
         AND (? = '' OR p.productType = ?)
       GROUP BY p.id_product, p.name, sd.product_id
       ORDER BY revenue DESC, qty DESC`,
      [r.from, r.toExcl, category, category]
    );

    // "Top offers" is best-effort: it attributes sold products that belong to an offer.
    const [topOffersRows] = await pool.query(
      `SELECT
         o.id_offer AS id,
         o.name AS name,
         COALESCE(SUM(sd.quantity), 0) AS qty,
         COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue
       FROM sales_details sd
       JOIN sales s ON s.id_sale = sd.sale_id
       JOIN products p ON p.id_product = sd.product_id
       JOIN product_offers_products op ON op.product_id = sd.product_id
       JOIN product_offers o ON o.id_offer = op.offer_id
       WHERE ${salesRangeWhere}
         AND (? = '' OR p.productType = ?)
       GROUP BY o.id_offer, o.name
       ORDER BY revenue DESC
       LIMIT 10`,
      [r.from, r.toExcl, category, category]
    );

    const productResults = (productResultRows || []).map((x) => {
      const revenue = Number(x.revenue);
      const cost = Number(x.cost);
      const profit = Number(x.profit);
      const marginPct = revenue ? (profit / revenue) * 100 : 0;
      return {
        id: x.id,
        name: x.name,
        category: x.category || "",
        salesCount: Number(x.salesCount),
        qty: Number(x.qty),
        revenue,
        cost,
        profit,
        marginPct,
      };
    });

    reply.send({
      meta: {
        category,
        businessDayStartHour: CFG.businessDayStartHour,
        businessDayEndHour: CFG.businessDayEndHour,
      },
      kpis: {
        revenue: Number(kpis.revenue),
        profit: Number(profit),
        salesCount: Number(kpis.salesCount),
        avgTicket: kpis.salesCount ? Number(kpis.revenue) / Number(kpis.salesCount) : 0,
      },
      series: (seriesRows || []).map((x) => ({
        date: String(x.date),
        revenue: Number(x.revenue),
        salesCount: Number(x.salesCount),
        avgTicket: Number(x.avgTicket),
      })),
      byHour: (byHourRows || []).map((x) => ({ hour: Number(x.hour), revenue: Number(x.revenue), salesCount: Number(x.salesCount) })),
      byWeekday: (byWeekdayRows || []).map((x) => ({
        weekday: Number(x.weekday),
        revenue: Number(x.revenue),
        salesCount: Number(x.salesCount),
      })),
      topProducts: productResults.slice(0, 10).map((x) => ({ id: x.id, name: x.name, qty: x.qty, revenue: x.revenue })),
      productResults,
      topOffers: (topOffersRows || []).map((x) => ({ id: x.id, name: x.name, qty: Number(x.qty), revenue: Number(x.revenue) })),
    });
  }
);

// ---- SALES ----
fastify.get(
  CFG.apiPrefix + "/sales",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    const fromIso = req.query && req.query.from;
    const toIso = req.query && req.query.to;
    const category = normalizeCategory(req.query && req.query.category);
    const r = rangeToSql(fromIso, toIso);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");

    const q = (req.query && typeof req.query.q === "string" ? req.query.q.trim() : "") || "";
    const limit = clampInt(req.query && req.query.limit, 1, 100, 20);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";
    const qNum = /^\d+$/.test(q) ? Number(q) : -1;
    const salesRangeWhere = `s.last_updated >= ? AND s.last_updated < ? AND ${businessWindowSql("s.last_updated")}`;

    let total = 0;
    let rows = [];

    if (category) {
      const [totalRows] = await pool.query(
        `SELECT COUNT(DISTINCT s.id_sale) AS total
         FROM sales s
         JOIN sales_details sd ON sd.sale_id = s.id_sale
         JOIN products p ON p.id_product = sd.product_id
         LEFT JOIN users u ON u.id_user = s.user_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
           AND (
             ? = '' OR s.notes LIKE ? OR u.username LIKE ? OR s.id_sale = ? OR p.name LIKE ? OR p.reference LIKE ?
           )`,
        [r.from, r.toExcl, category, q, like, like, qNum, like, like]
      );
      total = totalRows && totalRows[0] ? Number(totalRows[0].total) : 0;

      const [filteredRows] = await pool.query(
        `SELECT
           s.id_sale,
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS total_amount,
           s.notes,
           s.user_id,
           u.username,
           s.last_updated,
           COALESCE(SUM(sd.quantity), 0) AS items_count
         FROM sales s
         JOIN sales_details sd ON sd.sale_id = s.id_sale
         JOIN products p ON p.id_product = sd.product_id
         LEFT JOIN users u ON u.id_user = s.user_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
           AND (
             ? = '' OR s.notes LIKE ? OR u.username LIKE ? OR s.id_sale = ? OR p.name LIKE ? OR p.reference LIKE ?
           )
         GROUP BY s.id_sale, s.notes, s.user_id, u.username, s.last_updated
         ORDER BY s.last_updated DESC
         LIMIT ? OFFSET ?`,
        [r.from, r.toExcl, category, q, like, like, qNum, like, like, limit, offset]
      );
      rows = filteredRows || [];
    } else {
      const [totalRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM sales s
         LEFT JOIN users u ON u.id_user = s.user_id
         WHERE ${salesRangeWhere}
           AND (
             ? = '' OR s.notes LIKE ? OR u.username LIKE ? OR s.id_sale = ?
           )`,
        [r.from, r.toExcl, q, like, like, qNum]
      );
      total = totalRows && totalRows[0] ? Number(totalRows[0].total) : 0;

      const [allRows] = await pool.query(
        `SELECT
           s.id_sale,
           s.total_amount,
           s.notes,
           s.user_id,
           u.username,
           s.last_updated,
           (
             SELECT COALESCE(SUM(sd.quantity), 0)
             FROM sales_details sd
             WHERE sd.sale_id = s.id_sale
           ) AS items_count
         FROM sales s
         LEFT JOIN users u ON u.id_user = s.user_id
         WHERE ${salesRangeWhere}
           AND (
             ? = '' OR s.notes LIKE ? OR u.username LIKE ? OR s.id_sale = ?
           )
         ORDER BY s.last_updated DESC
         LIMIT ? OFFSET ?`,
        [r.from, r.toExcl, q, like, like, qNum, limit, offset]
      );
      rows = allRows || [];
    }

    reply.send({
      meta: {
        category,
      },
      total,
      items: (rows || []).map((x) => ({
        id_sale: x.id_sale,
        total_amount: Number(x.total_amount),
        notes: x.notes || "",
        user_id: x.user_id,
        username: x.username || "",
        last_updated: x.last_updated,
        items_count: Number(x.items_count),
      })),
    });
  }
);

fastify.get(
  CFG.apiPrefix + "/sales/:id",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    const saleId = req.params && req.params.id;
    const id = /^\d+$/.test(String(saleId)) ? Number(saleId) : null;
    const category = normalizeCategory(req.query && req.query.category);
    if (!id) return sendError(reply, 400, "Invalid sale id");

    const [saleRows] = await pool.query(
      `SELECT
         s.id_sale,
         s.total_amount,
         s.notes,
         s.user_id,
         u.username,
         s.last_updated
       FROM sales s
       LEFT JOIN users u ON u.id_user = s.user_id
       WHERE s.id_sale = ?
       LIMIT 1`,
      [id]
    );
    const sale = saleRows && saleRows[0] ? saleRows[0] : null;
    if (!sale) return sendError(reply, 404, "Not found");

    const detailSql = category
      ? `SELECT
           sd.id_sale_detail,
           sd.sale_id,
           sd.product_id,
           p.name AS product_name,
           sd.quantity,
           sd.price,
           sd.total_price
         FROM sales_details sd
         LEFT JOIN products p ON p.id_product = sd.product_id
         WHERE sd.sale_id = ?
           AND p.productType = ?
         ORDER BY sd.id_sale_detail ASC`
      : `SELECT
           sd.id_sale_detail,
           sd.sale_id,
           sd.product_id,
           p.name AS product_name,
           sd.quantity,
           sd.price,
           sd.total_price
         FROM sales_details sd
         LEFT JOIN products p ON p.id_product = sd.product_id
         WHERE sd.sale_id = ?
         ORDER BY sd.id_sale_detail ASC`;
    const [detailRows] = await pool.query(detailSql, category ? [id, category] : [id]);
    const filteredTotal = (detailRows || []).reduce((acc, d) => {
      const line = d.total_price == null ? Number(d.price) * Number(d.quantity) : Number(d.total_price);
      return acc + (Number.isFinite(line) ? line : 0);
    }, 0);

    reply.send({
      sale: {
        id_sale: sale.id_sale,
        total_amount: category ? Number(filteredTotal) : Number(sale.total_amount),
        notes: sale.notes || "",
        user_id: sale.user_id,
        username: sale.username || "",
        last_updated: sale.last_updated,
      },
      details: (detailRows || []).map((d) => ({
        id_sale_detail: d.id_sale_detail,
        sale_id: d.sale_id,
        product_id: d.product_id,
        product_name: d.product_name || "",
        quantity: Number(d.quantity),
        price: Number(d.price),
        total_price: d.total_price == null ? null : Number(d.total_price),
      })),
    });
  }
);

// ---- PRODUCTS ----
fastify.get(
  CFG.apiPrefix + "/products/categories",
  async () => {
    const [rows] = await pool.query(
      `SELECT DISTINCT TRIM(p.productType) AS name
       FROM products p
       WHERE p.productType IS NOT NULL
         AND TRIM(p.productType) <> ''
       ORDER BY TRIM(p.productType) ASC`
    );
    const items = (rows || [])
      .map((r) => (r && typeof r.name === "string" ? r.name.trim() : ""))
      .filter(Boolean);
    return { items };
  }
);

fastify.get(
  CFG.apiPrefix + "/products",
  {
    preHandler: requireAuth,
  },
  async (req) => {
    const q = (req.query && typeof req.query.q === "string" ? req.query.q.trim() : "") || "";
    const imageSelect = productImageSelectSql("p");
    const limit = clampInt(req.query && req.query.limit, 1, 100, 20);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM products p
       WHERE (? = '' OR p.name LIKE ? OR p.barcode LIKE ? OR p.reference LIKE ? OR p.productType LIKE ?)`,
      [q, like, like, like, like]
    );
    const total = totalRows && totalRows[0] ? Number(totalRows[0].total) : 0;

    const [rows] = await pool.query(
      `SELECT
         p.id_product,
         p.barcode,
         p.reference,
         p.name,
         p.description,
         p.quantity,
         p.purchasePrice,
         p.price,
         p.productType,
         ${imageSelect},
         p.last_updated
       FROM products p
       WHERE (? = '' OR p.name LIKE ? OR p.barcode LIKE ? OR p.reference LIKE ? OR p.productType LIKE ?)
       ORDER BY p.last_updated DESC
       LIMIT ? OFFSET ?`,
      [q, like, like, like, like, limit, offset]
    );

    return { total, items: rows || [] };
  }
);

fastify.post(
  CFG.apiPrefix + "/products",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return sendError(reply, 400, "Missing name");

    const barcode = typeof b.barcode === "string" ? b.barcode.trim() : "";
    const reference = typeof b.reference === "string" ? b.reference.trim() : "";
    const description = typeof b.description === "string" ? b.description : "";
    const productType = typeof b.productType === "string" ? b.productType.trim() : "";
    const quantity = b.quantity == null || b.quantity === "" ? null : Number(b.quantity);
    const purchasePrice = b.purchasePrice == null || b.purchasePrice === "" ? null : Number(b.purchasePrice);
    const price = b.price == null || b.price === "" ? null : Number(b.price);
    if (b.quantity != null && b.quantity !== "" && !Number.isFinite(quantity)) return sendError(reply, 400, "Invalid quantity");
    if (b.purchasePrice != null && b.purchasePrice !== "" && !Number.isFinite(purchasePrice)) return sendError(reply, 400, "Invalid purchasePrice");
    if (b.price != null && b.price !== "" && !Number.isFinite(price)) return sendError(reply, 400, "Invalid price");
    const imageUrl = sanitizeImageUrl(b.imageUrl != null ? b.imageUrl : b.image_url);
    const hasImageColumn = hasTableColumn("products", "image_url");

    const [res] = hasImageColumn
      ? await pool.query(
          `INSERT INTO products
             (barcode, reference, name, description, quantity, purchasePrice, price, productType, image_url, last_updated, is_synced)
           VALUES
             (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)`,
          [barcode, reference, name, description, quantity, purchasePrice, price, productType, imageUrl]
        )
      : await pool.query(
          `INSERT INTO products
             (barcode, reference, name, description, quantity, purchasePrice, price, productType, last_updated, is_synced)
           VALUES
             (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)`,
          [barcode, reference, name, description, quantity, purchasePrice, price, productType]
        );

    reply.code(201).send({ id_product: res.insertId });
  }
);

const updateProductHandler = async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    const b = req.body || {};
    const fields = [];
    const values = [];

    function setField(col, val) {
      fields.push(`${col} = ?`);
      values.push(val);
    }

    if (typeof b.name === "string") setField("name", b.name.trim());
    if (typeof b.barcode === "string") setField("barcode", b.barcode.trim());
    if (typeof b.reference === "string") setField("reference", b.reference.trim());
    if (typeof b.description === "string") setField("description", b.description);
    if (typeof b.productType === "string") setField("productType", b.productType.trim());
    if ((b.imageUrl !== undefined || b.image_url !== undefined) && hasTableColumn("products", "image_url")) {
      const imageVal = b.imageUrl !== undefined ? b.imageUrl : b.image_url;
      setField("image_url", sanitizeImageUrl(imageVal));
    }
    if (b.quantity !== undefined) {
      const quantity = b.quantity == null || b.quantity === "" ? null : Number(b.quantity);
      if (b.quantity != null && b.quantity !== "" && !Number.isFinite(quantity)) return sendError(reply, 400, "Invalid quantity");
      setField("quantity", quantity);
    }
    if (b.purchasePrice !== undefined) {
      const purchasePrice = b.purchasePrice == null || b.purchasePrice === "" ? null : Number(b.purchasePrice);
      if (b.purchasePrice != null && b.purchasePrice !== "" && !Number.isFinite(purchasePrice)) return sendError(reply, 400, "Invalid purchasePrice");
      setField("purchasePrice", purchasePrice);
    }
    if (b.price !== undefined) {
      const price = b.price == null || b.price === "" ? null : Number(b.price);
      if (b.price != null && b.price !== "" && !Number.isFinite(price)) return sendError(reply, 400, "Invalid price");
      setField("price", price);
    }

    if (!fields.length) return sendError(reply, 400, "No fields to update");

    fields.push("last_updated = NOW()");
    fields.push("is_synced = 0");
    values.push(id);

    const conn = await getConnectionWithTimeout(4000);
    try {
      // Fail fast instead of hanging when another transaction keeps a row lock.
      await conn.query("SET SESSION innodb_lock_wait_timeout = 5");
      const [res] = await conn.query(
        {
          sql: `UPDATE products SET ${fields.join(", ")} WHERE id_product = ?`,
          timeout: 8000,
        },
        values
      );
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      reply.send({ ok: true });
    } catch (e) {
      if (e && e.code === "DB_POOL_TIMEOUT") {
        return sendError(reply, 503, "Database busy", {
          hint: "Trop de requetes simultanees. Reessaye dans quelques secondes.",
        });
      }
      if (e && (e.code === "ER_LOCK_WAIT_TIMEOUT" || e.code === "PROTOCOL_SEQUENCE_TIMEOUT")) {
        return sendError(reply, 503, "Product update timeout (row locked)", {
          hint: "Close other POS sessions editing the same product, then retry.",
        });
      }
      throw e;
    } finally {
      conn.release();
    }
  };

fastify.patch(
  CFG.apiPrefix + "/products/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updateProductHandler
);

fastify.put(
  CFG.apiPrefix + "/products/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updateProductHandler
);

fastify.delete(
  CFG.apiPrefix + "/products/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    try {
      const [res] = await pool.query(`DELETE FROM products WHERE id_product = ?`, [id]);
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      reply.send({ ok: true });
    } catch (e) {
      // Most likely FK/constraint if you have them.
      return sendError(reply, 409, "Cannot delete product (in use)", { hint: "Prefer deactivate/archiving instead of deleting if you need history." });
    }
  }
);

// ---- OFFERS ----
fastify.get(
  CFG.apiPrefix + "/offers",
  {
    preHandler: requireAuth,
  },
  async (req) => {
    const q = (req.query && typeof req.query.q === "string" ? req.query.q.trim() : "") || "";
    const limit = clampInt(req.query && req.query.limit, 1, 100, 20);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM product_offers o
       WHERE (? = '' OR o.name LIKE ?)`,
      [q, like]
    );
    const total = totalRows && totalRows[0] ? Number(totalRows[0].total) : 0;

    const [rows] = await pool.query(
      `SELECT
         o.id_offer,
         o.name,
         o.quantity,
         o.price,
         o.last_updated,
         GROUP_CONCAT(op.product_id ORDER BY op.product_id) AS product_ids
       FROM product_offers o
       LEFT JOIN product_offers_products op ON op.offer_id = o.id_offer
       WHERE (? = '' OR o.name LIKE ?)
       GROUP BY o.id_offer
       ORDER BY o.last_updated DESC
       LIMIT ? OFFSET ?`,
      [q, like, limit, offset]
    );

    const items = (rows || []).map((o) => ({
      id_offer: o.id_offer,
      name: o.name,
      quantity: o.quantity == null ? null : Number(o.quantity),
      price: o.price == null ? null : Number(o.price),
      last_updated: o.last_updated,
      productIds: o.product_ids
        ? String(o.product_ids)
            .split(",")
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x))
        : [],
    }));

    return { total, items };
  }
);

fastify.post(
  CFG.apiPrefix + "/offers",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return sendError(reply, 400, "Missing name");
    const quantity = b.quantity == null ? null : Number(b.quantity);
    const price = b.price == null ? null : Number(b.price);
    const productIds = Array.isArray(b.productIds) ? b.productIds.map(Number).filter((x) => Number.isFinite(x)) : [];

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query(
        `INSERT INTO product_offers (name, quantity, price, last_updated, is_synced)
         VALUES (?, ?, ?, NOW(), 0)`,
        [name, quantity, price]
      );
      const offerId = res.insertId;
      for (const pid of productIds) {
        await conn.query(`INSERT INTO product_offers_products (offer_id, product_id, is_synced) VALUES (?, ?, 0)`, [offerId, pid]);
      }
      await conn.commit();
      reply.code(201).send({ id_offer: offerId });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
);

fastify.patch(
  CFG.apiPrefix + "/offers/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : null;
    const quantity = b.quantity === undefined ? undefined : b.quantity == null ? null : Number(b.quantity);
    const price = b.price === undefined ? undefined : b.price == null ? null : Number(b.price);
    const productIds = Array.isArray(b.productIds) ? b.productIds.map(Number).filter((x) => Number.isFinite(x)) : null;

    const fields = [];
    const values = [];
    if (name != null) {
      fields.push("name = ?");
      values.push(name);
    }
    if (quantity !== undefined) {
      fields.push("quantity = ?");
      values.push(quantity);
    }
    if (price !== undefined) {
      fields.push("price = ?");
      values.push(price);
    }
    if (fields.length) {
      fields.push("last_updated = NOW()");
      fields.push("is_synced = 0");
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (fields.length) {
        values.push(id);
        const [res] = await conn.query(`UPDATE product_offers SET ${fields.join(", ")} WHERE id_offer = ?`, values);
        if (!res.affectedRows) {
          await conn.rollback();
          return sendError(reply, 404, "Not found");
        }
      }

      if (productIds !== null) {
        await conn.query(`DELETE FROM product_offers_products WHERE offer_id = ?`, [id]);
        for (const pid of productIds) {
          await conn.query(`INSERT INTO product_offers_products (offer_id, product_id, is_synced) VALUES (?, ?, 0)`, [id, pid]);
        }
      }

      await conn.commit();
      reply.send({ ok: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
);

fastify.delete(
  CFG.apiPrefix + "/offers/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM product_offers_products WHERE offer_id = ?`, [id]);
      const [res] = await conn.query(`DELETE FROM product_offers WHERE id_offer = ?`, [id]);
      await conn.commit();
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      reply.send({ ok: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
);

fastify.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, "Unhandled error");
  if (reply.sent) return;
  const status = err && err.statusCode ? err.statusCode : 500;
  // Avoid leaking internals.
  sendError(reply, status, status >= 500 ? "Server error" : String(err.message || "Error"));
});

async function main() {
  // Optional schema feature: keep legacy users.password for POS and use users.password_hash (bcrypt) for dashboard.
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM users LIKE 'password_hash'`);
    HAS_PASSWORD_HASH_COLUMN = Array.isArray(cols) && cols.length > 0;
    fastify.log.info({ password_hash: HAS_PASSWORD_HASH_COLUMN }, "Schema detection");
  } catch (e) {
    HAS_PASSWORD_HASH_COLUMN = false;
    fastify.log.warn({ err: e }, "Schema detection failed (password_hash disabled)");
  }
  await refreshPosSchema();
  fastify.log.info(
    {
      salesColumns: POS_SCHEMA.sales.size,
      salesDetailColumns: POS_SCHEMA.salesDetails.size,
      productColumns: POS_SCHEMA.products.size,
    },
    "POS schema cache"
  );
  await fastify.listen({ port: CFG.port, host: CFG.host });
}

main().catch((e) => {
  fastify.log.error(e);
  process.exit(1);
});
