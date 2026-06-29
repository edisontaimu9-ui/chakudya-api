/**
 * Chakudya API — Malawi's First Open Food & Nutrition Database
 * Cloudflare Worker · Supabase REST backend (no SDK, pure fetch)
 * ---------------------------------------------------------------
 * Author : Taimu Tech Solutions
 * Version: 1.0.0
 */

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
};

// ─── RESPONSE HELPERS ────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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

function serverErr(e) {
  console.error(e);
  return err("Internal server error", 500);
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

  /**
   * Build a Supabase REST URL with query params.
   * filters  → { column: "eq.value" } → ?column=eq.value
   * select   → columns string e.g. "*"
   * order    → e.g. "id.asc"
   * range    → [from, to] for Range header
   */
  function buildUrl(table, { filters = {}, select = "*", order, range } = {}) {
    const url = new URL(`${base}/${table}`);
    url.searchParams.set("select", select);
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    if (order) url.searchParams.set("order", order);
    if (range) {
      // range = { from, to } handled via Prefer header elsewhere
    }
    return url.toString();
  }

  async function query(url, options = {}) {
    const res = await fetch(url, { headers: { ...headers, ...options.headers }, ...options });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  }

  return {
    /** SELECT rows with optional filters, limit, offset */
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
      // Content-Range: 0-49/312
      const total = contentRange.includes("/")
        ? parseInt(contentRange.split("/")[1], 10)
        : null;
      return { ok: res.ok, status: res.status, body, total };
    },

    /** SELECT single row by id */
    async selectOne(table, id) {
      const url = buildUrl(table, { filters: { id: `eq.${id}` } });
      const { ok, status, body } = await query(url);
      if (!ok) return { ok, status, body };
      const row = Array.isArray(body) ? body[0] : body;
      return { ok: !!row, status: row ? 200 : 404, body: row || null };
    },

    /** INSERT a row */
    async insert(table, payload) {
      const url = `${base}/${table}`;
      const { ok, status, body } = await query(url, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const row = Array.isArray(body) ? body[0] : body;
      return { ok, status, body: row };
    },

    /** UPDATE (PUT / PATCH) by id */
    async update(table, id, payload, method = "PATCH") {
      const url = buildUrl(table, { filters: { id: `eq.${id}` } });
      const { ok, status, body } = await query(url, {
        method,
        body: JSON.stringify(payload),
      });
      const row = Array.isArray(body) ? body[0] : body;
      return { ok, status, body: row };
    },

    /** DELETE by id */
    async remove(table, id) {
      const url = buildUrl(table, { filters: { id: `eq.${id}` } });
      const res = await fetch(url, { method: "DELETE", headers });
      return { ok: res.ok, status: res.status };
    },

    /** CALL a Postgres RPC function */
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

// ─── COHERE EMBEDDING ─────────────────────────────────────────────────────────

async function embedText(text, env) {
  const res = await fetch("https://api.cohere.com/v1/embed", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      texts: [text],
      model: "embed-multilingual-v3.0",
      input_type: "search_query",
    }),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Cohere embed failed: ${e.message || res.status}`);
  }

  const data = await res.json();
  return data.embeddings[0]; // array of 1024 floats
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
    if (!source)  return err("'source' is required");

    let embedding;
    try {
      // Use search_document input type for ingestion
      const res = await fetch("https://api.cohere.com/v1/embed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.COHERE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          texts: [content],
          model: "embed-multilingual-v3.0",
          input_type: "search_document",
        }),
      });
      const data = await res.json();
      embedding = data.embeddings[0];
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
      queryEmbedding = await embedText(query, env);
    } catch (e) {
      return err(`Embedding failed: ${e.message}`, 502);
    }

    const { ok, status, body: chunks } = await db.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_count: Math.min(top_k, 20),
      context_filter: context,
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
    version: "1.0.0",
    maintainer: "Taimu Tech Solutions",
    endpoints: {
      foods: [
        "GET  /foods",
        "GET  /foods/:id",
        "POST /foods",
        "PUT  /foods/:id",
        "PATCH /foods/:id",
        "DELETE /foods/:id",
      ],
      exchange_lists: [
        "GET  /exchange",
        "POST /exchange",
        "PUT  /exchange/:id",
        "PATCH /exchange/:id",
        "DELETE /exchange/:id",
      ],
      renal: [
        "GET  /renal",
        "POST /renal",
        "PUT  /renal/:id",
        "PATCH /renal/:id",
        "DELETE /renal/:id",
      ],
      enteral_formulas: [
        "GET  /formulas",
        "POST /formulas",
        "PUT  /formulas/:id",
        "PATCH /formulas/:id",
        "DELETE /formulas/:id",
      ],
      packaged_foods: [
        "GET  /packaged",
        "POST /packaged/submit",
        "PUT  /packaged/:id",
        "PATCH /packaged/:id",
        "DELETE /packaged/:id",
      ],
      rag: [
        "POST /rag/retrieve  → semantic search (query, context, top_k)",
        "POST /rag/ingest    → add document chunk (content, source, context)",
      ],
    },
  });
}

// ── /foods ────────────────────────────────────────────────────────────────────

async function handleFoods(request, url, db, id) {
  const method = request.method;

  // GET /foods or GET /foods/:id
  if (method === "GET") {
    if (id) {
      const { ok, status, body } = await db.selectOne("foods", id);
      if (status === 404) return notFound("Food");
      if (!ok) return err(body?.message || "Query failed", status);
      return success(body);
    }

    const limit = intParam(url, "limit", 50);
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

  // POST /foods
  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload || !payload.food_name) return err("'food_name' is required");
    const { ok, status, body } = await db.insert("foods", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Food created" });
  }

  if (!id) return err("ID required for this method");

  // PUT /foods/:id
  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("foods", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Food replaced" });
  }

  // PATCH /foods/:id
  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("foods", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Food updated" });
  }

  // DELETE /foods/:id
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
    const limit = intParam(url, "limit", 50);
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
    const limit = intParam(url, "limit", 50);
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
    const limit = intParam(url, "limit", 50);
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
    const limit = intParam(url, "limit", 50);
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

  // POST /packaged/submit
  if (method === "POST" && isSubmit) {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    if (!payload.barcode) return err("'barcode' is required");
    if (!payload.product_name) return err("'product_name' is required");

    // Tag the submission with pending status if not already set
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
  // Normalise: strip trailing slash, split segments
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const segments = pathname.split("/").filter(Boolean); // ["foods", "123"]

  const db = supabase(env);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET /
  if (pathname === "/" && request.method === "GET") {
    return handleRoot();
  }

  const [resource, param] = segments; // segments[0] = resource, [1] = id or sub-path

  try {
    switch (resource) {
      // ── /foods ──────────────────────────────────────────────────────────────
      case "foods": {
        const id = param || null;
        return await handleFoods(request, url, db, id);
      }

      // ── /exchange ────────────────────────────────────────────────────────────
      case "exchange": {
        const id = param || null;
        return await handleExchange(request, url, db, id);
      }

      // ── /renal ───────────────────────────────────────────────────────────────
      case "renal": {
        const id = param || null;
        return await handleRenal(request, url, db, id);
      }

      // ── /formulas ────────────────────────────────────────────────────────────
      case "formulas": {
        const id = param || null;
        return await handleFormulas(request, url, db, id);
      }

      // ── /packaged ────────────────────────────────────────────────────────────
      case "packaged": {
        // POST /packaged/submit  → param === "submit"
        const isSubmit = param === "submit";
        const id = isSubmit ? null : param || null;
        return await handlePackaged(request, url, db, id, isSubmit);
      }

      // ── /rag ─────────────────────────────────────────────────────────────────
      case "rag": {
        // POST /rag/retrieve  → semantic search
        // POST /rag/ingest    → add document chunk
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
