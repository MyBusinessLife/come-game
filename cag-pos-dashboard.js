/* CAG POS Dashboard (Webflow embed) - v1
 *
 * This file is a frontend only. A browser cannot talk directly to your MySQL database.
 * You need an API (REST/JSON) in front of your POS database.
 *
 * Default endpoints expected (relative to `data-api-base`):
 * - POST   /auth/login                         body: { username, password } -> { token, user? }
 * - GET    /auth/me                            -> { user }
 * - GET    /dashboard/summary?from&to           -> { kpis, series, topProducts, topOffers }
 * - GET    /sales?from&to&q&limit&offset        -> { items, total }
 * - GET    /sales/:id                          -> { sale, details }
 * - GET    /products?q&limit&offset             -> { items, total }
 * - POST   /products                            body: { ... } -> { product }
 * - PATCH  /products/:id                         body: { ... } -> { product }
 * - DELETE /products/:id
 * - GET    /offers?q&limit&offset               -> { items, total }
 * - POST   /offers                               body: { name, quantity, price, productIds } -> { offer }
 * - PATCH  /offers/:id                            body: { ... } -> { offer }
 * - DELETE /offers/:id
 *
 * Root DIV example:
 * <div
 *   data-cag="pos-dashboard"
 *   data-api-base="https://YOUR_API_DOMAIN/api"
 *   data-page="dashboard"
 *   data-login-url="/login"
 *   data-after-login-url="/dashboard"
 * ></div>
 */

(function () {
  "use strict";

  var APP_VERSION = "1.0.0";
  var ROOT_SELECTOR = '[data-cag="pos-dashboard"]';

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.indexOf("data-") === 0) node.setAttribute(k, attrs[k]);
        else if (k === "style" && typeof attrs[k] === "object") Object.assign(node.style, attrs[k]);
        else if (k in node) node[k] = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null) continue;
      if (typeof child === "string") node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }

  function isTruthy(v) {
    return v === true || v === "true" || v === "1" || v === 1;
  }

  function todayISO() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function isoAddDays(iso, deltaDays) {
    var parts = String(iso || "").split("-");
    if (parts.length !== 3) return iso;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    d.setDate(d.getDate() + deltaDays);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function toNumber(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function readConfig(root) {
    var apiBase = (root.getAttribute("data-api-base") || "").trim();
    var page = (root.getAttribute("data-page") || "dashboard").trim();
    var title = (root.getAttribute("data-title") || "CAG Dashboard").trim();
    var subtitle = (root.getAttribute("data-subtitle") || "Salle de jeux").trim();
    var storageKey = (root.getAttribute("data-storage-key") || "cag_pos_auth").trim();
    var currency = (root.getAttribute("data-currency") || "EUR").trim();
    var locale = (root.getAttribute("data-locale") || (navigator.language || "fr-FR")).trim();
    var defaultRangeDays = parseInt(root.getAttribute("data-default-range-days") || "30", 10);
    var loginUrl = (root.getAttribute("data-login-url") || "").trim();
    var afterLoginUrl = (root.getAttribute("data-after-login-url") || "").trim();
    var enforceRoles = isTruthy(root.getAttribute("data-enforce-roles"));
    var writeRolesRaw = (root.getAttribute("data-write-roles") || "admin,manager").trim();
    var writeRoles = writeRolesRaw
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);

    // Allow override of endpoints if your backend differs.
    var epLogin = (root.getAttribute("data-ep-login") || "/auth/login").trim();
    var epMe = (root.getAttribute("data-ep-me") || "/auth/me").trim();
    var epSummary = (root.getAttribute("data-ep-summary") || "/dashboard/summary").trim();
    var epSales = (root.getAttribute("data-ep-sales") || "/sales").trim();
    var epProducts = (root.getAttribute("data-ep-products") || "/products").trim();
    var epOffers = (root.getAttribute("data-ep-offers") || "/offers").trim();

    return {
      apiBase: apiBase.replace(/\/+$/, ""),
      page: page,
      title: title,
      subtitle: subtitle,
      storageKey: storageKey,
      currency: currency,
      locale: locale,
      defaultRangeDays: Number.isFinite(defaultRangeDays) ? clamp(defaultRangeDays, 1, 366) : 30,
      loginUrl: loginUrl,
      afterLoginUrl: afterLoginUrl,
      enforceRoles: enforceRoles,
      writeRoles: writeRoles,
      epLogin: epLogin,
      epMe: epMe,
      epSummary: epSummary,
      epSales: epSales,
      epProducts: epProducts,
      epOffers: epOffers,
    };
  }

  function moneyFormatter(cfg) {
    var fmt = null;
    try {
      fmt = new Intl.NumberFormat(cfg.locale, {
        style: "currency",
        currency: cfg.currency,
        maximumFractionDigits: 2,
      });
    } catch (_) {
      fmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
    }
    return function (n) {
      if (n == null || !Number.isFinite(Number(n))) return "—";
      try {
        return fmt.format(Number(n));
      } catch (_) {
        return String(n);
      }
    };
  }

  function compactNumberFormatter(cfg) {
    var fmt = null;
    try {
      fmt = new Intl.NumberFormat(cfg.locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      });
    } catch (_) {
      fmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
    }
    return function (n) {
      if (n == null || !Number.isFinite(Number(n))) return "—";
      return fmt.format(Number(n));
    };
  }

  function readAuth(cfg) {
    try {
      var raw = localStorage.getItem(cfg.storageKey);
      if (!raw) return null;
      var data = safeJsonParse(raw);
      if (!data || typeof data !== "object") return null;
      if (typeof data.token !== "string" || !data.token) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function writeAuth(cfg, data) {
    try {
      localStorage.setItem(cfg.storageKey, JSON.stringify(data));
    } catch (_) {
      // ignore
    }
  }

  function clearAuth(cfg) {
    try {
      localStorage.removeItem(cfg.storageKey);
    } catch (_) {
      // ignore
    }
  }

  function parseRoles(user) {
    if (!user) return [];
    var r = user.roles;
    if (!r) return [];
    if (Array.isArray(r)) return r.map(String);
    if (typeof r === "string") {
      var parsed = safeJsonParse(r);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (parsed && typeof parsed === "object") return Object.keys(parsed);
      return r
        .split(/[,\s]+/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    }
    if (typeof r === "object") return Object.keys(r);
    return [];
  }

  function canWrite(cfg, user) {
    if (!cfg.enforceRoles) return true;
    var roles = parseRoles(user);
    if (!roles.length) return false;
    var roleSet = Object.create(null);
    roles.forEach(function (x) {
      roleSet[String(x).toLowerCase()] = true;
    });
    return cfg.writeRoles.some(function (r) {
      return roleSet[String(r).toLowerCase()] === true;
    });
  }

  function normalizeUser(u) {
    if (!u) return null;
    return {
      id: u.id != null ? u.id : u.id_user,
      username: u.username || u.login || u.email || "Utilisateur",
      roles: u.roles,
      raw: u,
    };
  }

  function normalizeProduct(p) {
    if (!p) return null;
    return {
      id: p.id != null ? p.id : p.id_product != null ? p.id_product : p.product_id,
      barcode: p.barcode || "",
      reference: p.reference || "",
      name: p.name || "",
      description: p.description || "",
      quantity: p.quantity != null ? Number(p.quantity) : null,
      purchasePrice:
        p.purchasePrice != null
          ? Number(p.purchasePrice)
          : p.purchase_price != null
            ? Number(p.purchase_price)
            : null,
      price: p.price != null ? Number(p.price) : null,
      productType: p.productType || p.product_type || "",
      lastUpdated: p.last_updated || p.lastUpdated || null,
      raw: p,
    };
  }

  function normalizeOffer(o) {
    if (!o) return null;
    var productIds = [];
    if (Array.isArray(o.productIds)) productIds = o.productIds.slice();
    else if (Array.isArray(o.product_ids)) productIds = o.product_ids.slice();
    else if (Array.isArray(o.products)) {
      productIds = o.products
        .map(function (p) {
          return p && (p.id != null ? p.id : p.id_product != null ? p.id_product : p.product_id);
        })
        .filter(function (x) {
          return x != null;
        });
    }
    return {
      id: o.id != null ? o.id : o.id_offer != null ? o.id_offer : o.offer_id,
      name: o.name || "",
      quantity: o.quantity != null ? Number(o.quantity) : null,
      price: o.price != null ? Number(o.price) : null,
      productIds: productIds,
      lastUpdated: o.last_updated || o.lastUpdated || null,
      raw: o,
    };
  }

  function normalizeSale(s) {
    if (!s) return null;
    return {
      id: s.id != null ? s.id : s.id_sale != null ? s.id_sale : s.sale_id,
      totalAmount:
        s.totalAmount != null ? Number(s.totalAmount) : s.total_amount != null ? Number(s.total_amount) : null,
      notes: s.notes || "",
      userId: s.userId != null ? s.userId : s.user_id,
      username: s.username || s.user_name || s.user || "",
      itemsCount:
        s.itemsCount != null
          ? Number(s.itemsCount)
          : s.items_count != null
            ? Number(s.items_count)
            : s.detailsCount != null
              ? Number(s.detailsCount)
              : null,
      createdAt: s.createdAt || s.created_at || s.last_updated || s.lastUpdated || null,
      raw: s,
    };
  }

  function normalizeSaleDetail(d) {
    if (!d) return null;
    return {
      id: d.id != null ? d.id : d.id_sale_detail != null ? d.id_sale_detail : d.sale_detail_id,
      saleId: d.saleId != null ? d.saleId : d.sale_id,
      productId: d.productId != null ? d.productId : d.product_id,
      productName: d.productName || d.product_name || d.name || "",
      quantity: d.quantity != null ? Number(d.quantity) : null,
      price: d.price != null ? Number(d.price) : null,
      totalPrice:
        d.totalPrice != null ? Number(d.totalPrice) : d.total_price != null ? Number(d.total_price) : null,
      raw: d,
    };
  }

  function toastHost(root) {
    var host = $(".cag-toast-stack", root);
    if (host) return host;
    host = el("div", { class: "cag-toast-stack" });
    root.appendChild(host);
    return host;
  }

  function toast(root, msg, kind, timeoutMs) {
    var host = toastHost(root);
    var t = el("div", { class: "cag-toast", "data-kind": kind || "" });
    t.innerHTML = msg;
    host.appendChild(t);
    var ms = timeoutMs == null ? 3200 : timeoutMs;
    window.setTimeout(function () {
      try {
        t.style.opacity = "0";
        t.style.transform = "translateY(6px)";
        window.setTimeout(function () {
          if (t && t.parentNode) t.parentNode.removeChild(t);
        }, 220);
      } catch (_) {
        // ignore
      }
    }, ms);
  }

  function setBusy(node, busy, label) {
    if (!node) return;
    node.disabled = !!busy;
    node.setAttribute("aria-busy", busy ? "true" : "false");
    if (label != null) node.textContent = label;
  }

  async function apiFetch(cfg, path, opts) {
    opts = opts || {};
    if (!cfg.apiBase) throw new Error("data-api-base manquant");

    var url = cfg.apiBase + path;
    if (opts.query) {
      var usp = new URLSearchParams();
      Object.keys(opts.query).forEach(function (k) {
        var v = opts.query[k];
        if (v == null || v === "") return;
        usp.set(k, String(v));
      });
      var qs = usp.toString();
      if (qs) url += (url.indexOf("?") === -1 ? "?" : "&") + qs;
    }

    var headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";

    var auth = readAuth(cfg);
    if (auth && auth.token) headers.Authorization = "Bearer " + auth.token;

    var res = await fetch(url, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    });

    var text = await res.text();
    var data = null;
    if (text) {
      data = safeJsonParse(text);
      if (data == null) data = text;
    }

    if (!res.ok) {
      var err = new Error((data && data.message) || ("HTTP " + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function renderAppChrome(root, cfg) {
    var app = el("div", { class: "cag-app" }, el("div", { class: "cag-grid" }), el("div", { class: "cag-shell" }));
    root.innerHTML = "";
    root.appendChild(app);
    return $(".cag-shell", app);
  }

  function renderLogin(shell, root, cfg, prefillUsername) {
    var badge = el("span", { class: "cag-badge" }, el("span", { class: "cag-status-dot" }), "Connexion POS");

    var title = el("h1", { text: "Se connecter" });
    var hint = el(
      "p",
      { html: "Connecte-toi pour accéder au dashboard et gérer les produits / offres." }
    );

    var fUser = el("input", {
      class: "cag-input",
      type: "text",
      name: "username",
      placeholder: "Nom d'utilisateur",
      value: prefillUsername || "",
      autocomplete: "username",
      required: true,
    });
    var fPass = el("input", {
      class: "cag-input",
      type: "password",
      name: "password",
      placeholder: "Mot de passe",
      autocomplete: "current-password",
      required: true,
    });

    var submitBtn = el("button", { class: "cag-btn cag-btn-primary", type: "submit", text: "Connexion" });

    var form = el(
      "form",
      { class: "cag-login" },
      el("div", { style: { display: "flex", gap: "10px", alignItems: "center", justifyContent: "space-between" } }, badge),
      title,
      hint,
      el("div", { class: "cag-field cag-field-full" }, el("label", { text: "Utilisateur" }), fUser),
      el("div", { class: "cag-field cag-field-full" }, el("label", { text: "Mot de passe" }), fPass),
      el("div", { style: { display: "flex", justifyContent: "flex-end" } }, submitBtn),
      el("div", { class: "cag-small", html: "Version front: <strong>" + APP_VERSION + "</strong>" })
    );

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      (async function () {
        setBusy(submitBtn, true, "Connexion...");
        try {
          var payload = { username: fUser.value.trim(), password: fPass.value };
          var r = await apiFetch(cfg, cfg.epLogin, { method: "POST", json: payload });
          var token = r && (r.token || (r.data && r.data.token));
          if (!token) throw new Error("Réponse login invalide (token manquant)");

          writeAuth(cfg, {
            token: token,
            user: r.user || (r.data && r.data.user) || null,
            at: new Date().toISOString(),
          });

          toast(root, "Connecté.", "ok");

          var redirectTo = cfg.afterLoginUrl || cfg.loginUrl || "";
          if (cfg.page === "login" && redirectTo) {
            window.setTimeout(function () {
              window.location.href = redirectTo;
            }, 250);
            return;
          }

          window.setTimeout(function () {
            window.location.reload();
          }, 250);
        } catch (err) {
          var msg = err && err.message ? err.message : "Erreur de connexion";
          toast(root, msg, "err", 5200);
        } finally {
          setBusy(submitBtn, false, "Connexion");
        }
      })();
    });

    shell.appendChild(form);
  }

  function renderTopbar(cfg, state, fmtMoney, fmtCompact) {
    var left = el(
      "div",
      { class: "cag-brand" },
      el("div", { class: "cag-brand-title", text: cfg.title }),
      el(
        "div",
        { class: "cag-brand-sub", text: cfg.subtitle + " • " + fmtCompact(state.kpis && state.kpis.salesCount) + " ventes" }
      )
    );

    var fromInput = el("input", { class: "cag-input", type: "date", value: state.range.from });
    var toInput = el("input", { class: "cag-input", type: "date", value: state.range.to });

    var refreshBtn = el("button", { class: "cag-btn", type: "button", text: "Rafraichir" });
    var logoutBtn = el("button", { class: "cag-btn cag-btn-ghost", type: "button", text: "Déconnexion" });

    var userPill = el(
      "span",
      { class: "cag-pill" },
      el("span", { class: "cag-status-dot" }),
      el("span", { text: state.user ? state.user.username : "Session" })
    );

    var actions = el(
      "div",
      { class: "cag-actions" },
      el(
        "div",
        { class: "cag-range" },
        el("label", { text: "Du" }),
        fromInput,
        el("label", { text: "Au" }),
        toInput
      ),
      refreshBtn,
      userPill,
      logoutBtn
    );

    var topbar = el("div", { class: "cag-topbar" }, left, actions);
    return { topbar: topbar, fromInput: fromInput, toInput: toInput, refreshBtn: refreshBtn, logoutBtn: logoutBtn };
  }

  function renderTabs(state) {
    var tabs = [
      { id: "overview", label: "Apercu" },
      { id: "sales", label: "Ventes" },
      { id: "products", label: "Produits" },
      { id: "offers", label: "Offres" },
    ];
    var wrap = el("div", { class: "cag-tabs", role: "tablist" });
    tabs.forEach(function (t) {
      var btn = el("button", {
        class: "cag-tab",
        type: "button",
        role: "tab",
        "data-tab": t.id,
        "aria-selected": t.id === state.view ? "true" : "false",
        text: t.label,
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function setActiveView(shell, state, viewId) {
    state.view = viewId;
    $all(".cag-tab", shell).forEach(function (b) {
      b.setAttribute("aria-selected", b.getAttribute("data-tab") === viewId ? "true" : "false");
    });
    $all(".cag-view", shell).forEach(function (v) {
      if (v.getAttribute("data-view") === viewId) v.classList.add("is-active");
      else v.classList.remove("is-active");
    });
  }

  function svgLineChart(series, valueKey, fmtMoney) {
    var w = 1000;
    var h = 280;
    var padX = 24;
    var padY = 26;

    var values = series
      .map(function (p) {
        var v = p && p[valueKey];
        return v == null ? null : Number(v);
      })
      .filter(function (v) {
        return v != null && Number.isFinite(v);
      });

    var minV = values.length ? Math.min.apply(Math, values) : 0;
    var maxV = values.length ? Math.max.apply(Math, values) : 0;
    if (minV === maxV) maxV = minV + 1;

    function xAt(i, n) {
      if (n <= 1) return padX;
      var usable = w - padX * 2;
      return padX + (i * usable) / (n - 1);
    }

    function yAt(v) {
      var usable = h - padY * 2;
      var t = (v - minV) / (maxV - minV);
      return padY + (1 - t) * usable;
    }

    var n = series.length;
    var path = "";
    for (var i = 0; i < n; i++) {
      var v = series[i] && series[i][valueKey];
      v = v == null ? null : Number(v);
      if (!Number.isFinite(v)) continue;
      var x = xAt(i, n);
      var y = yAt(v);
      path += path ? " L " + x.toFixed(2) + " " + y.toFixed(2) : "M " + x.toFixed(2) + " " + y.toFixed(2);
    }

    var last = null;
    for (var j = n - 1; j >= 0; j--) {
      var vv = series[j] && series[j][valueKey];
      vv = vv == null ? null : Number(vv);
      if (Number.isFinite(vv)) {
        last = { i: j, v: vv };
        break;
      }
    }

    var y0 = yAt(minV);
    var area = path ? path + " L " + xAt(n - 1, n).toFixed(2) + " " + y0.toFixed(2) + " L " + xAt(0, n).toFixed(2) + " " + y0.toFixed(2) + " Z" : "";

    var labelMax = fmtMoney(maxV);
    var labelMin = fmtMoney(minV);
    var labelLast = last ? fmtMoney(last.v) : "—";

    var svg =
      '<svg class="cag-chart" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" preserveAspectRatio="none" role="img" aria-label="Graphique">' +
      '<defs>' +
      '<linearGradient id="cagGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="rgba(14,165,164,0.28)"/>' +
      '<stop offset="90%" stop-color="rgba(14,165,164,0.02)"/>' +
      "</linearGradient>" +
      "</defs>" +
      '<rect x="0" y="0" width="' +
      w +
      '" height="' +
      h +
      '" fill="rgba(255,255,255,0.0)"/>' +
      '<g opacity="0.85">' +
      '<path d="' +
      area +
      '" fill="url(#cagGrad)"></path>' +
      '<path d="' +
      path +
      '" fill="none" stroke="rgba(14,165,164,0.95)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</g>" +
      '<g font-family="inherit" font-size="24" font-weight="800" fill="rgba(17,24,39,0.82)">' +
      '<text x="' +
      (padX + 6) +
      '" y="' +
      (padY + 28) +
      '">' +
      labelLast +
      "</text>" +
      "</g>" +
      '<g font-family="inherit" font-size="12" font-weight="700" fill="rgba(91,100,117,0.9)">' +
      '<text x="' +
      (padX + 6) +
      '" y="' +
      (h - 10) +
      '">' +
      labelMin +
      "</text>" +
      '<text x="' +
      (padX + 6) +
      '" y="' +
      (padY + 10) +
      '">' +
      labelMax +
      "</text>" +
      "</g>" +
      "</svg>";

    var wrapper = el("div", { html: svg });
    return wrapper.firstChild;
  }

  function skeletonCards() {
    var cards = el("div", { class: "cag-cards" });
    for (var i = 0; i < 4; i++) {
      var c = el(
        "div",
        { class: "cag-card" },
        el("div", { class: "cag-skeleton", style: { width: "46%", height: "10px", marginBottom: "12px" } }),
        el("div", { class: "cag-skeleton", style: { width: "72%", height: "22px", marginBottom: "10px" } }),
        el("div", { class: "cag-skeleton", style: { width: "56%", height: "10px" } })
      );
      cards.appendChild(c);
    }
    return cards;
  }

  function renderOverviewView(state, fmtMoney, fmtCompact) {
    var view = el("div", { class: "cag-view", "data-view": "overview" });
    view.appendChild(skeletonCards());

    var split = el(
      "div",
      { class: "cag-split" },
      el("div", { class: "cag-panel" }, el("h2", { text: "Revenu sur la periode" }), el("div", { class: "cag-skeleton", style: { height: "220px" } })),
      el(
        "div",
        { class: "cag-panel" },
        el("h2", { text: "Top ventes" }),
        el("div", { class: "cag-mini-list" }, el("div", { class: "cag-skeleton", style: { height: "42px" } }))
      )
    );
    view.appendChild(split);
    return view;
  }

  function renderSalesView() {
    var view = el("div", { class: "cag-view", "data-view": "sales" });
    view.appendChild(el("div", { class: "cag-empty", text: "Chargement..." }));
    return view;
  }

  function renderProductsView() {
    var view = el("div", { class: "cag-view", "data-view": "products" });
    view.appendChild(el("div", { class: "cag-empty", text: "Chargement..." }));
    return view;
  }

  function renderOffersView() {
    var view = el("div", { class: "cag-view", "data-view": "offers" });
    view.appendChild(el("div", { class: "cag-empty", text: "Chargement..." }));
    return view;
  }

  function openModal(root, titleText, bodyNode, actionsNode) {
    var backdrop = el("div", { class: "cag-modal-backdrop", role: "dialog", "aria-modal": "true" });
    var modal = el(
      "div",
      { class: "cag-modal" },
      el(
        "div",
        { class: "cag-modal-header" },
        el("div", { class: "cag-modal-title", text: titleText }),
        el("button", { class: "cag-btn cag-btn-ghost", type: "button", text: "Fermer" })
      ),
      el("div", { class: "cag-modal-body" }, bodyNode, actionsNode || null)
    );

    var closeBtn = $(".cag-btn", modal); // first button in header
    function close() {
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }

    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey);

    backdrop.appendChild(modal);
    root.appendChild(backdrop);
    return { close: close, modal: modal };
  }

  function table(headers, rows) {
    var t = el("table", { class: "cag-table" });
    var thead = el("thead");
    var trh = el("tr");
    headers.forEach(function (h) {
      trh.appendChild(el("th", { text: h }));
    });
    thead.appendChild(trh);
    t.appendChild(thead);
    var tbody = el("tbody");
    rows.forEach(function (tr) {
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    return t;
  }

  function paginate(stateSlice, total) {
    var limit = stateSlice.limit;
    var offset = stateSlice.offset;
    var page = Math.floor(offset / limit) + 1;
    var pages = Math.max(1, Math.ceil(total / limit));
    return { page: page, pages: pages };
  }

  async function loadMe(cfg) {
    var r = await apiFetch(cfg, cfg.epMe, { method: "GET" });
    var u = (r && (r.user || r.data || r)) || null;
    return normalizeUser(u);
  }

  async function ensureAuth(root, cfg) {
    var auth = readAuth(cfg);
    if (!auth || !auth.token) return null;
    try {
      var user = await loadMe(cfg);
      return user;
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        clearAuth(cfg);
        toast(root, "Session expirée. Reconnexion requise.", "warn", 5200);
      }
      return null;
    }
  }

  async function loadSummary(cfg, range) {
    return apiFetch(cfg, cfg.epSummary, { method: "GET", query: { from: range.from, to: range.to } });
  }

  async function loadSales(cfg, range, q, limit, offset) {
    return apiFetch(cfg, cfg.epSales, {
      method: "GET",
      query: { from: range.from, to: range.to, q: q || "", limit: limit, offset: offset },
    });
  }

  async function loadSale(cfg, saleId) {
    return apiFetch(cfg, cfg.epSales + "/" + encodeURIComponent(String(saleId)), { method: "GET" });
  }

  async function loadProducts(cfg, q, limit, offset) {
    return apiFetch(cfg, cfg.epProducts, { method: "GET", query: { q: q || "", limit: limit, offset: offset } });
  }

  async function createProduct(cfg, payload) {
    return apiFetch(cfg, cfg.epProducts, { method: "POST", json: payload });
  }

  async function updateProduct(cfg, id, payload) {
    return apiFetch(cfg, cfg.epProducts + "/" + encodeURIComponent(String(id)), { method: "PATCH", json: payload });
  }

  async function deleteProduct(cfg, id) {
    return apiFetch(cfg, cfg.epProducts + "/" + encodeURIComponent(String(id)), { method: "DELETE" });
  }

  async function loadOffers(cfg, q, limit, offset) {
    return apiFetch(cfg, cfg.epOffers, { method: "GET", query: { q: q || "", limit: limit, offset: offset } });
  }

  async function createOffer(cfg, payload) {
    return apiFetch(cfg, cfg.epOffers, { method: "POST", json: payload });
  }

  async function updateOffer(cfg, id, payload) {
    return apiFetch(cfg, cfg.epOffers + "/" + encodeURIComponent(String(id)), { method: "PATCH", json: payload });
  }

  async function deleteOffer(cfg, id) {
    return apiFetch(cfg, cfg.epOffers + "/" + encodeURIComponent(String(id)), { method: "DELETE" });
  }

  function renderDashboard(shell, root, cfg, state) {
    var fmtMoney = moneyFormatter(cfg);
    var fmtCompact = compactNumberFormatter(cfg);

    var chrome = renderTopbar(cfg, state, fmtMoney, fmtCompact);
    var tabs = renderTabs(state);

    var main = el("div", { class: "cag-main" });
    var vOverview = renderOverviewView(state, fmtMoney, fmtCompact);
    var vSales = renderSalesView();
    var vProducts = renderProductsView();
    var vOffers = renderOffersView();
    main.appendChild(vOverview);
    main.appendChild(vSales);
    main.appendChild(vProducts);
    main.appendChild(vOffers);

    shell.appendChild(chrome.topbar);
    shell.appendChild(tabs);
    shell.appendChild(main);

    function onLogout() {
      clearAuth(cfg);
      if (cfg.loginUrl) window.location.href = cfg.loginUrl;
      else window.location.reload();
    }

    chrome.logoutBtn.addEventListener("click", onLogout);

    function updateRangeFromInputs() {
      var f = chrome.fromInput.value;
      var t = chrome.toInput.value;
      if (f && t && f > t) {
        toast(root, "Date 'Du' doit être <= 'Au'", "warn");
        return false;
      }
      if (f) state.range.from = f;
      if (t) state.range.to = t;
      return true;
    }

    chrome.fromInput.addEventListener("change", function () {
      if (!updateRangeFromInputs()) {
        chrome.fromInput.value = state.range.from;
        chrome.toInput.value = state.range.to;
        return;
      }
      refreshAll();
    });

    chrome.toInput.addEventListener("change", function () {
      if (!updateRangeFromInputs()) {
        chrome.fromInput.value = state.range.from;
        chrome.toInput.value = state.range.to;
        return;
      }
      refreshAll();
    });

    chrome.refreshBtn.addEventListener("click", function () {
      refreshAll();
    });

    tabs.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".cag-tab") : null;
      if (!btn) return;
      var id = btn.getAttribute("data-tab");
      setActiveView(shell, state, id);
      if (id === "sales") refreshSales();
      if (id === "products") refreshProducts();
      if (id === "offers") refreshOffers();
    });

    // ---- Overview ----
    async function refreshOverview() {
      var view = $('.cag-view[data-view="overview"]', shell);
      if (!view) return;

      try {
        var r = await loadSummary(cfg, state.range);
        var k = (r && (r.kpis || r.data && r.data.kpis || r)) || {};
        var series = (r && (r.series || (r.data && r.data.series))) || [];
        var topProducts = (r && (r.topProducts || (r.data && r.data.topProducts))) || [];
        var topOffers = (r && (r.topOffers || (r.data && r.data.topOffers))) || [];

        state.kpis = {
          revenue: toNumber(k.revenue != null ? k.revenue : k.totalRevenue),
          profit: toNumber(k.profit),
          salesCount: toNumber(k.salesCount != null ? k.salesCount : k.countSales),
          avgTicket: toNumber(k.avgTicket != null ? k.avgTicket : k.averageTicket),
        };
        state.series = Array.isArray(series) ? series : [];
        state.topProducts = Array.isArray(topProducts) ? topProducts : [];
        state.topOffers = Array.isArray(topOffers) ? topOffers : [];

        // Re-render whole overview to keep it simple and consistent.
        view.innerHTML = "";

        var revenue = state.kpis.revenue;
        var profit = state.kpis.profit;
        var salesCount = state.kpis.salesCount;
        var avgTicket = state.kpis.avgTicket != null ? state.kpis.avgTicket : salesCount ? revenue / salesCount : null;
        var margin = revenue && profit != null ? (profit / revenue) * 100 : null;

        var cards = el(
          "div",
          { class: "cag-cards" },
          el(
            "div",
            { class: "cag-card" },
            el("h3", { text: "Revenu" }),
            el("p", { class: "cag-kpi", text: fmtMoney(revenue) }),
            el("div", { class: "cag-kpi-sub", text: state.range.from + " -> " + state.range.to })
          ),
          el(
            "div",
            { class: "cag-card" },
            el("h3", { text: "Profit" }),
            el("p", { class: "cag-kpi", text: fmtMoney(profit) }),
            el("div", { class: "cag-kpi-sub", text: margin == null ? "Marge: —" : "Marge: " + margin.toFixed(1) + "%" })
          ),
          el(
            "div",
            { class: "cag-card" },
            el("h3", { text: "Nombre de ventes" }),
            el("p", { class: "cag-kpi", text: salesCount == null ? "—" : String(salesCount) }),
            el("div", { class: "cag-kpi-sub", text: "Ticket moyen: " + fmtMoney(avgTicket) })
          ),
          el(
            "div",
            { class: "cag-card" },
            el("h3", { text: "Etat" }),
            el("p", { class: "cag-kpi", text: canWrite(cfg, state.user) ? "Admin" : "Lecture" }),
            el("div", { class: "cag-kpi-sub", text: "Front v" + APP_VERSION })
          )
        );

        var chartPanel = el("div", { class: "cag-panel" }, el("h2", { text: "Revenu (jour par jour)" }));
        var chartSeries = state.series.map(function (p) {
          var d = p && (p.date || p.day || p.label);
          return { date: d, revenue: toNumber(p.revenue != null ? p.revenue : p.total) };
        });
        chartPanel.appendChild(svgLineChart(chartSeries, "revenue", fmtMoney));

        var topPanel = el("div", { class: "cag-panel" }, el("h2", { text: "Top produits / offres" }));
        var mini = el("div", { class: "cag-mini-list" });

        function addMini(titleText, items) {
          if (!items || !items.length) return;
          mini.appendChild(el("div", { class: "cag-small", text: titleText }));
          items.slice(0, 5).forEach(function (it) {
            var name = it.name || it.productName || it.label || "—";
            var revenue2 = toNumber(it.revenue != null ? it.revenue : it.total);
            var qty = toNumber(it.qty != null ? it.qty : it.quantity);
            mini.appendChild(
              el(
                "div",
                { class: "cag-mini-item" },
                el("div", {}, el("strong", { text: name }), el("div", { class: "cag-small", text: qty == null ? "" : "Qté: " + qty })),
                el("span", { text: fmtMoney(revenue2) })
              )
            );
          });
        }

        addMini("Produits", state.topProducts);
        addMini("Offres", state.topOffers);

        if (!mini.children.length) mini.appendChild(el("div", { class: "cag-empty", text: "Aucun top item pour cette période." }));
        topPanel.appendChild(mini);

        var split = el("div", { class: "cag-split" }, chartPanel, topPanel);
        view.appendChild(cards);
        view.appendChild(split);

        // Update subtitle in topbar with actual sales count
        var sub = $(".cag-brand-sub", shell);
        if (sub) sub.textContent = cfg.subtitle + " • " + (salesCount == null ? "—" : String(salesCount)) + " ventes";
      } catch (err) {
        view.innerHTML = "";
        var msg = err && err.message ? err.message : "Erreur chargement aperçu";
        view.appendChild(
          el(
            "div",
            { class: "cag-empty" },
            el("div", { class: "cag-badge" }, el("span", { class: "cag-status-dot" }), "Erreur"),
            el("div", { style: { marginTop: "10px" }, text: msg }),
            el(
              "div",
              { class: "cag-small", style: { marginTop: "8px" } },
              "Astuce: configure l'endpoint ",
              el("strong", { text: cfg.epSummary }),
              " dans ton API."
            )
          )
        );
      }
    }

    // ---- Sales ----
    async function refreshSales() {
      var view = $('.cag-view[data-view="sales"]', shell);
      if (!view) return;

      if (!state.sales) state.sales = { q: "", limit: 20, offset: 0, total: 0, items: [] };

      // UI
      view.innerHTML = "";

      var qInput = el("input", { class: "cag-input", type: "search", placeholder: "Recherche (notes, user...)", value: state.sales.q || "" });
      var prevBtn = el("button", { class: "cag-btn", type: "button", text: "Précédent" });
      var nextBtn = el("button", { class: "cag-btn", type: "button", text: "Suivant" });
      var reloadBtn = el("button", { class: "cag-btn", type: "button", text: "Rafraichir" });

      var toolbar = el(
        "div",
        { class: "cag-toolbar" },
        el("div", { class: "cag-toolbar-left" }, qInput, reloadBtn),
        el("div", { class: "cag-toolbar-right" }, prevBtn, nextBtn)
      );

      var box = el("div", { class: "cag-panel" }, el("h2", { text: "Ventes" }), toolbar, el("div", { class: "cag-empty", text: "Chargement..." }));
      view.appendChild(box);

      async function run() {
        try {
          var r = await loadSales(cfg, state.range, state.sales.q, state.sales.limit, state.sales.offset);
          var items = (r && (r.items || (r.data && r.data.items) || r.sales)) || [];
          var total = toNumber((r && (r.total || (r.data && r.data.total))) || items.length) || items.length;
          state.sales.total = total;
          state.sales.items = items.map(normalizeSale).filter(Boolean);

          var rows = state.sales.items.map(function (s) {
            var date = s.createdAt ? String(s.createdAt).replace("T", " ").slice(0, 19) : "—";
            var who = s.username || (s.userId != null ? "User #" + s.userId : "—");
            var tr = el(
              "tr",
              { "data-id": s.id, style: { cursor: "pointer" } },
              el("td", { text: date }),
              el("td", { text: who }),
              el("td", { text: fmtMoney(s.totalAmount) }),
              el("td", { text: s.itemsCount == null ? "—" : String(s.itemsCount) }),
              el("td", { text: s.notes || "" })
            );
            tr.addEventListener("click", function () {
              openSaleDetail(s.id);
            });
            return tr;
          });

          var t = table(["Date", "Caissier", "Total", "Articles", "Notes"], rows);

          var pag = paginate(state.sales, total);
          prevBtn.disabled = pag.page <= 1;
          nextBtn.disabled = pag.page >= pag.pages;

          var footer = el(
            "div",
            { class: "cag-footer-row" },
            el("div", { class: "cag-small", text: "Page " + pag.page + " / " + pag.pages + " • Total: " + total }),
            el("div", { class: "cag-small", text: "Période: " + state.range.from + " -> " + state.range.to })
          );

          // Replace loading
          var empty = $(".cag-empty", box);
          if (empty) empty.parentNode.removeChild(empty);
          box.appendChild(t);
          box.appendChild(footer);
        } catch (err) {
          var empty2 = $(".cag-empty", box);
          if (empty2) empty2.textContent = (err && err.message) || "Erreur chargement ventes";
          else box.appendChild(el("div", { class: "cag-empty", text: (err && err.message) || "Erreur" }));
        }
      }

      function debounce(fn, ms) {
        var t = null;
        return function () {
          var args = arguments;
          window.clearTimeout(t);
          t = window.setTimeout(function () {
            fn.apply(null, args);
          }, ms);
        };
      }

      qInput.addEventListener(
        "input",
        debounce(function () {
          state.sales.q = qInput.value.trim();
          state.sales.offset = 0;
          run();
        }, 300)
      );

      reloadBtn.addEventListener("click", function () {
        run();
      });

      prevBtn.addEventListener("click", function () {
        state.sales.offset = Math.max(0, state.sales.offset - state.sales.limit);
        run();
      });
      nextBtn.addEventListener("click", function () {
        state.sales.offset = state.sales.offset + state.sales.limit;
        run();
      });

      async function openSaleDetail(saleId) {
        try {
          var r2 = await loadSale(cfg, saleId);
          var saleRaw = (r2 && (r2.sale || (r2.data && r2.data.sale) || r2)) || null;
          var detailsRaw = (r2 && (r2.details || (r2.data && r2.data.details) || r2.items)) || [];

          var sale = normalizeSale(saleRaw) || { id: saleId };
          var details = Array.isArray(detailsRaw) ? detailsRaw.map(normalizeSaleDetail).filter(Boolean) : [];

          var body = el("div", {});
          body.appendChild(
            el(
              "div",
              { class: "cag-toolbar", style: { marginBottom: "12px" } },
              el("div", { class: "cag-pill" }, el("span", { class: "cag-status-dot" }), "Vente #" + sale.id),
              el("div", { class: "cag-pill" }, "Total: " + fmtMoney(sale.totalAmount))
            )
          );

          var rows2 = details.map(function (d) {
            return el(
              "tr",
              {},
              el("td", { text: d.productName || (d.productId != null ? "Produit #" + d.productId : "—") }),
              el("td", { text: d.quantity == null ? "—" : String(d.quantity) }),
              el("td", { text: fmtMoney(d.price) }),
              el("td", { text: fmtMoney(d.totalPrice != null ? d.totalPrice : (d.price != null && d.quantity != null ? d.price * d.quantity : null)) })
            );
          });

          body.appendChild(table(["Produit", "Qté", "Prix", "Total"], rows2));
          if (sale.notes) body.appendChild(el("div", { class: "cag-small", style: { marginTop: "10px" }, text: "Notes: " + sale.notes }));

          openModal(root, "Détails de vente", body);
        } catch (err2) {
          toast(root, (err2 && err2.message) || "Erreur chargement détail vente", "err", 5200);
        }
      }

      run();
    }

    // ---- Products ----
    async function refreshProducts() {
      var view = $('.cag-view[data-view="products"]', shell);
      if (!view) return;

      if (!state.products) state.products = { q: "", limit: 20, offset: 0, total: 0, items: [] };

      view.innerHTML = "";

      var qInput = el("input", { class: "cag-input", type: "search", placeholder: "Recherche produit...", value: state.products.q || "" });
      var addBtn = el("button", { class: "cag-btn cag-btn-primary", type: "button", text: "Ajouter" });
      var prevBtn = el("button", { class: "cag-btn", type: "button", text: "Précédent" });
      var nextBtn = el("button", { class: "cag-btn", type: "button", text: "Suivant" });
      var reloadBtn = el("button", { class: "cag-btn", type: "button", text: "Rafraichir" });

      if (!canWrite(cfg, state.user)) addBtn.disabled = true;

      var toolbar = el(
        "div",
        { class: "cag-toolbar" },
        el("div", { class: "cag-toolbar-left" }, qInput, reloadBtn),
        el("div", { class: "cag-toolbar-right" }, addBtn, prevBtn, nextBtn)
      );

      var box = el("div", { class: "cag-panel" }, el("h2", { text: "Produits" }), toolbar, el("div", { class: "cag-empty", text: "Chargement..." }));
      view.appendChild(box);

      async function run() {
        try {
          var r = await loadProducts(cfg, state.products.q, state.products.limit, state.products.offset);
          var items = (r && (r.items || (r.data && r.data.items) || r.products)) || [];
          var total = toNumber((r && (r.total || (r.data && r.data.total))) || items.length) || items.length;
          state.products.total = total;
          state.products.items = items.map(normalizeProduct).filter(Boolean);

          var rows = state.products.items.map(function (p) {
            var actions = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } });
            var editBtn = el("button", { class: "cag-btn", type: "button", text: "Modifier" });
            var delBtn = el("button", { class: "cag-btn cag-btn-danger", type: "button", text: "Supprimer" });
            if (!canWrite(cfg, state.user)) {
              editBtn.disabled = true;
              delBtn.disabled = true;
            }
            editBtn.addEventListener("click", function () {
              openProductModal(p);
            });
            delBtn.addEventListener("click", function () {
              onDelete(p);
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            return el(
              "tr",
              {},
              el("td", { text: p.name || "—" }),
              el("td", { text: p.productType || "—" }),
              el("td", { text: fmtMoney(p.price) }),
              el("td", { text: fmtMoney(p.purchasePrice) }),
              el("td", { text: p.quantity == null ? "—" : String(p.quantity) }),
              el("td", { text: (p.barcode || "") + (p.reference ? " / " + p.reference : "") }),
              el("td", {}, actions)
            );
          });

          var t = table(["Nom", "Type", "Prix", "Achat", "Stock", "Codes", "Actions"], rows);

          var pag = paginate(state.products, total);
          prevBtn.disabled = pag.page <= 1;
          nextBtn.disabled = pag.page >= pag.pages;

          var footer = el("div", { class: "cag-footer-row" }, el("div", { class: "cag-small", text: "Page " + pag.page + " / " + pag.pages + " • Total: " + total }));

          var empty = $(".cag-empty", box);
          if (empty) empty.parentNode.removeChild(empty);

          // Remove existing table/footer before appending again
          $all("table.cag-table, .cag-footer-row", box).forEach(function (n) {
            if (n && n.parentNode) n.parentNode.removeChild(n);
          });

          box.appendChild(t);
          box.appendChild(footer);
        } catch (err) {
          var empty2 = $(".cag-empty", box);
          if (empty2) empty2.textContent = (err && err.message) || "Erreur chargement produits";
          else box.appendChild(el("div", { class: "cag-empty", text: (err && err.message) || "Erreur" }));
        }
      }

      function debounce(fn, ms) {
        var t = null;
        return function () {
          var args = arguments;
          window.clearTimeout(t);
          t = window.setTimeout(function () {
            fn.apply(null, args);
          }, ms);
        };
      }

      qInput.addEventListener(
        "input",
        debounce(function () {
          state.products.q = qInput.value.trim();
          state.products.offset = 0;
          run();
        }, 300)
      );

      reloadBtn.addEventListener("click", function () {
        run();
      });

      prevBtn.addEventListener("click", function () {
        state.products.offset = Math.max(0, state.products.offset - state.products.limit);
        run();
      });
      nextBtn.addEventListener("click", function () {
        state.products.offset = state.products.offset + state.products.limit;
        run();
      });

      addBtn.addEventListener("click", function () {
        openProductModal(null);
      });

      function openProductModal(product) {
        var isEdit = !!product;
        var fName = el("input", { class: "cag-input", type: "text", value: (product && product.name) || "", required: true });
        var fType = el("input", { class: "cag-input", type: "text", value: (product && product.productType) || "" });
        var fBarcode = el("input", { class: "cag-input", type: "text", value: (product && product.barcode) || "" });
        var fRef = el("input", { class: "cag-input", type: "text", value: (product && product.reference) || "" });
        var fQty = el("input", { class: "cag-input", type: "number", step: "1", value: product && product.quantity != null ? String(product.quantity) : "" });
        var fBuy = el("input", { class: "cag-input", type: "number", step: "0.01", value: product && product.purchasePrice != null ? String(product.purchasePrice) : "" });
        var fSell = el("input", { class: "cag-input", type: "number", step: "0.01", value: product && product.price != null ? String(product.price) : "" });
        var fDesc = el("textarea", { class: "cag-input", rows: 3, value: (product && product.description) || "" });

        var form = el(
          "form",
          { class: "cag-form" },
          el("div", { class: "cag-field cag-field-full" }, el("label", { text: "Nom" }), fName),
          el("div", { class: "cag-field" }, el("label", { text: "Type" }), fType),
          el("div", { class: "cag-field" }, el("label", { text: "Code barre" }), fBarcode),
          el("div", { class: "cag-field" }, el("label", { text: "Référence" }), fRef),
          el("div", { class: "cag-field" }, el("label", { text: "Stock" }), fQty),
          el("div", { class: "cag-field" }, el("label", { text: "Prix d'achat" }), fBuy),
          el("div", { class: "cag-field" }, el("label", { text: "Prix de vente" }), fSell),
          el("div", { class: "cag-field cag-field-full" }, el("label", { text: "Description" }), fDesc)
        );

        var saveBtn = el("button", { class: "cag-btn cag-btn-primary", type: "submit", text: isEdit ? "Enregistrer" : "Créer" });
        var cancelBtn = el("button", { class: "cag-btn", type: "button", text: "Annuler" });

        var actions = el("div", { class: "cag-form-actions" }, cancelBtn, saveBtn);
        var modal = openModal(root, isEdit ? "Modifier produit" : "Ajouter produit", form, actions);

        cancelBtn.addEventListener("click", modal.close);

        form.addEventListener("submit", function (e) {
          e.preventDefault();
          (async function () {
            setBusy(saveBtn, true, "Sauvegarde...");
            try {
              var payload = {
                name: fName.value.trim(),
                productType: fType.value.trim(),
                barcode: fBarcode.value.trim(),
                reference: fRef.value.trim(),
                quantity: toNumber(fQty.value),
                purchasePrice: toNumber(fBuy.value),
                price: toNumber(fSell.value),
                description: fDesc.value,
              };
              if (!payload.name) throw new Error("Nom requis");

              if (isEdit) await updateProduct(cfg, product.id, payload);
              else await createProduct(cfg, payload);

              toast(root, isEdit ? "Produit mis à jour." : "Produit créé.", "ok");
              modal.close();
              run();
            } catch (err) {
              toast(root, (err && err.message) || "Erreur sauvegarde produit", "err", 5200);
            } finally {
              setBusy(saveBtn, false, isEdit ? "Enregistrer" : "Créer");
            }
          })();
        });
      }

      function onDelete(product) {
        if (!product || product.id == null) return;
        if (!window.confirm("Supprimer le produit '" + (product.name || "") + "' ?")) return;
        (async function () {
          try {
            await deleteProduct(cfg, product.id);
            toast(root, "Produit supprimé.", "ok");
            run();
          } catch (err) {
            toast(root, (err && err.message) || "Erreur suppression produit", "err", 5200);
          }
        })();
      }

      run();
    }

    // ---- Offers ----
    async function refreshOffers() {
      var view = $('.cag-view[data-view="offers"]', shell);
      if (!view) return;

      if (!state.offers) state.offers = { q: "", limit: 20, offset: 0, total: 0, items: [] };

      view.innerHTML = "";

      var qInput = el("input", { class: "cag-input", type: "search", placeholder: "Recherche offre...", value: state.offers.q || "" });
      var addBtn = el("button", { class: "cag-btn cag-btn-primary", type: "button", text: "Ajouter" });
      var prevBtn = el("button", { class: "cag-btn", type: "button", text: "Précédent" });
      var nextBtn = el("button", { class: "cag-btn", type: "button", text: "Suivant" });
      var reloadBtn = el("button", { class: "cag-btn", type: "button", text: "Rafraichir" });

      if (!canWrite(cfg, state.user)) addBtn.disabled = true;

      var toolbar = el(
        "div",
        { class: "cag-toolbar" },
        el("div", { class: "cag-toolbar-left" }, qInput, reloadBtn),
        el("div", { class: "cag-toolbar-right" }, addBtn, prevBtn, nextBtn)
      );

      var box = el("div", { class: "cag-panel" }, el("h2", { text: "Offres" }), toolbar, el("div", { class: "cag-empty", text: "Chargement..." }));
      view.appendChild(box);

      async function run() {
        try {
          var r = await loadOffers(cfg, state.offers.q, state.offers.limit, state.offers.offset);
          var items = (r && (r.items || (r.data && r.data.items) || r.offers)) || [];
          var total = toNumber((r && (r.total || (r.data && r.data.total))) || items.length) || items.length;
          state.offers.total = total;
          state.offers.items = items.map(normalizeOffer).filter(Boolean);

          var rows = state.offers.items.map(function (o) {
            var actions = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } });
            var editBtn = el("button", { class: "cag-btn", type: "button", text: "Modifier" });
            var delBtn = el("button", { class: "cag-btn cag-btn-danger", type: "button", text: "Supprimer" });
            if (!canWrite(cfg, state.user)) {
              editBtn.disabled = true;
              delBtn.disabled = true;
            }
            editBtn.addEventListener("click", function () {
              openOfferModal(o);
            });
            delBtn.addEventListener("click", function () {
              onDelete(o);
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            return el(
              "tr",
              {},
              el("td", { text: o.name || "—" }),
              el("td", { text: o.quantity == null ? "—" : String(o.quantity) }),
              el("td", { text: fmtMoney(o.price) }),
              el("td", { text: o.productIds ? String(o.productIds.length) : "—" }),
              el("td", {}, actions)
            );
          });

          var t = table(["Nom", "Qté", "Prix", "Produits", "Actions"], rows);

          var pag = paginate(state.offers, total);
          prevBtn.disabled = pag.page <= 1;
          nextBtn.disabled = pag.page >= pag.pages;

          var footer = el("div", { class: "cag-footer-row" }, el("div", { class: "cag-small", text: "Page " + pag.page + " / " + pag.pages + " • Total: " + total }));

          var empty = $(".cag-empty", box);
          if (empty) empty.parentNode.removeChild(empty);

          $all("table.cag-table, .cag-footer-row", box).forEach(function (n) {
            if (n && n.parentNode) n.parentNode.removeChild(n);
          });

          box.appendChild(t);
          box.appendChild(footer);
        } catch (err) {
          var empty2 = $(".cag-empty", box);
          if (empty2) empty2.textContent = (err && err.message) || "Erreur chargement offres";
          else box.appendChild(el("div", { class: "cag-empty", text: (err && err.message) || "Erreur" }));
        }
      }

      function debounce(fn, ms) {
        var t = null;
        return function () {
          var args = arguments;
          window.clearTimeout(t);
          t = window.setTimeout(function () {
            fn.apply(null, args);
          }, ms);
        };
      }

      qInput.addEventListener(
        "input",
        debounce(function () {
          state.offers.q = qInput.value.trim();
          state.offers.offset = 0;
          run();
        }, 300)
      );

      reloadBtn.addEventListener("click", function () {
        run();
      });

      prevBtn.addEventListener("click", function () {
        state.offers.offset = Math.max(0, state.offers.offset - state.offers.limit);
        run();
      });
      nextBtn.addEventListener("click", function () {
        state.offers.offset = state.offers.offset + state.offers.limit;
        run();
      });

      addBtn.addEventListener("click", function () {
        openOfferModal(null);
      });

      async function getAllProductsForSelect() {
        // Cache once per page.
        if (state._productsAll && Array.isArray(state._productsAll) && state._productsAll.length) return state._productsAll;
        var r = await loadProducts(cfg, "", 2000, 0);
        var items = (r && (r.items || (r.data && r.data.items) || r.products)) || [];
        state._productsAll = items.map(normalizeProduct).filter(Boolean);
        return state._productsAll;
      }

      function openOfferModal(offer) {
        var isEdit = !!offer;

        var fName = el("input", { class: "cag-input", type: "text", value: (offer && offer.name) || "", required: true });
        var fQty = el("input", { class: "cag-input", type: "number", step: "1", value: offer && offer.quantity != null ? String(offer.quantity) : "" });
        var fPrice = el("input", { class: "cag-input", type: "number", step: "0.01", value: offer && offer.price != null ? String(offer.price) : "" });
        var prodSearch = el("input", { class: "cag-input", type: "search", placeholder: "Filtrer produits..." });
        var multi = el("div", { class: "cag-multi" }, el("div", { class: "cag-empty", text: "Chargement produits..." }));

        var form = el(
          "form",
          { class: "cag-form" },
          el("div", { class: "cag-field cag-field-full" }, el("label", { text: "Nom" }), fName),
          el("div", { class: "cag-field" }, el("label", { text: "Quantité" }), fQty),
          el("div", { class: "cag-field" }, el("label", { text: "Prix" }), fPrice),
          el("div", { class: "cag-field cag-field-full" }, el("label", { text: "Produits inclus" }), prodSearch, multi)
        );

        var saveBtn = el("button", { class: "cag-btn cag-btn-primary", type: "submit", text: isEdit ? "Enregistrer" : "Créer" });
        var cancelBtn = el("button", { class: "cag-btn", type: "button", text: "Annuler" });
        var actions = el("div", { class: "cag-form-actions" }, cancelBtn, saveBtn);

        var modal = openModal(root, isEdit ? "Modifier offre" : "Ajouter offre", form, actions);
        cancelBtn.addEventListener("click", modal.close);

        var selected = Object.create(null);
        (offer && offer.productIds ? offer.productIds : []).forEach(function (id) {
          selected[String(id)] = true;
        });

        var allProducts = [];

        function renderMulti(filterText) {
          filterText = (filterText || "").toLowerCase().trim();
          multi.innerHTML = "";
          var shown = 0;
          allProducts.forEach(function (p) {
            var label = (p.name || "") + " " + (p.barcode || "") + " " + (p.reference || "") + " " + (p.productType || "");
            if (filterText && label.toLowerCase().indexOf(filterText) === -1) return;
            shown++;
            var id = p.id;
            var checked = selected[String(id)] === true;
            var box = el("input", { type: "checkbox", checked: checked });
            box.addEventListener("change", function () {
              if (box.checked) selected[String(id)] = true;
              else delete selected[String(id)];
            });
            multi.appendChild(
              el(
                "label",
                { class: "cag-check" },
                box,
                el("div", {}, el("div", { style: { fontWeight: "800", fontSize: "13px" }, text: p.name || "—" }), el("div", { class: "cag-small", text: (p.productType || "—") + " • " + fmtMoney(p.price) }))
              )
            );
          });
          if (shown === 0) multi.appendChild(el("div", { class: "cag-empty", text: "Aucun produit." }));
        }

        (async function () {
          try {
            allProducts = await getAllProductsForSelect();
            renderMulti("");
          } catch (err) {
            multi.innerHTML = "";
            multi.appendChild(el("div", { class: "cag-empty", text: (err && err.message) || "Erreur chargement produits" }));
          }
        })();

        prodSearch.addEventListener("input", function () {
          renderMulti(prodSearch.value);
        });

        form.addEventListener("submit", function (e) {
          e.preventDefault();
          (async function () {
            setBusy(saveBtn, true, "Sauvegarde...");
            try {
              var productIds = Object.keys(selected).map(function (k) {
                return Number(k);
              });
              var payload = {
                name: fName.value.trim(),
                quantity: toNumber(fQty.value),
                price: toNumber(fPrice.value),
                productIds: productIds,
              };
              if (!payload.name) throw new Error("Nom requis");

              if (isEdit) await updateOffer(cfg, offer.id, payload);
              else await createOffer(cfg, payload);

              toast(root, isEdit ? "Offre mise à jour." : "Offre créée.", "ok");
              modal.close();
              run();
            } catch (err) {
              toast(root, (err && err.message) || "Erreur sauvegarde offre", "err", 5200);
            } finally {
              setBusy(saveBtn, false, isEdit ? "Enregistrer" : "Créer");
            }
          })();
        });
      }

      function onDelete(offer) {
        if (!offer || offer.id == null) return;
        if (!window.confirm("Supprimer l'offre '" + (offer.name || "") + "' ?")) return;
        (async function () {
          try {
            await deleteOffer(cfg, offer.id);
            toast(root, "Offre supprimée.", "ok");
            run();
          } catch (err) {
            toast(root, (err && err.message) || "Erreur suppression offre", "err", 5200);
          }
        })();
      }

      run();
    }

    async function refreshAll() {
      setBusy(chrome.refreshBtn, true, "Rafraichit...");
      try {
        await refreshOverview();
        if (state.view === "sales") await refreshSales();
        if (state.view === "products") await refreshProducts();
        if (state.view === "offers") await refreshOffers();
      } finally {
        setBusy(chrome.refreshBtn, false, "Rafraichir");
      }
    }

    // Initial paint
    setActiveView(shell, state, state.view);
    refreshAll();
  }

  async function mount(root) {
    if (!root || root.getAttribute("data-cag-mounted") === "1") return;
    root.setAttribute("data-cag-mounted", "1");

    var cfg = readConfig(root);
    var shell = renderAppChrome(root, cfg);

    if (!cfg.apiBase) {
      shell.appendChild(
        el(
          "div",
          { class: "cag-login" },
          el("h1", { text: "Configuration manquante" }),
          el("p", { text: "Ajoute l'attribut data-api-base sur la div racine (URL de ton API)." }),
          el("div", { class: "cag-small", html: "Ex: <code>data-api-base=\"https://ton-domaine.com/api\"</code>" })
        )
      );
      return;
    }

    // If dashboard page: require auth, otherwise show login form.
    if (cfg.page === "login") {
      renderLogin(shell, root, cfg);
      return;
    }

    // dashboard page
    var user = await ensureAuth(root, cfg);
    if (!user) {
      if (cfg.loginUrl) {
        // Redirect to login page if configured.
        window.location.href = cfg.loginUrl;
        return;
      }
      renderLogin(shell, root, cfg);
      return;
    }

    var to = todayISO();
    var from = isoAddDays(to, -cfg.defaultRangeDays);

    var state = {
      user: user,
      range: { from: from, to: to },
      view: "overview",
      kpis: { revenue: null, profit: null, salesCount: null, avgTicket: null },
      series: [],
      topProducts: [],
      topOffers: [],
      sales: null,
      products: null,
      offers: null,
      _productsAll: null,
    };

    renderDashboard(shell, root, cfg, state);
  }

  function boot() {
    var roots = $all(ROOT_SELECTOR);
    roots.forEach(function (root) {
      mount(root);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

