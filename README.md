# Chakudya Nutrition Registry (CNR) 🌽

**Malawi's Intelligent Food & Nutrition Knowledge Platform**

Chakudya is a Malawi focused nutrition data and intelligence API. It
provides structured, searchable nutrition information for health
applications, researchers, students, dietitians, and developers building
tools for clinical or public health nutrition work. It's a Cloudflare
Worker backed by Supabase, and includes retrieval augmented (RAG) search
for AI assisted nutrition tools.

---

## What the API provides

- **Malawian food composition data** (`/foods`). Locally relevant foods and their nutrient values.
- **Food exchange systems** (`/exchange`). Standard and therapeutic exchange lists.
- **Renal nutrition data** (`/renal`). Foods and nutrition information relevant to renal dietary planning.
- **Enteral formulas** (`/formulas`). Structured information for clinical nutrition applications.
- **Drug-nutrient interactions** (`/drug-interactions`). 117-entry reference DB (migrated from Oasis CNST) with keyword search, shared across the ecosystem instead of bundled per-app.
- **Food substitutions** (`/foods/substitutes`). Malawi-specific "what can I use instead" suggestions ranked by nutritional closeness (e.g. chicken → soya pieces → chambo → groundnuts), spanning categories the way people actually substitute rather than a strict taxonomy match.
- **Packaged and branded foods** (`/packaged`). Barcode lookup, community product submission, OCR assisted data capture, and an admin review workflow.
- **External food lookup** (`/foods/lookup`, `/foods/autocomplete`, `/foods/categories`). Additional food information from USDA FoodData Central, Open Food Facts, and FatSecret when a food isn't in the local database.
- **RAG powered nutrition knowledge** (`/rag/ask`, `/rag/retrieve`). Retrieve relevant knowledge or ask a question directly.
- **Session memory** (`/memory/write`, `/memory/recall`, `/memory/consolidate`). Store, consolidate, and recall contextual information for AI assisted applications like Oasis.
- **Recipe nutrition calculation** (`/recipes/calculate`). Give it a list of ingredients (name or id, quantity, unit) and it resolves, converts, and sums the nutrition for you — total and per-serving.
- **Meal analysis** (`/meals/analyze`). Same ingredient resolution as recipes, framed around a single meal: macronutrient % breakdown against the standard adult AMDR range, food-group coverage, an optional comparison against caller-supplied daily targets, and optional per-meal clinical screening flags (diabetes, hypertension, kidney disease).

## Who it's for

Chakudya can be used to build:

- Nutrition and dietetics applications
- Clinical decision support tools
- Meal planning systems
- Fitness and health applications
- Food and barcode scanners
- Nutrition research tools
- AI and RAG powered nutrition assistants
- Educational applications

---

## Runtime & Tech

- **Runtime:** Cloudflare Workers
- **Database:** Supabase REST (`/rest/v1`)
- **Embeddings:** Cohere (`embed-multilingual-v3.0`)
- **Rate limiting:** Cloudflare KV
- **Current CNR version:** `1.21.1`

---

## Project Structure

```text
chakudya-api/
├── src/
│   └── index.js       # Worker entry, all route handlers, caching, rate limiting
├── smoke-test.sh       # Post-deploy verification script (see "Smoke Test" below)
├── wrangler.toml       # Cloudflare Worker config — KV binding, cron trigger, account ID
└── README.md
```

> The JS client SDK has moved to its own repo: [Chakudya-sdk](https://github.com/edisontaimu9-ui/Chakudya-sdk). See "JS Client SDK" below.

---

## Required Environment Variables / Bindings

Set these in Cloudflare Worker settings:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `COHERE_API_KEY`
- `ADMIN_API_KEY` (required for admin write routes)
- `RATE_LIMIT_KV` (KV namespace binding used for rate limiting)

Optional — power the external food lookup cascade (`GET /foods/lookup`), plus `GET /foods/autocomplete` and `GET /foods/categories`, only; the rest of CNR works without them:

- `FATSECRET_CONSUMER_KEY` / `FATSECRET_CONSUMER_SECRET` (OAuth 1.0 Consumer credentials, from your FatSecret Platform dashboard). Name search and `/foods/lookup`'s FatSecret fallback work on any tier; barcode lookup, autocomplete, and categories need a **Premier or Premier Free** plan — see [Foods](#foods).
- `USDA_FDC_API_KEY` (USDA FoodData Central — free at [api.data.gov/signup](https://api.data.gov/signup))

> If `ADMIN_API_KEY` is missing, admin routes fail closed (writes denied).
> FatSecret auth is OAuth 1.0 (2-legged, HMAC-SHA1), signed natively inside the Worker via Web Crypto — no token exchange call, no IP whitelist needed.

---

## Setup

### 1) Clone

```bash
git clone https://github.com/edisontaimu9-ui/chakudya-api.git
cd chakudya-api
```

### 2) Configure `wrangler.toml`

Set your Cloudflare account ID:

```toml
account_id = "YOUR_ACCOUNT_ID"
```

### 3) Add secrets

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put COHERE_API_KEY
npx wrangler secret put ADMIN_API_KEY
```

Optional, for external food lookups:

```bash
npx wrangler secret put FATSECRET_CONSUMER_KEY
npx wrangler secret put FATSECRET_CONSUMER_SECRET
npx wrangler secret put USDA_FDC_API_KEY
```

### 4) Create and bind the KV namespace

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
```

This prints an `id`. Add it to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<the-id-it-printed>"
```

(Or bind it via the dashboard instead: **Workers & Pages → your-worker → Settings → Bindings → Add → KV Namespace**, variable name exactly `RATE_LIMIT_KV`. Either way works, but only the `wrangler.toml` version survives a fresh clone/redeploy from a different machine — a dashboard-only binding can silently disappear on redeploy from an unedited config.)

Both rate limiting and the RAG/memory query cache **fail open silently** if this binding is missing — the API keeps responding normally, it just isn't rate-limited or cached, with no error to tell you so. After any deploy or binding change, confirm it's live:

```bash
curl -s https://your-worker.workers.dev/ | grep -o '"kv_bound":[a-z]*'
```

Should print `"kv_bound":true`. If it prints `false`, the binding isn't connected.

### 5) Run & deploy

```bash
npx wrangler dev
npx wrangler deploy
```

### 6) Verify

```bash
bash smoke-test.sh https://your-worker.workers.dev
```

Runs the full MISS→HIT / rate-limit / cascade verification pass in one command instead of testing each piece by hand. See "Smoke Test" below for details.

---

## Authentication Model

`Authorization: Bearer <key>` is required for:

- All write routes (`POST`, `PUT`, `PATCH`, `DELETE`) on:
  - `/foods`
  - `/exchange`
  - `/renal`
  - `/formulas`
  - `/packaged/:id`
- `GET /packaged/pending`, `POST /packaged/:id/approve`, `POST /packaged/:id/reject`
- `GET /admin/keys`, `POST /admin/keys`, `DELETE /admin/keys/:id` — **root key only**, see [API keys](#api-keys)
- `POST /oauth/token` — OAuth 2.0 `client_credentials` token endpoint, see [OAuth 2.0](#oauth-20-machine-to-machine)
- `GET /admin/oauth-clients`, `POST /admin/oauth-clients`, `DELETE /admin/oauth-clients/:id` — **root key only**
- `POST /rag/ingest`
- `POST /memory/consolidate` (also runs automatically via hourly cron, bypassing HTTP auth)

The `<key>` can be either the root `ADMIN_API_KEY` or a per-consumer key
minted via `POST /admin/keys` — see [API keys](#api-keys) for the
difference.

Public exceptions:

- `GET /health` (public, rate-limited)
- `POST /packaged/submit`, `POST /packaged/scan` (public, rate-limited)
- `POST /rag/retrieve`, `POST /rag/ask` (public, rate-limited)
- `POST /memory/write` (public, rate-limited)
- `GET /memory/recall` (public, rate-limited)
- `GET /foods/lookup` (public, rate-limited)
- All other `GET` endpoints

---

## API keys

Before this feature existed, every admin action used the same
`ADMIN_API_KEY` — no way to tell who did what, or revoke one client's
access without breaking everyone else's. Now there are two kinds of valid
admin credential:

- **Root key** — `env.ADMIN_API_KEY` (the `wrangler secret`). Works
  exactly like before. Only the root key can manage other keys, and it
  always has full access regardless of role checks.
- **Per-consumer keys** — minted via `POST /admin/keys`, each with its own
  `label` and `role`. The label is what shows up automatically as
  `reviewed_by` on `/packaged/:id/approve|reject`, so approvals/rejections
  are attributable to a specific reviewer without them having to type
  their name every time.

**Roles** — every per-consumer key has one:

- `admin` *(default)* — same access as the root key, everything except
  managing other keys.
- `reviewer` — can only reach the packaged review queue
  (`GET /packaged/pending`, `POST /packaged/:id/approve`,
  `POST /packaged/:id/reject`) plus all public/`GET` routes. Blocked from
  everything else admin-gated — editing foods, deleting packaged foods, bulk
  inserts, RAG ingest, memory consolidation, key management, etc. A
  reviewer key that leaks can't do much beyond what a reviewer is
  supposed to do in the first place.

There's currently no "change a key's role" endpoint — revoke the key and
mint a new one with the role you want.

Raw keys are never stored — only a SHA-256 hash, in a new `api_keys`
table. Run this once in the Supabase SQL editor:

```sql
create table if not exists api_keys (
  id bigint generated always as identity primary key,
  key_hash text not null unique,
  label text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
```

If you already have an `api_keys` table from before roles existed, migrate
it instead (existing keys default to `admin` — nobody's access shrinks):

```sql
alter table api_keys add column if not exists role text not null default 'admin';
```

**Create a key** (root key only):

```bash
curl -X POST https://your-worker-url/admin/keys \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"label":"Grace - reviewer","role":"reviewer"}'
```

`role` is optional — omit it (or send `"admin"`) for full access, same as
before this feature existed.

```json
{
  "status": "success",
  "message": "API key created — save this now, it will not be shown again",
  "key": "cnr_9f2a...c81b",
  "data": { "id": 1, "label": "Grace - reviewer", "role": "reviewer", "created_at": "...", "last_used_at": null, "revoked_at": null }
}
```

The raw `key` value is shown exactly once — there's no way to retrieve it
again afterward (only its hash exists in the DB). If it's lost, revoke it
and mint a new one.

**List keys** (never returns raw keys or hashes):

```bash
curl https://your-worker-url/admin/keys -H "Authorization: Bearer <ADMIN_API_KEY>"
```

**Revoke a key** (soft-delete — sets `revoked_at`, keeps the row for audit history):

```bash
curl -X DELETE https://your-worker-url/admin/keys/1 -H "Authorization: Bearer <ADMIN_API_KEY>"
```

---

## OAuth 2.0 (machine-to-machine)

For services that call the API on their own behalf (MCP server, Thanzi Coach,
apps) there's an OAuth 2.0 **client_credentials** flow, so a service holds a
revocable client secret instead of a long-lived admin key. A client exchanges
its credentials for a **1-hour bearer token**, then uses it exactly like an API
key (`Authorization: Bearer <token>`) on any admin route, including `/batch`.
Tokens carry the client's role (`admin` or `reviewer`), so role limits apply
unchanged. Existing API keys keep working.

**One-time setup**

1. Run `sql/014_add_oauth_clients.sql` in the Supabase SQL editor.
2. Add a Worker secret `OAUTH_SIGNING_SECRET` in the Cloudflare dashboard
   (Workers & Pages → chakudya-api → Settings → Variables and Secrets).
   Generate one with `openssl rand -hex 32`. Rotating it invalidates all
   outstanding tokens (clients simply fetch a new one).

**Create a client** (root key only; the secret is shown once):

```bash
curl -X POST https://your-worker-url/admin/oauth-clients \
  -H "Authorization: Bearer <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{"label":"thanzi-coach","role":"admin"}'
# -> client_id: cnr_client_..., client_secret: cnr_secret_...
```

**Get a token** (HTTP Basic, or `client_id`/`client_secret` form fields):

```bash
curl -X POST https://your-worker-url/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" -d "grant_type=client_credentials"
# -> {"access_token":"eyJ...","token_type":"Bearer","expires_in":3600,"scope":"admin"}
```

Optional `scope=reviewer` requests a narrower token than the client's role;
asking for more than the client's role returns `invalid_scope`.

**Use it, caching until shortly before expiry:**

```js
let cached = { token: null, exp: 0 };
async function getToken(env, base) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.CNR_CLIENT_ID}:${env.CNR_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const { access_token, expires_in } = await res.json();
  cached = { token: access_token, exp: Date.now() + expires_in * 1000 };
  return access_token;
}
```

**Revoke:** `DELETE /admin/oauth-clients/:id` (root key). New tokens stop
immediately and already-issued tokens are rejected too (KV denylist; if
`RATE_LIMIT_KV` isn't bound they live out their hour). `GET /admin/oauth-clients`
lists clients without secrets. Discovery metadata (RFC 8414):
`GET /.well-known/oauth-authorization-server`. The token endpoint is limited
to 10 requests/min per IP.

---

## Rate Limits (from `index.js` policy)

- **Standard reads (`GET`)**: `100/min` per IP per resource
- **Packaged submit (`POST /packaged/submit`)**: `10/min` per IP
- **RAG retrieve (`POST /rag/retrieve`)**: `20/min` per IP
- **Memory write (`POST /memory/write`)**: `30/min` per IP
- **Memory recall (`GET /memory/recall`)**: `30/min` per IP
- **Admin writes (general)**: `60/min` per admin token
- **RAG ingest (`POST /rag/ingest`)**: `30/min` per admin token
- **Batch (`POST /batch`)**: `10/min` per IP — on top of whatever limit each sub-request's own resource applies

When exceeded:

- HTTP `429`
- `Retry-After` header returned

---

## Caching (Cloudflare Cache API, `v1.4.0+`)

GET responses for reference-style resources are cached at the Cloudflare edge, keyed on the full request URL (so different filters/query params get distinct cache entries). No extra bindings needed — this uses the Workers built-in `caches.default`.

| Resource | Cached? | TTL |
|---|---|---|
| `GET /foods`, `/exchange`, `/renal`, `/formulas`, `/glycaemic-index`, `/bmi-for-age`, `/hc-velocity`, `/length-velocity`, `/weight-velocity`, `/muac-for-age`, `/muac` | ✅ | 1 hour |
| `GET /foods/compare` | ✅ | 1 hour |
| `GET /foods/lookup` | ✅ | 30 min |
| `GET /foods/autocomplete` | ✅ | 1 hour |
| `GET /foods/categories` | ✅ | 24 hours |
| `GET /packaged*` | ❌ | — (changes often — community/OCR submissions) |
| `POST /rag/retrieve`, `POST`/`GET /memory/recall` | ❌ (edge cache) — ✅ (separate KV query cache, see below) | — |
| `POST /rag/ingest`, `POST /memory/write` | ❌ | — (writes; never cached) |

`/foods/lookup` was already deduping external USDA/FatSecret/Open Food Facts calls via the `external_foods_cache` Supabase table — the edge cache sits on top of that, so a repeat query within 30 min skips the Supabase round-trip entirely too.

**Invalidation:** a successful admin write (`POST`/`PUT`/`PATCH`/`DELETE`) to a cached resource automatically purges the bare list URL and the single-id URL for that resource. Filtered/paginated variants beyond those two shapes just expire naturally within the TTL above. Note this is the per-Worker Cache API, not zone-level CDN cache, so there's no dashboard "purge everything" button for it — the automatic purge on write is the main invalidation path.

**Verifying it's working:** every cached response carries an `X-Cache: HIT` or `X-Cache: MISS` header (Cloudflare's own `cf-cache-status` doesn't apply here since this is the Workers Cache API, not zone-level caching). Check it directly:

```bash
curl -sD - -o /dev/null "https://your-worker.workers.dev/foods/lookup?q=nsima" | grep -i x-cache
# first request  -> X-Cache: MISS
curl -sD - -o /dev/null "https://your-worker.workers.dev/foods/lookup?q=nsima" | grep -i x-cache
# second request -> X-Cache: HIT
```

Note: Cache API entries are per-datacenter, not global — if your first two requests happen to land on different Cloudflare edge nodes, the second one can still show `MISS`. Repeat a couple of times if that happens; it'll settle into `HIT` once requests are routed to a datacenter that already has the entry.

Note: Cloudflare has no dashboard analytics for the Workers Cache API specifically (the "Caching" dashboard tab is for zone-level CDN caching on a proxied domain, which is separate from this). To watch cache activity live instead: Workers & Pages → chakudya-api → Logs → enable **Real-time Logs**, then hit any cached endpoint — you'll see `[cache] HIT`, `[cache] MISS`, and `[cache] PURGE` lines streaming in as requests come through.

---

## RAG / Memory Query Cache (Cloudflare KV, `v1.6.0+`)

The edge cache above only applies to `GET` requests — `/rag/retrieve` and `/memory/recall` are `POST` (recall also supports a legacy `GET`), and each one spends a Cohere embed call just to turn the query text into a vector before searching. That's a separate, KV-backed cache (reuses the existing `RATE_LIMIT_KV` binding under its own key prefix — no new binding needed) that caches the *whole response*, so a hit skips the Cohere call **and** the Supabase RPC.

| Route | TTL | Cache key |
|---|---|---|
| `POST /rag/retrieve` | 10 min | `context` + `top_k` + normalized query text |
| `POST`/`GET /memory/recall` | 2 min | `session_id` + `top_k` + normalized query text |

`/memory/recall`'s key always includes `session_id`, so one patient session can never be served from another's cache entry. Its TTL is deliberately short (2 min, vs 10 min for RAG) because a session's facts can change mid-conversation via `/memory/write` — this cache is only meant to absorb rapid repeat/near-repeat recalls, not to serve stale clinical context.

`/rag/ingest` and `/memory/write` are never cached — caching a write risks silently dropping a distinct document or fact on what looks like a "repeat" call.

**Verifying it's working:** both routes return a `cache: "HIT"` or `cache: "MISS"` field in the JSON body (not a header, since this is a query-cache on POST routes, not the edge `GET` cache above):

```bash
curl -s -X POST "https://your-worker.workers.dev/rag/retrieve" \
  -H "Content-Type: application/json" \
  -d '{"query":"what is nsima made of","context":"both","top_k":3}' | grep -o '"cache":"[A-Z]*"'
# first call  -> "cache":"MISS"
# second call (same query, within 10 min) -> "cache":"HIT"
```

---

## Smoke Test

`smoke-test.sh` re-runs the full manual verification pass (KV binding, RAG cache, edge cache, rate limiting, memory recall cache + session isolation, foods lookup cascade) in one command instead of doing it by hand after every deploy or dashboard change:

```bash
bash smoke-test.sh
# or against a different deployment:
bash smoke-test.sh https://your-worker.workers.dev
```

Takes about 90 seconds (most of that is a deliberate 60s pause to let the rate-limit window reset before the script continues). Exits non-zero if anything fails, so it's safe to wire into a CI step later if useful.

---

## Endpoints

The full list below is also available as a machine-readable
[OpenAPI 3.0.3 spec](./openapi.yaml) — import it into Swagger UI, Postman,
or an SDK generator. It's a static file (not served by the Worker) kept in
sync by hand alongside this section; if they ever disagree, this README
and `src/index.js` are the source of truth. Row shapes for the nutrition
tables (`foods`, `packaged_foods`, `exchange_lists`, and so on) are kept
intentionally loose in the spec (`additionalProperties: true` with a few
illustrative properties) rather than exhaustively modeled, since the full
column list per table lives here in the README and evolves on its own.

### Root

- `GET /` — returns CNR metadata, version, auth summary, and endpoint map

### Health

- `GET /health` *(public, rate-limited)* — pings Supabase, Cohere, Groq,
  and Open Food Facts in parallel and reports per-service status plus an
  overall `healthy`/`degraded` verdict. Useful for quickly narrowing down
  which upstream is the cause when a route starts failing, instead of
  guessing from a generic `500`.

`open_food_facts` is live-pinged too (it's free/keyless — no
"configured" state to report, unlike the two below) since it's an
actively-used dependency for barcode lookups in `GET /foods/lookup` and
`POST /packaged/scan`. Optional integrations (USDA FDC, FatSecret, the
rate-limit/query-cache KV) are reported as `configured`/`bound` or not,
without a network call. None of these four affect the overall verdict —
they're visibility-only, since the rest of the API already degrades
gracefully without them.

Response:

```json
{
  "status": "healthy",
  "version": "1.17.0",
  "checked_at": "2026-08-13T22:40:00.000Z",
  "services": {
    "supabase": { "status": "ok" },
    "cohere": { "status": "ok" },
    "groq": { "status": "error", "detail": "HTTP 401" },
    "open_food_facts": { "status": "ok" },
    "usda_fdc": { "status": "configured" },
    "fatsecret": { "status": "not_configured" },
    "rate_limit_kv": { "status": "bound" }
  }
}
```

Returns `200` when `status: "healthy"`, `503` when `status: "degraded"`
(i.e. Supabase, Cohere, or Groq — the required upstreams — failed to
respond).

### Batch

- `POST /batch` *(public, rate-limited, max 20 sub-requests)* — runs several
  sub-requests in one HTTP call and returns all their results together.
  Built for clients (the MCP server, the SDK, or any caller) that would
  otherwise make several separate calls per user action — e.g. a few
  `/foods/lookup` calls plus a `/rag/ask`, or a batch of `/foods/:id` reads —
  and want one round trip instead.

  Each sub-request goes through the *exact same* auth + rate-limit + edge
  cache + dispatch path as calling it directly: an admin-only sub-route
  still needs a valid `Authorization: Bearer <admin key>` (forwarded from
  the batch call's own header), and it still consumes that resource's own
  rate-limit bucket. Batching only saves round trips — it can't be used to
  bypass per-resource auth or rate limits. The `/batch` endpoint itself also
  has its own limit (see Rate Limits above), since one batch call can fan
  out into a lot of backend work. Sub-requests run concurrently; results
  come back in the same order as the request array regardless. A failed
  sub-request never fails the others — each item carries its own `status`.

  Request:

  ```json
  {
    "requests": [
      { "id": "banana", "method": "GET", "path": "/foods/lookup?q=banana" },
      { "id": "rice-vs-nsima", "method": "GET", "path": "/foods/compare?foods=rice,nsima" },
      { "id": "log-it", "method": "POST", "path": "/log", "body": { "user_id": "u1", "meal_type": "lunch", "calories": 450 } }
    ]
  }
  ```

  Response:

  ```json
  {
    "status": "success",
    "data": [
      { "id": "banana", "status": 200, "body": { "status": "success", "data": { "...": "..." } } },
      { "id": "rice-vs-nsima", "status": 200, "body": { "status": "success", "data": { "...": "..." } } },
      { "id": "log-it", "status": 201, "body": { "status": "success", "data": { "...": "..." } } }
    ],
    "meta": { "total": 3, "succeeded": 3, "failed": 0, "duration_ms": 187 }
  }
  ```

  Notes:
  - `id` is optional — defaults to the item's index (as a string) if omitted.
  - `method` defaults to `GET`; supported methods are `GET`, `POST`, `PUT`,
    `PATCH`, `DELETE`.
  - `path` must be a path starting with `/` (not a full URL), matching
    whatever you'd normally call the API with (query string included).
  - Nested `/batch` sub-requests are rejected with a `400` item.
  - The envelope itself returns `200` unless the batch request is malformed
    (bad JSON, missing/empty/oversized `requests`) — individual sub-request
    failures live in each item's own `status`/`body`, not the envelope status.

## Request IDs & logging

Every request gets a UUID, returned as the `X-Request-Id` response header
on every response (success, error, rate-limited, cached — all of them).
Quote it back when reporting an issue; it's also in the corresponding log
line.

Each request also emits one structured JSON log line (via
`console.log`/`console.error`), visible in `wrangler tail` or the
Cloudflare dashboard's Workers Logs:

```json
{"level":"info","request_id":"5e2f...","method":"GET","path":"/foods","status":200,"duration_ms":42,"cache":"HIT"}
```

500 responses additionally carry `request_id` in the JSON body, since
that's the case most worth being able to search logs for afterward:

```json
{ "status": "error", "message": "Internal server error", "request_id": "5e2f..." }
```

Set `DISABLE_REQUEST_LOGGING = "true"` in `wrangler.toml`'s `[vars]` (or a
secret) to silence the per-request info log if volume ever becomes a
cost/noise concern — errors always log regardless of this setting.

## Pagination

`GET /foods`, `/exchange`, `/renal`, `/formulas`,
and `/packaged` all support two pagination modes, chosen by
whether a `cursor` param is present at all:

- **Offset/limit (default)** — `?limit=50&offset=100`, unchanged from
  before. Response includes `count` (total matching rows) and `offset`.
  Simple, but on a large table that's actively changing, rows can shift
  between pages as data is inserted or deleted.
- **Cursor (keyset)** — add `?cursor=` to switch modes. Start with
  `cursor=` (empty) or omit `offset`/leave `cursor` blank for the first
  page; each response includes `next_cursor` — pass that value as the next
  request's `cursor` to get the following page. Stops when `has_more` is
  `false` (`next_cursor` will be `null`). Not affected by rows shifting
  mid-pagination, which is the point of using it on a big or fast-moving
  table. **Note:** cursor pages are always ordered by `id.asc`, even where
  the offset mode's default order is something else (e.g. `/foods` sorts
  offset pages by `food_name.asc`).

```json
{ "status": "success", "limit": 50, "has_more": true, "next_cursor": 187, "data": [ /* ... */ ] }
```

```bash
curl ".../foods?category=fruit&cursor="              # first page
curl ".../foods?category=fruit&cursor=187"            # next page (from next_cursor above)
```

## Bulk insert

`POST /foods/bulk`, `/exchange/bulk`, `/renal/bulk`, `/formulas/bulk`,
`/drug-interactions/bulk`, `/glycaemic-index/bulk`, `/bmi-for-age/bulk`, `/hc-velocity/bulk`, `/length-velocity/bulk`, `/weight-velocity/bulk`, `/muac-for-age/bulk`, and
`/fenton-preterm/bulk` *(all admin)* accept a batch
of rows in one request instead of one `POST` per row — useful for loading
data from a spreadsheet or migration script.

```bash
curl -X POST https://your-worker-url/foods/bulk \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "food_name": "Cassava (boiled)", "category": "Staples", "kcal": 160, "protein_g": 1.4, "carbs_g": 38, "fat_g": 0.3 },
      { "food_name": "Groundnuts (roasted)", "category": "Legumes/Nuts", "kcal": 567, "protein_g": 26, "carbs_g": 16, "fat_g": 49 }
    ]
  }'
```

```json
{ "status": "success", "message": "2 foods created", "count": 2, "data": [ /* the 2 inserted rows */ ] }
```

- Max **500 items** per request — split larger loads into multiple calls.
- `food_name` is required on every item for `/foods/bulk` and
  `/glycaemic-index/bulk` (mirrors each resource's single-row `POST`
  validation), `drug` for `/drug-interactions/bulk`, `metric` for
  `/fenton-preterm/bulk`; the other resources have no required-field check
  beyond a non-empty array, matching
  their single-row endpoints today. Note `/glycaemic-index/bulk` does *not*
  enforce `match_keywords`/`source` per-item the way the single-row `POST`
  does — a bulk seed file with a missing citation will insert silently, so
  check your seed JSON before running it.
- **All-or-nothing:** this is one PostgREST batch insert, not N sequential
  inserts. If any row in the batch violates a constraint (e.g. a duplicate
  unique key), the *entire* batch is rejected and nothing is inserted —
  intentional, so a bad row doesn't leave you guessing which rows silently
  didn't make it in. Fix the offending row (the error message from
  Postgres usually names the constraint) and resubmit.

### Foods

- `GET /foods`
- `GET /foods/:id`
- `GET /foods/lookup` — see below
- `GET /foods/autocomplete` — see below
- `GET /foods/categories` — see below
- `GET /foods/substitutes` — see below
- `POST /foods` *(admin)*
- `POST /foods/bulk` *(admin)* — see [Bulk insert](#bulk-insert)
- `PUT /foods/:id` *(admin)*
- `PATCH /foods/:id` *(admin)*
- `DELETE /foods/:id` *(admin)*

Query params for `GET /foods`:

- `search` → maps to `food_name ilike`
- `category`
- `limit` (default `50`, capped at `100`)
- `offset` or `cursor` — see [Pagination](#pagination)
- `with_servings` → `true` to add `serving_sizes` to every row (see below) — works for both pagination modes

**Serving-Size Intelligence** — add `?with_servings=true` to `GET /foods/:id` or `GET /foods/lookup` to get a `serving_sizes` array alongside the usual per-100g/100ml fields: realistic Malawian household measures (e.g. "1 cup / chikombe", "1 chunk nsima", "1 sachet RUTF"), each with every nutrient already scaled from the 100g basis so you don't have to do the arithmetic. Three tiers, most specific first — the food's own FCT `measure`/`weight_g` if it has one (`source: "fct"`), a curated keyword match for common Malawian foods (`source: "local_intelligence"`), or a generic per-category estimate (`source: "category_estimate"`) — plus the raw 100g/100ml basis, always included as `source: "reference"`. Fully local/rule-based (no LLM call, no added latency); off by default so existing integrations are unaffected.

```json
GET /foods/45?with_servings=true
{
  "status": "success",
  "data": {
    "id": 45,
    "food_name": "Nsima (thick, maize)",
    "kcal": 130, "protein_g": 2.8, "carbs_g": 28.6, "...": "...per 100g",
    "serving_sizes": [
      { "label": "1 chunk / ndomondo (approx. 1 cup, 200g)", "grams": 200, "source": "local_intelligence",
        "nutrients": { "kcal": 260, "protein_g": 5.6, "carbs_g": 57.2 } },
      { "label": "100g", "grams": 100, "source": "reference",
        "nutrients": { "kcal": 130, "protein_g": 2.8, "carbs_g": 28.6 } }
    ]
  }
}
```

**`GET /foods/lookup`** — external cascade for foods not in the local database. Order: local cache → USDA FDC (name search) → Open Food Facts (barcode) → FatSecret barcode lookup (Premier-exclusive) → FatSecret name search. First external hit is cached into `external_foods_cache` so subsequent lookups skip the upstream calls. Public, rate-limited to 20 req/min per IP.

- `q` → name search (tries USDA, then FatSecret)
- `barcode` → barcode lookup (Open Food Facts, then FatSecret)
- `offset` (default `0`)
- `with_servings` → `true` to add `serving_sizes` (see above)

**`GET /foods/autocomplete?q=...&max_results=`** *(public, rate-limited, cached 1h)* — search-as-you-type suggestions via FatSecret's Premier-exclusive `foods.autocomplete.v2`. `max_results` defaults to `4`, capped at `10` (FatSecret's own limit). Returns a plain array of strings:

```json
{ "status": "success", "data": ["chicken", "chicken breast", "chicken salad"] }
```

**`GET /foods/categories`** *(public, rate-limited, cached 24h)* — the full FatSecret food category list (near-static reference data), via the Premier-exclusive `food_categories.get.v2`:

```json
{ "status": "success", "data": [{ "id": "1", "name": "Beans & Legumes", "description": "..." }] }
```

Both of the above require `FATSECRET_CONSUMER_KEY`/`FATSECRET_CONSUMER_SECRET` on a **Premier or Premier Free** plan — a Basic/free-tier key returns FatSecret error 14 ("Missing scope"), which surfaces here as a `503` ("not configured on this deployment"). See [Required Environment Variables](#required-environment-variables--bindings).

**`GET /foods/substitutes?food_name=chicken&limit=`** *(public, rate-limited, cached 1h)* — Malawi-specific substitution suggestions, entirely local (no FatSecret dependency). Resolves `food_name` the same way a `/meals/analyze` ingredient resolves (local `foods` match, falling back to the external lookup cascade), classifies it into a substitution group, then ranks candidates from `foods` by nutritional closeness on that group's primary nutrient.

The grouping deliberately overrides the plain category taxonomy where it matters for how people actually substitute: chicken/fish/eggs (category `Protein`) and beans/soya/groundnuts (category `Legumes`) are treated as one combined "Protein / body-building foods" group, ranked by protein per 100g; grains plus cassava/potatoes are one "Starches / staples" group, ranked by carbohydrate. Everything else falls back to its own plain category. `limit` defaults to `5`, capped at `15`.

```json
{ "food_name": "chicken", "limit": 5 }
```
```json
{
  "status": "success",
  "data": {
    "original": { "food_name": "Chicken breast, roasted", "matched_source": "local", "category": "Protein", "per_100g": { "kcal": 165, "protein_g": 31, "carbs_g": 0, "fat_g": 3.6, "iron_mg": 1, "calcium_mg": 15 } },
    "substitution_group": "Protein / body-building foods",
    "ranked_by": "closeness in protein per 100g",
    "substitutes": [
      { "food_name": "Soya pieces, rehydrated", "category": "Legumes", "per_100g": { "protein_g": 34, "...": "..." }, "comparison_vs_original": { "protein_g": { "substitute": 34, "original": 31, "difference": 3 }, "...": "..." } },
      { "food_name": "Chambo, grilled", "category": "Protein", "...": "..." },
      { "food_name": "Groundnuts, roasted", "category": "Legumes", "...": "..." }
    ],
    "note": "Values are per 100g (Malawi FCT convention)..."
  }
}
```

`classifyCategory`'s keyword list includes common Lake Malawi fish names (chambo, usipa, kapenta, matemba, mbaba, chisawasawa, ntchila) specifically so they classify as `Protein` and turn up as substitutes/candidates — without that, a food named "Chambo, grilled" would silently fall through both classification and the keyword-based candidate search, since it doesn't contain the word "fish".

Ranking is a single primary nutrient's closeness, not a full dietary-equivalence judgment — it doesn't know about cost, local availability, taste, or realistic portion size, and every candidate's full `comparison_vs_original` (kcal/protein/carbs/fat/iron/calcium) is included precisely so a clinician or cook can see *how* it differs, not just that it's "close".

**`GET /foods/compare?foods=nsima,rice,potatoes`** *(public, rate-limited, cached 1h)* — Nutrient Comparison: lines up 2-6 foods side by side. Resolves each name the same way `/foods/substitutes` does (local match, falling back to the external lookup cascade), then returns per-100g energy, protein, carbohydrate, fiber, fat, and the full micronutrient panel for each — plus `nutrient_comparison`, the same fields pivoted per-nutrient with the highest/lowest food flagged, so "which has more iron" doesn't need re-deriving client-side.

Glycaemic considerations are included **only where a published, sourced value exists** — nothing is estimated or guessed. Each food gets either a `glycaemic.entries[]` (measured GI/GL with citation, from the `glycaemic_index_data` reference table — see below) or `glycaemic: null` plus a clearly-labelled `glycaemic_note` heuristic (fiber-to-carbohydrate ratio only, explicitly not presented as a GI value).

```json
GET /foods/compare?foods=nsima,rice,potatoes
{
  "status": "success",
  "data": {
    "foods": [
      {
        "requested_as": "nsima", "food_name": "Nsima (thick, maize)", "matched_source": "local", "category": "Grains",
        "per_100g": { "energy_kcal": 130, "protein_g": 2.8, "carbs_g": 28.6, "fiber_g": 1.2, "...": "..." },
        "glycaemic": {
          "entries": [
            { "matched_as": "Maize stiff porridge (nsima), whole maize flour", "gi_value": 94.06, "gl_value": 47.03, "gi_category": "high", "source": "Mlotha V, et al. 2016...", "...": "..." },
            { "matched_as": "Maize stiff porridge (nsima), fermented maize grits", "gi_value": 65.49, "gl_value": 32.75, "gi_category": "medium", "source": "Mlotha V, et al. 2016...", "...": "..." }
          ]
        },
        "glycaemic_note": "Measured GI/GL from published sources — see entries[].source. Multiple entries mean multiple processing methods/studies exist..."
      },
      { "requested_as": "rice", "food_name": "Rice, white, cooked", "...": "...", "glycaemic": { "entries": [{ "gi_value": 73, "source": "Atkinson et al. 2021", "...": "..." }] } },
      { "requested_as": "potatoes", "food_name": "Potato, Irish, boiled", "...": "...", "glycaemic": null, "glycaemic_note": "No published GI/GL data on file for this food... Fiber is low relative to carbohydrate..." }
    ],
    "nutrient_comparison": {
      "protein_g": { "label": "Protein (g)", "values": { "Nsima (thick, maize)": 2.8, "Rice, white, cooked": 2.7, "Potato, Irish, boiled": 2.0 }, "highest": "Nsima (thick, maize)", "lowest": "Potato, Irish, boiled" },
      "...": "..."
    },
    "note": "Values are per 100g... Glycaemic figures are only shown where a published, sourced value exists..."
  }
}
```

Note the Malawi-specific nsima entries above come from an actual local study (Mlotha et al. 2016) that tested three processing variants (whole maize flour, maize grits, fermented maize grits) — all three surface if `foods=nsima` matches, since which one applies depends on how it was actually milled/prepared, not something CNR can infer from a food name alone.

### Glycaemic Index / Load Reference (`/glycaemic-index`)

Standalone reference table backing the `glycaemic` block on `GET /foods/compare` (see [`sql/004_add_glycaemic_index.sql`](sql/004_add_glycaemic_index.sql)). Kept separate from `foods` because GI/GL is measured per specific preparation/variety and rarely lines up 1:1 with an FCT row — rows are matched to a food name by keyword (`match_keywords`, e.g. `["nsima", "maize", "cornmeal"]`) at query time instead of a foreign key.

- `GET /glycaemic-index` — `search` (matches `food_name`), standard pagination
- `GET /glycaemic-index/:id`
- `POST /glycaemic-index` *(admin)* — requires `food_name`, `match_keywords` (non-empty array), and `source` (citation) — GI/GL values are never accepted without a traceable source
- `POST /glycaemic-index/bulk` *(admin)* — see [Bulk insert](#bulk-insert); seed file: [`scripts/glycaemic_index_seed.json`](scripts/glycaemic_index_seed.json)
- `PUT` / `PATCH` / `DELETE /glycaemic-index/:id` *(admin)*

The bundled seed covers Malawi's three nsima processing variants (Mlotha et al. 2016 — the only Malawi-specific GI study found), white/brown rice, boiled/mashed potato, boiled sweet potato, and cassava (flagged as high-variance/no regional consensus rather than given a single confident number). Extend it the same way as `drug_nutrient_interactions_seed.json` — add rows with a real citation, then `POST /glycaemic-index/bulk`.

### BMI-for-Age (`/bmi-for-age`)

WHO 2007 BMI-for-age reference for children and adolescents from 5y 1m to 19y 0m (61 to 228 completed months), as printed in the Malawi Ministry of Health guide *Eat Well to Live Well* (2021), Annex 2. Table: [`sql/012_add_bmi_for_age.sql`](sql/012_add_bmi_for_age.sql), 336 rows (168 girls, 168 boys), one per sex per age in months, each with the -3SD to +3SD BMI cut-offs. Values are transcribed from the guide, not estimated. Classification logic: [`src/bmiForAge.js`](src/bmiForAge.js).

- `GET /bmi-for-age/classify` *(public, rate-limited, cached 1h)* — `sex` (`girls` or `boys`; `girl`/`boy`/`female`/`male`/`f`/`m` also accepted), `age_months` (whole number, years x 12 + months, so 7y 11m = 95), and either `bmi` or both `weight_kg` and `height_cm`. Returns `status`, the rounded `bmi`, and the `cutoffs` used.
- `GET /bmi-for-age` — the raw reference rows; optional `sex` and `age_months` filters, standard pagination.
- `POST /bmi-for-age/bulk` *(admin)* — see [Bulk insert](#bulk-insert); seed file: [`scripts/bmi_for_age_seed.json`](scripts/bmi_for_age_seed.json). A unique `(sex, age_months)` constraint rejects a second seeding attempt instead of duplicating rows.

```
GET /bmi-for-age/classify?sex=girls&age_months=95&weight_kg=26&height_cm=121.1
```

```json
{
  "status": "success",
  "message": "BMI-for-age classification",
  "data": {
    "sex": "girls", "age_months": 95, "status": "overweight", "bmi": 17.7,
    "cutoffs": { "-3SD": 11.9, "-2SD": 12.9, "-1SD": 14.1, "median": 15.7, "+1SD": 17.7, "+2SD": 20.5, "+3SD": 24.6 },
    "source": "WHO 2007 BMI-for-age (5-19 years), as printed in Malawi Ministry of Health, Eat Well to Live Well (2021), Annex 2",
    "note": "Screening aid only, not a diagnosis. ..."
  }
}
```

Cut-offs (strict inequalities, compared against the **unrounded** BMI, so a displayed BMI of 17.7 can still be above a 17.7 cut-off): severe thinness < -3SD, thinness < -2SD, normal from -2SD to +1SD, overweight > +1SD, obesity > +2SD. The printed guide lists severe thinness as "< -1 SD", which looks like a typo, so the WHO -3SD cut-off is used. Ages outside 61 to 228 months return a 400: under-5s need the WHO child growth standards and adults use adult BMI cut-offs. This is a screening aid, not a diagnosis.

### Head Circumference Velocity (`/hc-velocity`)

WHO Child Growth Standards 6-month head circumference **increments** (simplified field tables), birth to 24 months, -3 SD to +3 SD, for girls and boys. Table: [`sql/018_add_who_hc_velocity.sql`](sql/018_add_who_hc_velocity.sql), 38 rows (19 girls + 19 boys), one per sex per 6-month window (0-6, 1-7, ... 18-24 months). Values are transcribed from the printed tables, not estimated. Logic: [`src/hcVelocity.js`](src/hcVelocity.js). This is how fast the head grew over a window, **not** head circumference for age.

- `GET /hc-velocity/classify` *(public, rate-limited, cached 1h)* — `sex`, `start_age_months` (0-18, whole months at the first measurement; 3 means the 3-9 month window), and either `increment_cm` or both `hc_start_cm` and `hc_end_cm`. Optional `end_age_months` must equal start + 6. Returns `status`, `increment_cm`, `z_approx` (interpolated between the printed SDs, null beyond -3 or +3) and the `cutoffs` used.
- `GET /hc-velocity` — the raw reference rows; optional `sex` and `start_age_months` filters, standard pagination.
- `POST /hc-velocity/bulk` *(admin)* — see [Bulk insert](#bulk-insert); seed file: [`scripts/who_hc_velocity_seed.json`](scripts/who_hc_velocity_seed.json). A unique `(sex, interval_start_months)` constraint rejects a second seeding attempt.

Bands (strict): very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. Screening aid only, not a diagnosis; interpret with head circumference for age and clinical context.

```
GET /hc-velocity/classify?sex=girls&start_age_months=3&hc_start_cm=40.2&hc_end_cm=43.9
```

Setup: run `sql/018_add_who_hc_velocity.sql` in the Supabase SQL editor, then `POST /hc-velocity/bulk` once with the seed file.

### Length Velocity (`/length-velocity`)

WHO Child Growth Standards 6-month length **increments** (simplified field tables), birth to 24 months, -3 SD to +3 SD, for girls and boys. Table: [`sql/019_add_who_length_velocity.sql`](sql/019_add_who_length_velocity.sql), 38 rows (19 girls + 19 boys), one per sex per 6-month window (0-6, 1-7, ... 18-24 months). Values are transcribed from the printed tables, not estimated. Logic: [`src/lengthVelocity.js`](src/lengthVelocity.js) (classification shared with `src/hcVelocity.js`). This is how fast the child grew over a window, **not** length for age.

- `GET /length-velocity/classify` *(public, rate-limited, cached 1h)* — `sex`, `start_age_months` (0-18, whole months at the first measurement; 3 means the 3-9 month window), and either `increment_cm` or both `length_start_cm` and `length_end_cm`. Optional `end_age_months` must equal start + 6. Returns `status`, `increment_cm`, `z_approx` (interpolated between the printed SDs, null beyond -3 or +3) and the `cutoffs` used.
- `GET /length-velocity` — the raw reference rows; optional `sex` and `start_age_months` filters, standard pagination.
- `POST /length-velocity/bulk` *(admin)* — see [Bulk insert](#bulk-insert); seed file: [`scripts/who_length_velocity_seed.json`](scripts/who_length_velocity_seed.json). A unique `(sex, interval_start_months)` constraint rejects a second seeding attempt.

Bands (strict): very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. Screening aid only, not a diagnosis; use recumbent length measured the same way at both visits, and interpret with length-for-age, weight-for-length and clinical context.

```
GET /length-velocity/classify?sex=girls&start_age_months=3&length_start_cm=61.0&length_end_cm=71.3
```

Setup: run `sql/019_add_who_length_velocity.sql` in the Supabase SQL editor, then `POST /length-velocity/bulk` once with the seed file.

### Weight Velocity (`/weight-velocity`)

WHO Child Growth Standards 6-month weight **increments in grams** (simplified field tables), birth to 24 months, for girls and boys. Table: [`sql/020_add_who_weight_velocity.sql`](sql/020_add_who_weight_velocity.sql), 38 rows (19 girls + 19 boys), one per sex per 6-month window (0-6, 1-7, ... 18-24 months). Logic: [`src/weightVelocity.js`](src/weightVelocity.js). This is how much weight the child gained over a window, **not** weight for age.

**Where the numbers come from:** the -3 SD to +3 SD cut-offs for both sexes are transcribed from the printed WHO z-score tables. Each row also stores that table's L, M, S and Delta parameters, so the API returns an exact z-score and percentile (`z = (((x + Delta) / M)^L - 1) / (L*S)`) as well as the band. A unit test re-checks all 266 stored cut-offs against their own L, M, S and Delta within 1 g.

- `GET /weight-velocity/classify` *(public, rate-limited, cached 1h)* — `sex`, `start_age_months` (0-18, whole months at the first weighing; 3 means the 3-9 month window), and either `increment_g` (grams) or both `weight_start_kg` and `weight_end_kg` (kilograms). Optional `end_age_months` must equal start + 6. Returns `status`, `increment_g`, `z_score`, `percentile` and the `cutoffs` (grams) used. `z_score` and `percentile` are `null` when the Delta-shifted increment is not positive.
- `GET /weight-velocity` — the raw reference rows including L, M, S and Delta; optional `sex` and `start_age_months` filters, standard pagination.
- `POST /weight-velocity/bulk` *(admin)* — see [Bulk insert](#bulk-insert); seed file: [`scripts/who_weight_velocity_seed.json`](scripts/who_weight_velocity_seed.json). A unique `(sex, interval_start_months)` constraint rejects a second seeding attempt.

Bands (strict): very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. Increments can legitimately be near zero or negative in the second year (the late-window -3 SD cut-offs are around 0 g or below). Screening aid only, not a diagnosis; weight gain varies with illness, feeding and scale error, so repeat on the same scale and interpret with weight-for-age and weight-for-length.

```
GET /weight-velocity/classify?sex=girls&start_age_months=3&weight_start_kg=5.8&weight_end_kg=8.2
```

Setup: run `sql/020_add_who_weight_velocity.sql` in the Supabase SQL editor, then `POST /weight-velocity/bulk` once with the seed file.

### MUAC-for-age (`/muac-for-age`)

WHO Child Growth Standards **arm circumference-for-age** (cm), 3 to 60 months, girls and boys. Table: [`sql/021_add_who_muac_for_age.sql`](sql/021_add_who_muac_for_age.sql), one row per sex per completed month, taken from WHO's expanded daily table at day = round(months x 30.4375). Logic: [`src/muacForAge.js`](src/muacForAge.js). This is MUAC as a **z-score for age**, not the fixed-cut-off MUAC tape used in community screening (115 mm / 125 mm).

**Where the numbers come from:** the -3 SD to +3 SD cut-offs are transcribed from the WHO expanded z-score tables, and each row stores that table's L, M and S, so the API returns an exact z-score and percentile (`z = ((x / M)^L - 1) / (L*S)`; beyond +/-3 SD WHO's linear extension is used). A unit test re-checks every stored cut-off against its own L, M, S within 0.001 cm.

- `GET /muac-for-age/classify` *(public, rate-limited, cached 1h)* — `sex`, `age_months` (3-60, whole months), and `muac_cm` or `muac_mm`. Returns `status`, `muac_cm`, `z_score`, `percentile` and the `cutoffs` (cm) used.
- `GET /muac-for-age` — raw reference rows including L, M, S; optional `sex` and `age_months` filters, standard pagination.
- `POST /muac-for-age/bulk` *(admin)* — see [Bulk insert](#bulk-insert); seed file: [`scripts/muac_for_age_seed.json`](scripts/muac_for_age_seed.json). A unique `(sex, age_months)` constraint rejects re-seeding of months already present, so the table can be loaded in more than one file. Regenerate or extend the seed with `node scripts/build_muac_seed.mjs <girls.txt> <boys.txt>` (months missing from the input are skipped and listed).

Bands (strict): very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. Screening aid only, not a diagnosis.

```
GET /muac-for-age/classify?sex=girls&age_months=12&muac_cm=13.5
```

Setup: run `sql/021_add_who_muac_for_age.sql` in the Supabase SQL editor, then `POST /muac-for-age/bulk` with the seed file.

### MUAC fixed cut-offs (`/muac`)

Severe / moderate / normal classification of mid-upper arm circumference by age group, 6 months to adult. Logic: [`src/muacFixed.js`](src/muacFixed.js). No database table and nothing to seed. Source: WHO, *Guideline for Integrated Approach to the National Care of HIV Infected Children (6 months - 14 years)*, 2008, as reproduced in the FANTA Ethiopia MUAC chart.

| Age | Severe | Moderate | Normal |
|---|---|---|---|
| 6-11 months | < 11 cm | 11-12 cm | > 12 cm |
| 12-59 months | < 11 cm | 11-13 cm | > 13 cm |
| 5-9 years | < 13.5 cm | 13.5-14.5 cm | > 14.5 cm |
| 10-14 years | < 16 cm | 16-18 cm | > 18 cm |
| Adults (15 y+) | < 18 cm | 18-21 cm | > 21 cm |

- `GET /muac/classify` *(public, rate-limited, cached 1h)* — `age_months` (6 or more, whole months) and `muac_cm` or `muac_mm`. Returns `age_group`, `status`, `muac_cm` and the `cutoffs_cm` used. Moderate includes both end values.

**Check your programme's cut-offs:** for 6-59 months the WHO/UNICEF community screening cut-offs most CMAM programmes use are 115 mm (severe) and 125 mm (moderate), which differ from this chart. For MUAC as a z-score for age see [`/muac-for-age`](#muac-for-age-muac-for-age).

```
GET /muac/classify?age_months=18&muac_cm=11.8
```

### Fenton Preterm Growth Chart (`/fenton-preterm`)

Weight, length, and head-circumference z-scores/percentiles for preterm infants, both the 2013 (Fenton & Kim, *BMC Pediatrics* 2013;13:59) and 2025 (Fenton, Elmrayed & Alshaikh, *Paediatric and Perinatal Epidemiology* 2025, PMID 40534585) references. LMS parameters provided directly by Dr. Tanis Fenton (University of Calgary) by email. Table: [`sql/013_add_fenton_preterm.sql`](sql/013_add_fenton_preterm.sql), 2284 rows (2013 + 2025, both sexes, all 3 metrics). Calculation logic: [`src/fentonPreterm.js`](src/fentonPreterm.js). Source-data provenance and verification notes (the source file itself is intentionally *not* in this public repo): [`data-sources/fenton/README.md`](data-sources/fenton/README.md).

**License — this is not open data like the rest of CNR.** Shared under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) for non-commercial use in this app only, with two extra conditions from Dr. Fenton: the underlying L/M/S values must never be visible to end users, and must never be shared with other hospitals or organizations. So, unlike every other reference table in CNR:

- There is **no `GET /fenton-preterm` list route** — every read path (`classify`, `profile`, `growth`, `velocity`, `chart`, `references`) only ever returns a computed result (a z-score/percentile/status, a rendered image, or static metadata), never a raw L/M/S row.
- Don't add one, and don't add a mode to any of the above that echoes L/M/S or the raw curve as JSON — `chart`'s SVG rendering is the one sanctioned way to expose the curve shape, as an image, not data. If this needs to change, that's a conversation with Edison about the data-sharing agreement, not a routine API change.

- `GET /fenton-preterm/classify` *(public, rate-limited, cached 1h)* — `sex` (`boys`/`girls`, or `boy`/`girl`/`male`/`female`/`m`/`f`), `metric` (`weight`/`length`/`hc`), `gest_age_weeks` (22-50), `day` (0-6, day of the gestational week, default 0), `value` (grams for weight, cm for length/hc), and optional `reference_year` (`2013` or `2025`, default `2025`). Returns `z`, `percentile`, and `status`.
- `POST /fenton-preterm/profile` *(public, rate-limited)* — classify weight + length + HC together at one timepoint. Body: `{sex, reference_year?, gest_age_weeks, day?, weight?, length?, hc?}` — at least one of `weight`/`length`/`hc` required, any combination is fine. Returns one `{value, z, percentile, status}` per metric provided.
- `POST /fenton-preterm/growth` *(public, rate-limited)* — classify a series of same-metric measurements over time and return the trajectory, chart-ready. Body: `{sex, metric, reference_year?, measurements: [{gest_age_weeks, day?, value}, ...]}` (up to 50 points, any order — sorted by age server-side). Returns each point's `{gest_age_weeks, day, value, z, percentile, status}` plus a `trend` block (`first_z`/`last_z`/`min_z`/`max_z`/`z_change_overall`, and `notable_drops`: consecutive-point gaps where z fell ≥0.67 — roughly one major percentile band. Descriptive only, not a clinical threshold.).
- `POST /fenton-preterm/velocity` *(public, rate-limited)* — same body shape as `/growth`, 2+ points. Returns velocity for each consecutive pair: weight in **g/kg/day** (average-weight method: Δweight / average-weight-kg / days — the long-standing NICU convention), length/HC in **cm/week**.
- `GET /fenton-preterm/chart` *(public, rate-limited, cached 1h)* — `sex`, `metric`, optional `reference_year`, and optional `points` (e.g. `points=28w0d:900,30w0d:1200,32w0d:1500` — day suffix optional, defaults `0`) to overlay an infant's own trajectory. Returns a self-contained **SVG image** (`Content-Type: image/svg+xml`) with the P3/P10/P50/P90/P97 reference curves and, if given, the overlay points/line. **This is the only endpoint that touches the full reference curve, and it never returns curve data as JSON — only rendered vector graphics** (mirrors Dr. Fenton's own public tool, which outputs jpg/pdf images rather than data points). See [`src/fentonChart.js`](src/fentonChart.js).
- `GET /fenton-preterm/references` *(public, rate-limited, cached 1h)* — static metadata: both years' citations/DOIs, sexes, metrics, the **exact** valid age range per (year, metric) — verified against the seeded data, not approximated — and the license summary. No L/M/S values.
- `POST /fenton-preterm/bulk` *(admin)* — see [Bulk insert](#bulk-insert); 5 seed files (500 rows each except the last, 284): [`scripts/fenton_preterm_seed_1.json`](scripts/fenton_preterm_seed_1.json) through `_5.json`. Run all 5 — the unique `(reference_year, sex, metric, time_days)` constraint rejects a repeat seed instead of duplicating rows.

```
GET /fenton-preterm/classify?sex=girls&metric=weight&gest_age_weeks=32&day=0&value=1500
```

```json
{
  "status": "success",
  "message": "Fenton preterm growth chart classification",
  "data": {
    "sex": "girls", "metric": "weight", "reference_year": 2025,
    "gest_age_weeks": 32, "day": 0, "value": 1500,
    "z": -0.92, "percentile": 17.9, "status": "appropriate",
    "note": "Screening aid only, not a diagnosis. SGA/LGA labels are only valid AT BIRTH per Fenton's own guidance; this 'status' is a generic +/-2SD read usable at any age for interval growth monitoring. Weight includes the WHO SD23 correction for extreme values; length/HC do not (matches Fenton's own calculator)."
  }
}
```

`POST /fenton-preterm/profile` — same 32w0d girl, all three metrics at once:

```json
// request: {"sex":"girls","gest_age_weeks":32,"day":0,"weight":1500,"length":41,"hc":29}
{
  "status": "success",
  "message": "Fenton preterm growth profile",
  "data": {
    "sex": "girls", "reference_year": 2025, "gest_age_weeks": 32, "day": 0,
    "metrics": {
      "weight": { "value": 1500, "z": -0.92, "percentile": 17.9, "status": "appropriate" },
      "length": { "value": 41,   "z": -0.23, "percentile": 41.0, "status": "appropriate" },
      "hc":     { "value": 29,   "z": -0.13, "percentile": 44.7, "status": "appropriate" }
    },
    "note": "..."
  }
}
```

`POST /fenton-preterm/growth` — three weight measurements over 4 weeks:

```json
// request: {"sex":"girls","metric":"weight","measurements":[
//   {"gest_age_weeks":28,"value":900},{"gest_age_weeks":30,"value":1050},{"gest_age_weeks":32,"value":1500}]}
{
  "data": {
    "points": [
      { "gest_age_weeks": 28, "day": 0, "value": 900,  "z": -1.20, "percentile": 11.5, "status": "appropriate" },
      { "gest_age_weeks": 30, "day": 0, "value": 1050, "z": -1.72, "percentile": 4.2,  "status": "appropriate" },
      { "gest_age_weeks": 32, "day": 0, "value": 1500, "z": -0.92, "percentile": 17.9, "status": "appropriate" }
    ],
    "trend": { "first_z": -1.20, "last_z": -0.92, "z_change_overall": 0.28, "min_z": -1.72, "max_z": -0.92, "notable_drops": [] }
  }
}
```

`POST /fenton-preterm/velocity` — same two-point weight gain: `900g → 1200g` over 14 days → `{"velocity": 20.4, "unit": "g/kg/day", "days": 14}` (average-weight method).

`GET /fenton-preterm/chart?sex=girls&metric=weight&points=28w0d:900,30w0d:1200,32w0d:1500` returns an SVG with the 5 reference curves and a dashed line through those 3 dots.

The age axis is days since 22 completed weeks gestation (`(gest_age_weeks - 22) * 7 + day`), matching Dr. Fenton's own spreadsheet's lookup axis exactly, and the reference-row lookup is a step function (largest tabulated age ≤ the requested age) rather than interpolated — same behaviour as her Excel `LOOKUP()`, so results match her calculator to within rounding. Weight's z-score gets the WHO-recommended SD23 correction for values beyond ±3SD (a linear extension from the SD2/SD3 cut-offs, per the [WHO technical report](http://www.who.int/childgrowth/standards/technical_report/en/)); length and head circumference don't — Dr. Fenton's own calculator doesn't correct those either, so neither does this. `status` is a plain ±2SD read (`small`/`appropriate`/`large`) usable at any postnatal age for interval growth monitoring — it is deliberately **not** the SGA/LGA label, which by Dr. Fenton's own guidance only means something at birth.

Length and head-circumference reference data start partway through the 22-50 week range, and it differs by year and metric — a `gest_age_weeks`/`day` before the real floor returns a clear 400 rather than a wrong answer:

| | 2013 | 2025 |
|---|---|---|
| weight | 22.6 wk | 22.5 wk |
| length | 23.5 wk | 23.5 wk |
| hc | 23.5 wk | 22.5 wk |

(An earlier version of this endpoint used a single hardcoded guess — `length` rejected anything before 30.6 weeks — which wrongly rejected valid length queries between 23.5 and 30.6 weeks. Fixed by keying the floor on the actual seeded data per `(reference_year, metric)` instead of approximating.)

### FHIR facade (`/fhir`) — growth + full Nutrition Care Process

Phase 1 (below) is a stateless FHIR R4 translation layer over the classify endpoints above. **Phase 2 adds the whole Nutrition Care Process** — see [NCP operations](#ncp-operations-fhir-phase-2). Groundwork for future EHR/HIE integration. **Not a FHIR server with storage** (Chakudya has never persisted patient records, and this doesn't change that — a real EHR is expected to store the returned `Observation` itself), and **not yet registered with any OpenHIM/HIE instance** — that's a separate, later step once there's a real instance to register with. See [`src/fhir.js`](src/fhir.js) for the full scope note.

- `GET /fhir/metadata` *(public, rate-limited)* — FHIR `CapabilityStatement`.
- `POST /fhir/Observation/$evaluate-growth` *(public, rate-limited)* — body is a FHIR `Parameters` resource:
  ```json
  {
    "resourceType": "Parameters",
    "parameter": [
      { "name": "sex", "valueCode": "female" },
      { "name": "gestationalAgeWeeks", "valueDecimal": 32 },
      { "name": "gestationalAgeDays", "valueInteger": 0 },
      { "name": "measurement", "part": [
        { "name": "type", "valueCode": "weight" },
        { "name": "value", "valueQuantity": { "value": 1500, "unit": "g" } }
      ]}
    ]
  }
  ```
  Routes on age: `gestationalAgeWeeks` (22-50) → Fenton preterm; `birthDate` (+ optional `effectiveDateTime`, default now) resolving to 5y1m-19y0m postnatal → WHO BMI-for-age. **The WHO 0-59-month gap is honest, not silent** — that age range returns a FHIR `OperationOutcome`, because chakudya-api has no endpoint for it (yet). One `measurement` → a single `Observation`; more than one → a `Bundle` (type `collection`). BMI-for-age needs either a `bmi` measurement or `weight`+`length` together (computes BMI itself, same unrounded formula as `/bmi-for-age/classify`).

  Units: weight accepts `g` or `kg`; length/hc accept `cm` or `m`; anything else is a 400, not a guess.

  Each `Observation` carries `z-score`/`percentile`/`status` as `component`s (Chakudya-specific codes — there's no LOINC fit for "Fenton status: appropriate"), a best-effort standard `interpretation` (v3-ObservationInterpretation N/L/H/LL/HH) for FHIR clients that only read that field, the same screening-aid `note` text as the native endpoints, and an `extension` recording which reference was used. Weight/length/HC use LOINC 29463-7/8302-2/9843-4; BMI uses 39156-5.

#### NCP operations (FHIR Phase 2)

The Academy of Nutrition and Dietetics Nutrition Care Process, end to end, as stateless FHIR R4 operations. Same contract as Phase 1: **nothing is stored or logged beyond method/path/status** — the caller's EHR persists what comes back. All are `POST`, public, rate-limited (100/min/IP), body is a FHIR `Parameters` resource, success is a `Bundle`, failure is an `OperationOutcome` (400 malformed, 422 valid-but-unsupported). Source: [`src/fhirNcp.js`](src/fhirNcp.js) (pure functions, tests in `test/fhirNcp.test.js`).

| NCP step | Operation | FHIR output |
|---|---|---|
| Screening | `POST /fhir/Observation/$screen` | MUST (default), NRS-2002 (`tool=nrs-2002`), MNA (`tool=mna`), SGA (`tool=sga`), PG-SGA (`tool=pg-sga`) or NACS classification (`tool=nacs`), adults (NACS also children) → `Observation` (score, sub-scores, risk category, management note) |
| 1. Assessment | `POST /fhir/Observation/$assess-nutrition` | `Observation`s: weight/height/BMI (+WHO adult class), % weight change (+ standard-interval significance), Mifflin-St Jeor BEE → energy requirement, protein requirement, intake adequacy, GLIM criteria, and any FH/AD/BD/PD/CH `indicator` you pass |
| 2. Diagnosis | `POST /fhir/Condition/$diagnose` | PES statement → `Condition` (problem, etiology, signs/symptoms, severity, evidence refs) |
| 3. Intervention | `POST /fhir/CarePlan/$intervene` | `CarePlan` + `Goal`s + `NutritionOrder`s (oral diet / supplement / enteral formula) + `ServiceRequest`s (education / counseling / coordination of care) |
| 4. Monitoring & evaluation | `POST /fhir/Goal/$evaluate` | `Goal` with `achievementStatus` (achieved / improving / no-change / worsening / sustaining / not-achieved / in-progress) + outcome `Observation` |
| Terminology | `GET /fhir/CodeSystem/ncp-diagnosis` | the NI/NC/NB diagnostic terms as a FHIR `CodeSystem` (public, from Supabase) |
| Conformance | `GET /fhir/CodeSystem/{name}`, `/fhir/OperationDefinition/{id}`, `/fhir/StructureDefinition/{name}` | static definitions behind every URL the facade emits |
| Documentation | `POST /fhir/Bundle/$ncp-document` | ADIME `Composition` **document Bundle** assembled from the Bundles above |

**What Chakudya computes vs. what the clinician supplies.** Chakudya computes the deterministic parts (BMI, % weight change, MUST score, Mifflin-St Jeor BEE, GLIM criteria logic, goal progress). It does **not** choose the nutrition diagnosis, goals or orders — the PES statement, targets, diet prescription etc. are inputs it validates and shapes into FHIR. Energy/protein requirements are only produced when you pass `energyFactor` / `proteinGPerKg`; the factor is your clinical call, not a default. Everything carries the screening-aid disclaimer.

**Conventions**
- Every operation that FHIR requires a patient for (`$diagnose`, `$intervene`, `$evaluate`, `$ncp-document`) needs `subject` (`valueString: "Patient/123"`). It is optional for `$screen` / `$assess-nutrition`.
- Units are never guessed: weight `kg|g`, height `cm|m`; goal quantities must share one unit (mismatch → 400, no silent conversion).
- Intervention defaults are conservative: `status: draft`, `intent: proposal` (Goals → `proposed`). Pass `status` (`draft|active`) and `intent` (`proposal|plan|order`) to change.
- Resources inside a returned Bundle cross-reference each other by `urn:uuid` `fullUrl`. Pass whole Bundles into `$ncp-document` (as `resource` parameters) to keep those links valid.
- Each Observation is tagged with an NCP step (`category` → `…/CodeSystem/ncp-step`). In `$ncp-document`, untagged Observations are filed under Assessment; a `Goal` with an `achievementStatus` goes under Monitoring & evaluation, otherwise under Intervention. Empty ADIME sections get `emptyReason: notstarted`; Screening is only included if present.
- Diagnosis terminology: the NCP nutrition diagnostic terms (2006 edition — Intake `NI`, Clinical `NC`, Behavioral-Environmental `NB`, 62 terms) live in Supabase table `ncp_diagnosis_terms` ([`sql/017_add_ncp_diagnosis_terms.sql`](sql/017_add_ncp_diagnosis_terms.sql), run once in the SQL editor; re-running upserts). Pass `problemCode: "NI-5.2"` and `$diagnose` fills in the term text, domain and a coding on `…/fhir/CodeSystem/ncp-diagnosis`; terms marked "(specify)" need `problemSpecify` (e.g. `NI-55.1` + `Iron`), "(use with caution)" terms add a note. Unknown codes are a 400; if the table hasn't been created, `$diagnose` returns 503 naming the migration. You can still pass your own coding (`problemSystem` + `problemCode`), a public shortcut (`malnutrition`, `underweight`, `obesity`, …), or free text with `domain` + `problem`. A PES statement needs problem + ≥1 etiology + ≥1 signs/symptoms. The terminology belongs to the Academy of Nutrition and Dietetics — it's reference data here, not Chakudya's own content.

**Parameters by operation** (`valueX` types as in FHIR; `part` = nested parts)

- `$screen` — `tool`: `must` (default), `nrs-2002`, `mna`, `sga`, `pg-sga` or `nacs`.
  - **MUST**: `bmi` *or* `weight`+`height`; `weightLossPercent3to6Months` *or* `usualWeight`+`weight`; `acuteDiseaseNoIntake` (boolean, required).
  - **NRS-2002** (as printed in the supplied appendix; two stages): `ageYears` *or* `birthDate`; `bmi` *or* `weight`+`height`; `weightLossPercent` (0 if none) + `weightLossPeriodMonths` (when > 0); `intakePercentOfRequirement` (preceding week); `impairedGeneralCondition` (required when BMI ≤ 20.5); `diseaseSeverityScore` (0–3, **your clinical call**: 0 absent, 1 mild, 2 moderate, 3 severe — required once initial screening is positive); optional `severelyIll` / `reducedIntakeLastWeek` to override initial questions 4 / 3 (defaults: `diseaseSeverityScore = 3` / intake < 100%).
    - Initial screening (BMI < 20.5; weight loss in the last 3 months; reduced intake in the last week; severely ill): all NO → no final score, result `final-screening-not-required` (re-screen weekly). Any YES → final screening.
    - Final: nutritional-status score (weight loss > 5% in 3 / 2 / 1 months → 1 / 2 / 3, or > 15% in 3 months → 3; BMI 18.5–20.5 / < 18.5 *with* impaired general condition → 2 / 3; intake 50–75 / 20–60 / 0–25% of requirement → 1 / 2 / 3) + disease severity + 1 if age ≥ 70. Total ≥ 3 = `at-risk` (initiate a nutritional care plan), otherwise `not-at-risk` (re-screen weekly).
    - The appendix's intake bands overlap (e.g. 55% is in both 50–75 and 20–60): the **highest applicable score is used and the overlap is stated in the note**. The appendix text reads "age ≥ 7- years" (garbled); the standard threshold of 70 is implemented.
    - Optional both: `subject`, `effectiveDateTime`.
  - **MNA** (full Mini Nutritional Assessment, as printed on the supplied Nestlé form, revision 2009; two stages):
    - Screening (always): `foodIntakeDeclineScore` (A, 0–2), `weightLossKg3Months` (B; 0 or negative if none) *or* `weightLossUnknown: true`, `mobilityScore` (C, 0–2), `psychologicalStressOrAcuteDisease` (D, boolean), `neuropsychologicalScore` (E, 0–2), and `bmi` *or* `weight`+`height` (F). Optional `ageYears` / `birthDate`.
    - Screening score 12–14 → `normal`, and the form stops there: no assessment items, no total (the Observation carries `mna-screening-score` only). 11 or less → assessment items G–R are required too: `livesIndependently`, `moreThan3PrescriptionDrugs`, `pressureSoresOrUlcers`, `fullMealsPerDay`, `dairyDaily` + `legumesOrEggsTwiceWeekly` + `meatFishPoultryDaily` (K), `fruitOrVegetablesTwoPlusServings`, `fluidCupsPerDay`, `modeOfFeedingScore` (0–2), `selfViewNutritionScore` (0–2), `selfViewHealthScore` (0, 0.5, 1 or 2), `midArmCircumferenceCm`, `calfCircumferenceCm`. A missing item is a 400 that names it.
    - Measured items (weight loss, BMI, meals, protein markers, fluid, MAC, CC) are scored here from the raw value; judgement items (A, C, E, N, O, P) are sent as the printed option score, never guessed. Total = screening + assessment (max 30): 24–30 `normal`, 17–23.5 `at-risk`, below 17 `malnourished`. The total is a `valueQuantity` in `{score}` units because half points are possible (FHIR `Observation.value[x]` has no decimal).
    - The form has no band for a weight loss under 1 kg: it is scored as no weight loss (3) and the note says so. The MNA was developed for older adults; if `ageYears` is under 65 the note says to interpret with care, and under 18 is a 422. The MNA-SF "calf circumference instead of BMI" substitution is not on this form and is not implemented.
  - **SGA** (Subjective Global Assessment, as printed on the supplied NEMO / Queensland Health form, May 2009, adapted from Detsky 1994):
    - **The overall rating is yours.** The form lists descriptors under columns A, B and C and then an overall A / B / C, but gives no rule for combining them, so `overallRating` (`A`|`B`|`C`) is required and is never computed or suggested. It comes back as the Observation value. The labels (A well nourished, B moderately malnourished or suspected malnutrition, C severely malnourished) are Detsky's standard wording, not printed on the form.
    - History (all required): `weightLossPercent6Months` *or* `usualWeight`+`weight` (0–<5% loss = A, 5–10% = B, >10% = C; no change or a gain = A); `weightChange2Weeks` (`no-change-normal-weight`, `increase-within-5-percent`, `increase-1-level-above`, `no-change-below-usual-weight`, `increase-within-5-10-percent`, `decrease`); `dietaryIntake` (`no-change-adequate`, `no-change-inadequate`, `suboptimal-diet`, `full-liquid`, `hypocaloric-liquid`, `starvation`, `borderline-increasing`, `borderline-decreasing`, `poor-no-change`, `poor-increasing`, `poor-decreasing`); `nauseaDailyOver2Weeks`, `vomitingDailyOver2Weeks`, `diarrhoeaDailyOver2Weeks`, `anorexiaDailyOver2Weeks` (booleans); `functionalCapacity` (`no-dysfunction`, `difficulty-with-activities`, `bed-chair-ridden`); `functionalChange2Weeks` (`improved`, `no-change`, `regressed`). Each maps to the column(s) the form prints it in; every item is reported as its own grade component and the items are **not** merged into a domain score.
    - Two descriptors are printed in two columns: `increase-1-level-above` (A and B) and `poor-no-change` (B and C). You say which with `weightChange2WeeksGrade` / `dietaryIntakeGrade`; omitting it is a 400.
    - GI symptoms: the form's "none; intermittent / some / all (daily > 2 weeks)" is read from the four symptom booleans: none = A, one to three = B, all four = C.
    - Physical examination (optional, per site, grade `A`/`B`/`C`): `underEyesFat`, `tricepsFat`, `bicepsFat`, `temple`, `clavicle`, `shoulder`, `scapulaRibs`, `quadriceps`, `calf`, `knee`, `interosseousMuscle`, `oedema`, `ascites`. The form prints no column B for under-eyes, triceps, biceps, calf, knee and interosseous muscle, so a B there is a 400. The note states how many of the 13 sites were graded.
    - Adults only (under 18 is a 422); there is no age adjustment.
  - **PG-SGA** (Scored Patient-Generated SGA, as printed on the supplied form, FD Ottery v3.22.15, metric): a scored tool, unlike the plain SGA. `valueInteger` is the total A + B + C + D, triaged as printed: 0-1 `no-intervention`, 2-3 `education-and-symptom-management`, 4-8 `dietitian-intervention`, 9 or more `critical-need`.
    - **A, boxes 1-4** (all required except where noted). Box 1: `weightLossPercent1Month` *or* `weightOneMonthAgo`+`weight`; 6-month data (`weightLossPercent6Months` *or* `weightSixMonthsAgo`+`weight`) are used only when there is no 1-month data, as Worksheet 1 says. Points from the printed tables (1 month: 2-2.9% = 1, 3-4.9% = 2, 5-9.9% = 3, 10% or more = 4; 6 months: 2-5.9% = 1, 6-9.9% = 2, 10-19.9% = 3, 20% or more = 4), plus 1 when `pgsgaWeightChange2Weeks` is `decreased`. Box 2: `pgsgaIntakeVsUsual` (`unchanged`, `more-than-usual`, `less-than-usual`) and optionally `pgsgaCurrentIntake` (`normal-food-less-than-normal-amount`, `little-solid-food`, `only-liquids`, `only-nutritional-supplements`, `very-little-of-anything`, `only-tube-feeding-or-parenteral`). Box 3: repeatable `pgsgaSymptom` (`no-problems-eating`, `no-appetite`, `nausea`, `vomiting`, `constipation`, `diarrhoea`, `dry-mouth`, `mouth-sores`, `smells-bother-me`, `taste-changes`, `feel-full-quickly`, `problems-swallowing`, `fatigue`, `pain`, `other`), at least one. Box 4: `pgsgaActivity` (`normal`, `fairly-normal-activities`, `in-bed-or-chair-less-than-half-day`, `little-activity-most-of-day-in-bed-or-chair`, `bed-ridden`). The form's item weights are used as printed. `A` is also the PG-SGA short form score.
    - **B, Worksheet 2:** 1 point each for the optional booleans `cancer`, `aids`, `pulmonaryOrCardiacCachexia`, `chronicRenalInsufficiency`, `decubitusOpenWoundOrFistula`, `trauma`, plus 1 when age is greater than 65 (`ageYears` *or* `birthDate`, required). A condition you do not send is taken as absent, and the note says so.
    - **C, Worksheet 3:** optional `feverTemperatureC` (above 37.2 = 1, 38.3 or more = 2, 38.8 or more = 3), `feverDurationHours` (required with a fever: under 72 = 1, exactly 72 = 2, over 72 = 3; the form scores intensity or duration, whichever is greater) and `corticosteroidPrednisoneEquivalentMgPerDay` (under 10 = 1, 10 to under 30 = 2, 30 or more = 3). Nothing sent means none.
    - **D, Worksheet 4:** `physicalExamDeficit` (`none`, `mild`, `moderate`, `severe` = 0-3) is the clinician's overall rating of total body deficit and is required; it is never computed. Optional `muscleStatusRating`, `fatStoresRating`, `fluidStatusRating` (0-3) are recorded and do not change the score.
    - Optional `pgsgaGlobalCategory` (`A`, `B`, `C`, Worksheet 5) is carried as entered, never computed: the form lists descriptors per stage but no combining rule.
    - **Assumptions the supplied pages do not settle** (each is stated in the Observation note): Box 2 takes the higher of its two answers; Box 3 symptoms are added (the form says check all that apply); the "other relevant diagnoses" line scores nothing because it has no tick box. The PG-SGA SF is boxes 1-4 only. Adults only (under 18 is a 422). The per-site Worksheet 4 ratings (temples, clavicles and so on) are not implemented.
  - **NACS classification** (FANTA NACS User's Guide, Module 2, May 2016; children and adults). The guide's cutoffs are its "recommended standards" and countries may use different ones. Nothing is required except what you want classified; each indicator that is sent is classified on its own:
    - **MUAC** (`muacMm`, millimetres): children 6-59 months (under 115 SAM, 115 to under 125 MAM, 125 or more normal), 5-9 years (135 / 145), 10-14 years (160 / 185); adults not pregnant or postpartum (under 185 SAM, 185 to under 220 moderate malnutrition, 220 or more normal); pregnant or up to 6 months postpartum (`pregnantOrPostpartum: true`: 190 / 230). Age comes from `ageMonths` (needed under 5 years), `birthDate` (completed months) or `ageYears` (5 or over). Refused with a 422 where the guide gives no cutoffs: infants under 6 months, 15-17 year-olds, and pregnant or postpartum females under 18.
    - **Adult BMI** (`bmi`, or `weight`+`height`; 18 and over): under 16 severe, 16 to under 17 moderate, 17 to under 18.5 mild, 18.5 to under 25 normal, 25 to under 30 overweight, 30 or more obesity. BMI is rounded to 1 decimal before banding. Refused (422) for pregnant or postpartum women, as the guide says to use MUAC.
    - **BMI-for-age** (`bmiForAgeZScore`, 5-17 years): under -3 severe, -3 to under -2 moderate, -2 to +1 normal, over +1 to +2 overweight, over +2 obesity. You supply the z-score (`Observation/$evaluate-growth` computes it from the WHO 5-19 year tables); a plain `bmi` under 18 is a 400 because the guide uses the z-score there.
    - **Pre-pregnancy BMI** (`prePregnancyBmi`): under 18.5 underweight, 18.5-24.9 normal weight, 25.0-29.9 overweight, 30 or more obese. Reported as its own category, not as a status.
    - **Bilateral pitting edema** (`edemaGrade` 0-3 for +, ++, +++, with `edemaBothFeetOrLegs`, required above 0): in both feet or legs it is severe acute malnutrition on its own, regardless of anthropometry, so no other indicator is classified. Grade +++ is admitted for inpatient management; grades + and ++ are treated as outpatients only with appetite and no medical complications (`hasAppetite` and `hasMedicalComplications` are required for those grades). Any other combination returns `not-stated-by-guide` because the guide says nothing about it. Edema in one foot only is not counted.
    - **No combined status.** The guide gives no rule for combining indicators, so when more than one is classified each is a separate component and there is no top-level value (a single value is set only when exactly one indicator, or the edema rule, applies).
    - **Not implemented because the guide does not print them:** weight-for-height z-score cutoffs, and MUAC cutoffs for 15-17 year-olds. Also not built from this module: birth-weight and newborn weight-loss checks, the priority-client list, assessment frequency, and the biochemical, dietary and food-security assessments.
- `$assess-nutrition` (adults 18+; children → `$evaluate-growth`): `sex`, `ageYears` *or* `birthDate`, `weight`, `height`, `usualWeight` + `usualWeightPeriodDays`, `requirementWeight`, `energyFactor`, `proteinGPerKg`, `energyIntakeKcalPerDay`, `proteinIntakeGPerDay`; GLIM: `screeningPositive`, `muscleMass` (`none|mild-moderate|severe`), `inflammation` (`none|acute-disease-or-injury|chronic-disease`), `intakePercentOfRequirement`, `intakeReductionDays`, `malabsorption`, `glimBmiCutoffSet` (`default|asian`); repeatable `indicator` part: `domain` (`FH|AD|BD|PD|CH`), `display`, `code`, `system`, `value`.
  - Weight-change significance uses the standard Blackburn intervals (1 wk, 1 mo, 3 mo, 6 mo) and is only graded when `usualWeightPeriodDays` matches one; otherwise it reports `no-standard-threshold` rather than extrapolating.
  - GLIM follows Cederholm 2019 (≥1 phenotypic + ≥1 etiologic criterion after a positive screen; severity from the worst phenotypic criterion). Missing inputs are listed as "not assessed" rather than assumed. Weight loss uses strict `>5%` (≤6 mo) / `>10%` (>6 mo).
- `$diagnose`: `subject`; repeatable `diagnosis` part: `problemCode` (e.g. `NI-5.2`, resolves `problem` + `domain` for you) and `problemSpecify` for "(specify)" terms — or `domain` + `problem` for free text — repeatable `etiology`, repeatable `signsSymptoms`, optional `problemSystem`/`problemDisplay` (your own coding), `severity` (`mild|moderate|severe`), `verificationStatus` (`provisional` default | `confirmed`), `evidence` (repeatable reference string, e.g. an Observation `urn:uuid`), `recordedDate`.
- `$intervene`: `subject`, `addresses` (Condition refs), `title`, `status`, `intent`; repeatable parts `goal` (`description`, `measure`, `measureCode`, `direction`, `baseline`, `target`, `dueDate`, `priority`), `nutritionOrder` (`kind` = `oral-diet` → `type`, repeatable `nutrient` part {`name`,`amount`}, `texture`, `fluidConsistency`, `instruction`; `supplement` → `type`, `productName`, `quantity`, `instruction`; `enteral-formula` → `baseFormulaType`, `productName`, `route`, `rate`, `maxVolume`, `instruction`), `education` (`topic`, `audience`, `method`), `counseling` (`topic`, `approach`), `coordination` (`reason`, `with`).
- `$evaluate`: `subject`, repeatable `goal` part: `description`, `direction` (`increase|decrease|maintain`), `current` (Quantity, required), `target`, `baseline`, `lowerBound`/`upperBound` (for `maintain`), `measure`, `measureCode`, `noChangeTolerance` (default `0.02` = ±2% of the baseline→target gap counts as no change). Without a `baseline` the direction of change is **not guessed** (`in-progress`).
- `$ncp-document`: `subject`, `author` (`Practitioner/…` reference or a name), repeatable `resource` (single resources or whole Bundles from the operations above), optional `title`, `date`, `encounter`.

**Worked example** — a minimal ADIME loop:
```bash
# 1. Assess
curl -s -X POST "$BASE/fhir/Observation/\$assess-nutrition" -H 'content-type: application/json' -d '{
  "resourceType":"Parameters","parameter":[
    {"name":"subject","valueString":"Patient/42"},
    {"name":"sex","valueCode":"male"},{"name":"ageYears","valueInteger":40},
    {"name":"weight","valueQuantity":{"value":60,"unit":"kg"}},
    {"name":"height","valueQuantity":{"value":175,"unit":"cm"}},
    {"name":"usualWeight","valueQuantity":{"value":70,"unit":"kg"}},
    {"name":"usualWeightPeriodDays","valueInteger":91},
    {"name":"screeningPositive","valueBoolean":true},
    {"name":"inflammation","valueCode":"chronic-disease"}]}'
# 2. Diagnose  → POST /fhir/Condition/$diagnose   (PES parts)
# 3. Intervene → POST /fhir/CarePlan/$intervene   (goals + orders)
# 4. Monitor   → POST /fhir/Goal/$evaluate        (current vs baseline/target)
# 5. Document  → POST /fhir/Bundle/$ncp-document  (each Bundle above as a "resource" parameter)
```

**Honest limits.** Screening covers MUST, NRS-2002, MNA, SGA, PG-SGA and the NACS classification (no paediatric screening tools such as STRONGkids or PYMS yet, and no WHZ cutoffs — the MCP server has more). `$assess-nutrition` is adult-only; WHO 0–59-month growth is still unsupported (as in Phase 1). No `Patient`/`Encounter` resources are created — you pass references. Every canonical URL the facade emits now resolves: `GET /fhir/CodeSystem/{name}` (the code lists — `ncp-step`, `ncp-assessment-domain`, `glim`, `growth-status`, … — plus `ncp-diagnosis` from Supabase), `GET /fhir/OperationDefinition/{id}` (one per operation in `/fhir/metadata`, id = `<Resource>-<operation>`, e.g. `Observation-screen`) and `GET /fhir/StructureDefinition/{name}` (the Extensions, e.g. `pes-specify`). They are static definitions in [`src/fhirTerminology.js`](src/fhirTerminology.js); a test walks real operation output and fails if any emitted code system, code, extension or operation link lacks a definition, so add the definition when you add a field. These are conformance descriptions, not validated profiles. Not registered with any OpenHIM/HIE instance.

### Recipes

**`POST /recipes/calculate`** *(public, rate-limited)* — give it a list of ingredients, get back the recipe's total and per-serving nutrition. Builds directly on Serving-Size Intelligence above.

```json
{
  "servings": 4,
  "ingredients": [
    { "food_name": "rice", "quantity": 2, "unit": "cup" },
    { "food_name": "beans", "quantity": 1, "unit": "cup" },
    { "food_id": 34, "quantity": 150, "unit": "g" }
  ]
}
```

- Each ingredient needs `quantity` and either `food_id` (exact row) or `food_name` (matched against local `foods` first, then falling back to the same local→external cascade `GET /foods/lookup` uses — so ingredients outside the local FCT can still resolve).
- `unit` defaults to `"g"` if omitted. Accepts plain mass/volume units (`g`, `kg`, `ml`, `l`, `oz`, `lb`, `floz`/`fl_oz`, `pint`, `quart`, `gallon`, ...), `"serving"`/`"servings"`, or a household unit (`cup`, `tbsp`, `tsp`, `piece`, `slice`, `handful`, ...) — household units are matched against *that specific food's* own serving-size candidates first (so "2 cups rice" uses rice's own cup measure), falling back to a generic estimate only if there's no food-specific match. Conversion factors cross-checked against the Nutrition Care Manual (NC Dietetic Association).
- `servings` (top-level, optional, default `1`) — the recipe yield, used to compute `nutrients_per_serving`.
- Response includes `total_nutrients`, `nutrients_per_serving`, `total_grams`, `grams_per_serving`, a per-ingredient `ingredients[]` breakdown (with `grams_basis` explaining how each quantity was converted), and `unresolved_ingredients[]` for anything that couldn't be matched or converted — one bad ingredient never fails the whole request.

**`POST /meals/analyze`** *(public, rate-limited)* — same ingredient resolution as `/recipes/calculate` (built on the same shared `resolveIngredientsList()`), but framed around a single eaten meal rather than a recipe yield — no `servings`, since a meal is eaten once.

```json
{
  "meal_type": "lunch",
  "ingredients": [
    { "food_name": "nsima", "quantity": 1, "unit": "cup" },
    { "food_name": "beans", "quantity": 1, "unit": "cup" }
  ],
  "daily_targets": { "kcal": 2000, "protein_g": 50, "carbs_g": 260, "fat_g": 65 }
}
```

Adds, on top of the recipe response shape:
- `macronutrient_breakdown` — kcal from protein/carbs/fat (Atwater 4/4/9 factors) and each as a % of total meal kcal, plus `within_amdr_adult_reference` (whether each % falls inside the standard adult Institute of Medicine Acceptable Macronutrient Distribution Range: protein 10–35%, carbs 45–65%, fat 20–35%). Purely descriptive — a reference range, not a personalized target.
- `food_groups_present` / `food_groups_missing` — against a core set (Grains, Legumes, Protein, Vegetables, Fruits, Dairy), reusing the same category classification as Serving-Size Intelligence.
- `daily_target_comparison` — **only included if you supply `daily_targets`** in the request. This endpoint never invents a personalized target on its own (no age/sex/weight-based EER calculation happens here); pass in a target computed elsewhere (e.g. from the Harris-Benedict tools in `chakudya-mcp-server`) if you want this comparison.
- `clinical_flags` — **only included if you supply `conditions`**. Two families, different flag vocabularies:
  - **Excess-focused** — `"diabetes"`, `"hypertension"`, `"kidney_disease"`. `{ condition, flag: "appropriate"|"caution"|"avoid"|null, reasons: string[], note }`, evaluated off the meal's own nutrient totals (carbs/fiber for diabetes, sodium/potassium for hypertension, potassium/sodium/protein for kidney disease) against standard per-meal reference thresholds (ADA carb-counting, DASH sodium, KDOQI conservative-CKD).
  - **Adequacy-focused** — `"pregnancy"`, `"paediatric"`, `"anaemia"`. `{ condition, flag: "good"|"low"|"very_low"|null, reasons: string[], note }` — asks whether the meal meaningfully contributes toward a nutrient the person needs *more* of, using Chakudya's own DRI system (`src/dri_data.js`, the same data behind `GET /dri`) for the resolved life stage's RDA/AI, split evenly across 3 meals/day. Optional top-level `age` (years) and `sex` (`"male"`/`"female"`) narrow the life stage: `pregnancy` defaults to age 24 if omitted (noted in `reasons`), `anaemia` defaults to age 30 + female (also noted), `paediatric` **requires** `age` (and `sex` for age 9+) — omitting it returns `flag: null` with an explanatory reason instead of guessing.
  - **Allergen screening** — `"food_allergy"` requires a top-level `allergens` array (values from `ALLERGEN_KEYWORDS`: `peanut`, `tree_nut`, `dairy`, `egg`, `soy`, `wheat_gluten`, `fish`, `shellfish`, `sesame`) — a 400 if you request `food_allergy` without it. `{ condition, flag: "appropriate"|"avoid", reasons: string[], note }`, matched by keyword against each resolved ingredient's name (e.g. "groundnut" → peanut, "chambo"/"usipa" → fish) — **not a verified allergen database**; can't catch allergens hidden inside a composite/packaged product's real ingredient list.
  - All of these are **screening, not a diagnosis or a personalized prescription** — every flag's `note` spells out what it doesn't account for (e.g. kidney-disease phosphorus isn't tracked locally; pregnancy/paediatric screening ignores supplementation; a `null` flag means the underlying data was missing, not that the meal is "fine").

```json
{ "ingredients": [{ "food_name": "nsima", "quantity": 1, "unit": "cup" }], "conditions": ["diabetes", "kidney_disease"] }
```

```json
{ "ingredients": [{ "food_name": "groundnut flour porridge", "quantity": 1, "unit": "cup" }], "conditions": ["pregnancy", "food_allergy"], "age": 26, "allergens": ["peanut"] }
```

**`POST /ingredients/parse`** *(public, rate-limited)* — turns free text into the `ingredients[]` shape `/recipes/calculate` and `/meals/analyze` accept above, so a caller can paste a plain sentence instead of hand-building JSON.

```json
{ "text": "2 eggs, 1 cup rice, 100g chicken and ½ avocado" }
```

```json
{
  "status": "success",
  "data": {
    "text": "2 eggs, 1 cup rice, 100g chicken and ½ avocado",
    "count": 4,
    "ingredients": [
      { "food_name": "eggs", "quantity": 2, "unit": "serving" },
      { "food_name": "rice", "quantity": 1, "unit": "cup" },
      { "food_name": "chicken", "quantity": 100, "unit": "g" },
      { "food_name": "avocado", "quantity": 0.5, "unit": "serving" }
    ]
  }
}
```

- Handles unicode fractions (`½`, `¼`, `¾`, ...), mixed numbers (`1 1/2`), compact units (`100g`), and comma/`and`/`&`-separated lists.
- A bare count with no stated unit (`"2 eggs"`) comes back as `unit: "serving"`, not grams — `resolveIngredientGrams()` treats a missing unit as grams, and "serving" is what it already falls back to for count-like foods via each food's own serving-size candidates (see Serving-Size Intelligence above), so "2 eggs" resolves to 2 whole eggs, not 2g of egg.
- Primary parse is a Groq LLM call (handles plurals, descriptors like "chopped", word-form quantities like "half"); falls back to a local regex parser if `GROQ_API_KEY` isn't configured or the LLM call/parse fails. The fallback is cruder (numeric quantities only, keeps plurals as-is) but never throws.
- Pipe the `ingredients[]` straight into `POST /recipes/calculate` or `POST /meals/analyze`.

### Dietary Reference Intakes (DRI)

EAR, RDA, AI, UL, and AMDR by life stage — Food and Nutrition Board (NASEM/IOM) tables, covering infants through >70y, pregnancy, and lactation. Data lives in `src/dri_data.js`; see that file's header for sourcing and what's intentionally left out (a handful of trace-mineral ULs with no clean published number, and Sodium's UL, superseded by the 2019 Chronic Disease Risk Reduction Intake).

**`GET /dri/life-stages`** — the 22 life-stage groups (code, label, sex, age range).

**`GET /dri`** — look up DRI values either by `life_stage` code directly, or by `age`+`sex` (+`life_stage_type=pregnancy|lactation`). Omit `nutrient` to get every nutrient for that life stage plus its AMDR and sodium CDRR; include it for one nutrient only.

```
GET /dri?age=25&sex=female&nutrient=iron_mg
→ { "ear": 8.1, "rda": 18, "ai": null, "ul": 45, "target_type": "rda", "target": 18 }
```

**`POST /dri/compare`** — compares actual intake against RDA/AI, flags UL if exceeded. `intake` uses the same field names as `/recipes/calculate` or `/meals/analyze`'s `total_nutrients`, so either can be piped straight in.

```json
{ "age": 30, "sex": "female", "intake": { "calcium_mg": 45, "iron_mg": 9.2, "protein_g": 47.95 } }
```

- Only nutrients CNR's `foods` table actually tracks (`trackable: true` on `GET /dri`) can be compared — protein, carbs, fiber, and 11 vitamins/minerals. Thiamin, riboflavin, niacin, vitamin B6/E/K, and most trace minerals are lookup-only (no intake data exists for them yet); they come back in `skipped` on `/dri/compare` rather than silently dropped.
- `percent_of_target` is intake ÷ RDA-or-AI × 100 — no clinical interpretation is added (no "deficient"/"adequate" label), since a single day's percentage isn't a diagnosis.

### Exchange

- `GET /exchange`
- `POST /exchange` *(admin)*
- `POST /exchange/bulk` *(admin)*
- `PUT /exchange/:id` *(admin)*
- `PATCH /exchange/:id` *(admin)*
- `DELETE /exchange/:id` *(admin)*

Query params: `type`, `limit`, `offset`/`cursor`

### Renal

- `GET /renal`
- `POST /renal` *(admin)*
- `POST /renal/bulk` *(admin)*
- `PUT /renal/:id` *(admin)*
- `PATCH /renal/:id` *(admin)*
- `DELETE /renal/:id` *(admin)*

Query params: `limit`, `offset`/`cursor`

### Formulas

- `GET /formulas`
- `POST /formulas` *(admin)*
- `POST /formulas/bulk` *(admin)*
- `PUT /formulas/:id` *(admin)*
- `PATCH /formulas/:id` *(admin)*
- `DELETE /formulas/:id` *(admin)*

Query params: `route`, `limit`, `offset`/`cursor`

### Drug Interactions

Migrated from Oasis CNST's client-side 117-entry drug-nutrient interaction
database (`js/dni.js`), so every app in the ecosystem shares one copy
instead of each bundling its own. Sources: Krause & Mahan's *Food and the
Nutrition Care Process* 16th ed.; *The Essential Pocket Guide for Clinical
Nutrition* 4th ed.; LPI/OSU Micronutrient Info Center; NIH PMC6109862.
Clinical reference only — not a substitute for a current pharmacopoeia or
a per-patient interaction checker.

- `GET /drug-interactions`
- `GET /drug-interactions/:id`
- `GET /drug-interactions/search?q=warfarin` *(public, rate-limited)* — keyword scan across `drug`/`aliases`/`category`/`subcategory`/`tags`/`effects`/`implications` (same whole-row-scan approach `/rag/ask` already uses for `exchange_lists`/`renal_foods`/`enteral_formulas`, since none of these have a single documented column to `ilike` on). `q` can be a drug name, brand name, drug class, or a nutrient/food keyword (e.g. `"grapefruit"`, `"vitamin B12"`); `drug` is also accepted as the param name. Returns rows with a `match_score` (count of matched keywords), sorted descending.
- `POST /drug-interactions` *(admin)*
- `POST /drug-interactions/bulk` *(admin)*
- `PUT /drug-interactions/:id` *(admin)*
- `PATCH /drug-interactions/:id` *(admin)*
- `DELETE /drug-interactions/:id` *(admin)*

Query params (list): `category`, `severity`, `limit`, `offset`/`cursor`

Row shape: `{ external_id, drug, aliases[], category, subcategory, effects[], implications[], severity: "info"|"caution"|"moderate"|"major", tags[] }`

### Packaged

- `GET /packaged`
- `GET /packaged/pending` *(admin)* — review queue
- `POST /packaged/submit` *(public, rate-limited)*
- `POST /packaged/scan` *(public, rate-limited)*
- `POST /packaged/:id/approve` *(admin)*
- `POST /packaged/:id/reject` *(admin)*
- `PUT /packaged/:id` *(admin)*
- `PATCH /packaged/:id` *(admin)*
- `DELETE /packaged/:id` *(admin)*

Query params for `GET /packaged`: `barcode`, `search` (product_name
substring match), `limit`, `offset`/`cursor`

**`GET /packaged/pending`** — the admin review queue: rows with
`status: "pending"` from either submission path, oldest first. Query params:
`source` (`manual` | `ocr_ai`, matches the `source` column set by
`/packaged/scan`), `limit`, `offset`.

**`POST /packaged/:id/approve`** — moves a row to `status: "approved"`.
Accepts an optional JSON body of field corrections (e.g. a mis-read
`energy_kcal`) applied in the same update, so a reviewer doesn't need a
separate `PATCH` call first. `reviewed_by` defaults to the calling API
key's label (see [API keys](#api-keys)) — pass an explicit `reviewed_by`
string to override it (e.g. when using the shared root key, which has no
per-caller identity of its own).

```json
{ "reviewed_by": "Grace", "energy_kcal": 210 }
```

**`POST /packaged/:id/reject`** — moves a row to `status: "rejected"`.
Requires a `reason` string, stored in `rejection_reason` for the audit trail:

```json
{ "reason": "Barcode doesn't match product name", "reviewed_by": "Grace" }
```

**Setup required** — run once against `packaged_foods`:

```sql
alter table packaged_foods add column if not exists reviewed_at timestamptz;
alter table packaged_foods add column if not exists reviewed_by text;
alter table packaged_foods add column if not exists rejection_reason text;
```

> Duplicate detection assumes `packaged_foods.barcode` already has a
> `UNIQUE` constraint. If yours doesn't, add one — otherwise two rows for
> the same barcode can coexist and the "already exists" check below won't
> reflect what the database actually allows:
> `alter table packaged_foods add constraint packaged_foods_barcode_key unique (barcode);`

`POST /packaged/submit` requires:

- `barcode`
- `product_name`

Submission is auto-tagged with:

- `status: "pending"`
- `submitted_at: <ISO timestamp>`

**Normalization:** if the submitter enters values "per serving" rather than
per 100g/100ml, pass `per: "serving"` alongside a parseable `serving_size`
(e.g. `"30g"`, `"250ml"`) and nutrient fields are scaled to per-100 before
being stored — the same normalization `/packaged/scan` already applies to
AI-read labels, so `packaged_foods` stays on one consistent basis regardless
of submission path. `per` is a hint only and is never written to the DB.
Omit `per` (or send `per: "100g"` / `"100ml"`) if values are already per-100.

**Duplicate detection:** `packaged_foods.barcode` has a `UNIQUE` constraint
in the database — a second row for the same barcode is rejected by Postgres
outright, regardless of status. Both `/packaged/submit` and `/packaged/scan`
check for an existing row with the same barcode *before* attempting an
insert:

- If a match is `approved` or still `pending`, the new submission is
  **not** written — the response (`409`) includes `already_exists: true`
  and the existing row under `data`, so the client can show it immediately
  instead of silently failing on the DB constraint.
- If a match was previously `rejected`, the submission is treated as a
  resubmission: that same row is updated back to `status: "pending"` with
  the new data (and its old `reviewed_at`/`reviewed_by`/`rejection_reason`
  cleared), rather than trying to insert a second row. The response
  includes `resubmission_of_rejected: <id>` in that case.

**Macro/calorie check:** when `energy_kcal`, `protein_g`, `fat_g`, and
`carbs_g` are all present, the API cross-checks them against the declared
calories using Atwater factors (protein 4 kcal/g, carbs 4 kcal/g, fat 9
kcal/g). A mismatch beyond tolerance (the greater of 20 kcal or 15%) does
**not** block the submission — it's stored as-is (`status: "pending"`) but
the response sets `needs_review: true` and includes a `macro_check` object
so the client can prompt a double-check before the admin review queue picks
it up.

`POST /packaged/scan` — client submits one or more photos of the product
instead of typing it in (e.g. one of the nutrition panel, one of the
barcode/front — they don't need to be the same face of the package). Body:

```json
{
  "images": ["data:image/jpeg;base64,....", "data:image/jpeg;base64,...."],
  "barcode": "6009123456789"
}
```

- `images` is required — an array of 1-5 photos, each either a full
  `data:image/...;base64,` URL or a bare base64 string (assumed JPEG). Max
  ~6MB decoded per photo, ~15MB combined. The legacy single-image shape
  `{ "image": "data:..." }` is still accepted.
- `barcode` is optional — if none of the photos have a clear barcode, or you
  already have it from a barcode scanner on the same screen, pass it
  separately; it takes priority over anything the AI read off the packaging.

The Worker sends all photos to a Groq vision model in a single call. The
model is prompted to treat them as different faces of the same product and
combine what it reads across all of them (e.g. barcode from one photo,
nutrition panel from another) into one result. If none of the photos show a
legible nutrition label, the Worker returns `422` with `status: "needs_retry"`
and does **not** write to the database. Otherwise it inserts a row into
`packaged_foods` with:

- `status: "pending"` (same admin review queue as manual submissions)
- `source: "ocr_ai"`
- `ai_confidence`: the model's own 0–1 confidence score
- `ocr_raw`: the full raw extraction, for admin review/debugging

Response includes the extracted fields and a `needs_review` flag — true when
`ai_confidence < 0.6` **or** when the macro/calorie check below flags a
mismatch — so the client can prompt the user to double-check before treating
the submission as final. Also runs the same macro/calorie cross-check
documented under `/packaged/submit` above and includes the resulting
`macro_check` object in the response when energy + macros were all read.

Requires `env.GROQ_API_KEY` (see `wrangler.toml`), and the following
additional (nullable) columns on `packaged_foods` if they don't already
exist:

```sql
alter table packaged_foods add column if not exists source text;
alter table packaged_foods add column if not exists ai_confidence numeric;
alter table packaged_foods add column if not exists ocr_raw jsonb;
```

### Favorites & History

No user-account system exists in this API — same model as the memory
system's `session_id`: the client generates and keeps its own identifier
(a device id, an app-level user id, whatever) and passes it as `user_id`
on every call. These endpoints are public and rate-limited, not
admin-gated, since there's no server-side account to authenticate against.

Rows are **not** hydrated with the underlying food data — just the
`(user_id, resource_type, resource_id)` linkage plus a timestamp. Look up
full details separately via the existing `GET /foods/:id` or
`GET /packaged/:id`. `resource_type` must be one of `food` or `packaged`.

**`GET /favorites?user_id=...&resource_type=...`** *(optional filter)* —
list a user's saved items, newest first. Supports `limit`/`offset`.

**`POST /favorites`** — idempotent; favoriting something already favorited
just returns the existing row instead of erroring.

```json
{ "user_id": "device-abc123", "resource_type": "food", "resource_id": 7 }
```

**`DELETE /favorites`** — same body shape as `POST`; removes the matching
row if it exists (no error if it doesn't — `removed: false` in the
response instead).

**`GET /history?user_id=...&resource_type=...`** — recently viewed, most
recent first. Supports `limit`/`offset`.

**`POST /history`** — logs a view. Upserts on
`(user_id, resource_type, resource_id)`, so repeat views of the same item
update its `viewed_at` in place rather than piling up duplicate rows — the
list is already de-duplicated and correctly ordered with no client-side
work. This is opt-in (the client calls it explicitly when it wants
something logged) — nothing is tracked automatically.

Requires these tables:

```sql
create table if not exists favorites (
  id bigint generated always as identity primary key,
  user_id text not null,
  resource_type text not null,
  resource_id bigint not null,
  created_at timestamptz not null default now(),
  unique (user_id, resource_type, resource_id)
);
create index if not exists favorites_user_id_idx on favorites(user_id);

create table if not exists view_history (
  id bigint generated always as identity primary key,
  user_id text not null,
  resource_type text not null,
  resource_id bigint not null,
  viewed_at timestamptz not null default now(),
  unique (user_id, resource_type, resource_id)
);
create index if not exists view_history_user_id_idx on view_history(user_id, viewed_at desc);
```

### Food Log (nutrition diary)

Same public, self-declared-identity model as Favorites & History above —
no server-side account system, `user_id` is whatever the client supplies.

**`GET /log?user_id=...&date=YYYY-MM-DD`** *(date optional)* — diary
entries, newest first. Supports `limit`/`offset`.

**`GET /log/:id`** — a single entry.

**`POST /log`** — log an item under a meal slot.

```json
{ "user_id": "device-abc123", "meal_type": "breakfast", "calories": 450, "food_name": "Oatmeal with banana" }
```

`meal_type` must be one of `breakfast`, `lunch`, `snack`, `dinner`.
`entry_date` is optional (`YYYY-MM-DD`, defaults to today).

**`DELETE /log/:id?user_id=...`** — delete one entry (scoped to
`user_id`, so one client can't delete another's rows even without a real
auth system).

**`GET /log/summary?user_id=...&period=daily|weekly&date=YYYY-MM-DD`** —
aggregate kcal totals, no client-side summing needed.

- `period=daily` *(default)* → `total_calories`, `by_meal` breakdown,
  `entry_count`, for one day.
- `period=weekly` → 7-day window ending on `date` (default today):
  `total_calories`, `average_daily_calories`, `by_meal` breakdown across
  the whole week, and `by_date[]` (one entry per day).

Example — a full day logged and summarized:

```
POST /log  {"user_id":"u1","meal_type":"breakfast","calories":450}
POST /log  {"user_id":"u1","meal_type":"lunch","calories":720}
POST /log  {"user_id":"u1","meal_type":"snack","calories":180}
POST /log  {"user_id":"u1","meal_type":"dinner","calories":650}

GET /log/summary?user_id=u1&period=daily
→ { "total_calories": 2000, "by_meal": {"breakfast":450,"lunch":720,"snack":180,"dinner":650}, "entry_count": 4 }
```

Requires this table:

```sql
create table if not exists food_log_entries (
  id bigint generated always as identity primary key,
  user_id text not null,
  entry_date date not null default current_date,
  meal_type text not null check (meal_type in ('breakfast','lunch','snack','dinner')),
  food_name text,
  calories numeric not null check (calories >= 0),
  created_at timestamptz not null default now()
);
create index if not exists food_log_entries_user_date_idx on food_log_entries(user_id, entry_date);
```

### RAG

- `POST /rag/retrieve` *(public, rate-limited)*
- `POST /rag/ingest` *(admin)*

`POST /rag/retrieve` body:

```json
{
  "query": "string",
  "context": "both | oasis | thanzi",
  "top_k": 5
}
```

`POST /rag/ingest` body:

```json
{
  "content": "string",
  "source": "string",
  "context": "both | oasis | thanzi",
  "metadata": {}
}
```

`POST /rag/ask` *(public, rate-limited — 15 req/min per IP)* — RAG Search Orchestrator

Runs the full pipeline: **Intent Detection** (Groq `llama-3.1-8b-instant`, with a
keyword-based heuristic fallback) → **Search Orchestrator** (fans out, in
parallel, across whichever of the sources below the detected intent needs) →
**Rerank** (Cohere `rerank-multilingual-v3.0`, heuristic-score fallback if
unavailable) → **Build Context** → grounded **LLM answer** (Groq) with
bracketed `[n]` citations back to the numbered sources.

Sources it can draw from, depending on intent:

| Source | Backing |
|---|---|
| Semantic Search (Vector DB) | `rag_knowledge_base` via `match_documents` |
| Malawi FCT / Exact SQL Search | `foods` (ilike `food_name`) |
| Packaged / OCR-sourced foods | `packaged_foods` (ilike `product_name`, approved only) |
| Diabetes Exchange List | `exchange_lists` (keyword scan) |
| Renal Exchange List | `renal_foods` (keyword scan) |
| Enteral Formula Database | `enteral_formulas` (keyword scan) |
| Drug-Nutrient Interactions | `drug_nutrient_interactions` (keyword scan) |
| Barcode Lookup | `lookupFoodCascade` (local → cache → Open Food Facts) |
| USDA FDC / Open Food Facts / FatSecret | `lookupFoodCascade`, **fallback only** — fires when the local sources above returned nothing |
| Session memory *(optional)* | `assistant_memory` via `match_memory`, only when `session_id` is passed |

Body:

```json
{
  "query": "string",
  "context": "clinical | general | both",
  "top_k": 6,
  "session_id": "string (optional)"
}
```

Response `data`:

```json
{
  "answer": "string — grounded answer with [n] citations",
  "intent": "food_search | barcode_search | nutrition_question | exchange_list | enteral_formula | drug_interaction | general_chat",
  "barcode_detected": "string | null",
  "sources": [{ "id": 1, "source": "malawi_fct", "title": "..." }]
}
```

Whole answers are cached 5 minutes (keyed on context + top_k + normalized
query) — skipped entirely whenever `session_id` is passed, since a
memory-personalized answer for one session must never be served back to a
different session asking the same surface question. `/rag/retrieve` and
`/rag/ingest` above are unchanged — same endpoints, same request/response
shape, same query params.

### Memory (Write → Consolidate → Recall → Apply)

Per-session clinical scratchpad for Oasis AI. Scoped by `session_id` (the
app's own `SESSION_ID`, regenerated per page load) — this is intentionally
session-scoped working memory, not a long-term cross-visit profile.

- `POST /memory/write` *(public, rate-limited)*
- `POST /memory/recall` *(public, rate-limited — preferred)* / `GET /memory/recall` *(deprecated, same params as query string)*
- `POST /memory/consolidate` *(admin — also run automatically, hourly, by a cron trigger)*

**Setup required** (not automatic — run once):

1. Run `sql/memory_schema.sql` in the Supabase SQL editor. Creates the
   `assistant_memory` table plus `match_memory` and
   `sessions_needing_consolidation` RPC functions (same pgvector + Cohere
   `embed-multilingual-v3.0` pattern as `rag_knowledge_base` / `match_documents`).
2. `wrangler.toml` declares an hourly cron trigger
   (`[triggers] crons = ["0 * * * *"]`). Cron triggers are only registered on
   a real deploy (`npx wrangler deploy`) — a Cloudflare dashboard Quick Edit
   save does **not** pick this up.

`POST /memory/write` body — captures one raw fact ("Write"):

```json
{
  "session_id": "S_ABC123_XYZ9",
  "content": "Patient reports 3-day history of poor oral intake, BMI 17.2",
  "kind": "fact",
  "patient_label": "Bed 4"
}
```

`POST /memory/recall` body — top-K most relevant memory rows (facts and/or
summaries) for that session ("Recall"), ranked by cosine similarity to `query`:

```json
{ "session_id": "S_ABC123_XYZ9", "query": "renal diet history", "top_k": 5 }
```

`GET /memory/recall?session_id=...&query=...&top_k=5` still works with the
same params but is deprecated — a GET puts `session_id` and the raw query
text (which can contain clinical detail) into the URL, where it's exposed to
Cloudflare access logs, browser history, and any proxy in the path. Migrate
callers to the POST form above when convenient.

`POST /memory/consolidate` body — manually trigger summarization for one
session ("Consolidate"):

```json
{ "session_id": "S_ABC123_XYZ9" }
```

Sessions with fewer than 6 unconsolidated facts are skipped
(`{"status":"skipped","reason":"Not enough unconsolidated facts yet"}`). When
consolidation runs, it summarizes the session's raw facts into one row via a
single Groq text completion (`llama-3.3-70b-versatile` by default, override
with `GROQ_TEXT_MODEL`), inserts it as `kind: "summary"`, and marks the
source facts `consolidated: true` so they drop out of future consolidation
batches (they remain individually recallable). The hourly cron runs this
automatically for every session that qualifies — no manual step needed in
normal operation.

---

## Response Format

### List success

```json
{
  "status": "success",
  "count": 123,
  "limit": 50,
  "offset": 0,
  "data": []
}
```

### Single/mutation success

```json
{
  "status": "success",
  "message": "Food created",
  "data": {}
}
```

### Error

```json
{
  "status": "error",
  "message": "Description of what went wrong"
}
```

---

## HTTP Status Codes

- `200` Success
- `204` Preflight (`OPTIONS`)
- `400` Bad request
- `401` Unauthorized (admin key missing/invalid)
- `404` Resource/route not found
- `405` Method not allowed
- `429` Rate limit exceeded
- `500` Internal server error
- `502` Upstream embedding failure (Cohere)

---

## CORS

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, apikey
Access-Control-Max-Age: 86400
```

---

## JS Client SDK

The zero-dependency JS client for this API now lives in its own repo:

**[github.com/edisontaimu9-ui/Chakudya-sdk](https://github.com/edisontaimu9-ui/Chakudya-sdk)**

It ships browser (`<script>` tag / UMD), ESM, and CommonJS builds, plus
TypeScript types, and wraps every route in this file — `foods`, `exchange`,
`renal`, `formulas`, `packaged`,
`rag`, and `memory`. See that repo's README for install and usage examples.

---

## Quick Examples

### Public read

```bash
curl "https://chakudya-api.<your-subdomain>.workers.dev/foods?search=nsima&limit=10"
```

### Admin write

```bash
curl -X POST "https://chakudya-api.<your-subdomain>.workers.dev/foods" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"food_name":"Matemba","category":"fish"}'
```

### Community packaged submission (public)

```bash
curl -X POST "https://chakudya-api.<your-subdomain>.workers.dev/packaged/submit" \
  -H "Content-Type: application/json" \
  -d '{"barcode":"6001234567890","product_name":"ONGA Mchuzi Mix"}'
```

### RAG retrieval (public)

```bash
curl -X POST "https://chakudya-api.<your-subdomain>.workers.dev/rag/retrieve" \
  -H "Content-Type: application/json" \
  -d '{"query":"high potassium foods","context":"both","top_k":5}'
```

---

## Maintainer

**Edison Taimu**
Blantyre, Malawi  
BSc Nutrition & Dietetics (KUHeS) · Self-taught Web Developer
