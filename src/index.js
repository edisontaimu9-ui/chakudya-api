/**
 * Chakudya Nutrition Registry (CNR) — Malawi's First Open Food & Nutrition Database
 * Cloudflare Worker · Supabase REST backend (no SDK, pure fetch)
 * ---------------------------------------------------------------
 * Author : Edison Taimu 
 * Version: 1.4.0
 *
 * v1.4.0 changes:
 *  - Added edge caching (Cloudflare Cache API) for GET /foods, /exchange,
 *    /renal, /formulas, and /foods/lookup — see cachePolicy(). Reference
 *    data is cached 1hr; external lookups 30min (on top of the existing
 *    external_foods_cache table dedup).
 *  - Added best-effort cache purge (purgeResourceCache) after successful
 *    admin writes to a cached resource, so edits don't wait out the full TTL.
 *  - router()/fetch() now thread `ctx` through so cache writes can use
 *    ctx.waitUntil() without blocking the response.
 *  - No new bindings or secrets required — Cache API is built into Workers.
 *
 * v1.3.0 changes:
 *  - Added session memory (Write → Consolidate → Recall → Apply):
 *    POST /memory/write, GET /memory/recall, POST /memory/consolidate
 *  - Added hourly cron trigger (scheduled()) that auto-consolidates any
 *    session with 6+ unconsolidated facts via a Groq summarization call
 *  - Requires the `assistant_memory` table + `match_memory` /
 *    `sessions_needing_consolidation` RPC functions — see sql/memory_schema.sql
 *
 * v1.2.0 changes:
 *  - Added POST /packaged/scan — photo of a nutrition label -> Groq vision
 *    OCR/AI extraction -> inserted into packaged_foods as status=pending
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
 *  - env.FATSECRET_CONSUMER_KEY    (OAuth 1.0 Consumer Key, from FatSecret dashboard)
 *  - env.FATSECRET_CONSUMER_SECRET (OAuth 1.0 Consumer Secret — do not commit)
 *  - env.USDA_FDC_API_KEY          (optional — USDA FoodData Central lookup, get free at api.data.gov/signup)
 *  - env.GROQ_API_KEY              (required for POST /packaged/scan AND memory consolidation — get free at console.groq.com)
 *  - env.GROQ_VISION_MODEL         (optional override; see note near DEFAULT_GROQ_VISION_MODEL below —
 *                                    Groq's vision model names change/retire more often than the others)
 *  - env.GROQ_TEXT_MODEL           (optional override for memory-consolidation summaries; defaults to llama-3.3-70b-versatile)
 *
 * Session memory setup (NEW in v1.3.0):
 *  1. Run sql/memory_schema.sql in the Supabase SQL editor (creates
 *     `assistant_memory` table + `match_memory` / `sessions_needing_consolidation`
 *     RPC functions; requires the `vector` extension, already enabled for RAG).
 *  2. wrangler.toml now declares an hourly [triggers] cron — redeploy
 *     (`npx wrangler deploy`) for Cloudflare to register it; cron triggers
 *     aren't picked up by a dashboard-only Quick Edit save.
 */

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers": "X-Cache",
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

// ─── EDGE CACHING (Cloudflare Cache API) ────────────────────────────────────

/**
 * Which GET routes get cached at the edge, and for how long.
 * Returns null for anything that must never be cached (writes are never
 * routed here at all — this is only ever consulted for GET requests).
 *
 * Rationale:
 *  - foods/exchange/renal/formulas are curated reference tables that only
 *    change when the maintainer edits them directly — safe to cache hard.
 *  - foods/lookup already dedupes external API calls via external_foods_cache
 *    in Supabase; an edge cache on top saves the Supabase round-trip too for
 *    repeat queries within the TTL window.
 *  - packaged foods change with every community submission/review — not cached.
 *  - rag/memory are session- and query-specific — never cached.
 */
function cachePolicy(resource, param) {
  if (resource === "products" && !param) {
    // Product list changes with every crawl run — short TTL, not the 1hr
    // reference-data TTL below. Single-product GETs (/products/:id) and
    // /nutrition are left uncached since they're low-traffic detail views.
    return { ttl: 900 }; // 15 min
  }
  if (resource === "manufacturers") {
    return { ttl: 86400 }; // changes only when you add a manufacturer
  }
  if (["foods", "exchange", "renal", "formulas"].includes(resource) && param !== "lookup") {
    return { ttl: 3600 }; // 1 hour — static reference data
  }
  if (resource === "foods" && param === "lookup") {
    return { ttl: 1800 }; // 30 min — external lookups, already deduped server-side
  }
  return null; // packaged, rag, memory, root — no edge caching
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
  const isPackagedScan = resource === "packaged" && param === "scan" && method === "POST";
  const isRagRetrieve = resource === "rag" && (param === "retrieve" || !param) && method === "POST";
  const isRagIngest = resource === "rag" && param === "ingest" && method === "POST";
  const isFoodsLookup = resource === "foods" && param === "lookup" && method === "GET";
  const isMemoryWrite = resource === "memory" && param === "write" && method === "POST";
  const isMemoryRecall = resource === "memory" && param === "recall" && method === "GET";
  const isMemoryConsolidate = resource === "memory" && param === "consolidate" && method === "POST";

  // Foods lookup can trigger external API calls (USDA/OFF/FatSecret) — public
  // but capped to protect those quotas, separate from plain local reads.
  if (isFoodsLookup) {
    return { auth: "public", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // Community submissions: public, but tightly rate-limited to deter spam.
  if (isPackagedSubmit) {
    return { auth: "public", rate: { limit: 10, windowSeconds: 60, scope: "ip" } };
  }

  // Photo scan costs a Groq vision call per request — public but capped
  // harder than the manual submit form to control cost/abuse.
  if (isPackagedScan) {
    return { auth: "public", rate: { limit: 5, windowSeconds: 60, scope: "ip" } };
  }

  // RAG retrieve costs a Cohere call per request — public but capped harder than plain reads.
  if (isRagRetrieve) {
    return { auth: "public", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // RAG ingest writes to the knowledge base AND costs a Cohere call — admin only.
  if (isRagIngest) {
    return { auth: "admin", rate: { limit: 300, windowSeconds: 60, scope: "admin" } };
  }

  // Memory write/recall each cost a Cohere embed call — public (the Oasis
  // client calls these directly during a chat, no admin key available
  // there) but capped like RAG retrieve/ingest.
  if (isMemoryWrite) {
    return { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }
  if (isMemoryRecall) {
    return { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // Crawl trigger queues a real scrape job (GitHub Actions) — admin only,
  // capped low so a mistake doesn't queue dozens of runs back to back.
  if (resource === "crawl" && method === "POST") {
    return { auth: "admin", rate: { limit: 10, windowSeconds: 60, scope: "admin" } };
  }

  // Consolidation runs an LLM summarization call and rewrites memory rows —
  // triggered by the hourly cron (which calls it internally, bypassing HTTP
  // auth) or manually by an admin for testing.
  if (isMemoryConsolidate) {
    return { auth: "admin", rate: { limit: 60, windowSeconds: 60, scope: "admin" } };
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
  const apiKey = (env.SUPABASE_KEY || "").trim();
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
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
    const { headers: extraHeaders, ...restOptions } = options;
    const res = await fetch(url, {
      ...restOptions,
      headers: { ...headers, ...extraHeaders },
    });
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

    /**
     * Upsert on a unique constraint — if a row with the same conflict-target
     * columns already exists, it's updated instead of duplicated. Used for
     * external_foods_cache, which has a UNIQUE (source, external_id) constraint.
     */
    async upsert(table, payload, conflictTarget) {
      const url = `${base}/${table}?on_conflict=${encodeURIComponent(conflictTarget)}`;
      const { ok, status, body } = await query(url, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
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

// ─── EXTERNAL FOOD LOOKUP (USDA FDC / Open Food Facts / FatSecret) ────────────
// Cascade: local cache -> USDA (name search) -> Open Food Facts (barcode) ->
// FatSecret (name search). First external hit gets cached into
// external_foods_cache so subsequent lookups never re-call the API.

/**
 * Rule-based category fallback for external sources that don't return one
 * (USDA in particular almost never does). Matches keywords against the food
 * name — no API call, no added latency. Only used when the source's own
 * category is missing; never overrides a real category.
 */
const CATEGORY_KEYWORDS = [
  ["Protein", ["chicken", "beef", "pork", "turkey", "lamb", "goat", "fish", "salmon",
    "tuna", "tilapia", "sardine", "shrimp", "prawn", "egg", "bacon", "sausage",
    "wagyu", "steak", "meat", "poultry", "mince", "liver"]],
  ["Dairy", ["milk", "cheese", "yogurt", "yoghurt", "butter", "cream", "whey"]],
  ["Grains", ["rice", "maize", "wheat", "bread", "pasta", "oat", "cereal", "flour",
    "cornmeal", "nsima", "noodle", "barley"]],
  ["Legumes", ["bean", "soya", "soy", "lentil", "pea", "groundnut", "peanut", "chickpea"]],
  ["Vegetables", ["tomato", "carrot", "spinach", "cabbage", "onion", "pepper", "broccoli",
    "lettuce", "potato", "pumpkin", "okra", "cassava", "kale", "cucumber"]],
  ["Fruits", ["apple", "banana", "orange", "mango", "pineapple", "grape", "papaya",
    "avocado", "watermelon", "lemon", "guava", "berry"]],
  ["Fats & Oils", ["oil", "margarine", "lard", "ghee", "truffle oil"]],
  ["Beverages", ["juice", "soda", "beer", "wine", "gin", "cola", "tea", "coffee"]],
  ["Sweets & Snacks", ["chocolate", "candy", "cake", "cookie", "biscuit", "sugar",
    "marmalade", "jam", "sweet"]],
  ["Nuts & Seeds", ["almond", "cashew", "walnut", "seed", "nut"]],
];

function classifyCategory(foodName) {
  const name = (foodName || "").toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => name.includes(kw))) return category;
  }
  return null;
}

function normalizeFood(source, raw) {
  // Produces the common shape stored in external_foods_cache and returned
  // to the client, regardless of which upstream API it came from.
  return {
    food_name: raw.food_name ?? "",
    category: raw.category ?? classifyCategory(raw.food_name),
    energy_kcal: raw.energy_kcal ?? null,
    protein_g: raw.protein_g ?? null,
    fat_g: raw.fat_g ?? null,
    carbs_g: raw.carbs_g ?? null,
    barcode: raw.barcode ?? null,
    source,
    external_id: raw.external_id ?? null,
    raw_data: raw.raw_data ?? null,
  };
}

/**
 * Rejects USDA's tendency to return loosely-related fuzzy matches (e.g. a
 * search for "Chibuku Shake Shake" returning "BURGER KING, Vanilla Shake"
 * because both contain the word "Shake"). Requires most of the query's
 * meaningful words to actually appear in the candidate's name.
 */
function wordOverlapScore(query, candidateName) {
  const normalize = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

  const queryWords = [...new Set(normalize(query))];
  if (!queryWords.length) return 0;
  const candidateWords = new Set(normalize(candidateName));
  const matched = queryWords.filter((w) => candidateWords.has(w)).length;
  return matched / queryWords.length;
}

async function fetchFromUSDA(query, env) {
  if (!env.USDA_FDC_API_KEY) return null;
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search` +
    `?api_key=${env.USDA_FDC_API_KEY}` +
    `&query=${encodeURIComponent(query)}` +
    `&pageSize=5&dataType=Foundation,SR%20Legacy`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const candidates = data?.foods ?? [];
  if (!candidates.length) return null;

  // USDA sorts by its own relevance score already; take the first candidate
  // that also clears our own word-overlap bar, rather than blindly trusting #1.
  const RELEVANCE_THRESHOLD = 0.6;
  const food = candidates.find(
    (c) => wordOverlapScore(query, c.description) >= RELEVANCE_THRESHOLD
  );
  if (!food) return null;

  // USDA returns TWO entries named "Energy" per food — one in kJ, one in
  // KCAL. A plain name match grabs whichever comes first in the array,
  // which is often the kJ entry, silently mislabeling it as energy_kcal
  // (off by ~4.18x). Filter by unit when one is specified.
  const getNutrient = (name, unit) =>
    food.foodNutrients?.find(
      (n) => n.nutrientName === name && (!unit || n.unitName === unit)
    )?.value ?? null;

  // Keep only what's actually useful (micronutrients + provenance) instead of
  // USDA's full ~100-field-per-nutrient payload — that bloats Supabase rows
  // and nothing downstream reads the rest.
  const trimmedNutrients = (food.foodNutrients ?? [])
    .filter((n) => n.value != null && n.value !== 0)
    .map((n) => ({
      name: n.nutrientName,
      value: n.value,
      unit: n.unitName,
    }));

  return normalizeFood("usda_fdc", {
    food_name: food.description,
    energy_kcal: getNutrient("Energy", "KCAL"),
    protein_g: getNutrient("Protein"),
    fat_g: getNutrient("Total lipid (fat)"),
    carbs_g: getNutrient("Carbohydrate, by difference"),
    external_id: String(food.fdcId),
    raw_data: {
      fdcId: food.fdcId,
      dataType: food.dataType,
      publishedDate: food.publishedDate,
      nutrients: trimmedNutrients,
    },
  });
}

async function fetchFromOpenFoodFacts(barcode, env) {
  if (!barcode) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`;
  const res = await fetch(url, {
    headers: {
      // Required by Open Food Facts terms of use — identify your app.
      "User-Agent": "ChakudyaAPI/1.0 (chakudya-api.edisontaimu9.workers.dev)",
    },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (data?.status !== 1 || !data.product) return null;
  const p = data.product;
  const n = p.nutriments || {};

  return normalizeFood("openfoodfacts", {
    food_name: p.product_name || p.generic_name || "Unknown product",
    category: p.categories?.split(",")[0]?.trim() ?? null,
    energy_kcal: n["energy-kcal_100g"] ?? null,
    protein_g: n["proteins_100g"] ?? null,
    fat_g: n["fat_100g"] ?? null,
    carbs_g: n["carbohydrates_100g"] ?? null,
    barcode,
    external_id: p.code,
    raw_data: {
      code: p.code,
      brands: p.brands ?? null,
      quantity: p.quantity ?? null,
      nutriscore_grade: p.nutriscore_grade ?? null,
      nova_group: p.nova_group ?? null,
      ingredients_text: p.ingredients_text ?? null,
      nutriments: {
        sugars_100g: n["sugars_100g"] ?? null,
        fiber_100g: n["fiber_100g"] ?? null,
        salt_100g: n["salt_100g"] ?? null,
        sodium_100g: n["sodium_100g"] ?? null,
        "saturated-fat_100g": n["saturated-fat_100g"] ?? null,
      },
    },
  });
}

// ─── FATSECRET OAUTH 1.0 SIGNING (HMAC-SHA1) ──────────────────────────────────
// 2-legged OAuth 1.0 against FatSecret's classic REST endpoint. Cloudflare
// Workers can sign natively via Web Crypto (crypto.subtle) — no proxy needed.

function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateNonce(length = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  let nonce = "";
  for (let i = 0; i < length; i++) nonce += chars[randomValues[i] % chars.length];
  return nonce;
}

async function hmacSha1Base64(baseString, signingKey) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Builds a fully OAuth 1.0-signed GET URL for FatSecret's server.api endpoint.
 * `params` are the API-specific params (method, search_expression, format, etc).
 */
async function signFatSecretRequest(params, consumerKey, consumerSecret) {
  const baseUrl = "https://platform.fatsecret.com/rest/server.api";

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...params,
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(String(oauthParams[k]))}`)
    .join("&");

  const baseString = ["GET", percentEncode(baseUrl), percentEncode(paramString)].join("&");

  // 2-legged: no token secret, so the signing key ends in a bare "&"
  const signingKey = `${percentEncode(consumerSecret)}&`;
  oauthParams.oauth_signature = await hmacSha1Base64(baseString, signingKey);

  const finalUrl = new URL(baseUrl);
  for (const [k, v] of Object.entries(oauthParams)) {
    finalUrl.searchParams.set(k, String(v));
  }
  return finalUrl.toString();
}

async function fetchFromFatSecret(query, env) {
  // Uses OAuth 1.0 (2-legged, HMAC-SHA1) — no IP whitelist, no token
  // exchange round-trip. The request is signed and sent in one shot.
  if (!env.FATSECRET_CONSUMER_KEY || !env.FATSECRET_CONSUMER_SECRET) return null;

  const signedUrl = await signFatSecretRequest(
    { method: "foods.search", search_expression: query, format: "json" },
    env.FATSECRET_CONSUMER_KEY,
    env.FATSECRET_CONSUMER_SECRET
  );

  const searchRes = await fetch(signedUrl);
  if (!searchRes.ok) return null;
  const data = await searchRes.json().catch(() => null);
  const rawFoods = data?.foods?.food;
  const candidates = Array.isArray(rawFoods) ? rawFoods : rawFoods ? [rawFoods] : [];
  if (!candidates.length) return null;

  // Same relevance bar as USDA — FatSecret's search is just as loose
  // (e.g. "Carlsberg Green" matching "Green Tomatoes" on the word "Green").
  const RELEVANCE_THRESHOLD = 0.6;
  const food = candidates.find(
    (c) => wordOverlapScore(query, c.food_name) >= RELEVANCE_THRESHOLD
  );
  if (!food) return null;

  // FatSecret's search endpoint returns a text description like
  // "Per 100g - Calories: 52kcal | Fat: 0.17g | Carbs: 13.81g | Protein: 0.26g"
  // for generic foods, but branded items are often something like
  // "Per 1 bar (45g) - Calories: 230kcal | ..." — NOT per 100g. Blindly
  // storing these as if they were per-100g silently corrupts every
  // downstream calculation (portions, exchange lists, PES). We extract the
  // actual gram/ml basis and scale everything to per-100g before caching.
  const desc = food.food_description || "";
  const grab = (label) => {
    const m = desc.match(new RegExp(`${label}:\\s*([\\d.]+)`));
    return m ? parseFloat(m[1]) : null;
  };

  // Try "Per 100g" / "Per 250ml" (no parens) first, then fall back to a
  // parenthetical gram/ml weight, e.g. "Per 1 bar (45g)".
  const extractServingBasis = (text) => {
    let m = text.match(/Per\s+([\d.]+)\s*(g|ml)\b/i);
    if (m) return { amount: parseFloat(m[1]), unit: m[2].toLowerCase() };
    m = text.match(/\(([\d.]+)\s*(g|ml)\)/i);
    if (m) return { amount: parseFloat(m[1]), unit: m[2].toLowerCase() };
    return null;
  };

  const basis = extractServingBasis(desc);
  // No determinable gram/ml basis (e.g. "Per 1 cup" with no weight given) —
  // discard rather than cache a value we can't trust the scale of.
  if (!basis || !basis.amount) return null;

  const scale = 100 / basis.amount;
  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const scaleVal = (n) => (n == null ? null : round2(n * scale));

  return normalizeFood("fatsecret", {
    food_name: food.food_name,
    energy_kcal: scaleVal(grab("Calories")),
    fat_g: scaleVal(grab("Fat")),
    carbs_g: scaleVal(grab("Carbs")),
    protein_g: scaleVal(grab("Protein")),
    external_id: food.food_id,
    raw_data: {
      food_id: food.food_id,
      food_type: food.food_type ?? null,
      food_description: food.food_description ?? null,
      food_url: food.food_url ?? null,
      serving_basis: `${basis.amount}${basis.unit}`,
      scaled_to_100: basis.amount !== 100,
    },
  });
}

// ─── GROQ VISION OCR (packaged food label extraction) ────────────────────────
// Client sends a photo of a nutrition facts panel (base64 data URL). We hand
// it to a Groq multimodal model with a strict JSON schema prompt, then
// normalize + sanity-check the result before it ever touches the DB.
//
// NOTE: Groq's vision-capable model lineup changes often (models get
// deprecated with only weeks of notice — meta-llama/llama-4-maverick and
// meta-llama/llama-4-scout were BOTH retired by Groq in 2026). Set
// GROQ_VISION_MODEL as a secret to override the default without a code
// deploy; check https://console.groq.com/docs/vision and
// https://console.groq.com/docs/deprecations for the current list if
// extraction starts failing with a "model decommissioned"/"model not found"
// error. qwen/qwen3.6-27b (current default below) is a PREVIEW model on
// Groq's side — fine for testing, but re-check before leaning on it hard for
// production, since preview models can be pulled without much notice.

const DEFAULT_GROQ_VISION_MODEL = "qwen/qwen3.6-27b";

// Keep this well under Groq's 20MB request cap and under Cloudflare Workers'
// memory/CPU budget — a phone camera photo re-encoded as base64 JPEG at
// reasonable quality is normally a few hundred KB to ~2MB.
const MAX_IMAGE_BASE64_BYTES = 6 * 1024 * 1024; // ~6MB decoded, per image
const MAX_IMAGES_PER_SCAN = 5; // Groq's own per-request cap on image inputs
const MAX_TOTAL_IMAGE_BASE64_BYTES = 15 * 1024 * 1024; // combined decoded cap across all images in one request

/** Accepts either a bare base64 string or a full "data:image/jpeg;base64,...." URL. */
function normalizeImageInput(image) {
  if (typeof image !== "string" || !image.trim()) return null;
  const dataUrlMatch = image.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/s);
  if (dataUrlMatch) {
    return { mimeType: dataUrlMatch[1], base64: dataUrlMatch[2].trim() };
  }
  // Bare base64 with no prefix — assume JPEG (the common case from a camera capture).
  return { mimeType: "image/jpeg", base64: image.trim() };
}

/**
 * Accepts a request body's image field(s) in either shape:
 *   { images: ["data:...", "data:...", ...] }  — preferred, up to MAX_IMAGES_PER_SCAN
 *   { image: "data:..." }                       — legacy single-image shape, still supported
 * Returns an array of normalized {mimeType, base64} objects (possibly empty).
 */
function normalizeImageInputs(payload) {
  const raw = Array.isArray(payload?.images) && payload.images.length
    ? payload.images
    : payload?.image
    ? [payload.image]
    : [];
  return raw.map(normalizeImageInput).filter(Boolean).slice(0, MAX_IMAGES_PER_SCAN);
}

function estimateBase64Bytes(base64) {
  // Rough decoded-size estimate without actually decoding: 3 bytes per 4 chars.
  const padding = (base64.match(/=+$/) || [""])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Pulls the first {...} JSON object out of a model reply, tolerating stray prose, code fences, or a leaked <think> reasoning block. */
function extractJsonObject(text) {
  if (!text) return null;
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : withoutThinking;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Default nutrient key set for values coming out of the AI extraction schema
// (NUTRITION_LABEL_SCHEMA_PROMPT uses "sugars_g"). Manual /packaged/submit
// payloads target the packaged_foods DB column names directly, which use
// "sugar_g" (singular) — see PACKAGED_FOOD_DB_NUTRIENT_FIELDS below.
const PACKAGED_FOOD_NUTRIENT_FIELDS = [
  "energy_kcal", "protein_g", "fat_g", "saturated_fat_g",
  "carbs_g", "sugars_g", "fiber_g", "sodium_mg", "salt_g",
];
const PACKAGED_FOOD_DB_NUTRIENT_FIELDS = [
  "energy_kcal", "protein_g", "fat_g", "saturated_fat_g",
  "carbs_g", "sugar_g", "fiber_g", "sodium_mg", "salt_g",
];

/**
 * If the values were read/entered "per serving" rather than "per 100g/100ml",
 * scale them so packaged_foods stays consistent with the rest of the database
 * (mirrors the same per-100 normalization already used for FatSecret above).
 * Used by both /packaged/scan (AI-extracted fields) and /packaged/submit
 * (manual entry) — pass the matching nutrientKeys list for each field-naming
 * convention. No-op if `per` isn't "serving" or no parseable serving size is
 * given, so values already declared per-100g/ml pass through untouched.
 */
function scaleNutrientsToPer100(fields, per, servingSizeText, nutrientKeys = PACKAGED_FOOD_NUTRIENT_FIELDS) {
  if (per !== "serving" || !servingSizeText) return fields;
  const m = String(servingSizeText).match(/([\d.]+)\s*(g|ml)\b/i);
  if (!m) return fields;
  const amount = parseFloat(m[1]);
  if (!amount) return fields;
  const scale = 100 / amount;
  const round2 = (n) => (typeof n === "number" ? Math.round(n * scale * 100) / 100 : n);
  const out = { ...fields };
  for (const key of nutrientKeys) {
    if (out[key] != null) out[key] = round2(out[key]);
  }
  return out;
}

/**
 * Cross-checks protein/carbs/fat against the declared energy value using the
 * standard Atwater factors (protein 4 kcal/g, carbs 4 kcal/g, fat 9 kcal/g).
 * Packaged-food labels routinely round each figure independently, and things
 * like fiber or sugar alcohols legitimately shift the true energy count, so
 * this FLAGS a mismatch for the admin review queue rather than rejecting the
 * submission outright.
 */
function checkMacrosMatchCalories({ energy_kcal, protein_g, fat_g, carbs_g }) {
  const num = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return null;
  };
  const kcal = num(energy_kcal), p = num(protein_g), f = num(fat_g), c = num(carbs_g);
  if ([kcal, p, f, c].some((n) => n == null || Number.isNaN(n))) {
    return { checked: false };
  }
  const calculated_kcal = Math.round((p * 4 + c * 4 + f * 9) * 100) / 100;
  const difference = Math.round(Math.abs(calculated_kcal - kcal) * 100) / 100;
  // Tolerance: greater of 20 kcal flat or 15% relative — absorbs normal label
  // rounding without being noisy on legitimate submissions.
  const tolerance = Math.round(Math.max(20, kcal * 0.15) * 100) / 100;
  return {
    checked: true,
    calculated_kcal,
    declared_kcal: kcal,
    difference,
    tolerance,
    matches: difference <= tolerance,
  };
}

const NUTRITION_LABEL_SCHEMA_PROMPT = `You are reading one or more photographs of the SAME packaged food product (e.g. a label typically seen in Malawi/Southern Africa on products such as maize flour, cooking oil, juice, biscuits, etc). The photos may show different faces of the same package — for example the nutrition facts panel in one photo and the barcode or front branding in another. Combine information across ALL the photos provided into a single answer about this one product.

Return ONLY a single JSON object (no prose, no markdown fences) with exactly these keys:
{
  "label_detected": boolean,      // true only if a nutrition facts panel is legible in at least one of the photos
  "product_name": string|null,
  "brand": string|null,
  "barcode": string|null,         // digits only, if a barcode/EAN number is visible in ANY of the photos
  "serving_size": string|null,    // as printed, e.g. "30g" or "250ml"
  "per": "100g"|"100ml"|"serving"|null,  // what basis the numbers below are printed as
  "energy_kcal": number|null,
  "protein_g": number|null,
  "fat_g": number|null,
  "saturated_fat_g": number|null,
  "carbs_g": number|null,
  "sugars_g": number|null,
  "fiber_g": number|null,
  "sodium_mg": number|null,
  "salt_g": number|null,
  "ingredients_text": string|null,
  "allergens": string|null,
  "confidence": number            // your own confidence 0.0-1.0 that the extracted values are accurate
}

Rules:
- If energy is printed in kJ only, convert to kcal (divide by 4.184) and note that in nothing else — just return the kcal number.
- If a field is not visible or not printed in ANY photo, use null. Do not guess or invent numbers.
- If none of the photos show a legible nutrition label, set "label_detected": false and set numeric fields to null (a barcode-only or front-of-pack-only photo does not count as a legible label).
- Output valid JSON only.`;

async function extractNutritionLabel(imageInputs, env) {
  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured");
  }
  if (!imageInputs.length) {
    throw new Error("No images provided");
  }

  const model = env.GROQ_VISION_MODEL || DEFAULT_GROQ_VISION_MODEL;
  const imageContent = imageInputs.map((img) => ({
    type: "image_url",
    image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
  }));

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 2048,
      // qwen3.6-27b defaults to a "thinking" mode that burns tokens on internal
      // reasoning before writing the actual answer, which was truncating our
      // JSON output before it could close. "none" disables thinking mode for
      // Qwen models on Groq so the reply goes straight to the JSON.
      reasoning_effort: "none",
      // NOTE: response_format: {type:"json_object"} is intentionally omitted.
      // Some Groq preview vision models (e.g. qwen3.6-27b) reject/fail strict
      // JSON-mode validation server-side ("Failed to validate JSON..."). The
      // prompt below already demands JSON-only output, and extractJsonObject()
      // tolerantly pulls the {...} block out of the reply regardless of
      // whether the model wraps it in prose or code fences.
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: NUTRITION_LABEL_SCHEMA_PROMPT }, ...imageContent],
        },
      ],
    }),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Groq vision request failed: ${e.error?.message || res.status}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const parsed = extractJsonObject(raw);
  if (!parsed) throw new Error("Could not parse a JSON label from the AI response");
  return parsed;
}

// Local `foods`/`packaged_foods` rows don't share the external cascade's
// column names (e.g. local uses `kcal` + `measure` + `weight_g`, external
// uses `energy_kcal` + `barcode` + `source` + `external_id`). Rather than
// altering the DB schema — which risks breaking RAG ingestion or any other
// consumer of the existing columns — we normalize the API *response* only.
// Every original field is preserved untouched; only fields that would
// otherwise be missing get filled in, so nothing that already reads `kcal`
// or `measure` breaks, but a client can now also always rely on
// `energy_kcal`, `barcode`, `source`, and `external_id` being present
// regardless of which layer of the cascade answered.
function withExternalShape(row, source) {
  return {
    ...row,
    energy_kcal: row.energy_kcal ?? row.kcal ?? null,
    barcode: row.barcode ?? null,
    source: row.source ?? source,
    external_id: row.external_id ?? null,
  };
}

async function lookupFoodCascade(db, { query, barcode }, env) {
  // 1. Local curated data
  if (query) {
    const local = await db.select("foods", {
      filters: { food_name: `ilike.*${query}*` },
      limit: 1,
    });
    if (local.ok && local.body?.[0]) {
      return { food: withExternalShape(local.body[0], "local"), source: "local", cached: false };
    }
  }
  if (barcode) {
    const localPackaged = await db.select("packaged_foods", {
      filters: { barcode: `eq.${barcode}`, status: "eq.approved" },
      limit: 1,
    });
    if (localPackaged.ok && localPackaged.body?.[0]) {
      return {
        food: withExternalShape(localPackaged.body[0], "local_packaged"),
        source: "local_packaged",
        cached: false,
      };
    }
  }

  // 2. Previously-cached external results
  const cacheFilters = {};
  if (barcode) cacheFilters.barcode = `eq.${barcode}`;
  else if (query) cacheFilters.food_name = `ilike.*${query}*`;
  const cached = await db.select("external_foods_cache", { filters: cacheFilters, limit: 1 });
  if (cached.ok && cached.body?.[0]) {
    return { food: cached.body[0], source: cached.body[0].source, cached: true };
  }

  // 3. External APIs, in order. Barcode lookups go to Open Food Facts first
  // since that's what it's built for; name searches go USDA -> FatSecret.
  let result = null;
  if (barcode) result = await fetchFromOpenFoodFacts(barcode, env);
  if (!result && query) result = await fetchFromUSDA(query, env);
  if (!result && query) result = await fetchFromFatSecret(query, env);

  if (!result) return null;

  // 4. Cache it so next time this is a step-2 hit, not a fresh API call.
  // Upsert on (source, external_id) — if this exact external food was already
  // cached via a different query text, this updates that row instead of
  // creating a duplicate.
  const { ok, status, body } = await db.upsert("external_foods_cache", result, "source,external_id");
  if (!ok) {
    console.error("external_foods_cache upsert failed", { status, body, result });
  }
  return {
    food: ok ? body : result,
    source: result.source,
    cached: false,
    freshly_cached: ok,
  };
}



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

    const VALID_CONTEXTS = ["clinical", "general", "both"];
    if (!VALID_CONTEXTS.includes(context)) {
      return err(
        `'context' must be one of: ${VALID_CONTEXTS.join(", ")} (got "${context}")`
      );
    }

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

    const VALID_CONTEXTS = ["clinical", "general", "both"];
    if (!VALID_CONTEXTS.includes(context)) {
      return err(
        `'context' must be one of: ${VALID_CONTEXTS.join(", ")} (got "${context}")`
      );
    }

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
      query_text: query,
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

// ─── SESSION MEMORY (Write → Consolidate → Recall → Apply) ───────────────────
// Per-session clinical scratchpad for Oasis AI, scoped by the app's existing
// SESSION_ID (fresh per page load — this is deliberately session-scoped, not
// a long-term cross-visit profile). Mirrors the RAG layer's Cohere embedding
// + pgvector pattern, using its own `assistant_memory` table so consolidation
// (which prunes/rewrites rows) never touches the RAG knowledge base.
//
//   Write       POST /memory/write      — capture a raw fact for a session
//   Consolidate POST /memory/consolidate — summarize a session's accumulated
//                                          facts into one row (admin/cron)
//   Recall      GET  /memory/recall      — top-K relevant memory for a query
//   Apply       (client-side) — Oasis AI injects recalled memory into the
//                                 system prompt before its Groq call
//
// Requires the `assistant_memory` table + `match_memory` / // ── /memory ───
// `sessions_needing_consolidation` RPC functions — see sql/memory_schema.sql.

const MEMORY_MIN_FACTS_TO_CONSOLIDATE = 6; // don't bother summarizing a session with only a couple of facts

/**
 * Summarizes a session's unconsolidated "fact" rows into one "summary" row
 * via a single Groq text completion, then marks the source facts
 * consolidated=true. Shared between the admin-triggered POST
 * /memory/consolidate route and the hourly cron handler. Returns
 * { consolidated: boolean, reason?: string, summaryId? }.
 */
async function consolidateSession(sessionId, db, env) {
  const { ok, status, body: facts } = await db.select("assistant_memory", {
    filters: { session_id: `eq.${sessionId}`, kind: "eq.fact", consolidated: "eq.false" },
    limit: 100,
    order: "created_at.asc",
  });
  if (!ok) return { consolidated: false, reason: `Query failed (${status})` };
  if (!Array.isArray(facts) || facts.length < MEMORY_MIN_FACTS_TO_CONSOLIDATE) {
    return { consolidated: false, reason: "Not enough unconsolidated facts yet" };
  }

  if (!env.GROQ_API_KEY) {
    return { consolidated: false, reason: "GROQ_API_KEY not configured" };
  }

  const factLines = facts.map((f) => `- ${f.content}`).join("\n");
  const prompt = `You are compressing a clinical dietitian's session notes into a single concise memory summary. Below are raw notes captured during one patient session, in chronological order.

${factLines}

Write ONE paragraph (max ~120 words) capturing the key patient facts, clinical context, goals, and any plan/decisions made so far. Preserve specific clinical values (weights, lab results, diagnoses, targets) exactly as given — do not round or approximate them. Do not add information that wasn't in the notes. Output only the summary paragraph, no preamble.`;

  let summaryText;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile",
        temperature: 0.2,
        max_completion_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { consolidated: false, reason: `Groq summarization failed: ${e.error?.message || res.status}` };
    }
    const data = await res.json();
    summaryText = data?.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    return { consolidated: false, reason: `Groq summarization failed: ${e.message}` };
  }
  if (!summaryText) return { consolidated: false, reason: "Empty summary from Groq" };

  let embedding;
  try {
    embedding = await embedText(summaryText, env, "search_document");
  } catch (e) {
    return { consolidated: false, reason: `Embedding failed: ${e.message}` };
  }

  const patientLabel = facts.find((f) => f.patient_label)?.patient_label || null;
  const { ok: insOk, status: insStatus, body: summaryRow } = await db.insert("assistant_memory", {
    session_id: sessionId,
    patient_label: patientLabel,
    content: summaryText,
    kind: "summary",
    embedding: JSON.stringify(embedding),
    consolidated: true,
  });
  if (!insOk) return { consolidated: false, reason: `Insert failed (${insStatus})` };

  // Mark the source facts consolidated so they drop out of future
  // consolidation batches (still queryable/recallable individually — only
  // the "needs consolidating" cron scan excludes them now).
  await Promise.all(
    facts.map((f) => db.update("assistant_memory", f.id, { consolidated: true }, "PATCH"))
  );

  return { consolidated: true, summaryId: summaryRow?.[0]?.id ?? summaryRow?.id ?? null };
}

async function handleMemory(request, url, db, env, param) {
  // ── POST /memory/write ───────────────────────────────────────────────────
  if (param === "write" && request.method === "POST") {
    const body = await parseBody(request);
    if (!body) return err("Request body required");
    const { session_id, content, kind = "fact", patient_label } = body;
    if (!session_id) return err("'session_id' is required");
    if (!content || !String(content).trim()) return err("'content' is required");
    if (!["fact", "summary"].includes(kind)) return err("'kind' must be 'fact' or 'summary'");

    let embedding;
    try {
      embedding = await embedText(String(content).trim(), env, "search_document");
    } catch (e) {
      return err(`Embedding failed: ${e.message}`, 502);
    }

    const { ok, status, body: row } = await db.insert("assistant_memory", {
      session_id,
      patient_label: patient_label || null,
      content: String(content).trim(),
      kind,
      embedding: JSON.stringify(embedding),
      consolidated: false,
    });
    if (!ok) return err(row?.message || "Write failed", status);
    return success(row, { message: "Memory written" });
  }

  // ── GET /memory/recall?session_id=...&query=...&top_k=5 ────────────────
  if (param === "recall" && request.method === "GET") {
    const sessionId = url.searchParams.get("session_id") || "";
    const query = url.searchParams.get("query") || "";
    const topK = intParam(url, "top_k", 5);
    if (!sessionId) return err("'session_id' is required");
    if (!query) return err("'query' is required");

    let queryEmbedding;
    try {
      queryEmbedding = await embedText(query, env, "search_query");
    } catch (e) {
      return err(`Embedding failed: ${e.message}`, 502);
    }

    const { ok, status, body: rows } = await db.rpc("match_memory", {
      query_embedding: queryEmbedding,
      match_session_id: sessionId,
      match_count: Math.min(topK, 20),
    });
    if (!ok) return err(rows?.message || "Recall failed", status);
    return success(rows, { session_id: sessionId, query, count: Array.isArray(rows) ? rows.length : 0 });
  }

  // ── POST /memory/consolidate ────────────────────────────────────────────
  // Admin-only over HTTP (manual testing); the hourly cron calls
  // consolidateSession() directly, bypassing this route entirely.
  if (param === "consolidate" && request.method === "POST") {
    const body = await parseBody(request);
    const sessionId = body?.session_id;
    if (!sessionId) return err("'session_id' is required");
    const result = await consolidateSession(sessionId, db, env);
    if (!result.consolidated) return json({ status: "skipped", reason: result.reason }, 200);
    return success({ session_id: sessionId, summary_id: result.summaryId }, { message: "Session consolidated" });
  }

  return notFound("Memory route");
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

// GET /
function handleRoot() {
  return success({
    name: "Chakudya Nutrition Registry (CNR)",
    tagline: "Malawi's first open Food & Nutrition Database",
    version: "1.2.0",
    maintainer: "Taimu Tech Solutions",
    auth: "Write operations (POST/PUT/PATCH/DELETE) require 'Authorization: Bearer <admin key>', except POST /packaged/submit, POST /packaged/scan, POST /rag/retrieve, POST /memory/write, and GET /memory/recall, which are public but rate-limited.",
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
        "POST /packaged/scan    (public, rate-limited — photo of nutrition label -> OCR/AI -> status=pending)",
        "PUT  /packaged/:id     (admin)",
        "PATCH /packaged/:id    (admin)",
        "DELETE /packaged/:id   (admin)",
      ],
      rag: [
        "POST /rag/retrieve     (public, rate-limited) → semantic search (query, context, top_k)",
        "POST /rag/ingest       (admin) → add document chunk (content, source, context)",
      ],
      memory: [
        "POST /memory/write        (public, rate-limited) → capture a session fact (session_id, content)",
        "GET  /memory/recall       (public, rate-limited) → top-K relevant memory for a session (session_id, query, top_k)",
        "POST /memory/consolidate  (admin) → summarize a session's facts (session_id) — also run hourly by cron",
      ],
      manufacturers: [
        "GET  /manufacturers",
        "POST /manufacturers        (admin)",
        "PATCH /manufacturers/:id   (admin)",
        "DELETE /manufacturers/:id  (admin)",
      ],
      products: [
        "GET  /products             — filters: category, route, manufacturer_id, search, include_inactive",
        "GET  /products/:id",
        "POST /products             (admin)",
        "PUT  /products/:id         (admin)",
        "PATCH /products/:id        (admin)",
        "DELETE /products/:id       (admin — soft delete, sets is_active=false)",
      ],
      nutrition: ["GET /nutrition?product_id=123"],
      crawler: [
        "POST /crawl                (admin, rate-limited) → queue a crawl for all enabled manufacturers",
        "POST /crawl/:manufacturer_slug  (admin, rate-limited) → queue a crawl for one manufacturer",
        "GET  /status               → recent crawl_logs rows",
      ],
    },
  });
}

// ── /foods ────────────────────────────────────────────────────────────────────

// GET /foods/lookup?q=banana
// GET /foods/lookup?barcode=6007048001598
// Checks local data first, then previously-cached external results, then
// falls through to USDA FDC / Open Food Facts / FatSecret and caches
// whatever it finds so the next lookup for the same food is a local hit.
async function handleFoodsLookup(request, url, db, env) {
  if (request.method !== "GET") return err("Only GET is supported for lookup", 405);

  const query = url.searchParams.get("q") || "";
  const barcode = url.searchParams.get("barcode") || "";
  if (!query && !barcode) return err("Provide 'q' (food name) or 'barcode'");

  const result = await lookupFoodCascade(db, { query, barcode }, env);
  if (!result) {
    return json(
      { status: "not_found", message: "No match in local data or any external source" },
      404
    );
  }
  return success(result.food, {
    source: result.source,
    cached: result.cached,
    freshly_cached: !!result.freshly_cached,
  });
}

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

// ── /manufacturers ───────────────────────────────────────────────────────────

async function handleManufacturers(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const { ok, status, body, total } = await db.select("manufacturers", {
      filters: {},
      limit,
      offset,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.insert("manufacturers", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Manufacturer created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("manufacturers", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Manufacturer updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("manufacturers", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Manufacturer ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ── /products ─────────────────────────────────────────────────────────────────
//
// Serves the crawler's normalized catalog (see crawler_schema.sql). The
// crawler itself (Python/Playwright, running in GitHub Actions) writes to
// Supabase directly with the service key — it does NOT go through this
// Worker. This handler is for the read side (site/app queries) plus manual
// admin edits/corrections to crawled data.

async function handleProducts(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const category = url.searchParams.get("category") || "";
    const route = url.searchParams.get("route") || "";
    const manufacturerId = url.searchParams.get("manufacturer_id") || "";
    const search = url.searchParams.get("search") || "";
    const activeOnly = url.searchParams.get("include_inactive") !== "true";

    const filters = {};
    if (category) filters["category"] = `eq.${category}`;
    if (route) filters["route"] = `eq.${route}`;
    if (manufacturerId) filters["manufacturer_id"] = `eq.${manufacturerId}`;
    if (search) filters["product_name"] = `ilike.*${search}*`;
    if (activeOnly) filters["is_active"] = `eq.true`;

    if (id) {
      const { ok, status, body } = await db.select("products", {
        filters: { id: `eq.${id}` },
        limit: 1,
      });
      if (!ok) return err(body?.message || "Query failed", status);
      if (!body || !body.length) return notFound("Product");
      return success(body[0]);
    }

    const { ok, status, body, total } = await db.select("products", {
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
    const { ok, status, body } = await db.insert("products", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Product created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("products", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Product replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("products", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Product updated" });
  }

  if (method === "DELETE") {
    // Soft delete by default — crawled catalogs should almost never hard-delete;
    // a product missing from a manufacturer's site today may reappear.
    const { ok, status, body } = await db.update(
      "products",
      id,
      { is_active: false },
      "PATCH"
    );
    if (!ok) return err(body?.message || "Deactivate failed", status);
    return success(body, { message: `Product ${id} deactivated` });
  }

  return err("Method not allowed", 405);
}

// ── /nutrition ────────────────────────────────────────────────────────────────
// GET /nutrition?product_id=123

async function handleNutrition(request, url, db) {
  if (request.method !== "GET") return err("Only GET is supported", 405);

  const productId = url.searchParams.get("product_id");
  if (!productId) return err("product_id query param required");

  const { ok, status, body } = await db.select("product_nutrition", {
    filters: { product_id: `eq.${productId}` },
    limit: 200,
  });
  if (!ok) return err(body?.message || "Query failed", status);
  return success(body);
}

// ── /crawl ────────────────────────────────────────────────────────────────────
//
// The Worker does NOT run the crawl (Playwright needs a real browser process,
// which Cloudflare Workers can't host). POST /crawl and POST /crawl/:manufacturer
// just record a request row in crawl_logs — a GitHub Actions workflow polls
// for status:"requested" rows (or is triggered directly via repository_dispatch)
// and does the actual scraping, writing products/nutrition/etc. straight to
// Supabase with the service key. GET /status reads back recent crawl_logs rows.

async function handleCrawlTrigger(request, url, db, manufacturerSlug) {
  if (request.method !== "POST") return err("Only POST is supported", 405);

  let manufacturerId = null;
  if (manufacturerSlug) {
    const { ok, body } = await db.select("manufacturers", {
      filters: { slug: `eq.${manufacturerSlug}` },
      limit: 1,
    });
    if (!ok || !body || !body.length) return notFound("Manufacturer");
    manufacturerId = body[0].id;
  }

  const { ok, status, body } = await db.insert("crawl_logs", {
    manufacturer_id: manufacturerId,
    status: "requested",
  });
  if (!ok) return err(body?.message || "Failed to queue crawl", status);
  return success(body, {
    message: manufacturerSlug
      ? `Crawl queued for ${manufacturerSlug}`
      : "Crawl queued for all enabled manufacturers",
  });
}

async function handleCrawlStatus(request, url, db) {
  if (request.method !== "GET") return err("Only GET is supported", 405);

  const limit = limitParam(url);
  const manufacturerId = url.searchParams.get("manufacturer_id") || "";
  const filters = {};
  if (manufacturerId) filters["manufacturer_id"] = `eq.${manufacturerId}`;

  const { ok, status, body, total } = await db.select("crawl_logs", {
    filters,
    limit,
    offset: 0,
    order: "started_at.desc",
  });
  if (!ok) return err(body?.message || "Query failed", status);
  return listSuccess(body, { count: total, limit, offset: 0 });
}

// ── /packaged/scan ────────────────────────────────────────────────────────────
// POST /packaged/scan — public community contribution via photo(s) instead of
// a manual form. Body: { "images": ["data:image/jpeg;base64,....", ...] }
// (up to 5 photos — e.g. one of the nutrition panel, one of the barcode, one
// of the front of pack; they don't need to be the same face of the package).
// The legacy single-image shape { "image": "data:..." } is still accepted.
//
// Flow: decode -> single Groq vision call with ALL photos attached -> AI
// combines info across them -> sanity-check -> insert into packaged_foods as
// status "pending" (same review queue as the manual /packaged/submit form)
// -> return the extracted fields back to the client.
//
// Requires these columns on packaged_foods (nullable) in addition to the
// existing manual-submit columns — add via Supabase SQL editor if missing:
//   alter table packaged_foods add column if not exists source text;
//   alter table packaged_foods add column if not exists ai_confidence numeric;
//   alter table packaged_foods add column if not exists ocr_raw jsonb;
async function handlePackagedScan(request, env, db) {
  if (request.method !== "POST") return err("Method not allowed", 405);

  const payload = await parseBody(request);
  if (!payload) return err("Request body required");

  const imageInputs = normalizeImageInputs(payload);
  if (!imageInputs.length) {
    return err("'images' is required — an array of 1-5 base64 strings or data: URLs (or a single 'image')");
  }

  let totalBytes = 0;
  for (const img of imageInputs) {
    const bytes = estimateBase64Bytes(img.base64);
    if (bytes > MAX_IMAGE_BASE64_BYTES) {
      return err(
        `One of the photos is too large (~${Math.round(bytes / 1024 / 1024)}MB). Please compress each photo to under ${
          MAX_IMAGE_BASE64_BYTES / 1024 / 1024
        }MB and try again.`,
        413
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BASE64_BYTES) {
    return err(
      `These photos are too large combined (~${Math.round(totalBytes / 1024 / 1024)}MB). Please use fewer photos or compress them further.`,
      413
    );
  }

  let extracted;
  try {
    extracted = await extractNutritionLabel(imageInputs, env);
  } catch (e) {
    return err(`Label scan failed: ${e.message}`, 502);
  }

  // AI couldn't find a legible label at all — don't pollute the review queue
  // with an empty row. Give the user actionable feedback instead.
  if (!extracted.label_detected) {
    return json(
      {
        status: "needs_retry",
        message:
          "Couldn't read a nutrition label in that photo. Try again with better lighting, " +
          "the panel flat and in focus, or fill in the details manually.",
        extracted,
      },
      422
    );
  }

  const scaled = scaleNutrientsToPer100(extracted, extracted.per, extracted.serving_size);

  const productName = extracted.product_name?.trim();
  if (!productName && scaled.energy_kcal == null) {
    return json(
      {
        status: "needs_retry",
        message:
          "The label was too unclear to read reliably (no product name or energy value found). " +
          "Try a clearer photo or fill in the details manually.",
        extracted,
      },
      422
    );
  }

  const data = {
    status: "pending",
    submitted_at: new Date().toISOString(),
    source: "ocr_ai",
    ai_confidence: typeof extracted.confidence === "number" ? extracted.confidence : null,
    barcode: payload.barcode || extracted.barcode || null,
    product_name: productName || "Unknown product (from photo)",
    brand: extracted.brand ?? null,
    serving_size: extracted.serving_size ?? null,
    energy_kcal: scaled.energy_kcal ?? null,
    protein_g: scaled.protein_g ?? null,
    fat_g: scaled.fat_g ?? null,
    saturated_fat_g: scaled.saturated_fat_g ?? null,
    carbs_g: scaled.carbs_g ?? null,
    sugar_g: scaled.sugars_g ?? null,
    fiber_g: scaled.fiber_g ?? null,
    sodium_mg: scaled.sodium_mg ?? null,
    salt_g: scaled.salt_g ?? null,
    ingredients_text: extracted.ingredients_text ?? null,
    allergens: extracted.allergens ?? null,
    ocr_raw: extracted,
  };

  const macroCheck = checkMacrosMatchCalories(data);

  const { ok, status, body } = await db.insert("packaged_foods", data);
  if (!ok) return err(body?.message || "Submit failed", status);

  const lowConfidence = data.ai_confidence != null && data.ai_confidence < 0.6;
  const macroMismatch = macroCheck.checked && !macroCheck.matches;
  const needsReview = lowConfidence || macroMismatch;

  let message;
  if (lowConfidence && macroMismatch) {
    message =
      "Submitted for review, but the scan confidence was low and the calories don't closely " +
      "match protein/carbs/fat — please double-check the details.";
  } else if (macroMismatch) {
    message =
      `Submitted for review — declared calories (${macroCheck.declared_kcal} kcal) don't closely ` +
      `match protein/carbs/fat (~${macroCheck.calculated_kcal} kcal calculated). Please double-check the label.`;
  } else if (lowConfidence) {
    message = "Submitted for review, but the scan confidence was low — please double-check the details.";
  } else {
    message = "Submitted for review. Thanks for contributing to Chakudya!";
  }

  return success(body, {
    message,
    needs_review: needsReview,
    macro_check: macroCheck.checked ? macroCheck : undefined,
  });
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

    // `per` ("100g" | "100ml" | "serving") is an optional hint, not a
    // packaged_foods column — pull it (and serving_size, handled separately
    // below) out before building the insert payload so it never hits the DB.
    const { per, serving_size, ...rest } = payload;

    // Same per-100g/ml normalization /packaged/scan applies to AI-read
    // labels, so packaged_foods stays consistent no matter which submission
    // path a row came from. No-op if the submitter already entered per-100
    // values (the common case) or omitted `per`/`serving_size`.
    const normalized = scaleNutrientsToPer100(rest, per, serving_size, PACKAGED_FOOD_DB_NUTRIENT_FIELDS);
    const macroCheck = checkMacrosMatchCalories(normalized);

    const data = {
      status: "pending",
      submitted_at: new Date().toISOString(),
      serving_size: serving_size ?? null,
      ...normalized,
    };
    const { ok, status, body } = await db.insert("packaged_foods", data);
    if (!ok) return err(body?.message || "Submit failed", status);

    const macroMismatch = macroCheck.checked && !macroCheck.matches;
    const message = macroMismatch
      ? `Packaged food submitted for review — declared calories (${macroCheck.declared_kcal} kcal) don't closely ` +
        `match protein/carbs/fat (~${macroCheck.calculated_kcal} kcal calculated). Please double-check the label.`
      : "Packaged food submitted for review";

    return success(body, {
      message,
      needs_review: macroMismatch,
      macro_check: macroCheck.checked ? macroCheck : undefined,
    });
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

/**
 * Dispatches to the actual resource handler. Pulled out of router() so the
 * edge-cache wrapper can call it uniformly whether or not a cache policy
 * applies to the route.
 */
async function dispatch(request, url, db, env, resource, param) {
  switch (resource) {
    case "foods": {
      if (param === "lookup") {
        return await handleFoodsLookup(request, url, db, env);
      }
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
      if (param === "scan") {
        return await handlePackagedScan(request, env, db);
      }
      const isSubmit = param === "submit";
      const id = isSubmit ? null : param || null;
      return await handlePackaged(request, url, db, id, isSubmit);
    }

    case "rag": {
      return await handleRAG(request, url, db, env, param || null);
    }

    case "memory": {
      return await handleMemory(request, url, db, env, param || null);
    }

    case "manufacturers": {
      const id = param || null;
      return await handleManufacturers(request, url, db, id);
    }

    case "products": {
      const id = param || null;
      return await handleProducts(request, url, db, id);
    }

    case "nutrition": {
      return await handleNutrition(request, url, db);
    }

    case "crawl": {
      // param here is a manufacturer slug, e.g. POST /crawl/abbott-nutrition
      return await handleCrawlTrigger(request, url, db, param || null);
    }

    case "status": {
      return await handleCrawlStatus(request, url, db);
    }

    default:
      return notFound();
  }
}

/**
 * Best-effort purge after an admin write. The Cache API only deletes exact
 * URL matches, so this can't clear every filtered/paginated variant that may
 * be cached — but it clears the two shapes people actually hit right after
 * an edit: the bare list endpoint and the single-id endpoint. Anything else
 * (odd filter combos) just ages out naturally within the TTL from cachePolicy.
 */
async function purgeResourceCache(origin, resource, param, ctx) {
  const urls = [`${origin}/${resource}`];
  if (param) urls.push(`${origin}/${resource}/${param}`);
  ctx.waitUntil(
    Promise.all(
      urls.map((u) => caches.default.delete(new Request(u, { method: "GET" })))
    )
  );
}

async function router(request, env, ctx) {
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

  // Admin-authenticated requests are exempt from rate limiting — the admin
  // key itself is the access control; volume caps only apply to public routes.
  if (policy.auth !== "admin") {
    const allowed = await checkRateLimit(
      env,
      rateBucketKey,
      policy.rate.limit,
      policy.rate.windowSeconds
    );
    if (!allowed) return rateLimited(policy.rate.windowSeconds);
  }

  // ── Edge cache (Cloudflare Cache API) — GET routes only ─────────────────────
  // Cache key includes full query string (filters/limit/offset/query text all
  // vary the response), so different filter combos on the same resource get
  // distinct cache entries automatically.
  const edgeCache = request.method === "GET" ? cachePolicy(resource, param) : null;
  const cacheKey = edgeCache ? new Request(url.toString(), request) : null;

  if (cacheKey) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const tagged = new Response(hit.body, hit);
      tagged.headers.set("X-Cache", "HIT");
      return tagged;
    }
  }

  try {
    const response = await dispatch(request, url, db, env, resource, param);

    if (cacheKey && response.status === 200) {
      const cacheable = new Response(response.body, response);
      cacheable.headers.set("Cache-Control", `public, max-age=${edgeCache.ttl}`);
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      cacheable.headers.set("X-Cache", "MISS");
      return cacheable;
    }

    // Successful admin write to a cacheable resource — clear the obvious
    // stale shapes so the next read isn't served last hour's data.
    if (
      request.method !== "GET" &&
      response.status < 300 &&
      cachePolicy(resource, param) !== null
    ) {
      await purgeResourceCache(url.origin, resource, param, ctx);
    }

    return response;
  } catch (e) {
    return serverErr(e);
  }
}

// ─── WORKER ENTRY ────────────────────────────────────────────────────────────

/**
 * Hourly cron (see wrangler.toml [triggers]) — the "Consolidate" step of the
 * Write/Consolidate/Recall/Apply memory cycle. Finds sessions that have
 * accumulated enough unconsolidated facts and summarizes each via
 * consolidateSession(). Runs independently per session; one failure doesn't
 * block the rest.
 */
async function runScheduledConsolidation(env) {
  const db = supabase(env);
  const { ok, body: candidates } = await db.rpc("sessions_needing_consolidation", {
    min_facts: MEMORY_MIN_FACTS_TO_CONSOLIDATE,
  });
  if (!ok || !Array.isArray(candidates) || !candidates.length) return;

  for (const { session_id } of candidates) {
    try {
      await consolidateSession(session_id, db, env);
    } catch (e) {
      console.error(`[consolidate] session ${session_id} failed:`, e.message);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await router(request, env, ctx);
    } catch (e) {
      return serverErr(e);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledConsolidation(env));
  },
};
