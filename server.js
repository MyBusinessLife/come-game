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
const API_VERSION = "1.3.6";

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

function parseBusinessOffsetMinutes() {
  const rawMinutes = process.env.BUSINESS_TIME_OFFSET_MINUTES;
  if (rawMinutes != null && rawMinutes !== "") {
    const n = Number(rawMinutes);
    if (Number.isFinite(n)) return Math.max(-840, Math.min(840, Math.round(n)));
  }
  const rawHours = process.env.BUSINESS_TIME_OFFSET_HOURS;
  if (rawHours != null && rawHours !== "") {
    const n = Number(rawHours);
    if (Number.isFinite(n)) return Math.max(-840, Math.min(840, Math.round(n * 60)));
  }
  // Default: Algeria local time (UTC+1), which matches the business rules used in this project.
  return 60;
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
  migratePlaintextPasswords: envBool("MIGRATE_PLAINTEXT_PASSWORDS", false),
  migratePlaintextPasswordsOverwrite: envBool("MIGRATE_PLAINTEXT_PASSWORDS_OVERWRITE", false),
  businessDayStartHour: clampHour(env("BUSINESS_DAY_START_HOUR", "12"), 12),
  businessDayEndHour: clampHour(env("BUSINESS_DAY_END_HOUR", "3"), 3),
  businessTimeOffsetMinutes: parseBusinessOffsetMinutes(),
  corsOrigins: parseCsv(env("CORS_ORIGINS", "https://mybusinesslife.fr,https://www.mybusinesslife.fr")),
  enableDebugRoutes: envBool("ENABLE_DEBUG_ROUTES", false),
  enforceRoles: envBool("ENFORCE_ROLES", true),
  writeRoles: parseCsv(env("WRITE_ROLES", "admin,manager")).map((r) => r.toLowerCase()),
  allowWriteWithoutRole: envBool("ALLOW_WRITE_WITHOUT_ROLE", true),
  authDbCheck: envBool("AUTH_DB_CHECK", true),
  authLookupTimeoutMs: Number(env("AUTH_LOOKUP_TIMEOUT_MS", "5000")),
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

function queryWithTimeout(conn, sqlOrOptions, params, timeoutMs) {
  const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : 8000;
  let timer = null;
  const queryPromise = conn.query(sqlOrOptions, params);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        conn.destroy();
      } catch (_) {
        // ignore
      }
      const err = new Error(`DB query timeout (${timeout}ms)`);
      err.code = "DB_QUERY_TIMEOUT";
      reject(err);
    }, timeout);
  });

  return Promise.race([queryPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function poolQueryWithTimeout(sqlOrOptions, params, timeoutMs) {
  const acquireMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Math.min(Number(timeoutMs), 5000)) : 4000;
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(acquireMs);
    return await queryWithTimeout(conn, sqlOrOptions, params, timeoutMs);
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
  }
}

fastify.decorate("db", pool);

fastify.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-cag-api-version", API_VERSION);
  return payload;
});

let HAS_PASSWORD_HASH_COLUMN = false;
let POS_SYNC_TABLE_READY = false;
let PURCHASES_TABLE_READY = false;
let BOXING_TABLES_READY = false;
let LINK_PAGES_TABLE_READY = false;
const USER_SCHEMA = new Set();
const LINK_PAGES_SCHEMA = new Set();
const POS_SCHEMA = {
  sales: new Set(),
  salesDetails: new Set(),
  products: new Set(),
};


fastify.register(helmet, {
  global: true,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "https:", "'unsafe-inline'"],
      connectSrc: ["'self'", "https:"],
      upgradeInsecureRequests: [],
    },
  },
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

const ADMIN_V2_ASSET_PATHS = {
  index: resolveAsset("admin-v2/index.html"),
  login: resolveAsset("admin-v2/login.html"),
  js: resolveAsset("admin-v2/app.js"),
  loginJs: resolveAsset("admin-v2/login.js"),
  css: resolveAsset("admin-v2/app.css"),
};

const LINK_PAGE_ASSET_PATHS = {
  scene: resolveAsset("link-page-scene.js"),
  three: resolveAsset("node_modules/three/build/three.module.min.js"),
};
const GAME_ROOM_ASSET_NAMES = new Set([
  "art-01.webp",
  "art-02.webp",
  "art-03.png",
  "art-03.webp",
  "art-04.webp",
  "art-05.webp",
  "art-06.webp",
]);

const ASSET_CACHE = {};

function loadAssetCache() {
  for (const [kind, p] of Object.entries(ASSET_PATHS)) {
    if (p) {
      try { ASSET_CACHE[kind] = fs.readFileSync(p); } catch (_) {}
    }
  }
  for (const [kind, p] of Object.entries(ADMIN_V2_ASSET_PATHS)) {
    if (p) {
      try { ASSET_CACHE[`admin2_${kind}`] = fs.readFileSync(p); } catch (_) {}
    }
  }
  for (const [kind, p] of Object.entries(LINK_PAGE_ASSET_PATHS)) {
    if (p) {
      try { ASSET_CACHE[`link_${kind}`] = fs.readFileSync(p); } catch (_) {}
    }
  }
}

function sendAsset(reply, kind) {
  const buf = ASSET_CACHE[kind] || (() => {
    const p = ASSET_PATHS[kind];
    if (!p) return null;
    try { return fs.readFileSync(p); } catch (_) { return null; }
  })();
  if (!buf) return sendError(reply, 404, "Asset not found", { kind });
  reply.header("Cache-Control", "public, max-age=300");
  if (kind === "js") reply.type("application/javascript; charset=utf-8").send(buf);
  else reply.type("text/css; charset=utf-8").send(buf);
}

fastify.get("/cag-pos-dashboard.js", async (_req, reply) => sendAsset(reply, "js"));
fastify.get("/cag-pos-dashboard.css", async (_req, reply) => sendAsset(reply, "css"));

function sendAdminV2Asset(reply, kind) {
  const buf = ASSET_CACHE[`admin2_${kind}`] || (() => {
    const p = ADMIN_V2_ASSET_PATHS[kind];
    if (!p) return null;
    try { return fs.readFileSync(p); } catch (_) { return null; }
  })();
  if (!buf) return sendError(reply, 404, "Admin v2 asset not found", { kind });
  if (kind === "index" || kind === "login") {
    reply.header("Cache-Control", "no-cache");
    reply.type("text/html; charset=utf-8").send(buf);
    return;
  }
  if (kind === "js" || kind === "loginJs") {
    reply.header("Cache-Control", "public, max-age=60");
    reply.type("application/javascript; charset=utf-8").send(buf);
    return;
  }
  if (kind === "css") {
    reply.header("Cache-Control", "public, max-age=60");
    reply.type("text/css; charset=utf-8").send(buf);
    return;
  }
  return sendError(reply, 404, "Unsupported admin v2 asset kind", { kind });
}

fastify.get("/admin-v2", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/admin-v2/", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/admin-v2/index.html", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/admin-v2/login.html", async (_req, reply) => sendAdminV2Asset(reply, "login"));
fastify.get("/admin-v2/app.js", async (_req, reply) => sendAdminV2Asset(reply, "js"));
fastify.get("/admin-v2/login.js", async (_req, reply) => sendAdminV2Asset(reply, "loginJs"));
fastify.get("/admin-v2/app.css", async (_req, reply) => sendAdminV2Asset(reply, "css"));

// Short alias for production use.
fastify.get("/admin", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/admin/", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/dashboard", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/dashboard/", async (_req, reply) => sendAdminV2Asset(reply, "index"));
fastify.get("/login", async (_req, reply) => sendAdminV2Asset(reply, "login"));
fastify.get("/login/", async (_req, reply) => sendAdminV2Asset(reply, "login"));

function sendLinkPageAsset(reply, kind) {
  const buf = ASSET_CACHE[`link_${kind}`] || (() => {
    const p = LINK_PAGE_ASSET_PATHS[kind];
    if (!p) return null;
    try { return fs.readFileSync(p); } catch (_) { return null; }
  })();
  if (!buf) return sendError(reply, 404, "Link page asset not found", { kind });
  reply.header("Cache-Control", "public, max-age=86400");
  reply.type("application/javascript; charset=utf-8").send(buf);
}

fastify.get("/assets/link-page-scene.js", async (_req, reply) => sendLinkPageAsset(reply, "scene"));
fastify.get("/assets/three.module.min.js", async (_req, reply) => sendLinkPageAsset(reply, "three"));
fastify.get("/assets/game-room/:file", async (req, reply) => {
  const file = sanitizeText(req.params && req.params.file, 80);
  if (!GAME_ROOM_ASSET_NAMES.has(file)) return sendError(reply, 404, "Game room asset not found");
  const p = resolveAsset(path.join("link-page-assets", "game-room", file));
  if (!p) return sendError(reply, 404, "Game room asset not found");
  reply.header("Cache-Control", "public, max-age=86400");
  reply.type(file.endsWith(".png") ? "image/png" : "image/webp").send(fs.readFileSync(p));
});

function sendError(reply, status, message, extra) {
  reply.code(status).send(Object.assign({ message }, extra || {}));
}

function handleDbWriteError(req, reply, err, context) {
  const code = err && err.code ? String(err.code) : "";
  const sqlMessage = err && err.sqlMessage ? String(err.sqlMessage) : "";
  const info = {
    context: context || "db-write",
    code: code || "UNKNOWN",
    sqlMessage: sqlMessage || undefined,
  };

  if (code === "DB_POOL_TIMEOUT") {
    req.log.warn(info, "Database pool timeout");
    return sendError(reply, 503, "Database busy", {
      hint: "Trop de requetes simultanees. Reessaye dans quelques secondes.",
    });
  }
  if (code === "ER_LOCK_WAIT_TIMEOUT" || code === "ER_LOCK_DEADLOCK" || code === "PROTOCOL_SEQUENCE_TIMEOUT" || code === "DB_QUERY_TIMEOUT") {
    req.log.warn(info, "Database lock timeout");
    return sendError(reply, 503, "Database write timeout", {
      hint: "Une autre session bloque l'ecriture. Reessaye dans quelques secondes.",
    });
  }
  if (code === "ER_DUP_ENTRY") {
    req.log.warn(info, "Duplicate entry");
    return sendError(reply, 409, "Duplicate value", {
      hint: "Valeur deja utilisee (identifiant, code barre ou reference).",
    });
  }
  if (code === "ER_TABLEACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_ACCESS_DENIED_ERROR") {
    req.log.error(info, "Database access denied on write");
    return sendError(reply, 500, "Database write permission denied", {
      hint: "Verifie les privileges INSERT/UPDATE/DELETE du user MySQL.",
    });
  }
  if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR") {
    req.log.error(info, "Database schema mismatch");
    return sendError(reply, 500, "Database schema mismatch", {
      hint: "Le schema MySQL ne correspond pas aux requetes de l'API.",
    });
  }
  return false;
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

function calendarRangeToSql(fromIso, toIso) {
  if (!isISODate(fromIso) || !isISODate(toIso)) return null;
  const from = `${fromIso} 00:00:00`;
  const toExcl = `${addDaysIso(toIso, 1)} 00:00:00`;
  return { from, toExcl };
}

function businessLocalDateTimeSql(columnExpr) {
  const offset = Number(CFG.businessTimeOffsetMinutes) || 0;
  if (!offset) return columnExpr;
  if (offset > 0) return `DATE_ADD(${columnExpr}, INTERVAL ${offset} MINUTE)`;
  return `DATE_SUB(${columnExpr}, INTERVAL ${Math.abs(offset)} MINUTE)`;
}

function businessWindowSql(columnExpr) {
  const localExpr = businessLocalDateTimeSql(columnExpr);
  if (BUSINESS_CROSSES_MIDNIGHT) {
    return `(TIME(${localExpr}) >= '${BUSINESS_START_TIME}' OR TIME(${localExpr}) < '${BUSINESS_END_TIME}')`;
  }
  return `(TIME(${localExpr}) >= '${BUSINESS_START_TIME}' AND TIME(${localExpr}) < '${BUSINESS_END_TIME}')`;
}

function businessDateSql(columnExpr) {
  const localExpr = businessLocalDateTimeSql(columnExpr);
  if (BUSINESS_CROSSES_MIDNIGHT) {
    return `CASE
      WHEN TIME(${localExpr}) < '${BUSINESS_END_TIME}' THEN DATE_SUB(DATE(${localExpr}), INTERVAL 1 DAY)
      ELSE DATE(${localExpr})
    END`;
  }
  return `DATE(${localExpr})`;
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

function normalizeRoleToken(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return "";
  const dequoted = s.replace(/["'[\]{}()]/g, "");
  if (dequoted.includes("admin")) return "admin";
  if (dequoted.includes("manager") || dequoted.includes("gestionnaire")) return "manager";
  return dequoted
    .replace(/^roles?[_:-]?/, "")
    .replace(/^is[_:-]?/, "")
    .trim();
}

function extractRoleTokens(raw) {
  const parsed = parseRoles(raw);
  const out = new Set();
  for (const role of parsed) {
    const asString = String(role || "");
    asString
      .split(/[,\s;|]+/)
      .map((x) => normalizeRoleToken(x))
      .filter(Boolean)
      .forEach((x) => out.add(x));
    const full = normalizeRoleToken(asString);
    if (full) out.add(full);
  }
  return Array.from(out);
}

function hasWriteRole(user) {
  if (!CFG.enforceRoles) return true;
  const roles = extractRoleTokens(user && user.roles);
  if (!roles.length && CFG.allowWriteWithoutRole) return true;
  const set = new Set(roles);
  const expected = (CFG.writeRoles || []).map((r) => normalizeRoleToken(r)).filter(Boolean);
  if (expected.includes("*")) return true;
  return expected.some((r) => set.has(r));
}

function userRoleSet(user) {
  return new Set(extractRoleTokens(user && user.roles));
}

function isAdminUser(user) {
  return userRoleSet(user).has("admin");
}

function isManagerUser(user) {
  return userRoleSet(user).has("manager");
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
  const u = String(username || "").trim();
  const archiveCols = userArchiveSelectColumns();
  const sql = HAS_PASSWORD_HASH_COLUMN
    ? `SELECT id_user, username, password, password_hash, roles, last_login, is_active${archiveCols}
       FROM users
       WHERE username = ?
          OR TRIM(username) = ?
       LIMIT 1`
    : `SELECT id_user, username, password, roles, last_login, is_active${archiveCols}
       FROM users
       WHERE username = ?
          OR TRIM(username) = ?
       LIMIT 1`;
  const [rows] = await poolQueryWithTimeout(sql, [u, u], Math.max(3000, CFG.authLookupTimeoutMs));
  return rows && rows[0] ? rows[0] : null;
}

async function getUserById(idUser) {
  const archiveCols = userArchiveSelectColumns();
  const [rows] = await poolQueryWithTimeout(
    `SELECT id_user, username, roles, last_login, is_active${archiveCols}
     FROM users
     WHERE id_user = ?
     LIMIT 1`,
    [idUser],
    Math.max(3000, CFG.authLookupTimeoutMs)
  );
  return rows && rows[0] ? rows[0] : null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id_user: u.id_user,
    username: u.username,
    roles: u.roles,
    roleTokens: extractRoleTokens(u.roles),
    last_login: u.last_login,
    is_active: u.is_active,
    archived_at: u.archived_at || null,
    archived_by: u.archived_by || null,
    archived_reason: u.archived_reason || null,
    is_archived: !!u.archived_at,
  };
}

function hasUserColumn(name) {
  return USER_SCHEMA.has(String(name || ""));
}

function userArchiveSelectColumns() {
  const cols = [];
  if (hasUserColumn("archived_at")) cols.push("archived_at");
  if (hasUserColumn("archived_by")) cols.push("archived_by");
  if (hasUserColumn("archived_reason")) cols.push("archived_reason");
  return cols.length ? ", " + cols.join(", ") : "";
}

function normalizeUsername(v) {
  const username = sanitizeText(v, 100);
  if (!username) return "";
  return username.replace(/\s+/g, "_");
}

function normalizeUserRoles(raw) {
  const allowed = new Set(["admin", "manager", "cashier", "viewer"]);
  const source = Array.isArray(raw) ? raw : parseRoles(raw);
  const roles = source
    .map((role) => normalizeRoleToken(role))
    .filter((role) => allowed.has(role));
  const unique = Array.from(new Set(roles));
  return unique.length ? unique : ["cashier"];
}

const MANAGER_MANAGED_USER_ROLES = new Set(["cashier"]);

function isEmployeeRoleList(roles) {
  const normalized = normalizeUserRoles(roles);
  return normalized.length > 0 && normalized.every((role) => MANAGER_MANAGED_USER_ROLES.has(role));
}

function isEmployeeUserAccount(user) {
  return isEmployeeRoleList(extractRoleTokens(user && user.roles));
}

function enforceUserManagementScope(req, reply, targetUser, nextRoles) {
  if (isAdminUser(req.cagUser)) return false;
  if (!isManagerUser(req.cagUser)) {
    return sendError(reply, 403, "Forbidden", {
      hint: "Seuls les admins et managers peuvent gerer les utilisateurs.",
    });
  }
  if (targetUser && !isEmployeeUserAccount(targetUser)) {
    return sendError(reply, 403, "Forbidden", {
      hint: "Un manager ne peut gerer que les comptes Travailleur / caisse.",
    });
  }
  if (nextRoles && !isEmployeeRoleList(nextRoles)) {
    return sendError(reply, 403, "Forbidden", {
      hint: "Un manager peut uniquement attribuer le role Travailleur / caisse.",
    });
  }
  return false;
}

function rolesToDbValue(roles) {
  return JSON.stringify(normalizeUserRoles(roles));
}

function normalizeActiveFlag(v, fallback) {
  if (v == null || v === "") return fallback ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on" || s === "active" ? 1 : 0;
}

async function hashPassword(raw) {
  const password = typeof raw === "string" ? raw : "";
  if (password.length < 8) {
    const err = new Error("Password too short");
    err.statusCode = 400;
    throw err;
  }
  return bcrypt.hash(password, 12);
}

function getBearerToken(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseBodyObject(raw) {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return {};
    try {
      const j = JSON.parse(s);
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function getRequestBodyObject(req) {
  const body = parseBodyObject(req && req.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  if (body._payload && typeof body._payload === "object" && !Array.isArray(body._payload)) {
    return Object.assign({}, body._payload, {
      _token: typeof body._token === "string" ? body._token : body._payload._token,
      token: typeof body.token === "string" ? body.token : body._payload.token,
    });
  }
  return body;
}

function getRequestPayloadObject(req) {
  const body = getRequestBodyObject(req);
  const queryRaw = req && req.query && typeof req.query === "object" && !Array.isArray(req.query) ? req.query : {};
  const query = {};
  Object.keys(queryRaw).forEach((k) => {
    const v = queryRaw[k];
    if (v == null) return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      query[k] = String(v[0]);
      return;
    }
    if (typeof v === "string") {
      query[k] = v;
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      query[k] = String(v);
    }
  });
  return Object.assign({}, query, body);
}

function getTokenFromRequestBodyOrQuery(req) {
  const body = getRequestPayloadObject(req);
  const tokenFromBody =
    typeof body._token === "string"
      ? body._token.trim()
      : typeof body.token === "string"
        ? body.token.trim()
        : "";
  if (tokenFromBody) return tokenFromBody;
  const query = req && req.query && typeof req.query === "object" ? req.query : {};
  const tokenFromQuery =
    typeof query._token === "string"
      ? query._token.trim()
      : typeof query.token === "string"
        ? query.token.trim()
        : "";
  return tokenFromQuery || null;
}

async function requireAuth(req, reply) {
  const token = getBearerToken(req) || getTokenFromRequestBodyOrQuery(req);
  if (!token) return sendError(reply, 401, "Unauthorized");
  let payload;
  try {
    payload = jwt.verify(token, CFG.jwtSecret);
  } catch (_) {
    return sendError(reply, 401, "Unauthorized");
  }
  const idUser = payload && (payload.sub || payload.id_user || payload.idUser);
  if (!idUser) return sendError(reply, 401, "Unauthorized");
  if (!CFG.authDbCheck) {
    const tokenUser = {
      id_user: Number(idUser),
      username: payload && payload.username ? String(payload.username) : "",
      roles: payload && payload.roles != null ? payload.roles : "",
      is_active: payload && payload.is_active != null ? payload.is_active : 1,
      last_login: null,
    };
    if (String(tokenUser.is_active) === "0") return sendError(reply, 401, "Unauthorized");
    req.cagUser = tokenUser;
    return;
  }
  let user;
  try {
    user = await getUserById(idUser);
  } catch (e) {
    const code = e && e.code ? String(e.code) : "";
    if (code === "DB_POOL_TIMEOUT" || code === "DB_QUERY_TIMEOUT" || code === "PROTOCOL_SEQUENCE_TIMEOUT") {
      return sendError(reply, 503, "Auth lookup timeout", {
        hint: "Base de donnees lente pour la verification utilisateur.",
      });
    }
    throw e;
  }
  if (!user || String(user.is_active) === "0" || user.archived_at) return sendError(reply, 401, "Unauthorized");
  req.cagUser = user;
}

async function requireWrite(req, reply) {
  if (hasWriteRole(req.cagUser)) return;
  return sendError(reply, 403, "Forbidden", {
    hint: "Le compte connecte n'a pas les droits d'ecriture.",
    userRoles: extractRoleTokens(req.cagUser && req.cagUser.roles),
    requiredRoles: CFG.writeRoles,
  });
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

function sanitizeImageUrl(v) {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch (_) {
    return null;
  }
  return s.slice(0, 1024);
}

function sanitizeClientSaleUid(v) {
  const raw = sanitizeText(v, 128);
  if (!raw) return "";
  if (!/^[a-zA-Z0-9._:-]{6,128}$/.test(raw)) return "";
  return raw;
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeLinkPageSlug(v, fallback) {
  const raw = sanitizeText(v, 120) || sanitizeText(fallback, 120);
  const slug = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "";
}

function sanitizePublicUrl(v) {
  const raw = sanitizeText(v, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href.slice(0, 500);
  } catch (_) {
    return "";
  }
}

function normalizeEmail(v) {
  const email = sanitizeText(v, 190).toLowerCase();
  if (!email) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizePhone(v) {
  const phone = sanitizeText(v, 80);
  if (!phone) return "";
  return /^[0-9+().\-\s]{6,80}$/.test(phone) ? phone : "";
}

function normalizePageType(v) {
  const raw = sanitizeText(v, 60).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const map = {
    standard: "standard",
    default: "standard",
    game_room: "game_room",
    salle_de_jeu: "game_room",
    salle_jeu: "game_room",
    arcade: "game_room",
  };
  return map[raw] || "standard";
}

function defaultLinkLabel(type) {
  const key = sanitizeText(type, 40).toLowerCase();
  const map = {
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    snapchat: "Snapchat",
    youtube: "YouTube",
    whatsapp: "WhatsApp",
    linkedin: "LinkedIn",
    website: "Site web",
    maps: "Google Maps",
  };
  return map[key] || "Lien utile";
}

function parseLinkPageLinks(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === "") return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function normalizeLinkPageLinks(raw, errors) {
  const source = parseLinkPageLinks(raw);
  const out = [];
  for (let i = 0; i < source.length && out.length < 12; i += 1) {
    const item = source[i] || {};
    const type = sanitizeText(item.type, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "link";
    const label = sanitizeText(item.label, 80) || defaultLinkLabel(type);
    const urlRaw = sanitizeText(item.url, 500);
    if (!label && !urlRaw) continue;
    const url = sanitizePublicUrl(urlRaw);
    if (!url) {
      if (urlRaw && errors) errors.push(`Lien #${i + 1}: URL invalide.`);
      continue;
    }
    out.push({ type, label, url });
  }
  return out;
}

function normalizeLinkPagePayload(rawBody, existing) {
  const b = Object.assign({}, existing || {}, rawBody || {});
  const errors = [];
  const title = sanitizeText(b.title, 160);
  const slug = normalizeLinkPageSlug(b.slug, title);
  const emailRaw = sanitizeText(b.email, 190);
  const phoneRaw = sanitizeText(b.phone, 80);
  const email = normalizeEmail(emailRaw);
  const phone = normalizePhone(phoneRaw);
  const links = normalizeLinkPageLinks(b.links != null ? b.links : b.links_json, errors);

  if (!title) errors.push("Titre obligatoire.");
  if (!slug) errors.push("Identifiant de page obligatoire.");
  if (emailRaw && !email) errors.push("Email invalide.");
  if (phoneRaw && !phone) errors.push("Numero de telephone invalide.");
  if (!links.length && !email && !phone) errors.push("Ajoute au moins un lien, un email ou un numero de telephone.");

  return {
    errors,
    data: {
      slug,
      pageType: normalizePageType(b.pageType != null ? b.pageType : b.page_type),
      title,
      subtitle: sanitizeText(b.subtitle, 220),
      description: sanitizeText(b.description, 1200),
      email,
      phone,
      links,
      isActive: normalizeActiveFlag(b.is_active != null ? b.is_active : b.isActive, true),
    },
  };
}

function getRequestBaseUrl(req) {
  const configured = sanitizeText(process.env.PUBLIC_BASE_URL || "", 240).replace(/\/+$/g, "");
  if (configured) return configured;
  const protoHeader = req.headers && (req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"]);
  const hostHeader = req.headers && (req.headers["x-forwarded-host"] || req.headers.host);
  const proto = String(Array.isArray(protoHeader) ? protoHeader[0] : protoHeader || "https").split(",")[0].trim() || "https";
  const host = String(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader || "cag.mybusinesslife.fr").split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/g, "");
}

function linkPagePublicUrl(req, slug) {
  return `${getRequestBaseUrl(req)}/l/${encodeURIComponent(slug)}`;
}

function linkPageQrUrl(req, slug) {
  return `${getRequestBaseUrl(req)}/qr/${encodeURIComponent(slug)}.png`;
}

function rowToLinkPage(row, req) {
  const slug = row.slug || "";
  return {
    id: Number(row.id_link_page || row.id || 0),
    slug,
    pageType: normalizePageType(row.page_type),
    title: row.title || "",
    subtitle: row.subtitle || "",
    description: row.description || "",
    email: row.email || "",
    phone: row.phone || "",
    links: normalizeLinkPageLinks(row.links_json || [], []),
    isActive: Number(row.is_active) === 1,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    updatedBy: row.updated_by == null ? null : Number(row.updated_by),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    publicUrl: linkPagePublicUrl(req, slug),
    qrUrl: linkPageQrUrl(req, slug),
  };
}

function platformMeta(type) {
  const key = sanitizeText(type, 40).toLowerCase();
  const map = {
    instagram: { label: "Instagram", color: "#df2d75", rgb: "223,45,117" },
    facebook: { label: "Facebook", color: "#1877f2", rgb: "24,119,242" },
    tiktok: { label: "TikTok", color: "#111827", rgb: "17,24,39" },
    snapchat: { label: "Snapchat", color: "#f6c900", rgb: "246,201,0" },
    youtube: { label: "YouTube", color: "#ff0033", rgb: "255,0,51" },
    whatsapp: { label: "WhatsApp", color: "#20c765", rgb: "32,199,101" },
    linkedin: { label: "LinkedIn", color: "#0a66c2", rgb: "10,102,194" },
    maps: { label: "Google Maps", color: "#34a853", rgb: "52,168,83" },
    website: { label: "Site web", color: "#12b8a6", rgb: "18,184,166" },
    link: { label: "Lien utile", color: "#12b8a6", rgb: "18,184,166" },
  };
  return map[key] || map.link;
}

function platformIcon(type) {
  const key = sanitizeText(type, 40).toLowerCase();
  const common = `class="brand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`;
  if (key === "instagram") {
    return `<svg ${common}><rect x="4.8" y="4.8" width="14.4" height="14.4" rx="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.35" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.8" cy="7.3" r="1.25" fill="currentColor"/></svg>`;
  }
  if (key === "tiktok") {
    return `<svg ${common}><path fill="currentColor" d="M14.3 3.7c.35 2.55 1.82 4.15 4.45 4.65v3.15a8.9 8.9 0 0 1-4.38-1.42v5.22c0 3.32-2.18 5.45-5.18 5.45-2.73 0-4.85-1.9-4.85-4.45 0-2.58 2.1-4.48 4.83-4.48.43 0 .82.05 1.2.15v3.32a2.4 2.4 0 0 0-1.1-.27c-1.02 0-1.75.58-1.75 1.35 0 .83.75 1.42 1.73 1.42 1.1 0 1.72-.72 1.72-2V3.7h3.33Z"/></svg>`;
  }
  if (key === "facebook") {
    return `<svg ${common}><path fill="currentColor" d="M14.1 8.6h2.55V5.05c-.45-.06-1.95-.2-3.7-.2-3.66 0-6.16 2.24-6.16 6.34v3.1H3.8v3.96h3V24h4.18v-5.75h3.47l.56-3.96h-4.03v-2.72c0-1.14.31-1.92 2-1.92h1.13V8.6Z"/></svg>`;
  }
  if (key === "youtube") {
    return `<svg ${common}><path fill="currentColor" d="M21.35 7.35a3.02 3.02 0 0 0-2.12-2.12C17.35 4.72 12 4.72 12 4.72s-5.35 0-7.23.51a3.02 3.02 0 0 0-2.12 2.12A31.8 31.8 0 0 0 2.14 12c0 1.62.17 3.24.51 4.65a3.02 3.02 0 0 0 2.12 2.12c1.88.51 7.23.51 7.23.51s5.35 0 7.23-.51a3.02 3.02 0 0 0 2.12-2.12c.34-1.41.51-3.03.51-4.65s-.17-3.24-.51-4.65ZM10.05 15.55v-7.1L16.2 12l-6.15 3.55Z"/></svg>`;
  }
  if (key === "whatsapp") {
    return `<svg ${common}><path fill="currentColor" d="M12.02 3.3A8.62 8.62 0 0 0 4.7 16.5L3.62 20.7l4.3-1.05a8.62 8.62 0 1 0 4.1-16.35Zm0 2.05a6.55 6.55 0 1 1-3.33 12.2l-.3-.18-2.1.52.54-2.03-.2-.32a6.55 6.55 0 0 1 5.39-10.19Zm-2.35 3.2c-.16 0-.4.06-.6.3-.2.24-.78.76-.78 1.86 0 1.1.8 2.17.92 2.32.11.15 1.57 2.52 3.88 3.43 1.92.75 2.32.6 2.73.57.42-.04 1.35-.55 1.54-1.08.19-.53.19-.98.13-1.08-.06-.1-.21-.16-.45-.28-.24-.12-1.4-.69-1.62-.77-.22-.08-.38-.12-.54.12-.16.24-.62.77-.76.93-.14.16-.28.18-.52.06-.24-.12-1-.37-1.91-1.18-.7-.63-1.18-1.4-1.32-1.64-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.53-1.28-.73-1.75-.19-.46-.38-.4-.55-.4h-.1Z"/></svg>`;
  }
  if (key === "snapchat") {
    return `<svg ${common}><path fill="currentColor" d="M12 3.55c2.46 0 4.16 1.74 4.16 4.23v2.06c0 .23.17.39.42.39.37 0 .83-.22 1.1-.34.2-.1.38-.04.47.14.11.22.03.53-.25.75-.38.3-.92.52-1.46.68.28 1.05 1.08 1.78 2.18 2.24.55.23.54.92-.04 1.1-.52.16-1.1.27-1.75.33-.2.32-.4.68-.62 1.08-.13.24-.4.36-.66.28-.64-.18-1.24-.16-1.82.07-.5.2-.93.58-1.47.92-.52.34-1.18.66-2.26.66s-1.74-.32-2.26-.66c-.54-.34-.97-.72-1.47-.92-.58-.23-1.18-.25-1.82-.07a.62.62 0 0 1-.66-.28c-.22-.4-.42-.76-.62-1.08a9.2 9.2 0 0 1-1.75-.33c-.58-.18-.59-.87-.04-1.1 1.1-.46 1.9-1.19 2.18-2.24-.54-.16-1.08-.38-1.46-.68-.28-.22-.36-.53-.25-.75.09-.18.27-.24.47-.14.27.12.73.34 1.1.34.25 0 .42-.16.42-.39V7.78C7.84 5.29 9.54 3.55 12 3.55Z"/></svg>`;
  }
  if (key === "linkedin") {
    return `<svg ${common}><path fill="currentColor" d="M5.1 8.92H1.52V20.4H5.1V8.92ZM3.32 3.25a2.07 2.07 0 1 0 0 4.14 2.07 2.07 0 0 0 0-4.14ZM20.48 14.05c0-3.08-1.65-5.13-4.35-5.13-1.98 0-2.86 1.08-3.35 1.84V8.92H9.2V20.4h3.58v-5.68c0-1.5.29-2.95 2.14-2.95 1.82 0 1.84 1.7 1.84 3.04v5.59h3.58l.14-6.35Z"/></svg>`;
  }
  if (key === "maps") {
    return `<svg ${common}><path fill="currentColor" d="M12 2.8a7.15 7.15 0 0 0-7.15 7.15c0 5.2 7.15 11.25 7.15 11.25s7.15-6.05 7.15-11.25A7.15 7.15 0 0 0 12 2.8Zm0 9.72a2.62 2.62 0 1 1 0-5.24 2.62 2.62 0 0 1 0 5.24Z"/></svg>`;
  }
  return `<svg ${common}><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.6 13.4a4 4 0 0 0 5.66 0l2.12-2.12a4 4 0 0 0-5.66-5.66l-1.2 1.2"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.4 10.6a4 4 0 0 0-5.66 0l-2.12 2.12a4 4 0 0 0 5.66 5.66l1.2-1.2"/></svg>`;
}

function contactIcon(type) {
  if (type === "email") {
    return `<svg class="mini-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" d="M4 6h16v12H4z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4 7 8 6 8-6"/></svg>`;
  }
  return `<svg class="mini-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7.5 4.5 10 7 8.6 9.2c.9 1.9 2.3 3.3 4.2 4.2L15 12l2.5 2.5-.7 3.2c-.1.5-.6.8-1.1.8C9.9 18.5 5.5 14.1 5.5 8.3c0-.5.3-1 .8-1.1l1.2-.7Z"/></svg>`;
}

function linkHostLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "");
  } catch (_) {
    return "";
  }
}

function renderPublicLinkPage(page) {
  const links = Array.isArray(page.links) ? page.links : [];
  const contactLinks = [];
  if (page.email) contactLinks.push({ type: "email", label: "Email", value: page.email, url: `mailto:${page.email}` });
  if (page.phone) contactLinks.push({ type: "phone", label: "Téléphone", value: page.phone, url: `tel:${page.phone.replace(/[^\d+]/g, "")}` });
  const usefulLinksHtml = links.map((link, index) => {
    const meta = platformMeta(link.type);
    const host = linkHostLabel(link.url);
    const style = `--brand:${meta.color};--brand-rgb:${meta.rgb};--delay:${Math.min(index * 70, 560)}ms`;
    return `<a class="link-card" style="${style}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(link.label)}">` +
      `<span class="logo-box">${platformIcon(link.type)}</span>` +
      `<span class="link-copy"><strong>${escapeHtml(link.label)}</strong><small>${escapeHtml(meta.label)}${host ? ` · ${escapeHtml(host)}` : ""}</small></span>` +
      `<span class="link-action">Ouvrir<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` +
      `</a>`;
  }).join("");
  const contactHtml = contactLinks.map((link) => (
    `<a class="contact-pill" href="${escapeHtml(link.url)}">${contactIcon(link.type)}<span><strong>${escapeHtml(link.label)}</strong><small>${escapeHtml(link.value)}</small></span></a>`
  )).join("");
  const linkCountLabel = links.length > 1 ? `${links.length} liens utiles` : links.length === 1 ? "1 lien utile" : "Contact direct";
  const isGameRoom = page.pageType === "game_room";
  const bodyClass = isGameRoom ? ' class="theme-game-room"' : "";
  const sceneHtml = isGameRoom ? '<div class="game-room-scene" aria-hidden="true"><canvas id="game-room-canvas"></canvas></div>' : "";
  const sceneScript = isGameRoom ? '<script type="module" src="/assets/link-page-scene.js"></script>' : "";

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(page.title)}</title>
    <meta name="description" content="${escapeHtml(page.subtitle || page.description || page.title)}" />
    <style>
      :root {
        color-scheme: light;
        --ink:#07110d;
        --muted:#586b63;
        --line:rgba(15,35,28,.13);
        --soft:#f7fbf8;
        --paper:rgba(255,255,255,.86);
        --accent:#13b99f;
        --gold:#d9b76f;
        --shadow:0 26px 74px rgba(7,17,13,.13);
      }
      * { box-sizing:border-box; }
      html { min-height:100%; background:#f4faf6; }
      body {
        min-height:100svh;
        margin:0;
        color:var(--ink);
        font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          linear-gradient(135deg, rgba(255,255,255,.96), rgba(237,248,242,.9) 48%, rgba(255,255,255,.98)),
          repeating-linear-gradient(90deg, rgba(9,30,22,.035) 0 1px, transparent 1px 44px),
          repeating-linear-gradient(0deg, rgba(9,30,22,.03) 0 1px, transparent 1px 44px);
        display:grid;
        place-items:center;
        padding:34px 18px;
        overflow-x:hidden;
      }
      body::before {
        content:"";
        position:fixed;
        inset:0;
        pointer-events:none;
        z-index:0;
        background:linear-gradient(120deg, transparent 15%, rgba(19,185,159,.1) 38%, transparent 62%, rgba(217,183,111,.12) 84%, transparent);
        opacity:.75;
        animation:ambientSweep 9s ease-in-out infinite alternate;
      }
      .theme-game-room {
        background:
          radial-gradient(circle at 20% 8%, rgba(44, 214, 255, .2), transparent 34%),
          radial-gradient(circle at 82% 18%, rgba(255, 61, 151, .16), transparent 32%),
          linear-gradient(145deg, #07110d 0%, #0d1714 42%, #08100d 100%);
        color:#f8fff9;
      }
      .theme-game-room::before {
        background:linear-gradient(120deg, rgba(255,255,255,.04), rgba(19,185,159,.08), rgba(255,255,255,.04));
        opacity:.9;
      }
      .theme-game-room::after {
        content:"";
        position:fixed;
        inset:0;
        z-index:1;
        pointer-events:none;
        background:radial-gradient(circle at center, rgba(255,255,255,.16), rgba(255,255,255,.08) 42%, rgba(7,17,13,.42) 100%);
      }
      .game-room-scene {
        position:fixed;
        inset:0;
        z-index:0;
        pointer-events:none;
        overflow:hidden;
      }
      .game-room-scene canvas {
        width:100%;
        height:100%;
        display:block;
        opacity:.76;
        filter:saturate(1.08) contrast(1.03);
      }
      .page {
        position:relative;
        z-index:2;
        width:min(720px,100%);
        display:grid;
        gap:24px;
        animation:pageIn .7s cubic-bezier(.2,.8,.2,1) both;
      }
      .theme-game-room .page {
        padding:22px;
        border:1px solid rgba(255,255,255,.14);
        border-radius:38px;
        background:linear-gradient(145deg, rgba(255,255,255,.9), rgba(246,255,250,.78));
        box-shadow:0 36px 110px rgba(0,0,0,.34);
        backdrop-filter:blur(18px);
      }
      .brand {
        display:grid;
        gap:14px;
        justify-items:center;
        text-align:center;
        padding-top:4px;
      }
      .brand-mark {
        position:relative;
        width:88px;
        height:88px;
        border-radius:29px;
        display:grid;
        place-items:center;
        color:#fff;
        background:linear-gradient(145deg,#07110d,#13271f);
        box-shadow:0 22px 54px rgba(7,17,13,.2), inset 0 0 0 1px rgba(255,255,255,.12);
        font-weight:1000;
      }
      .brand-mark::after {
        content:"";
        position:absolute;
        inset:-6px;
        border-radius:34px;
        border:1px solid rgba(19,185,159,.28);
        animation:ringPulse 2.9s ease-in-out infinite;
      }
      .eyebrow {
        display:inline-flex;
        align-items:center;
        gap:8px;
        margin:2px 0 0;
        padding:8px 12px;
        border:1px solid rgba(217,183,111,.35);
        border-radius:999px;
        background:rgba(255,255,255,.68);
        color:#6d5a2b;
        font-size:12px;
        font-weight:900;
        text-transform:uppercase;
        letter-spacing:.08em;
      }
      h1 {
        margin:0;
        max-width:12ch;
        font-size:58px;
        line-height:.95;
        letter-spacing:0;
      }
      p { margin:0; color:var(--muted); line-height:1.6; }
      .subtitle {
        max-width:52ch;
        font-size:19px;
        font-weight:720;
      }
      .description {
        border:1px solid var(--line);
        border-radius:24px;
        padding:18px 20px;
        background:rgba(255,255,255,.62);
        box-shadow:0 16px 44px rgba(7,17,13,.07);
        white-space:pre-wrap;
      }
      .links {
        display:grid;
        gap:14px;
      }
      .link-card {
        position:relative;
        min-height:86px;
        display:grid;
        grid-template-columns:62px minmax(0,1fr) auto;
        align-items:center;
        gap:15px;
        padding:14px 16px;
        border:1px solid rgba(var(--brand-rgb),.2);
        border-radius:26px;
        color:var(--ink);
        text-decoration:none;
        background:linear-gradient(135deg, rgba(var(--brand-rgb),.1), var(--paper) 42%, rgba(255,255,255,.96));
        box-shadow:var(--shadow);
        overflow:hidden;
        transform:translateY(14px);
        opacity:0;
        animation:cardIn .58s cubic-bezier(.2,.8,.2,1) forwards;
        animation-delay:var(--delay);
      }
      .link-card::before {
        content:"";
        position:absolute;
        inset:0;
        background:linear-gradient(105deg, transparent, rgba(255,255,255,.72), transparent);
        transform:translateX(-120%);
        opacity:.6;
      }
      .logo-box {
        width:58px;
        height:58px;
        border-radius:20px;
        display:grid;
        place-items:center;
        color:var(--brand);
        background:rgba(var(--brand-rgb),.12);
        box-shadow:inset 0 0 0 1px rgba(var(--brand-rgb),.16);
      }
      .brand-icon { width:30px; height:30px; display:block; }
      .link-copy { min-width:0; display:grid; gap:5px; }
      .link-copy strong {
        display:block;
        color:var(--ink);
        font-size:22px;
        font-weight:950;
        overflow-wrap:anywhere;
      }
      .link-copy small {
        color:var(--muted);
        font-size:13px;
        font-weight:800;
        overflow-wrap:anywhere;
      }
      .link-action {
        display:inline-flex;
        align-items:center;
        gap:7px;
        color:var(--brand);
        font-size:13px;
        font-weight:950;
        text-transform:uppercase;
        letter-spacing:.06em;
      }
      .link-action svg { width:17px; height:17px; transition:transform .22s ease; }
      .contact {
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:12px;
      }
      .contact-pill {
        display:flex;
        align-items:center;
        gap:12px;
        min-width:0;
        padding:14px 16px;
        border:1px solid var(--line);
        border-radius:22px;
        color:var(--ink);
        text-decoration:none;
        background:rgba(255,255,255,.82);
        box-shadow:0 14px 36px rgba(7,17,13,.08);
      }
      .mini-icon {
        flex:0 0 auto;
        width:24px;
        height:24px;
        color:var(--accent);
      }
      .contact-pill span { min-width:0; display:grid; gap:3px; }
      .contact-pill strong { font-weight:950; }
      .contact-pill small { color:var(--muted); overflow-wrap:anywhere; }
      footer {
        display:flex;
        justify-content:center;
        padding:5px 0 0;
        color:#7c9288;
        font-size:12px;
        font-weight:850;
      }
      @media (hover:hover) {
        .link-card:hover { transform:translateY(-3px); box-shadow:0 30px 86px rgba(7,17,13,.18); }
        .link-card:hover::before { animation:sheen .8s ease; }
        .link-card:hover .link-action svg { transform:translateX(4px); }
        .contact-pill:hover { transform:translateY(-2px); box-shadow:0 20px 54px rgba(7,17,13,.12); }
      }
      @media (max-width:680px) {
        body { padding:24px 12px; place-items:start center; }
        .theme-game-room { padding:12px; }
        .theme-game-room .page { padding:18px; border-radius:30px; }
        .page { gap:18px; }
        .brand { gap:11px; }
        .brand-mark { width:74px; height:74px; border-radius:24px; }
        h1 { font-size:38px; max-width:11ch; }
        .subtitle { font-size:16px; }
        .link-card { grid-template-columns:54px minmax(0,1fr); min-height:78px; border-radius:22px; padding:13px; }
        .logo-box { width:50px; height:50px; border-radius:17px; }
        .brand-icon { width:26px; height:26px; }
        .link-copy strong { font-size:19px; }
        .link-action { grid-column:2; justify-self:start; margin-top:-4px; }
        .contact { grid-template-columns:1fr; }
      }
      @media (prefers-reduced-motion:reduce) {
        *, *::before, *::after { animation:none !important; transition:none !important; }
        .link-card { opacity:1; transform:none; }
        .game-room-scene { display:none; }
      }
      @keyframes pageIn { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
      @keyframes cardIn { to { opacity:1; transform:translateY(0); } }
      @keyframes sheen { to { transform:translateX(120%); } }
      @keyframes ringPulse { 0%,100% { transform:scale(.98); opacity:.45; } 50% { transform:scale(1.08); opacity:1; } }
      @keyframes ambientSweep { from { transform:translateX(-2%); } to { transform:translateX(2%); } }
    </style>
  </head>
  <body${bodyClass}>
    ${sceneHtml}
    <main class="page">
      <section class="brand">
        <div class="brand-mark">CAG</div>
        <p class="eyebrow">${escapeHtml(linkCountLabel)}</p>
        <h1>${escapeHtml(page.title)}</h1>
        ${page.subtitle ? `<p class="subtitle">${escapeHtml(page.subtitle)}</p>` : ""}
      </section>
      ${page.description ? `<p class="description">${escapeHtml(page.description)}</p>` : ""}
      <section class="links">${usefulLinksHtml || ""}</section>
      ${contactHtml ? `<section class="contact">${contactHtml}</section>` : ""}
      <footer>Come & Game</footer>
    </main>
    ${sceneScript}
  </body>
</html>`;
}

function parseNumericIdList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(Number).filter((x) => Number.isFinite(x) && x > 0);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    return s
      .split(/[,\s;|]+/)
      .map((x) => Number(String(x).trim()))
      .filter((x) => Number.isFinite(x) && x > 0);
  }
  if (raw == null) return [];
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return [n];
  return [];
}

function normalizePaymentMethod(v) {
  const method = sanitizeText(v, 32).toLowerCase();
  if (!method) return "unknown";
  const allowed = new Set(["cash", "card", "mobile", "transfer", "check", "mixed", "unknown"]);
  return allowed.has(method) ? method : "unknown";
}

function normalizePurchaseCategory(v) {
  const raw = sanitizeText(v, 80).toLowerCase();
  const map = {
    alimentaire: "stock_alimentaire",
    stock: "stock_alimentaire",
    "stock alimentaire": "stock_alimentaire",
    stock_alimentaire: "stock_alimentaire",
    materiel: "materiel",
    "matériel": "materiel",
    loyer: "loyer",
    service: "service",
    services: "service",
    investissement: "investissement_depart",
    "investissement de depart": "investissement_depart",
    "investissement de départ": "investissement_depart",
    investissement_depart: "investissement_depart",
    maintenance: "maintenance",
    marketing: "marketing",
    autre: "autre",
  };
  return map[raw] || raw || "autre";
}

function publicPurchaseCategoryLabel(category) {
  const labels = {
    stock_alimentaire: "Alimentaire / stock",
    materiel: "Materiel",
    loyer: "Loyer",
    service: "Services",
    investissement_depart: "Investissement de depart",
    maintenance: "Maintenance",
    marketing: "Marketing",
    autre: "Autre",
  };
  return labels[category] || category || "Autre";
}

function sqlDateOnly(v) {
  const s = sanitizeText(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function roundToStep(value, step) {
  const n = Number(value);
  const s = Number(step) || 1;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / s) * s;
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

async function refreshUserSchema() {
  const cols = await loadColumns("users");
  USER_SCHEMA.clear();
  cols.forEach((col) => USER_SCHEMA.add(col));
  HAS_PASSWORD_HASH_COLUMN = USER_SCHEMA.has("password_hash");
}

async function ensureUsersArchiveColumns(connOrPool) {
  const db = connOrPool || pool;
  await refreshUserSchema();
  if (!USER_SCHEMA.has("archived_at")) {
    await db.query(`ALTER TABLE users ADD COLUMN archived_at DATETIME NULL`);
  }
  if (!USER_SCHEMA.has("archived_by")) {
    await db.query(`ALTER TABLE users ADD COLUMN archived_by BIGINT NULL`);
  }
  if (!USER_SCHEMA.has("archived_reason")) {
    await db.query(`ALTER TABLE users ADD COLUMN archived_reason VARCHAR(255) NULL`);
  }
  await refreshUserSchema();
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

async function ensurePurchasesTable(connOrPool) {
  if (PURCHASES_TABLE_READY) return;
  const db = connOrPool || pool;
  await db.query(
    `CREATE TABLE IF NOT EXISTS cag_purchases (
      id_purchase BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      purchase_date DATETIME NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'autre',
      label VARCHAR(180) NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      quantity DECIMAL(12,3) NULL,
      unit VARCHAR(40) NULL,
      supplier VARCHAR(160) NULL,
      payment_method VARCHAR(40) NULL,
      product_id BIGINT NULL,
      stock_quantity DECIMAL(12,3) NULL,
      apply_stock TINYINT(1) NOT NULL DEFAULT 0,
      assigned_user_id BIGINT NULL,
      is_startup_investment TINYINT(1) NOT NULL DEFAULT 0,
      notes TEXT NULL,
      created_by BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id_purchase),
      KEY idx_cag_purchases_date (purchase_date),
      KEY idx_cag_purchases_category (category),
      KEY idx_cag_purchases_product (product_id),
      KEY idx_cag_purchases_assigned_user (assigned_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  PURCHASES_TABLE_READY = true;
}

async function ensureLinkPagesTable(connOrPool) {
  if (LINK_PAGES_TABLE_READY) return;
  const db = connOrPool || pool;
  await db.query(
    `CREATE TABLE IF NOT EXISTS cag_link_pages (
      id_link_page BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      slug VARCHAR(80) NOT NULL,
      page_type VARCHAR(60) NOT NULL DEFAULT 'standard',
      title VARCHAR(160) NOT NULL,
      subtitle VARCHAR(220) NULL,
      description TEXT NULL,
      email VARCHAR(190) NULL,
      phone VARCHAR(80) NULL,
      links_json MEDIUMTEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT UNSIGNED NULL,
      updated_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id_link_page),
      UNIQUE KEY ux_cag_link_pages_slug (slug),
      KEY idx_cag_link_pages_active (is_active),
      KEY idx_cag_link_pages_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const cols = await loadColumns("cag_link_pages");
  LINK_PAGES_SCHEMA.clear();
  cols.forEach((col) => LINK_PAGES_SCHEMA.add(col));
  if (!LINK_PAGES_SCHEMA.has("page_type")) {
    await db.query(`ALTER TABLE cag_link_pages ADD COLUMN page_type VARCHAR(60) NOT NULL DEFAULT 'standard' AFTER slug`);
    LINK_PAGES_SCHEMA.add("page_type");
  }
  LINK_PAGES_TABLE_READY = true;
}

async function getLinkPageById(id, req) {
  await ensureLinkPagesTable();
  const [rows] = await pool.query(
    `SELECT id_link_page, slug, page_type, title, subtitle, description, email, phone, links_json, is_active, created_by, updated_by, created_at, updated_at
     FROM cag_link_pages
     WHERE id_link_page = ?
     LIMIT 1`,
    [id]
  );
  return rows && rows[0] ? rowToLinkPage(rows[0], req) : null;
}

async function getLinkPageBySlug(slug, req, includeInactive) {
  await ensureLinkPagesTable();
  const [rows] = await pool.query(
    `SELECT id_link_page, slug, page_type, title, subtitle, description, email, phone, links_json, is_active, created_by, updated_by, created_at, updated_at
     FROM cag_link_pages
     WHERE slug = ? ${includeInactive ? "" : "AND is_active = 1"}
     LIMIT 1`,
    [slug]
  );
  return rows && rows[0] ? rowToLinkPage(rows[0], req) : null;
}

async function sendQrPng(reply, url, slug, download) {
  const png = await QRCode.toBuffer(url, {
    type: "png",
    width: 1400,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#000000",
      light: "#0000",
    },
  });
  reply.header("Cache-Control", "no-store");
  if (download) reply.header("Content-Disposition", `attachment; filename="qrcode-${slug}.png"`);
  reply.type("image/png").send(png);
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
  return {
    ok: true,
    apiVersion: API_VERSION,
    now: new Date().toISOString(),
  };
});

async function handlePublicLinkPage(req, reply) {
  const slug = normalizeLinkPageSlug(req.params && req.params.slug, "");
  if (!slug) return sendError(reply, 404, "Not found");
  const page = await getLinkPageBySlug(slug, req, false);
  if (!page) return sendError(reply, 404, "Not found");
  reply.header("Cache-Control", "public, max-age=120");
  reply.type("text/html; charset=utf-8").send(renderPublicLinkPage(page));
}

fastify.get("/l/:slug", handlePublicLinkPage);
fastify.get("/links/:slug", handlePublicLinkPage);

fastify.get("/qr/:slug", async (req, reply) => {
  const rawSlug = String((req.params && req.params.slug) || "").replace(/\.png$/i, "");
  const slug = normalizeLinkPageSlug(rawSlug, "");
  if (!slug) return sendError(reply, 404, "Not found");
  const page = await getLinkPageBySlug(slug, req, false);
  if (!page) return sendError(reply, 404, "Not found");
  return sendQrPng(reply, page.publicUrl, page.slug, false);
});

fastify.get(
  CFG.apiPrefix + "/link-pages",
  {
    preHandler: requireAuth,
  },
  async (req) => {
    await ensureLinkPagesTable();
    const q = sanitizeText(req.query && req.query.q, 120);
    const limit = clampInt(req.query && req.query.limit, 1, 100, 25);
    const offset = clampInt(req.query && req.query.offset, 0, 100000, 0);
    const values = [];
    let where = "";
    if (q) {
      where = "WHERE title LIKE ? OR slug LIKE ? OR page_type LIKE ? OR email LIKE ? OR phone LIKE ?";
      const like = `%${q}%`;
      values.push(like, like, like, like, like);
    }
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS total FROM cag_link_pages ${where}`, values);
    const [rows] = await pool.query(
      `SELECT id_link_page, slug, page_type, title, subtitle, description, email, phone, links_json, is_active, created_by, updated_by, created_at, updated_at
       FROM cag_link_pages
       ${where}
       ORDER BY updated_at DESC, id_link_page DESC
       LIMIT ? OFFSET ?`,
      values.concat([limit, offset])
    );
    return {
      total: Number(totalRows && totalRows[0] && totalRows[0].total || 0),
      items: (rows || []).map((row) => rowToLinkPage(row, req)),
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
    const normalized = normalizeLinkPagePayload(getRequestPayloadObject(req), null);
    if (normalized.errors.length) return sendError(reply, 400, "Invalid link page", { hint: normalized.errors.join(" ") });
    const p = normalized.data;
    const conn = await getConnectionWithTimeout(4000);
    try {
      const [res] = await queryWithTimeout(
        conn,
        `INSERT INTO cag_link_pages (slug, page_type, title, subtitle, description, email, phone, links_json, is_active, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.slug,
          p.pageType,
          p.title,
          p.subtitle || null,
          p.description || null,
          p.email || null,
          p.phone || null,
          JSON.stringify(p.links),
          p.isActive,
          req.cagUser && req.cagUser.id_user || null,
          req.cagUser && req.cagUser.id_user || null,
        ],
        8000
      );
      const created = await getLinkPageById(res.insertId, req);
      reply.code(201).send({ ok: true, item: created });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "create-link-page");
      if (handled !== false) return handled;
      throw e;
    } finally {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
  }
);

fastify.patch(
  CFG.apiPrefix + "/link-pages/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = /^\d+$/.test(String(req.params && req.params.id)) ? Number(req.params.id) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    const existing = await getLinkPageById(id, req);
    if (!existing) return sendError(reply, 404, "Not found");
    const normalized = normalizeLinkPagePayload(getRequestPayloadObject(req), existing);
    if (normalized.errors.length) return sendError(reply, 400, "Invalid link page", { hint: normalized.errors.join(" ") });
    const p = normalized.data;
    const conn = await getConnectionWithTimeout(4000);
    try {
      const [res] = await queryWithTimeout(
        conn,
        `UPDATE cag_link_pages
         SET slug = ?, page_type = ?, title = ?, subtitle = ?, description = ?, email = ?, phone = ?, links_json = ?, is_active = ?, updated_by = ?
         WHERE id_link_page = ?`,
        [
          p.slug,
          p.pageType,
          p.title,
          p.subtitle || null,
          p.description || null,
          p.email || null,
          p.phone || null,
          JSON.stringify(p.links),
          p.isActive,
          req.cagUser && req.cagUser.id_user || null,
          id,
        ],
        8000
      );
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      const updated = await getLinkPageById(id, req);
      reply.send({ ok: true, item: updated });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "update-link-page");
      if (handled !== false) return handled;
      throw e;
    } finally {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
  }
);

fastify.delete(
  CFG.apiPrefix + "/link-pages/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = /^\d+$/.test(String(req.params && req.params.id)) ? Number(req.params.id) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    await ensureLinkPagesTable();
    const [res] = await pool.query(
      `UPDATE cag_link_pages SET is_active = 0, updated_by = ? WHERE id_link_page = ?`,
      [req.cagUser && req.cagUser.id_user || null, id]
    );
    if (!res.affectedRows) return sendError(reply, 404, "Not found");
    const item = await getLinkPageById(id, req);
    return { ok: true, item };
  }
);

fastify.get(
  CFG.apiPrefix + "/link-pages/:id/qr",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = /^\d+$/.test(String(req.params && req.params.id)) ? Number(req.params.id) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    const page = await getLinkPageById(id, req);
    if (!page) return sendError(reply, 404, "Not found");
    return sendQrPng(reply, page.publicUrl, page.slug, true);
  }
);

fastify.get(
  CFG.apiPrefix + "/link-pages/:id/qr.png",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const id = /^\d+$/.test(String(req.params && req.params.id)) ? Number(req.params.id) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    const page = await getLinkPageById(id, req);
    if (!page) return sendError(reply, 404, "Not found");
    return sendQrPng(reply, page.publicUrl, page.slug, true);
  }
);

if (CFG.enableDebugRoutes) {
  fastify.get(
    CFG.apiPrefix + "/debug/write-access",
    {
      preHandler: requireAuth,
    },
    async (req) => {
      return {
        ok: true,
        apiVersion: API_VERSION,
        enforceRoles: CFG.enforceRoles,
        allowWriteWithoutRole: CFG.allowWriteWithoutRole,
        requiredRoles: CFG.writeRoles,
        roles: extractRoleTokens(req.cagUser && req.cagUser.roles),
        canWrite: hasWriteRole(req.cagUser),
      };
    }
  );

  fastify.post(
    CFG.apiPrefix + "/debug/write-probe",
    {
      preHandler: [requireAuth, requireWrite],
    },
    async (req, reply) => {
      const b = getRequestPayloadObject(req);
      const idRaw = b.id_product != null ? b.id_product : b.id;
      const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
      if (!id) return sendError(reply, 400, "Missing or invalid id_product");

      let conn = null;
      const startedAt = Date.now();
      try {
        conn = await getConnectionWithTimeout(4000);
        await conn.beginTransaction();

        const [rows] = await queryWithTimeout(
          conn,
          `SELECT id_product, name, last_updated FROM products WHERE id_product = ? LIMIT 1`,
          [id],
          6000
        );
        if (!rows || !rows[0]) {
          await conn.rollback();
          return sendError(reply, 404, "Product not found");
        }

        await queryWithTimeout(conn, `UPDATE products SET last_updated = NOW() WHERE id_product = ?`, [id], 8000);
        await conn.rollback();

        return {
          ok: true,
          id_product: id,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (e) {
        try {
          if (conn) await conn.rollback();
        } catch (_) {
          // ignore rollback failure on broken connection
        }
        const handled = handleDbWriteError(req, reply, e, "debug-write-probe");
        if (handled !== false) return handled;
        throw e;
      } finally {
        if (conn) {
          try {
            conn.release();
          } catch (_) {
            // ignore
          }
        }
      }
    }
  );
}

// ---- Rate limiting manuel pour /auth/login ----
const LOGIN_RATE_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_MAX = 10;
const loginAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if (now > rec.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

function loginRateLimit(req, reply) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + LOGIN_RATE_WINDOW_MS };
    loginAttempts.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > LOGIN_RATE_MAX) {
    const retryAfterSec = Math.ceil((rec.resetAt - now) / 1000);
    reply.header("Retry-After", retryAfterSec);
    return sendError(reply, 429, `Trop de tentatives de connexion. Reessaye dans ${retryAfterSec}s.`);
  }
}

// ---- AUTH ----
fastify.post(CFG.apiPrefix + "/auth/login", async (req, reply) => {
  const blocked = loginRateLimit(req, reply);
  if (blocked !== undefined || reply.sent) return;
  const body = getRequestPayloadObject(req);
  const usernameRaw =
    typeof body.username === "string"
      ? body.username
      : typeof body.user === "string"
        ? body.user
        : typeof body.login === "string"
          ? body.login
          : "";
  const passwordRaw =
    typeof body.password === "string"
      ? body.password
      : typeof body.pass === "string"
        ? body.pass
        : typeof body.pwd === "string"
          ? body.pwd
          : "";
  const username = usernameRaw.trim();
  const password = passwordRaw;
  if (!username || !password) return sendError(reply, 400, "Missing username/password");

  req.log.info({ route: "auth-login", username }, "Login attempt");
  const user = await getUserByUsername(username);
  // Do not reveal if user exists.
  if (!user || String(user.is_active) === "0" || user.archived_at) return sendError(reply, 401, "Invalid credentials");

  const stored = user.password || "";
  const storedHash = HAS_PASSWORD_HASH_COLUMN ? user.password_hash || "" : "";
  let ok = false;
  const candidates = [password];
  const trimmed = password.trim();
  if (trimmed && trimmed !== password) candidates.push(trimmed);
  try {
    if (passwordLooksHashed(storedHash)) {
      for (const c of candidates) {
        if (await bcrypt.compare(c, storedHash)) {
          ok = true;
          break;
        }
      }
    } else if (passwordLooksHashed(stored)) {
      for (const c of candidates) {
        if (await bcrypt.compare(c, stored)) {
          ok = true;
          break;
        }
      }
    } else {
      ok = candidates.some((c) => stored === c);
    }
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
      roles: user.roles,
      is_active: user.is_active,
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

fastify.get(
  CFG.apiPrefix + "/users",
  {
    preHandler: requireAuth,
  },
  async (req) => {
    const archiveMode = isAdminUser(req.cagUser) ? String((req.query && req.query.archived) || "").toLowerCase() : "";
    const where = [];
    if (USER_SCHEMA.has("archived_at")) {
      if (archiveMode === "1" || archiveMode === "true") where.push("archived_at IS NOT NULL");
      else if (archiveMode !== "all") where.push("archived_at IS NULL");
    } else if (archiveMode === "1" || archiveMode === "true") {
      where.push("is_active = 0");
    } else if (archiveMode !== "all") {
      where.push("is_active = 1");
    }
    const [rows] = await pool.query(
      `SELECT id_user, username, roles, is_active, last_login${userArchiveSelectColumns()}
       FROM users
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY username ASC`
    );
    const visibleRows = isAdminUser(req.cagUser)
      ? rows || []
      : isManagerUser(req.cagUser)
        ? (rows || []).filter((u) => isEmployeeUserAccount(u))
        : [];
    return {
      items: visibleRows.map((u) => publicUser(u)),
    };
  }
);

fastify.post(
  CFG.apiPrefix + "/users",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const b = getRequestPayloadObject(req);
    const username = normalizeUsername(b.username);
    const password = typeof b.password === "string" ? b.password : "";
    const roles = normalizeUserRoles(b.roles != null ? b.roles : b.role);
    const isActive = normalizeActiveFlag(b.is_active != null ? b.is_active : b.isActive, true);
    const scopeError = enforceUserManagementScope(req, reply, null, roles);
    if (scopeError) return scopeError;

    if (!username) return sendError(reply, 400, "Missing username");
    if (!/^[a-zA-Z0-9._@-]{3,100}$/.test(username)) {
      return sendError(reply, 400, "Invalid username", {
        hint: "Utilise 3 a 100 caracteres: lettres, chiffres, point, tiret, underscore ou @.",
      });
    }
    if (!password) return sendError(reply, 400, "Missing password");

    let hash;
    try {
      hash = await hashPassword(password);
    } catch (e) {
      return sendError(reply, Number(e.statusCode) || 400, "Password too short", {
        hint: "Le mot de passe doit faire au moins 8 caracteres.",
      });
    }

    const conn = await getConnectionWithTimeout(4000);
    try {
      const cols = ["username", "password", "roles", "last_login", "is_active"];
      const vals = [username, hash, rolesToDbValue(roles), null, isActive];
      if (HAS_PASSWORD_HASH_COLUMN) {
        cols.splice(2, 0, "password_hash");
        vals.splice(2, 0, hash);
      }
      const placeholders = cols.map(() => "?").join(", ");
      const [res] = await queryWithTimeout(
        conn,
        `INSERT INTO users (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${placeholders})`,
        vals,
        8000
      );
      const created = await getUserById(res.insertId);
      reply.code(201).send({ user: publicUser(created), passwordStored: HAS_PASSWORD_HASH_COLUMN ? "password_hash" : "password" });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "create-user");
      if (handled !== false) return handled;
      throw e;
    } finally {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
  }
);

fastify.patch(
  CFG.apiPrefix + "/users/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    const b = getRequestPayloadObject(req);
    const targetUser = await getUserById(id);
    if (!targetUser) return sendError(reply, 404, "Not found");

    const requestedRoles = b.roles !== undefined || b.role !== undefined ? normalizeUserRoles(b.roles != null ? b.roles : b.role) : null;
    const scopeError = enforceUserManagementScope(req, reply, targetUser, requestedRoles);
    if (scopeError) return scopeError;

    const fields = [];
    const values = [];
    function setField(col, value) {
      fields.push(`\`${col}\` = ?`);
      values.push(value);
    }

    if (typeof b.username === "string") {
      const username = normalizeUsername(b.username);
      if (!username) return sendError(reply, 400, "Missing username");
      if (!/^[a-zA-Z0-9._@-]{3,100}$/.test(username)) {
        return sendError(reply, 400, "Invalid username", {
          hint: "Utilise 3 a 100 caracteres: lettres, chiffres, point, tiret, underscore ou @.",
        });
      }
      setField("username", username);
    }
    if (requestedRoles) setField("roles", rolesToDbValue(requestedRoles));
    if (b.is_active !== undefined || b.isActive !== undefined) {
      const nextActive = normalizeActiveFlag(b.is_active !== undefined ? b.is_active : b.isActive, true);
      if (Number(req.cagUser && req.cagUser.id_user) === id && nextActive === 0) {
        return sendError(reply, 400, "Cannot deactivate yourself");
      }
      setField("is_active", nextActive);
    }
    if (typeof b.password === "string" && b.password.length) {
      let hash;
      try {
        hash = await hashPassword(b.password);
      } catch (e) {
        return sendError(reply, Number(e.statusCode) || 400, "Password too short", {
          hint: "Le mot de passe doit faire au moins 8 caracteres.",
        });
      }
      setField("password", hash);
      if (HAS_PASSWORD_HASH_COLUMN) setField("password_hash", hash);
    }

    if (!fields.length) return sendError(reply, 400, "No fields to update");
    values.push(id);

    const conn = await getConnectionWithTimeout(4000);
    try {
      const [res] = await queryWithTimeout(conn, `UPDATE users SET ${fields.join(", ")} WHERE id_user = ?`, values, 8000);
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      const updated = await getUserById(id);
      reply.send({ ok: true, user: publicUser(updated) });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "update-user");
      if (handled !== false) return handled;
      throw e;
    } finally {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
  }
);

fastify.delete(
  CFG.apiPrefix + "/users/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    if (!isAdminUser(req.cagUser)) {
      return sendError(reply, 403, "Forbidden", {
        hint: "Seul un administrateur peut archiver un compte.",
      });
    }
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    if (Number(req.cagUser && req.cagUser.id_user) === id) {
      return sendError(reply, 400, "Cannot archive yourself");
    }

    const targetUser = await getUserById(id);
    if (!targetUser) return sendError(reply, 404, "Not found");
    const b = getRequestPayloadObject(req);
    const reason = sanitizeText(b.reason || "Archive dashboard admin", 255);

    const conn = await getConnectionWithTimeout(4000);
    try {
      const hasArchive = USER_SCHEMA.has("archived_at") && USER_SCHEMA.has("archived_by") && USER_SCHEMA.has("archived_reason");
      const [res] = hasArchive
        ? await queryWithTimeout(
          conn,
          `UPDATE users
           SET is_active = 0,
               archived_at = COALESCE(archived_at, NOW()),
               archived_by = ?,
               archived_reason = ?
           WHERE id_user = ?`,
          [req.cagUser.id_user || null, reason || null, id],
          8000
        )
        : await queryWithTimeout(conn, `UPDATE users SET is_active = 0 WHERE id_user = ?`, [id], 8000);
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      const archived = await getUserById(id);
      reply.send({ ok: true, archived: true, user: publicUser(archived) });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "archive-user");
      if (handled !== false) return handled;
      throw e;
    } finally {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
  }
);

fastify.post(
  CFG.apiPrefix + "/users/:id/restore",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    if (!isAdminUser(req.cagUser)) {
      return sendError(reply, 403, "Forbidden", {
        hint: "Seul un administrateur peut restaurer un compte archive.",
      });
    }
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    const targetUser = await getUserById(id);
    if (!targetUser) return sendError(reply, 404, "Not found");

    const conn = await getConnectionWithTimeout(4000);
    try {
      const hasArchive = USER_SCHEMA.has("archived_at") && USER_SCHEMA.has("archived_by") && USER_SCHEMA.has("archived_reason");
      const [res] = hasArchive
        ? await queryWithTimeout(
          conn,
          `UPDATE users
           SET is_active = 1,
               archived_at = NULL,
               archived_by = NULL,
               archived_reason = NULL
           WHERE id_user = ?`,
          [id],
          8000
        )
        : await queryWithTimeout(conn, `UPDATE users SET is_active = 1 WHERE id_user = ?`, [id], 8000);
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      const restored = await getUserById(id);
      reply.send({ ok: true, restored: true, user: publicUser(restored) });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "restore-user");
      if (handled !== false) return handled;
      throw e;
    } finally {
      try {
        conn.release();
      } catch (_) {
        // ignore
      }
    }
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
    const r = calendarRangeToSql(fromIso, toIso);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");
    const salesLocalExpr = businessLocalDateTimeSql("s.last_updated");
    const salesRangeWhere = `${salesLocalExpr} >= ? AND ${salesLocalExpr} < ?`;
    const summaryDateExpr = `DATE(${salesLocalExpr})`;
    const hourOrderExpr = `HOUR(${salesLocalExpr})`;

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
           ${summaryDateExpr} AS date,
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
         GROUP BY ${summaryDateExpr}
         ORDER BY ${summaryDateExpr} ASC`,
        [r.from, r.toExcl, category]
      );
      seriesRows = series || [];

      const [hourRows] = await pool.query(
        `SELECT
           HOUR(${salesLocalExpr}) AS hour,
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
           COUNT(DISTINCT s.id_sale) AS salesCount
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
         GROUP BY HOUR(${salesLocalExpr})
         ORDER BY ${hourOrderExpr} ASC`,
        [r.from, r.toExcl, category]
      );
      byHourRows = hourRows || [];

      const [weekdayRows] = await pool.query(
        `SELECT
           WEEKDAY(${summaryDateExpr}) AS weekday,
           COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue,
           COUNT(DISTINCT s.id_sale) AS salesCount
         FROM sales_details sd
         JOIN sales s ON s.id_sale = sd.sale_id
         JOIN products p ON p.id_product = sd.product_id
         WHERE ${salesRangeWhere}
           AND p.productType = ?
         GROUP BY WEEKDAY(${summaryDateExpr})
         ORDER BY WEEKDAY(${summaryDateExpr}) ASC`,
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
           ${summaryDateExpr} AS date,
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount,
           COALESCE(AVG(s.total_amount), 0) AS avgTicket
         FROM sales s
         WHERE ${salesRangeWhere}
         GROUP BY ${summaryDateExpr}
         ORDER BY ${summaryDateExpr} ASC`,
        [r.from, r.toExcl]
      );
      seriesRows = series || [];

      const [hourRows] = await pool.query(
        `SELECT
           HOUR(${salesLocalExpr}) AS hour,
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount
         FROM sales s
         WHERE ${salesRangeWhere}
         GROUP BY HOUR(${salesLocalExpr})
         ORDER BY ${hourOrderExpr} ASC`,
        [r.from, r.toExcl]
      );
      byHourRows = hourRows || [];

      const [weekdayRows] = await pool.query(
        `SELECT
           WEEKDAY(${summaryDateExpr}) AS weekday,
           COALESCE(SUM(s.total_amount), 0) AS revenue,
           COUNT(*) AS salesCount
         FROM sales s
         WHERE ${salesRangeWhere}
         GROUP BY WEEKDAY(${summaryDateExpr})
         ORDER BY WEEKDAY(${summaryDateExpr}) ASC`,
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
        summaryMode: "calendar-day",
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
    const r = calendarRangeToSql(fromIso, toIso);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");

    const q = (req.query && typeof req.query.q === "string" ? req.query.q.trim() : "") || "";
    const limit = clampInt(req.query && req.query.limit, 1, 100, 20);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";
    const qNum = /^\d+$/.test(q) ? Number(q) : -1;
    const salesLocalExpr = businessLocalDateTimeSql("s.last_updated");
    const salesRangeWhere = `${salesLocalExpr} >= ? AND ${salesLocalExpr} < ?`;

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
           ${salesLocalExpr} AS last_updated,
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
         GROUP BY s.id_sale, s.notes, s.user_id, u.username, ${salesLocalExpr}
         ORDER BY ${salesLocalExpr} DESC
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
           ${salesLocalExpr} AS last_updated,
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
         ORDER BY ${salesLocalExpr} DESC
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
         ${businessLocalDateTimeSql("s.last_updated")} AS last_updated
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

// ---- PURCHASES / EXPENSES ----
const PURCHASE_CATEGORIES = [
  { value: "stock_alimentaire", label: "Alimentaire / stock" },
  { value: "materiel", label: "Materiel" },
  { value: "loyer", label: "Loyer" },
  { value: "service", label: "Services" },
  { value: "investissement_depart", label: "Investissement de depart" },
  { value: "maintenance", label: "Maintenance" },
  { value: "marketing", label: "Marketing" },
  { value: "autre", label: "Autre" },
];

function dateOnlyFromMysql(v) {
  if (!v) return "";
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

function boolInt(v, fallback) {
  if (v === undefined) return fallback ? 1 : 0;
  if (v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "yes") return 1;
  if (v === false || v === 0 || v === "0" || String(v).toLowerCase() === "false" || String(v).toLowerCase() === "no") return 0;
  return fallback ? 1 : 0;
}

function nullablePositiveNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function nullablePositiveInt(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

function purchaseFromPayload(raw, existing) {
  const b = raw || {};
  const fallbackDate = existing ? dateOnlyFromMysql(existing.purchase_date) : new Date().toISOString().slice(0, 10);
  const date = sqlDateOnly(b.purchaseDate || b.purchase_date) || fallbackDate;
  const category = normalizePurchaseCategory(b.category != null ? b.category : existing && existing.category);
  const label =
    typeof b.label === "string"
      ? b.label.trim()
      : typeof b.name === "string"
        ? b.name.trim()
        : existing
          ? existing.label
          : "";
  const amountRaw = b.amount !== undefined ? b.amount : existing ? existing.amount : undefined;
  const amount = nullablePositiveNumber(amountRaw);
  const quantity = b.quantity !== undefined ? nullablePositiveNumber(b.quantity) : existing ? existing.quantity : null;
  const stockQuantity =
    b.stockQuantity !== undefined
      ? nullablePositiveNumber(b.stockQuantity)
      : b.stock_quantity !== undefined
        ? nullablePositiveNumber(b.stock_quantity)
        : existing
          ? existing.stock_quantity
          : null;
  const productId =
    b.productId !== undefined
      ? nullablePositiveInt(b.productId)
      : b.product_id !== undefined
        ? nullablePositiveInt(b.product_id)
        : existing
          ? existing.product_id
          : null;
  const assignedUserId =
    b.assignedUserId !== undefined
      ? nullablePositiveInt(b.assignedUserId)
      : b.assigned_user_id !== undefined
        ? nullablePositiveInt(b.assigned_user_id)
        : existing
          ? existing.assigned_user_id
          : null;

  if (!label) {
    const e = new Error("Missing purchase label");
    e.statusCode = 400;
    throw e;
  }
  if (!Number.isFinite(amount)) {
    const e = new Error("Invalid purchase amount");
    e.statusCode = 400;
    throw e;
  }
  if (Number.isNaN(quantity)) {
    const e = new Error("Invalid purchase quantity");
    e.statusCode = 400;
    throw e;
  }
  if (Number.isNaN(stockQuantity)) {
    const e = new Error("Invalid stock quantity");
    e.statusCode = 400;
    throw e;
  }
  if (Number.isNaN(productId)) {
    const e = new Error("Invalid product id");
    e.statusCode = 400;
    throw e;
  }
  if (Number.isNaN(assignedUserId)) {
    const e = new Error("Invalid assigned user id");
    e.statusCode = 400;
    throw e;
  }

  return {
    purchaseDateSql: `${date} 12:00:00`,
    purchaseDate: date,
    category,
    label: label.slice(0, 180),
    amount: round2(amount),
    quantity,
    unit:
      typeof b.unit === "string"
        ? b.unit.trim().slice(0, 40)
        : existing && existing.unit
          ? String(existing.unit).slice(0, 40)
          : "",
    supplier:
      typeof b.supplier === "string"
        ? b.supplier.trim().slice(0, 160)
        : existing && existing.supplier
          ? String(existing.supplier).slice(0, 160)
          : "",
    paymentMethod:
      typeof b.paymentMethod === "string"
        ? b.paymentMethod.trim().slice(0, 40)
        : typeof b.payment_method === "string"
          ? b.payment_method.trim().slice(0, 40)
          : existing && existing.payment_method
            ? String(existing.payment_method).slice(0, 40)
            : "",
    productId,
    stockQuantity,
    applyStock: boolInt(
      b.applyStock !== undefined ? b.applyStock : b.apply_stock !== undefined ? b.apply_stock : undefined,
      existing ? Number(existing.apply_stock) === 1 : false
    ),
    assignedUserId,
    isStartupInvestment: boolInt(
      b.isStartupInvestment !== undefined
        ? b.isStartupInvestment
        : b.is_startup_investment !== undefined
          ? b.is_startup_investment
          : undefined,
      existing ? Number(existing.is_startup_investment) === 1 : category === "investissement_depart"
    ),
    notes:
      typeof b.notes === "string"
        ? b.notes.slice(0, 2000)
        : existing && existing.notes
          ? String(existing.notes).slice(0, 2000)
          : "",
  };
}

function serializePurchase(row) {
  if (!row) return null;
  return {
    id_purchase: Number(row.id_purchase),
    purchaseDate: dateOnlyFromMysql(row.purchase_date),
    purchase_date: row.purchase_date,
    category: row.category || "autre",
    categoryLabel: publicPurchaseCategoryLabel(row.category),
    label: row.label || "",
    amount: Number(row.amount || 0),
    quantity: row.quantity == null ? null : Number(row.quantity),
    unit: row.unit || "",
    supplier: row.supplier || "",
    paymentMethod: row.payment_method || "",
    productId: row.product_id == null ? null : Number(row.product_id),
    productName: row.product_name || "",
    stockQuantity: row.stock_quantity == null ? null : Number(row.stock_quantity),
    applyStock: Number(row.apply_stock) === 1,
    assignedUserId: row.assigned_user_id == null ? null : Number(row.assigned_user_id),
    assignedUsername: row.assigned_username || "",
    isStartupInvestment: Number(row.is_startup_investment) === 1,
    notes: row.notes || "",
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getPurchaseById(conn, id) {
  await ensurePurchasesTable(conn);
  const [rows] = await conn.query(
    `SELECT
       cp.*,
       p.name AS product_name,
       au.username AS assigned_username,
       cu.username AS created_by_username
     FROM cag_purchases cp
     LEFT JOIN products p ON p.id_product = cp.product_id
     LEFT JOIN users au ON au.id_user = cp.assigned_user_id
     LEFT JOIN users cu ON cu.id_user = cp.created_by
     WHERE cp.id_purchase = ?
     LIMIT 1`,
    [id]
  );
  return rows && rows[0] ? rows[0] : null;
}

async function applyPurchaseStockDelta(conn, purchase, sign) {
  if (!purchase || Number(purchase.apply_stock) !== 1) return;
  const productId = Number(purchase.product_id);
  const quantity = Number(purchase.stock_quantity);
  if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;
  await queryWithTimeout(
    conn,
    `UPDATE products
     SET quantity = COALESCE(quantity, 0) + ?, last_updated = NOW(), is_synced = 0
     WHERE id_product = ?`,
    [round2(quantity * Number(sign || 1)), productId],
    8000
  );
}

fastify.get(
  CFG.apiPrefix + "/purchases/categories",
  {
    preHandler: requireAuth,
  },
  async () => ({ items: PURCHASE_CATEGORIES })
);

fastify.get(
  CFG.apiPrefix + "/purchases/summary",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    await ensurePurchasesTable(pool);
    const r = calendarRangeToSql(req.query && req.query.from, req.query && req.query.to);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");
    const category = normalizePurchaseCategory(req.query && req.query.category);
    const hasCategory = Boolean(req.query && req.query.category);
    const localExpr = businessLocalDateTimeSql("cp.purchase_date");
    const where = `${localExpr} >= ? AND ${localExpr} < ? AND (? = 0 OR cp.category = ?)`;

    const [totalRows] = await pool.query(
      `SELECT
         COALESCE(SUM(cp.amount), 0) AS total,
         COUNT(*) AS count
       FROM cag_purchases cp
       WHERE ${where}`,
      [r.from, r.toExcl, hasCategory ? 1 : 0, category]
    );

    const [categoryRows] = await pool.query(
      `SELECT
         cp.category,
         COALESCE(SUM(cp.amount), 0) AS amount,
         COUNT(*) AS count
       FROM cag_purchases cp
       WHERE ${where}
       GROUP BY cp.category
       ORDER BY amount DESC`,
      [r.from, r.toExcl, hasCategory ? 1 : 0, category]
    );

    return {
      total: Number(totalRows && totalRows[0] ? totalRows[0].total : 0),
      count: Number(totalRows && totalRows[0] ? totalRows[0].count : 0),
      byCategory: (categoryRows || []).map((x) => ({
        category: x.category || "autre",
        categoryLabel: publicPurchaseCategoryLabel(x.category),
        amount: Number(x.amount || 0),
        count: Number(x.count || 0),
      })),
    };
  }
);

fastify.get(
  CFG.apiPrefix + "/purchases",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    await ensurePurchasesTable(pool);
    const r = calendarRangeToSql(req.query && req.query.from, req.query && req.query.to);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");
    const q = (req.query && typeof req.query.q === "string" ? req.query.q.trim() : "") || "";
    const category = normalizePurchaseCategory(req.query && req.query.category);
    const hasCategory = Boolean(req.query && req.query.category);
    const limit = clampInt(req.query && req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";
    const localExpr = businessLocalDateTimeSql("cp.purchase_date");
    const where = `${localExpr} >= ? AND ${localExpr} < ?
      AND (? = 0 OR cp.category = ?)
      AND (? = '' OR cp.label LIKE ? OR cp.supplier LIKE ? OR cp.notes LIKE ? OR p.name LIKE ? OR au.username LIKE ?)`;

    const params = [r.from, r.toExcl, hasCategory ? 1 : 0, category, q, like, like, like, like, like];
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM cag_purchases cp
       LEFT JOIN products p ON p.id_product = cp.product_id
       LEFT JOIN users au ON au.id_user = cp.assigned_user_id
       WHERE ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT
         cp.*,
         p.name AS product_name,
         au.username AS assigned_username,
         cu.username AS created_by_username
       FROM cag_purchases cp
       LEFT JOIN products p ON p.id_product = cp.product_id
       LEFT JOIN users au ON au.id_user = cp.assigned_user_id
       LEFT JOIN users cu ON cu.id_user = cp.created_by
       WHERE ${where}
       ORDER BY cp.purchase_date DESC, cp.id_purchase DESC
       LIMIT ? OFFSET ?`,
      params.concat([limit, offset])
    );

    return {
      total: Number(totalRows && totalRows[0] ? totalRows[0].total : 0),
      items: (rows || []).map(serializePurchase),
    };
  }
);

const createPurchaseHandler = async (req, reply) => {
  const payload = purchaseFromPayload(getRequestPayloadObject(req), null);
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(4000);
    await ensurePurchasesTable(conn);
    await conn.beginTransaction();
    const [res] = await queryWithTimeout(
      conn,
      `INSERT INTO cag_purchases
       (purchase_date, category, label, amount, quantity, unit, supplier, payment_method, product_id,
        stock_quantity, apply_stock, assigned_user_id, is_startup_investment, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.purchaseDateSql,
        payload.category,
        payload.label,
        payload.amount,
        payload.quantity,
        payload.unit,
        payload.supplier,
        payload.paymentMethod,
        payload.productId,
        payload.stockQuantity,
        payload.applyStock,
        payload.assignedUserId,
        payload.isStartupInvestment,
        payload.notes,
        req.cagUser && req.cagUser.id_user ? req.cagUser.id_user : null,
      ],
      8000
    );
    const created = {
      product_id: payload.productId,
      stock_quantity: payload.stockQuantity,
      apply_stock: payload.applyStock,
    };
    await applyPurchaseStockDelta(conn, created, 1);
    await conn.commit();
    const row = await getPurchaseById(conn, res.insertId);
    reply.code(201).send({ purchase: serializePurchase(row) });
  } catch (e) {
    try {
      if (conn) await conn.rollback();
    } catch (_) {
      // ignore
    }
    const handled = handleDbWriteError(req, reply, e, "create-purchase");
    if (handled !== false) return handled;
    throw e;
  } finally {
    if (conn) conn.release();
  }
};

fastify.post(
  CFG.apiPrefix + "/purchases",
  {
    preHandler: [requireAuth, requireWrite],
  },
  createPurchaseHandler
);

fastify.get(
  CFG.apiPrefix + "/purchases/create-q",
  {
    preHandler: [requireAuth, requireWrite],
  },
  createPurchaseHandler
);

const updatePurchaseHandler = async (req, reply) => {
  const idRaw = req.params && req.params.id;
  const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
  if (!id) return sendError(reply, 400, "Invalid id");
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(4000);
    await ensurePurchasesTable(conn);
    await conn.beginTransaction();
    const existing = await getPurchaseById(conn, id);
    if (!existing) {
      await conn.rollback();
      return sendError(reply, 404, "Not found");
    }
    const payload = purchaseFromPayload(getRequestPayloadObject(req), existing);
    await applyPurchaseStockDelta(conn, existing, -1);
    const [res] = await queryWithTimeout(
      conn,
      `UPDATE cag_purchases
       SET purchase_date = ?,
           category = ?,
           label = ?,
           amount = ?,
           quantity = ?,
           unit = ?,
           supplier = ?,
           payment_method = ?,
           product_id = ?,
           stock_quantity = ?,
           apply_stock = ?,
           assigned_user_id = ?,
           is_startup_investment = ?,
           notes = ?
       WHERE id_purchase = ?`,
      [
        payload.purchaseDateSql,
        payload.category,
        payload.label,
        payload.amount,
        payload.quantity,
        payload.unit,
        payload.supplier,
        payload.paymentMethod,
        payload.productId,
        payload.stockQuantity,
        payload.applyStock,
        payload.assignedUserId,
        payload.isStartupInvestment,
        payload.notes,
        id,
      ],
      8000
    );
    if (!res.affectedRows) {
      await conn.rollback();
      return sendError(reply, 404, "Not found");
    }
    await applyPurchaseStockDelta(
      conn,
      { product_id: payload.productId, stock_quantity: payload.stockQuantity, apply_stock: payload.applyStock },
      1
    );
    await conn.commit();
    const row = await getPurchaseById(conn, id);
    reply.send({ purchase: serializePurchase(row) });
  } catch (e) {
    try {
      if (conn) await conn.rollback();
    } catch (_) {
      // ignore
    }
    const handled = handleDbWriteError(req, reply, e, "update-purchase");
    if (handled !== false) return handled;
    throw e;
  } finally {
    if (conn) conn.release();
  }
};

fastify.patch(
  CFG.apiPrefix + "/purchases/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updatePurchaseHandler
);

fastify.put(
  CFG.apiPrefix + "/purchases/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updatePurchaseHandler
);

fastify.post(
  CFG.apiPrefix + "/purchases/:id/update",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updatePurchaseHandler
);

fastify.get(
  CFG.apiPrefix + "/purchases/:id/update-q",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updatePurchaseHandler
);

fastify.delete(
  CFG.apiPrefix + "/purchases/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    let conn = null;
    try {
      conn = await getConnectionWithTimeout(4000);
      await ensurePurchasesTable(conn);
      await conn.beginTransaction();
      const existing = await getPurchaseById(conn, id);
      if (!existing) {
        await conn.rollback();
        return sendError(reply, 404, "Not found");
      }
      await applyPurchaseStockDelta(conn, existing, -1);
      await queryWithTimeout(conn, `DELETE FROM cag_purchases WHERE id_purchase = ?`, [id], 8000);
      await conn.commit();
      reply.send({ ok: true });
    } catch (e) {
      try {
        if (conn) await conn.rollback();
      } catch (_) {
        // ignore
      }
      const handled = handleDbWriteError(req, reply, e, "delete-purchase");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) conn.release();
    }
  }
);

// ---- BOXING MACHINES ----
const BOXING_MACHINE_STATUSES = [
  { value: "active", label: "Active" },
  { value: "maintenance", label: "Maintenance" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archivee" },
];

const BOXING_ENTRY_CATEGORIES = [
  { value: "collecte_cash", label: "Collecte cash", type: "revenue" },
  { value: "partenaire", label: "Partenaire / reversement", type: "revenue" },
  { value: "evenement", label: "Evenement", type: "revenue" },
  { value: "autre_revenu", label: "Autre revenu", type: "revenue" },
  { value: "achat_machine", label: "Achat machine", type: "expense" },
  { value: "transport", label: "Transport / installation", type: "expense" },
  { value: "maintenance", label: "Maintenance", type: "expense" },
  { value: "piece", label: "Pieces / consommables", type: "expense" },
  { value: "emplacement", label: "Emplacement / loyer", type: "expense" },
  { value: "commission", label: "Commission partenaire", type: "expense" },
  { value: "autre_frais", label: "Autre frais", type: "expense" },
];

function normalizeBoxingStatus(v) {
  const raw = sanitizeText(v, 40).toLowerCase();
  return BOXING_MACHINE_STATUSES.some((s) => s.value === raw) ? raw : "active";
}

function normalizeBoxingEntryType(v) {
  const raw = sanitizeText(v, 20).toLowerCase();
  return raw === "expense" || raw === "frais" || raw === "depense" ? "expense" : "revenue";
}

function normalizeBoxingEntryCategory(v, type) {
  const raw = sanitizeText(v, 80).toLowerCase();
  const mapped = {
    cash: "collecte_cash",
    collecte: "collecte_cash",
    recette: "collecte_cash",
    revenu: "autre_revenu",
    frais: "autre_frais",
    depense: "autre_frais",
    "dépense": "autre_frais",
    materiel: "piece",
    "matériel": "piece",
  }[raw] || raw;
  const found = BOXING_ENTRY_CATEGORIES.find((c) => c.value === mapped);
  if (found) return found.value;
  return normalizeBoxingEntryType(type) === "expense" ? "autre_frais" : "autre_revenu";
}

function boxingCategoryLabel(category) {
  const found = BOXING_ENTRY_CATEGORIES.find((c) => c.value === category);
  return found ? found.label : category || "Autre";
}

async function ensureBoxingTables(connOrPool) {
  if (BOXING_TABLES_READY) return;
  const db = connOrPool || pool;
  await db.query(
    `CREATE TABLE IF NOT EXISTS cag_boxing_machines (
      id_machine BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      serial_number VARCHAR(120) NULL,
      location_name VARCHAR(180) NOT NULL,
      location_address VARCHAR(255) NULL,
      placement_type VARCHAR(80) NOT NULL DEFAULT 'depot',
      owner_contact VARCHAR(160) NULL,
      purchase_price DECIMAL(12,2) NOT NULL DEFAULT 0,
      install_date DATE NULL,
      revenue_share_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      target_daily_revenue DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'active',
      notes TEXT NULL,
      created_by BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id_machine),
      KEY idx_cag_boxing_status (status),
      KEY idx_cag_boxing_location (location_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS cag_boxing_entries (
      id_entry BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      machine_id BIGINT UNSIGNED NOT NULL,
      entry_date DATETIME NOT NULL,
      entry_type VARCHAR(20) NOT NULL DEFAULT 'revenue',
      category VARCHAR(80) NOT NULL DEFAULT 'autre_revenu',
      label VARCHAR(180) NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(60) NULL,
      notes TEXT NULL,
      created_by BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id_entry),
      KEY idx_cag_boxing_entries_machine_date (machine_id, entry_date),
      KEY idx_cag_boxing_entries_type (entry_type),
      KEY idx_cag_boxing_entries_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  BOXING_TABLES_READY = true;
}

function boxingMoneyValue(raw, fallback, fieldName) {
  const value = raw === undefined ? fallback : raw;
  const n = nullablePositiveNumber(value);
  if (Number.isNaN(n)) {
    const e = new Error(`Invalid ${fieldName}`);
    e.statusCode = 400;
    throw e;
  }
  return n == null ? 0 : round2(n);
}

function boxingMachineFromPayload(raw, existing) {
  const b = raw || {};
  const name = sanitizeText(b.name !== undefined ? b.name : existing && existing.name, 160);
  const locationName = sanitizeText(
    b.locationName !== undefined ? b.locationName : b.location_name !== undefined ? b.location_name : existing && existing.location_name,
    180
  );
  if (!name) {
    const e = new Error("Missing machine name");
    e.statusCode = 400;
    throw e;
  }
  if (!locationName) {
    const e = new Error("Missing location name");
    e.statusCode = 400;
    throw e;
  }
  const installDate = sqlDateOnly(
    b.installDate !== undefined ? b.installDate : b.install_date !== undefined ? b.install_date : existing && dateOnlyFromMysql(existing.install_date)
  );
  const share = Math.min(
    100,
    boxingMoneyValue(
      b.revenueSharePercent !== undefined
        ? b.revenueSharePercent
        : b.revenue_share_percent !== undefined
          ? b.revenue_share_percent
          : existing && existing.revenue_share_percent,
      0,
      "revenue share"
    )
  );
  return {
    name,
    serialNumber: sanitizeText(
      b.serialNumber !== undefined ? b.serialNumber : b.serial_number !== undefined ? b.serial_number : existing && existing.serial_number,
      120
    ),
    locationName,
    locationAddress: sanitizeText(
      b.locationAddress !== undefined ? b.locationAddress : b.location_address !== undefined ? b.location_address : existing && existing.location_address,
      255
    ),
    placementType: sanitizeText(
      b.placementType !== undefined ? b.placementType : b.placement_type !== undefined ? b.placement_type : existing && existing.placement_type,
      80
    ) || "depot",
    ownerContact: sanitizeText(
      b.ownerContact !== undefined ? b.ownerContact : b.owner_contact !== undefined ? b.owner_contact : existing && existing.owner_contact,
      160
    ),
    purchasePrice: boxingMoneyValue(
      b.purchasePrice !== undefined ? b.purchasePrice : b.purchase_price !== undefined ? b.purchase_price : existing && existing.purchase_price,
      0,
      "purchase price"
    ),
    installDate,
    revenueSharePercent: share,
    targetDailyRevenue: boxingMoneyValue(
      b.targetDailyRevenue !== undefined
        ? b.targetDailyRevenue
        : b.target_daily_revenue !== undefined
          ? b.target_daily_revenue
          : existing && existing.target_daily_revenue,
      0,
      "target daily revenue"
    ),
    status: normalizeBoxingStatus(b.status !== undefined ? b.status : existing && existing.status),
    notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : existing && existing.notes ? String(existing.notes).slice(0, 2000) : "",
  };
}

function boxingEntryFromPayload(raw, existing) {
  const b = raw || {};
  const machineId =
    b.machineId !== undefined
      ? nullablePositiveInt(b.machineId)
      : b.machine_id !== undefined
        ? nullablePositiveInt(b.machine_id)
        : existing
          ? Number(existing.machine_id)
          : NaN;
  if (Number.isNaN(machineId) || !machineId) {
    const e = new Error("Invalid machine id");
    e.statusCode = 400;
    throw e;
  }
  const date = sqlDateOnly(
    b.entryDate !== undefined ? b.entryDate : b.entry_date !== undefined ? b.entry_date : existing && dateOnlyFromMysql(existing.entry_date)
  ) || new Date().toISOString().slice(0, 10);
  const type = normalizeBoxingEntryType(b.type !== undefined ? b.type : b.entryType !== undefined ? b.entryType : existing && existing.entry_type);
  const category = normalizeBoxingEntryCategory(b.category !== undefined ? b.category : existing && existing.category, type);
  const label = sanitizeText(b.label !== undefined ? b.label : existing && existing.label, 180);
  const amount = boxingMoneyValue(b.amount !== undefined ? b.amount : existing && existing.amount, NaN, "amount");
  if (!label) {
    const e = new Error("Missing entry label");
    e.statusCode = 400;
    throw e;
  }
  if (amount <= 0) {
    const e = new Error("Amount must be greater than zero");
    e.statusCode = 400;
    throw e;
  }
  return {
    machineId,
    entryDateSql: `${date} 12:00:00`,
    entryDate: date,
    type,
    category,
    label,
    amount,
    paymentMethod: sanitizeText(
      b.paymentMethod !== undefined ? b.paymentMethod : b.payment_method !== undefined ? b.payment_method : existing && existing.payment_method,
      60
    ),
    notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : existing && existing.notes ? String(existing.notes).slice(0, 2000) : "",
  };
}

function serializeBoxingMachine(row) {
  if (!row) return null;
  const revenue = Number(row.revenue || 0);
  const expenses = Number(row.expenses || 0);
  const net = revenue - expenses;
  const investment = Number(row.purchase_price || 0);
  return {
    id_machine: Number(row.id_machine),
    id: Number(row.id_machine),
    name: row.name || "",
    serialNumber: row.serial_number || "",
    locationName: row.location_name || "",
    locationAddress: row.location_address || "",
    placementType: row.placement_type || "depot",
    ownerContact: row.owner_contact || "",
    purchasePrice: investment,
    installDate: dateOnlyFromMysql(row.install_date),
    revenueSharePercent: Number(row.revenue_share_percent || 0),
    targetDailyRevenue: Number(row.target_daily_revenue || 0),
    status: row.status || "active",
    notes: row.notes || "",
    revenue,
    expenses,
    net,
    roiPercent: investment > 0 ? round2((net / investment) * 100) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeBoxingEntry(row) {
  if (!row) return null;
  return {
    id_entry: Number(row.id_entry),
    id: Number(row.id_entry),
    machineId: Number(row.machine_id),
    machineName: row.machine_name || "",
    locationName: row.location_name || "",
    entryDate: dateOnlyFromMysql(row.entry_date),
    entry_date: row.entry_date,
    type: row.entry_type || "revenue",
    category: row.category || "",
    categoryLabel: boxingCategoryLabel(row.category),
    label: row.label || "",
    amount: Number(row.amount || 0),
    paymentMethod: row.payment_method || "",
    notes: row.notes || "",
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getBoxingMachineById(conn, id) {
  await ensureBoxingTables(conn);
  const [rows] = await conn.query(`SELECT * FROM cag_boxing_machines WHERE id_machine = ? LIMIT 1`, [id]);
  return rows && rows[0] ? rows[0] : null;
}

async function getBoxingEntryById(conn, id) {
  await ensureBoxingTables(conn);
  const [rows] = await conn.query(
    `SELECT be.*, bm.name AS machine_name, bm.location_name, u.username AS created_by_username
     FROM cag_boxing_entries be
     LEFT JOIN cag_boxing_machines bm ON bm.id_machine = be.machine_id
     LEFT JOIN users u ON u.id_user = be.created_by
     WHERE be.id_entry = ?
     LIMIT 1`,
    [id]
  );
  return rows && rows[0] ? rows[0] : null;
}

fastify.get(
  CFG.apiPrefix + "/boxing/categories",
  { preHandler: requireAuth },
  async () => ({
    statuses: BOXING_MACHINE_STATUSES,
    categories: BOXING_ENTRY_CATEGORIES,
  })
);

fastify.get(
  CFG.apiPrefix + "/boxing/machines",
  { preHandler: requireAuth },
  async (req) => {
    await ensureBoxingTables(pool);
    const includeArchived = String((req.query && req.query.archived) || "") === "1";
    const [rows] = await pool.query(
      `SELECT bm.*,
         COALESCE(agg.revenue, 0) AS revenue,
         COALESCE(agg.expenses, 0) AS expenses
       FROM cag_boxing_machines bm
       LEFT JOIN (
         SELECT machine_id,
           COALESCE(SUM(CASE WHEN entry_type = 'revenue' THEN amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN entry_type = 'expense' THEN amount ELSE 0 END), 0) AS expenses
         FROM cag_boxing_entries
         GROUP BY machine_id
       ) agg ON agg.machine_id = bm.id_machine
       WHERE (? = 1 OR bm.status <> 'archived')
       ORDER BY FIELD(bm.status, 'active', 'maintenance', 'inactive', 'archived'), bm.name ASC`,
      [includeArchived ? 1 : 0]
    );
    return { items: (rows || []).map(serializeBoxingMachine) };
  }
);

const createBoxingMachineHandler = async (req, reply) => {
  const payload = boxingMachineFromPayload(getRequestPayloadObject(req), null);
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(4000);
    await ensureBoxingTables(conn);
    const [res] = await queryWithTimeout(
      conn,
      `INSERT INTO cag_boxing_machines
       (name, serial_number, location_name, location_address, placement_type, owner_contact, purchase_price,
        install_date, revenue_share_percent, target_daily_revenue, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name,
        payload.serialNumber,
        payload.locationName,
        payload.locationAddress,
        payload.placementType,
        payload.ownerContact,
        payload.purchasePrice,
        payload.installDate,
        payload.revenueSharePercent,
        payload.targetDailyRevenue,
        payload.status,
        payload.notes,
        req.cagUser && req.cagUser.id_user ? req.cagUser.id_user : null,
      ],
      8000
    );
    const row = await getBoxingMachineById(conn, res.insertId);
    reply.code(201).send({ machine: serializeBoxingMachine(row) });
  } catch (e) {
    const handled = handleDbWriteError(req, reply, e, "create-boxing-machine");
    if (handled !== false) return handled;
    throw e;
  } finally {
    if (conn) conn.release();
  }
};

fastify.post(CFG.apiPrefix + "/boxing/machines", { preHandler: [requireAuth, requireWrite] }, createBoxingMachineHandler);
fastify.get(CFG.apiPrefix + "/boxing/machines/create-q", { preHandler: [requireAuth, requireWrite] }, createBoxingMachineHandler);

const updateBoxingMachineHandler = async (req, reply) => {
  const idRaw = req.params && req.params.id;
  const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
  if (!id) return sendError(reply, 400, "Invalid id");
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(4000);
    await ensureBoxingTables(conn);
    const existing = await getBoxingMachineById(conn, id);
    if (!existing) return sendError(reply, 404, "Not found");
    const payload = boxingMachineFromPayload(getRequestPayloadObject(req), existing);
    const [res] = await queryWithTimeout(
      conn,
      `UPDATE cag_boxing_machines
       SET name = ?, serial_number = ?, location_name = ?, location_address = ?, placement_type = ?,
           owner_contact = ?, purchase_price = ?, install_date = ?, revenue_share_percent = ?,
           target_daily_revenue = ?, status = ?, notes = ?
       WHERE id_machine = ?`,
      [
        payload.name,
        payload.serialNumber,
        payload.locationName,
        payload.locationAddress,
        payload.placementType,
        payload.ownerContact,
        payload.purchasePrice,
        payload.installDate,
        payload.revenueSharePercent,
        payload.targetDailyRevenue,
        payload.status,
        payload.notes,
        id,
      ],
      8000
    );
    if (!res.affectedRows) return sendError(reply, 404, "Not found");
    const row = await getBoxingMachineById(conn, id);
    reply.send({ machine: serializeBoxingMachine(row) });
  } catch (e) {
    const handled = handleDbWriteError(req, reply, e, "update-boxing-machine");
    if (handled !== false) return handled;
    throw e;
  } finally {
    if (conn) conn.release();
  }
};

fastify.patch(CFG.apiPrefix + "/boxing/machines/:id", { preHandler: [requireAuth, requireWrite] }, updateBoxingMachineHandler);
fastify.put(CFG.apiPrefix + "/boxing/machines/:id", { preHandler: [requireAuth, requireWrite] }, updateBoxingMachineHandler);
fastify.post(CFG.apiPrefix + "/boxing/machines/:id/update", { preHandler: [requireAuth, requireWrite] }, updateBoxingMachineHandler);
fastify.get(CFG.apiPrefix + "/boxing/machines/:id/update-q", { preHandler: [requireAuth, requireWrite] }, updateBoxingMachineHandler);

fastify.delete(
  CFG.apiPrefix + "/boxing/machines/:id",
  { preHandler: [requireAuth, requireWrite] },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    await ensureBoxingTables(pool);
    const [res] = await pool.query(`UPDATE cag_boxing_machines SET status = 'archived' WHERE id_machine = ?`, [id]);
    if (!res.affectedRows) return sendError(reply, 404, "Not found");
    reply.send({ ok: true });
  }
);

fastify.get(
  CFG.apiPrefix + "/boxing/entries",
  { preHandler: requireAuth },
  async (req, reply) => {
    await ensureBoxingTables(pool);
    const r = calendarRangeToSql(req.query && req.query.from, req.query && req.query.to);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");
    const machineId = nullablePositiveInt(req.query && req.query.machineId);
    if (Number.isNaN(machineId)) return sendError(reply, 400, "Invalid machineId");
    const typeRaw = sanitizeText(req.query && req.query.type, 20);
    const type = typeRaw ? normalizeBoxingEntryType(typeRaw) : "";
    const q = sanitizeText(req.query && req.query.q, 120);
    const limit = clampInt(req.query && req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";
    const where = `be.entry_date >= ? AND be.entry_date < ?
      AND (? IS NULL OR be.machine_id = ?)
      AND (? = '' OR be.entry_type = ?)
      AND (? = '' OR be.label LIKE ? OR be.notes LIKE ? OR bm.name LIKE ? OR bm.location_name LIKE ?)`;
    const params = [r.from, r.toExcl, machineId, machineId, type, type, q, like, like, like, like];
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM cag_boxing_entries be
       LEFT JOIN cag_boxing_machines bm ON bm.id_machine = be.machine_id
       WHERE ${where}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT be.*, bm.name AS machine_name, bm.location_name, u.username AS created_by_username
       FROM cag_boxing_entries be
       LEFT JOIN cag_boxing_machines bm ON bm.id_machine = be.machine_id
       LEFT JOIN users u ON u.id_user = be.created_by
       WHERE ${where}
       ORDER BY be.entry_date DESC, be.id_entry DESC
       LIMIT ? OFFSET ?`,
      params.concat([limit, offset])
    );
    return {
      total: Number(totalRows && totalRows[0] ? totalRows[0].total : 0),
      items: (rows || []).map(serializeBoxingEntry),
    };
  }
);

const createBoxingEntryHandler = async (req, reply) => {
  const payload = boxingEntryFromPayload(getRequestPayloadObject(req), null);
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(4000);
    await ensureBoxingTables(conn);
    const machine = await getBoxingMachineById(conn, payload.machineId);
    if (!machine || machine.status === "archived") return sendError(reply, 404, "Machine not found");
    const [res] = await queryWithTimeout(
      conn,
      `INSERT INTO cag_boxing_entries
       (machine_id, entry_date, entry_type, category, label, amount, payment_method, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.machineId,
        payload.entryDateSql,
        payload.type,
        payload.category,
        payload.label,
        payload.amount,
        payload.paymentMethod,
        payload.notes,
        req.cagUser && req.cagUser.id_user ? req.cagUser.id_user : null,
      ],
      8000
    );
    const row = await getBoxingEntryById(conn, res.insertId);
    reply.code(201).send({ entry: serializeBoxingEntry(row) });
  } catch (e) {
    const handled = handleDbWriteError(req, reply, e, "create-boxing-entry");
    if (handled !== false) return handled;
    throw e;
  } finally {
    if (conn) conn.release();
  }
};

fastify.post(CFG.apiPrefix + "/boxing/entries", { preHandler: [requireAuth, requireWrite] }, createBoxingEntryHandler);
fastify.get(CFG.apiPrefix + "/boxing/entries/create-q", { preHandler: [requireAuth, requireWrite] }, createBoxingEntryHandler);

const updateBoxingEntryHandler = async (req, reply) => {
  const idRaw = req.params && req.params.id;
  const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
  if (!id) return sendError(reply, 400, "Invalid id");
  let conn = null;
  try {
    conn = await getConnectionWithTimeout(4000);
    await ensureBoxingTables(conn);
    const existing = await getBoxingEntryById(conn, id);
    if (!existing) return sendError(reply, 404, "Not found");
    const payload = boxingEntryFromPayload(getRequestPayloadObject(req), existing);
    const machine = await getBoxingMachineById(conn, payload.machineId);
    if (!machine || machine.status === "archived") return sendError(reply, 404, "Machine not found");
    const [res] = await queryWithTimeout(
      conn,
      `UPDATE cag_boxing_entries
       SET machine_id = ?, entry_date = ?, entry_type = ?, category = ?, label = ?, amount = ?,
           payment_method = ?, notes = ?
       WHERE id_entry = ?`,
      [
        payload.machineId,
        payload.entryDateSql,
        payload.type,
        payload.category,
        payload.label,
        payload.amount,
        payload.paymentMethod,
        payload.notes,
        id,
      ],
      8000
    );
    if (!res.affectedRows) return sendError(reply, 404, "Not found");
    const row = await getBoxingEntryById(conn, id);
    reply.send({ entry: serializeBoxingEntry(row) });
  } catch (e) {
    const handled = handleDbWriteError(req, reply, e, "update-boxing-entry");
    if (handled !== false) return handled;
    throw e;
  } finally {
    if (conn) conn.release();
  }
};

fastify.patch(CFG.apiPrefix + "/boxing/entries/:id", { preHandler: [requireAuth, requireWrite] }, updateBoxingEntryHandler);
fastify.put(CFG.apiPrefix + "/boxing/entries/:id", { preHandler: [requireAuth, requireWrite] }, updateBoxingEntryHandler);
fastify.post(CFG.apiPrefix + "/boxing/entries/:id/update", { preHandler: [requireAuth, requireWrite] }, updateBoxingEntryHandler);
fastify.get(CFG.apiPrefix + "/boxing/entries/:id/update-q", { preHandler: [requireAuth, requireWrite] }, updateBoxingEntryHandler);

fastify.delete(
  CFG.apiPrefix + "/boxing/entries/:id",
  { preHandler: [requireAuth, requireWrite] },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    await ensureBoxingTables(pool);
    const [res] = await pool.query(`DELETE FROM cag_boxing_entries WHERE id_entry = ?`, [id]);
    if (!res.affectedRows) return sendError(reply, 404, "Not found");
    reply.send({ ok: true });
  }
);

fastify.get(
  CFG.apiPrefix + "/boxing/summary",
  { preHandler: requireAuth },
  async (req, reply) => {
    await ensureBoxingTables(pool);
    const r = calendarRangeToSql(req.query && req.query.from, req.query && req.query.to);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");
    const machineId = nullablePositiveInt(req.query && req.query.machineId);
    if (Number.isNaN(machineId)) return sendError(reply, 400, "Invalid machineId");
    const days = Math.max(1, Math.round((new Date(r.toExcl).getTime() - new Date(r.from).getTime()) / 86400000));
    const [kpiRows] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN be.entry_type = 'revenue' THEN be.amount ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN be.entry_type = 'expense' THEN be.amount ELSE 0 END), 0) AS expenses,
         COUNT(be.id_entry) AS entries_count
       FROM cag_boxing_entries be
       WHERE be.entry_date >= ? AND be.entry_date < ?
         AND (? IS NULL OR be.machine_id = ?)`,
      [r.from, r.toExcl, machineId, machineId]
    );
    const [machineCountRows] = await pool.query(
      `SELECT COUNT(*) AS machines_count, COALESCE(SUM(purchase_price), 0) AS investment
       FROM cag_boxing_machines
       WHERE status <> 'archived' AND (? IS NULL OR id_machine = ?)`,
      [machineId, machineId]
    );
    const [dayRows] = await pool.query(
      `SELECT DATE(be.entry_date) AS date,
         COALESCE(SUM(CASE WHEN be.entry_type = 'revenue' THEN be.amount ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN be.entry_type = 'expense' THEN be.amount ELSE 0 END), 0) AS expenses
       FROM cag_boxing_entries be
       WHERE be.entry_date >= ? AND be.entry_date < ?
         AND (? IS NULL OR be.machine_id = ?)
       GROUP BY DATE(be.entry_date)
       ORDER BY DATE(be.entry_date) ASC`,
      [r.from, r.toExcl, machineId, machineId]
    );
    const [machineRows] = await pool.query(
      `SELECT bm.*,
         COALESCE(agg.revenue, 0) AS revenue,
         COALESCE(agg.expenses, 0) AS expenses
       FROM cag_boxing_machines bm
       LEFT JOIN (
         SELECT machine_id,
           COALESCE(SUM(CASE WHEN entry_type = 'revenue' THEN amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN entry_type = 'expense' THEN amount ELSE 0 END), 0) AS expenses
         FROM cag_boxing_entries
         WHERE entry_date >= ? AND entry_date < ?
         GROUP BY machine_id
       ) agg ON agg.machine_id = bm.id_machine
       WHERE bm.status <> 'archived'
         AND (? IS NULL OR bm.id_machine = ?)
       ORDER BY (COALESCE(agg.revenue, 0) - COALESCE(agg.expenses, 0)) DESC, bm.name ASC`,
      [r.from, r.toExcl, machineId, machineId]
    );
    const [categoryRows] = await pool.query(
      `SELECT be.entry_type, be.category, COALESCE(SUM(be.amount), 0) AS amount, COUNT(*) AS count
       FROM cag_boxing_entries be
       WHERE be.entry_date >= ? AND be.entry_date < ?
         AND (? IS NULL OR be.machine_id = ?)
       GROUP BY be.entry_type, be.category
       ORDER BY amount DESC`,
      [r.from, r.toExcl, machineId, machineId]
    );
    const k = kpiRows && kpiRows[0] ? kpiRows[0] : {};
    const mc = machineCountRows && machineCountRows[0] ? machineCountRows[0] : {};
    const revenue = Number(k.revenue || 0);
    const expenses = Number(k.expenses || 0);
    const net = revenue - expenses;
    const investment = Number(mc.investment || 0);
    return {
      kpis: {
        machinesCount: Number(mc.machines_count || 0),
        revenue,
        expenses,
        net,
        investment,
        roiPercent: investment > 0 ? round2((net / investment) * 100) : null,
        avgDailyRevenue: round2(revenue / days),
        entriesCount: Number(k.entries_count || 0),
        days,
      },
      byDay: (dayRows || []).map((x) => ({
        date: dateOnlyFromMysql(x.date),
        revenue: Number(x.revenue || 0),
        expenses: Number(x.expenses || 0),
        net: Number(x.revenue || 0) - Number(x.expenses || 0),
      })),
      byMachine: (machineRows || []).map((row) => {
        const item = serializeBoxingMachine(row);
        const target = Number(item.targetDailyRevenue || 0) * days;
        return Object.assign(item, {
          targetRevenue: target,
          performance: target > 0 ? round2((Number(item.revenue || 0) / target) * 100) : null,
          avgDailyRevenue: round2(Number(item.revenue || 0) / days),
        });
      }),
      byCategory: (categoryRows || []).map((x) => ({
        type: x.entry_type || "revenue",
        category: x.category || "",
        categoryLabel: boxingCategoryLabel(x.category),
        amount: Number(x.amount || 0),
        count: Number(x.count || 0),
      })),
    };
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
    const category = normalizeCategory(req.query && req.query.category);
    const imageSelect = productImageSelectSql("p");
    const limit = clampInt(req.query && req.query.limit, 1, 100, 20);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM products p
       WHERE (? = '' OR p.productType = ?)
         AND (? = '' OR p.name LIKE ? OR p.barcode LIKE ? OR p.reference LIKE ? OR p.productType LIKE ?)`,
      [category, category, q, like, like, like, like]
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
       WHERE (? = '' OR p.productType = ?)
         AND (? = '' OR p.name LIKE ? OR p.barcode LIKE ? OR p.reference LIKE ? OR p.productType LIKE ?)
       ORDER BY p.last_updated DESC
       LIMIT ? OFFSET ?`,
      [category, category, q, like, like, like, like, limit, offset]
    );

    return { meta: { category }, total, items: rows || [] };
  }
);

fastify.get(
  CFG.apiPrefix + "/products/:id",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");

    const imageSelect = productImageSelectSql("p");
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
       WHERE p.id_product = ?
       LIMIT 1`,
      [id]
    );
    if (!rows || !rows[0]) return sendError(reply, 404, "Not found");
    return { product: rows[0] };
  }
);

const createProductHandler = async (req, reply) => {
    const b = getRequestPayloadObject(req);
    req.log.info({ route: "create-product" }, "Create product request");
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
    let conn = null;
    try {
      req.log.info({ route: "create-product" }, "Create product acquiring DB connection");
      conn = await getConnectionWithTimeout(4000);
      req.log.info({ route: "create-product" }, "Create product DB connection acquired");
      req.log.info({ route: "create-product", hasImageColumn }, "Create product running insert");
      const [res] = hasImageColumn
        ? await queryWithTimeout(
            conn,
            {
              sql: `INSERT INTO products
               (barcode, reference, name, description, quantity, purchasePrice, price, productType, image_url, last_updated, is_synced)
             VALUES
               (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)`,
            },
            [barcode, reference, name, description, quantity, purchasePrice, price, productType, imageUrl],
            8000
          )
        : await queryWithTimeout(
            conn,
            {
              sql: `INSERT INTO products
               (barcode, reference, name, description, quantity, purchasePrice, price, productType, last_updated, is_synced)
             VALUES
               (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)`,
            },
            [barcode, reference, name, description, quantity, purchasePrice, price, productType],
            8000
          );

      req.log.info({ route: "create-product", id_product: res && res.insertId }, "Create product insert done");
      reply.code(201).send({ id_product: res.insertId });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "create-product");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore
        }
      }
    }
  };

fastify.post(
  CFG.apiPrefix + "/products",
  {
    preHandler: [requireAuth, requireWrite],
  },
  createProductHandler
);

// Query-string write fallback for environments where POST body can hang behind proxy.
fastify.get(
  CFG.apiPrefix + "/products/create-q",
  {
    preHandler: [requireAuth, requireWrite],
  },
  createProductHandler
);

const updateProductHandler = async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    req.log.info({ route: "update-product", id_product: id }, "Update product request");
    const startedAt = Date.now();

    const b = getRequestPayloadObject(req);
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

    let conn = null;
    try {
      req.log.info({ route: "update-product", id_product: id }, "Update product acquiring DB connection");
      conn = await getConnectionWithTimeout(4000);
      req.log.info({ route: "update-product", id_product: id }, "Update product DB connection acquired");
      const [res] = await queryWithTimeout(
        conn,
        {
          sql: `UPDATE products SET ${fields.join(", ")} WHERE id_product = ?`,
        },
        values,
        8000
      );
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      req.log.info({ route: "update-product", id_product: id, elapsed_ms: Date.now() - startedAt }, "Product updated");
      reply.send({ ok: true });
    } catch (e) {
      const handled = handleDbWriteError(req, reply, e, "update-product");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore
        }
      }
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

fastify.post(
  CFG.apiPrefix + "/products/:id/update",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updateProductHandler
);

// Query-string write fallback.
fastify.get(
  CFG.apiPrefix + "/products/:id/update-q",
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
    req.log.info({ route: "delete-product", id_product: id }, "Delete product request");

    let conn = null;
    try {
      conn = await getConnectionWithTimeout(4000);
      const [res] = await queryWithTimeout(conn, `DELETE FROM products WHERE id_product = ?`, [id], 8000);
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      reply.send({ ok: true });
    } catch (e) {
      if (e && e.code === "ER_ROW_IS_REFERENCED_2") {
        return sendError(reply, 409, "Cannot delete product (in use)", {
          hint: "Prefer deactivate/archiving instead of deleting if you need history.",
        });
      }
      const handled = handleDbWriteError(req, reply, e, "delete-product");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore
        }
      }
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

const createOfferHandler = async (req, reply) => {
    const b = getRequestPayloadObject(req);
    req.log.info({ route: "create-offer" }, "Create offer request");
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return sendError(reply, 400, "Missing name");
    const quantity = b.quantity == null ? null : Number(b.quantity);
    const price = b.price == null ? null : Number(b.price);
    const productIds = parseNumericIdList(b.productIds);

    let conn = null;
    try {
      conn = await getConnectionWithTimeout(4000);
      await conn.beginTransaction();
      const [res] = await queryWithTimeout(
        conn,
        `INSERT INTO product_offers (name, quantity, price, last_updated, is_synced)
         VALUES (?, ?, ?, NOW(), 0)`,
        [name, quantity, price],
        8000
      );
      const offerId = res.insertId;
      for (const pid of productIds) {
        await queryWithTimeout(conn, `INSERT INTO product_offers_products (offer_id, product_id, is_synced) VALUES (?, ?, 0)`, [offerId, pid], 8000);
      }
      await conn.commit();
      reply.code(201).send({ id_offer: offerId });
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_) {
        // ignore rollback failure on broken connection
      }
      const handled = handleDbWriteError(req, reply, e, "create-offer");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore
        }
      }
    }
  };

fastify.post(
  CFG.apiPrefix + "/offers",
  {
    preHandler: [requireAuth, requireWrite],
  },
  createOfferHandler
);

// Query-string write fallback.
fastify.get(
  CFG.apiPrefix + "/offers/create-q",
  {
    preHandler: [requireAuth, requireWrite],
  },
  createOfferHandler
);

const updateOfferHandler = async (req, reply) => {
    const idRaw = req.params && req.params.id;
    const id = /^\d+$/.test(String(idRaw)) ? Number(idRaw) : null;
    if (!id) return sendError(reply, 400, "Invalid id");
    req.log.info({ route: "update-offer", id_offer: id }, "Update offer request");

    const b = getRequestPayloadObject(req);
    const name = typeof b.name === "string" ? b.name.trim() : null;
    const quantity = b.quantity === undefined ? undefined : b.quantity == null ? null : Number(b.quantity);
    const price = b.price === undefined ? undefined : b.price == null ? null : Number(b.price);
    const productIds = b.productIds === undefined ? null : parseNumericIdList(b.productIds);

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

    let conn = null;
    try {
      conn = await getConnectionWithTimeout(4000);
      await conn.beginTransaction();

      if (fields.length) {
        values.push(id);
        const [res] = await queryWithTimeout(conn, `UPDATE product_offers SET ${fields.join(", ")} WHERE id_offer = ?`, values, 8000);
        if (!res.affectedRows) {
          await conn.rollback();
          return sendError(reply, 404, "Not found");
        }
      }

      if (productIds !== null) {
        await queryWithTimeout(conn, `DELETE FROM product_offers_products WHERE offer_id = ?`, [id], 8000);
        for (const pid of productIds) {
          await queryWithTimeout(conn, `INSERT INTO product_offers_products (offer_id, product_id, is_synced) VALUES (?, ?, 0)`, [id, pid], 8000);
        }
      }

      await conn.commit();
      reply.send({ ok: true });
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_) {
        // ignore rollback failure on broken connection
      }
      const handled = handleDbWriteError(req, reply, e, "update-offer");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore
        }
      }
    }
  };

fastify.patch(
  CFG.apiPrefix + "/offers/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updateOfferHandler
);

// Query-string write fallback.
fastify.get(
  CFG.apiPrefix + "/offers/:id/update-q",
  {
    preHandler: [requireAuth, requireWrite],
  },
  updateOfferHandler
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
    req.log.info({ route: "delete-offer", id_offer: id }, "Delete offer request");

    let conn = null;
    try {
      conn = await getConnectionWithTimeout(4000);
      await conn.beginTransaction();
      await queryWithTimeout(conn, `DELETE FROM product_offers_products WHERE offer_id = ?`, [id], 8000);
      const [res] = await queryWithTimeout(conn, `DELETE FROM product_offers WHERE id_offer = ?`, [id], 8000);
      await conn.commit();
      if (!res.affectedRows) return sendError(reply, 404, "Not found");
      reply.send({ ok: true });
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_) {
        // ignore rollback failure on broken connection
      }
      const handled = handleDbWriteError(req, reply, e, "delete-offer");
      if (handled !== false) return handled;
      throw e;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore
        }
      }
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
  loadAssetCache();

  // Optional schema feature: keep legacy users.password for POS and use users.password_hash (bcrypt) for dashboard.
  try {
    await ensureUsersArchiveColumns(pool);
    fastify.log.info(
      {
        password_hash: HAS_PASSWORD_HASH_COLUMN,
        archived_at: USER_SCHEMA.has("archived_at"),
      },
      "Users schema ready"
    );
  } catch (e) {
    try {
      await refreshUserSchema();
    } catch (_) {
      HAS_PASSWORD_HASH_COLUMN = false;
    }
    fastify.log.warn({ err: e }, "Users schema setup failed; archive columns disabled if missing");
  }
  await refreshPosSchema();
  try {
    await ensurePurchasesTable(pool);
    fastify.log.info("Purchases schema ready");
  } catch (e) {
    fastify.log.warn({ err: e }, "Purchases schema setup failed; purchases endpoints will retry on demand");
  }
  try {
    await ensureBoxingTables(pool);
    fastify.log.info("Boxing machines schema ready");
  } catch (e) {
    fastify.log.warn({ err: e }, "Boxing machines schema setup failed; boxing endpoints will retry on demand");
  }
  try {
    await ensureLinkPagesTable(pool);
    fastify.log.info("Link pages schema ready");
  } catch (e) {
    fastify.log.warn({ err: e }, "Link pages schema setup failed; link page endpoints will retry on demand");
  }
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
