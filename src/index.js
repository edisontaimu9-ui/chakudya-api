// ============================================================
//  Chakudya API — Malawi's first open Food & Nutrition Database
//  Cloudflare Worker · Supabase REST via fetch · No npm deps
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ---------- helpers -----------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function success(data, extras = {}) {
  return json({ status: "success", ...extras, data });
}

function listSuccess(data, count, limit, offset) {
  return json({ status: "success", count, limit, offset, data });
}

function err(msg, status = 400) {
  return json({ status: "error", message: msg }, status);
}

function parseIntParam(val, fallback, max = 200) {
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0) return fallback;
  return Math.min(n, max);
}

// ---------- Supabase client ---------------------------------

function supabase(env) {
  const base = env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
  const headers = {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  async function query(table, params = {}, opts = {}) {
    const url = new URL(`${base}/${table}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      method: opts.method || "GET",
      headers: {
        ...headers,
        ...(opts.count ? { Prefer: "count=exact,return=representation" } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res;
  }

  return { query };
}

// ---------- generic CRUD helpers ----------------------------

async function listRows(env, table, params, filters = {}) {
  const limit = parseIntParam(params.limit, 50);
  const offset = parseIntParam(params.offset, 0);

  const qp = { limit, offset };
  for (const [col, val] of Object.entries(filters)) {
    if (val) qp[col] = `ilike.*${val}*`;
  }

  const sb = supabase(env);
  const res = await sb.query(table, qp, { count: true });
  if (!res.ok) return err(await res.text(), 500);

  const contentRange = res.headers.get("content-range") || "";
  const total = contentRange ? parseInt(contentRange.split("/")[1], 10) || 0 : 0;
  const data = await res.json();
  return listSuccess(data, total, limit, offset);
}

async function getRow(env, table, id) {
  const sb = supabase(env);
  const res = await sb.query(table, { id: `eq.${id}` });
  if (!res.ok) return err(await res.text(), 500);
  const data = await res.json();
  if (!data.length) return err("Not found", 404);
  return success(data[0]);
}

async function insertRow(env, table, body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return err("Request body must be a JSON object");
  const sb = supabase(env);
  const res = await sb.query(table, {}, { method: "POST", body });
  if (!res.ok) return err(await res.text(), 500);
  const data = await res.json();
  return success(Array.isArray(data) ? data[0] : data, 201);
}

async function replaceRow(env, table, id, body) {
  if (!body || typeof body !== "object") return err("Request body must be a JSON object");
  const sb = supabase(env);
  const res = await sb.query(table, { id: `eq.${id}` }, { method: "PUT", body });
  if (!res.ok) return err(await res.text(), 500);
  const data = await res.json();
  if (!data || (Array.isArray(data) && !data.length)) return err("Not found", 404);
  return success(Array.isArray(data) ? data[0] : data);
}

async function patchRow(env, table, id, body) {
  if (!body || typeof body !== "object") return err("Request body must be a JSON object");
  const sb = supabase(env);
  const res = await sb.query(table, { id: `eq.${id}` }, { method: "PATCH", body });
  if (!res.ok) return err(await res.text(), 500);
  const data = await res.json();
  if (!data || (Array.isArray(data) && !data.length)) return err("Not found", 404);
  return success(Array.isArray(data) ? data[0] : data);
}

async function deleteRow(env, table, id) {
  const sb = supabase(env);
  const res = await sb.query(table, { id: `eq.${id}` }, { method: "DELETE" });
  if (!res.ok) return err(await res.text(), 500);
  return json({ status: "success", message: "Deleted" });
}

// ---------- route handlers ----------------------------------

// GET /
function handleRoot() {
  return json({
    name: "Chakudya API",
    description: "Malawi's first open Food & Nutrition Database",
    version: "1.0.0",
    endpoints: {
      foods: "/foods",
      exchange: "/exchange",
      renal: "/renal",
      formulas: "/formulas",
      packaged: "/packaged",
    },
    docs: "https://github.com/yourusername/chakudya-api",
  });
}

// /foods
async function handleFoods(req, env, method, id, params, body) {
  const table = "foods";
  if (!id) {
    if (method === "GET") {
      const filters = {};
      if (params.search) filters.name = params.search;
      // category is an exact-ish filter
      const qp = { limit: parseIntParam(params.limit, 50), offset: parseIntParam(params.offset, 0) };
      if (params.search) qp.name = `ilike.*${params.search}*`;
      if (params.category) qp.category = `eq.${params.category}`;
      const sb = supabase(env);
      const res = await sb.query(table, qp, { count: true });
      if (!res.ok) return err(await res.text(), 500);
      const contentRange = res.headers.get("content-range") || "";
      const total = parseInt(contentRange.split("/")[1], 10) || 0;
      const data = await res.json();
      return listSuccess(data, total, qp.limit, qp.offset);
    }
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "GET") return getRow(env, table, id);
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

// /exchange
async function handleExchange(req, env, method, id, params, body) {
  const table = "exchange_lists";
  if (!id) {
    if (method === "GET") {
      const qp = { limit: parseIntParam(params.limit, 50), offset: parseIntParam(params.offset, 0) };
      if (params.type) qp.type = `eq.${params.type}`;
      const sb = supabase(env);
      const res = await sb.query(table, qp, { count: true });
      if (!res.ok) return err(await res.text(), 500);
      const total = parseInt((res.headers.get("content-range") || "").split("/")[1], 10) || 0;
      return listSuccess(await res.json(), total, qp.limit, qp.offset);
    }
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

// /renal
async function handleRenal(req, env, method, id, params, body) {
  const table = "renal_foods";
  if (!id) {
    if (method === "GET") return listRows(env, table, params);
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

// /formulas
async function handleFormulas(req, env, method, id, params, body) {
  const table = "enteral_formulas";
  if (!id) {
    if (method === "GET") {
      const qp = { limit: parseIntParam(params.limit, 50), offset: parseIntParam(params.offset, 0) };
      if (params.route) qp.route = `eq.${params.route}`;
      const sb = supabase(env);
      const res = await sb.query(table, qp, { count: true });
      if (!res.ok) return err(await res.text(), 500);
      const total = parseInt((res.headers.get("content-range") || "").split("/")[1], 10) || 0;
      return listSuccess(await res.json(), total, qp.limit, qp.offset);
    }
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

// /packaged
async function handlePackaged(req, env, method, id, params, body, isSubmit) {
  const table = "packaged_foods";
  if (isSubmit) {
    if (method === "POST") return insertRow(env, table, body);
    return err("Method not allowed", 405);
  }
  if (!id) {
    if (method === "GET") {
      const qp = { limit: parseIntParam(params.limit, 50), offset: parseIntParam(params.offset, 0) };
      if (params.barcode) qp.barcode = `eq.${params.barcode}`;
      const sb = supabase(env);
      const res = await sb.query(table, qp, { count: true });
      if (!res.ok) return err(await res.text(), 500);
      const total = parseInt((res.headers.get("content-range") || "").split("/")[1], 10) || 0;
      return listSuccess(await res.json(), total, qp.limit, qp.offset);
    }
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

// ---------- router ------------------------------------------

async function router(req, env) {
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const params = Object.fromEntries(url.searchParams.entries());

  // Parse body for mutating methods
  let body = null;
  if (["POST", "PUT", "PATCH"].includes(method)) {
    try {
      body = await req.json();
    } catch {
      return err("Invalid or missing JSON body");
    }
  }

  // Match routes
  // GET /
  if (path === "" || path === "/") return handleRoot();

  // /foods
  const foodsMatch = path.match(/^\/foods(?:\/([^/]+))?$/);
  if (foodsMatch) {
    const id = foodsMatch[1] || null;
    return handleFoods(req, env, method, id, params, body);
  }

  // /exchange
  const exchangeMatch = path.match(/^\/exchange(?:\/([^/]+))?$/);
  if (exchangeMatch) {
    const id = exchangeMatch[1] || null;
    return handleExchange(req, env, method, id, params, body);
  }

  // /renal
  const renalMatch = path.match(/^\/renal(?:\/([^/]+))?$/);
  if (renalMatch) {
    const id = renalMatch[1] || null;
    return handleRenal(req, env, method, id, params, body);
  }

  // /formulas
  const formulasMatch = path.match(/^\/formulas(?:\/([^/]+))?$/);
  if (formulasMatch) {
    const id = formulasMatch[1] || null;
    return handleFormulas(req, env, method, id, params, body);
  }

  // /packaged/submit  (must check before generic /packaged/:id)
  if (path === "/packaged/submit") {
    return handlePackaged(req, env, method, null, params, body, true);
  }

  // /packaged  and  /packaged/:id
  const packagedMatch = path.match(/^\/packaged(?:\/([^/]+))?$/);
  if (packagedMatch) {
    const id = packagedMatch[1] || null;
    return handlePackaged(req, env, method, id, params, body, false);
  }

  return err("Route not found", 404);
}

// ---------- entry point -------------------------------------

export default {
  async fetch(req, env, ctx) {
    try {
      return await router(req, env);
    } catch (e) {
      return json({ status: "error", message: "Internal server error", detail: e.message }, 500);
    }
  },
};
