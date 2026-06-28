// ============================================================
//  Chakudya API — Malawi's first open Food & Nutrition Database
//  Cloudflare Worker · Supabase REST via fetch · No npm deps
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function success(data) {
  return json({ status: "success", data });
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
    const reqHeaders = { ...headers };
    if (opts.count) reqHeaders["Prefer"] = "count=exact,return=representation";
    const res = await fetch(url.toString(), {
      method: opts.method || "GET",
      headers: reqHeaders,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res;
  }

  return { query };
}

// ---------- generic CRUD helpers ----------------------------

function getTotal(res) {
  const cr = res.headers.get("content-range") || "";
  const parts = cr.split("/");
  return parseInt(parts[1] || "0", 10) || 0;
}

async function listRows(env, table, limit, offset, extra = {}) {
  const qp = { limit, offset, ...extra };
  const sb = supabase(env);
  const res = await sb.query(table, qp, { count: true });
  if (!res.ok) return err(await res.text(), 500);
  const total = getTotal(res);
  return listSuccess(await res.json(), total, limit, offset);
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
  return json({ status: "success", data: Array.isArray(data) ? data[0] : data }, 201);
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
    docs: "https://github.com/edisontaimu9-ui/chakudya-api",
  });
}

async function handleFoods(env, method, id, params, body) {
  const table = "foods";
  const limit = parseIntParam(params.limit, 50);
  const offset = parseIntParam(params.offset, 0);
  if (!id) {
    if (method === "GET") {
      const extra = {};
      if (params.search) extra.food_name = `ilike.*${params.search}*`;
      if (params.category) extra.category = `eq.${params.category}`;
      return listRows(env, table, limit, offset, extra);
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

async function handleExchange(env, method, id, params, body) {
  const table = "exchange_lists";
  const limit = parseIntParam(params.limit, 50);
  const offset = parseIntParam(params.offset, 0);
  if (!id) {
    if (method === "GET") {
      const extra = {};
      if (params.type) extra.type = `eq.${params.type}`;
      return listRows(env, table, limit, offset, extra);
    }
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

async function handleRenal(env, method, id, params, body) {
  const table = "renal_foods";
  const limit = parseIntParam(params.limit, 50);
  const offset = parseIntParam(params.offset, 0);
  if (!id) {
    if (method === "GET") return listRows(env, table, limit, offset);
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

async function handleFormulas(env, method, id, params, body) {
  const table = "enteral_formulas";
  const limit = parseIntParam(params.limit, 50);
  const offset = parseIntParam(params.offset, 0);
  if (!id) {
    if (method === "GET") {
      const extra = {};
      if (params.route) extra.route = `eq.${params.route}`;
      return listRows(env, table, limit, offset, extra);
    }
    if (method === "POST") return insertRow(env, table, body);
  } else {
    if (method === "PUT") return replaceRow(env, table, id, body);
    if (method === "PATCH") return patchRow(env, table, id, body);
    if (method === "DELETE") return deleteRow(env, table, id);
  }
  return err("Method not allowed", 405);
}

async function handlePackaged(env, method, id, params, body, isSubmit) {
  const table = "packaged_foods";
  const limit = parseIntParam(params.limit, 50);
  const offset = parseIntParam(params.offset, 0);
  if (isSubmit) {
    if (method === "POST") return insertRow(env, table, body);
    return err("Method not allowed", 405);
  }
  if (!id) {
    if (method === "GET") {
      const extra = {};
      if (params.barcode) extra.barcode = `eq.${params.barcode}`;
      return listRows(env, table, limit, offset, extra);
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

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const params = Object.fromEntries(url.searchParams.entries());

  let body = null;
  if (["POST", "PUT", "PATCH"].includes(method)) {
    try {
      body = await req.json();
    } catch {
      return err("Invalid or missing JSON body");
    }
  }

  if (path === "" || path === "/") return handleRoot();

  const foodsMatch = path.match(/^\/foods(?:\/([^/]+))?$/);
  if (foodsMatch) return handleFoods(env, method, foodsMatch[1] || null, params, body);

  const exchangeMatch = path.match(/^\/exchange(?:\/([^/]+))?$/);
  if (exchangeMatch) return handleExchange(env, method, exchangeMatch[1] || null, params, body);

  const renalMatch = path.match(/^\/renal(?:\/([^/]+))?$/);
  if (renalMatch) return handleRenal(env, method, renalMatch[1] || null, params, body);

  const formulasMatch = path.match(/^\/formulas(?:\/([^/]+))?$/);
  if (formulasMatch) return handleFormulas(env, method, formulasMatch[1] || null, params, body);

  if (path === "/packaged/submit") return handlePackaged(env, method, null, params, body, true);

  const packagedMatch = path.match(/^\/packaged(?:\/([^/]+))?$/);
  if (packagedMatch) return handlePackaged(env, method, packagedMatch[1] || null, params, body, false);

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
