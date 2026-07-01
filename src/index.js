/**
 * Chakudya API — Malawi's First Open Food & Nutrition Database
 * Cloudflare Worker · Supabase REST backend (no SDK, pure fetch)
 * ---------------------------------------------------------------
 * Author : Edison Taimu 
 * Version: 1.1.0
 *
 * v1.1.0 changes:
 *  - Added admin-key auth on all write routes (POST/PUT/PATCH/DELETE)
 *  - Added per-IP rate limiting via KV (reads + writes + RAG calls)
 *  - Fixed RAG retrieve: "both"/empty context no longer sent as a literal filter value
 *  - Capped `limit` query param to prevent oversized queries
 *
 * Required bindings (set in Cloudflare dashboard → Worker → Settings):
 *  - env.SUPABASE_URL          (existing)
 *  - env.SUPABASE_KEY          (existing)
 *  - env.COHERE_API_KEY        (existing)
 *  - env.ADMIN_API_KEY         (NEW — secret string, e.g. "chakudya_admin_xxx")
 *  - env.RATE_LIMIT_KV         (NEW — a KV namespace binding)
 */

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
};

// ─── RESPONSE HELPERS ────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function success(data, extras = {}) {
  return json({ status: "success", ...extras, data });
}

function listSuccess(data, { count = null, limit = 50, offset = 0 } = {}) {
  return json({
    status: "success",
    count: count ?? data.length,
    limit,
    offset,
    data,
  });
}

function err(message, status = 400) {
  return json({ status: "error", message }, status);
}

function notFound(resource = "Route") {
  return err(`${resource} not found`, 404);
}

function unauthorized(message = "Valid API key required for this action") {
  return err(message, 401);
}

function rateLimited(retryAfter = 60) {
  return json(
    { status: "error", message: "Rate limit exceeded. Try again shortly." },
    429,
    { "Retry-After": String(retryAfter) }
  );
}

function serverErr(e) {
  console.error(e);
  return err("Internal server error", 500);
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** True if the request carries a valid admin key. */
function isAdmin(request, env) {
  const token = getBearerToken(request);
  if (!env.ADMIN_API_KEY) {
    // Misconfiguration safety: if no admin key is set, fail closed (deny writes)
    // rather than silently allowing unauthenticated writes.
    return false;
  }
  return !!token && token === env.ADMIN_API_KEY;
}

// ─── RATE LIMITING (Cloudflare KV) ──────────────────────────────────────────

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/**
 * Fixed-window rate limiter backed by KV.
 * Returns true if the request is allowed, false if the limit was hit.
 * Fails OPEN (allows the request) if RATE_LIMIT_KV isn't bound, so the API
 * doesn't go fully down just because the namespace wasn't configured yet —
 * but this should be treated as a setup TODO, not a permanent state.
 */
async function checkRateLimit(env, bucketKey, limit, windowSeconds) {
  if (!env.RATE_LIMIT_KV) return true;

  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucketKey}:${windowId}`;

  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= limit) return false;

  await env.RATE_LIMIT_KV.put(key, String(current + 1), {
    expirationTtl: windowSeconds + 5,
  });
  return true;
}

/**
 * Central policy: how each route is protected.
 * - auth: "public" | "admin"
 * - rate: { limit, windowSeconds, scope: "ip" | "admin" }
 * Tune these numbers as real usage patterns emerge.
 */
function routePolicy(resource, method, param) {
  const isWrite = method !== "GET";
  const isPackagedSubmit = resource === "packaged" && param === "submit" && method === "POST";
  const isRagRetrieve = resource === "rag" && (param === "retrieve" || !param) && method === "POST";
  const isRagIngest = resource === "rag" && param === "ingest" && method === "POST";

  // Community submissions: public, but tightly rate-limited to deter spam.
  if (isPackagedSubmit) {
    return { auth: "public", rate: { limit: 10, windowSeconds: 60, scope: "ip" } };
  }

  // RAG retrieve costs a Cohere call per request — public but capped harder than plain reads.
  if (isRagRetrieve) {
    return { auth: "public", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // RAG ingest writes to the knowledge base AND costs a Cohere call — admin only.
  if (isRagIngest) {
    return { auth: "admin", rate: { limit: 30, windowSeconds: 60, scope: "admin" } };
  }

  // All other writes (foods/exchange/renal/formulas/packaged CRUD): admin only.
  if (isWrite) {
    return { auth: "admin", rate: { limit: 60, windowSeconds: 60, scope: "admin" } };
  }

  // Plain reads: public, generous but bounded.
  return { auth: "public", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
}

// ─── SUPABASE CLIENT ─────────────────────────────────────────────────────────

function supabase(env) {
  const base = env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
  const headers = {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  function buildUrl(table, { filters = {}, select = "*", order } = {}) {
    const url = new URL(`${base}/${table}`);
    url.searchParams.set("select", select);
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    if (order) url.searchParams.set("order", order);
    return url.toString();
  }

  async function query(url, options = {}) {
    const res = await fetch(url, { headers: { ...headers, ...options.headers }, ...options });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  }

  return {
    async select(table, { filters = {}, limit = 50, offset = 0, order } = {}) {
      const url = buildUrl(table, { filters, order });
      const rangeStart = offset;
      const rangeEnd = offset + limit - 1;
      const res = await fetch(url, {
        headers: {
          ...headers,
          Range: `${rangeStart}-${rangeEnd}`,
          "Range-Unit": "items",
          Prefer: "count=exact",
        },
      });
      const body = await res.json().catch(() => []);
      const contentRange = res.headers.get("Content-Range") || "";
      const total = contentRange.includes("/")
        ? parseInt(contentRange.split("/")[1], 10)
        : null;
      return { ok: res.ok, status: res.status, body, total };
    },

    async selectOne(table, id) {
      const url = buildUrl(table, { filters: { id: `eq.${id}` } });
      const { ok, status, body } = await query(url);
      if (!ok) return { ok, status, body };
      const row = Array.isArray(body) ? body[0] : body;
      return { ok: !!row, status: row ? 200 : 404, body: row || null };
    },

    async insert(table, payload) {
      const url = `${base}/${table}`;
      const { ok, status, body } = await query(url, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const row = Array.isArray(body) ? body[0] : body;
      return { ok, status, body: row };
    },

    async update(table, id, payload, method = "PATCH") {
      const url = buildUrl(table, { filters: { id: `eq.${id}` } });
      const { ok, status, body } = await query(url, {
        method,
        body: JSON.stringify(payload),
      });
      const row = Array.isArray(body) ? body[0] : body;
      return { ok, status, body: row };
    },

    async remove(table, id) {
      const url = buildUrl(table, { filters: { id: `eq.${id}` } });
      const res = await fetch(url, { method: "DELETE", headers });
      return { ok: res.ok, status: res.status };
    },

    async rpc(fnName, params = {}) {
      const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${fnName}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body };
    },
  };
}

// ─── BODY PARSER ─────────────────────────────────────────────────────────────

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function intParam(url, key, fallback) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : Math.max(0, n);
}

/** Same as intParam but capped to prevent absurdly large queries (e.g. ?limit=999999). */
function limitParam(url, fallback = 50, max = 100) {
  return Math.min(intParam(url, "limit", fallback), max);
}

// ─── COHERE EMBEDDING ─────────────────────────────────────────────────────────

async function embedText(text, env, inputType = "search_query") {
  const res = await fetch("https://api.cohere.com/v1/embed", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      texts: [text],
      model: "embed-multilingual-v3.0",
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Cohere embed failed: ${e.message || res.status}`);
  }

  const data = await res.json();
  return data.embeddings[0];
}

// ─── RAG HANDLER ─────────────────────────────────────────────────────────────

// POST /rag/retrieve  — semantic search
// POST /rag/ingest    — add a document chunk to the knowledge base
async function handleRAG(request, url, db, env, param) {
  if (request.method !== "POST") return err("Method not allowed", 405);

  const body = await parseBody(request);
  if (!body) return err("Request body required");

  // ── POST /rag/ingest ───────────────────────────────────────────────────────
  if (param === "ingest") {
    const { content, source, context = "both", metadata = {} } = body;
    if (!content) return err("'content' is required");
    if (!source) return err("'source' is required");

    let embedding;
    try {
      embedding = await embedText(content, env, "search_document");
    } catch (e) {
      return err(`Embedding failed: ${e.message}`, 502);
    }

    const { ok, status, body: row } = await db.insert("rag_knowledge_base", {
      content,
      embedding: JSON.stringify(embedding),
      source,
      context,
      metadata,
    });

    if (!ok) return err(row?.message || "Ingest failed", status);
    return success(row, { message: "Document ingested into RAG knowledge base" });
  }

  // ── POST /rag/retrieve ─────────────────────────────────────────────────────
  if (param === "retrieve" || !param) {
    const { query, context = "both", top_k = 5 } = body;
    if (!query) return err("'query' is required");

    let queryEmbedding;
    try {
      queryEmbedding = await embedText(query, env, "search_query");
    } catch (e) {
      return err(`Embedding failed: ${e.message}`, 502);
    }

    // FIX: "both" (or empty) used to be passed straight through as a literal
    // context_filter value, which would only match rows literally tagged
    // context = 'both'. Normalise to null so match_documents treats it as
    // "no filter" (assuming the SQL function does `where app_filter is null or ...`).
    const contextFilter = !context || context === "both" ? null : context;

    const { ok, status, body: chunks } = await db.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_count: Math.min(top_k, 20),
      context_filter: contextFilter,
    });

    if (!ok) return err(chunks?.message || "RAG search failed", status);

    return success(chunks, {
      query,
      context,
      count: Array.isArray(chunks) ? chunks.length : 0,
    });
  }

  return notFound("RAG route");
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

// GET /
function handleRoot() {
  return success({
    name: "Chakudya API",
    tagline: "Malawi's first open Food & Nutrition Database",
    version: "1.1.0",
    maintainer: "Taimu Tech Solutions",
    auth: "Write operations (POST/PUT/PATCH/DELETE) require 'Authorization: Bearer <admin key>', except POST /packaged/submit and POST /rag/retrieve, which are public but rate-limited.",
    endpoints: {
      foods: [
        "GET  /foods",
        "GET  /foods/:id",
        "POST /foods            (admin)",
        "PUT  /foods/:id        (admin)",
        "PATCH /foods/:id       (admin)",
        "DELETE /foods/:id      (admin)",
      ],
      exchange_lists: [
        "GET  /exchange",
        "POST /exchange         (admin)",
        "PUT  /exchange/:id     (admin)",
        "PATCH /exchange/:id    (admin)",
        "DELETE /exchange/:id   (admin)",
      ],
      renal: [
        "GET  /renal",
        "POST /renal            (admin)",
        "PUT  /renal/:id        (admin)",
        "PATCH /renal/:id       (admin)",
        "DELETE /renal/:id      (admin)",
      ],
      enteral_formulas: [
        "GET  /formulas",
        "POST /formulas         (admin)",
        "PUT  /formulas/:id     (admin)",
        "PATCH /formulas/:id    (admin)",
        "DELETE /formulas/:id   (admin)",
      ],
      packaged_foods: [
        "GET  /packaged",
        "POST /packaged/submit  (public, rate-limited — community contribution, status=pending)",
        "PUT  /packaged/:id     (admin)",
        "PATCH /packaged/:id    (admin)",
        "DELETE /packaged/:id   (admin)",
      ],
      rag: [
        "POST /rag/retrieve     (public, rate-limited) → semantic search (query, context, top_k)",
        "POST /rag/ingest       (admin) → add document chunk (content, source, context)",
      ],
    },
  });
}

// ── /foods ────────────────────────────────────────────────────────────────────

async function handleFoods(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    if (id) {
      const { ok, status, body } = await db.selectOne("foods", id);
      if (status === 404) return notFound("Food");
      if (!ok) return err(body?.message || "Query failed", status);
      return success(body);
    }

    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const search = url.searchParams.get("search") || "";
    const category = url.searchParams.get("category") || "";

    const filters = {};
    if (category) filters["category"] = `eq.${category}`;
    if (search) filters["food_name"] = `ilike.*${search}*`;

    const { ok, status, body, total } = await db.select("foods", {
      filters,
      limit,
      offset,
      order: "food_name.asc",
    });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload || !payload.food_name) return err("'food_name' is required");
    const { ok, status, body } = await db.insert("foods", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Food created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("foods", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Food replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("foods", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Food updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("foods", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Food ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ── /exchange ─────────────────────────────────────────────────────────────────

async function handleExchange(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const type = url.searchParams.get("type") || "";
    const filters = {};
    if (type) filters["exchange_type"] = `eq.${type}`;

    const { ok, status, body, total } = await db.select("exchange_lists", {
      filters,
      limit,
      offset,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.insert("exchange_lists", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Exchange list entry created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("exchange_lists", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Exchange entry replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("exchange_lists", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Exchange entry updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("exchange_lists", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Exchange entry ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ── /renal ────────────────────────────────────────────────────────────────────

async function handleRenal(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const { ok, status, body, total } = await db.select("renal_foods", { limit, offset });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.insert("renal_foods", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Renal food entry created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("renal_foods", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Renal entry replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("renal_foods", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Renal entry updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("renal_foods", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Renal entry ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ── /formulas ─────────────────────────────────────────────────────────────────

async function handleFormulas(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const route = url.searchParams.get("route") || "";
    const filters = {};
    if (route) filters["route"] = `eq.${route}`;

    const { ok, status, body, total } = await db.select("enteral_formulas", {
      filters,
      limit,
      offset,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.insert("enteral_formulas", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Formula created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("enteral_formulas", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Formula replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("enteral_formulas", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Formula updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("enteral_formulas", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Formula ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ── /packaged ─────────────────────────────────────────────────────────────────

async function handlePackaged(request, url, db, id, isSubmit) {
  const method = request.method;

  if (method === "GET") {
    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const barcode = url.searchParams.get("barcode") || "";
    const filters = {};
    if (barcode) filters["barcode"] = `eq.${barcode}`;

    const { ok, status, body, total } = await db.select("packaged_foods", {
      filters,
      limit,
      offset,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  // POST /packaged/submit — public community contribution
  if (method === "POST" && isSubmit) {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    if (!payload.barcode) return err("'barcode' is required");
    if (!payload.product_name) return err("'product_name' is required");

    const data = { status: "pending", submitted_at: new Date().toISOString(), ...payload };
    const { ok, status, body } = await db.insert("packaged_foods", data);
    if (!ok) return err(body?.message || "Submit failed", status);
    return success(body, { message: "Packaged food submitted for review" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("packaged_foods", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Packaged food replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("packaged_foods", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Packaged food updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("packaged_foods", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Packaged food ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

async function router(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const segments = pathname.split("/").filter(Boolean);

  const db = supabase(env);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET /
  if (pathname === "/" && request.method === "GET") {
    return handleRoot();
  }

  const [resource, param] = segments;

  // ── Centralised auth + rate limit gate ─────────────────────────────────────
  const policy = routePolicy(resource, request.method, param);

  if (policy.auth === "admin" && !isAdmin(request, env)) {
    return unauthorized();
  }

  const rateBucketKey =
    policy.rate.scope === "admin"
      ? `admin:${getBearerToken(request) || "unknown"}`
      : `ip:${clientIp(request)}:${resource || "root"}`;

  const allowed = await checkRateLimit(
    env,
    rateBucketKey,
    policy.rate.limit,
    policy.rate.windowSeconds
  );
  if (!allowed) return rateLimited(policy.rate.windowSeconds);

  try {
    switch (resource) {
      case "foods": {
        const id = param || null;
        return await handleFoods(request, url, db, id);
      }

      case "exchange": {
        const id = param || null;
        return await handleExchange(request, url, db, id);
      }

      case "renal": {
        const id = param || null;
        return await handleRenal(request, url, db, id);
      }

      case "formulas": {
        const id = param || null;
        return await handleFormulas(request, url, db, id);
      }

      case "packaged": {
        const isSubmit = param === "submit";
        const id = isSubmit ? null : param || null;
        return await handlePackaged(request, url, db, id, isSubmit);
      }

      case "rag": {
        return await handleRAG(request, url, db, env, param || null);
      }

      default:
        return notFound();
    }
  } catch (e) {
    return serverErr(e);
  }
}

// ─── WORKER ENTRY ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (e) {
      return serverErr(e);
    }
  },
};
