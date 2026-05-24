(function () {
  "use strict";

  var APP_VERSION = "3.1.0";
  var STORAGE_KEY = "cag_admin_v2_auth";
  var API_ROOT = "/api";
  var DEFAULT_NEXT = "/admin";

  function $(id) {
    return document.getElementById(id);
  }

  function nextUrl() {
    try {
      var url = new URL(window.location.href);
      var next = url.searchParams.get("next") || DEFAULT_NEXT;
      if (!next || /^https?:\/\//i.test(next) || next.indexOf("//") === 0) return DEFAULT_NEXT;
      if (next === "/login" || next.indexOf("/login?") === 0) return DEFAULT_NEXT;
      return next.charAt(0) === "/" ? next : DEFAULT_NEXT;
    } catch (_) {
      return DEFAULT_NEXT;
    }
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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: token, user: user || null, updatedAt: new Date().toISOString(), appVersion: APP_VERSION })
    );
  }

  function clearAuth() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (label) btn.textContent = label;
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.token) headers.Authorization = "Bearer " + opts.token;

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 30000) : null;
    try {
      var res = await fetch(API_ROOT + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      var text = await res.text();
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
      }
      if (!res.ok) {
        var msg = data && data.message ? data.message : "Erreur API";
        var err = new Error(msg + " (HTTP " + res.status + ")");
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("Timeout API. Reessaie dans quelques secondes.");
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function verifyExistingSession() {
    var auth = readAuth();
    if (!auth || !auth.token) return false;
    try {
      await api("/auth/me", { token: auth.token, timeoutMs: 15000 });
      window.location.replace(nextUrl());
      return true;
    } catch (_) {
      clearAuth();
      return false;
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    var form = $("login-form");
    var username = $("login-username");
    var password = $("login-password");
    var submit = $("login-submit");
    var error = $("login-error");
    if (!form || !username || !password || !submit || !error) return;

    error.textContent = "";
    setBusy(submit, true, "Connexion...");
    try {
      var data = await api("/auth/login", {
        method: "POST",
        body: { username: username.value.trim(), password: password.value },
        timeoutMs: 30000,
      });
      if (!data || !data.token) throw new Error("Token manquant");
      writeAuth(data.token, data.user || null);
      window.location.replace(nextUrl());
    } catch (err) {
      error.textContent = err && err.message ? err.message : "Connexion impossible";
    } finally {
      setBusy(submit, false, "Entrer dans le cockpit");
    }
  }

  async function bootstrap() {
    var form = $("login-form");
    if (form) form.addEventListener("submit", handleSubmit);
    await verifyExistingSession();
    console.info("[CAG LOGIN] version", APP_VERSION);
  }

  bootstrap().catch(function (err) {
    console.error(err);
    var error = $("login-error");
    if (error) error.textContent = err && err.message ? err.message : "Erreur chargement login";
  });
})();
