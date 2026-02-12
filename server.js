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

fastify.decorate("db", pool);

let HAS_PASSWORD_HASH_COLUMN = false;

fastify.register(helmet, {
  global: true,
});

fastify.register(cors, {
  origin: (origin, cb) => {
    // Allow server-to-server or curl without Origin header.
    if (!origin) return cb(null, true);
    if (CFG.corsOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS blocked"), false);
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});

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
  const from = `${fromIso} 00:00:00`;
  const toExcl = `${addDaysIso(toIso, 1)} 00:00:00`;
  return { from, toExcl };
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

// Health check
fastify.get(CFG.apiPrefix + "/health", async () => {
  return { ok: true };
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

// ---- DASHBOARD ----
fastify.get(
  CFG.apiPrefix + "/dashboard/summary",
  {
    preHandler: requireAuth,
  },
  async (req, reply) => {
    const fromIso = req.query && req.query.from;
    const toIso = req.query && req.query.to;
    const r = rangeToSql(fromIso, toIso);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");

    const [kpiRows] = await pool.query(
      `SELECT
         COALESCE(SUM(s.total_amount), 0) AS revenue,
         COUNT(*) AS salesCount
       FROM sales s
       WHERE s.last_updated >= ? AND s.last_updated < ?`,
      [r.from, r.toExcl]
    );
    const kpis = kpiRows && kpiRows[0] ? kpiRows[0] : { revenue: 0, salesCount: 0 };

    const [profitRows] = await pool.query(
      `SELECT
         COALESCE(SUM(
           (COALESCE(sd.total_price, sd.price * sd.quantity) - (COALESCE(p.purchasePrice, 0) * sd.quantity))
         ), 0) AS profit
       FROM sales_details sd
       JOIN sales s ON s.id_sale = sd.sale_id
       LEFT JOIN products p ON p.id_product = sd.product_id
       WHERE s.last_updated >= ? AND s.last_updated < ?`,
      [r.from, r.toExcl]
    );
    const profit = profitRows && profitRows[0] ? profitRows[0].profit : 0;

    const [seriesRows] = await pool.query(
      `SELECT
         DATE(s.last_updated) AS date,
         COALESCE(SUM(s.total_amount), 0) AS revenue
       FROM sales s
       WHERE s.last_updated >= ? AND s.last_updated < ?
       GROUP BY DATE(s.last_updated)
       ORDER BY DATE(s.last_updated) ASC`,
      [r.from, r.toExcl]
    );

    const [topProductsRows] = await pool.query(
      `SELECT
         p.id_product AS id,
         COALESCE(p.name, CONCAT('Produit #', sd.product_id)) AS name,
         COALESCE(SUM(sd.quantity), 0) AS qty,
         COALESCE(SUM(COALESCE(sd.total_price, sd.price * sd.quantity)), 0) AS revenue
       FROM sales_details sd
       JOIN sales s ON s.id_sale = sd.sale_id
       LEFT JOIN products p ON p.id_product = sd.product_id
       WHERE s.last_updated >= ? AND s.last_updated < ?
       GROUP BY p.id_product, p.name, sd.product_id
       ORDER BY revenue DESC
       LIMIT 10`,
      [r.from, r.toExcl]
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
       JOIN product_offers_products op ON op.product_id = sd.product_id
       JOIN product_offers o ON o.id_offer = op.offer_id
       WHERE s.last_updated >= ? AND s.last_updated < ?
       GROUP BY o.id_offer, o.name
       ORDER BY revenue DESC
       LIMIT 10`,
      [r.from, r.toExcl]
    );

    reply.send({
      kpis: {
        revenue: Number(kpis.revenue),
        profit: Number(profit),
        salesCount: Number(kpis.salesCount),
        avgTicket: kpis.salesCount ? Number(kpis.revenue) / Number(kpis.salesCount) : 0,
      },
      series: (seriesRows || []).map((x) => ({ date: String(x.date), revenue: Number(x.revenue) })),
      topProducts: (topProductsRows || []).map((x) => ({ id: x.id, name: x.name, qty: Number(x.qty), revenue: Number(x.revenue) })),
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
    const r = rangeToSql(fromIso, toIso);
    if (!r) return sendError(reply, 400, "Invalid from/to (expected YYYY-MM-DD)");

    const q = (req.query && typeof req.query.q === "string" ? req.query.q.trim() : "") || "";
    const limit = clampInt(req.query && req.query.limit, 1, 100, 20);
    const offset = clampInt(req.query && req.query.offset, 0, 1_000_000, 0);
    const like = "%" + q + "%";
    const qNum = /^\d+$/.test(q) ? Number(q) : -1;

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM sales s
       LEFT JOIN users u ON u.id_user = s.user_id
       WHERE s.last_updated >= ? AND s.last_updated < ?
         AND (
           ? = '' OR s.notes LIKE ? OR u.username LIKE ? OR s.id_sale = ?
         )`,
      [r.from, r.toExcl, q, like, like, qNum]
    );
    const total = totalRows && totalRows[0] ? Number(totalRows[0].total) : 0;

    const [rows] = await pool.query(
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
       WHERE s.last_updated >= ? AND s.last_updated < ?
         AND (
           ? = '' OR s.notes LIKE ? OR u.username LIKE ? OR s.id_sale = ?
         )
       ORDER BY s.last_updated DESC
       LIMIT ? OFFSET ?`,
      [r.from, r.toExcl, q, like, like, qNum, limit, offset]
    );

    reply.send({
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

    const [detailRows] = await pool.query(
      `SELECT
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
       ORDER BY sd.id_sale_detail ASC`,
      [id]
    );

    reply.send({
      sale: {
        id_sale: sale.id_sale,
        total_amount: Number(sale.total_amount),
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
  CFG.apiPrefix + "/products",
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
    const quantity = b.quantity == null ? null : Number(b.quantity);
    const purchasePrice = b.purchasePrice == null ? null : Number(b.purchasePrice);
    const price = b.price == null ? null : Number(b.price);

    const [res] = await pool.query(
      `INSERT INTO products
         (barcode, reference, name, description, quantity, purchasePrice, price, productType, last_updated, is_synced)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0)`,
      [barcode, reference, name, description, quantity, purchasePrice, price, productType]
    );

    reply.code(201).send({ id_product: res.insertId });
  }
);

fastify.patch(
  CFG.apiPrefix + "/products/:id",
  {
    preHandler: [requireAuth, requireWrite],
  },
  async (req, reply) => {
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
    if (b.quantity !== undefined) setField("quantity", b.quantity == null ? null : Number(b.quantity));
    if (b.purchasePrice !== undefined) setField("purchasePrice", b.purchasePrice == null ? null : Number(b.purchasePrice));
    if (b.price !== undefined) setField("price", b.price == null ? null : Number(b.price));

    if (!fields.length) return sendError(reply, 400, "No fields to update");

    fields.push("last_updated = NOW()");
    fields.push("is_synced = 0");
    values.push(id);

    const [res] = await pool.query(`UPDATE products SET ${fields.join(", ")} WHERE id_product = ?`, values);
    if (!res.affectedRows) return sendError(reply, 404, "Not found");
    reply.send({ ok: true });
  }
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
  await fastify.listen({ port: CFG.port, host: CFG.host });
}

main().catch((e) => {
  fastify.log.error(e);
  process.exit(1);
});
