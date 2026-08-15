/**
 * Chakudya Nutrition Registry (CNR) — Malawi's First Open Food & Nutrition Database
 * Cloudflare Worker · Supabase REST backend (no SDK, pure fetch)
 * ---------------------------------------------------------------
 * Author : Edison Taimu 
 * Version: 1.7.0
 *
 * v1.7.0 changes:
 *  - Added POST /rag/ask — a RAG Search Orchestrator layered on top of the
 *    existing /rag/retrieve and /rag/ingest (neither of which changed: same
 *    endpoints, same request/response shape, same query params).
 *    Pipeline: Intent Detection (Groq llama-3.1-8b-instant, heuristic
 *    fallback) -> fan-out Search Orchestrator (semantic vector search,
 *    Malawi FCT / foods exact search, packaged/OCR-sourced foods, diabetes
 *    exchange list, renal exchange list, enteral formula DB, barcode lookup,
 *    and — only when local sources come back empty — the existing USDA
 *    FDC / Open Food Facts / FatSecret fallback cascade via
 *    lookupFoodCascade) -> Rerank (Cohere rerank-multilingual-v3.0, with a
 *    heuristic-score fallback if reranking fails or isn't configured) ->
 *    Build Context -> grounded LLM answer (Groq) with bracketed source
 *    citations. Optional `session_id` pulls in the existing session-memory
 *    layer (match_memory) as extra personalized context. Whole-answer KV
 *    cache (5 min TTL, skipped whenever session_id is present since that
 *    context is session-specific). Public, rate-limited (costs an embed +
 *    optional rerank + LLM call per request).
 *
 * v1.6.0 changes:
 *  - Added a KV-backed query cache for POST /rag/retrieve and
 *    POST|GET /memory/recall — a cache hit skips BOTH the Cohere embed
 *    call and the Supabase RPC, to reduce Cohere trial-quota usage.
 *    Reuses the existing RATE_LIMIT_KV binding under a new key prefix
 *    (ragcache:/memcache:) — no new binding required.
 *    RAG cache: 10 min TTL, keyed on (context, top_k, normalized query).
 *    Memory recall cache: 2 min TTL, keyed on (session_id, top_k,
 *    normalized query) — short TTL + session-scoped key because a
 *    session's facts can change mid-conversation via /memory/write.
 *    Deliberately NOT applied to /rag/ingest or /memory/write — caching a
 *    write risks silently dropping a distinct document/fact.
 *    Responses now include a "cache": "HIT"|"MISS" field on these two
 *    routes so you can see it working.
 *
 * v1.5.0 changes:
 *  - Removed the formula/product crawler entirely from this Worker: the
 *    trigger/status endpoints (POST /crawl, POST /crawl/:manufacturer_slug,
 *    GET /status) and their handlers (handleCrawlTrigger, handleCrawlStatus)
 *    are gone, and every remaining reference to "the crawler" in comments/
 *    docs has been cleaned up too. /manufacturers, /products, and
 *    /nutrition are untouched — they still serve whatever is already in
 *    those tables, just with no crawl-related framing left anywhere.
 *  - Embeddings stay on Cohere (embed-multilingual-v3.0) — no other
 *    provider added.
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
 * v1.16.0 changes:
 *  - Removed /products entirely (GET/GET-by-id/POST/PUT/PATCH/DELETE,
 *    plus /products/bulk) and /nutrition (which only ever queried
 *    product_nutrition filtered by product_id — dead weight without
 *    products to attach it to). Handlers, routePolicy/dispatch/
 *    cachePolicy/bulk-allowlist entries, and both entries in the GET /
 *    endpoint map are gone. "product" was also removed from
 *    FAVORITABLE_RESOURCE_TYPES — a favorite/history row pointing at a
 *    resource type with no backing endpoint isn't useful. The products
 *    and product_nutrition Supabase tables are a separate, manual DROP
 *    TABLE (product_nutrition first, or use CASCADE) — this file doesn't
 *    touch the schema.
 *
 * v1.15.0 changes:
 *  - Removed /manufacturers entirely (GET/POST/PATCH/DELETE, plus
 *    /manufacturers/bulk) — the table was unused (empty). Handler,
 *    routePolicy/dispatch/cachePolicy/bulk-allowlist entries, and the
 *    endpoint map in GET / are all gone. The manufacturers Supabase table
 *    itself is a separate, manual DROP TABLE — this file doesn't touch
 *    the schema. products.manufacturer_id (column + GET /products filter)
 *    is untouched and still works — it's just no longer FK-enforced
 *    against anything once the manufacturers table is dropped.
 *
 * v1.14.0 changes:
 *  - Added favorites (GET/POST/DELETE /favorites) and recently-viewed
 *    history (GET/POST /history). No user-account system — same
 *    client-supplied-identifier model as memory's session_id, here called
 *    user_id. Public, rate-limited, not admin-gated. Rows are NOT
 *    hydrated with the underlying food/product data — just the
 *    (user_id, resource_type, resource_id) linkage; look up details via
 *    the existing GET /foods|packaged|products/:id endpoints. Requires
 *    two new tables — see the comment above FAVORITABLE_RESOURCE_TYPES.
 *
 * v1.13.0 changes:
 *  - Added scoped roles for per-consumer API keys. POST /admin/keys now
 *    accepts an optional `role` ("admin", the default/full-access, or
 *    "reviewer", limited to the packaged review queue + reads). Existing
 *    keys default to "admin" via the new column's DB default, so nobody's
 *    access silently shrinks. See ROLE_RANK, isAdmin(), and the role gate
 *    in router(). Requires: alter table api_keys add column if not exists
 *    role text not null default 'admin';
 *
 * v1.12.0 changes:
 *  - Added POST /:resource/bulk (admin) for foods, exchange, renal,
 *    formulas, manufacturers, and products — accepts {items:[...]} (max
 *    500) and inserts them all in a single PostgREST batch request instead
 *    of one row at a time. See handleBulkInsert() and db.insertMany().
 *    Note: PostgREST batch insert is all-or-nothing — one bad row rejects
 *    the whole batch, nothing is partially inserted.
 *  - Added openapi.yaml at the repo root — a full OpenAPI 3.0.3 spec
 *    covering every route this file serves, generated from this changelog
 *    + the README. Not served by the Worker itself (static file only, for
 *    import into Swagger UI/Postman or SDK generation) — keep it in sync
 *    by hand alongside README changes when adding/changing routes.
 *
 * v1.11.0 changes:
 *  - Added per-consumer admin API keys (POST/GET/DELETE /admin/keys,
 *    root-key-only to manage). isAdmin() now checks the raw root key
 *    first, then looks up a SHA-256 hash against the new api_keys table.
 *    Resolves the long-standing "reviewed_by is just free text" limitation
 *    on /packaged/:id/approve|reject — a per-consumer key's label is now
 *    used automatically as the actor identity, no override needed. See
 *    the comment above handleAdminKeys for the required table schema.
 *
 * v1.10.0 changes:
 *  - Added structured request logging + X-Request-Id. Every request gets a
 *    UUID, echoed back as the X-Request-Id response header and included in
 *    one structured JSON log line per request (via console.log/error, so
 *    it shows up in `wrangler tail` / Workers Logs). 500 responses also
 *    carry request_id in the JSON body. Set env.DISABLE_REQUEST_LOGGING =
 *    "true" to silence the per-request info log if volume becomes a
 *    concern (errors still always log). See the WORKER ENTRY section.
 *
 * v1.9.0 changes:
 *  - Added cursor-based (keyset) pagination as an opt-in alternative to
 *    offset/limit on GET /foods, /exchange, /renal, /formulas,
 *    /manufacturers, /products, and /packaged. Triggered by the presence
 *    of a `cursor` query param; offset/limit remains the default when it's
 *    absent, so existing integrations are unaffected. See paginatedList().
 *
 * v1.8.0 changes:
 *  - Added POST /packaged/:id/approve and POST /packaged/:id/reject — admin
 *    review queue for community/OCR submissions (paired with the new
 *    GET /packaged/pending listing). Requires reviewed_at/reviewed_by/
 *    rejection_reason columns on packaged_foods — see comment above
 *    handlePackagedPending.
 *  - Barcode duplicate handling on POST /packaged/submit and POST
 *    /packaged/scan — packaged_foods.barcode has a UNIQUE constraint, so a
 *    matching pending/approved row now blocks the new submission (409,
 *    existing row returned) instead of failing on the raw DB constraint;
 *    a matching rejected row is overwritten in place as a resubmission.
 *  - Added GET /health — pings Supabase/Cohere/Groq in parallel and reports
 *    per-service status plus overall healthy/degraded, so a single request
 *    tells you which upstream is the cause when routes start failing.
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

// ─── VERSION ─────────────────────────────────────────────────────────────────
// Single source of truth for the version reported by GET / (handleRoot).
// Bump this alongside the changelog comment at the top of this file — the two
// had drifted out of sync before (header said v1.4.0, GET / said v1.2.0).
const CNR_VERSION = "1.16.0";

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

function serverErr(e, requestId) {
  console.error(
    JSON.stringify({
      level: "error",
      request_id: requestId || null,
      message: e?.message || String(e),
    })
  );
  return json({ status: "error", message: "Internal server error", request_id: requestId || undefined }, 500);
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

/**
 * Role hierarchy for per-consumer API keys (see /admin/keys and isAdmin()).
 * "reviewer" is a subset of "admin" — can only reach routes that
 * explicitly opt in via routePolicy's requiredRole: "reviewer" (currently
 * just the packaged review queue: GET /packaged/pending, POST
 * /packaged/:id/approve|reject). Every other admin route implicitly
 * requires "admin" (the strictest/default), so a route added later that
 * forgets to set requiredRole fails closed rather than open.
 */
const ROLE_RANK = { reviewer: 1, admin: 2 };
const VALID_ROLES = Object.keys(ROLE_RANK);

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// sha256Hex() is defined further down (used first by the query-cache
// helpers) — reused here for API key hashing too. Function declarations
// are hoisted, so the call below is safe regardless of file order.

/**
 * Resolves the bearer token on a request to an admin identity.
 *
 * Two kinds of valid admin credential:
 *  - The "root" key — env.ADMIN_API_KEY, matched directly (legacy behavior,
 *    always works even if the api_keys table doesn't exist yet or is
 *    empty). Only the root key can manage other keys (POST/GET/DELETE
 *    /admin/keys), and root always has full access regardless of role
 *    checks elsewhere — it has no `role` column entry to read.
 *  - A per-consumer key — looked up by SHA-256 hash in `api_keys` (the raw
 *    key is never stored, only its hash, so a DB leak doesn't leak usable
 *    credentials). Must not be revoked. `last_used_at` is bumped on every
 *    successful use (fire-and-forget via ctx.waitUntil — doesn't block or
 *    fail the request if that write is slow/fails).
 *
 * Returns { valid: false } or { valid: true, label, isRoot, keyId, role }.
 * `label` is what gets used as the default reviewed_by/actor identity on
 * writes that record one (see handlePackagedApprove/Reject). `role` is
 * either "admin" (full access, the default — same as before roles
 * existed) or "reviewer" (packaged-review + reads only, see routePolicy's
 * requiredRole checks and the role gate in router()). Falls back to
 * "admin" if the row predates the `role` column (safe default — an
 * existing key's access doesn't silently shrink when this feature ships).
 */
async function isAdmin(request, env, db, ctx) {
  const token = getBearerToken(request);
  if (!token) return { valid: false };

  if (!env.ADMIN_API_KEY) {
    // Misconfiguration safety: if no root key is set, fail closed (deny
    // writes) rather than silently allowing unauthenticated writes.
    return { valid: false };
  }

  if (token === env.ADMIN_API_KEY) {
    return { valid: true, label: "root", isRoot: true, keyId: null, role: "admin" };
  }

  if (!db) return { valid: false };

  const hash = await sha256Hex(token);
  const { ok, body } = await db.select("api_keys", {
    filters: { key_hash: `eq.${hash}`, revoked_at: "is.null" },
    limit: 1,
  });
  if (!ok || !Array.isArray(body) || !body.length) return { valid: false };

  const row = body[0];
  const bump = db
    .update("api_keys", row.id, { last_used_at: new Date().toISOString() }, "PATCH")
    .catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(bump);

  return { valid: true, label: row.label, isRoot: false, keyId: row.id, role: row.role || "admin" };
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
 * Returns { allowed, retryAfter }. retryAfter is the number of seconds left
 * in the current window — accurate to the second, rather than always
 * reporting the full window length regardless of when within it the caller
 * was blocked.
 * Fails OPEN (allowed: true) if RATE_LIMIT_KV isn't bound, so the API
 * doesn't go fully down just because the namespace wasn't configured yet —
 * but this should be treated as a setup TODO, not a permanent state. Check
 * GET / -> kv_bound to confirm the binding is actually live.
 */
async function checkRateLimit(env, bucketKey, limit, windowSeconds) {
  if (!env.RATE_LIMIT_KV) return { allowed: true, retryAfter: 0 };

  const nowSeconds = Date.now() / 1000;
  const windowId = Math.floor(nowSeconds / windowSeconds);
  const key = `rl:${bucketKey}:${windowId}`;
  const retryAfter = Math.ceil((windowId + 1) * windowSeconds - nowSeconds);

  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= limit) return { allowed: false, retryAfter };

  await env.RATE_LIMIT_KV.put(key, String(current + 1), {
    expirationTtl: windowSeconds + 5,
  });
  return { allowed: true, retryAfter: 0 };
}

// ─── QUERY CACHE (Cloudflare KV) — RAG retrieve & memory recall only ────────
//
// /rag/retrieve and /memory/recall both spend a Cohere embed call (billed
// against the same trial quota as everything else) just to turn the query
// text into a vector before searching. Repeat/near-repeat questions are
// common — this caches the full response so a cache hit skips BOTH the
// Cohere call and the Supabase RPC.
//
// Deliberately NOT used on /rag/ingest or /memory/write: those are writes,
// and caching a write risks silently dropping a distinct document or a
// distinct clinical fact on what looks like a "repeat" call. Only read
// (query) routes are safe to cache.
//
// Reuses the existing RATE_LIMIT_KV binding (own key prefix, no new
// namespace needed) — fails open (no caching, but no breakage) if it isn't
// bound, same as checkRateLimit above.

function normalizeQueryText(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the parsed cached value, or null on a miss / no KV bound. */
async function getQueryCache(env, prefix, keyParts) {
  if (!env.RATE_LIMIT_KV) return null;
  const hash = await sha256Hex(keyParts.join("|"));
  const cached = await env.RATE_LIMIT_KV.get(`${prefix}:${hash}`);
  return cached ? JSON.parse(cached) : null;
}

/** Fire-and-forget (via ctx.waitUntil) cache write — never blocks the response. */
function putQueryCache(env, ctx, prefix, keyParts, value, ttlSeconds) {
  if (!env.RATE_LIMIT_KV) return;
  const write = sha256Hex(keyParts.join("|")).then((hash) =>
    env.RATE_LIMIT_KV.put(`${prefix}:${hash}`, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    })
  );
  if (ctx?.waitUntil) ctx.waitUntil(write);
}

const RAG_CACHE_TTL_SECONDS = 600; // 10 min — reference content changes rarely
const MEMORY_RECALL_CACHE_TTL_SECONDS = 120; // 2 min — a session's facts can change mid-conversation, keep this short

/**
 * Central policy: how each route is protected.
 * - auth: "public" | "admin"
 * - rate: { limit, windowSeconds, scope: "ip" | "admin" }
 * Tune these numbers as real usage patterns emerge.
 */
function routePolicy(resource, method, param, action) {
  const isWrite = method !== "GET";
  const isHealth = resource === "health" && method === "GET";
  const isPackagedSubmit = resource === "packaged" && param === "submit" && method === "POST";
  const isPackagedScan = resource === "packaged" && param === "scan" && method === "POST";
  const isPackagedPending = resource === "packaged" && param === "pending" && method === "GET";
  const isPackagedReview =
    resource === "packaged" && (action === "approve" || action === "reject") && method === "POST";
  const isRagRetrieve = resource === "rag" && (param === "retrieve" || !param) && method === "POST";
  const isRagIngest = resource === "rag" && param === "ingest" && method === "POST";
  const isRagAsk = resource === "rag" && param === "ask" && method === "POST";
  const isFoodsLookup = resource === "foods" && param === "lookup" && method === "GET";
  const isMemoryWrite = resource === "memory" && param === "write" && method === "POST";
  const isMemoryRecall = resource === "memory" && param === "recall" && (method === "GET" || method === "POST");
  const isMemoryConsolidate = resource === "memory" && param === "consolidate" && method === "POST";
  const isAdminKeys = resource === "admin" && param === "keys";
  const isBulkInsert =
    ["foods", "exchange", "renal", "formulas"].includes(resource) &&
    param === "bulk" &&
    method === "POST";
  const isFavorites = resource === "favorites";
  const isHistory = resource === "history";

  // Favorites/history — no admin gate (same public, self-declared-identity
  // model as memory/write and memory/recall: the client supplies its own
  // user_id, there's no server-side account system). Writes capped tighter
  // than reads.
  if (isFavorites || isHistory) {
    return isWrite
      ? { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } }
      : { auth: "public", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // API key management — admin-gated regardless of method (including GET,
  // which would otherwise fall through to the public-reads default below).
  // Root-only enforcement (as opposed to any admin key) happens in
  // router(), since routePolicy() only resolves auth *level*, not identity.
  if (isAdminKeys) {
    return { auth: "admin", rate: { limit: 30, windowSeconds: 60, scope: "admin" } };
  }

  // Bulk insert — admin only, tighter cap than plain writes since each
  // request can carry up to BULK_MAX_ITEMS rows and does more DB work.
  if (isBulkInsert) {
    return { auth: "admin", rate: { limit: 10, windowSeconds: 60, scope: "admin" } };
  }

  // Health check — public, moderate cap. Each hit fans out 2-3 upstream
  // pings, so it shouldn't be as generously limited as a plain local read.
  if (isHealth) {
    return { auth: "public", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

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

  // Admin review queue — exposes unapproved community/OCR submissions,
  // so it must never be public even though it's a GET. Reviewer-role keys
  // can access this (it's the whole point of the reviewer role).
  if (isPackagedPending) {
    return { auth: "admin", requiredRole: "reviewer", rate: { limit: 60, windowSeconds: 60, scope: "admin" } };
  }

  // Approve/reject a pending submission — admin only, same as any other
  // packaged write. Called out explicitly (rather than relying on the
  // generic isWrite catch-all below) so its own rate budget can be tuned
  // independently of bulk CRUD if review volume ever grows. Reviewer-role
  // keys can access this too — see requiredRole in router()'s role gate.
  if (isPackagedReview) {
    return { auth: "admin", requiredRole: "reviewer", rate: { limit: 60, windowSeconds: 60, scope: "admin" } };
  }

  // RAG retrieve costs a Cohere call per request — public but capped harder than plain reads.
  if (isRagRetrieve) {
    return { auth: "public", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // RAG ingest writes to the knowledge base AND costs a Cohere call — admin only.
  if (isRagIngest) {
    return { auth: "admin", rate: { limit: 300, windowSeconds: 60, scope: "admin" } };
  }

  // RAG orchestrator (/rag/ask): intent classification (Groq) + embed
  // (Cohere) + fan-out searches + rerank (Cohere) + answer (Groq) per
  // request — public but capped harder than plain /rag/retrieve since it's
  // the most expensive route in the API.
  if (isRagAsk) {
    return { auth: "public", rate: { limit: 15, windowSeconds: 60, scope: "ip" } };
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
     * Same as insert(), but for a whole array of rows in one PostgREST
     * request (a single POST with a JSON array body, which PostgREST
     * natively supports as a batch insert) — used by the /:resource/bulk
     * endpoints. Unlike insert(), does NOT unwrap to a single row; body is
     * the full array of inserted rows (or a PostgREST error object).
     */
    async insertMany(table, payloadArray) {
      const url = `${base}/${table}`;
      const { ok, status, body } = await query(url, {
        method: "POST",
        body: JSON.stringify(payloadArray),
      });
      return { ok, status, body };
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

    /**
     * Delete by arbitrary filter columns instead of a single primary key —
     * used by favorites/history, which are identified by a
     * (user_id, resource_type, resource_id) composite, not a numeric id
     * the client would otherwise have to look up first.
     */
    async removeWhere(table, filters) {
      const url = buildUrl(table, { filters });
      const res = await fetch(url, { method: "DELETE", headers: { ...headers, Prefer: "return=representation" } });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body };
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

/**
 * Shared list-pagination helper used by /foods, /exchange, /renal,
 * /formulas, and /products.
 *
 * Two modes, selected by whether `?cursor=` is present at all:
 *
 *  - No `cursor` param → legacy offset/limit pagination (unchanged default
 *    behavior — existing integrations aren't affected). Ordered by
 *    `order`, or whatever PostgREST's default is if omitted.
 *
 *  - `cursor` param present → keyset pagination. `cursor=` (empty) starts
 *    from the beginning; `cursor=<id>` resumes after that id. Always
 *    ordered by `id.asc` for deterministic keyset semantics — note this
 *    can differ from the offset mode's default sort (e.g. /foods sorts
 *    offset pages by `food_name.asc`, but cursor pages always go by id).
 *    Response shape differs from listSuccess: `has_more` / `next_cursor`
 *    instead of `count` / `offset`, since a total count isn't cheap to
 *    keep accurate under keyset pagination.
 *
 * Offset pagination degrades on large, actively-changing tables (rows
 * shift between pages as data is inserted/deleted); cursor pagination
 * doesn't have that problem, which is the whole reason to offer it.
 */
async function paginatedList(db, table, url, { filters = {}, order } = {}) {
  const limit = limitParam(url);
  const cursorParam = url.searchParams.get("cursor");

  if (cursorParam !== null) {
    const cursorFilters = { ...filters };
    if (cursorParam !== "") {
      const cursorId = Number(cursorParam);
      if (!Number.isFinite(cursorId)) {
        return err("Invalid 'cursor' — must be a numeric id, taken from a previous response's next_cursor");
      }
      cursorFilters.id = `gt.${cursorId}`;
    }

    // Fetch one extra row to detect whether another page exists, without a
    // separate count query.
    const { ok, status, body } = await db.select(table, {
      filters: cursorFilters,
      limit: limit + 1,
      offset: 0,
      order: "id.asc",
    });
    if (!ok) return err(body?.message || "Query failed", status);

    const rows = Array.isArray(body) ? body : [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return json({
      status: "success",
      limit,
      has_more: hasMore,
      next_cursor: hasMore && page.length ? page[page.length - 1].id : null,
      data: page,
    });
  }

  const offset = intParam(url, "offset", 0);
  const { ok, status, body, total } = await db.select(table, { filters, limit, offset, order });
  if (!ok) return err(body?.message || "Query failed", status);
  return listSuccess(body, { count: total, limit, offset });
}

/** Max rows accepted in a single /:resource/bulk request — keeps a single
 * PostgREST call (and the request/response body) bounded. Callers with
 * more rows than this should split into multiple requests. */
const BULK_MAX_ITEMS = 500;

/**
 * Shared handler for POST /:resource/bulk — admin-only batch insert used
 * by /foods/bulk, /exchange/bulk, /renal/bulk, /formulas/bulk, and
 * /products/bulk. Accepts `{ "items": [...] }`
 * and inserts them all in a single PostgREST request (a batch insert,
 * not N sequential single-row inserts), so loading e.g. a spreadsheet of
 * 200 foods is one request instead of 200.
 *
 * `requiredField`, if given, is validated on every item up front (mirrors
 * whatever the single-row POST for that resource already requires) so a
 * bad row is caught before hitting the DB, with an index the caller can
 * fix, rather than PostgREST rejecting the whole batch on a constraint
 * error partway through.
 *
 * Note: PostgREST's batch insert is all-or-nothing — if any row violates
 * a constraint (e.g. a duplicate unique key), the entire batch is rejected
 * and nothing is inserted. That's intentional here (silently skipping bad
 * rows in a 200-row admin load would be worse), but worth knowing before
 * bulk-loading data with duplicates in it.
 */
async function handleBulkInsert(request, db, table, { requiredField, label } = {}) {
  const payload = await parseBody(request);
  const items = payload?.items;

  if (!Array.isArray(items) || !items.length) {
    return err("'items' must be a non-empty array");
  }
  if (items.length > BULK_MAX_ITEMS) {
    return err(`Too many items — max ${BULK_MAX_ITEMS} per request, got ${items.length}`);
  }
  if (requiredField) {
    const badIndex = items.findIndex((item) => !item || !item[requiredField]);
    if (badIndex !== -1) {
      return err(`Item at index ${badIndex} is missing required field '${requiredField}'`);
    }
  }

  const { ok, status, body } = await db.insertMany(table, items);
  if (!ok) return err(body?.message || "Bulk insert failed", status);

  const rows = Array.isArray(body) ? body : [];
  return success(rows, { message: `${rows.length} ${label} created`, count: rows.length });
}

// ─── FAVORITES / RECENTLY VIEWED ─────────────────────────────────────────────
//
// No user-account system exists in this API (same trust model as the
// memory system's session_id: the client generates and keeps its own
// identifier — a device id, an app-level user id, whatever — and passes
// it on every call). `user_id` here plays exactly that role.
//
// Two tables, deliberately NOT hydrated with the underlying food/product
// row — these endpoints return just the (user_id, resource_type,
// resource_id) linkage plus a timestamp. The client already has
// GET /foods/:id, /packaged/:id, /products/:id to look up full details;
// duplicating that data here would just be another place for it to go
// stale.
//
// Requires these tables:
//   create table if not exists favorites (
//     id bigint generated always as identity primary key,
//     user_id text not null,
//     resource_type text not null,
//     resource_id bigint not null,
//     created_at timestamptz not null default now(),
//     unique (user_id, resource_type, resource_id)
//   );
//   create index if not exists favorites_user_id_idx on favorites(user_id);
//
//   create table if not exists view_history (
//     id bigint generated always as identity primary key,
//     user_id text not null,
//     resource_type text not null,
//     resource_id bigint not null,
//     viewed_at timestamptz not null default now(),
//     unique (user_id, resource_type, resource_id)
//   );
//   create index if not exists view_history_user_id_idx on view_history(user_id, viewed_at desc);

const FAVORITABLE_RESOURCE_TYPES = ["food", "packaged"];

function validateFavoritePayload(payload) {
  const userId = (payload?.user_id || "").trim();
  const resourceType = (payload?.resource_type || "").trim();
  const resourceId = payload?.resource_id;

  if (!userId) return { error: "'user_id' is required" };
  if (!FAVORITABLE_RESOURCE_TYPES.includes(resourceType)) {
    return { error: `'resource_type' must be one of: ${FAVORITABLE_RESOURCE_TYPES.join(", ")}` };
  }
  if (resourceId === undefined || resourceId === null || resourceId === "") {
    return { error: "'resource_id' is required" };
  }
  return { userId, resourceType, resourceId };
}

/** GET/POST /favorites, DELETE /favorites — save/list/remove a food-like resource for a user_id. */
async function handleFavorites(request, url, db) {
  const method = request.method;

  if (method === "GET") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return err("'user_id' query param is required");
    const resourceType = url.searchParams.get("resource_type") || "";

    const filters = { user_id: `eq.${userId}` };
    if (resourceType) filters["resource_type"] = `eq.${resourceType}`;

    return await paginatedList(db, "favorites", url, { filters, order: "created_at.desc" });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    const parsed = validateFavoritePayload(payload);
    if (parsed.error) return err(parsed.error);

    // Idempotent: favoriting something already favorited isn't an error —
    // upsert on the (user_id, resource_type, resource_id) unique
    // constraint just returns the existing row unchanged.
    const { ok, status, body } = await db.upsert(
      "favorites",
      { user_id: parsed.userId, resource_type: parsed.resourceType, resource_id: parsed.resourceId },
      "user_id,resource_type,resource_id"
    );
    if (!ok) return err(body?.message || "Favorite failed", status);
    return success(body, { message: "Saved to favorites" });
  }

  if (method === "DELETE") {
    const payload = await parseBody(request);
    const parsed = validateFavoritePayload(payload);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.removeWhere("favorites", {
      user_id: `eq.${parsed.userId}`,
      resource_type: `eq.${parsed.resourceType}`,
      resource_id: `eq.${parsed.resourceId}`,
    });
    if (!ok) return err(body?.message || "Remove failed", status);
    const removed = Array.isArray(body) ? body.length : 0;
    return success(null, { message: removed ? "Removed from favorites" : "Not in favorites (nothing to remove)", removed: !!removed });
  }

  return err("Method not allowed", 405);
}

/** GET/POST /history — log or list "recently viewed" for a user_id (upserts viewed_at, no duplicate rows per resource). */
async function handleHistory(request, url, db) {
  const method = request.method;

  if (method === "GET") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return err("'user_id' query param is required");
    const resourceType = url.searchParams.get("resource_type") || "";

    const filters = { user_id: `eq.${userId}` };
    if (resourceType) filters["resource_type"] = `eq.${resourceType}`;

    const limit = limitParam(url);
    const offset = intParam(url, "offset", 0);
    const { ok, status, body, total } = await db.select("view_history", {
      filters,
      limit,
      offset,
      order: "viewed_at.desc",
    });
    if (!ok) return err(body?.message || "Query failed", status);
    return listSuccess(body, { count: total, limit, offset });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    const parsed = validateFavoritePayload(payload);
    if (parsed.error) return err(parsed.error);

    // Upsert, not insert — repeat views of the same resource update
    // viewed_at in place rather than piling up duplicate rows, so
    // GET /history?user_id=... is already a clean "recently viewed" list
    // sorted by viewed_at, no client-side de-duping needed.
    const { ok, status, body } = await db.upsert(
      "view_history",
      {
        user_id: parsed.userId,
        resource_type: parsed.resourceType,
        resource_id: parsed.resourceId,
        viewed_at: new Date().toISOString(),
      },
      "user_id,resource_type,resource_id"
    );
    if (!ok) return err(body?.message || "History log failed", status);
    return success(body, { message: "Logged" });
  }

  return err("Method not allowed", 405);
}

/**
 * Escapes PostgREST/Postgres LIKE wildcard characters (% and _) in raw user
 * search input before it's wrapped in `ilike.*value*`. Without this, a search
 * like "50% juice" or "under_ripe" is silently interpreted as a wildcard
 * pattern instead of a literal string, returning surprising/broad matches
 * (not an injection risk — PostgREST parameterizes the SQL — but a real
 * correctness bug for anyone searching a food/product name containing % or _).
 */
function escapeLikePattern(raw) {
  return String(raw).replace(/[%_]/g, (c) => `\\${c}`);
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

/**
 * Looks for an existing packaged_foods row with the same barcode, so a new
 * submission can be flagged as a probable duplicate rather than silently
 * piling up alongside it in the review queue. Prefers an already-approved
 * row (the "real" entry a duplicate should be compared/merged against);
 * falls back to the most recent pending one if nothing's approved yet.
 * Returns null if there's no barcode to check or nothing matches.
 */
async function findDuplicateByBarcode(db, barcode) {
  if (!barcode) return null;
  const { ok, body } = await db.select("packaged_foods", {
    filters: { barcode: `eq.${barcode}` },
    limit: 10,
    order: "submitted_at.desc",
  });
  if (!ok || !Array.isArray(body) || !body.length) return null;
  return body.find((row) => row.status === "approved") || body[0];
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
      filters: { food_name: `ilike.*${escapeLikePattern(query)}*` },
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
  else if (query) cacheFilters.food_name = `ilike.*${escapeLikePattern(query)}*`;
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
async function handleRAG(request, url, db, env, param, ctx) {
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

  // ── POST /rag/ask — RAG Search Orchestrator ────────────────────────────────
  if (param === "ask") {
    return await handleRagAsk(request, url, db, env, ctx, body);
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

    const cappedTopK = Math.min(top_k, 20);

    // Cache hit — skip the Cohere embed call AND the Supabase RPC entirely.
    const cacheKeyParts = ["rag", context, String(cappedTopK), normalizeQueryText(query)];
    const cached = await getQueryCache(env, "ragcache", cacheKeyParts);
    if (cached) {
      return success(cached.chunks, {
        query,
        context,
        count: cached.chunks.length,
        cache: "HIT",
      });
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
      match_count: cappedTopK,
      context_filter: contextFilter,
      query_text: query,
    });

    if (!ok) return err(chunks?.message || "RAG search failed", status);

    const chunkList = Array.isArray(chunks) ? chunks : [];
    putQueryCache(env, ctx, "ragcache", cacheKeyParts, { chunks: chunkList }, RAG_CACHE_TTL_SECONDS);

    return success(chunkList, {
      query,
      context,
      count: chunkList.length,
      cache: "MISS",
    });
  }

  return notFound("RAG route");
}

// ─── RAG SEARCH ORCHESTRATOR (POST /rag/ask) ─────────────────────────────────
//
//   User Query
//       -> Intent Detection            (classifyIntent)
//       -> Search Orchestrator          (fan-out, Promise.allSettled)
//            - Semantic Search (Vector DB)     -> semanticSearchForAsk (match_documents)
//            - Exact SQL Search / Malawi FCT   -> searchFoodsExact (foods)
//            - Packaged / OCR-sourced foods    -> searchPackagedExact (packaged_foods)
//            - Diabetes Exchange List          -> scanTableByKeywords (exchange_lists)
//            - Renal Exchange List             -> scanTableByKeywords (renal_foods)
//            - Enteral Formula Database        -> scanTableByKeywords (enteral_formulas)
//            - Barcode Lookup                  -> lookupFoodCascade (barcode branch)
//            - USDA FDC / Open Food Facts /
//              FatSecret (fallback only)       -> lookupFoodCascade (query branch)
//       -> Rerank Results                (rerankCandidates, Cohere rerank-multilingual-v3.0)
//       -> Build Context                 (numbered, tagged snippet block)
//       -> LLM (Groq)                    (answerWithLLM) -> grounded answer + citations
//
// Intent detection decides which of the 8 sources above are actually worth
// querying for this particular question — e.g. a greeting doesn't need an
// enteral-formula table scan, and a specific-food question doesn't need the
// diabetes exchange list. This keeps the orchestrator's per-request cost
// (Cohere embed, Cohere rerank, Groq classify, Groq answer, N Supabase
// queries) proportional to what the question actually needs instead of
// always hitting all 8 sources on every request.

const ASK_CACHE_TTL_SECONDS = 300; // 5 min — shorter than RAG_CACHE_TTL_SECONDS since this caches a full generated answer, not just raw chunks

const RAG_ASK_INTENTS = [
  "food_search",
  "barcode_search",
  "nutrition_question",
  "exchange_list",
  "enteral_formula",
  "general_chat",
];

// Which sources the orchestrator fans out to per intent. `externalFallback`
// only fires when the local structured sources (foods/packaged/barcode) came
// back completely empty — see handleRagAsk.
const INTENT_SOURCE_PLAN = {
  food_search: { semantic: true, foods: true, packaged: true, exchange: false, renal: false, formulas: false, externalFallback: true },
  barcode_search: { semantic: true, foods: true, packaged: true, exchange: false, renal: false, formulas: false, externalFallback: true },
  nutrition_question: { semantic: true, foods: true, packaged: false, exchange: false, renal: false, formulas: false, externalFallback: false },
  exchange_list: { semantic: true, foods: true, packaged: false, exchange: true, renal: true, formulas: false, externalFallback: false },
  enteral_formula: { semantic: true, foods: true, packaged: false, exchange: false, renal: false, formulas: true, externalFallback: false },
  general_chat: { semantic: true, foods: false, packaged: false, exchange: false, renal: false, formulas: false, externalFallback: false },
};

/** Finds the first 8-14 digit run in free text — a plausible barcode/EAN/UPC. */
function extractBarcode(text) {
  const match = String(text || "").match(/(?<!\d)\d{8,14}(?!\d)/);
  return match ? match[0] : null;
}

const RAG_ASK_STOPWORDS = new Set([
  "the", "and", "for", "with", "what", "is", "are", "how", "much", "many",
  "does", "that", "this", "can", "should", "have", "has", "from", "about",
  "into", "per", "food", "foods", "you", "your", "tell", "me", "please",
  "need", "want", "would", "could", "give", "list", "does", "any",
]);

/** Loose keyword extraction for the schema-agnostic keyword scan (scanTableByKeywords). */
function extractKeywords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !RAG_ASK_STOPWORDS.has(w));
}

/** Keyword-only intent guess — used when GROQ_API_KEY isn't configured, or Groq classification fails. */
function heuristicIntent(query) {
  const q = query.toLowerCase().trim();
  if (extractBarcode(query)) return "barcode_search";
  if (/\b(renal|kidney|dialysis|ckd)\b/.test(q)) return "exchange_list";
  if (/\b(exchange|diabet|carb counting|glycaemic|glycemic)\b/.test(q)) return "exchange_list";
  if (/\b(enteral|tube.?feed|parenteral|\btpn\b|formula)\b/.test(q)) return "enteral_formula";
  if (/^(hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening)\b/.test(q)) return "general_chat";
  if (/\b(what is|why|explain|difference between|how does|how do)\b/.test(q)) return "nutrition_question";
  return "food_search";
}

/**
 * Classifies a query into one of RAG_ASK_INTENTS via a cheap/fast Groq call
 * (same llama-3.1-8b-instant pattern already used client-side in Oasis's
 * FatSecret query classifier), falling back to heuristicIntent() if
 * GROQ_API_KEY isn't configured or the call/parse fails for any reason.
 * Never throws — always returns a usable { intent, barcode } pair.
 */
async function classifyIntent(query, env) {
  if (!env.GROQ_API_KEY) {
    return { intent: heuristicIntent(query), barcode: extractBarcode(query) };
  }

  const prompt = `Classify this nutrition-app user query into exactly one intent label: food_search, barcode_search, nutrition_question, exchange_list, enteral_formula, general_chat.

- food_search: looking up a specific food/ingredient/product's nutrition info
- barcode_search: the query is or contains a product barcode number
- nutrition_question: a general nutrition/clinical knowledge question, not about one specific food
- exchange_list: about diabetic or renal food exchange/portion lists
- enteral_formula: about tube-feeding/enteral/parenteral formulas
- general_chat: greetings, thanks, small talk, anything not nutrition-related

Query: "${query}"

Respond with ONLY this JSON, no other text: {"intent": "<label>", "barcode": "<digits found in the query, or null>"}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_completion_tokens: 60,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Groq classify failed (${res.status})`);

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

    const intent = RAG_ASK_INTENTS.includes(parsed.intent) ? parsed.intent : heuristicIntent(query);
    const barcode = /^\d{8,14}$/.test(String(parsed.barcode || "")) ? String(parsed.barcode) : extractBarcode(query);
    return { intent, barcode };
  } catch (e) {
    return { intent: heuristicIntent(query), barcode: extractBarcode(query) };
  }
}

const ASK_ROW_EXCLUDED_FIELDS = new Set(["embedding", "created_at", "updated_at", "id"]);

/**
 * Schema-agnostic row -> text formatter. Used for tables (exchange_lists,
 * renal_foods, enteral_formulas) whose exact column names aren't assumed —
 * this just serializes whatever non-empty, non-internal fields exist, so it
 * keeps working even if those tables' schemas differ from what's documented.
 */
function rowToText(row, maxLen = 400) {
  if (!row) return "";
  const parts = [];
  for (const [k, v] of Object.entries(row)) {
    if (ASK_ROW_EXCLUDED_FIELDS.has(k) || v === null || v === undefined || v === "") continue;
    parts.push(`${k}: ${v}`);
  }
  const text = parts.join(", ");
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/**
 * Fetches up to `limit` rows from `table` and keeps only the ones where at
 * least one extracted query keyword appears anywhere in the row (checked via
 * a stringified, lowercased scan rather than a column-specific ilike filter,
 * since exchange_lists/renal_foods/enteral_formulas don't have a documented
 * single "name" column to filter on). Returns { row, score } sorted
 * descending by keyword-match count, capped to 8.
 */
async function scanTableByKeywords(db, table, keywords, limit = 150) {
  if (!keywords.length) return [];
  const { ok, body } = await db.select(table, { limit, offset: 0 });
  if (!ok || !Array.isArray(body)) return [];

  const scored = [];
  for (const row of body) {
    const haystack = JSON.stringify(row).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) score += 1;
    }
    if (score > 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

/** Malawi FCT / curated foods table — exact ilike search on food_name. */
async function searchFoodsExact(db, query, limit = 5) {
  if (!query) return [];
  const { ok, body } = await db.select("foods", {
    filters: { food_name: `ilike.*${escapeLikePattern(query)}*` },
    limit,
  });
  return ok && Array.isArray(body) ? body : [];
}

/** Community/OCR-submitted packaged foods — exact ilike search on product_name, approved only. */
async function searchPackagedExact(db, query, limit = 5) {
  if (!query) return [];
  const { ok, body } = await db.select("packaged_foods", {
    filters: { product_name: `ilike.*${escapeLikePattern(query)}*`, status: "eq.approved" },
    limit,
  });
  return ok && Array.isArray(body) ? body : [];
}

/**
 * Semantic (vector DB) search against rag_knowledge_base via match_documents
 * — same embed + RPC pattern as POST /rag/retrieve, but with its own cache
 * key prefix (asksemcache) so it never collides with or disturbs the
 * existing /rag/retrieve cache entries. Returns the query embedding too, so
 * handleRagAsk can reuse it for match_memory instead of embedding twice.
 */
async function semanticSearchForAsk(query, context, topK, db, env, ctx) {
  const cappedTopK = Math.min(topK, 10);
  const cacheKeyParts = ["asksem", context, String(cappedTopK), normalizeQueryText(query)];
  const cached = await getQueryCache(env, "asksemcache", cacheKeyParts);
  if (cached) return { chunks: cached.chunks, embedding: null, cacheHit: true };

  let queryEmbedding;
  try {
    queryEmbedding = await embedText(query, env, "search_query");
  } catch (e) {
    return { chunks: [], embedding: null, error: e.message };
  }

  const contextFilter = !context || context === "both" ? null : context;
  const { ok, body: chunks } = await db.rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_count: cappedTopK,
    context_filter: contextFilter,
    query_text: query,
  });

  const chunkList = ok && Array.isArray(chunks) ? chunks : [];
  putQueryCache(env, ctx, "asksemcache", cacheKeyParts, { chunks: chunkList }, RAG_CACHE_TTL_SECONDS);
  return { chunks: chunkList, embedding: queryEmbedding, cacheHit: false };
}

/**
 * Reranks candidates against the query via Cohere rerank-multilingual-v3.0.
 * Falls back to a plain score-descending sort (whatever score each source
 * already attached) if COHERE_API_KEY is missing, there's <=1 candidate, or
 * the rerank call itself fails — reranking is an enhancement, not a hard
 * dependency of the orchestrator.
 */
async function rerankCandidates(query, candidates, env, topN) {
  const capped = candidates.slice(0, 30); // guard against oversized rerank payloads
  const heuristicOrder = () =>
    capped.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topN);

  if (!env.COHERE_API_KEY || capped.length <= 1) return heuristicOrder();

  try {
    const res = await fetch("https://api.cohere.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.COHERE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "rerank-multilingual-v3.0",
        query,
        documents: capped.map((c) => `${c.title}: ${c.text}`.slice(0, 1000)),
        top_n: Math.min(topN, capped.length),
      }),
    });
    if (!res.ok) throw new Error(`Cohere rerank failed (${res.status})`);

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return heuristicOrder();
    return results.map((r) => ({ ...capped[r.index], score: r.relevance_score }));
  } catch (e) {
    return heuristicOrder();
  }
}

/**
 * Grounded answer generation (Groq). Instructed to answer ONLY from the
 * numbered context block and to cite snippet numbers inline, and to say so
 * plainly rather than invent facts when the context is insufficient. Never
 * throws — degrades to a message pointing at the raw sources if
 * GROQ_API_KEY is missing or the call fails.
 */
async function answerWithLLM(query, contextBlock, env) {
  if (!env.GROQ_API_KEY) {
    return "I found relevant information below, but I can't generate a written answer right now (GROQ_API_KEY not configured on the server) — see the numbered sources for the raw matches.";
  }

  const systemPrompt = `You are Chakudya AI, a grounded nutrition assistant for Malawi's Chakudya Nutrition Registry. Answer ONLY using the numbered context snippets provided by the user. Cite the snippet number(s) you used inline in square brackets, e.g. [1] or [2][3]. If the snippets don't contain enough information to answer confidently, say so plainly instead of guessing — do not invent nutrient values, brand details, or clinical guidance that isn't in the context. Keep answers concise and clinically accurate for a Malawian dietetics context.`;
  const userPrompt = `Context:\n${contextBlock}\n\nQuestion: ${query}`;

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
        max_completion_tokens: 500,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return `(LLM answer unavailable: ${e.error?.message || res.status}) — see the numbered sources below.`;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "(Empty response from the LLM — see the numbered sources below.)";
  } catch (e) {
    return `(LLM answer unavailable: ${e.message}) — see the numbered sources below.`;
  }
}

/**
 * POST /rag/ask — the orchestrator itself. Body: { query (required),
 * context ("clinical"|"general"|"both", default "both"), top_k (default 6,
 * capped 10), session_id (optional — pulls in session memory as extra
 * context) }.
 */
async function handleRagAsk(request, url, db, env, ctx, body) {
  const { query, context = "both", top_k = 6, session_id = null } = body || {};

  if (!query || !String(query).trim()) return err("'query' is required");

  const VALID_CONTEXTS = ["clinical", "general", "both"];
  if (!VALID_CONTEXTS.includes(context)) {
    return err(`'context' must be one of: ${VALID_CONTEXTS.join(", ")} (got "${context}")`);
  }

  const cappedTopK = Math.min(Math.max(parseInt(top_k, 10) || 6, 1), 10);
  const trimmedQuery = String(query).trim();

  // Whole-answer cache — skipped whenever session_id is present, since the
  // memory-personalized answer for one session shouldn't be served back to
  // a different session asking the same surface-level question.
  const cacheKeyParts = ["ask", context, String(cappedTopK), normalizeQueryText(trimmedQuery)];
  if (!session_id) {
    const cached = await getQueryCache(env, "askcache", cacheKeyParts);
    if (cached) return success(cached, { query: trimmedQuery, context, cache: "HIT" });
  }

  // ── 1. Intent Detection ──────────────────────────────────────────────────
  const { intent, barcode: detectedBarcode } = await classifyIntent(trimmedQuery, env);
  const barcode = extractBarcode(trimmedQuery) || detectedBarcode || null;
  const plan = INTENT_SOURCE_PLAN[intent] || INTENT_SOURCE_PLAN.food_search;
  const keywords = extractKeywords(trimmedQuery);

  // ── 2. Search Orchestrator — fan out across every source the intent plan calls for ──
  const tasks = {};
  if (plan.semantic) tasks.semantic = semanticSearchForAsk(trimmedQuery, context, cappedTopK, db, env, ctx);
  if (plan.foods) tasks.foods = searchFoodsExact(db, trimmedQuery);
  if (plan.packaged) tasks.packaged = searchPackagedExact(db, trimmedQuery);
  if (plan.exchange) tasks.exchange = scanTableByKeywords(db, "exchange_lists", keywords);
  if (plan.renal) tasks.renal = scanTableByKeywords(db, "renal_foods", keywords);
  if (plan.formulas) tasks.formulas = scanTableByKeywords(db, "enteral_formulas", keywords);
  if (barcode) tasks.barcode = lookupFoodCascade(db, { query: "", barcode }, env);

  const taskKeys = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const results = {};
  taskKeys.forEach((key, i) => {
    results[key] = settled[i].status === "fulfilled" ? settled[i].value : null;
  });

  // USDA FDC / Open Food Facts / FatSecret fallback (via the existing
  // lookupFoodCascade cascade) — only fires when every local structured
  // source came back empty, to avoid burning external API quota on queries
  // the local registry already answers.
  const hasLocalFoodHits =
    (results.foods?.length || 0) > 0 || (results.packaged?.length || 0) > 0 || !!results.barcode;
  if (plan.externalFallback && !hasLocalFoodHits && !barcode) {
    try {
      results.external = await lookupFoodCascade(db, { query: trimmedQuery, barcode: "" }, env);
    } catch (e) {
      results.external = null;
    }
  }

  // ── 3. Optional session memory tie-in (Write → Consolidate → Recall → Apply) ──
  let memoryRows = [];
  if (session_id && results.semantic?.embedding) {
    try {
      const { ok, body: rows } = await db.rpc("match_memory", {
        query_embedding: results.semantic.embedding,
        match_session_id: session_id,
        match_count: 3,
      });
      if (ok && Array.isArray(rows)) memoryRows = rows;
    } catch (e) {
      // Session memory is a bonus, not a required source — fail silently.
    }
  }

  // ── 4. Assemble candidates from every source that returned something ────
  const candidates = [];

  for (const chunk of results.semantic?.chunks || []) {
    candidates.push({
      source: "knowledge_base",
      title: chunk.source || "Reference note",
      text: chunk.content || "",
      score: typeof chunk.similarity === "number" ? chunk.similarity : null,
    });
  }
  for (const row of results.foods || []) {
    candidates.push({ source: "malawi_fct", title: row.food_name || "Food", text: rowToText(row), score: null });
  }
  for (const row of results.packaged || []) {
    candidates.push({ source: "packaged_foods", title: row.product_name || "Packaged food", text: rowToText(row), score: null });
  }
  for (const { row } of results.exchange || []) {
    candidates.push({ source: "diabetes_exchange", title: row.food_item || row.food_name || row.name || "Exchange item", text: rowToText(row), score: null });
  }
  for (const { row } of results.renal || []) {
    candidates.push({ source: "renal_exchange", title: row.food_item || row.food_name || row.name || "Renal food", text: rowToText(row), score: null });
  }
  for (const { row } of results.formulas || []) {
    candidates.push({ source: "enteral_formula", title: row.formula_name || row.name || "Formula", text: rowToText(row), score: null });
  }
  if (results.barcode) {
    candidates.push({
      source: `barcode_${results.barcode.source}`,
      title: results.barcode.food?.food_name || results.barcode.food?.product_name || "Barcode match",
      text: rowToText(results.barcode.food),
      score: 1,
    });
  }
  if (results.external) {
    candidates.push({
      source: `external_${results.external.source}`,
      title: results.external.food?.food_name || results.external.food?.product_name || "External match",
      text: rowToText(results.external.food),
      score: 0.9,
    });
  }
  for (const row of memoryRows) {
    candidates.push({ source: "session_memory", title: "Session context", text: row.content || "", score: 1 });
  }

  if (!candidates.length) {
    return success(
      {
        answer:
          "I couldn't find anything in the Chakudya registry or connected sources for that — could you rephrase, or add more detail (e.g. the food name, brand, or barcode)?",
        intent,
        barcode_detected: barcode,
        sources: [],
      },
      { query: trimmedQuery, context, cache: "MISS" }
    );
  }

  // ── 5. Rerank ─────────────────────────────────────────────────────────────
  const ranked = await rerankCandidates(trimmedQuery, candidates, env, cappedTopK);

  // ── 6. Build Context ──────────────────────────────────────────────────────
  const contextBlock = ranked
    .map((c, i) => `[${i + 1}] (${c.source}: ${c.title})\n${c.text}`)
    .join("\n\n")
    .slice(0, 6000);

  // ── 7. LLM answer, grounded + cited ──────────────────────────────────────
  const answer = await answerWithLLM(trimmedQuery, contextBlock, env);

  const payload = {
    answer,
    intent,
    barcode_detected: barcode,
    sources: ranked.map((c, i) => ({ id: i + 1, source: c.source, title: c.title })),
  };

  if (!session_id) {
    putQueryCache(env, ctx, "askcache", cacheKeyParts, payload, ASK_CACHE_TTL_SECONDS);
  }

  return success(payload, { query: trimmedQuery, context, cache: "MISS" });
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

async function handleMemory(request, url, db, env, param, ctx) {
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

  // ── POST /memory/recall (preferred) or GET /memory/recall?session_id=...&query=...&top_k=5 (legacy) ──
  // POST is preferred because session_id and query text are clinical-context
  // data — as GET query-string params they'd otherwise land in Cloudflare
  // access logs, browser history, and any intermediate proxy. GET is kept
  // working so existing clients don't break; migrate them to POST when convenient.
  if (param === "recall" && (request.method === "POST" || request.method === "GET")) {
    let sessionId, query, topK;
    if (request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return err("Request body required");
      sessionId = body.session_id || "";
      query = body.query || "";
      topK = typeof body.top_k === "number" ? body.top_k : 5;
    } else {
      sessionId = url.searchParams.get("session_id") || "";
      query = url.searchParams.get("query") || "";
      topK = intParam(url, "top_k", 5);
    }
    if (!sessionId) return err("'session_id' is required");
    if (!query) return err("'query' is required");

    const cappedTopK = Math.min(topK, 20);

    // Cache key includes session_id so one patient's recall can never be
    // served from another session's cache entry. Short TTL (2 min) because
    // a session's facts can change mid-conversation via /memory/write —
    // this is only meant to absorb rapid repeat/near-repeat recalls within
    // the same short window, not to serve stale clinical context.
    const cacheKeyParts = ["memory", sessionId, String(cappedTopK), normalizeQueryText(query)];
    const cached = await getQueryCache(env, "memcache", cacheKeyParts);
    if (cached) {
      return success(cached.rows, {
        session_id: sessionId,
        query,
        count: cached.rows.length,
        cache: "HIT",
      });
    }

    let queryEmbedding;
    try {
      queryEmbedding = await embedText(query, env, "search_query");
    } catch (e) {
      return err(`Embedding failed: ${e.message}`, 502);
    }

    const { ok, status, body: rows } = await db.rpc("match_memory", {
      query_embedding: queryEmbedding,
      match_session_id: sessionId,
      match_count: cappedTopK,
    });
    if (!ok) return err(rows?.message || "Recall failed", status);

    const rowList = Array.isArray(rows) ? rows : [];
    putQueryCache(env, ctx, "memcache", cacheKeyParts, { rows: rowList }, MEMORY_RECALL_CACHE_TTL_SECONDS);

    return success(rowList, {
      session_id: sessionId,
      query,
      count: rowList.length,
      cache: "MISS",
    });
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

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
//
// GET /health — pings the required upstream services in parallel (Supabase,
// Cohere, Groq) and reports each one's status plus an overall
// healthy/degraded verdict. Meant to answer "which upstream broke?" in one
// request instead of guessing from a generic 500 on whatever route failed.
// Optional integrations (USDA FDC, FatSecret, the rate-limit/query-cache KV)
// are reported as configured/bound or not, without a network call — they
// don't affect the overall verdict since the rest of the API works without
// them (see the "Optional" env var list in the README).

/** Fetch with a timeout, so one hung upstream can't hang the whole health check. */
async function pingWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { ok: res.ok, httpStatus: res.status };
  } catch (e) {
    return { ok: false, httpStatus: null, error: e.name === "AbortError" ? "Timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSupabase(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return { status: "not_configured" };
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/foods?select=id&limit=1`;
  const res = await pingWithTimeout(url, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  });
  return res.ok ? { status: "ok" } : { status: "error", detail: res.error || `HTTP ${res.httpStatus}` };
}

async function checkCohere(env) {
  if (!env.COHERE_API_KEY) return { status: "not_configured" };
  const res = await pingWithTimeout("https://api.cohere.com/v1/models?page_size=1", {
    headers: { Authorization: `Bearer ${env.COHERE_API_KEY}` },
  });
  return res.ok ? { status: "ok" } : { status: "error", detail: res.error || `HTTP ${res.httpStatus}` };
}

async function checkGroq(env) {
  if (!env.GROQ_API_KEY) return { status: "not_configured" };
  // OpenAI-compatible /models endpoint — lists available models, no
  // completion tokens billed, cheapest possible liveness check.
  const res = await pingWithTimeout("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
  });
  return res.ok ? { status: "ok" } : { status: "error", detail: res.error || `HTTP ${res.httpStatus}` };
}

async function handleHealth(request, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const [supabase_, cohere_, groq_] = await Promise.all([
    checkSupabase(env),
    checkCohere(env),
    checkGroq(env),
  ]);

  const services = {
    supabase: supabase_,
    cohere: cohere_,
    groq: groq_,
    // Optional integrations — configuration/binding presence only, no
    // network call (FatSecret in particular needs a signed OAuth request,
    // not a simple ping; not worth the complexity for a health check).
    usda_fdc: { status: env.USDA_FDC_API_KEY ? "configured" : "not_configured" },
    fatsecret: {
      status: env.FATSECRET_CONSUMER_KEY && env.FATSECRET_CONSUMER_SECRET ? "configured" : "not_configured",
    },
    rate_limit_kv: { status: env.RATE_LIMIT_KV ? "bound" : "not_bound" },
  };

  // Only the three required upstreams affect the overall verdict — the
  // optional ones are visibility-only, matching how the rest of the API
  // already treats them (it degrades gracefully without them, see README).
  const degraded = [supabase_, cohere_, groq_].some((s) => s.status === "error");

  return json(
    {
      status: degraded ? "degraded" : "healthy",
      version: CNR_VERSION,
      checked_at: new Date().toISOString(),
      services,
    },
    degraded ? 503 : 200
  );
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

// GET /
function handleRoot(env) {
  return success({
    name: "Chakudya Nutrition Registry (CNR)",
    tagline: "Malawi's first open Food & Nutrition Database",
    version: CNR_VERSION,
    maintainer: "Edison Taimu",
    auth: "Write operations (POST/PUT/PATCH/DELETE) require 'Authorization: Bearer <admin key>', except POST /packaged/submit, POST /packaged/scan, POST /rag/retrieve, POST /rag/ask, POST /memory/write, and GET /memory/recall, which are public but rate-limited.",
    // Rate limiting and the RAG/memory query cache both fail OPEN (silently)
    // if RATE_LIMIT_KV isn't bound — meaning the API keeps working but with
    // no rate limiting and no caching, and nothing else would tell you that.
    // Check this flag after any deploy or dashboard binding change instead
    // of finding out the hard way via a manual MISS/HIT test cycle.
    kv_bound: !!env?.RATE_LIMIT_KV,
    endpoints: {
      health: [
        "GET  /health           (public, rate-limited) → pings Supabase/Cohere/Groq in parallel, reports per-service status + overall healthy/degraded",
      ],
      admin_keys: [
        "GET    /admin/keys       (root key only) → list keys (never returns the raw key or its hash)",
        "POST   /admin/keys       (root key only) → body {label, role?}; role: admin (default, full access) | reviewer (packaged review + reads only); returns the raw key ONCE, store it now",
        "DELETE /admin/keys/:id   (root key only) → revoke (soft — sets revoked_at, doesn't delete the row)",
      ],
      foods: [
        "GET  /foods",
        "GET  /foods/:id",
        "POST /foods            (admin)",
        "POST /foods/bulk       (admin) → body {items:[...]}, max 500, batch insert in one request",
        "PUT  /foods/:id        (admin)",
        "PATCH /foods/:id       (admin)",
        "DELETE /foods/:id      (admin)",
      ],
      exchange_lists: [
        "GET  /exchange",
        "POST /exchange         (admin)",
        "POST /exchange/bulk    (admin) → body {items:[...]}, max 500",
        "PUT  /exchange/:id     (admin)",
        "PATCH /exchange/:id    (admin)",
        "DELETE /exchange/:id   (admin)",
      ],
      renal: [
        "GET  /renal",
        "POST /renal            (admin)",
        "POST /renal/bulk       (admin) → body {items:[...]}, max 500",
        "PUT  /renal/:id        (admin)",
        "PATCH /renal/:id       (admin)",
        "DELETE /renal/:id      (admin)",
      ],
      enteral_formulas: [
        "GET  /formulas",
        "POST /formulas         (admin)",
        "POST /formulas/bulk    (admin) → body {items:[...]}, max 500",
        "PUT  /formulas/:id     (admin)",
        "PATCH /formulas/:id    (admin)",
        "DELETE /formulas/:id   (admin)",
      ],
      packaged_foods: [
        "GET  /packaged",
        "GET  /packaged/pending          (admin) → review queue (filters: source, limit, offset)",
        "POST /packaged/submit           (public, rate-limited — community contribution, status=pending)",
        "POST /packaged/scan             (public, rate-limited — photo of nutrition label -> OCR/AI -> status=pending)",
        "POST /packaged/:id/approve      (admin) → status=approved (optional body = field corrections)",
        "POST /packaged/:id/reject       (admin) → status=rejected (body requires 'reason')",
        "PUT  /packaged/:id              (admin)",
        "PATCH /packaged/:id             (admin)",
        "DELETE /packaged/:id            (admin)",
      ],
      rag: [
        "POST /rag/retrieve     (public, rate-limited) → semantic search (query, context, top_k)",
        "POST /rag/ingest       (admin) → add document chunk (content, source, context)",
        "POST /rag/ask          (public, rate-limited) → RAG Search Orchestrator: intent detection -> fan-out search (semantic + Malawi FCT + packaged/OCR foods + exchange/renal/formula DBs + barcode + USDA/OFF/FatSecret fallback) -> rerank -> grounded LLM answer with citations (query, context, top_k, session_id)",
      ],
      memory: [
        "POST /memory/write        (public, rate-limited) → capture a session fact (session_id, content)",
        "POST /memory/recall       (public, rate-limited) → top-K relevant memory for a session (session_id, query, top_k) — preferred; GET with the same params still works but is deprecated since it puts clinical text in the URL/logs",
        "POST /memory/consolidate  (admin) → summarize a session's facts (session_id) — also run hourly by cron",
      ],
      favorites: [
        "GET    /favorites?user_id=...&resource_type=...   (public, rate-limited)",
        "POST   /favorites   (public, rate-limited) → body {user_id, resource_type, resource_id}, idempotent",
        "DELETE /favorites   (public, rate-limited) → body {user_id, resource_type, resource_id}",
      ],
      history: [
        "GET  /history?user_id=...&resource_type=...   (public, rate-limited) → recently viewed, viewed_at desc",
        "POST /history   (public, rate-limited) → body {user_id, resource_type, resource_id}, upserts viewed_at",
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

    const search = url.searchParams.get("search") || "";
    const category = url.searchParams.get("category") || "";

    const filters = {};
    if (category) filters["category"] = `eq.${category}`;
    if (search) filters["food_name"] = `ilike.*${escapeLikePattern(search)}*`;

    return await paginatedList(db, "foods", url, { filters, order: "food_name.asc" });
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
    const type = url.searchParams.get("type") || "";
    const filters = {};
    if (type) filters["exchange_type"] = `eq.${type}`;

    return await paginatedList(db, "exchange_lists", url, { filters });
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
    return await paginatedList(db, "renal_foods", url);
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
    const route = url.searchParams.get("route") || "";
    const filters = {};
    if (route) filters["route"] = `eq.${route}`;

    return await paginatedList(db, "enteral_formulas", url, { filters });
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

  // packaged_foods.barcode has a UNIQUE constraint, so — same as
  // /packaged/submit — a duplicate must be caught BEFORE attempting an
  // insert, not handled by linking two rows together after the fact.
  const duplicate = await findDuplicateByBarcode(db, data.barcode);

  if (duplicate && duplicate.status !== "rejected") {
    return json(
      {
        status: "success",
        message:
          `This barcode already has a ${duplicate.status} entry ` +
          `("${duplicate.product_name}", id ${duplicate.id}) — not submitting a duplicate.`,
        already_exists: true,
        data: duplicate,
      },
      409
    );
  }

  const macroCheck = checkMacrosMatchCalories(data);

  // A previously-rejected row already owns this barcode — overwrite it
  // (reset to pending, clear the old review trail) instead of inserting,
  // since a second row for the same barcode is impossible.
  const { ok, status, body } = duplicate
    ? await db.update(
        "packaged_foods",
        duplicate.id,
        { ...data, reviewed_at: null, reviewed_by: null, rejection_reason: null },
        "PATCH"
      )
    : await db.insert("packaged_foods", data);
  if (!ok) return err(body?.message || "Submit failed", status);

  const lowConfidence = data.ai_confidence != null && data.ai_confidence < 0.6;
  const macroMismatch = macroCheck.checked && !macroCheck.matches;
  const needsReview = lowConfidence || macroMismatch;

  let message;
  if (duplicate) {
    message =
      "Resubmitted for review (a previous submission with this barcode was rejected)." +
      (lowConfidence ? " Scan confidence was also low." : "") +
      (macroMismatch ? " Declared calories don't closely match protein/carbs/fat either." : "");
  } else if (lowConfidence && macroMismatch) {
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
    resubmission_of_rejected: duplicate ? duplicate.id : undefined,
  });
}

// ── /packaged ─────────────────────────────────────────────────────────────────

async function handlePackaged(request, url, db, id, isSubmit) {
  const method = request.method;

  if (method === "GET") {
    const barcode = url.searchParams.get("barcode") || "";
    const filters = {};
    if (barcode) filters["barcode"] = `eq.${barcode}`;

    return await paginatedList(db, "packaged_foods", url, { filters });
  }

  // POST /packaged/submit — public community contribution
  if (method === "POST" && isSubmit) {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    if (!payload.barcode) return err("'barcode' is required");
    if (!payload.product_name) return err("'product_name' is required");

    // packaged_foods.barcode has a UNIQUE constraint (a second row for the
    // same barcode is impossible at the DB level, regardless of status), so
    // duplicates must be handled BEFORE attempting an insert, not after.
    const duplicate = await findDuplicateByBarcode(db, payload.barcode);

    // An approved or still-pending match already occupies this barcode —
    // don't attempt an insert (it would just fail the unique constraint).
    // Return the existing entry so the client can show it immediately.
    if (duplicate && duplicate.status !== "rejected") {
      return json(
        {
          status: "success",
          message:
            `This barcode already has a ${duplicate.status} entry ` +
            `("${duplicate.product_name}", id ${duplicate.id}) — not submitting a duplicate.`,
          already_exists: true,
          data: duplicate,
        },
        409
      );
    }

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

    // A previously-rejected row already owns this barcode — since a second
    // row can't be inserted, resubmission means overwriting that row (reset
    // to pending, clear the old review trail) rather than an insert.
    const { ok, status, body } = duplicate
      ? await db.update(
          "packaged_foods",
          duplicate.id,
          { ...data, reviewed_at: null, reviewed_by: null, rejection_reason: null },
          "PATCH"
        )
      : await db.insert("packaged_foods", data);
    if (!ok) return err(body?.message || "Submit failed", status);

    const macroMismatch = macroCheck.checked && !macroCheck.matches;
    let message;
    if (duplicate) {
      message = "Packaged food resubmitted for review (a previous submission with this barcode was rejected).";
    } else if (macroMismatch) {
      message =
        `Packaged food submitted for review — declared calories (${macroCheck.declared_kcal} kcal) don't closely ` +
        `match protein/carbs/fat (~${macroCheck.calculated_kcal} kcal calculated). Please double-check the label.`;
    } else {
      message = "Packaged food submitted for review";
    }

    return success(body, {
      message,
      needs_review: macroMismatch,
      macro_check: macroCheck.checked ? macroCheck : undefined,
      resubmission_of_rejected: duplicate ? duplicate.id : undefined,
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

// ── /packaged/pending, /packaged/:id/approve, /packaged/:id/reject ───────────
// Admin review queue for community (POST /packaged/submit) and OCR
// (POST /packaged/scan) submissions, both of which land as status="pending".
// Closes the loop those two endpoints leave open: before this, moving a row
// out of "pending" required editing Supabase directly.
//
// Requires these additional (nullable) columns on packaged_foods:
//   alter table packaged_foods add column if not exists reviewed_at timestamptz;
//   alter table packaged_foods add column if not exists reviewed_by text;
//   alter table packaged_foods add column if not exists rejection_reason text;
//
// Duplicate handling relies on packaged_foods.barcode already having a
// UNIQUE constraint (confirmed in production — a second row for the same
// barcode is rejected by Postgres regardless of status). Because of that,
// /packaged/submit and /packaged/scan check for an existing row BEFORE
// inserting: an approved/pending match blocks the new submission outright
// (409, existing row returned as-is); a rejected match is overwritten in
// place (reset to pending) rather than inserted as a second row.

/** GET /packaged/pending (admin) — the review queue, oldest first (FIFO). */
async function handlePackagedPending(request, url, db) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const limit = limitParam(url);
  const offset = intParam(url, "offset", 0);
  const source = url.searchParams.get("source") || ""; // "manual" | "ocr_ai"

  const filters = { status: "eq.pending" };
  if (source) filters["source"] = `eq.${source}`;

  const { ok, status, body, total } = await db.select("packaged_foods", {
    filters,
    limit,
    offset,
    order: "submitted_at.asc",
  });
  if (!ok) return err(body?.message || "Query failed", status);
  return listSuccess(body, { count: total, limit, offset });
}

/**
 * POST /packaged/:id/approve (admin) — moves a row from "pending" to
 * "approved". Accepts an optional JSON body of field corrections (e.g. a
 * mis-read `energy_kcal`) applied in the same update, so a reviewer doesn't
 * need a separate PATCH call first. `status`/`reviewed_at`/`reviewed_by`
 * in the body, if present, are ignored — those are always server-set.
 */
async function handlePackagedApprove(request, db, id, admin) {
  if (!id) return err("ID required for this method");

  const payload = (await parseBody(request)) || {};
  const { status: _status, reviewed_at: _reviewedAt, reviewed_by: _reviewedBy, ...corrections } = payload;

  const data = {
    ...corrections,
    status: "approved",
    reviewed_at: new Date().toISOString(),
    // Per-consumer API keys (see /admin/keys) resolve to a label that's
    // used here automatically — reviewed_by only falls back to an
    // explicit body override or "admin" when the request used the shared
    // root key, which has no per-caller identity of its own.
    reviewed_by:
      typeof payload.reviewed_by === "string" && payload.reviewed_by.trim()
        ? payload.reviewed_by.trim()
        : admin?.label || "admin",
  };

  const { ok, status, body } = await db.update("packaged_foods", id, data, "PATCH");
  if (!ok) return err(body?.message || "Approve failed", status);
  if (!body) return notFound("Packaged food");
  return success(body, { message: `Packaged food ${id} approved` });
}

/**
 * POST /packaged/:id/reject (admin) — moves a row from "pending" to
 * "rejected". Requires a `reason` so there's an audit trail (and something
 * to eventually show the submitter, if/when submissions get attributed to
 * a user rather than just an IP).
 */
async function handlePackagedReject(request, db, id, admin) {
  if (!id) return err("ID required for this method");

  const payload = await parseBody(request);
  const reason = (payload?.reason || "").trim();
  if (!reason) return err("'reason' is required to reject a submission");

  const data = {
    status: "rejected",
    reviewed_at: new Date().toISOString(),
    reviewed_by:
      typeof payload.reviewed_by === "string" && payload.reviewed_by.trim()
        ? payload.reviewed_by.trim()
        : admin?.label || "admin",
    rejection_reason: reason,
  };

  const { ok, status, body } = await db.update("packaged_foods", id, data, "PATCH");
  if (!ok) return err(body?.message || "Reject failed", status);
  if (!body) return notFound("Packaged food");
  return success(body, { message: `Packaged food ${id} rejected` });
}

// ─── /admin/keys ─────────────────────────────────────────────────────────────
//
// Per-consumer admin API keys, so different integrations/reviewers don't
// all share env.ADMIN_API_KEY (the "root" key). Root-only to manage (see
// the isRoot check in router()) — a leaked per-consumer key can read/write
// only what its role permits, and can never mint or revoke other keys.
//
// Each key has a role — "admin" (full access, the default) or "reviewer"
// (packaged review queue + reads only — see ROLE_RANK and the requiredRole
// checks in routePolicy()/router()).
//
// Requires this table (raw keys are never stored — only their hash):
//   create table if not exists api_keys (
//     id bigint generated always as identity primary key,
//     key_hash text not null unique,
//     label text not null,
//     role text not null default 'admin',
//     created_at timestamptz not null default now(),
//     last_used_at timestamptz,
//     revoked_at timestamptz
//   );
//
// If api_keys already exists from before roles were added, migrate with:
//   alter table api_keys add column if not exists role text not null default 'admin';

/** Generates a random, high-entropy raw API key (256 bits, hex-encoded). */
function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cnr_${hex}`;
}

async function handleAdminKeys(request, db, idOrAction) {
  const method = request.method;

  if (method === "GET") {
    // Never returns key_hash — only what's needed to identify/audit a key.
    const { ok, status, body } = await db.select("api_keys", {
      filters: {},
      order: "created_at.desc",
      limit: 200,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const rows = (Array.isArray(body) ? body : []).map(({ key_hash, ...rest }) => rest);
    return success(rows);
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    const label = (payload?.label || "").trim();
    if (!label) return err("'label' is required (e.g. a reviewer's name or integration name)");

    const role = payload?.role ? String(payload.role).trim() : "admin";
    if (!VALID_ROLES.includes(role)) {
      return err(`'role' must be one of: ${VALID_ROLES.join(", ")} (got "${role}")`);
    }

    const rawKey = generateApiKey();
    const hash = await sha256Hex(rawKey);

    const { ok, status, body } = await db.insert("api_keys", { key_hash: hash, label, role });
    if (!ok) return err(body?.message || "Key creation failed", status);

    const { key_hash: _hash, ...safeRow } = body || {};

    return success(safeRow, {
      message: "API key created — save this now, it will not be shown again",
      key: rawKey,
    });
  }

  if (method === "DELETE") {
    if (!idOrAction) return err("Key id required, e.g. DELETE /admin/keys/5");
    const { ok, status, body } = await db.update(
      "api_keys",
      idOrAction,
      { revoked_at: new Date().toISOString() },
      "PATCH"
    );
    if (!ok) return err(body?.message || "Revoke failed", status);
    if (!body) return notFound("API key");
    const { key_hash: _hash, ...safeRow } = body;
    return success(safeRow, { message: `API key ${idOrAction} revoked` });
  }

  return err("Method not allowed", 405);
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

/**
 * Dispatches to the actual resource handler. Pulled out of router() so the
 * edge-cache wrapper can call it uniformly whether or not a cache policy
 * applies to the route.
 */
async function dispatch(request, url, db, env, resource, param, ctx, action, admin) {
  switch (resource) {
    case "health": {
      return await handleHealth(request, env);
    }

    case "admin": {
      if (param === "keys") {
        return await handleAdminKeys(request, db, action || null);
      }
      return notFound();
    }

    case "foods": {
      if (param === "lookup") {
        return await handleFoodsLookup(request, url, db, env);
      }
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "foods", { requiredField: "food_name", label: "foods" });
      }
      const id = param || null;
      return await handleFoods(request, url, db, id);
    }

    case "exchange": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "exchange_lists", { label: "exchange entries" });
      }
      const id = param || null;
      return await handleExchange(request, url, db, id);
    }

    case "renal": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "renal_foods", { label: "renal entries" });
      }
      const id = param || null;
      return await handleRenal(request, url, db, id);
    }

    case "formulas": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "enteral_formulas", { label: "formulas" });
      }
      const id = param || null;
      return await handleFormulas(request, url, db, id);
    }

    case "packaged": {
      if (param === "scan") {
        return await handlePackagedScan(request, env, db);
      }
      if (param === "pending") {
        return await handlePackagedPending(request, url, db);
      }
      if (action === "approve") {
        return await handlePackagedApprove(request, db, param, admin);
      }
      if (action === "reject") {
        return await handlePackagedReject(request, db, param, admin);
      }
      const isSubmit = param === "submit";
      const id = isSubmit ? null : param || null;
      return await handlePackaged(request, url, db, id, isSubmit);
    }

    case "rag": {
      return await handleRAG(request, url, db, env, param || null, ctx);
    }

    case "memory": {
      return await handleMemory(request, url, db, env, param || null, ctx);
    }

    case "favorites": {
      return await handleFavorites(request, url, db);
    }

    case "history": {
      return await handleHistory(request, url, db);
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

async function router(request, env, ctx, requestId) {
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
    return handleRoot(env);
  }

  const [resource, param, action] = segments;

  // ── Centralised auth + rate limit gate ─────────────────────────────────────
  const policy = routePolicy(resource, request.method, param, action);

  let admin = null;
  if (policy.auth === "admin") {
    admin = await isAdmin(request, env, db, ctx);
    if (!admin.valid) return unauthorized();

    // Managing other API keys is root-only — a per-consumer key can't
    // mint or revoke keys, so a single leaked non-root key can't escalate.
    if (resource === "admin" && param === "keys" && !admin.isRoot) {
      return unauthorized("Only the root admin key can manage API keys");
    }

    // Scoped roles — "reviewer" keys can only reach routes that opted into
    // requiredRole: "reviewer" (the packaged review queue); everything
    // else needs the default "admin" role. Root always passes regardless
    // of role, same as it bypasses the key-management check above.
    // Unknown/corrupt role values rank as 0 (fail closed — denied by
    // default) rather than comparing against `undefined`, which JS would
    // silently treat as passing (undefined < N is always false).
    const requiredRole = policy.requiredRole || "admin";
    const currentRank = ROLE_RANK[admin.role] || 0;
    if (!admin.isRoot && currentRank < ROLE_RANK[requiredRole]) {
      return unauthorized(`This action requires the '${requiredRole}' role (this key has '${admin.role}')`);
    }
  }

  const rateBucketKey =
    policy.rate.scope === "admin"
      ? `admin:${getBearerToken(request) || "unknown"}`
      : `ip:${clientIp(request)}:${resource || "root"}`;

  // Admin-authenticated requests are exempt from rate limiting — the admin
  // key itself is the access control; volume caps only apply to public routes.
  if (policy.auth !== "admin") {
    const { allowed, retryAfter } = await checkRateLimit(
      env,
      rateBucketKey,
      policy.rate.limit,
      policy.rate.windowSeconds
    );
    if (!allowed) return rateLimited(retryAfter);
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
    const response = await dispatch(request, url, db, env, resource, param, ctx, action, admin);

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
    return serverErr(e, requestId);
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

// ─── STRUCTURED LOGGING / REQUEST IDS ───────────────────────────────────────
//
// Every request gets a UUID (crypto.randomUUID(), available in the Workers
// runtime) that's:
//   - echoed back as the X-Request-Id response header, so a client (or you,
//     manually) can quote it back when reporting an issue
//   - included in the one structured JSON log line emitted per request via
//     console.log/console.error — filterable/greppable in `wrangler tail`
//     or the Cloudflare dashboard's Workers Logs, unlike the previous
//     unstructured console.error(e) calls scattered through the codebase
//   - included in the JSON body of 500 responses specifically (request_id
//     field), since that's the case most worth a support conversation
//
// Set env.DISABLE_REQUEST_LOGGING = "true" to skip the per-request info log
// (errors still always log) if request volume ever makes the log volume
// itself a cost/noise concern — off by default.

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);

    let response;
    try {
      response = await router(request, env, ctx, requestId);
    } catch (e) {
      response = serverErr(e, requestId);
    }

    const tagged = new Response(response.body, response);
    tagged.headers.set("X-Request-Id", requestId);

    if (env.DISABLE_REQUEST_LOGGING !== "true" || tagged.status >= 500) {
      const logFn = tagged.status >= 500 ? console.error : console.log;
      logFn(
        JSON.stringify({
          level: tagged.status >= 500 ? "error" : "info",
          request_id: requestId,
          method: request.method,
          path: url.pathname,
          status: tagged.status,
          duration_ms: Date.now() - startedAt,
          cache: tagged.headers.get("X-Cache") || undefined,
        })
      );
    }

    return tagged;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledConsolidation(env));
  },
};
