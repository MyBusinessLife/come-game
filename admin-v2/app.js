(function () {
  "use strict";

  var APP_VERSION = "3.7.0";
  var STORAGE_KEY = "cag_admin_v2_auth";
  var LOCALE = "fr-DZ";
  var CURRENCY = "DZD";
  var PAGE_SIZE = 25;
  var SALES_AUTO_REFRESH_MS = 10000;
  var USER_ROLE_OPTIONS = [
    { value: "cashier", label: "Travailleur / caisse", hint: "Connexion POS + ventes. Pas de droits de gestion." },
    { value: "manager", label: "Manager", hint: "Gestion produits, offres, achats et utilisateurs." },
    { value: "admin", label: "Administrateur", hint: "Acces complet au dashboard." },
    { value: "viewer", label: "Lecture seule", hint: "Consultation dashboard sans modifications." },
  ];
  var LINK_TYPE_OPTIONS = [
    { value: "instagram", label: "Instagram" },
    { value: "facebook", label: "Facebook" },
    { value: "tiktok", label: "TikTok" },
    { value: "snapchat", label: "Snapchat" },
    { value: "youtube", label: "YouTube" },
    { value: "whatsapp", label: "WhatsApp" },
    { value: "maps", label: "Google Maps" },
    { value: "website", label: "Site web" },
  ];
  var PAGE_TYPE_OPTIONS = [
    { value: "standard", label: "Standard" },
    { value: "game_room", label: "Salle de jeu" },
  ];
  var API_ROOT = "/api";
  var LOGIN_URL = "/login";
  var ADMIN_URL = "/admin";

  var state = {
    token: "",
    user: null,
    activeTab: "cockpit",
    categories: [],
    purchaseCategories: [],
    boxingMeta: { statuses: [], categories: [] },
    products: [],
    productRows: [],
    offers: [],
    users: [],
    usersPage: { q: "", archived: false },
    summary: null,
    history: null,
    purchaseSummary: null,
    boxingSummary: null,
    boxingMachines: [],
    filters: { from: "", to: "", category: "" },
    sales: { q: "", offset: 0, total: 0, items: [] },
    productsPage: { q: "", category: "", offset: 0, total: 0, items: [] },
    purchases: { q: "", category: "", offset: 0, total: 0, items: [] },
    boxingEntries: { q: "", machineId: "", type: "", offset: 0, total: 0, items: [] },
    linkPages: { q: "", offset: 0, total: 0, items: [] },
    log: [],
  };

  var els = {};
  var autoRefreshTimer = null;
  var salesRefreshInFlight = false;
  var weekdayNames = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

  function $(id) {
    return document.getElementById(id);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toIso(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function todayIso() {
    return toIso(new Date());
  }

  function dateFromIso(iso) {
    var parts = String(iso || "").split("-").map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return new Date();
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function minusDays(baseIso, days) {
    var d = dateFromIso(baseIso);
    d.setDate(d.getDate() - days);
    return toIso(d);
  }

  function addDays(baseIso, days) {
    var d = dateFromIso(baseIso);
    d.setDate(d.getDate() + days);
    return toIso(d);
  }

  function firstDayOfMonth(baseIso) {
    var d = dateFromIso(baseIso);
    d.setDate(1);
    return toIso(d);
  }

  function previousMonthRange(baseIso) {
    var d = dateFromIso(baseIso);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    var from = toIso(d);
    d.setMonth(d.getMonth() + 1);
    d.setDate(0);
    return { from: from, to: toIso(d) };
  }

  function daysBetweenInclusive(from, to) {
    var a = dateFromIso(from);
    var b = dateFromIso(to);
    var ms = b.getTime() - a.getTime();
    if (!Number.isFinite(ms)) return 1;
    return Math.max(1, Math.floor(ms / 86400000) + 1);
  }

  function fmtMoney(v, compact) {
    var n = Number(v);
    if (!Number.isFinite(n)) n = 0;
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: CURRENCY,
      maximumFractionDigits: compact ? 0 : 2,
    }).format(n);
  }

  function fmtNumber(v, digits) {
    var n = Number(v);
    if (!Number.isFinite(n)) n = 0;
    return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits == null ? 2 : digits }).format(n);
  }

  function fmtDateTime(v) {
    if (!v) return "-";
    var d = new Date(String(v).replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return String(v);
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(d);
  }

  function parseNumberInput(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    var n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }

  function roundStep(value, step) {
    var n = Number(value) || 0;
    var s = Number(step) || 100;
    return Math.max(0, Math.ceil(n / s) * s);
  }

  function readAuth() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && data.token ? data : null;
    } catch (_) {
      return null;
    }
  }

  function writeAuth(token, user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: token, user: user || null, updatedAt: new Date().toISOString(), appVersion: APP_VERSION }));
  }

  function clearAuth() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (label) btn.textContent = label;
  }

  function showToast(message, kind) {
    if (!els.globalAlert) return;
    var node = document.createElement("div");
    node.className = "toast " + (kind || "info");
    node.textContent = message;
    els.globalAlert.appendChild(node);
    setTimeout(function () {
      node.classList.add("leaving");
      setTimeout(function () { node.remove(); }, 260);
    }, 4200);
  }

  function apiErrorMessage(status, data, fallback) {
    var msg = fallback || "Erreur API";
    if (data && typeof data.message === "string") msg = data.message;
    if (data && typeof data.hint === "string") msg += " - " + data.hint;
    if (status) msg += " (HTTP " + status + ")";
    return msg;
  }

  function logRequest(entry) {
    var line = Object.assign({ at: new Date(), ms: null, status: "..." }, entry || {});
    state.log.unshift(line);
    state.log = state.log.slice(0, 60);
    renderRequestLog();
    return line;
  }

  function updateLogLine(line, patch) {
    Object.assign(line, patch || {});
    renderRequestLog();
  }

  async function api(path, opts) {
    opts = opts || {};
    var method = String(opts.method || "GET").toUpperCase();
    var timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : method === "GET" ? 30000 : 30000;
    var url = /^https?:\/\//.test(path) ? path : API_ROOT + (path[0] === "/" ? path : "/" + path);

    if (opts.query && typeof opts.query === "object") {
      var params = new URLSearchParams();
      Object.keys(opts.query).forEach(function (k) {
        var v = opts.query[k];
        if (v == null) return;
        if (v === "" && !opts.keepEmptyQuery) return;
        params.set(k, String(v));
      });
      var qs = params.toString();
      if (qs) url += (url.indexOf("?") === -1 ? "?" : "&") + qs;
    }

    var headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false && state.token) headers.Authorization = "Bearer " + state.token;

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    var start = Date.now();
    var line = logRequest({ method: method, path: url.replace(API_ROOT, "/api") });
    try {
      var res = await fetch(url, {
        method: method,
        headers: headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      var text = await res.text();
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
      }
      updateLogLine(line, { status: res.status, ms: Date.now() - start, ok: res.ok });
      if (!res.ok) {
        var err = new Error(apiErrorMessage(res.status, data, "Erreur API"));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err) {
      var aborted = err && err.name === "AbortError";
      updateLogLine(line, { status: aborted ? "TIMEOUT" : err.status || "ERR", ms: Date.now() - start, ok: false });
      if (aborted) {
        var t = new Error("Timeout API sur " + method + " " + url.replace(API_ROOT, "/api") + " (" + timeoutMs + "ms)");
        t.status = 408;
        throw t;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function apiBlob(path, opts) {
    opts = opts || {};
    var method = String(opts.method || "GET").toUpperCase();
    var url = /^https?:\/\//.test(path) ? path : API_ROOT + (path[0] === "/" ? path : "/" + path);
    var headers = { Accept: opts.accept || "application/octet-stream" };
    if (opts.auth !== false && state.token) headers.Authorization = "Bearer " + state.token;
    var start = Date.now();
    var line = logRequest({ method: method, path: url.replace(API_ROOT, "/api") });
    var res = await fetch(url, { method: method, headers: headers });
    updateLogLine(line, { status: res.status, ms: Date.now() - start, ok: res.ok });
    if (!res.ok) {
      var text = await res.text().catch(function () { return ""; });
      throw new Error(text || "Telechargement impossible (HTTP " + res.status + ")");
    }
    return res.blob();
  }

  function shouldQueryFallback(err) {
    var s = Number(err && err.status);
    return !s || s === 408 || s === 429 || s >= 500 || s === 404 || s === 405;
  }

  function queryPayload(payload) {
    var out = {};
    Object.keys(payload || {}).forEach(function (k) {
      var v = payload[k];
      if (v === undefined) return;
      if (v === null) out[k] = "";
      else if (Array.isArray(v)) out[k] = v.join(",");
      else out[k] = String(v);
    });
    return out;
  }

  async function writeWithFallback(primary, fallback, payload) {
    try {
      return await api(primary.path, { method: primary.method, body: payload, timeoutMs: primary.timeoutMs || 30000 });
    } catch (err) {
      if (!fallback || !shouldQueryFallback(err)) throw err;
      return api(fallback.path, {
        method: fallback.method || "GET",
        query: queryPayload(payload),
        keepEmptyQuery: true,
        timeoutMs: fallback.timeoutMs || 30000,
      });
    }
  }

  function setLoginVisible(show) {
    if (show) {
      var next = window.location.pathname + window.location.search;
      if (next === LOGIN_URL || next.indexOf(LOGIN_URL + "?") === 0) next = ADMIN_URL;
      window.location.replace(LOGIN_URL + "?next=" + encodeURIComponent(next));
      return;
    }
    if (els.loginScreen) els.loginScreen.hidden = true;
    if (els.adminScreen) els.adminScreen.hidden = false;
  }

  function setRange(range) {
    var t = todayIso();
    var r = { from: t, to: t };
    if (range === "yesterday") r = { from: minusDays(t, 1), to: minusDays(t, 1) };
    else if (range === "7d") r = { from: minusDays(t, 6), to: t };
    else if (range === "30d") r = { from: minusDays(t, 29), to: t };
    else if (range === "month") r = { from: firstDayOfMonth(t), to: t };
    else if (range === "prevmonth") r = previousMonthRange(t);
    state.filters.from = r.from;
    state.filters.to = r.to;
    els.filterFrom.value = r.from;
    els.filterTo.value = r.to;
    all(".chip[data-range]").forEach(function (btn) { btn.classList.toggle("active", btn.getAttribute("data-range") === range); });
  }

  function normalizeProduct(p) {
    return {
      id: Number(p.id_product != null ? p.id_product : p.id),
      name: p.name || "",
      barcode: p.barcode || "",
      reference: p.reference || "",
      description: p.description || "",
      productType: p.productType || "",
      quantity: p.quantity == null ? null : Number(p.quantity),
      purchasePrice: p.purchasePrice == null ? null : Number(p.purchasePrice),
      price: p.price == null ? null : Number(p.price),
      imageUrl: p.imageUrl || p.image_url || "",
    };
  }

  function normalizeOffer(o) {
    return {
      id: Number(o.id_offer != null ? o.id_offer : o.id),
      name: o.name || "",
      quantity: o.quantity == null ? null : Number(o.quantity),
      price: o.price == null ? null : Number(o.price),
      productIds: Array.isArray(o.productIds) ? o.productIds.map(Number).filter(Number.isFinite) : [],
    };
  }

  function normalizePurchase(p) {
    return {
      id: Number(p.id_purchase || p.id || 0),
      purchaseDate: p.purchaseDate || String(p.purchase_date || "").slice(0, 10),
      category: p.category || "autre",
      categoryLabel: p.categoryLabel || p.category || "Autre",
      label: p.label || "",
      amount: Number(p.amount || 0),
      quantity: p.quantity == null ? null : Number(p.quantity),
      unit: p.unit || "",
      supplier: p.supplier || "",
      paymentMethod: p.paymentMethod || p.payment_method || "",
      productId: p.productId == null ? null : Number(p.productId),
      productName: p.productName || "",
      stockQuantity: p.stockQuantity == null ? null : Number(p.stockQuantity),
      applyStock: !!p.applyStock,
      assignedUserId: p.assignedUserId == null ? null : Number(p.assignedUserId),
      assignedUsername: p.assignedUsername || "",
      isStartupInvestment: !!p.isStartupInvestment,
      notes: p.notes || "",
    };
  }

  function normalizeBoxingMachine(m) {
    return {
      id: Number(m.id_machine || m.id || 0),
      name: m.name || "",
      serialNumber: m.serialNumber || m.serial_number || "",
      locationName: m.locationName || m.location_name || "",
      locationAddress: m.locationAddress || m.location_address || "",
      placementType: m.placementType || m.placement_type || "depot",
      ownerContact: m.ownerContact || m.owner_contact || "",
      purchasePrice: Number(m.purchasePrice || m.purchase_price || 0),
      installDate: m.installDate || String(m.install_date || "").slice(0, 10),
      revenueSharePercent: Number(m.revenueSharePercent || m.revenue_share_percent || 0),
      targetDailyRevenue: Number(m.targetDailyRevenue || m.target_daily_revenue || 0),
      status: m.status || "active",
      notes: m.notes || "",
      revenue: Number(m.revenue || 0),
      expenses: Number(m.expenses || 0),
      net: Number(m.net || 0),
      roiPercent: m.roiPercent == null ? null : Number(m.roiPercent),
      avgDailyRevenue: Number(m.avgDailyRevenue || 0),
      performance: m.performance == null ? null : Number(m.performance),
    };
  }

  function normalizeBoxingEntry(e) {
    return {
      id: Number(e.id_entry || e.id || 0),
      machineId: Number(e.machineId || e.machine_id || 0),
      machineName: e.machineName || e.machine_name || "",
      locationName: e.locationName || e.location_name || "",
      entryDate: e.entryDate || String(e.entry_date || "").slice(0, 10),
      type: e.type || e.entry_type || "revenue",
      category: e.category || "",
      categoryLabel: e.categoryLabel || e.category || "",
      label: e.label || "",
      amount: Number(e.amount || 0),
      paymentMethod: e.paymentMethod || e.payment_method || "",
      notes: e.notes || "",
      createdByUsername: e.createdByUsername || e.created_by_username || "",
    };
  }

  function parseRoleTokens(raw) {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return [];
    try {
      var j = JSON.parse(s);
      if (Array.isArray(j)) return j.map(String).filter(Boolean);
      if (j && typeof j === "object") return Object.keys(j);
    } catch (_) {}
    return s.split(/[,;|\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function normalizeUser(u) {
    var tokens = Array.isArray(u.roleTokens) && u.roleTokens.length ? u.roleTokens : parseRoleTokens(u.roles);
    return {
      id: Number(u.id_user || u.id || 0),
      username: u.username || "",
      roles: u.roles || "",
      roleTokens: tokens.map(function (x) { return String(x).toLowerCase(); }).filter(Boolean),
      isActive: Number(u.is_active) === 1,
      lastLogin: u.last_login || null,
      archivedAt: u.archived_at || null,
      archivedBy: u.archived_by || null,
      archivedReason: u.archived_reason || "",
      isArchived: !!u.is_archived || !!u.archived_at,
    };
  }

  function normalizeLinkPage(p) {
    return {
      id: Number(p.id || p.id_link_page || 0),
      slug: p.slug || "",
      pageType: p.pageType || p.page_type || "standard",
      title: p.title || "",
      subtitle: p.subtitle || "",
      description: p.description || "",
      email: p.email || "",
      phone: p.phone || "",
      links: Array.isArray(p.links) ? p.links : [],
      isActive: p.isActive !== undefined ? !!p.isActive : Number(p.is_active) === 1,
      publicUrl: p.publicUrl || "",
      qrUrl: p.qrUrl || "",
      createdAt: p.createdAt || p.created_at || null,
      updatedAt: p.updatedAt || p.updated_at || null,
    };
  }

  function roleInfo(value) {
    return USER_ROLE_OPTIONS.find(function (r) { return r.value === value; }) || { value: value, label: value || "Sans role", hint: "" };
  }

  function roleLabel(value) {
    return roleInfo(value).label;
  }

  function pageTypeLabel(value) {
    var found = PAGE_TYPE_OPTIONS.find(function (x) { return x.value === value; });
    return found ? found.label : "Standard";
  }

  function pageTypeOptions(selected) {
    return PAGE_TYPE_OPTIONS.map(function (option) {
      return '<option value="' + escapeHtml(option.value) + '"' + (String(selected || "standard") === option.value ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>';
    }).join('');
  }

  function currentUserRoleTokens() {
    if (!state.user) return [];
    if (Array.isArray(state.user.roleTokens) && state.user.roleTokens.length) {
      return state.user.roleTokens.map(function (x) { return String(x).toLowerCase(); });
    }
    return parseRoleTokens(state.user.roles).map(function (x) { return String(x).toLowerCase(); });
  }

  function currentUserIsAdmin() {
    return currentUserRoleTokens().indexOf("admin") !== -1;
  }

  function currentUserCanWrite() {
    var tokens = currentUserRoleTokens();
    return tokens.indexOf("admin") !== -1 || tokens.indexOf("manager") !== -1;
  }

  function availableUserRoleOptions() {
    if (currentUserIsAdmin()) return USER_ROLE_OPTIONS;
    return USER_ROLE_OPTIONS.filter(function (role) { return role.value === "cashier"; });
  }

  function currentSummaryQuery(extra) {
    var q = Object.assign({ from: state.filters.from, to: state.filters.to }, extra || {});
    if (state.filters.category) q.category = state.filters.category;
    return q;
  }

  async function loadCategories() {
    var data = await api("/products/categories", { auth: false });
    state.categories = Array.isArray(data && data.items) ? data.items : [];
    var html = '<option value="">Toutes categories</option>' + state.categories.map(function (c) {
      return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
    }).join("");
    els.filterCategory.innerHTML = html;
    els.filterCategory.value = state.filters.category || "";
    if (els.productsFilterCategory) {
      els.productsFilterCategory.innerHTML = html;
      els.productsFilterCategory.value = state.productsPage.category || "";
    }
  }

  async function loadPurchaseCategories() {
    try {
      var data = await api("/purchases/categories");
      state.purchaseCategories = Array.isArray(data && data.items) ? data.items : [];
    } catch (_) {
      state.purchaseCategories = [
        { value: "stock_alimentaire", label: "Alimentaire / stock" },
        { value: "materiel", label: "Materiel" },
        { value: "loyer", label: "Loyer" },
        { value: "service", label: "Services" },
        { value: "investissement_depart", label: "Investissement de depart" },
        { value: "autre", label: "Autre" },
      ];
    }
    var html = '<option value="">Toutes les charges</option>' + state.purchaseCategories.map(function (c) {
      return '<option value="' + escapeHtml(c.value) + '">' + escapeHtml(c.label) + '</option>';
    }).join("");
    els.purchaseFilterCategory.innerHTML = html;
    els.purchaseFilterCategory.value = state.purchases.category || "";
  }

  async function loadBoxingMeta() {
    try {
      var data = await api("/boxing/categories");
      state.boxingMeta = {
        statuses: Array.isArray(data && data.statuses) ? data.statuses : [],
        categories: Array.isArray(data && data.categories) ? data.categories : [],
      };
    } catch (_) {
      state.boxingMeta = {
        statuses: [
          { value: "active", label: "Active" },
          { value: "maintenance", label: "Maintenance" },
          { value: "inactive", label: "Inactive" },
          { value: "archived", label: "Archivee" },
        ],
        categories: [
          { value: "collecte_cash", label: "Collecte cash", type: "revenue" },
          { value: "maintenance", label: "Maintenance", type: "expense" },
          { value: "transport", label: "Transport / installation", type: "expense" },
          { value: "autre_frais", label: "Autre frais", type: "expense" },
        ],
      };
    }
  }

  async function loadBoxingMachines() {
    var data = await api("/boxing/machines");
    state.boxingMachines = Array.isArray(data && data.items) ? data.items.map(normalizeBoxingMachine) : [];
    renderBoxingMachineFilter();
    renderBoxing();
  }

  async function loadBoxingSummary() {
    var query = { from: state.filters.from, to: state.filters.to };
    if (state.boxingEntries.machineId) query.machineId = state.boxingEntries.machineId;
    state.boxingSummary = await api("/boxing/summary", { query: query });
    renderBoxing();
  }

  async function loadBoxingEntries() {
    var query = {
      from: state.filters.from,
      to: state.filters.to,
      q: state.boxingEntries.q,
      machineId: state.boxingEntries.machineId,
      type: state.boxingEntries.type,
      limit: PAGE_SIZE,
      offset: state.boxingEntries.offset,
    };
    var data = await api("/boxing/entries", { query: query });
    state.boxingEntries.total = Number(data && data.total || 0);
    state.boxingEntries.items = Array.isArray(data && data.items) ? data.items.map(normalizeBoxingEntry) : [];
    renderBoxing();
  }

  async function loadBoxing() {
    await Promise.all([loadBoxingMeta(), loadBoxingMachines()]);
    await Promise.all([loadBoxingSummary(), loadBoxingEntries()]);
  }

  async function loadUsers() {
    try {
      var query = state.usersPage.archived ? { archived: "1" } : {};
      var data = await api("/users", { query: query });
      state.users = Array.isArray(data && data.items) ? data.items.map(normalizeUser) : [];
    } catch (_) {
      state.users = [];
    }
    renderUsers();
  }

  async function loadLinkPages() {
    var data = await api("/link-pages", { query: { q: state.linkPages.q, limit: PAGE_SIZE, offset: state.linkPages.offset } });
    state.linkPages.total = Number(data && data.total || 0);
    state.linkPages.items = Array.isArray(data && data.items) ? data.items.map(normalizeLinkPage) : [];
    renderLinkPages();
  }

  async function loadProductCatalog() {
    var data = await api("/pos/bootstrap?limit=5000");
    state.products = Array.isArray(data && data.products) ? data.products.map(normalizeProduct).filter(function (p) { return Number.isFinite(p.id); }) : [];
    if (Array.isArray(data && data.offers) && !state.offers.length) state.offers = data.offers.map(normalizeOffer);
  }

  async function loadSummary() {
    state.summary = await api("/dashboard/summary", { query: currentSummaryQuery() });
    var historyFrom = minusDays(state.filters.to || todayIso(), 59);
    state.history = await api("/dashboard/summary", { query: Object.assign(currentSummaryQuery({ from: historyFrom, to: state.filters.to }), state.filters.category ? { category: state.filters.category } : {}) });
    try {
      state.purchaseSummary = await api("/purchases/summary", { query: { from: state.filters.from, to: state.filters.to } });
    } catch (_) {
      state.purchaseSummary = { total: 0, count: 0, byCategory: [] };
    }
    renderCockpit();
    renderAnalysis();
  }

  async function loadSales() {
    if (salesRefreshInFlight) return;
    salesRefreshInFlight = true;
    try {
    var data = await api("/sales", { query: { from: state.filters.from, to: state.filters.to, category: state.filters.category, q: state.sales.q, limit: PAGE_SIZE, offset: state.sales.offset } });
    state.sales.total = Number(data && data.total || 0);
    state.sales.items = Array.isArray(data && data.items) ? data.items : [];
    renderSales();
    } finally {
      salesRefreshInFlight = false;
    }
  }

  async function loadProductsPage() {
    var data = await api("/products", { query: { q: state.productsPage.q, category: state.productsPage.category, limit: PAGE_SIZE, offset: state.productsPage.offset } });
    state.productsPage.total = Number(data && data.total || 0);
    state.productsPage.items = Array.isArray(data && data.items) ? data.items.map(normalizeProduct) : [];
    renderProducts();
  }

  async function loadOffers() {
    var data = await api("/offers", { query: { q: "", limit: 100, offset: 0 } });
    state.offers = Array.isArray(data && data.items) ? data.items.map(normalizeOffer) : [];
    renderOffers();
  }

  async function loadPurchases() {
    var data = await api("/purchases", { query: { from: state.filters.from, to: state.filters.to, q: state.purchases.q, category: state.purchases.category, limit: PAGE_SIZE, offset: state.purchases.offset } });
    state.purchases.total = Number(data && data.total || 0);
    state.purchases.items = Array.isArray(data && data.items) ? data.items.map(normalizePurchase) : [];
    renderPurchases();
  }

  async function refreshData(scope) {
    if (!state.token) return;
    if (scope === "base") {
      await Promise.all([loadCategories(), loadPurchaseCategories(), loadBoxingMeta(), loadUsers(), loadProductCatalog()]);
      return;
    }
    if (scope === "dashboard") return loadSummary();
    if (scope === "sales") return loadSales();
    if (scope === "products") return Promise.all([loadProductsPage(), loadProductCatalog(), loadCategories()]);
    if (scope === "offers") return loadOffers();
    if (scope === "purchases") return Promise.all([loadPurchases(), loadSummary(), loadProductCatalog(), loadUsers(), loadPurchaseCategories()]);
    if (scope === "boxing") return loadBoxing();
    if (scope === "users") return loadUsers();
    if (scope === "link-pages") return loadLinkPages();
    await Promise.all([loadSummary(), loadSales(), loadProductsPage(), loadOffers(), loadPurchases(), loadBoxing(), loadUsers(), loadLinkPages()]);
  }

  function computeTargets() {
    var summary = state.summary || {};
    var history = state.history || {};
    var series = Array.isArray(history.series) ? history.series : [];
    var selectedDays = daysBetweenInclusive(state.filters.from, state.filters.to);
    var revenue = Number(summary.kpis && summary.kpis.revenue || 0);
    var profit = Number(summary.kpis && summary.kpis.profit || 0);
    var purchases = Number(state.purchaseSummary && state.purchaseSummary.total || 0);
    var net = profit - purchases;
    var lastDate = state.filters.to || todayIso();
    var avgWindow = function (days) {
      var from = minusDays(lastDate, days - 1);
      var filtered = series.filter(function (x) { return String(x.date) >= from && String(x.date) <= lastDate; });
      var sum = filtered.reduce(function (acc, x) { return acc + Number(x.revenue || 0); }, 0);
      return sum / Math.max(1, days);
    };
    var avg7 = avgWindow(7);
    var avg30 = avgWindow(30);
    var todayWeekday = (dateFromIso(lastDate).getDay() + 6) % 7;
    var sameWeekday = series.filter(function (x) { return ((dateFromIso(String(x.date)).getDay() + 6) % 7) === todayWeekday; });
    var weekdayAvg = sameWeekday.reduce(function (acc, x) { return acc + Number(x.revenue || 0); }, 0) / Math.max(1, sameWeekday.length);
    var baseline = Math.max(avg7 * 1.1, avg30 * 1.05, weekdayAvg * 1.08, revenue / selectedDays);
    var targetDaily = roundStep(baseline || revenue || 1000, 500);
    var targetPeriod = targetDaily * selectedDays;
    var performance = targetPeriod ? revenue / targetPeriod : 0;
    var trend = avg30 ? (avg7 - avg30) / avg30 : 0;
    return { revenue: revenue, profit: profit, purchases: purchases, net: net, selectedDays: selectedDays, avg7: avg7, avg30: avg30, weekdayAvg: weekdayAvg, targetDaily: targetDaily, targetPeriod: targetPeriod, performance: performance, trend: trend };
  }

  function kpiCard(label, value, sub, status, delta) {
    var cls = status === "good" ? "positive" : status === "bad" ? "negative" : "neutral";
    return '<article class="kpi-card ' + cls + '"><span class="scanline"></span><p>' + escapeHtml(label) + '</p><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(sub || "") + '</small>' + (delta ? '<em>' + escapeHtml(delta) + '</em>' : '') + '</article>';
  }

  function renderCockpit() {
    var s = state.summary || {};
    var k = s.kpis || {};
    var t = computeTargets();
    var margin = Number(k.revenue) ? Number(k.profit) / Number(k.revenue) : 0;
    var status = t.performance >= 1 ? "good" : t.performance >= 0.85 ? "neutral" : "bad";
    els.kpisGrid.innerHTML = [
      kpiCard("Chiffre d'affaires", fmtMoney(k.revenue), "Objectif periode: " + fmtMoney(t.targetPeriod, true), status, fmtNumber(t.performance * 100, 0) + "%"),
      kpiCard("Resultat brut", fmtMoney(k.profit), "Marge: " + fmtNumber(margin * 100, 1) + "%", margin >= 0.45 ? "good" : margin >= 0.25 ? "neutral" : "bad"),
      kpiCard("Achats", fmtMoney(t.purchases), "Charges sur la periode", t.purchases <= t.profit * 0.45 ? "good" : "bad"),
      kpiCard("Resultat net", fmtMoney(t.net), "Brut - achats", t.net >= 0 ? "good" : "bad"),
      kpiCard("Ventes", fmtNumber(k.salesCount, 0), "Tickets encaisses", "neutral"),
      kpiCard("Ticket moyen", fmtMoney(k.avgTicket), "Panier moyen", Number(k.avgTicket) >= 250 ? "good" : "neutral"),
    ].join("");

    els.dailyPerformancePill.textContent = t.performance >= 1 ? "Au-dessus objectif" : "A renforcer";
    els.dailyPerformancePill.className = "metric-pill " + (t.performance >= 1 ? "positive" : "negative");
    renderBarChart(els.dailyChart, (s.series || []).map(function (x) { return { label: String(x.date).slice(5), value: Number(x.revenue || 0), hint: fmtMoney(x.revenue) }; }), "money");
    renderBarChart(els.hourChart, (s.byHour || []).map(function (x) { return { label: String(x.hour).padStart(2, "0") + "h", value: Number(x.revenue || 0), hint: fmtMoney(x.revenue) }; }), "money");
    renderMiniBars(els.categoryChart, groupProductsByCategory(s.productResults || []), "money");
    renderTargetGauge(t);
  }

  function renderTargetGauge(t) {
    var pct = Math.max(0, Math.min(140, t.performance * 100));
    var color = t.performance >= 1 ? "#20e68a" : t.performance >= 0.85 ? "#f6c453" : "#ff5c7a";
    els.targetTitle.textContent = "Objectif: " + fmtMoney(t.targetDaily, true) + " / jour";
    els.targetGauge.innerHTML = '<div class="gauge-ring" style="--pct:' + pct + ';--gauge:' + color + '"><span>' + fmtNumber(t.performance * 100, 0) + '%</span></div><div class="gauge-meta"><strong>' + fmtMoney(t.revenue) + '</strong><small>sur ' + fmtMoney(t.targetPeriod, true) + ' attendus</small></div>';
    var tips = [];
    if (t.performance >= 1) tips.push("Performance au-dessus de l'objectif. Garde ce rythme et surveille le stock des best-sellers.");
    else tips.push("Il manque environ " + fmtMoney(Math.max(0, t.targetPeriod - t.revenue), true) + " pour atteindre le plan de la periode.");
    if (t.trend >= 0.05) tips.push("La moyenne 7 jours progresse vs 30 jours: tu peux relever doucement l'objectif.");
    if (t.trend < -0.05) tips.push("La tendance courte baisse: regarde les heures faibles et pousse les offres a forte marge.");
    els.targetInsights.innerHTML = tips.map(function (x) { return '<div class="insight"><span></span>' + escapeHtml(x) + '</div>'; }).join("");
  }

  function renderAnalysis() {
    var s = state.summary || {};
    var t = computeTargets();
    var byHour = Array.isArray(s.byHour) ? s.byHour.slice().sort(function (a, b) { return Number(b.revenue) - Number(a.revenue); }) : [];
    var bestHour = byHour[0];
    var weakHour = byHour.length ? byHour[byHour.length - 1] : null;
    var topProducts = Array.isArray(s.productResults) ? s.productResults.slice(0, 8) : [];
    els.objectiveStack.innerHTML = [
      '<div class="objective"><span>Objectif jour</span><strong>' + fmtMoney(t.targetDaily, true) + '</strong><small>Base: moyenne 7j, 30j et jour de semaine.</small></div>',
      '<div class="objective"><span>Objectif periode</span><strong>' + fmtMoney(t.targetPeriod, true) + '</strong><small>' + t.selectedDays + ' jour(s) analyses.</small></div>',
      '<div class="objective"><span>CA moyen 7j</span><strong>' + fmtMoney(t.avg7, true) + '</strong><small>Signal court terme.</small></div>',
      '<div class="objective"><span>CA moyen 30j</span><strong>' + fmtMoney(t.avg30, true) + '</strong><small>Socle de pilotage.</small></div>',
    ].join("");
    var feed = [];
    feed.push({ title: t.performance >= 1 ? "Objectif depasse" : "Objectif a travailler", text: t.performance >= 1 ? "Le CA depasse la cible calculee. Priorite: garder la qualite et eviter les ruptures." : "Le CA est sous la cible. Priorite: concentrer les actions sur les heures fortes et les produits avec marge." });
    if (bestHour) feed.push({ title: "Heure la plus forte", text: bestHour.hour + "h genere " + fmtMoney(bestHour.revenue, true) + ". Place les offres premium autour de ce pic." });
    if (weakHour) feed.push({ title: "Heure faible", text: weakHour.hour + "h est en retrait. Teste une offre courte ou une animation pour relancer." });
    if (topProducts[0]) feed.push({ title: "Produit moteur", text: topProducts[0].name + " domine avec " + fmtMoney(topProducts[0].revenue, true) + ". Verifie stock et marge." });
    els.analysisFeed.innerHTML = feed.map(function (x) { return '<article class="feed-card"><strong>' + escapeHtml(x.title) + '</strong><p>' + escapeHtml(x.text) + '</p></article>'; }).join("");
    renderBarChart(els.weekdayChart, (s.byWeekday || []).map(function (x) { return { label: weekdayNames[Number(x.weekday)] || "-", value: Number(x.revenue || 0), hint: fmtMoney(x.revenue) }; }), "money");
    els.topProductsList.innerHTML = topProducts.length ? topProducts.map(function (p, i) { return '<div class="rank-row"><span>' + (i + 1) + '</span><div><strong>' + escapeHtml(p.name) + '</strong><small>' + escapeHtml(p.category || "Sans categorie") + ' - ' + fmtNumber(p.qty, 0) + ' unites</small></div><em>' + fmtMoney(p.profit) + '</em></div>'; }).join("") : '<p class="empty">Aucun produit vendu sur cette periode.</p>';
  }

  function groupProductsByCategory(rows) {
    var map = {};
    rows.forEach(function (p) {
      var key = p.category || "Sans categorie";
      map[key] = (map[key] || 0) + Number(p.revenue || 0);
    });
    return Object.keys(map).map(function (k) { return { label: k, value: map[k], hint: fmtMoney(map[k]) }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
  }

  function renderBarChart(el, rows) {
    rows = (rows || []).filter(function (x) { return x && Number.isFinite(Number(x.value)); });
    if (!rows.length) {
      el.innerHTML = '<div class="empty chart-empty">Aucune donnee pour ce graphique.</div>';
      return;
    }
    var max = rows.reduce(function (m, x) { return Math.max(m, Number(x.value || 0)); }, 0) || 1;
    el.innerHTML = '<div class="bar-chart">' + rows.map(function (x, i) {
      var h = Math.max(4, Math.round((Number(x.value || 0) / max) * 100));
      return '<div class="bar-col" style="--i:' + i + '"><div class="bar-tip">' + escapeHtml(x.hint || fmtNumber(x.value)) + '</div><span class="bar" style="height:' + h + '%"></span><small>' + escapeHtml(x.label) + '</small></div>';
    }).join("") + '</div>';
  }

  function renderMiniBars(el, rows) {
    rows = rows || [];
    if (!rows.length) {
      el.innerHTML = '<p class="empty">Aucune donnee.</p>';
      return;
    }
    var max = rows.reduce(function (m, x) { return Math.max(m, Number(x.value || 0)); }, 0) || 1;
    el.innerHTML = rows.map(function (x) {
      var pct = Math.round((Number(x.value || 0) / max) * 100);
      return '<div class="mini-bar"><div><strong>' + escapeHtml(x.label) + '</strong><span>' + escapeHtml(x.hint || fmtMoney(x.value)) + '</span></div><i style="width:' + pct + '%"></i></div>';
    }).join("");
  }

  function tableHtml(columns, rows, empty) {
    if (!rows.length) return '<div class="empty table-empty">' + escapeHtml(empty || "Aucune donnee") + '</div>';
    return '<div class="table-scroll"><table><thead><tr>' + columns.map(function (c) { return '<th>' + escapeHtml(c.label) + '</th>'; }).join("") + '</tr></thead><tbody>' + rows.map(function (row) {
      return '<tr>' + columns.map(function (c) { return '<td data-label="' + escapeHtml(c.label) + '">' + row[c.key] + '</td>'; }).join("") + '</tr>';
    }).join("") + '</tbody></table></div>';
  }

  function renderSales() {
    var rows = state.sales.items.map(function (s) {
      return {
        id: '#' + escapeHtml(s.id_sale),
        date: escapeHtml(fmtDateTime(s.last_updated)),
        amount: '<strong>' + escapeHtml(fmtMoney(s.total_amount)) + '</strong>',
        items: escapeHtml(fmtNumber(s.items_count, 0)),
        user: escapeHtml(s.username || '-'),
        actions: '<div class="row-actions"><button class="btn btn-soft" data-sale-view="' + escapeHtml(s.id_sale) + '">Voir</button></div>',
      };
    });
    els.salesTable.innerHTML = tableHtml([
      { key: "id", label: "ID" }, { key: "date", label: "Date" }, { key: "amount", label: "CA" }, { key: "items", label: "Qte" }, { key: "user", label: "User" }, { key: "actions", label: "Actions" },
    ], rows, "Aucune vente sur cette periode.");
    renderPager("sales", state.sales, els.salesPage, els.salesPrev, els.salesNext);
  }

  function openInfoModal(title, html) {
    var root = document.createElement("div");
    root.className = "modal-backdrop";
    root.innerHTML = '<div class="modal-panel" role="dialog" aria-modal="true"><div class="modal-head"><h2>' + escapeHtml(title) + '</h2><button class="btn btn-soft" data-close>Fermer</button></div><div class="modal-body" data-info-body>' + html + '<div class="modal-actions"><button type="button" class="btn btn-primary" data-close>Fermer</button></div></div></div>';
    els.modalRoot.appendChild(root);
    function close() { root.remove(); }
    all("[data-close]", root).forEach(function (btn) { btn.addEventListener("click", close); });
    root.addEventListener("click", function (e) { if (e.target === root) close(); });
    return {
      root: root,
      close: close,
      setBody: function (nextHtml) {
        var body = root.querySelector("[data-info-body]");
        if (body) body.innerHTML = nextHtml + '<div class="modal-actions"><button type="button" class="btn btn-primary" data-close>Fermer</button></div>';
        all("[data-close]", root).forEach(function (btn) { btn.addEventListener("click", close); });
      },
    };
  }

  function saleDetailsHtml(data) {
    var sale = data && data.sale ? data.sale : {};
    var details = Array.isArray(data && data.details) ? data.details : [];
    var qtyTotal = details.reduce(function (acc, d) { return acc + Number(d.quantity || 0); }, 0);
    var computedTotal = details.reduce(function (acc, d) {
      var line = d.total_price == null ? Number(d.price || 0) * Number(d.quantity || 0) : Number(d.total_price || 0);
      return acc + (Number.isFinite(line) ? line : 0);
    }, 0);
    var rows = details.map(function (d) {
      var lineTotal = d.total_price == null ? Number(d.price || 0) * Number(d.quantity || 0) : Number(d.total_price || 0);
      return {
        product: '<strong>' + escapeHtml(d.product_name || ('Produit #' + d.product_id)) + '</strong><small>ID produit: ' + escapeHtml(d.product_id || '-') + '</small>',
        qty: escapeHtml(fmtNumber(d.quantity, 2)),
        unit: escapeHtml(fmtMoney(d.price)),
        total: '<strong>' + escapeHtml(fmtMoney(lineTotal)) + '</strong>',
      };
    });
    return '<div class="sale-detail-grid">' +
      '<article class="detail-stat"><span>Vente</span><strong>#' + escapeHtml(sale.id_sale || '-') + '</strong><small>' + escapeHtml(fmtDateTime(sale.last_updated)) + '</small></article>' +
      '<article class="detail-stat"><span>CA</span><strong>' + escapeHtml(fmtMoney(sale.total_amount == null ? computedTotal : sale.total_amount)) + '</strong><small>Total encaisse</small></article>' +
      '<article class="detail-stat"><span>Articles</span><strong>' + escapeHtml(fmtNumber(qtyTotal, 0)) + '</strong><small>' + escapeHtml(details.length) + ' ligne(s)</small></article>' +
      '<article class="detail-stat"><span>Utilisateur</span><strong>' + escapeHtml(sale.username || '-') + '</strong><small>ID: ' + escapeHtml(sale.user_id || '-') + '</small></article>' +
      '</div>' +
      (sale.notes ? '<article class="note-box"><span>Notes techniques</span><p>' + escapeHtml(sale.notes) + '</p></article>' : '') +
      tableHtml([
        { key: "product", label: "Produit" },
        { key: "qty", label: "Qte" },
        { key: "unit", label: "Prix unit." },
        { key: "total", label: "Total" },
      ], rows, "Aucun detail pour cette vente.");
  }

  async function openSaleDetailsModal(saleId) {
    var modal = openInfoModal("Details vente #" + saleId, '<div class="loading-card">Chargement des lignes de vente...</div>');
    try {
      var query = state.filters.category ? { category: state.filters.category } : {};
      var data = await api('/sales/' + encodeURIComponent(saleId), { query: query });
      modal.setBody(saleDetailsHtml(data));
    } catch (err) {
      modal.setBody('<p class="form-error">' + escapeHtml(err && err.message ? err.message : 'Impossible de charger la vente') + '</p>');
    }
  }

  function renderProducts() {
    var rows = state.productsPage.items.map(function (p) {
      var stockClass = Number(p.quantity || 0) <= 5 ? "badge negative" : "badge positive";
      return {
        name: '<strong>' + escapeHtml(p.name) + '</strong><small>' + escapeHtml(p.description || '') + '</small>',
        type: '<span class="badge">' + escapeHtml(p.productType || 'Sans categorie') + '</span>',
        buy: escapeHtml(fmtMoney(p.purchasePrice)),
        sell: escapeHtml(fmtMoney(p.price)),
        stock: '<span class="' + stockClass + '">' + escapeHtml(fmtNumber(p.quantity, 0)) + '</span>',
        code: escapeHtml(p.barcode || p.reference || '-'),
        actions: '<div class="row-actions"><button class="btn btn-soft" data-product-edit="' + p.id + '">Modifier</button><button class="btn btn-danger" data-product-delete="' + p.id + '">Supprimer</button></div>',
      };
    });
    els.productsTable.innerHTML = tableHtml([
      { key: "name", label: "Produit" }, { key: "type", label: "Categorie" }, { key: "buy", label: "Achat" }, { key: "sell", label: "Vente" }, { key: "stock", label: "Stock" }, { key: "code", label: "Code" }, { key: "actions", label: "Actions" },
    ], rows, "Aucun produit trouve.");
    renderPager("productsPage", state.productsPage, els.productsPageLabel, els.productsPrev, els.productsNext);
  }

  function renderOffers() {
    var rows = state.offers.map(function (o) {
      return {
        name: '<strong>' + escapeHtml(o.name) + '</strong>',
        qty: escapeHtml(fmtNumber(o.quantity, 0)),
        price: escapeHtml(fmtMoney(o.price)),
        products: escapeHtml((o.productIds || []).join(', ') || '-'),
        actions: '<div class="row-actions"><button class="btn btn-soft" data-offer-edit="' + o.id + '">Modifier</button><button class="btn btn-danger" data-offer-delete="' + o.id + '">Supprimer</button></div>',
      };
    });
    els.offersTable.innerHTML = tableHtml([
      { key: "name", label: "Offre" }, { key: "qty", label: "Qte" }, { key: "price", label: "Prix" }, { key: "products", label: "Produits" }, { key: "actions", label: "Actions" },
    ], rows, "Aucune offre trouvee.");
  }

  function renderPurchases() {
    var summary = state.purchaseSummary || { total: 0, count: 0, byCategory: [] };
    els.purchaseKpis.innerHTML = '<div class="purchase-stat"><span>Total achats</span><strong>' + fmtMoney(summary.total) + '</strong></div><div class="purchase-stat"><span>Operations</span><strong>' + fmtNumber(summary.count, 0) + '</strong></div>';
    renderMiniBars(els.purchaseCategoryChart, (summary.byCategory || []).map(function (x) { return { label: x.categoryLabel || x.category, value: Number(x.amount || 0), hint: fmtMoney(x.amount) }; }));
    var rows = state.purchases.items.map(function (p) {
      return {
        date: escapeHtml(p.purchaseDate || '-'),
        label: '<strong>' + escapeHtml(p.label) + '</strong><small>' + escapeHtml([p.supplier, p.notes].filter(Boolean).join(' - ')) + '</small>',
        category: '<span class="badge">' + escapeHtml(p.categoryLabel) + '</span>',
        amount: '<strong>' + escapeHtml(fmtMoney(p.amount)) + '</strong>',
        stock: p.applyStock ? '<span class="badge positive">+' + escapeHtml(fmtNumber(p.stockQuantity, 0)) + ' stock</span>' : '<span class="badge">-</span>',
        user: escapeHtml(p.assignedUsername || '-'),
        actions: '<div class="row-actions"><button class="btn btn-soft" data-purchase-edit="' + p.id + '">Modifier</button><button class="btn btn-danger" data-purchase-delete="' + p.id + '">Supprimer</button></div>',
      };
    });
    els.purchasesTable.innerHTML = tableHtml([
      { key: "date", label: "Date" }, { key: "label", label: "Achat" }, { key: "category", label: "Categorie" }, { key: "amount", label: "Montant" }, { key: "stock", label: "Stock" }, { key: "user", label: "Attribue" }, { key: "actions", label: "Actions" },
    ], rows, "Aucun achat sur cette periode.");
    renderPager("purchases", state.purchases, els.purchasesPage, els.purchasesPrev, els.purchasesNext);
  }

  function boxingTypeLabel(type) {
    return type === "expense" ? "Frais" : "Revenu";
  }

  function boxingCategoryLabel(value) {
    var found = (state.boxingMeta.categories || []).find(function (c) { return c.value === value; });
    return found ? found.label : (value || "Autre");
  }

  function boxingStatusLabel(value) {
    var found = (state.boxingMeta.statuses || []).find(function (s) { return s.value === value; });
    return found ? found.label : (value || "Active");
  }

  function renderBoxingMachineFilter() {
    if (!els.boxingFilterMachine) return;
    var selected = state.boxingEntries.machineId || "";
    els.boxingFilterMachine.innerHTML = '<option value="">Toutes les machines</option>' + state.boxingMachines.map(function (m) {
      var label = m.name + (m.locationName ? " - " + m.locationName : "");
      return '<option value="' + escapeHtml(m.id) + '"' + (String(selected) === String(m.id) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join("");
    els.boxingFilterMachine.value = selected;
  }

  function boxingMachineOptions(selected) {
    return optionsHtml(state.boxingMachines.map(function (m) {
      return { value: m.id, label: m.name + (m.locationName ? " - " + m.locationName : "") };
    }), "value", "label", selected, "Selectionner une machine");
  }

  function boxingCategoryOptions(type, selected) {
    var cats = (state.boxingMeta.categories || []).filter(function (c) { return !type || c.type === type; });
    return optionsHtml(cats.map(function (c) { return { value: c.value, label: c.label }; }), "value", "label", selected, "Selectionner une categorie");
  }

  function renderBoxing() {
    if (!els.boxingKpis) return;
    renderBoxingMachineFilter();
    var summary = state.boxingSummary || { kpis: {}, byDay: [], byMachine: [], byCategory: [] };
    var k = summary.kpis || {};
    var netStatus = Number(k.net || 0) >= 0 ? "positive" : "negative";
    els.boxingKpis.innerHTML =
      '<div class="purchase-stat"><span>Revenus boxe</span><strong>' + fmtMoney(k.revenue || 0) + '</strong></div>' +
      '<div class="purchase-stat"><span>Frais boxe</span><strong>' + fmtMoney(k.expenses || 0) + '</strong></div>' +
      '<div class="purchase-stat ' + netStatus + '"><span>Resultat net</span><strong>' + fmtMoney(k.net || 0) + '</strong></div>' +
      '<div class="purchase-stat"><span>ROI</span><strong>' + (k.roiPercent == null ? '-' : fmtNumber(k.roiPercent, 1) + '%') + '</strong></div>' +
      '<div class="purchase-stat"><span>Moyenne / jour</span><strong>' + fmtMoney(k.avgDailyRevenue || 0) + '</strong></div>' +
      '<div class="purchase-stat"><span>Machines</span><strong>' + fmtNumber(k.machinesCount || state.boxingMachines.length, 0) + '</strong></div>';

    renderMiniBars(els.boxingCategoryChart, (summary.byCategory || []).slice(0, 8).map(function (x) {
      var sign = x.type === "expense" ? "Frais: " : "Revenu: ";
      return { label: sign + (x.categoryLabel || boxingCategoryLabel(x.category)), value: Math.abs(Number(x.amount || 0)), hint: fmtMoney(x.amount || 0) };
    }));
    renderMiniBars(els.boxingMachineChart, (summary.byMachine || []).slice(0, 10).map(function (m) {
      var net = Number(m.net || 0);
      var perf = m.performance == null ? "" : " | obj. " + fmtNumber(m.performance, 0) + "%";
      return { label: m.name + (m.locationName ? " - " + m.locationName : ""), value: Math.abs(net), hint: fmtMoney(net) + perf };
    }));
    renderBarChart(els.boxingDailyChart, (summary.byDay || []).map(function (d) {
      return { label: String(d.date).slice(5), value: Math.abs(Number(d.net || 0)), hint: "Net " + fmtMoney(d.net || 0) + " | CA " + fmtMoney(d.revenue || 0) + " | Frais " + fmtMoney(d.expenses || 0) };
    }));

    var periodMachines = {};
    (summary.byMachine || []).forEach(function (m) { periodMachines[Number(m.id || m.id_machine)] = m; });
    var machineRows = state.boxingMachines.map(function (base) {
      var m = Object.assign({}, base, periodMachines[base.id] || {});
      var perf = m.performance == null ? "" : '<small>Objectif periode: ' + escapeHtml(fmtNumber(m.performance, 0)) + '%</small>';
      return {
        machine: '<strong>' + escapeHtml(m.name) + '</strong><small>' + escapeHtml(m.serialNumber || 'Sans numero') + '</small>',
        location: '<strong>' + escapeHtml(m.locationName || '-') + '</strong><small>' + escapeHtml(m.placementType || '') + '</small>',
        invest: escapeHtml(fmtMoney(m.purchasePrice)),
        net: '<span class="badge ' + (Number(m.net || 0) >= 0 ? 'positive' : 'negative') + '">' + escapeHtml(fmtMoney(m.net || 0)) + '</span>' + perf,
        status: '<span class="badge">' + escapeHtml(boxingStatusLabel(m.status)) + '</span>',
        actions: '<div class="row-actions"><button class="btn btn-soft" data-boxing-machine-edit="' + m.id + '">Modifier</button><button class="btn btn-danger" data-boxing-machine-delete="' + m.id + '">Archiver</button></div>',
      };
    });
    els.boxingMachinesTable.innerHTML = tableHtml([
      { key: "machine", label: "Machine" },
      { key: "location", label: "Emplacement" },
      { key: "invest", label: "Invest." },
      { key: "net", label: "Net" },
      { key: "status", label: "Statut" },
      { key: "actions", label: "Actions" },
    ], machineRows, "Aucune machine de boxe enregistree.");

    var entryRows = state.boxingEntries.items.map(function (e) {
      return {
        date: escapeHtml(e.entryDate || '-'),
        machine: '<strong>' + escapeHtml(e.machineName || ('Machine #' + e.machineId)) + '</strong><small>' + escapeHtml(e.locationName || '') + '</small>',
        type: '<span class="badge ' + (e.type === "expense" ? 'negative' : 'positive') + '">' + escapeHtml(boxingTypeLabel(e.type)) + '</span>',
        label: '<strong>' + escapeHtml(e.label) + '</strong><small>' + escapeHtml(e.categoryLabel || boxingCategoryLabel(e.category)) + '</small>',
        amount: '<strong>' + escapeHtml(fmtMoney(e.amount)) + '</strong>',
        actions: '<div class="row-actions"><button class="btn btn-soft" data-boxing-entry-edit="' + e.id + '">Modifier</button><button class="btn btn-danger" data-boxing-entry-delete="' + e.id + '">Supprimer</button></div>',
      };
    });
    els.boxingEntriesTable.innerHTML = tableHtml([
      { key: "date", label: "Date" },
      { key: "machine", label: "Machine" },
      { key: "type", label: "Type" },
      { key: "label", label: "Libelle" },
      { key: "amount", label: "Montant" },
      { key: "actions", label: "Actions" },
    ], entryRows, "Aucun mouvement boxe sur cette periode.");
    renderPager("boxingEntries", state.boxingEntries, els.boxingEntriesPage, els.boxingEntriesPrev, els.boxingEntriesNext);
  }

  function renderUsers() {
    if (!els.usersTable) return;
    if (els.usersArchiveToggle) {
      els.usersArchiveToggle.textContent = state.usersPage.archived ? "Voir actifs" : "Archives";
      els.usersArchiveToggle.classList.toggle("active", !!state.usersPage.archived);
      els.usersArchiveToggle.style.display = currentUserIsAdmin() ? "" : "none";
    }
    var q = String(state.usersPage.q || "").toLowerCase();
    var filtered = state.users.filter(function (u) {
      var hay = [u.username, u.archivedReason].concat(u.roleTokens || []).join(" ").toLowerCase();
      return !q || hay.indexOf(q) !== -1;
    });
    var rows = filtered.map(function (u) {
      var primaryRole = (u.roleTokens && u.roleTokens[0]) || "cashier";
      var actions = '<button class="btn btn-soft" data-user-edit="' + u.id + '">Modifier</button>';
      if (currentUserIsAdmin()) {
        actions += u.isArchived
          ? '<button class="btn btn-primary" data-user-restore="' + u.id + '">Restaurer</button>'
          : '<button class="btn btn-danger" data-user-archive="' + u.id + '">Archiver</button>';
      }
      return {
        username: '<strong>' + escapeHtml(u.username) + '</strong><small>ID utilisateur: ' + escapeHtml(u.id) + '</small>',
        role: '<span class="badge">' + escapeHtml(roleLabel(primaryRole)) + '</span><small>' + escapeHtml((u.roleTokens || []).map(roleLabel).join(', ') || '-') + '</small>',
        status: u.isArchived ? '<span class="badge negative">Archive</span><small>' + escapeHtml(u.archivedAt ? fmtDateTime(u.archivedAt) : '') + '</small>' : (u.isActive ? '<span class="badge positive">Actif</span>' : '<span class="badge negative">Desactive</span>'),
        login: escapeHtml(u.lastLogin ? fmtDateTime(u.lastLogin) : 'Jamais'),
        actions: '<div class="row-actions">' + actions + '</div>',
      };
    });
    els.usersTable.innerHTML = tableHtml([
      { key: "username", label: "Utilisateur" },
      { key: "role", label: "Role" },
      { key: "status", label: "Statut" },
      { key: "login", label: "Derniere connexion" },
      { key: "actions", label: "Actions" },
    ], rows, "Aucun utilisateur trouve.");
  }

  function renderLinkPages() {
    if (!els.linkPagesTable) return;
    if (els.linkPagesAdd) els.linkPagesAdd.style.display = currentUserCanWrite() ? "" : "none";
    var canWrite = currentUserCanWrite();
    var rows = state.linkPages.items.map(function (p) {
      var linksCount = Array.isArray(p.links) ? p.links.length : 0;
      var actions = '<button class="btn btn-soft" data-link-page-copy="' + p.id + '">Copier lien</button>' +
        '<button class="btn btn-soft" data-link-page-open="' + p.id + '">Ouvrir</button>' +
        '<button class="btn btn-primary" data-link-page-qr="' + p.id + '">QR PNG</button>';
      if (canWrite) {
        actions += '<button class="btn btn-soft" data-link-page-edit="' + p.id + '">Modifier</button>';
        actions += p.isActive
          ? '<button class="btn btn-danger" data-link-page-disable="' + p.id + '">Desactiver</button>'
          : '<button class="btn btn-primary" data-link-page-enable="' + p.id + '">Reactiver</button>';
      }
      return {
        page: '<strong>' + escapeHtml(p.title) + '</strong><small>/' + escapeHtml(p.slug) + '</small>',
        type: '<span class="badge">' + escapeHtml(pageTypeLabel(p.pageType)) + '</span>',
        contact: '<span>' + escapeHtml(p.email || '-') + '</span><small>' + escapeHtml(p.phone || '') + '</small>',
        links: '<span class="badge">' + linksCount + ' lien(s)</span>',
        status: p.isActive ? '<span class="badge positive">Active</span>' : '<span class="badge negative">Desactivee</span>',
        updated: escapeHtml(p.updatedAt ? fmtDateTime(p.updatedAt) : '-'),
        actions: '<div class="row-actions">' + actions + '</div>',
      };
    });
    els.linkPagesTable.innerHTML = tableHtml([
      { key: "page", label: "Page" },
      { key: "type", label: "Type" },
      { key: "contact", label: "Contact" },
      { key: "links", label: "Liens" },
      { key: "status", label: "Statut" },
      { key: "updated", label: "Modifiee" },
      { key: "actions", label: "Actions" },
    ], rows, "Aucune page QR client.");
    renderPager("linkPages", state.linkPages, els.linkPagesPage, els.linkPagesPrev, els.linkPagesNext);
  }

  function renderPager(key, pageState, label, prev, next) {
    var start = pageState.total ? pageState.offset + 1 : 0;
    var end = Math.min(pageState.total, pageState.offset + PAGE_SIZE);
    label.textContent = start + "-" + end + " / " + pageState.total;
    prev.disabled = pageState.offset <= 0;
    next.disabled = pageState.offset + PAGE_SIZE >= pageState.total;
  }

  function renderRequestLog() {
    if (!els.requestLog) return;
    els.requestLog.innerHTML = state.log.length ? state.log.map(function (l) {
      return '<li class="' + (l.ok ? 'ok' : l.status === '...' ? '' : 'err') + '"><span>' + escapeHtml(l.at.toLocaleTimeString('fr-FR', { hour12: false })) + '</span><strong>' + escapeHtml(l.method || 'GET') + '</strong><em>' + escapeHtml(l.status) + '</em><small>' + escapeHtml(l.ms == null ? '' : l.ms + 'ms') + '</small><code>' + escapeHtml(l.path || '') + '</code></li>';
    }).join("") : '<li class="empty">Aucune requete journalisee.</li>';
  }

  function optionsHtml(items, valueKey, labelKey, selected, emptyLabel) {
    var html = emptyLabel == null ? "" : '<option value="">' + escapeHtml(emptyLabel) + '</option>';
    return html + (items || []).map(function (item) {
      var value = String(item[valueKey]);
      var label = String(item[labelKey]);
      return '<option value="' + escapeHtml(value) + '"' + (String(selected || "") === value ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join("");
  }

  function productCategoryOptions(selected) {
    var cats = state.categories.slice();
    if (selected && cats.indexOf(selected) === -1) cats.unshift(selected);
    return optionsHtml(cats.map(function (c) { return { value: c, label: c }; }), "value", "label", selected, "Sans categorie");
  }

  function productOptions(selected) {
    return optionsHtml(state.products.map(function (p) { return { value: p.id, label: p.name + (p.barcode ? " - " + p.barcode : "") }; }), "value", "label", selected, "Aucun produit lie");
  }

  function userOptions(selected) {
    return optionsHtml(state.users.map(function (u) { return { value: u.id, label: u.username }; }), "value", "label", selected, "Non attribue");
  }

  function openModal(title, html, submitLabel, onSubmit) {
    var root = document.createElement("div");
    root.className = "modal-backdrop";
    root.innerHTML = '<div class="modal-panel" role="dialog" aria-modal="true"><div class="modal-head"><h2>' + escapeHtml(title) + '</h2><button class="btn btn-soft" data-close>Fermer</button></div><form class="modal-body">' + html + '<p class="form-error" data-error></p><div class="modal-actions"><button type="button" class="btn btn-soft" data-close>Annuler</button><button type="submit" class="btn btn-primary" data-submit>' + escapeHtml(submitLabel || "Enregistrer") + '</button></div></form></div>';
    els.modalRoot.appendChild(root);
    var form = root.querySelector("form");
    var submit = root.querySelector("[data-submit]");
    var error = root.querySelector("[data-error]");
    function close() { root.remove(); }
    all("[data-close]", root).forEach(function (btn) { btn.addEventListener("click", close); });
    root.addEventListener("click", function (e) { if (e.target === root) close(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      (async function () {
        error.textContent = "";
        setBusy(submit, true, "Sauvegarde...");
        try {
          await onSubmit(form);
          close();
        } catch (err) {
          error.textContent = err && err.message ? err.message : "Erreur sauvegarde";
        } finally {
          setBusy(submit, false, submitLabel || "Enregistrer");
        }
      })();
    });
    setTimeout(function () { var first = root.querySelector("input,select,textarea"); if (first) first.focus(); }, 50);
    return { root: root, close: close };
  }

  function field(label, name, value, type, extra) {
    return '<label class="field"><span>' + escapeHtml(label) + '</span><input name="' + escapeHtml(name) + '" type="' + escapeHtml(type || 'text') + '" value="' + escapeHtml(value == null ? '' : value) + '" ' + (extra || '') + ' /></label>';
  }

  function openBoxingMachineModal(item) {
    item = item || null;
    var statusOptions = optionsHtml((state.boxingMeta.statuses || []).map(function (s) {
      return { value: s.value, label: s.label };
    }), "value", "label", item ? item.status : "active", null);
    var html = '<div class="form-grid two">' +
      field('Nom machine *', 'name', item && item.name, 'text', 'required placeholder="Ex: Boxing machine 01"') +
      field('Numero serie', 'serialNumber', item && item.serialNumber, 'text', 'placeholder="Optionnel"') +
      field('Lieu *', 'locationName', item && item.locationName, 'text', 'required placeholder="Ex: Cafe Emir, Centre commercial..."') +
      field('Adresse', 'locationAddress', item && item.locationAddress, 'text', 'placeholder="Adresse ou repere"') +
      field('Type placement', 'placementType', item && item.placementType || 'depot', 'text', 'placeholder="depot, partage, location..."') +
      field('Contact partenaire', 'ownerContact', item && item.ownerContact, 'text', 'placeholder="Nom / telephone"') +
      field('Prix achat machine', 'purchasePrice', item && item.purchasePrice, 'number', 'step="0.01" min="0"') +
      field('Date installation', 'installDate', item && item.installDate, 'date') +
      field('% reversement partenaire', 'revenueSharePercent', item && item.revenueSharePercent, 'number', 'step="0.01" min="0" max="100"') +
      field('Objectif CA / jour', 'targetDailyRevenue', item && item.targetDailyRevenue, 'number', 'step="0.01" min="0"') +
      '<label class="field"><span>Statut</span><select name="status">' + statusOptions + '</select></label>' +
      '<label class="field full"><span>Notes</span><textarea name="notes" rows="4" placeholder="Conditions, cle, proprietaire, particularites...">' + escapeHtml(item && item.notes || '') + '</textarea></label>' +
      '</div>';
    openModal(item ? 'Modifier machine boxe' : 'Ajouter machine boxe', html, item ? 'Enregistrer' : 'Creer', async function (form) {
      var payload = {
        name: form.elements.name.value.trim(),
        serialNumber: form.elements.serialNumber.value.trim(),
        locationName: form.elements.locationName.value.trim(),
        locationAddress: form.elements.locationAddress.value.trim(),
        placementType: form.elements.placementType.value.trim(),
        ownerContact: form.elements.ownerContact.value.trim(),
        purchasePrice: parseNumberInput(form.elements.purchasePrice.value) || 0,
        installDate: form.elements.installDate.value || null,
        revenueSharePercent: parseNumberInput(form.elements.revenueSharePercent.value) || 0,
        targetDailyRevenue: parseNumberInput(form.elements.targetDailyRevenue.value) || 0,
        status: form.elements.status.value,
        notes: form.elements.notes.value,
      };
      if (!payload.name) throw new Error("Nom machine requis.");
      if (!payload.locationName) throw new Error("Lieu requis.");
      if (Number.isNaN(payload.purchasePrice) || Number.isNaN(payload.revenueSharePercent) || Number.isNaN(payload.targetDailyRevenue)) throw new Error("Montant invalide.");
      if (item) await writeWithFallback({ path: '/boxing/machines/' + item.id, method: 'PATCH' }, { path: '/boxing/machines/' + item.id + '/update-q' }, payload);
      else await writeWithFallback({ path: '/boxing/machines', method: 'POST' }, { path: '/boxing/machines/create-q' }, payload);
      showToast(item ? 'Machine modifiee.' : 'Machine creee.', 'success');
      await loadBoxing();
    });
  }

  function openBoxingEntryModal(item) {
    item = item || null;
    if (!state.boxingMachines.length) {
      showToast("Ajoute d'abord une machine de boxe.", "error");
      return;
    }
    var entryType = item ? item.type : "revenue";
    var html = '<div class="form-grid two boxing-entry-form">' +
      '<label class="field"><span>Machine *</span><select name="machineId" required>' + boxingMachineOptions(item && item.machineId) + '</select></label>' +
      field('Date *', 'entryDate', item && item.entryDate || todayIso(), 'date', 'required') +
      '<label class="field"><span>Type</span><select name="type"><option value="revenue"' + (entryType === "revenue" ? ' selected' : '') + '>Revenu</option><option value="expense"' + (entryType === "expense" ? ' selected' : '') + '>Frais</option></select></label>' +
      '<label class="field"><span>Categorie</span><select name="category">' + boxingCategoryOptions(entryType, item && item.category) + '</select></label>' +
      field('Libelle *', 'label', item && item.label, 'text', 'required placeholder="Ex: collecte semaine 12, maintenance monnayeur..."') +
      field('Montant *', 'amount', item && item.amount, 'number', 'step="0.01" min="0" required') +
      field('Paiement', 'paymentMethod', item && item.paymentMethod, 'text', 'placeholder="cash, virement..."') +
      '<label class="field full"><span>Notes</span><textarea name="notes" rows="4">' + escapeHtml(item && item.notes || '') + '</textarea></label>' +
      '</div>';
    var modal = openModal(item ? 'Modifier mouvement boxe' : 'Ajouter mouvement boxe', html, item ? 'Enregistrer' : 'Creer', async function (form) {
      var payload = {
        machineId: Number(form.elements.machineId.value),
        entryDate: form.elements.entryDate.value,
        type: form.elements.type.value,
        category: form.elements.category.value,
        label: form.elements.label.value.trim(),
        amount: parseNumberInput(form.elements.amount.value),
        paymentMethod: form.elements.paymentMethod.value.trim(),
        notes: form.elements.notes.value,
      };
      if (!payload.machineId) throw new Error("Selectionne une machine.");
      if (!payload.entryDate) throw new Error("Date requise.");
      if (!payload.label) throw new Error("Libelle requis.");
      if (payload.amount == null || Number.isNaN(payload.amount) || payload.amount <= 0) throw new Error("Montant invalide.");
      if (item) await writeWithFallback({ path: '/boxing/entries/' + item.id, method: 'PATCH' }, { path: '/boxing/entries/' + item.id + '/update-q' }, payload);
      else await writeWithFallback({ path: '/boxing/entries', method: 'POST' }, { path: '/boxing/entries/create-q' }, payload);
      showToast(item ? 'Mouvement modifie.' : 'Mouvement ajoute.', 'success');
      await Promise.all([loadBoxingMachines(), loadBoxingSummary(), loadBoxingEntries()]);
    });
    var typeSelect = modal.root.querySelector('select[name="type"]');
    var categorySelect = modal.root.querySelector('select[name="category"]');
    if (typeSelect && categorySelect) {
      typeSelect.addEventListener('change', function () {
        categorySelect.innerHTML = boxingCategoryOptions(typeSelect.value, "");
      });
    }
  }

  async function deleteBoxingMachine(item) {
    if (!item) return;
    if (!window.confirm('Archiver cette machine ? Les mouvements restent conserves pour les statistiques.')) return;
    await api('/boxing/machines/' + item.id, { method: 'DELETE', timeoutMs: 30000 });
    showToast('Machine archivee.', 'success');
    await loadBoxing();
  }

  async function deleteBoxingEntry(item) {
    if (!item) return;
    if (!window.confirm('Supprimer ce mouvement boxe ?')) return;
    await api('/boxing/entries/' + item.id, { method: 'DELETE', timeoutMs: 30000 });
    showToast('Mouvement supprime.', 'success');
    await Promise.all([loadBoxingMachines(), loadBoxingSummary(), loadBoxingEntries()]);
  }

  function userRoleOptions(selected) {
    return availableUserRoleOptions().map(function (role) {
      return '<option value="' + escapeHtml(role.value) + '"' + (String(selected || 'cashier') === role.value ? ' selected' : '') + '>' + escapeHtml(role.label) + '</option>';
    }).join('');
  }

  function openUserModal(item) {
    item = item || null;
    var selectedRole = item && item.roleTokens && item.roleTokens[0] ? item.roleTokens[0] : 'cashier';
    var html = '<div class="form-grid two">' +
      field('Identifiant *', 'username', item && item.username, 'text', 'required autocomplete="username" placeholder="ex: yacine"') +
      '<label class="field"><span>Role</span><select name="role">' + userRoleOptions(selectedRole) + '</select></label>' +
      field(item ? 'Nouveau mot de passe' : 'Mot de passe *', 'password', '', 'password', (item ? 'autocomplete="new-password" placeholder="Laisser vide pour ne pas changer"' : 'required autocomplete="new-password" minlength="8" placeholder="Minimum 8 caracteres"')) +
      '<label class="field"><span>Statut</span><select name="isActive"><option value="1"' + (!item || item.isActive ? ' selected' : '') + '>Actif</option><option value="0"' + (item && !item.isActive ? ' selected' : '') + '>Desactive</option></select></label>' +
      '<div class="user-role-help full">' + availableUserRoleOptions().map(function (role) { return '<article><strong>' + escapeHtml(role.label) + '</strong><span>' + escapeHtml(role.hint) + '</span></article>'; }).join('') + '</div>' +
      '</div>';
    openModal(item ? 'Modifier utilisateur' : 'Creer utilisateur', html, item ? 'Enregistrer' : 'Creer', async function (form) {
      var fields = form.elements;
      var payload = {
        username: fields.username.value.trim(),
        roles: [fields.role.value],
        is_active: fields.isActive.value === '1' ? 1 : 0,
      };
      if (!payload.username) throw new Error('Identifiant requis');
      if (fields.password.value) payload.password = fields.password.value;
      if (!item && !payload.password) throw new Error('Mot de passe requis');
      if (payload.password && payload.password.length < 8) throw new Error('Le mot de passe doit faire au moins 8 caracteres');
      if (item) await api('/users/' + item.id, { method: 'PATCH', body: payload, timeoutMs: 30000 });
      else await api('/users', { method: 'POST', body: payload, timeoutMs: 30000 });
      showToast(item ? 'Utilisateur modifie.' : 'Utilisateur cree. Il peut maintenant se connecter au POS.', 'success');
      await loadUsers();
    });
  }

  async function archiveUserAccount(item) {
    if (!item) return;
    if (!currentUserIsAdmin()) {
      showToast("Seul un administrateur peut archiver un compte.", "error");
      return;
    }
    if (!confirm("Archiver le compte " + item.username + " ? Il ne pourra plus se connecter, mais l'historique sera conserve.")) return;
    await api('/users/' + item.id, { method: 'DELETE', body: { reason: 'Archive depuis dashboard' }, timeoutMs: 30000 });
    showToast("Compte archive.", "success");
    await loadUsers();
  }

  async function restoreUserAccount(item) {
    if (!item) return;
    if (!currentUserIsAdmin()) {
      showToast("Seul un administrateur peut restaurer un compte.", "error");
      return;
    }
    await api('/users/' + item.id + '/restore', { method: 'POST', body: {}, timeoutMs: 30000 });
    showToast("Compte restaure.", "success");
    await loadUsers();
  }

  function linkTypeLabel(value) {
    var found = LINK_TYPE_OPTIONS.find(function (x) { return x.value === value; });
    return found ? found.label : "Lien utile";
  }

  function linkTypeOptions(selected) {
    var known = LINK_TYPE_OPTIONS.some(function (x) { return x.value === selected; });
    var items = known || !selected ? LINK_TYPE_OPTIONS : LINK_TYPE_OPTIONS.concat([{ value: selected, label: selected }]);
    return items.map(function (type) {
      return '<option value="' + escapeHtml(type.value) + '"' + (String(selected || "") === type.value ? ' selected' : '') + '>' + escapeHtml(type.label) + '</option>';
    }).join('');
  }

  function linkEditorRows(item) {
    var existing = item && Array.isArray(item.links) ? item.links.slice(0, 8) : [];
    var rows = existing.map(function (link) {
      return { type: link.type || "website", label: link.label || linkTypeLabel(link.type), url: link.url || "" };
    });
    var used = {};
    rows.forEach(function (link) { used[link.type] = true; });
    LINK_TYPE_OPTIONS.forEach(function (opt) {
      if (rows.length < 8 && !used[opt.value]) rows.push({ type: opt.value, label: opt.label, url: "" });
    });
    return rows.slice(0, 8).map(function (link, index) {
      return '<div class="link-row">' +
        '<select name="linkType' + index + '">' + linkTypeOptions(link.type) + '</select>' +
        '<input name="linkLabel' + index + '" type="text" value="' + escapeHtml(link.label) + '" placeholder="Libelle" />' +
        '<input name="linkUrl' + index + '" type="url" value="' + escapeHtml(link.url) + '" placeholder="https://..." />' +
      '</div>';
    }).join('');
  }

  function openLinkPageModal(item) {
    if (!currentUserCanWrite()) {
      showToast("Seuls les managers et admins peuvent gerer les pages QR.", "error");
      return;
    }
    item = item || null;
    var html = '<div class="form-grid two link-page-form">' +
      field('Nom de la page *', 'title', item && item.title, 'text', 'required placeholder="Come & Game"') +
      field('Slug URL', 'slug', item && item.slug, 'text', 'placeholder="come-and-game"') +
      '<label class="field"><span>Type de page</span><select name="pageType">' + pageTypeOptions(item && item.pageType) + '</select></label>' +
      '<label class="field"><span>Statut</span><select name="isActive"><option value="1"' + (!item || item.isActive ? ' selected' : '') + '>Active</option><option value="0"' + (item && !item.isActive ? ' selected' : '') + '>Desactivee</option></select></label>' +
      field('Sous-titre', 'subtitle', item && item.subtitle, 'text', 'placeholder="Reseaux sociaux et contact"') +
      field('Email', 'email', item && item.email, 'email', 'placeholder="contact@example.com"') +
      field('Telephone', 'phone', item && item.phone, 'tel', 'placeholder="+213..."') +
      '<label class="field full"><span>Description</span><textarea name="description" rows="4" placeholder="Texte optionnel visible sur la page client">' + escapeHtml(item && item.description || '') + '</textarea></label>' +
      '<div class="link-editor full"><strong class="link-editor-title">Liens reseaux</strong><div class="link-editor-head"><span>Type</span><span>Libelle</span><span>URL</span></div>' + linkEditorRows(item) + '</div>' +
      '</div>';
    var modal = openModal(item ? 'Modifier page QR' : 'Creer page QR', html, item ? 'Enregistrer' : 'Creer', async function (form) {
      var fields = form.elements;
      var links = [];
      for (var i = 0; i < 8; i += 1) {
        var typeEl = fields['linkType' + i];
        var labelEl = fields['linkLabel' + i];
        var urlEl = fields['linkUrl' + i];
        if (!typeEl || !urlEl) continue;
        var url = urlEl.value.trim();
        if (!url) continue;
        var type = typeEl.value;
        links.push({ type: type, label: (labelEl && labelEl.value.trim()) || linkTypeLabel(type), url: url });
      }
      var payload = {
        title: fields.title.value.trim(),
        slug: fields.slug.value.trim(),
        pageType: fields.pageType.value,
        subtitle: fields.subtitle.value.trim(),
        description: fields.description.value,
        email: fields.email.value.trim(),
        phone: fields.phone.value.trim(),
        isActive: fields.isActive.value === '1' ? 1 : 0,
        links: links,
      };
      if (!payload.title) throw new Error("Nom de page requis.");
      if (!payload.links.length && !payload.email && !payload.phone) throw new Error("Ajoute au moins un lien, un email ou un telephone.");
      if (item) await api('/link-pages/' + item.id, { method: 'PATCH', body: payload, timeoutMs: 30000 });
      else await api('/link-pages', { method: 'POST', body: payload, timeoutMs: 30000 });
      showToast(item ? 'Page QR modifiee.' : 'Page QR creee.', 'success');
      await loadLinkPages();
    });
    all('.link-row select', modal.root).forEach(function (select) {
      select.addEventListener('change', function () {
        var row = select.closest('.link-row');
        var input = row && row.querySelector('input[name^="linkLabel"]');
        if (input && !input.value.trim()) input.value = linkTypeLabel(select.value);
      });
    });
  }

  async function copyLinkPageUrl(item) {
    if (!item || !item.publicUrl) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(item.publicUrl);
      else {
        var ta = document.createElement('textarea');
        ta.value = item.publicUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showToast('Lien copie.', 'success');
    } catch (_) {
      showToast(item.publicUrl, 'info');
    }
  }

  async function downloadLinkPageQr(item) {
    if (!item) return;
    var blob = await apiBlob('/link-pages/' + item.id + '/qr', { accept: 'image/png' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'qrcode-' + (item.slug || item.id) + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast('QR code telecharge.', 'success');
  }

  async function setLinkPageActive(item, active) {
    if (!item) return;
    await api('/link-pages/' + item.id, { method: 'PATCH', body: { isActive: active ? 1 : 0 }, timeoutMs: 30000 });
    showToast(active ? 'Page reactivee.' : 'Page desactivee.', 'success');
    await loadLinkPages();
  }

  function openProductModal(item) {
    item = item || null;
    var html = '<div class="form-grid two">' +
      field('Nom *', 'name', item && item.name, 'text', 'required') +
      '<label class="field"><span>Categorie</span><select name="productType">' + productCategoryOptions(item && item.productType) + '</select></label>' +
      field('Code barre', 'barcode', item && item.barcode) +
      field('Reference', 'reference', item && item.reference) +
      field('Stock', 'quantity', item && item.quantity, 'number', 'step="1"') +
      field("Prix d'achat", 'purchasePrice', item && item.purchasePrice, 'number', 'step="0.01"') +
      field('Prix de vente', 'price', item && item.price, 'number', 'step="0.01"') +
      field('Lien image', 'imageUrl', item && item.imageUrl, 'url', 'placeholder="https://..."') +
      '<label class="field full"><span>Description</span><textarea name="description" rows="4">' + escapeHtml(item && item.description || '') + '</textarea></label>' +
      '</div>';
    openModal(item ? 'Modifier produit' : 'Ajouter produit', html, item ? 'Enregistrer' : 'Creer', async function (form) {
      var fields = form.elements;
      var payload = {
        name: fields.name.value.trim(),
        productType: fields.productType.value.trim(),
        barcode: fields.barcode.value.trim(),
        reference: fields.reference.value.trim(),
        imageUrl: fields.imageUrl.value.trim(),
        description: fields.description.value,
      };
      if (!payload.name) throw new Error('Nom requis');
      ['quantity', 'purchasePrice', 'price'].forEach(function (k) {
        var n = parseNumberInput(fields[k].value);
        if (Number.isNaN(n)) throw new Error('Valeur invalide: ' + k);
        payload[k] = n;
      });
      if (item) {
        await writeWithFallback({ path: '/products/' + item.id + '/update', method: 'POST' }, { path: '/products/' + item.id + '/update-q' }, payload);
      } else {
        await writeWithFallback({ path: '/products', method: 'POST' }, { path: '/products/create-q' }, payload);
      }
      showToast(item ? 'Produit modifie.' : 'Produit cree.', 'success');
      await Promise.all([loadProductsPage(), loadProductCatalog(), loadCategories(), loadSummary()]);
    });
  }

  function openOfferModal(item) {
    item = item || null;
    var html = '<div class="form-grid two">' +
      field('Nom *', 'name', item && item.name, 'text', 'required') +
      field('Quantite', 'quantity', item && item.quantity, 'number', 'step="1"') +
      field('Prix', 'price', item && item.price, 'number', 'step="0.01"') +
      '<label class="field full"><span>Produits (IDs separes par virgule)</span><input name="productIds" value="' + escapeHtml(item ? (item.productIds || []).join(',') : '') + '" /></label>' +
      '</div>';
    openModal(item ? 'Modifier offre' : 'Ajouter offre', html, item ? 'Enregistrer' : 'Creer', async function (form) {
      var fields = form.elements;
      var payload = {
        name: fields.name.value.trim(),
        quantity: parseNumberInput(fields.quantity.value),
        price: parseNumberInput(fields.price.value),
        productIds: String(fields.productIds.value || '').split(',').map(function (x) { return Number(x.trim()); }).filter(function (x) { return Number.isFinite(x) && x > 0; }),
      };
      if (!payload.name) throw new Error('Nom requis');
      if (Number.isNaN(payload.quantity) || Number.isNaN(payload.price)) throw new Error('Quantite ou prix invalide');
      if (item) await writeWithFallback({ path: '/offers/' + item.id, method: 'PATCH' }, { path: '/offers/' + item.id + '/update-q' }, payload);
      else await writeWithFallback({ path: '/offers', method: 'POST' }, { path: '/offers/create-q' }, payload);
      showToast(item ? 'Offre modifiee.' : 'Offre creee.', 'success');
      await loadOffers();
    });
  }

  function purchaseCategoryInfo(value) {
    var map = {
      stock_alimentaire: { icon: "ST", title: "Alimentaire / stock", hint: "Boissons, snacks et consommables qui peuvent alimenter le stock.", defaultUnit: "pcs" },
      materiel: { icon: "MT", title: "Materiel", hint: "Consoles, manettes, mobilier, equipements ou accessoires durables.", defaultUnit: "pcs" },
      loyer: { icon: "LY", title: "Loyer", hint: "Charges fixes liees au local ou a l'exploitation.", defaultUnit: "mois" },
      service: { icon: "SV", title: "Services", hint: "Prestations, abonnements, logiciels ou services externes.", defaultUnit: "" },
      investissement_depart: { icon: "ID", title: "Investissement de depart", hint: "Apport ou depense de lancement, a attribuer a un utilisateur.", defaultUnit: "" },
      maintenance: { icon: "MX", title: "Maintenance", hint: "Reparations, entretien et interventions techniques.", defaultUnit: "" },
      marketing: { icon: "MK", title: "Marketing", hint: "Communication, publicite, contenus et actions commerciales.", defaultUnit: "" },
      autre: { icon: "AU", title: "Autre", hint: "Achat ponctuel qui ne rentre pas dans les autres categories.", defaultUnit: "" },
    };
    var found = (state.purchaseCategories || []).find(function (c) { return c.value === value; });
    var base = map[value] || { icon: "CG", title: found ? found.label : "Autre", hint: "Classe cet achat pour garder une lecture propre des charges.", defaultUnit: "" };
    if (found && !map[value]) base.title = found.label;
    return base;
  }

  function purchaseCategoryLabel(value) {
    var found = (state.purchaseCategories || []).find(function (c) { return c.value === value; });
    return found ? found.label : purchaseCategoryInfo(value).title;
  }

  function purchaseWizardSteps(step) {
    var labels = ["Type", "Details", "Validation"];
    return '<div class="wizard-steps">' + labels.map(function (label, index) {
      var n = index + 1;
      return '<span class="' + (n === step ? 'active' : n < step ? 'done' : '') + '"><i>' + n + '</i>' + escapeHtml(label) + '</span>';
    }).join("") + '</div>';
  }

  function purchaseCategoryChoices(selected) {
    var preferred = ["stock_alimentaire", "materiel", "investissement_depart", "loyer", "service", "maintenance", "marketing", "autre"];
    var source = state.purchaseCategories && state.purchaseCategories.length ? state.purchaseCategories : preferred.map(function (v) {
      return { value: v, label: purchaseCategoryInfo(v).title };
    });
    var ordered = preferred.map(function (v) { return source.find(function (c) { return c.value === v; }); }).filter(Boolean);
    source.forEach(function (c) { if (!ordered.some(function (x) { return x.value === c.value; })) ordered.push(c); });
    return '<div class="purchase-choice-grid">' + ordered.map(function (c) {
      var info = purchaseCategoryInfo(c.value);
      return '<label class="purchase-choice ' + (selected === c.value ? 'active' : '') + '">' +
        '<input type="radio" name="category" value="' + escapeHtml(c.value) + '"' + (selected === c.value ? ' checked' : '') + ' />' +
        '<strong><em>' + escapeHtml(info.icon) + '</em>' + escapeHtml(c.label || info.title) + '</strong>' +
        '<small>' + escapeHtml(info.hint) + '</small>' +
      '</label>';
    }).join("") + '</div>';
  }

  function purchaseDraftFromItem(item) {
    item = item || {};
    return {
      purchaseDate: item.purchaseDate || todayIso(),
      category: item.category || "",
      label: item.label || "",
      amount: item.amount == null ? "" : item.amount,
      quantity: item.quantity == null ? "" : item.quantity,
      unit: item.unit || "",
      supplier: item.supplier || "",
      paymentMethod: item.paymentMethod || "",
      productId: item.productId || "",
      stockQuantity: item.stockQuantity == null ? "" : item.stockQuantity,
      applyStock: item.applyStock ? 1 : 0,
      assignedUserId: item.assignedUserId || "",
      isStartupInvestment: item.isStartupInvestment ? 1 : 0,
      notes: item.notes || "",
    };
  }

  function readPurchaseDraft(root, draft) {
    var form = root.querySelector("form");
    if (!form || !form.elements) return draft;
    var f = form.elements;
    function read(name, key) { if (f[name]) draft[key || name] = f[name].value; }
    read("category");
    read("purchaseDate");
    read("label");
    read("amount");
    read("quantity");
    read("unit");
    read("supplier");
    read("paymentMethod");
    read("productId");
    read("stockQuantity");
    read("assignedUserId");
    if (f.applyStock) draft.applyStock = f.applyStock.checked ? 1 : 0;
    if (f.isStartupInvestment) draft.isStartupInvestment = f.isStartupInvestment.checked ? 1 : 0;
    if (f.notes) draft.notes = f.notes.value;
    return draft;
  }

  function purchasePayloadFromDraft(draft) {
    var payload = {
      purchaseDate: draft.purchaseDate || todayIso(),
      category: draft.category || "autre",
      label: String(draft.label || "").trim(),
      amount: parseNumberInput(draft.amount),
      quantity: parseNumberInput(draft.quantity),
      unit: String(draft.unit || "").trim(),
      supplier: String(draft.supplier || "").trim(),
      paymentMethod: String(draft.paymentMethod || "").trim(),
      productId: draft.productId ? Number(draft.productId) : null,
      stockQuantity: parseNumberInput(draft.stockQuantity),
      applyStock: draft.applyStock ? 1 : 0,
      assignedUserId: draft.assignedUserId ? Number(draft.assignedUserId) : null,
      isStartupInvestment: draft.isStartupInvestment || draft.category === "investissement_depart" ? 1 : 0,
      notes: draft.notes || "",
    };
    if (!payload.category) throw new Error("Choisis un type d'achat.");
    if (!payload.label) throw new Error("Libelle requis.");
    if (payload.amount == null || Number.isNaN(payload.amount)) throw new Error("Montant invalide.");
    if (Number.isNaN(payload.quantity)) throw new Error("Quantite invalide.");
    if (Number.isNaN(payload.stockQuantity)) throw new Error("Quantite stock invalide.");
    if (payload.applyStock && (!payload.productId || payload.stockQuantity == null || payload.stockQuantity <= 0)) throw new Error("Pour alimenter le stock, selectionne un produit et une quantite.");
    if (payload.isStartupInvestment && !payload.assignedUserId) throw new Error("Attribue l'investissement de depart a un utilisateur.");
    return payload;
  }

  function purchaseStepOneHtml(draft) {
    return purchaseWizardSteps(1) +
      '<div class="wizard-intro"><p class="eyebrow">Classification</p><h3>Quel type d\'achat veux-tu enregistrer ?</h3><p>Cette etape pilote les champs suivants : stock pour l\'alimentaire, utilisateur pour l\'investissement, lecture propre des charges pour le reste.</p></div>' +
      purchaseCategoryChoices(draft.category);
  }

  function purchaseStepTwoHtml(draft) {
    var info = purchaseCategoryInfo(draft.category);
    var showStock = draft.category === "stock_alimentaire" || draft.productId || draft.applyStock;
    var showUser = draft.category === "investissement_depart" || draft.assignedUserId;
    var unit = draft.unit || info.defaultUnit || "";
    return purchaseWizardSteps(2) +
      '<div class="wizard-intro"><p class="eyebrow">' + escapeHtml(purchaseCategoryLabel(draft.category)) + '</p><h3>Details de l\'operation</h3><p>' + escapeHtml(info.hint) + '</p></div>' +
      '<input type="hidden" name="category" value="' + escapeHtml(draft.category) + '" />' +
      '<div class="form-grid two">' +
      field('Date *', 'purchaseDate', draft.purchaseDate || todayIso(), 'date', 'required') +
      field('Libelle *', 'label', draft.label, 'text', 'required placeholder="Ex: achat boissons, loyer avril..."') +
      field('Montant *', 'amount', draft.amount, 'number', 'step="0.01" required') +
      field('Quantite', 'quantity', draft.quantity, 'number', 'step="0.001" placeholder="Optionnel"') +
      field('Unite', 'unit', unit, 'text', 'placeholder="kg, pcs, mois..."') +
      field('Fournisseur', 'supplier', draft.supplier, 'text', 'placeholder="Nom du fournisseur"') +
      field('Paiement', 'paymentMethod', draft.paymentMethod, 'text', 'placeholder="cash, carte, virement..."') +
      (showStock ? '<label class="field"><span>Produit stock lie</span><select name="productId">' + productOptions(draft.productId) + '</select></label>' +
      field('Quantite a ajouter au stock', 'stockQuantity', draft.stockQuantity, 'number', 'step="0.001" placeholder="Ex: 24"') +
      '<label class="toggle full"><input name="applyStock" type="checkbox" ' + (draft.applyStock ? 'checked' : '') + ' /><span>Ajouter cette quantite au stock du produit lie</span></label>' : '') +
      (showUser ? '<label class="field"><span>Utilisateur attribue *</span><select name="assignedUserId">' + userOptions(draft.assignedUserId) + '</select></label>' +
      '<label class="toggle"><input name="isStartupInvestment" type="checkbox" checked /><span>Investissement de depart</span></label>' : '<label class="field"><span>Utilisateur attribue</span><select name="assignedUserId">' + userOptions(draft.assignedUserId) + '</select></label>') +
      '</div>';
  }

  function purchaseStepThreeHtml(draft) {
    var amount = parseNumberInput(draft.amount);
    var stockText = draft.applyStock ? ('+ ' + fmtNumber(parseNumberInput(draft.stockQuantity) || 0, 2) + ' stock') : 'Non';
    var user = state.users.find(function (u) { return String(u.id) === String(draft.assignedUserId); });
    var product = state.products.find(function (p) { return String(p.id) === String(draft.productId); });
    return purchaseWizardSteps(3) +
      '<div class="wizard-intro"><p class="eyebrow">Verification</p><h3>Valide avant enregistrement</h3><p>Tu peux revenir en arriere si une information n\'est pas correcte.</p></div>' +
      '<input type="hidden" name="category" value="' + escapeHtml(draft.category) + '" />' +
      '<div class="review-grid">' +
      '<div><span>Type</span><strong>' + escapeHtml(purchaseCategoryLabel(draft.category)) + '</strong></div>' +
      '<div><span>Date</span><strong>' + escapeHtml(draft.purchaseDate || '-') + '</strong></div>' +
      '<div><span>Libelle</span><strong>' + escapeHtml(draft.label || '-') + '</strong></div>' +
      '<div><span>Montant</span><strong>' + escapeHtml(fmtMoney(amount || 0)) + '</strong></div>' +
      '<div><span>Stock</span><strong>' + escapeHtml(stockText) + '</strong><small>' + escapeHtml(product ? product.name : '') + '</small></div>' +
      '<div><span>Attribue</span><strong>' + escapeHtml(user ? user.username : '-') + '</strong></div>' +
      '</div>' +
      '<label class="field full"><span>Notes</span><textarea name="notes" rows="4" placeholder="Detail utile : facture, contexte, remarque stock...">' + escapeHtml(draft.notes || '') + '</textarea></label>';
  }

  function openPurchaseModal(item) {
    item = item || null;
    var draft = purchaseDraftFromItem(item);
    var step = item ? 2 : 1;
    var root = document.createElement("div");
    root.className = "modal-backdrop";
    root.innerHTML = '<div class="modal-panel purchase-wizard-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>' + escapeHtml(item ? 'Modifier achat' : 'Ajouter achat') + '</h2><button class="btn btn-soft" data-close>Fermer</button></div><form class="modal-body purchase-wizard-body"></form></div>';
    els.modalRoot.appendChild(root);
    var form = root.querySelector("form");
    function close() { root.remove(); }
    function render(errorText) {
      var body = step === 1 ? purchaseStepOneHtml(draft) : step === 2 ? purchaseStepTwoHtml(draft) : purchaseStepThreeHtml(draft);
      form.innerHTML = body +
        '<p class="form-error" data-error>' + escapeHtml(errorText || '') + '</p>' +
        '<div class="modal-actions wizard-actions">' +
        '<button type="button" class="btn btn-soft" data-close>Annuler</button>' +
        (step > 1 ? '<button type="button" class="btn btn-ghost" data-prev>Retour</button>' : '') +
        '<button type="submit" class="btn btn-primary" data-submit>' + escapeHtml(step < 3 ? 'Continuer' : item ? 'Enregistrer' : 'Creer') + '</button>' +
        '</div>';
      all("[data-close]", root).forEach(function (btn) { btn.addEventListener("click", close); });
      setTimeout(function () { var first = form.querySelector("input:not([type=hidden]),select,textarea"); if (first) first.focus(); }, 20);
    }
    root.addEventListener("click", function (e) {
      if (e.target === root) close();
      var prev = e.target.closest("[data-prev]");
      if (prev) {
        readPurchaseDraft(root, draft);
        step = Math.max(1, step - 1);
        render();
      }
    });
    form.addEventListener("change", function (e) {
      if (e.target && e.target.name === "category") {
        draft.category = e.target.value;
        if (draft.category === "stock_alimentaire") draft.applyStock = 1;
        if (draft.category !== "stock_alimentaire" && !item) draft.applyStock = 0;
        if (draft.category !== "stock_alimentaire" && !item) { draft.productId = ""; draft.stockQuantity = ""; }
        if (draft.category === "investissement_depart") draft.isStartupInvestment = 1;
        if (draft.category !== "investissement_depart") draft.isStartupInvestment = 0;
        if (!draft.unit) draft.unit = purchaseCategoryInfo(draft.category).defaultUnit || "";
        render();
      }
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      (async function () {
        readPurchaseDraft(root, draft);
        var submit = root.querySelector("[data-submit]");
        try {
          if (step === 1 && !draft.category) throw new Error("Choisis un type d'achat.");
          if (step === 2) purchasePayloadFromDraft(draft);
          if (step < 3) {
            step += 1;
            render();
            return;
          }
          var payload = purchasePayloadFromDraft(draft);
          setBusy(submit, true, "Sauvegarde...");
          if (item) await writeWithFallback({ path: '/purchases/' + item.id, method: 'PATCH' }, { path: '/purchases/' + item.id + '/update-q' }, payload);
          else await writeWithFallback({ path: '/purchases', method: 'POST' }, { path: '/purchases/create-q' }, payload);
          close();
          showToast(item ? 'Achat modifie.' : 'Achat enregistre.', 'success');
          await Promise.all([loadPurchases(), loadSummary(), loadProductCatalog(), loadProductsPage()]);
        } catch (err) {
          render(err && err.message ? err.message : "Erreur sauvegarde");
        } finally {
          setBusy(root.querySelector("[data-submit]"), false);
        }
      })();
    });
    render();
  }

  async function deleteItem(kind, id) {
    var label = kind === 'products' ? 'produit' : kind === 'offers' ? 'offre' : 'achat';
    if (!window.confirm('Supprimer ce ' + label + ' ?')) return;
    await api('/' + kind + '/' + id, { method: 'DELETE', timeoutMs: 30000 });
    showToast(label.charAt(0).toUpperCase() + label.slice(1) + ' supprime.', 'success');
    if (kind === 'products') await Promise.all([loadProductsPage(), loadProductCatalog(), loadSummary()]);
    else if (kind === 'offers') await loadOffers();
    else await Promise.all([loadPurchases(), loadSummary()]);
  }

  function switchTab(tab) {
    state.activeTab = tab;
    all('.nav-item').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === tab); });
    all('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === tab); });
    if (tab === 'sales') loadSales().catch(showFatal);
    if (tab === 'products') loadProductsPage().catch(showFatal);
    if (tab === 'offers') loadOffers().catch(showFatal);
    if (tab === 'purchases') loadPurchases().catch(showFatal);
    if (tab === 'boxing') loadBoxing().catch(showFatal);
    if (tab === 'users') loadUsers().catch(showFatal);
    if (tab === 'link-pages') loadLinkPages().catch(showFatal);
  }

  function showFatal(err) {
    showToast(err && err.message ? err.message : 'Erreur application', 'error');
    console.error(err);
  }

  async function handleLogin(e) {
    e.preventDefault();
    els.loginError.textContent = '';
    setBusy(els.loginSubmit, true, 'Connexion...');
    try {
      var data = await api('/auth/login', { method: 'POST', auth: false, body: { username: els.loginUsername.value.trim(), password: els.loginPassword.value }, timeoutMs: 30000 });
      if (!data || !data.token) throw new Error('Token manquant');
      state.token = data.token;
      state.user = data.user || null;
      writeAuth(state.token, state.user);
      await startAdmin();
    } catch (err) {
      els.loginError.textContent = err && err.message ? err.message : 'Echec connexion';
    } finally {
      setBusy(els.loginSubmit, false, 'Entrer dans le cockpit');
    }
  }

  async function verifySession() {
    if (!state.token) return false;
    try {
      var me = await api('/auth/me', { timeoutMs: 25000 });
      state.user = me && me.user ? me.user : state.user;
      writeAuth(state.token, state.user);
      return true;
    } catch (_) {
      clearAuth();
      state.token = '';
      state.user = null;
      return false;
    }
  }

  async function startAdmin() {
    setLoginVisible(false);
    els.userLine.textContent = (state.user && state.user.username ? state.user.username : 'connecte') + ' | v' + APP_VERSION;
    els.frontVersion.textContent = 'Front v' + APP_VERSION;
    await refreshData('base');
    await refreshData('dashboard');
    await Promise.all([loadSales(), loadProductsPage(), loadOffers(), loadPurchases(), loadBoxing()]).catch(function (err) { console.warn(err); });
    renderLinkPages();
    startAutoRefresh();
  }

  function startAutoRefresh() {
    if (autoRefreshTimer) return;
    autoRefreshTimer = setInterval(function () {
      if (!state.token || document.hidden) return;
      if (els.modalRoot && els.modalRoot.children.length) return;
      if (state.activeTab === 'sales' && state.sales.offset === 0) {
        loadSales().catch(function (err) { console.warn('Auto-refresh ventes impossible', err); });
      }
      if (state.activeTab === 'cockpit' || state.activeTab === 'analysis') {
        loadSummary().catch(function (err) { console.warn('Auto-refresh dashboard impossible', err); });
      }
      if (state.activeTab === 'boxing') {
        Promise.all([loadBoxingSummary(), loadBoxingEntries()]).catch(function (err) { console.warn('Auto-refresh boxe impossible', err); });
      }
    }, SALES_AUTO_REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (!autoRefreshTimer) return;
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  function bindEvents() {
    if (els.loginForm) els.loginForm.addEventListener('submit', handleLogin);
    all('.nav-item').forEach(function (btn) { btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); }); });
    all('.chip[data-range]').forEach(function (btn) { btn.addEventListener('click', function () { setRange(btn.getAttribute('data-range')); refreshData('dashboard').catch(showFatal); if (state.activeTab === 'sales') loadSales().catch(showFatal); if (state.activeTab === 'purchases') loadPurchases().catch(showFatal); if (state.activeTab === 'boxing') Promise.all([loadBoxingSummary(), loadBoxingEntries()]).catch(showFatal); }); });
    els.filterFrom.addEventListener('change', function () { state.filters.from = els.filterFrom.value; refreshData('dashboard').catch(showFatal); if (state.activeTab === 'boxing') Promise.all([loadBoxingSummary(), loadBoxingEntries()]).catch(showFatal); });
    els.filterTo.addEventListener('change', function () { state.filters.to = els.filterTo.value; refreshData('dashboard').catch(showFatal); if (state.activeTab === 'boxing') Promise.all([loadBoxingSummary(), loadBoxingEntries()]).catch(showFatal); });
    els.filterCategory.addEventListener('change', function () { state.filters.category = els.filterCategory.value; refreshData('dashboard').catch(showFatal); if (state.activeTab === 'sales') loadSales().catch(showFatal); });
    els.btnRefresh.addEventListener('click', function () { refreshData('all').then(function () { showToast('Donnees rafraichies.', 'success'); }).catch(showFatal); });
    els.btnLogout.addEventListener('click', function () { stopAutoRefresh(); clearAuth(); state.token = ''; state.user = null; window.location.href = LOGIN_URL; });
    els.salesRefresh.addEventListener('click', function () { loadSales().catch(showFatal); });
    els.salesSearch.addEventListener('input', debounce(function () { state.sales.q = els.salesSearch.value.trim(); state.sales.offset = 0; loadSales().catch(showFatal); }, 350));
    els.productsSearch.addEventListener('input', debounce(function () { state.productsPage.q = els.productsSearch.value.trim(); state.productsPage.offset = 0; loadProductsPage().catch(showFatal); }, 350));
    if (els.productsFilterCategory) els.productsFilterCategory.addEventListener('change', function () { state.productsPage.category = els.productsFilterCategory.value; state.productsPage.offset = 0; loadProductsPage().catch(showFatal); });
    els.offersSearch.addEventListener('input', debounce(function () { var q = els.offersSearch.value.trim().toLowerCase(); renderOffersFiltered(q); }, 200));
    els.purchasesSearch.addEventListener('input', debounce(function () { state.purchases.q = els.purchasesSearch.value.trim(); state.purchases.offset = 0; loadPurchases().catch(showFatal); }, 350));
    els.purchaseFilterCategory.addEventListener('change', function () { state.purchases.category = els.purchaseFilterCategory.value; state.purchases.offset = 0; loadPurchases().catch(showFatal); });
    if (els.boxingFilterMachine) els.boxingFilterMachine.addEventListener('change', function () { state.boxingEntries.machineId = els.boxingFilterMachine.value; state.boxingEntries.offset = 0; Promise.all([loadBoxingSummary(), loadBoxingEntries()]).catch(showFatal); });
    if (els.boxingEntryType) els.boxingEntryType.addEventListener('change', function () { state.boxingEntries.type = els.boxingEntryType.value; state.boxingEntries.offset = 0; loadBoxingEntries().catch(showFatal); });
    if (els.boxingEntrySearch) els.boxingEntrySearch.addEventListener('input', debounce(function () { state.boxingEntries.q = els.boxingEntrySearch.value.trim(); state.boxingEntries.offset = 0; loadBoxingEntries().catch(showFatal); }, 350));
    els.productsAdd.addEventListener('click', function () { openProductModal(null); });
    els.offersAdd.addEventListener('click', function () { openOfferModal(null); });
    els.purchasesAdd.addEventListener('click', function () { openPurchaseModal(null); });
    if (els.boxingAddMachine) els.boxingAddMachine.addEventListener('click', function () { openBoxingMachineModal(null); });
    if (els.boxingAddEntry) els.boxingAddEntry.addEventListener('click', function () { openBoxingEntryModal(null); });
    if (els.usersAdd) els.usersAdd.addEventListener('click', function () { openUserModal(null); });
    if (els.usersSearch) els.usersSearch.addEventListener('input', debounce(function () { state.usersPage.q = els.usersSearch.value.trim(); renderUsers(); }, 200));
    if (els.usersArchiveToggle) els.usersArchiveToggle.addEventListener('click', function () {
      state.usersPage.archived = !state.usersPage.archived;
      loadUsers().catch(showFatal);
    });
    if (els.linkPagesAdd) els.linkPagesAdd.addEventListener('click', function () { openLinkPageModal(null); });
    if (els.linkPagesSearch) els.linkPagesSearch.addEventListener('input', debounce(function () { state.linkPages.q = els.linkPagesSearch.value.trim(); state.linkPages.offset = 0; loadLinkPages().catch(showFatal); }, 350));
    els.clearLog.addEventListener('click', function () { state.log = []; renderRequestLog(); });

    document.addEventListener('click', function (e) {
      var btn;
      btn = e.target.closest('[data-sale-view]');
      if (btn) { openSaleDetailsModal(btn.getAttribute('data-sale-view')).catch(showFatal); return; }
      btn = e.target.closest('[data-product-edit]');
      if (btn) { openProductModal(state.productsPage.items.find(function (p) { return p.id === Number(btn.getAttribute('data-product-edit')); })); return; }
      btn = e.target.closest('[data-product-delete]');
      if (btn) { deleteItem('products', btn.getAttribute('data-product-delete')).catch(showFatal); return; }
      btn = e.target.closest('[data-offer-edit]');
      if (btn) { openOfferModal(state.offers.find(function (o) { return o.id === Number(btn.getAttribute('data-offer-edit')); })); return; }
      btn = e.target.closest('[data-offer-delete]');
      if (btn) { deleteItem('offers', btn.getAttribute('data-offer-delete')).catch(showFatal); return; }
      btn = e.target.closest('[data-purchase-edit]');
      if (btn) { openPurchaseModal(state.purchases.items.find(function (p) { return p.id === Number(btn.getAttribute('data-purchase-edit')); })); return; }
      btn = e.target.closest('[data-purchase-delete]');
      if (btn) { deleteItem('purchases', btn.getAttribute('data-purchase-delete')).catch(showFatal); return; }
      btn = e.target.closest('[data-boxing-machine-edit]');
      if (btn) { openBoxingMachineModal(state.boxingMachines.find(function (m) { return m.id === Number(btn.getAttribute('data-boxing-machine-edit')); })); return; }
      btn = e.target.closest('[data-boxing-machine-delete]');
      if (btn) { deleteBoxingMachine(state.boxingMachines.find(function (m) { return m.id === Number(btn.getAttribute('data-boxing-machine-delete')); })).catch(showFatal); return; }
      btn = e.target.closest('[data-boxing-entry-edit]');
      if (btn) { openBoxingEntryModal(state.boxingEntries.items.find(function (x) { return x.id === Number(btn.getAttribute('data-boxing-entry-edit')); })); return; }
      btn = e.target.closest('[data-boxing-entry-delete]');
      if (btn) { deleteBoxingEntry(state.boxingEntries.items.find(function (x) { return x.id === Number(btn.getAttribute('data-boxing-entry-delete')); })).catch(showFatal); return; }
      btn = e.target.closest('[data-user-edit]');
      if (btn) { openUserModal(state.users.find(function (u) { return u.id === Number(btn.getAttribute('data-user-edit')); })); return; }
      btn = e.target.closest('[data-user-archive]');
      if (btn) { archiveUserAccount(state.users.find(function (u) { return u.id === Number(btn.getAttribute('data-user-archive')); })).catch(showFatal); return; }
      btn = e.target.closest('[data-user-restore]');
      if (btn) { restoreUserAccount(state.users.find(function (u) { return u.id === Number(btn.getAttribute('data-user-restore')); })).catch(showFatal); return; }
      btn = e.target.closest('[data-link-page-copy]');
      if (btn) { copyLinkPageUrl(state.linkPages.items.find(function (p) { return p.id === Number(btn.getAttribute('data-link-page-copy')); })).catch(showFatal); return; }
      btn = e.target.closest('[data-link-page-open]');
      if (btn) {
        var openItem = state.linkPages.items.find(function (p) { return p.id === Number(btn.getAttribute('data-link-page-open')); });
        if (openItem && openItem.publicUrl) window.open(openItem.publicUrl, '_blank', 'noopener');
        return;
      }
      btn = e.target.closest('[data-link-page-qr]');
      if (btn) { downloadLinkPageQr(state.linkPages.items.find(function (p) { return p.id === Number(btn.getAttribute('data-link-page-qr')); })).catch(showFatal); return; }
      btn = e.target.closest('[data-link-page-edit]');
      if (btn) { openLinkPageModal(state.linkPages.items.find(function (p) { return p.id === Number(btn.getAttribute('data-link-page-edit')); })); return; }
      btn = e.target.closest('[data-link-page-disable]');
      if (btn) { setLinkPageActive(state.linkPages.items.find(function (p) { return p.id === Number(btn.getAttribute('data-link-page-disable')); }), false).catch(showFatal); return; }
      btn = e.target.closest('[data-link-page-enable]');
      if (btn) { setLinkPageActive(state.linkPages.items.find(function (p) { return p.id === Number(btn.getAttribute('data-link-page-enable')); }), true).catch(showFatal); return; }
    });

    bindPager(els.salesPrev, els.salesNext, state.sales, loadSales);
    bindPager(els.productsPrev, els.productsNext, state.productsPage, loadProductsPage);
    bindPager(els.purchasesPrev, els.purchasesNext, state.purchases, loadPurchases);
    bindPager(els.boxingEntriesPrev, els.boxingEntriesNext, state.boxingEntries, loadBoxingEntries);
    bindPager(els.linkPagesPrev, els.linkPagesNext, state.linkPages, loadLinkPages);
  }

  function renderOffersFiltered(q) {
    if (!q) return renderOffers();
    var original = state.offers;
    var filtered = original.filter(function (o) { return (o.name || '').toLowerCase().indexOf(q) !== -1; });
    var saved = state.offers;
    state.offers = filtered;
    renderOffers();
    state.offers = saved;
  }

  function bindPager(prev, next, pageState, loader) {
    prev.addEventListener('click', function () { pageState.offset = Math.max(0, pageState.offset - PAGE_SIZE); loader().catch(showFatal); });
    next.addEventListener('click', function () { pageState.offset += PAGE_SIZE; loader().catch(showFatal); });
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function initDom() {
    [
      'login-screen','admin-screen','login-form','login-username','login-password','login-submit','login-error','front-version','user-line','btn-refresh','btn-logout','filter-from','filter-to','filter-category','global-alert','kpis-grid','daily-performance-pill','daily-chart','hour-chart','category-chart','target-title','target-gauge','target-insights','objective-stack','analysis-feed','weekday-chart','top-products-list','sales-search','sales-refresh','sales-table','sales-prev','sales-next','sales-page','products-search','products-filter-category','products-add','products-table','products-prev','products-next','products-page','offers-search','offers-add','offers-table','purchase-kpis','purchase-category-chart','purchase-filter-category','purchases-search','purchases-add','purchases-table','purchases-prev','purchases-next','purchases-page','boxing-kpis','boxing-category-chart','boxing-filter-machine','boxing-add-machine','boxing-add-entry','boxing-machine-chart','boxing-daily-chart','boxing-machines-table','boxing-entry-type','boxing-entry-search','boxing-entries-table','boxing-entries-prev','boxing-entries-next','boxing-entries-page','users-search','users-archive-toggle','users-add','users-table','link-pages-search','link-pages-add','link-pages-table','link-pages-prev','link-pages-next','link-pages-page','request-log','clear-log','modal-root'
    ].forEach(function (id) {
      var key = id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      els[key] = $(id);
    });
    els.productsPageLabel = els.productsPage;
  }

  async function bootstrap() {
    initDom();
    setRange('30d');
    bindEvents();
    var auth = readAuth();
    if (auth) {
      state.token = auth.token || '';
      state.user = auth.user || null;
    }
    if (await verifySession()) await startAdmin();
    else setLoginVisible(true);
    window.CAG_ADMIN_V2 = { version: APP_VERSION, state: state, refresh: refreshData };
    console.info('[CAG ADMIN V2] version', APP_VERSION);
  }

  bootstrap().catch(function (err) {
    console.error(err);
    alert(err && err.message ? err.message : 'Erreur chargement application');
  });
})();
