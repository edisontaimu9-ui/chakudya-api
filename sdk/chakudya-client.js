/**
 * Chakudya Nutrition Registry (CNR) — JS Client SDK
 * ---------------------------------------------------------------
 * Zero dependencies, no build step. Wraps every CNR endpoint so
 * Oasis, Thanzi, DietitianOS, and the portfolio site don't each
 * hand-roll their own fetch() calls against the Worker.
 *
 * Load it the same way as your other vanilla JS modules (foodData.js etc.):
 *   <script src="chakudya-client.js"></script>
 *   const cnr = new ChakudyaClient(...);   // -> window.ChakudyaClient
 *
 * Also exports via module.exports for anything Node/bundler-based
 * (e.g. a build script or a future React rewrite) that does
 * `const { ChakudyaClient } = require("./chakudya-client.js")`.
 *
 * Usage:
 *   const cnr = new ChakudyaClient("https://chakudya-api.edisontaimu9.workers.dev");
 *
 *   const foods = await cnr.foods.list({ search: "nsima", limit: 10 });
 *   const hit   = await cnr.foods.lookup({ q: "banana" });
 *   const chunk = await cnr.rag.retrieve("high potassium foods", { topK: 5 });
 *
 *   // Admin (write) calls — pass the admin key once at construction, or
 *   // per-call via the `adminKey` option if you need to switch keys.
 *   const admin = new ChakudyaClient(baseUrl, { adminKey: "chakudya_admin_xxx" });
 *   await admin.foods.create({ food_name: "Matemba", category: "fish" });
 *
 * Every method returns the parsed JSON body on success and throws a
 * ChakudyaApiError (with .status and .body) on a non-2xx response, so
 * callers can just try/catch instead of checking `status === "success"`
 * on every call.
 */

class ChakudyaApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ChakudyaApiError";
    this.status = status;
    this.body = body;
  }
}

class ChakudyaClient {
  /**
   * @param {string} baseUrl - e.g. "https://chakudya-api.edisontaimu9.workers.dev" (no trailing slash needed)
   * @param {object} [opts]
   * @param {string} [opts.adminKey] - bearer token for admin (write) routes
   * @param {number} [opts.timeoutMs] - abort a request after this long (default 20000)
   */
  constructor(baseUrl, opts = {}) {
    if (!baseUrl) throw new Error("ChakudyaClient requires a baseUrl");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.adminKey = opts.adminKey || null;
    this.timeoutMs = opts.timeoutMs || 20000;

    // Generic CRUD-ish resources — same shape as the Worker's routePolicy.
    this.foods = this._crud("foods", { extra: { lookup: (params) => this._get("/foods/lookup", params) } });
    this.exchange = this._crud("exchange");
    this.renal = this._crud("renal");
    this.formulas = this._crud("formulas");
    this.manufacturers = this._crud("manufacturers", { supportsPut: false });
    this.products = this._crud("products");

    this.packaged = {
      list: (params) => this._get("/packaged", params),
      submit: (payload) => this._post("/packaged/submit", payload),
      scan: (images) => this._post("/packaged/scan", { images }),
      update: (id, payload) => this._patch(`/packaged/${id}`, payload),
      remove: (id) => this._delete(`/packaged/${id}`),
    };

    this.nutrition = {
      get: (productId) => this._get("/nutrition", { product_id: productId }),
    };

    this.rag = {
      retrieve: (query, { context = "both", topK = 5 } = {}) =>
        this._post("/rag/retrieve", { query, context, top_k: topK }),
      ingest: (payload) => this._post("/rag/ingest", payload), // admin
    };

    this.memory = {
      write: (sessionId, content, { kind = "fact", patientLabel } = {}) =>
        this._post("/memory/write", {
          session_id: sessionId,
          content,
          kind,
          patient_label: patientLabel,
        }),
      recall: (sessionId, query, { topK = 5 } = {}) =>
        this._post("/memory/recall", { session_id: sessionId, query, top_k: topK }),
      consolidate: (sessionId) => this._post("/memory/consolidate", { session_id: sessionId }), // admin
    };
  }

  /** GET / — version, maintainer, auth notes, and the live endpoint list. */
  root() {
    return this._get("/");
  }

  // ── Generic CRUD factory for the plain resource-table endpoints ──────────
  _crud(resource, { supportsPut = true, extra = {} } = {}) {
    const base = `/${resource}`;
    const api = {
      list: (params) => this._get(base, params),
      get: (id) => this._get(`${base}/${id}`),
      create: (payload) => this._post(base, payload), // admin
      update: (id, payload) => this._patch(`${base}/${id}`, payload), // admin
      remove: (id) => this._delete(`${base}/${id}`), // admin
      ...extra,
    };
    if (supportsPut) {
      api.replace = (id, payload) => this._put(`${base}/${id}`, payload); // admin
    }
    return api;
  }

  // ── Low-level request helpers ─────────────────────────────────────────
  _url(path, params) {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  async _request(method, path, { params, payload } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = { "Content-Type": "application/json" };
    if (this.adminKey) headers.Authorization = `Bearer ${this.adminKey}`;

    try {
      const res = await fetch(this._url(path, params), {
        method,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });

      const body = await res.json().catch(() => null);

      if (!res.ok || body?.status === "error") {
        throw new ChakudyaApiError(
          body?.message || `Request failed (${res.status})`,
          res.status,
          body
        );
      }

      return body?.data !== undefined ? body.data : body;
    } finally {
      clearTimeout(timeout);
    }
  }

  _get(path, params) {
    return this._request("GET", path, { params });
  }
  _post(path, payload) {
    return this._request("POST", path, { payload });
  }
  _put(path, payload) {
    return this._request("PUT", path, { payload });
  }
  _patch(path, payload) {
    return this._request("PATCH", path, { payload });
  }
  _delete(path) {
    return this._request("DELETE", path);
  }
}

// Dual export: ES module + plain-script global, so it drops into any of
// the four apps without changing how each one already loads scripts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ChakudyaClient, ChakudyaApiError };
}
if (typeof window !== "undefined") {
  window.ChakudyaClient = ChakudyaClient;
  window.ChakudyaApiError = ChakudyaApiError;
}
