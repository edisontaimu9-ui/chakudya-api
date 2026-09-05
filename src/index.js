/**
 * Chakudya Nutrition Registry (CNR) — Malawi's First Open Food & Nutrition Database
 * Cloudflare Worker · Supabase REST backend (no SDK, pure fetch)
 * ---------------------------------------------------------------
 * Author : Edison Taimu 
 * Version: 1.21.1
 *
 * v1.21.1 changes:
 *  - Fixed a category-vocabulary mismatch that made Meal Analysis's
 *    food_groups_present/missing wrong: both buildServingSizes() (Tier 3
 *    fallback) and resolveIngredientsList() were preferring the food row's
 *    own `category` DB column over classifyCategory(food_name) when
 *    present. That column uses a different, coarser vocabulary (e.g.
 *    "Staples", "Baby Foods") than the Grains/Legumes/Protein/Vegetables/
 *    Fruits/Dairy taxonomy CATEGORY_SERVING_DEFAULTS/CORE_FOOD_GROUPS are
 *    actually built around — so nsima (DB category "Staples") matched
 *    neither, and got wrongly reported as "Grains" missing from a meal
 *    that clearly contained it; "Green beans" likewise came back as
 *    DB category "Vegetables" rather than the Legumes bucket the keyword
 *    taxonomy puts beans in. Both call sites now classify from the food
 *    name unconditionally via classifyCategory(), ignoring food.category.
 *    Verified: "Nsima (thick, maize)" -> Grains, "Green beans (raw)" ->
 *    Legumes.
 *
 * v1.21.0 changes:
 *  - Added Meal Analysis: POST /meals/analyze. Body {meal_type?,
 *    ingredients:[{food_id?|food_name, quantity, unit?}], daily_targets?}
 *    — same ingredient resolution as Recipe Nutrition Calculation (now
 *    factored into resolveIngredientsList(), shared by both endpoints; no
 *    behavior change to /recipes/calculate). Adds macronutrient_breakdown
 *    (kcal from protein/carbs/fat via Atwater 4/4/9, each as % of total,
 *    compared against the standard adult Institute of Medicine AMDR
 *    range), food_groups_present/food_groups_missing (against a core
 *    Grains/Legumes/Protein/Vegetables/Fruits/Dairy set, reusing
 *    classifyCategory()), and an opt-in daily_target_comparison — only
 *    included when the caller supplies daily_targets; this endpoint never
 *    infers a personalized target itself (that should come from a
 *    clinician or the calling app's own EER/macro calculation, e.g. the
 *    Harris-Benedict tools in chakudya-mcp-server). Everything returned is
 *    descriptive (what's in the meal, how it compares to a standard
 *    reference), not a recommendation. Public, rate-limited like
 *    /recipes/calculate.
 *
 * v1.20.4 changes:
 *  - Fixed pickBestFoodMatch()'s tiebreak: "shortest food_name wins" was
 *    too naive — "Rice pudding" (12 chars) is literally shorter than
 *    "Rice (cooked, white)" (21 chars), so "rice" was still resolving to
 *    the wrong dish after v1.20.3's word-boundary fix. Added a tier
 *    between word-boundary matching and the length tiebreak: prefer names
 *    where the matched word is immediately followed by a qualifier
 *    (parenthesis/comma/dash/slash/end-of-string) rather than straight
 *    into another bare word — that's what actually distinguishes
 *    "Rice (cooked, white)" or "Rice, brown, raw" (still just rice, with
 *    a qualifier) from "Rice pudding" or "Rice porridge" (a different
 *    dish that happens to start with the same word). Verified against the
 *    live rice/milk data. Known residual limitation: this still can't
 *    disambiguate raw vs. cooked when both qualify equally — pass food_id
 *    instead of food_name when that distinction matters.
 *
 * v1.20.3 changes:
 *  - Fixed Recipe Nutrition Calculation matching the wrong food for a
 *    plain ingredient name — e.g. "milk" was matching "Milk scones
 *    (Sikono ya mkaka)" and "rice" was matching "Rice porridge (Phala la
 *    mpunga)", since the ilike search just took whatever row came back
 *    first. Added pickBestFoodMatch(): now fetches up to 25 ilike
 *    candidates and ranks them (exact name match, then whole-word match,
 *    then shortest name as a proxy for "the plain ingredient" over a
 *    compound dish) before picking one. food_id lookups and the external
 *    lookupFoodCascade() fallback are unaffected.
 *
 * v1.20.2 changes:
 *  - Expanded GENERIC_UNIT_GRAMS (used by Recipe Nutrition Calculation's
 *    resolveIngredientGrams()) with fl oz, pint, quart, and gallon, and
 *    added a distinct fluid-ounce entry (floz/fl_oz/fluidounce, ~29.57mL)
 *    separate from the existing weight-ounce (oz/ounce, 28.35g) — the two
 *    are different quantities for non-water liquids and conflating them
 *    was a latent inaccuracy. Values cross-checked against the Nutrition
 *    Care Manual (NC Dietetic Association, 2011) equivalents/conversion
 *    tables; existing cup/Tbsp/tsp/oz/lb values already matched that
 *    reference exactly, so those are unchanged.
 *
 * v1.20.1 changes:
 *  - Fixed a data-trust bug in buildServingSizes()'s Tier 1 (the food's own
 *    FCT household measure): some `foods` rows have a `weight_g` that
 *    doesn't match the gram amount printed in `measure` (e.g. measure
 *    "1 cup / chikombe (240g)" but weight_g: 100 — weight_g looks
 *    defaulted to the 100g reference basis on a number of rows rather than
 *    actually recorded per measure). Now parses the gram amount out of
 *    `measure`'s own text first (extractGramsFromMeasureText()) and only
 *    falls back to weight_g when that parse fails. Fixes both Serving-Size
 *    Intelligence's serving_sizes[] and Recipe Nutrition Calculation's
 *    grams_basis/grams for any ingredient resolved via a food's FCT
 *    measure — both build on the same buildServingSizes(). No API shape
 *    change, just corrected numbers. The underlying weight_g column data
 *    itself is still worth a cleanup pass separately — this only changes
 *    which column the Worker trusts at read time.
 *
 * v1.20.0 changes:
 *  - Added Recipe Nutrition Calculation: POST /recipes/calculate. Body
 *    {servings?, ingredients:[{food_id?|food_name, quantity, unit?}]} —
 *    each ingredient is resolved to a food row (local `foods` table first,
 *    falling back to the same local→external lookupFoodCascade() used by
 *    /foods/lookup), its quantity/unit converted to grams via
 *    resolveIngredientGrams() (built on Serving-Size Intelligence's
 *    buildServingSizes(), so "2 cups rice" uses rice's own cup measure
 *    rather than a generic one), then nutrients are scaled and summed
 *    across the recipe. Returns total_nutrients, nutrients_per_serving
 *    (divided by `servings`, default 1), a per-ingredient breakdown, and
 *    unresolved_ingredients for anything that couldn't be matched or
 *    converted (never fails the whole request over one bad ingredient).
 *    No persistence — pure calculation on existing data. Public, rate-
 *    limited like /rag/ask since it can fan out to an external lookup per
 *    unresolved ingredient.
 *
 * v1.19.1 changes:
 *  - Extended Serving-Size Intelligence's ?with_servings=true to also work
 *    on the GET /foods list endpoint (was previously only GET /foods/:id
 *    and GET /foods/lookup), for both pagination modes (offset and
 *    cursor). Each row in `data` gets its own serving_sizes array, same
 *    tier logic as before. paginatedList() (shared with /exchange, /renal,
 *    /formulas, /products) now takes an optional `enrichRow` callback —
 *    undefined for every other caller, so nothing else changes.
 *
 * v1.19.0 changes:
 *  - Added Serving-Size Intelligence: GET /foods/:id and GET /foods/lookup
 *    now accept ?with_servings=true, which adds a `serving_sizes` array to
 *    the response — realistic Malawian household measures (e.g. "1 cup /
 *    chikombe (240g)", "1 chunk nsima (200g)", "1 sachet RUTF (92g)"), each
 *    with every nutrient field pre-scaled from the existing per-100g/100ml
 *    basis (that basis itself is unchanged — this is response-shaping only,
 *    no new columns, no migration). Three tiers, most specific first: the
 *    food's own FCT `measure`/`weight_g` if present, then a curated
 *    keyword match (SERVING_SIZE_KEYWORDS), then a generic per-category
 *    estimate (CATEGORY_SERVING_DEFAULTS) — the raw 100g/100ml basis is
 *    always included too, labeled "reference". Fully local/rule-based, no
 *    LLM call and no added latency; opt-in via the query param so existing
 *    consumers are unaffected. See buildServingSizes() and the block
 *    comment above it.
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
 * v1.18.0 changes:
 *  - FatSecret Premier features. The consumer key was upgraded to Premier
 *    Free tier, unlocking three previously-inaccessible methods:
 *     - Barcode lookup (food.find_id_for_barcode.v2) — added as a
 *       fallback in the /foods/lookup barcode cascade, after Open Food
 *       Facts. See fetchFromFatSecretBarcode() and pickFatSecretServing().
 *     - GET /foods/autocomplete?q=... (public, rate-limited) — wraps
 *       foods.autocomplete.v2.
 *     - GET /foods/categories (public, rate-limited, cached 24h) — wraps
 *       food_categories.get.v2.
 *    Both new endpoints return null (via their fetch helpers) rather than
 *    an error when FATSECRET_CONSUMER_KEY/SECRET aren't set, surfaced as
 *    a 503 — same "not configured, not broken" convention used elsewhere.
 *    Also documented /foods/lookup in the GET / endpoint map, which had
 *    been missing from it since it was added.
 *
 * v1.17.0 changes:
 *  - GET /health now also pings Open Food Facts (used for barcode lookups
 *    in /foods/lookup and /packaged/scan) — it was a real, actively-used
 *    dependency that was missing from the health check entirely. Unlike
 *    usda_fdc/fatsecret (which just report configured/not_configured,
 *    since checking them properly needs a signed request or an API key
 *    that may not be set), Open Food Facts is free/keyless, so it gets an
 *    actual live ping instead. Visibility-only, like the other two
 *    optional integrations — doesn't affect the overall healthy/degraded
 *    verdict. See checkOpenFoodFacts().
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
 *  - env.GROQ_TEXT_MODEL           (optional override for memory-consolidation summaries; defaults to openai/gpt-oss-120b)
 *
 * Session memory setup (NEW in v1.3.0):
 *  1. Run sql/memory_schema.sql in the Supabase SQL editor (creates
 *     `assistant_memory` table + `match_memory` / `sessions_needing_consolidation`
 *     RPC functions; requires the `vector` extension, already enabled for RAG).
 *  2. wrangler.toml now declares an hourly [triggers] cron — redeploy
 *     (`npx wrangler deploy`) for Cloudflare to register it; cron triggers
 *     aren't picked up by a dashboard-only Quick Edit save.
 */

import {
  DRI_LIFE_STAGES,
  DRI_NUTRIENT_META,
  DRI_VALUES,
  DRI_AMDR_BY_AGE_BUCKET,
  DRI_ADDITIONAL_MACRO_RECOMMENDATIONS,
  amdrBucketForAge,
  sodiumCdrrForAge,
  resolveDriLifeStage,
} from "./dri_data.js";

// ─── VERSION ─────────────────────────────────────────────────────────────────
// Single source of truth for the version reported by GET / (handleRoot).
// Bump this alongside the changelog comment at the top of this file — the two
// had drifted out of sync before (header said v1.4.0, GET / said v1.2.0).
const CNR_VERSION = "1.24.0";

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

/** Query-param truthiness for opt-in boolean flags like ?with_servings=true. */
function isTruthyParam(v) {
  return v === "true" || v === "1" || v === "yes";
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
  if (resource === "foods" && param === "categories") {
    return { ttl: 86400 }; // 24 hours — near-static reference data
  }
  if (resource === "foods" && param === "autocomplete") {
    return { ttl: 3600 }; // 1 hour — repeat partial-query lookups are common while typing
  }
  if (resource === "foods" && param === "substitutes") {
    return { ttl: 3600 }; // 1 hour — same reference-data reasoning as autocomplete
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
  const isRagDeleteSource = resource === "rag" && param === "source" && method === "DELETE";
  const isRagAsk = resource === "rag" && param === "ask" && method === "POST";
  const isFoodsLookup = resource === "foods" && param === "lookup" && method === "GET";
  const isFoodsAutocomplete = resource === "foods" && param === "autocomplete" && method === "GET";
  const isFoodsCategories = resource === "foods" && param === "categories" && method === "GET";
  const isFoodSubstitutes = resource === "foods" && param === "substitutes" && method === "GET";
  const isMemoryWrite = resource === "memory" && param === "write" && method === "POST";
  const isMemoryRecall = resource === "memory" && param === "recall" && (method === "GET" || method === "POST");
  const isMemoryConsolidate = resource === "memory" && param === "consolidate" && method === "POST";
  const isAdminKeys = resource === "admin" && param === "keys";
  const isBulkInsert =
    ["foods", "exchange", "renal", "formulas", "drug-interactions"].includes(resource) &&
    param === "bulk" &&
    method === "POST";
  const isFavorites = resource === "favorites";
  const isHistory = resource === "history";
  const isLog = resource === "log";
  const isRecipesCalculate = resource === "recipes" && param === "calculate" && method === "POST";
  const isMealsAnalyze = resource === "meals" && param === "analyze" && method === "POST";
  const isIngredientsParse = resource === "ingredients" && param === "parse" && method === "POST";
  const isDri = resource === "dri";
  const isDrugInteractionsSearch =
    resource === "drug-interactions" && param === "search" && method === "GET";

  // Favorites/history — no admin gate (same public, self-declared-identity
  // model as memory/write and memory/recall: the client supplies its own
  // user_id, there's no server-side account system). Writes capped tighter
  // than reads.
  if (isFavorites || isHistory) {
    return isWrite
      ? { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } }
      : { auth: "public", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Food log (nutrition diary) — same public, self-declared-identity model
  // as favorites/history above. Writes (log a meal, delete an entry) capped
  // tighter than reads; /log/summary is a read.
  if (isLog) {
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

  // Autocomplete — a type-ahead UX fires one request per keystroke pause,
  // so this needs more headroom than a single lookup, but each hit still
  // costs a FatSecret Premier call, hence not as generous as plain reads.
  if (isFoodsAutocomplete) {
    return { auth: "public", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
  }

  // Categories — near-static reference data, heavily cached at the edge
  // (see cachePolicy), so the rate limit mostly just protects cache misses.
  if (isFoodsCategories) {
    return { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
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

  // Bulk-delete all chunks for one document (by 'source' string) — admin
  // only. Needed before re-ingesting a document whose chunks were extracted
  // badly (e.g. table/scanned pages ingested before the extraction fix),
  // since /rag/ingest only ever inserts and never overwrites.
  if (isRagDeleteSource) {
    return { auth: "admin", rate: { limit: 30, windowSeconds: 60, scope: "admin" } };
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

  // Recipe nutrition calculation — no persistence, but fans out a DB lookup
  // (and possibly an external cascade call) per ingredient, so it needs a
  // real cap rather than the generous plain-read default. Same cost class
  // as /rag/ask.
  if (isRecipesCalculate || isMealsAnalyze) {
    return { auth: "public", rate: { limit: 15, windowSeconds: 60, scope: "ip" } };
  }

  // Ingredient text parsing — costs a Groq call per request (same cost
  // class as recipes/meals above), no persistence.
  if (isIngredientsParse) {
    return { auth: "public", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // DRI lookup/compare — pure in-memory computation, no DB or LLM call at
  // all, so it gets the generous plain-read allowance even for the POST
  // /dri/compare endpoint.
  if (isDri) {
    return { auth: "public", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Drug-interaction keyword search — same cost class as the exchange/renal
  // keyword scans /rag/ask already runs internally (a full-table scan
  // capped by scan_limit), so it gets its own moderate cap rather than the
  // generous plain-read default.
  if (isDrugInteractionsSearch) {
    return { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // Food substitutes — fans out one ilike query per keyword in the matched
  // substitution group (multiKeywordFoodSearch), same cost class as the
  // scans above.
  if (isFoodSubstitutes) {
    return { auth: "public", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // All other writes (foods/exchange/renal/formulas/drug-interactions/packaged CRUD): admin only.
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
async function paginatedList(db, table, url, { filters = {}, order, enrichRow } = {}) {
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
      data: enrichRow ? page.map(enrichRow) : page,
    });
  }

  const offset = intParam(url, "offset", 0);
  const { ok, status, body, total } = await db.select(table, { filters, limit, offset, order });
  if (!ok) return err(body?.message || "Query failed", status);
  const rows = enrichRow && Array.isArray(body) ? body.map(enrichRow) : body;
  return listSuccess(rows, { count: total, limit, offset });
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

// ─── FOOD LOG (NUTRITION DIARY) ──────────────────────────────────────────────
//
// Same public, self-declared-identity model as favorites/history: no
// server-side account system, the client generates and keeps its own
// user_id and passes it on every call.
//
// Each row is one logged item under one of the four meal slots
// (breakfast/lunch/snack/dinner) with its calorie count for a given day.
// GET /log/summary aggregates those rows into a daily or weekly total —
// callers don't need to fetch every row and sum client-side.
//
// Requires this table:
//   create table if not exists food_log_entries (
//     id bigint generated always as identity primary key,
//     user_id text not null,
//     entry_date date not null default current_date,
//     meal_type text not null check (meal_type in ('breakfast','lunch','snack','dinner')),
//     food_name text,
//     calories numeric not null check (calories >= 0),
//     created_at timestamptz not null default now()
//   );
//   create index if not exists food_log_entries_user_date_idx on food_log_entries(user_id, entry_date);

const MEAL_TYPES = ["breakfast", "lunch", "snack", "dinner"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyMealTotals() {
  return { breakfast: 0, lunch: 0, snack: 0, dinner: 0 };
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function validateLogPayload(payload) {
  const userId = (payload?.user_id || "").trim();
  const mealType = (payload?.meal_type || "").trim().toLowerCase();
  const caloriesRaw = payload?.calories;

  if (!userId) return { error: "'user_id' is required" };
  if (!MEAL_TYPES.includes(mealType)) {
    return { error: `'meal_type' must be one of: ${MEAL_TYPES.join(", ")}` };
  }
  const calories = Number(caloriesRaw);
  if (caloriesRaw === undefined || caloriesRaw === null || caloriesRaw === "" || !Number.isFinite(calories) || calories < 0) {
    return { error: "'calories' is required and must be a non-negative number" };
  }
  const entryDate = payload?.entry_date ? String(payload.entry_date).trim() : null;
  if (entryDate && !DATE_RE.test(entryDate)) {
    return { error: "'entry_date' must be in YYYY-MM-DD format" };
  }
  const foodName = payload?.food_name ? String(payload.food_name).trim() : null;

  return { userId, mealType, calories, entryDate, foodName };
}

/** GET/POST/DELETE /log — nutrition diary entries (breakfast/lunch/snack/dinner) for a user_id. */
async function handleFoodLog(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    if (id) {
      const { ok, body } = await db.selectOne("food_log_entries", id);
      if (!ok) return notFound("Log entry");
      return success(body);
    }

    const userId = url.searchParams.get("user_id");
    if (!userId) return err("'user_id' query param is required");
    const date = url.searchParams.get("date") || "";
    if (date && !DATE_RE.test(date)) return err("'date' must be in YYYY-MM-DD format");

    const filters = { user_id: `eq.${userId}` };
    if (date) filters["entry_date"] = `eq.${date}`;

    return await paginatedList(db, "food_log_entries", url, {
      filters,
      order: "entry_date.desc,created_at.desc",
    });
  }

  if (method === "POST") {
    if (id) return err("POST /log does not take an id in the path — omit it to create a new entry");
    const payload = await parseBody(request);
    const parsed = validateLogPayload(payload);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.insert("food_log_entries", {
      user_id: parsed.userId,
      meal_type: parsed.mealType,
      calories: parsed.calories,
      food_name: parsed.foodName,
      ...(parsed.entryDate ? { entry_date: parsed.entryDate } : {}),
    });
    if (!ok) return err(body?.message || "Log entry failed", status);
    return success(body, { message: "Logged" });
  }

  if (method === "DELETE") {
    if (!id) return err("Entry id required, e.g. DELETE /log/5?user_id=...");
    const userId = url.searchParams.get("user_id");
    if (!userId) return err("'user_id' query param is required to delete a log entry");

    const { ok, status, body } = await db.removeWhere("food_log_entries", {
      id: `eq.${id}`,
      user_id: `eq.${userId}`,
    });
    if (!ok) return err(body?.message || "Delete failed", status);
    const removed = Array.isArray(body) ? body.length : 0;
    if (!removed) return notFound("Log entry");
    return success(null, { message: "Log entry deleted" });
  }

  return err("Method not allowed", 405);
}

/**
 * GET /log/summary?user_id=...&period=daily|weekly&date=YYYY-MM-DD
 * Aggregates food_log_entries into kcal totals — daily gives one day's
 * breakdown by meal; weekly gives a 7-day window (ending on `date`,
 * default today) with per-day totals, a per-meal breakdown across the
 * whole week, and the daily average.
 */
async function handleLogSummary(request, url, db) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const userId = url.searchParams.get("user_id");
  if (!userId) return err("'user_id' query param is required");

  const period = (url.searchParams.get("period") || "daily").toLowerCase();
  if (!["daily", "weekly"].includes(period)) {
    return err("'period' must be 'daily' or 'weekly'");
  }

  const dateParam = url.searchParams.get("date") || "";
  if (dateParam && !DATE_RE.test(dateParam)) return err("'date' must be in YYYY-MM-DD format");
  const anchor = dateParam ? new Date(`${dateParam}T00:00:00Z`) : new Date(`${toDateOnly(new Date())}T00:00:00Z`);
  if (isNaN(anchor.getTime())) return err("Invalid 'date'");

  if (period === "daily") {
    const dateStr = toDateOnly(anchor);
    const { ok, status, body } = await db.select("food_log_entries", {
      filters: { user_id: `eq.${userId}`, entry_date: `eq.${dateStr}` },
      limit: 500,
      order: "created_at.asc",
    });
    if (!ok) return err(body?.message || "Query failed", status);

    const rows = Array.isArray(body) ? body : [];
    const byMeal = emptyMealTotals();
    let total = 0;
    for (const row of rows) {
      const kcal = Number(row.calories) || 0;
      total += kcal;
      if (byMeal.hasOwnProperty(row.meal_type)) byMeal[row.meal_type] += kcal;
    }

    return success({
      user_id: userId,
      period: "daily",
      date: dateStr,
      total_calories: total,
      by_meal: byMeal,
      entry_count: rows.length,
    });
  }

  // weekly — 7-day window ending on the anchor date (inclusive)
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - 6);
  const startStr = toDateOnly(start);
  const endStr = toDateOnly(anchor);

  const { ok, status, body } = await db.select("food_log_entries", {
    filters: { user_id: `eq.${userId}`, entry_date: `gte.${startStr}` },
    limit: 1000,
    order: "entry_date.asc",
  });
  if (!ok) return err(body?.message || "Query failed", status);

  // gte was applied server-side; the upper bound is filtered here since
  // buildUrl can't express two conditions on the same column at once.
  const rows = (Array.isArray(body) ? body : []).filter((row) => row.entry_date <= endStr);

  const byMeal = emptyMealTotals();
  const byDate = {};
  let total = 0;
  for (const row of rows) {
    const kcal = Number(row.calories) || 0;
    total += kcal;
    if (byMeal.hasOwnProperty(row.meal_type)) byMeal[row.meal_type] += kcal;
    byDate[row.entry_date] = (byDate[row.entry_date] || 0) + kcal;
  }

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const dStr = toDateOnly(d);
    days.push({ date: dStr, total_calories: byDate[dStr] || 0 });
  }

  return success({
    user_id: userId,
    period: "weekly",
    start_date: startStr,
    end_date: endStr,
    total_calories: total,
    average_daily_calories: Math.round((total / 7) * 100) / 100,
    by_meal: byMeal,
    by_date: days,
    entry_count: rows.length,
  });
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
    "wagyu", "steak", "meat", "poultry", "mince", "liver",
    // Lake Malawi / local fish names — none of these contain "fish" in the
    // name they're actually stored/searched under, so without this they'd
    // silently fall through both classification and keyword-based search.
    "chambo", "usipa", "kapenta", "matemba", "mbaba", "chisawasawa", "ntchila"]],
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

// Some rows in `foods` have a `weight_g` value that doesn't match the gram
// amount printed in `measure` (e.g. measure "1 cup / chikombe (240g)" but
// weight_g: 100) — weight_g looks like it was defaulted to the 100g
// reference basis on a number of rows rather than actually recorded per
// measure. The gram amount printed inside `measure`'s parentheses is more
// trustworthy when present, so that's tried first; weight_g is only the
// fallback. This affects both Serving-Size Intelligence and Recipe
// Nutrition Calculation, since both build on buildServingSizes() below.
function extractGramsFromMeasureText(measureText) {
  if (!measureText) return null;
  const m = String(measureText).match(/\(\s*([\d.]+)\s*g\s*\)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return isNaN(val) ? null : val;
}

function classifyCategory(foodName) {
  const name = (foodName || "").toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => name.includes(kw))) return category;
  }
  return null;
}

// ─── FOOD SUBSTITUTIONS ─────────────────────────────────────────────────────
//
// "I don't have chicken, what can I use instead?" — deliberately NOT just
// "same CATEGORY_KEYWORDS category", because that taxonomy splits chicken
// (Protein) from beans/soya/groundnuts (Legumes) even though a Malawian
// household or clinician treats all of them as interchangeable protein
// sources. The groups below override that split for the categories where
// it matters; anything else falls back to its own CATEGORY_KEYWORDS
// category (see getSubstitutionGroup below).
const CATEGORY_KEYWORD_MAP = new Map(CATEGORY_KEYWORDS);

const SUBSTITUTION_GROUP_OVERRIDES = {
  Protein: {
    label: "Protein / body-building foods",
    primaryNutrient: "protein_g",
    keywords: [...(CATEGORY_KEYWORD_MAP.get("Protein") || []), ...(CATEGORY_KEYWORD_MAP.get("Legumes") || [])],
  },
  Grains: {
    label: "Starches / staples",
    primaryNutrient: "carbs_g",
    // Cassava/potatoes sit under Vegetables in CATEGORY_KEYWORDS, but
    // they're staples in a Malawian diet, not relish — grouped with grains here.
    keywords: [...(CATEGORY_KEYWORD_MAP.get("Grains") || []), "cassava", "sweet potato", "irish potato", "potato"],
  },
};
SUBSTITUTION_GROUP_OVERRIDES.Legumes = SUBSTITUTION_GROUP_OVERRIDES.Protein;

const SUBSTITUTION_PRIMARY_NUTRIENT_LABEL = {
  protein_g: "protein",
  carbs_g: "carbohydrate",
  fiber_g: "fiber",
  vitc_mg: "vitamin C",
  calcium_mg: "calcium",
  kcal: "calories",
};

function getSubstitutionGroup(category) {
  if (SUBSTITUTION_GROUP_OVERRIDES[category]) return SUBSTITUTION_GROUP_OVERRIDES[category];
  const keywords = CATEGORY_KEYWORD_MAP.get(category) || [];
  if (!keywords.length) return null;
  const primaryByCategory = { Vegetables: "fiber_g", Fruits: "vitc_mg", Dairy: "calcium_mg" };
  return { label: category, primaryNutrient: primaryByCategory[category] || "kcal", keywords };
}

/**
 * GET /foods/substitutes?food_name=chicken&limit=5
 * Resolves the food (same local-ilike-then-external-cascade lookup /meals/
 * analyze uses per ingredient), works out its substitution group (see
 * SUBSTITUTION_GROUP_OVERRIDES above), gathers candidates from `foods` via
 * the group's keyword list (multiKeywordFoodSearch — one ilike query per
 * keyword, merged/deduped), then ranks by closeness to the original on the
 * group's primary nutrient per 100g (closest first). Every candidate also
 * gets a full comparison table (kcal/protein/carbs/fat/iron/calcium) vs the
 * original, not just the ranking nutrient.
 * Purely computational — no auth required, no writes, nothing persisted.
 */
async function handleFoodSubstitutes(request, url, db, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const foodName = (url.searchParams.get("food_name") || url.searchParams.get("food") || "").trim();
  if (!foodName) return err("'food_name' query param is required");
  const limit = Math.min(Math.max(intParam(url, "limit", 5), 1), 15);

  const local = await db.select("foods", {
    filters: { food_name: `ilike.*${escapeLikePattern(foodName)}*` },
    limit: 25,
  });
  let food = local.ok ? pickBestFoodMatch(local.body, foodName) : null;
  let matchedSource = food ? "local" : null;
  if (!food) {
    const cascade = await lookupFoodCascade(db, { query: foodName }, env);
    if (cascade?.food) {
      food = cascade.food;
      matchedSource = cascade.source;
    }
  }
  if (!food) return notFound(`Food matching '${foodName}'`);

  const originalName = food.food_name || food.product_name || foodName;
  const category = classifyCategory(originalName);
  const group = category ? getSubstitutionGroup(category) : null;
  if (!group) {
    return success({
      original: { food_name: originalName, matched_source: matchedSource, category: null },
      substitution_group: null,
      substitutes: [],
      note: `Couldn't classify '${originalName}' into a known food category, so no substitution group applies.`,
    });
  }

  const candidates = await multiKeywordFoodSearch(searchFoodsExact, db, originalName, group.keywords, 60);
  const originalNameLower = originalName.toLowerCase();
  const pool = candidates.filter((c) => (c.food_name || "").toLowerCase() !== originalNameLower);

  const comparisonFields = ["kcal", "protein_g", "carbs_g", "fat_g", "iron_mg", "calcium_mg"];
  const originalNutrients = {};
  for (const f of comparisonFields) originalNutrients[f] = food[f] != null && food[f] !== "" ? Number(food[f]) : null;
  const originalPrimary = originalNutrients[group.primaryNutrient];

  const ranked = pool
    .map((c) => {
      const nutrients = {};
      for (const f of comparisonFields) nutrients[f] = c[f] != null && c[f] !== "" ? Number(c[f]) : null;
      const candidatePrimary = nutrients[group.primaryNutrient];
      const distance = originalPrimary != null && candidatePrimary != null ? Math.abs(candidatePrimary - originalPrimary) : Infinity;

      const comparisonVsOriginal = {};
      for (const f of comparisonFields) {
        comparisonVsOriginal[f] =
          originalNutrients[f] == null || nutrients[f] == null
            ? null
            : { substitute: nutrients[f], original: originalNutrients[f], difference: roundServingVal(nutrients[f] - originalNutrients[f]) };
      }

      return {
        food_name: c.food_name,
        category: classifyCategory(c.food_name),
        per_100g: nutrients,
        comparison_vs_original: comparisonVsOriginal,
        _distance: distance,
      };
    })
    .sort((a, b) => a._distance - b._distance)
    .slice(0, limit)
    .map(({ _distance, ...rest }) => rest);

  return success({
    original: { food_name: originalName, matched_source: matchedSource, category, per_100g: originalNutrients },
    substitution_group: group.label,
    ranked_by: `closeness in ${SUBSTITUTION_PRIMARY_NUTRIENT_LABEL[group.primaryNutrient] || group.primaryNutrient} per 100g`,
    substitutes: ranked,
    note: "Values are per 100g (Malawi FCT convention). Ranked purely on nutritional closeness within a Malawi-relevant substitution group — doesn't know about cost, local availability, taste, or portion size, and 'closeness' is a single primary nutrient, not a full dietary equivalence.",
  });
}

// ─── SERVING-SIZE INTELLIGENCE ─────────────────────────────────────────────
//
// All nutrient columns on `foods` (and the normalized shape used by
// /foods/lookup) are per-100g/100ml, per Malawi FCT 2019 convention — see
// sql/001_add_micronutrients_to_foods.sql. That's the right storage/API
// basis, but "per 100g" isn't how anyone actually eats or counsels a
// patient. This adds an opt-in `serving_sizes` array (see `with_servings`
// below) of realistic Malawian household servings for a food, each with
// nutrients pre-scaled from the 100g basis — so a clinician or app doesn't
// have to do the arithmetic (or guess a plausible portion) themselves.
//
// Three tiers, most authoritative first, first match per tier wins:
//   1. `fct`               — the food's own `measure`/`weight_g` columns,
//                             when present (an actual Malawi FCT 2019
//                             household-measure entry for THIS food).
//   2. `local_intelligence` — a specific keyword match against food_name
//                             against SERVING_SIZE_KEYWORDS below — hand-
//                             curated Malawian household measures (chikombe/
//                             cup, ladle, chunk, sachet, etc.) for foods
//                             that come up constantly in local diets/clinical
//                             work but may not carry their own FCT measure
//                             (e.g. external/packaged/OCR-sourced foods).
//   3. `category_estimate`  — a generic per-category fallback (e.g. "1 cup
//                             cooked" for Grains) when nothing more specific
//                             matches. Coarser, but still far more useful
//                             than only ever seeing a 100g number.
// The literal 100g/100ml reference basis is always included too, labeled
// `reference`, so the raw per-100g numbers are never lost.
//
// This is deliberately local/rule-based (no LLM call, no added latency or
// cost) — same philosophy as classifyCategory() above. Servings are
// estimates for counselling/portioning purposes, not lab-measured weights.

const SERVING_SIZE_KEYWORDS = [
  [["nsima"], { label: "1 chunk / ndomondo (approx. 1 cup, 200g)", grams: 200 }],
  [["likuni phala", "phala", "porridge", "csb", "corn soya blend"], { label: "1 cup cooked porridge / chikombe (250g)", grams: 250 }],
  [["rutf", "plumpy"], { label: "1 sachet (92g)", grams: 92 }],
  [["rice"], { label: "1 cup cooked rice (150g)", grams: 150 }],
  [["bean", "soya", "soy", "lentil", "pea", "chickpea"], { label: "1 cup cooked (170g)", grams: 170 }],
  [["groundnut", "peanut"], { label: "1 tablespoon / dzankho (15g)", grams: 15 }],
  [["cassava", "sweet potato", "irish potato", "potato"], { label: "1 medium piece (150g)", grams: 150 }],
  [["tea", "coffee"], { label: "1 cup (250ml)", grams: 250 }],
  [["milk"], { label: "1 cup (250ml)", grams: 250 }],
  [["cooking oil", " oil", "oil,", "margarine", "ghee", "lard"], { label: "1 tablespoon (15g)", grams: 15 }],
  [["sugar"], { label: "1 tablespoon (12g)", grams: 12 }],
  [["banana"], { label: "1 medium banana (120g)", grams: 120 }],
  [["egg"], { label: "1 medium egg (50g)", grams: 50 }],
  [["bread"], { label: "1 slice (35g)", grams: 35 }],
  [["mango", "orange", "papaya", "guava", "apple"], { label: "1 medium piece (150g)", grams: 150 }],
  [["fish", "sardine", "tilapia", "salmon", "tuna", "chambo", "usipa", "kapenta", "matemba", "mbaba", "chisawasawa", "ntchila"], { label: "1 medium piece (80g)", grams: 80 }],
  [["chicken", "beef", "pork", "goat", "turkey", "meat", "liver", "mince"], { label: "1 palm-sized portion (90g)", grams: 90 }],
  [["rape", "mustard", "pumpkin leaves", "cabbage", "spinach", "kale"], { label: "1 cup cooked relish (95g)", grams: 95 }],
  [["tomato"], { label: "1 medium tomato (90g)", grams: 90 }],
  [["juice"], { label: "1 cup (250ml)", grams: 250 }],
  [["soda", "cola"], { label: "1 can (330ml)", grams: 330 }],
  [["biscuit", "cookie"], { label: "1 piece (10g)", grams: 10 }],
];

const CATEGORY_SERVING_DEFAULTS = {
  Grains: { label: "1 cup cooked (150g)", grams: 150 },
  Legumes: { label: "1 cup cooked (170g)", grams: 170 },
  Vegetables: { label: "1 cup cooked (95g)", grams: 95 },
  Fruits: { label: "1 medium piece (120g)", grams: 120 },
  Protein: { label: "1 palm-sized portion (90g)", grams: 90 },
  Dairy: { label: "1 cup (250ml)", grams: 250 },
  "Fats & Oils": { label: "1 tablespoon (15g)", grams: 15 },
  Beverages: { label: "1 cup (250ml)", grams: 250 },
  "Sweets & Snacks": { label: "1 piece (20g)", grams: 20 },
  "Nuts & Seeds": { label: "1 handful (30g)", grams: 30 },
};

// Fields scaled by serving weight — union of local `foods` columns and the
// normalized external-lookup shape (see normalizeFood/withExternalShape),
// so this works the same whether the food came from /foods/:id or
// /foods/lookup. Missing fields on a given food are simply skipped.
const SERVING_SCALE_FIELDS = [
  "kcal", "energy_kcal", "kj", "protein_g", "carbs_g", "fat_g", "fiber_g",
  "vita_rae_mcg", "vitc_mg", "vitd_mcg", "vitb12_mcg", "folate_mcg",
  "calcium_mg", "iron_mg", "zinc_mg", "magnesium_mg", "potassium_mg",
  "sodium_mg", "iodine_mcg",
];

function roundServingVal(n) {
  return n == null || n === "" || isNaN(n) ? null : Math.round(Number(n) * 100) / 100;
}

/**
 * Builds the `serving_sizes` array for a food object (per-100g/100ml basis).
 * See the block comment above for the tier logic. Pure/local — no I/O.
 */
function buildServingSizes(food) {
  if (!food) return [];
  const name = (food.food_name || food.product_name || "").toLowerCase();
  // Always classify from the food name via our own keyword taxonomy here —
  // don't fall back to food.category. The `foods` table's own category
  // column uses a different, coarser vocabulary (e.g. "Staples", "Baby
  // Foods") than CATEGORY_SERVING_DEFAULTS/CORE_FOOD_GROUPS below (Grains,
  // Legumes, Protein, Vegetables, Fruits, Dairy, ...) — trusting it here
  // caused nsima (DB category "Staples") to match neither "Grains" nor
  // any other core group, so Meal Analysis wrongly flagged "Grains" as
  // missing from a nsima-containing meal. classifyCategory() is the
  // taxonomy this logic is actually built around, so use it unconditionally.
  const category = classifyCategory(name);

  const candidates = [];

  // Tier 1 — this food's own Malawi FCT household-measure entry. Prefer the
  // gram amount printed inside `measure` itself (more trustworthy — see
  // extractGramsFromMeasureText() above); fall back to weight_g only if
  // `measure` doesn't have a parseable gram amount.
  if (food.measure) {
    const parsedGrams = extractGramsFromMeasureText(food.measure);
    const grams =
      parsedGrams != null
        ? parsedGrams
        : food.weight_g != null && !isNaN(Number(food.weight_g))
        ? Number(food.weight_g)
        : null;
    if (grams != null) {
      candidates.push({ label: String(food.measure), grams, source: "fct" });
    }
  }

  // Tier 2 — specific local-food keyword match (first/most-specific wins).
  const keywordMatch = SERVING_SIZE_KEYWORDS.find(([keywords]) => keywords.some((kw) => name.includes(kw)));
  if (keywordMatch) {
    candidates.push({ ...keywordMatch[1], source: "local_intelligence" });
  }

  // Tier 3 — generic category fallback, only when nothing more specific matched.
  if (!keywordMatch && category && CATEGORY_SERVING_DEFAULTS[category]) {
    candidates.push({ ...CATEGORY_SERVING_DEFAULTS[category], source: "category_estimate" });
  }

  // Always keep the raw 100g/100ml reference basis.
  candidates.push({ label: food.kj != null || food.kcal != null ? "100g" : "100g / 100ml", grams: 100, source: "reference" });

  // Dedup near-identical gram amounts (e.g. an FCT measure of ~100g would
  // otherwise duplicate the reference basis) — first (highest-priority) wins.
  const deduped = [];
  for (const c of candidates) {
    if (!deduped.some((d) => Math.abs(d.grams - c.grams) < 5)) deduped.push(c);
  }

  return deduped.map(({ label, grams, source }) => {
    const scale = grams / 100;
    const nutrients = {};
    for (const field of SERVING_SCALE_FIELDS) {
      if (food[field] != null && food[field] !== "") {
        nutrients[field] = roundServingVal(Number(food[field]) * scale);
      }
    }
    return { label, grams, source, nutrients };
  });
}

// ─── RECIPE NUTRITION CALCULATION ───────────────────────────────────────────
//
// Builds on Serving-Size Intelligence above: given a list of ingredients
// (each a food + quantity + unit), resolves each to a food row, converts
// its quantity/unit to grams, scales that food's per-100g nutrients, and
// sums across the recipe — with a per-serving breakdown. POST /recipes/calculate,
// see handleRecipesCalculate(). No persistence — purely a calculation on
// top of existing data.

// Unambiguous mass/volume units — exact conversion, doesn't depend on which
// food it's attached to. ml/l assume ~1g/ml (water-like density) since we
// don't have per-food density data; fine for the liquids/porridges this is
// mostly used for, less exact for e.g. oil. Values cross-checked against
// the Nutrition Care Manual (NC Dietetic Association, 2011) equivalents/
// conversion tables — cup=240mL, Tbsp=15mL, tsp=5mL, oz=28.35g, lb=453.6g,
// pint=473.2mL, quart=946.2mL, gallon=3785mL all match that reference.
// "oz"/"ounce" defaults to the dry/weight ounce (28.35g), since that's how
// most food-ingredient quantities in oz are meant; "fl oz" (fluid ounce,
// ~29.57mL/g) is kept as a distinct unit rather than folded into "oz",
// since the two are genuinely different quantities for non-water liquids.
const GENERIC_UNIT_GRAMS = {
  g: 1, gram: 1, grams: 1, gm: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  mg: 0.001, milligram: 0.001,
  ml: 1, milliliter: 1, millilitre: 1,
  l: 1000, liter: 1000, litre: 1000,
  oz: 28.35, ounce: 28.35, ounces: 28.35,
  lb: 453.6, pound: 453.6, pounds: 453.6,
  floz: 29.57, fl_oz: 29.57, fluidounce: 29.57, fluidounces: 29.57,
  pint: 473.2, pints: 473.2,
  quart: 946.2, quarts: 946.2,
  gallon: 3785, gallons: 3785,
};

// Generic household-unit fallback — used only when the unit couldn't be
// matched against this specific food's own serving_sizes (see
// resolveIngredientGrams below), so it's necessarily coarser than a
// food-specific measure.
const GENERIC_HOUSEHOLD_UNIT_GRAMS = {
  cup: 240, cups: 240,
  tbsp: 15, tablespoon: 15, tablespoons: 15,
  tsp: 5, teaspoon: 5, teaspoons: 5,
  slice: 30, slices: 30,
  handful: 30, handfuls: 30,
  pinch: 0.5, pinches: 0.5,
};

/**
 * Converts one ingredient's {quantity, unit} to grams for a given food row.
 * Three tiers, most accurate first:
 *   1. Unambiguous mass/volume unit (g, kg, ml, oz, ...) — exact.
 *   2. "serving"/"servings", or a household unit (cup, tbsp, piece, ...)
 *      matched against THIS food's own buildServingSizes() candidates —
 *      e.g. "2 cups rice" resolves via rice's own "1 cup cooked rice
 *      (150g)" entry, not a generic cup.
 *   3. Generic household-unit fallback (GENERIC_HOUSEHOLD_UNIT_GRAMS) when
 *      no food-specific match exists — coarser, same rationale as
 *      CATEGORY_SERVING_DEFAULTS above.
 * Returns { grams, basis } on success, or { grams: null, reason } when the
 * unit can't be resolved at all.
 */
function resolveIngredientGrams(food, quantity, unit) {
  const u = String(unit || "g").trim().toLowerCase();

  if (GENERIC_UNIT_GRAMS[u] != null) {
    return { grams: quantity * GENERIC_UNIT_GRAMS[u], basis: `${u} (direct mass/volume conversion)` };
  }

  const candidates = buildServingSizes(food);

  if (u === "serving" || u === "servings") {
    const best = candidates.find((c) => c.source !== "reference") || candidates[0];
    if (best) return { grams: quantity * best.grams, basis: best.label };
  }

  const candidateMatch = candidates.find((c) => c.label.toLowerCase().includes(u));
  if (candidateMatch) {
    return { grams: quantity * candidateMatch.grams, basis: candidateMatch.label };
  }

  if (GENERIC_HOUSEHOLD_UNIT_GRAMS[u] != null) {
    return { grams: quantity * GENERIC_HOUSEHOLD_UNIT_GRAMS[u], basis: `generic '${u}' estimate (not food-specific)` };
  }

  return { grams: null, reason: `unrecognized unit '${unit}' — use g/kg/ml/l/oz/lb, a household unit (cup/tbsp/tsp/piece/slice/handful/serving), or a food-specific label` };
}

/**
 * Given several ilike-matched food rows for a search term, picks the one
 * most likely to be what was meant — plain "milk" or "rice" over
 * "Milk scones" or "Rice porridge" just because the substring happens to
 * appear inside a longer dish name. Four tiers:
 *   1. Exact case-insensitive match on the whole food_name.
 *   2. The search term appears as a whole word (word-boundary match) —
 *      narrows out coincidental substring hits like "rice" inside
 *      "Apricot".
 *   3. Among those, prefer names where the matched word is immediately
 *      followed by a qualifier — parenthesis/comma/dash/slash/end-of-
 *      string — rather than straight into another bare word. This is the
 *      part that actually distinguishes "Rice (cooked, white)" or
 *      "Rice, brown, raw" (still just rice, with a qualifier) from
 *      "Rice pudding" or "Rice porridge" (a different dish that happens to
 *      start with the same word) — a plain shortest-name tiebreak alone
 *      gets this wrong, since e.g. "Rice pudding" (12 chars) is literally
 *      shorter than "Rice (cooked, white)" (21 chars).
 *   4. Shortest food_name as the final tiebreak within whatever's left.
 * This still can't disambiguate raw vs. cooked when both qualify equally
 * (e.g. plain "rice" could mean either) — pass food_id instead of
 * food_name for exact control when that distinction matters.
 */
function pickBestFoodMatch(rows, query) {
  if (!rows || !rows.length) return null;
  const q = query.trim().toLowerCase();

  const exact = rows.find((r) => (r.food_name || "").trim().toLowerCase() === q);
  if (exact) return exact;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordBoundary = new RegExp(`\\b${escaped}\\b`, "i");
  let pool = rows.filter((r) => wordBoundary.test(r.food_name || ""));
  if (!pool.length) pool = rows;

  const qualifierAfter = new RegExp(`\\b${escaped}\\b\\s*($|[(),/-])`, "i");
  const qualified = pool.filter((r) => qualifierAfter.test(r.food_name || ""));
  const candidates = qualified.length ? qualified : pool;

  candidates.sort((a, b) => (a.food_name || "").length - (b.food_name || "").length);
  return candidates[0];
}

// ─── INGREDIENT TEXT PARSING ─────────────────────────────────────────────────
//
// POST /ingredients/parse turns a free-text line like
// "2 eggs, 1 cup rice, 100g chicken and ½ avocado" into the structured
// ingredients[] shape resolveIngredientsList() (and therefore
// /recipes/calculate and /meals/analyze) already accepts:
// [{food_name, quantity, unit}, ...] — so a caller can paste in a plain
// sentence instead of hand-building JSON.
//
// Two tiers, same pattern as classifyIntent() above:
//   1. Groq LLM parse (openai/gpt-oss-20b, temperature 0) — handles real
//      free text well: plurals, "and"/commas mixed, words like "half",
//      descriptors ("boiled", "chopped") that should be dropped from the
//      food name.
//   2. heuristicParseIngredients() — a local regex splitter, used when
//      GROQ_API_KEY isn't configured or the LLM call/parse fails. Cruder
//      (keeps plurals as-is, doesn't strip descriptors) but never throws
//      and needs no API call.
// A bare count with no unit ("2 eggs", "½ avocado") is emitted with
// unit: "serving" rather than left null — resolveIngredientGrams() treats
// a missing unit as grams, which would silently turn "2 eggs" into 2g.
// "serving" is what that same function already falls back to for
// count-like items (via each food's own buildServingSizes() candidates),
// so downstream resolution treats "2 eggs" as 2 whole eggs, not 2g of egg.

const UNICODE_FRACTIONS = {
  "¼": 0.25, "½": 0.5, "¾": 0.75,
  "⅓": 1 / 3, "⅔": 2 / 3,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
  "⅙": 1 / 6, "⅚": 5 / 6,
  "⅐": 1 / 7,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
  "⅑": 1 / 9,
  "⅒": 0.1,
};
const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");

// Every unit resolveIngredientGrams() already understands (GENERIC_UNIT_GRAMS
// + GENERIC_HOUSEHOLD_UNIT_GRAMS, both keyed by the exact surface forms —
// plurals included — it looks up), plus "piece(s)" as a plain count synonym.
const KNOWN_INGREDIENT_UNITS = new Set([
  ...Object.keys(GENERIC_UNIT_GRAMS),
  ...Object.keys(GENERIC_HOUSEHOLD_UNIT_GRAMS),
  "serving", "servings", "piece", "pieces",
]);

/** Parses one quantity token ("2", "1.5", "½", "1/2", "1 1/2") to a number, or null. */
function parseQuantityToken(tok) {
  const t = (tok || "").trim();
  if (!t) return null;
  if (UNICODE_FRACTIONS[t] != null) return UNICODE_FRACTIONS[t];

  // "1½" / "1 ½" — leading integer plus a unicode fraction char
  const mixedUnicode = t.match(new RegExp(`^(\\d+)\\s*([${UNICODE_FRACTION_CHARS}])$`));
  if (mixedUnicode) return Number(mixedUnicode[1]) + UNICODE_FRACTIONS[mixedUnicode[2]];

  // "1 1/2"
  const mixedSlash = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixedSlash) return Number(mixedSlash[1]) + Number(mixedSlash[2]) / Number(mixedSlash[3]);

  // "1/2"
  const slash = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (slash) return Number(slash[1]) / Number(slash[2]);

  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

/**
 * Splits one ingredient phrase ("100g chicken", "1 cup rice", "2 eggs",
 * "½ avocado") into { quantity, unit, food_name }, or null if no leading
 * quantity could be found at all (e.g. "salt to taste").
 */
function parseIngredientPhrase(phrase) {
  const text = (phrase || "").trim();
  if (!text) return null;

  const qtyMatch = text.match(
    new RegExp(`^(\\d+\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s*\\/\\s*\\d+|\\d+(?:\\.\\d+)?\\s*[${UNICODE_FRACTION_CHARS}]|[${UNICODE_FRACTION_CHARS}]|\\d+(?:\\.\\d+)?)`)
  );
  if (!qtyMatch) return null;

  const quantity = parseQuantityToken(qtyMatch[1]);
  if (quantity == null || quantity <= 0) return null;

  let rest = text.slice(qtyMatch[0].length).trim();

  // Two-word unit ("fl oz") checked before the generic single-word match.
  let unit = null;
  const flOzMatch = rest.match(/^fl\.?\s*oz\b\.?/i);
  if (flOzMatch) {
    unit = "fl_oz";
    rest = rest.slice(flOzMatch[0].length).trim();
  } else {
    const wordMatch = rest.match(/^([a-zA-Z]+)\b\.?/);
    if (wordMatch && KNOWN_INGREDIENT_UNITS.has(wordMatch[1].toLowerCase())) {
      unit = wordMatch[1].toLowerCase();
      rest = rest.slice(wordMatch[0].length).trim();
    }
  }

  rest = rest.replace(/^(of\s+)/i, "").trim();
  if (!rest) return null;

  // No unit stated at all → a bare count ("2 eggs", "½ avocado"); see the
  // section comment above for why this becomes "serving" rather than null.
  return { food_name: rest, quantity, unit: unit || "serving" };
}

/**
 * Local regex fallback for POST /ingredients/parse — used when
 * GROQ_API_KEY isn't configured or the LLM parse fails. Splits on commas,
 * "and", "&", and newlines, then parses each piece with
 * parseIngredientPhrase(). Segments with no leading quantity (e.g. "salt
 * to taste") are dropped rather than guessed at.
 */
function heuristicParseIngredients(text) {
  const segments = String(text || "")
    .split(/,|\n|;|(?:\s+and\s+)|&/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const ingredients = [];
  for (const segment of segments) {
    const parsed = parseIngredientPhrase(segment);
    if (parsed) ingredients.push(parsed);
  }
  return ingredients;
}

/**
 * Groq LLM parse — handles real free text (plurals, mixed connectors,
 * word-form quantities like "half", descriptors to drop from the food
 * name) noticeably better than the regex fallback. Falls back to
 * heuristicParseIngredients() on any failure — never throws.
 */
async function parseIngredientsWithLLM(text, env) {
  if (!env.GROQ_API_KEY) return heuristicParseIngredients(text);

  const prompt = `Parse this free-text list of food ingredients into a structured JSON array. For each ingredient extract:
- food_name: the food name only — singular, lowercase, no descriptors like "chopped"/"fresh"/"boiled" unless they're part of the name
- quantity: a plain number (convert fractions and words like "half"/"a"/"an" to a decimal, e.g. 0.5, 1)
- unit: one of g, kg, ml, l, oz, lb, cup, tbsp, tsp, slice, handful, pinch, serving — use "serving" if the text gives no unit, just a bare count (e.g. "2 eggs" -> quantity 2, unit "serving")

Text: "${text}"

Respond with ONLY this JSON, no other text: {"ingredients": [{"food_name": "...", "quantity": <number>, "unit": "..."}]}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0,
        max_completion_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Groq parse failed (${res.status})`);

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const parsed = extractJsonObject(raw);
    const items = Array.isArray(parsed?.ingredients) ? parsed.ingredients : null;
    if (!items) throw new Error("Groq response missing 'ingredients' array");

    const cleaned = items
      .map((item) => {
        const quantity = Number(item?.quantity);
        const foodName = String(item?.food_name || "").trim();
        if (!foodName || !Number.isFinite(quantity) || quantity <= 0) return null;
        const unit = String(item?.unit || "serving").trim().toLowerCase();
        return { food_name: foodName, quantity, unit: KNOWN_INGREDIENT_UNITS.has(unit) ? unit : "serving" };
      })
      .filter(Boolean);

    // An empty/garbled parse is still a failure worth falling back on, not
    // a legitimately empty ingredient list.
    if (!cleaned.length) throw new Error("Groq parse produced no usable ingredients");
    return cleaned;
  } catch (e) {
    return heuristicParseIngredients(text);
  }
}

/** POST /ingredients/parse — body {text}; see the section comment above. */
async function handleIngredientsParse(request, db, env) {
  if (request.method !== "POST") return err("Method not allowed", 405);

  const body = await parseBody(request);
  const text = (body?.text || "").trim();
  if (!text) return err("'text' is required, e.g. \"2 eggs, 1 cup rice, 100g chicken and ½ avocado\"");

  const ingredients = await parseIngredientsWithLLM(text, env);
  if (!ingredients.length) {
    return success(
      { text, ingredients: [] },
      { message: "No ingredients could be identified in that text — try a simpler format like '2 eggs, 1 cup rice'" }
    );
  }

  return success({ text, ingredients, count: ingredients.length });
}

// ─── DIETARY REFERENCE INTAKES (DRI) ────────────────────────────────────────
//
// EAR / RDA / AI / UL / AMDR by life stage — official Food and Nutrition
// Board (NASEM/IOM) tables, data lives in ./dri_data.js (see that file's
// header for sourcing, the RDA-vs-AI derivation rule, and what's
// intentionally omitted). Three endpoints:
//
//   GET  /dri/life-stages          — list every life-stage group
//   GET  /dri                      — look up EAR/RDA/AI/UL, either by
//                                     life_stage code directly or by
//                                     age+sex(+life_stage_type)
//   POST /dri/compare              — compare an actual day's intake
//                                     against a resolved life stage's
//                                     RDA/AI targets, flagging UL
//
// All three are read-only/computational — no persistence, no auth beyond
// the standard public rate limit.

/** GET /dri/life-stages — every DRI life-stage group CNR has data for. */
async function handleDriLifeStages(request) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  return success({
    life_stages: DRI_LIFE_STAGES.map((s) => ({
      code: s.code,
      label: s.label,
      sex: s.sex,
      life_stage_type: s.life_stage_type,
      age_min_years: s.age_min,
      age_max_years: s.age_max,
    })),
  });
}

/** Shapes one nutrient's stored {ear?,rda?,ai?,ul?} into a full response entry. */
function formatDriNutrientEntry(key, values) {
  const meta = DRI_NUTRIENT_META[key];
  const target = values.rda ?? values.ai ?? null;
  return {
    nutrient: key,
    label: meta?.label || key,
    unit: meta?.unit || null,
    trackable: !!meta?.trackable,
    ear: values.ear ?? null,
    rda: values.rda ?? null,
    ai: values.ai ?? null,
    ul: values.ul ?? null,
    target_type: values.rda != null ? "rda" : values.ai != null ? "ai" : null,
    target,
  };
}

/**
 * GET /dri?nutrient=<key>&life_stage=<code>
 * GET /dri?nutrient=<key>&age=<years>&sex=<male|female>&life_stage_type=<normal|pregnancy|lactation>
 * `nutrient` is optional — omit it to get every nutrient for the resolved
 * life stage. `life_stage` (a code from GET /dri/life-stages) takes
 * priority over age/sex if both are given.
 */
async function handleDriLookup(request, url) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const lifeStageCode = url.searchParams.get("life_stage");
  const nutrient = url.searchParams.get("nutrient");

  let stage;
  if (lifeStageCode) {
    stage = DRI_LIFE_STAGES.find((s) => s.code === lifeStageCode);
    if (!stage) {
      return err(`Unknown life_stage '${lifeStageCode}' — see GET /dri/life-stages for valid codes`);
    }
  } else {
    const age = url.searchParams.get("age");
    if (!age) {
      return err("Provide either 'life_stage' (a code from GET /dri/life-stages) or 'age' (years, plus 'sex' if age >= 9)");
    }
    const sex = url.searchParams.get("sex");
    const lifeStageType = url.searchParams.get("life_stage_type") || "normal";
    if (!["normal", "pregnancy", "lactation"].includes(lifeStageType)) {
      return err("'life_stage_type' must be one of: normal, pregnancy, lactation");
    }
    stage = resolveDriLifeStage(Number(age), sex, lifeStageType);
    if (!stage) {
      return err(
        "Could not resolve a life stage for that age/sex/life_stage_type combination — check 'age' is a valid number, 'sex' is 'male' or 'female' for age >= 9, and pregnancy/lactation are only defined from age 14 up"
      );
    }
  }

  const nutrientMap = DRI_VALUES[stage.code] || {};

  if (nutrient) {
    if (!DRI_NUTRIENT_META[nutrient]) {
      return err(`Unknown nutrient '${nutrient}' — see the 'nutrients' list on any /dri response for valid keys`);
    }
    const values = nutrientMap[nutrient];
    if (!values) {
      return success({
        life_stage: stage.code,
        life_stage_label: stage.label,
        nutrient: formatDriNutrientEntry(nutrient, {}),
        note: `No DRI value established for '${nutrient}' at this life stage`,
      });
    }
    return success({
      life_stage: stage.code,
      life_stage_label: stage.label,
      nutrient: formatDriNutrientEntry(nutrient, values),
    });
  }

  const nutrients = Object.entries(nutrientMap)
    .map(([key, values]) => formatDriNutrientEntry(key, values))
    .sort((a, b) => a.label.localeCompare(b.label));

  const amdrBucket = amdrBucketForAge(stage.age_min);
  const sodiumCdrr = sodiumCdrrForAge(stage.age_min);

  return success({
    life_stage: stage.code,
    life_stage_label: stage.label,
    nutrient_count: nutrients.length,
    nutrients,
    amdr: DRI_AMDR_BY_AGE_BUCKET[amdrBucket],
    sodium_chronic_disease_risk_reduction_mg: sodiumCdrr?.mg_per_day ?? null,
    additional_macronutrient_recommendations: DRI_ADDITIONAL_MACRO_RECOMMENDATIONS,
  });
}

/**
 * POST /dri/compare
 * Body: { age, sex?, life_stage_type?, life_stage?, intake: {nutrient_key: amount, ...} }
 * `intake` uses the same field names as /recipes/calculate and
 * /meals/analyze's total_nutrients (protein_g, calcium_mg, vitc_mg, ...) —
 * pipe either straight in. Only nutrients present in `intake` AND tracked
 * in DRI_NUTRIENT_META are compared; untrackable nutrients (thiamin,
 * vitamin E/K, most trace minerals — see GET /dri) are skipped since
 * intake data for them doesn't exist in CNR yet.
 */
async function handleDriCompare(request) {
  if (request.method !== "POST") return err("Method not allowed", 405);

  const body = await parseBody(request);
  const intake = body?.intake;
  if (!intake || typeof intake !== "object" || Array.isArray(intake)) {
    return err("'intake' is required — an object like {\"calcium_mg\": 850, \"iron_mg\": 12}, e.g. the total_nutrients from /meals/analyze");
  }

  let stage;
  if (body?.life_stage) {
    stage = DRI_LIFE_STAGES.find((s) => s.code === body.life_stage);
    if (!stage) return err(`Unknown life_stage '${body.life_stage}' — see GET /dri/life-stages for valid codes`);
  } else {
    if (body?.age == null) return err("Provide either 'life_stage' or 'age' (plus 'sex' if age >= 9)");
    const lifeStageType = body?.life_stage_type || "normal";
    if (!["normal", "pregnancy", "lactation"].includes(lifeStageType)) {
      return err("'life_stage_type' must be one of: normal, pregnancy, lactation");
    }
    stage = resolveDriLifeStage(Number(body.age), body?.sex, lifeStageType);
    if (!stage) {
      return err(
        "Could not resolve a life stage for that age/sex/life_stage_type — check 'age' is a valid number, 'sex' is 'male' or 'female' for age >= 9, and pregnancy/lactation are only defined from age 14 up"
      );
    }
  }

  const nutrientMap = DRI_VALUES[stage.code] || {};
  const results = [];
  const skipped = [];

  for (const [key, rawAmount] of Object.entries(intake)) {
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount)) continue;

    const meta = DRI_NUTRIENT_META[key];
    if (!meta) {
      skipped.push({ nutrient: key, reason: "not a recognized DRI nutrient key" });
      continue;
    }
    const values = nutrientMap[key];
    if (!values || (values.rda == null && values.ai == null)) {
      skipped.push({ nutrient: key, reason: "no RDA/AI established for this nutrient at this life stage" });
      continue;
    }

    const target = values.rda ?? values.ai;
    const targetType = values.rda != null ? "rda" : "ai";
    const percentOfTarget = target > 0 ? Math.round((amount / target) * 1000) / 10 : null;
    const exceedsUl = values.ul != null && amount > values.ul;

    results.push({
      nutrient: key,
      label: meta.label,
      unit: meta.unit,
      intake: amount,
      target,
      target_type: targetType,
      percent_of_target: percentOfTarget,
      ul: values.ul ?? null,
      exceeds_ul: exceedsUl,
    });
  }

  results.sort((a, b) => a.label.localeCompare(b.label));

  return success({
    life_stage: stage.code,
    life_stage_label: stage.label,
    nutrients_compared: results.length,
    results,
    ...(skipped.length ? { skipped } : {}),
  });
}

/**
 * Shared by POST /recipes/calculate and POST /meals/analyze: resolves a
 * raw ingredients[] array from a request body into scaled-nutrient rows.
 * See handleRecipesCalculate's doc comment below for the resolution order
 * (food_id exact / local ilike+pickBestFoodMatch / external cascade
 * fallback) and unit handling (resolveIngredientGrams). Returns
 * { resolvedIngredients, unresolvedIngredients } — never throws on a bad
 * individual ingredient, only on a malformed list (caller's job to check).
 */
async function resolveIngredientsList(ingredients, db, env) {
  const resolvedIngredients = [];
  const unresolvedIngredients = [];

  for (const item of ingredients) {
    const quantity = Number(item?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      unresolvedIngredients.push({ input: item, reason: "missing or invalid 'quantity'" });
      continue;
    }

    let food = null;
    let matchedSource = null;

    if (item.food_id != null) {
      const { ok, body } = await db.selectOne("foods", item.food_id);
      if (ok && body) {
        food = body;
        matchedSource = "food_id";
      }
    } else if (item.food_name) {
      const local = await db.select("foods", {
        filters: { food_name: `ilike.*${escapeLikePattern(item.food_name)}*` },
        limit: 25,
      });
      const bestLocal = local.ok ? pickBestFoodMatch(local.body, item.food_name) : null;
      if (bestLocal) {
        food = bestLocal;
        matchedSource = "local";
      } else {
        const cascade = await lookupFoodCascade(db, { query: item.food_name }, env);
        if (cascade?.food) {
          food = cascade.food;
          matchedSource = cascade.source;
        }
      }
    } else {
      unresolvedIngredients.push({ input: item, reason: "provide either 'food_id' or 'food_name'" });
      continue;
    }

    if (!food) {
      unresolvedIngredients.push({ input: item, reason: "food not found (checked local data and external sources)" });
      continue;
    }

    const gramsResult = resolveIngredientGrams(food, quantity, item.unit);
    if (gramsResult.grams == null) {
      unresolvedIngredients.push({ input: item, reason: gramsResult.reason });
      continue;
    }

    const scale = gramsResult.grams / 100;
    const nutrients = {};
    for (const field of SERVING_SCALE_FIELDS) {
      if (food[field] != null && food[field] !== "") {
        nutrients[field] = roundServingVal(Number(food[field]) * scale);
      }
    }

    resolvedIngredients.push({
      food_name: food.food_name || food.product_name || item.food_name || null,
      matched_source: matchedSource,
      // Same reasoning as buildServingSizes() above — classify from the
      // name via our own taxonomy rather than trusting food.category,
      // which uses a different vocabulary (see comment there).
      category: classifyCategory(food.food_name || food.product_name || ""),
      quantity,
      unit: item.unit || "g",
      grams: roundServingVal(gramsResult.grams),
      grams_basis: gramsResult.basis,
      nutrients,
    });
  }

  return { resolvedIngredients, unresolvedIngredients };
}

/** Sums a nutrient field across resolved ingredients — null if none contributed a value. */
function sumNutrientField(resolvedIngredients, field) {
  let sum = null;
  for (const ing of resolvedIngredients) {
    if (ing.nutrients[field] != null) sum = (sum ?? 0) + ing.nutrients[field];
  }
  return sum == null ? null : roundServingVal(sum);
}

/**
 * POST /recipes/calculate
 * Body: { servings?: number, ingredients: [{ food_id? | food_name, quantity, unit? }] }
 * unit defaults to "g" (i.e. quantity is already grams) when omitted.
 * food_name resolution: local `foods` table first (ilike), then the same
 * local->external lookupFoodCascade() used by /foods/lookup — so an
 * ingredient not in the local FCT can still resolve via USDA/OFF/FatSecret.
 * Purely additive/computational — writes nothing, no auth required.
 */
async function handleRecipesCalculate(request, db, env) {
  const payload = await parseBody(request);
  if (!payload || !Array.isArray(payload.ingredients) || !payload.ingredients.length) {
    return err("'ingredients' array is required — each item: {food_name or food_id, quantity, unit?}");
  }
  const servingsRaw = Number(payload.servings);
  const servings = Number.isFinite(servingsRaw) && servingsRaw > 0 ? servingsRaw : 1;

  const { resolvedIngredients, unresolvedIngredients } = await resolveIngredientsList(payload.ingredients, db, env);

  const totalNutrients = {};
  for (const field of SERVING_SCALE_FIELDS) {
    const sum = sumNutrientField(resolvedIngredients, field);
    if (sum != null) totalNutrients[field] = sum;
  }

  const totalGrams = resolvedIngredients.reduce((s, ing) => s + ing.grams, 0);
  const nutrientsPerServing = {};
  for (const [field, value] of Object.entries(totalNutrients)) {
    nutrientsPerServing[field] = roundServingVal(value / servings);
  }

  return success({
    servings,
    total_grams: roundServingVal(totalGrams),
    grams_per_serving: roundServingVal(totalGrams / servings),
    total_nutrients: totalNutrients,
    nutrients_per_serving: nutrientsPerServing,
    ingredients: resolvedIngredients,
    unresolved_ingredients: unresolvedIngredients,
  });
}

// ─── MEAL ANALYSIS ──────────────────────────────────────────────────────────
//
// Builds on the same ingredient resolution as Recipe Nutrition Calculation,
// but frames the result around a single eaten meal rather than a recipe
// yield: macronutrient % of calories, which of the core food groups are
// present/absent, and — only where the standard Institute of Medicine AMDR
// ranges or caller-supplied targets are being compared against — how the
// meal's numbers sit relative to them. Everything here is descriptive
// (what's in the meal, how it compares to a standard reference range),
// never a personalized recommendation — an actual EER/macro target should
// come from a clinician or the calling app's own calculation (e.g. the
// Harris-Benedict tools in chakudya-mcp-server) and be passed in via
// `daily_targets`, not inferred here from age/sex/weight.

// Institute of Medicine Acceptable Macronutrient Distribution Range for
// adults — the standard reference for "is this meal's macro split in a
// typical/reasonable range", independent of any individual's targets.
const AMDR_ADULT = {
  protein: { min_percent: 10, max_percent: 35 },
  carbs: { min_percent: 45, max_percent: 65 },
  fat: { min_percent: 20, max_percent: 35 },
};

// The food groups a "complete" plate is generally built from, for the
// food_groups_present/missing check — matches the categories already used
// by classifyCategory()/CATEGORY_SERVING_DEFAULTS above. Fats & Oils,
// Sweets & Snacks, Beverages, and Nuts & Seeds are tracked in
// food_groups_present when they occur, but aren't part of this core set —
// their absence isn't flagged as "missing".
const CORE_FOOD_GROUPS = ["Grains", "Legumes", "Protein", "Vegetables", "Fruits", "Dairy"];

// ─── CLINICAL CONDITION FLAGS ───────────────────────────────────────────────
//
// Per-meal screening against a handful of conditions, evaluated straight off
// the same resolved-ingredient nutrient totals /meals/analyze already
// computes — no extra lookups, no invented daily targets. These are
// meal-level screening flags for a dietitian/patient to weigh, not a
// diagnosis or a substitute for an individualized prescription (a CKD
// patient's protein allowance depends on their weight and stage, a
// diabetic's carb target on their own plan, etc.) — each flag's `note` says
// so explicitly.
//
// Thresholds are meal-level (roughly a third to a quarter of commonly-cited
// daily limits), sourced from standard references (ADA carb-counting
// guidance, DASH/AHA sodium targets, KDOQI conservative-CKD guidance) rather
// than any single patient's prescription. Two known gaps, called out in each
// flag's `note` rather than silently ignored:
//   - phosphorus isn't in the local `foods` schema, so kidney-disease
//     phosphorus screening isn't possible from meal data alone — cross-check
//     against the renal exchange list (GET /renal-foods, or /rag/ask with
//     context=clinical) for phosphorus-specific guidance.
//   - CKD protein/potassium limits vary hugely by dialysis status and stage;
//     the flag here is "this meal's protein/potassium looks high relative to
//     a *typical* restricted diet", not a per-patient verdict.

const CLINICAL_CONDITIONS = ["diabetes", "hypertension", "kidney_disease", "pregnancy", "paediatric", "anaemia", "food_allergy"];

// Three-tier flag from a single nutrient value against caution/avoid
// cutoffs — null propagates (missing data means "can't say", not "fine").
function flagLevel(value, cautionAt, avoidAt) {
  if (value == null) return null;
  if (value >= avoidAt) return "avoid";
  if (value >= cautionAt) return "caution";
  return "appropriate";
}

function evaluateDiabetes(totalNutrients) {
  const carbs = totalNutrients.carbs_g ?? null;
  const fiber = totalNutrients.fiber_g ?? null;
  const reasons = [];
  // ADA carb-counting guidance commonly starts patients around 45-60g
  // carbohydrate per meal; 75g+ in one sitting is a large single-meal load.
  const level = flagLevel(carbs, 60, 75);
  if (level == null) {
    reasons.push("Carbohydrate content unknown for one or more ingredients — flag is incomplete.");
  } else {
    reasons.push(
      `Meal carries ${roundServingVal(carbs)}g carbohydrate (a common per-meal starting target is ~45-60g — adjust to the individual's own carb-counting plan).`
    );
    if (fiber != null && carbs > 0) {
      const fiberRatio = fiber / carbs;
      reasons.push(
        fiberRatio < 0.1
          ? `Low fiber relative to carbs (${roundServingVal(fiber)}g) — refined-carb meals raise blood glucose faster; pairing with more fiber or protein slows the rise.`
          : `Fiber-to-carb ratio is reasonable (${roundServingVal(fiber)}g fiber), which helps blunt the glycemic response.`
      );
    }
  }
  return {
    condition: "diabetes",
    flag: level,
    reasons,
    note: "Screening only — carb totals don't capture glycemic index/load or the individual's own carb-counting target. Confirm against the patient's prescribed plan.",
  };
}

function evaluateHypertension(totalNutrients) {
  const sodium = totalNutrients.sodium_mg ?? null;
  const potassium = totalNutrients.potassium_mg ?? null;
  const reasons = [];
  // DASH targets ~1500-2300mg sodium/day; roughly a third of that per meal
  // is a reasonable per-meal ceiling for a three-meal day.
  const level = flagLevel(sodium, 400, 700);
  if (level == null) {
    reasons.push("Sodium content unknown for one or more ingredients — flag is incomplete.");
  } else {
    reasons.push(`Meal carries ${roundServingVal(sodium)}mg sodium (DASH guidance targets 1500-2300mg/day total).`);
  }
  if (potassium != null) {
    reasons.push(`${roundServingVal(potassium)}mg potassium — DASH favors potassium-rich meals (fruit, vegetables, legumes) alongside the sodium limit.`);
  }
  return {
    condition: "hypertension",
    flag: level,
    reasons,
    note: "Sodium-focused DASH screening — doesn't account for a clinician-set sodium limit stricter than DASH, or potassium-sparing diuretics, where high-potassium meals need their own caution.",
  };
}

function evaluateKidneyDisease(totalNutrients) {
  const potassium = totalNutrients.potassium_mg ?? null;
  const sodium = totalNutrients.sodium_mg ?? null;
  const protein = totalNutrients.protein_g ?? null;
  const reasons = [];
  // Conservative (non-dialysis) CKD potassium limits often run
  // 2000-3000mg/day total — a per-meal share of that is much tighter than
  // the general-population DASH sodium ceiling reused here for sodium.
  const potassiumLevel = flagLevel(potassium, 700, 1000);
  const sodiumLevel = flagLevel(sodium, 400, 700);
  const levels = [potassiumLevel, sodiumLevel].filter((l) => l != null);
  const worst = levels.includes("avoid") ? "avoid" : levels.includes("caution") ? "caution" : levels.length ? "appropriate" : null;

  reasons.push(
    potassium != null
      ? `${roundServingVal(potassium)}mg potassium (conservative CKD limits often run 2000-3000mg/day total, stage-dependent).`
      : "Potassium content unknown for one or more ingredients — flag is incomplete."
  );
  if (sodium != null) reasons.push(`${roundServingVal(sodium)}mg sodium.`);
  if (protein != null && protein > 30) {
    reasons.push(
      `${roundServingVal(protein)}g protein is high for a single meal on a protein-restricted CKD diet (typical restriction: 0.6-0.8g/kg/day) — check against the patient's prescribed protein target.`
    );
  }
  reasons.push("Phosphorus isn't tracked in the local food data — cross-check against the renal exchange list for phosphorus-specific guidance.");

  return {
    condition: "kidney_disease",
    flag: worst,
    reasons,
    note: "Non-dialysis conservative-management screening (potassium/sodium/protein only, no phosphorus). Dialysis patients have different, often opposite, fluid/potassium/protein targets — always confirm against the patient's stage and dialysis status.",
  };
}

const CONDITION_EVALUATORS = {
  diabetes: (ctx) => evaluateDiabetes(ctx.totalNutrients),
  hypertension: (ctx) => evaluateHypertension(ctx.totalNutrients),
  kidney_disease: (ctx) => evaluateKidneyDisease(ctx.totalNutrients),
  pregnancy: (ctx) => evaluatePregnancy(ctx.totalNutrients, ctx.age),
  paediatric: (ctx) => evaluatePaediatric(ctx.totalNutrients, ctx.age, ctx.sex),
  anaemia: (ctx) => evaluateAnaemia(ctx.totalNutrients, ctx.age, ctx.sex),
  food_allergy: (ctx) => evaluateFoodAllergy(ctx.resolvedIngredients, ctx.unresolvedIngredients, ctx.allergens),
};

// ── Adequacy screening (pregnancy / paediatric / anaemia) ──────────────────
//
// Different shape from the diabetes/hypertension/kidney-disease flags above:
// those ask "is this meal too much of something", these ask "does this meal
// meaningfully contribute toward a nutrient the person needs more of" — so
// they get their own three-tier vocabulary (good/low/very_low) rather than
// reusing appropriate/caution/avoid, which would misleadingly imply a low-X
// meal is somehow unsafe rather than just not a big contributor.
//
// All three reuse Chakudya's own DRI system (src/dri_data.js — the same
// data GET /dri and POST /dri/compare already serve) rather than
// hand-picked numbers, so "per-meal share" here is always the actual
// NASEM/IOM RDA/AI for the resolved life stage, divided evenly across 3
// meals/day. That "÷3" is a simplification — real days include snacks, and
// prenatal/paediatric vitamins aren't accounted for at all — spelled out in
// each flag's `note` rather than presented as a precise daily read.

function adequacyLevel(percentOfPerMealShare) {
  if (percentOfPerMealShare == null) return null;
  if (percentOfPerMealShare >= 80) return "good";
  if (percentOfPerMealShare >= 40) return "low";
  return "very_low";
}

const ADEQUACY_RANK = { very_low: 0, low: 1, good: 2 };

/** Shared per-nutrient adequacy check against a resolved DRI life stage's RDA/AI, split 3 ways. */
function checkAdequacy(totalNutrients, stage, nutrientKeys) {
  const nutrientMap = DRI_VALUES[stage.code] || {};
  const reasons = [];
  const levels = [];

  for (const key of nutrientKeys) {
    const meta = DRI_NUTRIENT_META[key];
    const values = nutrientMap[key];
    const target = values?.rda ?? values?.ai ?? null;
    if (target == null) {
      reasons.push(`No RDA/AI established for ${meta?.label || key} at this life stage — skipped.`);
      continue;
    }
    const perMealShare = target / 3;
    const amount = totalNutrients[key] ?? 0;
    const percent = perMealShare > 0 ? roundServingVal((amount / perMealShare) * 100) : null;
    const level = adequacyLevel(percent);
    if (level) levels.push(level);
    reasons.push(
      `${meta?.label || key}: ${roundServingVal(amount)}${(meta?.unit || "").replace("/d", "")} — ${percent}% of a per-meal share of the ${stage.label} target (${target}${meta?.unit || ""} ÷ 3 meals/day).`
    );
  }

  const overall = levels.length ? levels.reduce((worst, l) => (ADEQUACY_RANK[l] < ADEQUACY_RANK[worst] ? l : worst)) : null;
  return { overall, reasons };
}

function evaluatePregnancy(totalNutrients, ageInput) {
  const assumedAge = ageInput == null;
  const age = assumedAge ? 24 : Number(ageInput);
  const stage = resolveDriLifeStage(age, "female", "pregnancy");
  if (!stage) {
    return {
      condition: "pregnancy",
      flag: null,
      reasons: [`Could not resolve a pregnancy DRI life stage for age ${age} — pregnancy DRI values are only defined from age 14 up.`],
      note: "Pass 'age' (14+) in the request body for an age-matched life stage.",
    };
  }

  const { overall, reasons } = checkAdequacy(totalNutrients, stage, ["iron_mg", "folate_mcg", "calcium_mg", "protein_g"]);
  if (assumedAge) reasons.unshift(`No 'age' supplied — assumed ${age} (${stage.label}); pass 'age' for a precise match.`);

  return {
    condition: "pregnancy",
    flag: overall,
    reasons,
    note: "Screens this one meal's contribution toward iron/folate/calcium/protein needs in pregnancy, evenly split across 3 meals/day — a single low-scoring meal isn't itself a problem if the rest of the day makes up for it, and this doesn't account for prenatal vitamin supplementation, which covers most of the gap in practice.",
  };
}

function evaluatePaediatric(totalNutrients, ageInput, sexInput) {
  if (ageInput == null) {
    return {
      condition: "paediatric",
      flag: null,
      reasons: ["'age' is required for paediatric screening — nutrient needs vary hugely between a toddler and a teenager."],
      note: "Pass 'age' (years) — and 'sex' ('male'/'female') for age 9 and up — in the request body.",
    };
  }
  const age = Number(ageInput);
  if (age >= 18) {
    return {
      condition: "paediatric",
      flag: null,
      reasons: [`Paediatric screening covers ages under 18 — for age ${age}, use GET/POST /dri directly for adult reference values.`],
      note: "Not applicable at this age.",
    };
  }
  const stage = resolveDriLifeStage(age, sexInput, "normal");
  if (!stage) {
    return {
      condition: "paediatric",
      flag: null,
      reasons: [`Could not resolve a life stage for age ${age}${sexInput ? `, sex ${sexInput}` : ""} — for ages 9 and up, 'sex' ('male' or 'female') is required.`],
      note: "Pass 'sex' in the request body.",
    };
  }

  const { overall, reasons } = checkAdequacy(totalNutrients, stage, ["protein_g", "iron_mg", "calcium_mg", "vitd_mcg"]);

  return {
    condition: "paediatric",
    flag: overall,
    reasons,
    note: `Screens this one meal against ${stage.label} targets (protein/iron/calcium/vitamin D), evenly split across 3 meals/day — younger children often eat smaller, more frequent meals plus snacks, so treat this as a rough share rather than a strict per-meal rule.`,
  };
}

function evaluateAnaemia(totalNutrients, ageInput, sexInput) {
  const assumedSex = !sexInput;
  const sex = sexInput === "male" ? "male" : "female"; // default to the higher (female) iron requirement — the more sensitive assumption when sex isn't given
  const assumedAge = ageInput == null;
  const age = assumedAge ? 30 : Number(ageInput);
  const stage = resolveDriLifeStage(age, sex, "normal") || resolveDriLifeStage(30, sex, "normal");

  const { overall, reasons } = checkAdequacy(totalNutrients, stage, ["iron_mg", "vitb12_mcg", "folate_mcg"]);
  if (assumedAge || assumedSex) {
    reasons.unshift(
      `${assumedSex ? "No 'sex' supplied — assumed female (higher iron requirement)." : ""}${assumedSex && assumedAge ? " " : ""}${assumedAge ? `No 'age' supplied — assumed ${age} (${stage.label}).` : ""}`.trim()
    );
  }

  const vitc = totalNutrients.vitc_mg ?? null;
  const iron = totalNutrients.iron_mg ?? null;
  if (iron != null && iron > 0) {
    reasons.push(
      vitc != null && vitc >= 20
        ? `${roundServingVal(vitc)}mg vitamin C alongside the iron helps non-heme iron absorption.`
        : "No meaningful vitamin C in this meal — pairing iron-rich foods with a vitamin-C source (citrus, tomato, etc.) improves non-heme iron absorption."
    );
  }

  return {
    condition: "anaemia",
    flag: overall,
    reasons,
    note: "Anaemia has multiple causes (iron deficiency is the most diet-modifiable, but B12/folate deficiency, chronic disease, and other non-dietary causes also apply) — this only screens one meal's iron/B12/folate contribution against standard adult DRI values. Not a diagnosis, and doesn't replace a CBC/ferritin workup.",
  };
}

// ── Food allergy screening ──────────────────────────────────────────────────
//
// No allergen-tag column exists on `foods`/`packaged_foods` yet (see the
// gap called out in /drug-interactions' kidney-disease note's sibling
// discussion), so this is a best-effort keyword match against each resolved
// ingredient's food_name — not a verified allergen database. It will miss
// allergens hidden inside a composite/packaged product's actual ingredient
// list and can't catch cross-contamination.

const ALLERGEN_KEYWORDS = {
  peanut: ["peanut", "peanuts", "groundnut", "groundnuts"],
  tree_nut: ["cashew", "almond", "walnut", "pecan", "pistachio", "hazelnut", "macadamia"],
  dairy: ["milk", "cheese", "yogurt", "yoghurt", "butter", "cream", "whey", "casein", "ghee"],
  egg: ["egg", "eggs", "mayonnaise"],
  soy: ["soy", "soya", "soybean", "tofu"],
  wheat_gluten: ["wheat", "flour", "bread", "pasta", "macaroni", "semolina", "barley", "rye", "gluten"],
  fish: ["fish", "tuna", "salmon", "sardine", "chambo", "usipa", "kapenta", "mackerel", "tilapia"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "crayfish", "mussel", "oyster", "clam", "squid", "calamari"],
  sesame: ["sesame", "tahini"],
};

function evaluateFoodAllergy(resolvedIngredients, unresolvedIngredients, allergens) {
  // Checks both — a food that failed to resolve (no nutrient match found)
  // still has a name, and that name can still contain an allergen. Silently
  // skipping unresolved ingredients here would be a real safety gap, not
  // just a data gap, so they're scanned by name and called out separately
  // in the reason when they're the only match.
  const namedItems = [
    ...(resolvedIngredients || []).map((ing) => ({ name: ing.food_name, resolved: true })),
    ...(unresolvedIngredients || []).map((ing) => ({ name: ing.input?.food_name || ing.input?.food_id, resolved: false })),
  ].filter((i) => i.name);

  const results = [];
  for (const allergen of allergens) {
    const keywords = ALLERGEN_KEYWORDS[allergen] || [];
    const matched = namedItems.filter((item) => keywords.some((kw) => String(item.name).toLowerCase().includes(kw)));
    results.push({
      allergen,
      detected: matched.length > 0,
      matched_ingredients: matched.map((m) => (m.resolved ? m.name : `${m.name} (unresolved — nutrient data unavailable, matched by name only)`)),
    });
  }

  const anyDetected = results.some((r) => r.detected);
  const reasons = results.map((r) =>
    r.detected
      ? `${r.allergen}: detected in ${r.matched_ingredients.join(", ")}.`
      : `${r.allergen}: not detected by name in this meal's ingredients.`
  );
  if ((unresolvedIngredients || []).length) {
    reasons.push(`${unresolvedIngredients.length} ingredient(s) didn't resolve to a nutrient match but were still checked by name for allergens.`);
  }

  return {
    condition: "food_allergy",
    flag: anyDetected ? "avoid" : "appropriate",
    reasons,
    note: "Name-based keyword matching against ingredient names only — not a verified allergen database. Can't catch hidden allergens inside composite/packaged products, cross-contamination, or allergens outside the tracked list. Always check the product label directly for packaged foods.",
  };
}

/**
 * POST /meals/analyze
 * Body: { meal_type?: string, ingredients: [{ food_id? | food_name, quantity, unit? }], daily_targets?: {kcal, protein_g, carbs_g, fat_g}, conditions?: string[], age?: number, sex?: "male"|"female", allergens?: string[] }
 * Same ingredient resolution as /recipes/calculate (resolveIngredientsList)
 * — no `servings` concept here, a meal is just eaten once. Adds:
 *   - macronutrient_breakdown: kcal from protein/carbs/fat (Atwater
 *     4/4/9 kcal-per-gram factors) and each as a % of total meal kcal,
 *     plus whether each % falls inside AMDR_ADULT (informational only).
 *   - food_groups_present / food_groups_missing, from CORE_FOOD_GROUPS.
 *   - daily_target_comparison: only included if the caller supplies
 *     `daily_targets` — this endpoint never invents personalized targets.
 *   - clinical_flags: only included if the caller supplies `conditions`,
 *     any subset of:
 *       "diabetes" | "hypertension" | "kidney_disease" — excess-focused
 *         (appropriate/caution/avoid), meal-level thresholds only.
 *       "pregnancy" | "paediatric" | "anaemia" — adequacy-focused
 *         (good/low/very_low), driven by Chakudya's own DRI system
 *         (src/dri_data.js). Optional shared `age`/`sex` fields narrow the
 *         life stage used; `paediatric` requires `age` (and `sex` for 9+).
 *       "food_allergy" — requires an `allergens` array (see
 *         ALLERGEN_KEYWORDS for the supported list); name-based keyword
 *         match against resolved ingredient names, not a verified
 *         allergen database.
 *     See CONDITION_EVALUATORS above. Screening, not a diagnosis or a
 *     personalized prescription.
 * Purely additive/computational — writes nothing, no auth required.
 */
async function handleMealsAnalyze(request, db, env) {
  const payload = await parseBody(request);
  if (!payload || !Array.isArray(payload.ingredients) || !payload.ingredients.length) {
    return err("'ingredients' array is required — each item: {food_name or food_id, quantity, unit?}");
  }

  let requestedConditions = [];
  if (payload.conditions !== undefined) {
    if (!Array.isArray(payload.conditions)) {
      return err("'conditions' must be an array of condition names");
    }
    const invalid = payload.conditions.filter((c) => !CLINICAL_CONDITIONS.includes(c));
    if (invalid.length) {
      return err(`Unknown condition(s): ${invalid.join(", ")} — supported: ${CLINICAL_CONDITIONS.join(", ")}`);
    }
    requestedConditions = [...new Set(payload.conditions)];
  }

  if (requestedConditions.includes("food_allergy")) {
    if (!Array.isArray(payload.allergens) || !payload.allergens.length) {
      return err(`'allergens' array is required when 'conditions' includes 'food_allergy' — supported: ${Object.keys(ALLERGEN_KEYWORDS).join(", ")}`);
    }
    const invalidAllergens = payload.allergens.filter((a) => !ALLERGEN_KEYWORDS[a]);
    if (invalidAllergens.length) {
      return err(`Unknown allergen(s): ${invalidAllergens.join(", ")} — supported: ${Object.keys(ALLERGEN_KEYWORDS).join(", ")}`);
    }
  }

  const { resolvedIngredients, unresolvedIngredients } = await resolveIngredientsList(payload.ingredients, db, env);

  const totalNutrients = {};
  for (const field of SERVING_SCALE_FIELDS) {
    const sum = sumNutrientField(resolvedIngredients, field);
    if (sum != null) totalNutrients[field] = sum;
  }
  const totalGrams = resolvedIngredients.reduce((s, ing) => s + ing.grams, 0);

  // Macronutrient breakdown — Atwater factors: 4 kcal/g protein, 4 kcal/g
  // carbs, 9 kcal/g fat. Falls back to summing these three (rather than
  // using total_nutrients.kcal directly) so the percentages always sum to
  // ~100% even if the food rows' own kcal figure was rounded independently.
  const proteinKcal = (totalNutrients.protein_g ?? 0) * 4;
  const carbsKcal = (totalNutrients.carbs_g ?? 0) * 4;
  const fatKcal = (totalNutrients.fat_g ?? 0) * 9;
  const macroKcalSum = proteinKcal + carbsKcal + fatKcal;

  const percentOf = (kcal) => (macroKcalSum > 0 ? roundServingVal((kcal / macroKcalSum) * 100) : null);
  const withinAmdr = (percent, range) => (percent == null ? null : percent >= range.min_percent && percent <= range.max_percent);

  const percentProtein = percentOf(proteinKcal);
  const percentCarbs = percentOf(carbsKcal);
  const percentFat = percentOf(fatKcal);

  const macronutrientBreakdown = {
    kcal_from_protein: roundServingVal(proteinKcal),
    kcal_from_carbs: roundServingVal(carbsKcal),
    kcal_from_fat: roundServingVal(fatKcal),
    percent_kcal_from_protein: percentProtein,
    percent_kcal_from_carbs: percentCarbs,
    percent_kcal_from_fat: percentFat,
    within_amdr_adult_reference: {
      protein: withinAmdr(percentProtein, AMDR_ADULT.protein),
      carbs: withinAmdr(percentCarbs, AMDR_ADULT.carbs),
      fat: withinAmdr(percentFat, AMDR_ADULT.fat),
    },
  };

  const categoriesPresent = [...new Set(resolvedIngredients.map((ing) => ing.category).filter(Boolean))];
  const foodGroupsMissing = CORE_FOOD_GROUPS.filter((g) => !categoriesPresent.includes(g));

  const result = {
    meal_type: payload.meal_type || null,
    total_grams: roundServingVal(totalGrams),
    total_nutrients: totalNutrients,
    macronutrient_breakdown: macronutrientBreakdown,
    food_groups_present: categoriesPresent,
    food_groups_missing: foodGroupsMissing,
    ingredients: resolvedIngredients,
    unresolved_ingredients: unresolvedIngredients,
  };

  // daily_target_comparison is opt-in only — this endpoint never invents a
  // personalized target itself (see block comment above).
  if (payload.daily_targets && typeof payload.daily_targets === "object") {
    const comparison = {};
    for (const field of ["kcal", "protein_g", "carbs_g", "fat_g"]) {
      const target = Number(payload.daily_targets[field]);
      if (Number.isFinite(target) && target > 0) {
        const consumed = totalNutrients[field] ?? 0;
        comparison[field] = {
          consumed,
          target,
          percent_of_target: roundServingVal((consumed / target) * 100),
        };
      }
    }
    if (Object.keys(comparison).length) result.daily_target_comparison = comparison;
  }

  if (requestedConditions.length) {
    const ctx = {
      totalNutrients,
      resolvedIngredients,
      unresolvedIngredients,
      age: payload.age,
      sex: payload.sex,
      allergens: payload.allergens,
    };
    result.clinical_flags = requestedConditions.map((c) => CONDITION_EVALUATORS[c](ctx));
  }

  return success(result);
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

/**
 * Picks which FatSecret `serving` element to use as the per-100g/ml basis.
 * Prefers an exact "100 g"/"100 ml" serving if the response includes one
 * (common — food.find_id_for_barcode.v2 often derives one); otherwise
 * falls back to the flagged default serving (or the first one) and
 * returns a scale factor to bring it to a per-100 basis.
 */
function pickFatSecretServing(servings) {
  const list = Array.isArray(servings) ? servings : servings ? [servings] : [];
  if (!list.length) return null;

  const isGramsOrMl = (s) => s.metric_serving_unit === "g" || s.metric_serving_unit === "ml";

  const per100 = list.find((s) => isGramsOrMl(s) && parseFloat(s.metric_serving_amount) === 100);
  if (per100) return { serving: per100, scale: 1 };

  const chosen = list.find((s) => String(s.is_default) === "1") || list[0];
  const amount = parseFloat(chosen?.metric_serving_amount);
  if (!chosen || !amount || !isGramsOrMl(chosen)) return null;
  return { serving: chosen, scale: 100 / amount };
}

/**
 * Barcode lookup via FatSecret's Premier-exclusive food.find_id_for_barcode.v2
 * — returns the full food object (name, brand, servings with nutrition) in
 * one call, no follow-up food.get needed. Requires the "barcode" scope,
 * which comes with a Premier/Premier Free plan (see the README's FatSecret
 * setup note) — a Basic/free-tier key gets error 14 "Missing scope" and
 * this just returns null, same as any other lookup miss.
 */
async function fetchFromFatSecretBarcode(barcode, env) {
  if (!barcode || !env.FATSECRET_CONSUMER_KEY || !env.FATSECRET_CONSUMER_SECRET) return null;

  // FatSecret requires GTIN-13 — left-pad UPC-A (12 digits) / EAN-8 (8
  // digits) with zeros. Strip anything non-digit first (defensive).
  const gtin13 = barcode.replace(/\D/g, "").padStart(13, "0").slice(-13);

  const signedUrl = await signFatSecretRequest(
    { method: "food.find_id_for_barcode.v2", barcode: gtin13, flag_default_serving: "true", format: "json" },
    env.FATSECRET_CONSUMER_KEY,
    env.FATSECRET_CONSUMER_SECRET
  );

  const res = await fetch(signedUrl);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  // Error 211 = "No food item detected" for this barcode; missing scope
  // (14) or any other error also just falls through to the next source.
  const food = data?.food;
  if (!food || data?.error) return null;

  const picked = pickFatSecretServing(food.servings?.serving);
  if (!picked) return null;
  const { serving, scale } = picked;

  const scaleVal = (n) => (n == null || n === "" ? null : Math.round(parseFloat(n) * scale * 100) / 100);

  return normalizeFood("fatsecret", {
    food_name: food.food_name,
    energy_kcal: scaleVal(serving.calories),
    protein_g: scaleVal(serving.protein),
    fat_g: scaleVal(serving.fat),
    carbs_g: scaleVal(serving.carbohydrate),
    barcode,
    external_id: food.food_id,
    raw_data: {
      food_id: food.food_id,
      food_type: food.food_type ?? null,
      brand_name: food.brand_name ?? null,
      food_url: food.food_url ?? null,
      serving_basis: `${serving.metric_serving_amount}${serving.metric_serving_unit}`,
      scaled_to_100: scale !== 1,
    },
  });
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

/**
 * FatSecret's Premier-exclusive foods.autocomplete.v2 — up to `maxResults`
 * (max 10, FatSecret-enforced) suggested search expressions for a partial
 * query, e.g. "chic" -> ["chicken", "chicken breast", ...]. Returns null
 * (not []) when the credentials aren't configured, so callers can tell
 * "not set up" apart from "no suggestions found".
 */
async function fetchFatSecretAutocomplete(expression, maxResults, env) {
  if (!env.FATSECRET_CONSUMER_KEY || !env.FATSECRET_CONSUMER_SECRET) return null;

  const signedUrl = await signFatSecretRequest(
    { method: "foods.autocomplete.v2", expression, max_results: String(maxResults), format: "json" },
    env.FATSECRET_CONSUMER_KEY,
    env.FATSECRET_CONSUMER_SECRET
  );

  const res = await fetch(signedUrl);
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  // FatSecret's JSON quirk: a single result comes back as a bare string,
  // not a 1-element array.
  const raw = data?.suggestions?.suggestion;
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * FatSecret's Premier-exclusive food_categories.get.v2 — the full,
 * near-static list of food categories (id/name/description). Same
 * null-vs-empty-array convention as fetchFatSecretAutocomplete above.
 */
async function fetchFatSecretCategories(env) {
  if (!env.FATSECRET_CONSUMER_KEY || !env.FATSECRET_CONSUMER_SECRET) return null;

  const signedUrl = await signFatSecretRequest(
    { method: "food_categories.get.v2", format: "json" },
    env.FATSECRET_CONSUMER_KEY,
    env.FATSECRET_CONSUMER_SECRET
  );

  const res = await fetch(signedUrl);
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const raw = data?.food_categories?.food_category;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map((c) => ({
    id: c.food_category_id,
    name: c.food_category_name,
    description: c.food_category_description ?? null,
  }));
}

// GET /foods/autocomplete?q=...&max_results=...
async function handleFoodsAutocomplete(request, url, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const expression = (url.searchParams.get("q") || url.searchParams.get("expression") || "").trim();
  if (!expression) return err("'q' query param is required");

  const maxResults = Math.min(Math.max(intParam(url, "max_results", 4), 1), 10);

  const suggestions = await fetchFatSecretAutocomplete(expression, maxResults, env);
  if (suggestions === null) {
    return err("Autocomplete isn't configured on this deployment (FatSecret credentials missing)", 503);
  }
  return success(suggestions);
}

// GET /foods/categories
async function handleFoodsCategories(request, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const categories = await fetchFatSecretCategories(env);
  if (categories === null) {
    return err("Food categories aren't configured on this deployment (FatSecret credentials missing)", 503);
  }
  return success(categories);
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

  // 3. External APIs, in order. Barcode lookups try Open Food Facts first
  // (better community/international coverage), then FatSecret's
  // Premier-exclusive barcode lookup as a fallback; name searches go
  // USDA -> FatSecret.
  let result = null;
  if (barcode) result = await fetchFromOpenFoodFacts(barcode, env);
  if (!result && barcode) result = await fetchFromFatSecretBarcode(barcode, env);
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
  // ── DELETE /rag/source?source=... ──────────────────────────────────────────
  // Bulk-removes every chunk with a matching 'source' string. /rag/ingest only
  // ever inserts (never upserts/overwrites), so re-ingesting a fixed document
  // leaves the old bad chunks sitting alongside the new ones unless they're
  // cleared first. No request body — the citation string is the query param
  // (it's the same string passed as --source to the ingest script).
  if (param === "source" && request.method === "DELETE") {
    const source = url.searchParams.get("source");
    if (!source) {
      return err("'source' query param is required, e.g. DELETE /rag/source?source=YourCitationString");
    }

    const { ok, status, body: rows } = await db.removeWhere("rag_knowledge_base", {
      source: `eq.${source}`,
    });
    if (!ok) return err(rows?.message || "Delete failed", status);

    const deletedCount = Array.isArray(rows) ? rows.length : 0;
    return success(
      { deleted: deletedCount, source },
      { message: `Deleted ${deletedCount} chunk(s) for source "${source}"` }
    );
  }

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
//            - Drug-Nutrient Interactions      -> scanTableByKeywords (drug_nutrient_interactions)
//            - Barcode Lookup                  -> lookupFoodCascade (barcode branch)
//            - USDA FDC / Open Food Facts /
//              FatSecret (fallback only)       -> lookupFoodCascade (query branch)
//       -> Rerank Results                (rerankCandidates, Cohere rerank-multilingual-v3.0)
//       -> Build Context                 (numbered, tagged snippet block)
//       -> LLM (Groq)                    (answerWithLLM) -> grounded answer + citations
//
// Intent detection decides which of the 9 sources above are actually worth
// querying for this particular question — e.g. a greeting doesn't need an
// enteral-formula table scan, and a specific-food question doesn't need the
// diabetes exchange list. This keeps the orchestrator's per-request cost
// (Cohere embed, Cohere rerank, Groq classify, Groq answer, N Supabase
// queries) proportional to what the question actually needs instead of
// always hitting all 9 sources on every request.

const ASK_CACHE_TTL_SECONDS = 300; // 5 min — shorter than RAG_CACHE_TTL_SECONDS since this caches a full generated answer, not just raw chunks

const RAG_ASK_INTENTS = [
  "food_search",
  "barcode_search",
  "nutrition_question",
  "exchange_list",
  "enteral_formula",
  "drug_interaction",
  "general_chat",
];

// Which sources the orchestrator fans out to per intent. `externalFallback`
// only fires when the local structured sources (foods/packaged/barcode) came
// back completely empty — see handleRagAsk.
const INTENT_SOURCE_PLAN = {
  food_search: { semantic: true, foods: true, packaged: true, exchange: false, renal: false, formulas: false, drugInteractions: false, externalFallback: true },
  barcode_search: { semantic: true, foods: true, packaged: true, exchange: false, renal: false, formulas: false, drugInteractions: false, externalFallback: true },
  nutrition_question: { semantic: true, foods: true, packaged: false, exchange: false, renal: false, formulas: false, drugInteractions: false, externalFallback: false },
  exchange_list: { semantic: true, foods: true, packaged: false, exchange: true, renal: true, formulas: false, drugInteractions: false, externalFallback: false },
  enteral_formula: { semantic: true, foods: true, packaged: false, exchange: false, renal: false, formulas: true, drugInteractions: false, externalFallback: false },
  drug_interaction: { semantic: true, foods: false, packaged: false, exchange: false, renal: false, formulas: false, drugInteractions: true, externalFallback: false },
  general_chat: { semantic: true, foods: false, packaged: false, exchange: false, renal: false, formulas: false, drugInteractions: false, externalFallback: false },
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
  const mentionsDrugWord = /\b(drug|medication|medicine|pill|tablet|warfarin|metformin|aspirin|antibiotic)s?\b/.test(q);
  const mentionsInteractionAngle = /\b(interact|interaction|take with|eat with|avoid while|food effect|side effect)\b|\btake\b[\s\S]*\bwith\b/.test(q);
  if (mentionsDrugWord && mentionsInteractionAngle) return "drug_interaction";
  if (/\b(drug.?nutrient|drug.?food)\s*interaction/.test(q)) return "drug_interaction";
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

  const prompt = `Classify this nutrition-app user query into exactly one intent label: food_search, barcode_search, nutrition_question, exchange_list, enteral_formula, drug_interaction, general_chat.

- food_search: looking up a specific food/ingredient/product's nutrition info
- barcode_search: the query is or contains a product barcode number
- nutrition_question: a general nutrition/clinical knowledge question, not about one specific food
- exchange_list: about diabetic or renal food exchange/portion lists
- enteral_formula: about tube-feeding/enteral/parenteral formulas
- drug_interaction: about a medication/drug interacting with food, nutrients, or supplements (e.g. "can I take X with grapefruit", "does warfarin interact with vitamin K")
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
        model: "openai/gpt-oss-20b",
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

/**
 * searchFoodsExact/searchPackagedExact do an ilike substring match against
 * food_name/product_name, so they only ever work when given something close
 * to an actual food name — not a full natural-language question. /rag/ask
 * used to pass the whole trimmed query straight through (e.g. "What
 * nutrients are in nsima?"), which almost never matches any real food_name
 * and silently starved these two sources on anything but a bare food name,
 * leaving semantic search to carry food_search intent alone.
 *
 * Runs the exact-match search once per extracted keyword (in parallel,
 * since a food name is usually just one of the keywords, not the full
 * keyword string) and merges/dedupes the hits, capped at `limit`. Falls
 * back to the raw query when there are no keywords to try (very short or
 * stopword-only input), so a bare single-word query like "nsima" behaves
 * exactly as before — one call, no behavior change.
 */
async function multiKeywordFoodSearch(searchFn, db, rawQuery, keywords, limit = 5) {
  const terms = keywords.length ? keywords : [rawQuery];
  const resultsPerTerm = await Promise.all(terms.map((term) => searchFn(db, term, limit)));
  const seen = new Set();
  const merged = [];
  for (const rows of resultsPerTerm) {
    for (const row of rows) {
      const key = row.id ?? JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
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
// Hard cap per Groq call. 500 was too tight — a multi-row meal-plan table
// with citations can easily run past that and get cut off mid-row. If the
// model still hits the cap, MAX_ANSWER_CONTINUATIONS below lets it pick up
// where it left off rather than shipping a truncated answer.
const ANSWER_MAX_COMPLETION_TOKENS = 2000;
const MAX_ANSWER_CONTINUATIONS = 1;

async function answerWithLLM(query, contextBlock, env) {
  if (!env.GROQ_API_KEY) {
    return "I found relevant information below, but I can't generate a written answer right now (GROQ_API_KEY not configured on the server) — see the numbered sources for the raw matches.";
  }

  const systemPrompt = `You are Chakudya AI, a grounded nutrition assistant for Malawi's Chakudya Nutrition Registry. Answer ONLY using the numbered context snippets provided by the user. Cite the snippet number(s) you used inline in plain ASCII square brackets only — [1] or [2][3], using the standard "[" and "]" characters, never full-width or other Unicode bracket variants — that bracketed number is the only attribution you should ever give. Never write phrases like "based on the context", "according to the source/document/snippet", "the text states", "as shown in", or similar attribution wording in the body of the answer; state facts directly and naturally, as though they were your own knowledge, and let the bracketed citation do the attribution work. If the snippets don't contain enough information to answer confidently, say so plainly instead of guessing — do not invent nutrient values, brand details, or clinical guidance that isn't in the context. Keep answers concise and clinically accurate for a Malawian dietetics context.`;
  const userPrompt = `Context:\n${contextBlock}\n\nQuestion: ${query}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let fullAnswer = "";

  try {
    for (let attempt = 0; attempt <= MAX_ANSWER_CONTINUATIONS; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b",
          temperature: 0.2,
          max_completion_tokens: ANSWER_MAX_COMPLETION_TOKENS,
          messages,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const msg = `(LLM answer unavailable: ${e.error?.message || res.status}) — see the numbered sources below.`;
        return fullAnswer ? `${fullAnswer}\n\n${msg}` : msg;
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      const piece = choice?.message?.content?.trim() || "";
      fullAnswer = fullAnswer ? `${fullAnswer}${piece}` : piece;

      // Only Groq's own truncation signal continues the loop — anything
      // else (a normal stop, or running out of continuation budget) ends it.
      if (choice?.finish_reason !== "length" || attempt === MAX_ANSWER_CONTINUATIONS) {
        break;
      }

      // Cut off mid-generation with budget left: ask the model to resume
      // exactly where it stopped instead of restarting the whole answer.
      messages.push({ role: "assistant", content: piece });
      messages.push({
        role: "user",
        content: "Continue exactly where you left off. Do not repeat any text already written, and do not restart or summarize the answer.",
      });
    }
  } catch (e) {
    const msg = `(LLM answer unavailable: ${e.message}) — see the numbered sources below.`;
    return fullAnswer ? `${fullAnswer}\n\n${msg}` : msg;
  }

  return fullAnswer || "(Empty response from the LLM — see the numbered sources below.)";
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
  if (plan.foods) tasks.foods = multiKeywordFoodSearch(searchFoodsExact, db, trimmedQuery, keywords);
  if (plan.packaged) tasks.packaged = multiKeywordFoodSearch(searchPackagedExact, db, trimmedQuery, keywords);
  if (plan.exchange) tasks.exchange = scanTableByKeywords(db, "exchange_lists", keywords);
  if (plan.renal) tasks.renal = scanTableByKeywords(db, "renal_foods", keywords);
  if (plan.formulas) tasks.formulas = scanTableByKeywords(db, "enteral_formulas", keywords);
  if (plan.drugInteractions) tasks.drugInteractions = scanTableByKeywords(db, "drug_nutrient_interactions", keywords);
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
  for (const { row } of results.drugInteractions || []) {
    candidates.push({
      source: "drug_nutrient_interaction",
      title: row.severity ? `${row.drug} — ${row.severity}` : row.drug || "Drug-nutrient interaction",
      text: rowToText(row),
      score: null,
    });
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
        model: env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b",
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
// Open Food Facts is also live-pinged (used for barcode lookups) since it's
// free/keyless and there's nothing to "configure" — but like the two below,
// it's visibility-only and doesn't affect the overall verdict. USDA FDC,
// FatSecret, and the rate-limit/query-cache KV are reported as
// configured/bound or not, without a network call — none of the four
// (Open Food Facts included) affect the overall verdict since the rest of
// the API works without them (see the "Optional" env var list in the README).

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

async function checkOpenFoodFacts() {
  // Open Food Facts is free and keyless (no env var/API key — see
  // fetchFromOpenFoodFacts), so unlike usda_fdc/fatsecret below there's no
  // "configured" flag to report; this is an actual live ping instead.
  // A barcode that's very unlikely to exist still returns HTTP 200 with a
  // "not found" body — that's enough to confirm the service itself is up,
  // we don't need real product data for a liveness check.
  const res = await pingWithTimeout("https://world.openfoodfacts.org/api/v2/product/0000000000000.json", {
    headers: { "User-Agent": "ChakudyaAPI/1.0 (chakudya-api.edisontaimu9.workers.dev)" },
  });
  return res.ok ? { status: "ok" } : { status: "error", detail: res.error || `HTTP ${res.httpStatus}` };
}

async function handleHealth(request, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const [supabase_, cohere_, groq_, openFoodFacts_] = await Promise.all([
    checkSupabase(env),
    checkCohere(env),
    checkGroq(env),
    checkOpenFoodFacts(),
  ]);

  const services = {
    supabase: supabase_,
    cohere: cohere_,
    groq: groq_,
    open_food_facts: openFoodFacts_,
    // Optional integrations — configuration/binding presence only, no
    // network call (FatSecret in particular needs a signed OAuth request,
    // not a simple ping; not worth the complexity for a health check).
    usda_fdc: { status: env.USDA_FDC_API_KEY ? "configured" : "not_configured" },
    fatsecret: {
      status: env.FATSECRET_CONSUMER_KEY && env.FATSECRET_CONSUMER_SECRET ? "configured" : "not_configured",
    },
    rate_limit_kv: { status: env.RATE_LIMIT_KV ? "bound" : "not_bound" },
  };

  // Open Food Facts is a free public dependency (used for barcode lookups
  // in /foods/lookup and /packaged/scan's barcode field) but not one of
  // this Worker's *required* upstreams — the barcode-lookup path degrades
  // gracefully (falls through the cascade) without it, same as
  // usda_fdc/fatsecret already do. So it's reported for visibility but,
  // like those two, doesn't flip the overall healthy/degraded verdict.
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
        "GET  /health           (public, rate-limited) → pings Supabase/Cohere/Groq/Open Food Facts in parallel, reports per-service status + overall healthy/degraded",
      ],
      admin_keys: [
        "GET    /admin/keys       (root key only) → list keys (never returns the raw key or its hash)",
        "POST   /admin/keys       (root key only) → body {label, role?}; role: admin (default, full access) | reviewer (packaged review + reads only); returns the raw key ONCE, store it now",
        "DELETE /admin/keys/:id   (root key only) → revoke (soft — sets revoked_at, doesn't delete the row)",
      ],
      foods: [
        "GET  /foods?with_servings=true",
        "GET  /foods/:id?with_servings=true     → add ?with_servings=true for a serving_sizes[] array (household measures, e.g. \"1 cup\", each with nutrients pre-scaled from the 100g basis)",
        "GET  /foods/lookup?q=...|barcode=...&with_servings=true   (public, rate-limited) → external cascade: local cache → USDA FDC → Open Food Facts → FatSecret; ?with_servings=true adds serving_sizes[] as above",
        "GET  /foods/autocomplete?q=...&max_results=  (public, rate-limited) → FatSecret Premier autocomplete suggestions",
        "GET  /foods/categories                 (public, rate-limited, cached 24h) → FatSecret Premier food category list",
        "GET  /foods/substitutes?food_name=chicken&limit=  (public, rate-limited, cached 1h) → Malawi-specific substitution suggestions, ranked by nutritional closeness, with a full nutrient comparison vs the original — see SUBSTITUTION_GROUP_OVERRIDES",
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
        "DELETE /rag/source?source=... (admin) → bulk-delete all chunks for one document (use before re-ingesting a fixed document, since ingest never overwrites)",
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
      food_log: [
        "GET    /log?user_id=...&date=YYYY-MM-DD   (public, rate-limited) → diary entries, newest first; date filter optional",
        "GET    /log/:id                           (public, rate-limited) → single entry",
        "POST   /log        (public, rate-limited) → body {user_id, meal_type: breakfast|lunch|snack|dinner, calories, food_name?, entry_date?}",
        "DELETE /log/:id?user_id=...                (public, rate-limited) → delete one entry (scoped to user_id)",
        "GET    /log/summary?user_id=...&period=daily|weekly&date=YYYY-MM-DD   (public, rate-limited) → kcal totals + by_meal breakdown; weekly adds by_date[] and average_daily_calories",
      ],
      recipes: [
        "POST /recipes/calculate   (public, rate-limited) → body {servings?, ingredients:[{food_id?|food_name, quantity, unit?}]}; resolves each ingredient (local foods, falling back to the same local→external cascade as /foods/lookup), converts quantity/unit to grams (see Serving-Size Intelligence), and returns total_nutrients + nutrients_per_serving + a per-ingredient breakdown + any unresolved_ingredients",
      ],
      meals: [
        "POST /meals/analyze   (public, rate-limited) → body {meal_type?, ingredients:[{food_id?|food_name, quantity, unit?}], daily_targets?:{kcal,protein_g,carbs_g,fat_g}}; same ingredient resolution as /recipes/calculate, no servings — returns total_nutrients, macronutrient_breakdown (kcal + % from protein/carbs/fat, Atwater 4/4/9, compared against the standard adult AMDR range), food_groups_present/food_groups_missing (from the core Grains/Legumes/Protein/Vegetables/Fruits/Dairy set), and — only if daily_targets was supplied — daily_target_comparison; purely descriptive, never invents a personalized target itself",
      ],
      ingredients: [
        "POST /ingredients/parse   (public, rate-limited) → body {text}; parses free text like \"2 eggs, 1 cup rice, 100g chicken and ½ avocado\" into ingredients:[{food_name, quantity, unit}] — the exact shape /recipes/calculate and /meals/analyze accept. Groq LLM parse, falls back to a local regex parser if GROQ_API_KEY isn't configured or the LLM call fails. A bare count with no stated unit (\"2 eggs\") comes back as unit:\"serving\", not grams.",
      ],
      drug_interactions: [
        "GET  /drug-interactions?category=&severity=&limit=&offset=/cursor=   (public, rate-limited) → paginated list of drug-nutrient interaction entries",
        "GET  /drug-interactions/:id   (public, rate-limited) → single entry",
        "GET  /drug-interactions/search?q=warfarin   (public, rate-limited) → keyword scan across drug/aliases/category/subcategory/tags/effects/implications (same approach as /rag/ask's exchange/renal/formula lookups) — 'drug' also accepted as the param name",
        "POST /drug-interactions   (admin) → body: {drug, aliases?, category?, subcategory?, effects?, implications?, severity?, tags?}",
        "POST /drug-interactions/bulk   (admin) → body {items:[...]}, up to 500 rows",
        "PUT/PATCH/DELETE /drug-interactions/:id   (admin)",
      ],
      dri: [
        "GET  /dri/life-stages   (public, rate-limited) → every DRI life-stage group (code, label, sex, age range)",
        "GET  /dri?nutrient=&life_stage=   OR   ?nutrient=&age=&sex=&life_stage_type=   (public, rate-limited) → EAR/RDA/AI/UL for one nutrient (or every nutrient if 'nutrient' is omitted) at the resolved life stage, plus that life stage's AMDR and sodium CDRR when returning the full set",
        "POST /dri/compare   (public, rate-limited) → body {age|life_stage, sex?, life_stage_type?, intake:{nutrient_key: amount}}; compares intake (same field names as /recipes/calculate or /meals/analyze's total_nutrients) against RDA/AI, flags UL if exceeded — only nutrients CNR's foods table actually tracks are comparable, see 'trackable' on GET /dri",
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
  if (isTruthyParam(url.searchParams.get("with_servings"))) {
    result.food.serving_sizes = buildServingSizes(result.food);
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
      if (isTruthyParam(url.searchParams.get("with_servings"))) {
        body.serving_sizes = buildServingSizes(body);
      }
      return success(body);
    }

    const search = url.searchParams.get("search") || "";
    const category = url.searchParams.get("category") || "";

    const filters = {};
    if (category) filters["category"] = `eq.${category}`;
    if (search) filters["food_name"] = `ilike.*${escapeLikePattern(search)}*`;

    const withServings = isTruthyParam(url.searchParams.get("with_servings"));
    return await paginatedList(db, "foods", url, {
      filters,
      order: "food_name.asc",
      enrichRow: withServings ? (row) => ({ ...row, serving_sizes: buildServingSizes(row) }) : undefined,
    });
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

// ── /drug-interactions ───────────────────────────────────────────────────────
//
// Migrated from Oasis CNST's client-side 117-entry drug-nutrient interaction
// database (js/dni.js — Krause & Mahan's Food and the Nutrition Care
// Process 16th ed., The Essential Pocket Guide for Clinical Nutrition 4th
// ed., LPI/OSU Micronutrient Info Center, NIH PMC) so every app in the
// ecosystem (Oasis CNST, Thanzi, Umoyo Agent, NCRS) can query one shared
// copy instead of each bundling its own. Standard CRUD (same shape as
// /renal, /exchange, /formulas) plus a keyword search endpoint that mirrors
// the client-side search this data used to have (drug name/aliases/
// category/tags/effects/implications, whole-row substring match).
//
// Requires:
//   create table if not exists public.drug_nutrient_interactions ( ... );
// — see sql/003_add_drug_nutrient_interactions.sql.

async function handleDrugInteractions(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    const category = url.searchParams.get("category") || "";
    const severity = url.searchParams.get("severity") || "";
    const filters = {};
    if (category) filters["category"] = `eq.${category}`;
    if (severity) filters["severity"] = `eq.${severity}`;

    if (id) {
      const { ok, status, body } = await db.selectOne("drug_nutrient_interactions", id);
      if (status === 404) return notFound("Drug-nutrient interaction entry");
      if (!ok) return err(body?.message || "Query failed", status);
      return success(body);
    }
    return await paginatedList(db, "drug_nutrient_interactions", url, { filters });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    if (!payload.drug) return err("'drug' is required");
    const { ok, status, body } = await db.insert("drug_nutrient_interactions", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Drug-nutrient interaction entry created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("drug_nutrient_interactions", id, payload, "PUT");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Drug-nutrient interaction entry replaced" });
  }

  if (method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("drug_nutrient_interactions", id, payload, "PATCH");
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Drug-nutrient interaction entry updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("drug_nutrient_interactions", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Drug-nutrient interaction entry ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

/**
 * GET /drug-interactions/search?q=warfarin
 * Same keyword-scan approach /rag/ask already uses for exchange_lists/
 * renal_foods/enteral_formulas (scanTableByKeywords — no documented single
 * "name" column to ilike on, so it's a whole-row substring scan instead).
 * `q` can be a drug name, brand name, drug class, or a nutrient/food
 * keyword (e.g. "grapefruit", "warfarin", "vitamin B12") — matches the
 * client-side search this data used to have in Oasis CNST.
 */
async function handleDrugInteractionsSearch(request, url, db) {
  const q = url.searchParams.get("q") || url.searchParams.get("drug") || "";
  if (!q.trim()) return err("'q' (or 'drug') query param is required");

  const keywords = extractKeywords(q);
  if (!keywords.length) return success([], { message: "Query too short/generic to search on", query: q });

  const scanLimit = intParam(url, "scan_limit", 300);
  const matches = await scanTableByKeywords(db, "drug_nutrient_interactions", keywords, scanLimit);

  return success(
    matches.map((m) => ({ ...m.row, match_score: m.score })),
    { query: q, count: matches.length }
  );
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
    const search = url.searchParams.get("search") || "";
    const filters = {};
    if (barcode) filters["barcode"] = `eq.${barcode}`;
    if (search) filters["product_name"] = `ilike.*${escapeLikePattern(search)}*`;

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
      if (param === "autocomplete") {
        return await handleFoodsAutocomplete(request, url, env);
      }
      if (param === "categories") {
        return await handleFoodsCategories(request, env);
      }
      if (param === "substitutes") {
        return await handleFoodSubstitutes(request, url, db, env);
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

    case "drug-interactions": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "drug_nutrient_interactions", {
          requiredField: "drug",
          label: "drug-nutrient interaction entries",
        });
      }
      if (param === "search") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        return await handleDrugInteractionsSearch(request, url, db);
      }
      const id = param || null;
      return await handleDrugInteractions(request, url, db, id);
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

    case "log": {
      if (param === "summary") {
        return await handleLogSummary(request, url, db);
      }
      const id = param || null;
      return await handleFoodLog(request, url, db, id);
    }

    case "recipes": {
      if (param === "calculate") {
        if (request.method !== "POST") return err("Only POST is supported for /recipes/calculate", 405);
        return await handleRecipesCalculate(request, db, env);
      }
      return notFound();
    }

    case "meals": {
      if (param === "analyze") {
        if (request.method !== "POST") return err("Only POST is supported for /meals/analyze", 405);
        return await handleMealsAnalyze(request, db, env);
      }
      return notFound();
    }

    case "ingredients": {
      if (param === "parse") {
        return await handleIngredientsParse(request, db, env);
      }
      return notFound();
    }

    case "dri": {
      if (param === "life-stages") {
        return await handleDriLifeStages(request);
      }
      if (param === "compare") {
        return await handleDriCompare(request);
      }
      if (!param) {
        return await handleDriLookup(request, url);
      }
      return notFound();
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
