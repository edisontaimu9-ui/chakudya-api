# Chakudya Nutrition Registry (CNR) 🌽

**Malawi’s first open Food & Nutrition Database**

A Cloudflare Worker API backed by Supabase for Malawian food and nutrition data, including semantic RAG search support.

---

## What’s in CNR

- Food composition data (`/foods`)
- Exchange lists (`/exchange`)
- Renal food entries (`/renal`)
- Enteral formulas (`/formulas`)
- Packaged foods + community submission flow (`/packaged`, `/packaged/submit`)
- RAG semantic retrieval and ingestion (`/rag/retrieve`, `/rag/ingest`)
- Session memory for Oasis AI — Write/Consolidate/Recall (`/memory/write`, `/memory/recall`, `/memory/consolidate`)

---

## Runtime & Tech

- **Runtime:** Cloudflare Workers
- **Database:** Supabase REST (`/rest/v1`)
- **Embeddings:** Cohere (`embed-multilingual-v3.0`)
- **Rate limiting:** Cloudflare KV
- **Current CNR version:** `1.13.0`

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

Optional — power the external food lookup cascade (`GET /foods/lookup`) only; the rest of CNR works without them:

- `FATSECRET_CONSUMER_KEY` / `FATSECRET_CONSUMER_SECRET` (OAuth 1.0 Consumer credentials, from your FatSecret Platform dashboard)
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
  everything else admin-gated — editing foods, deleting products, bulk
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

## Rate Limits (from `index.js` policy)

- **Standard reads (`GET`)**: `100/min` per IP per resource
- **Packaged submit (`POST /packaged/submit`)**: `10/min` per IP
- **RAG retrieve (`POST /rag/retrieve`)**: `20/min` per IP
- **Memory write (`POST /memory/write`)**: `30/min` per IP
- **Memory recall (`GET /memory/recall`)**: `30/min` per IP
- **Admin writes (general)**: `60/min` per admin token
- **RAG ingest (`POST /rag/ingest`)**: `30/min` per admin token

When exceeded:

- HTTP `429`
- `Retry-After` header returned

---

## Caching (Cloudflare Cache API, `v1.4.0+`)

GET responses for reference-style resources are cached at the Cloudflare edge, keyed on the full request URL (so different filters/query params get distinct cache entries). No extra bindings needed — this uses the Workers built-in `caches.default`.

| Resource | Cached? | TTL |
|---|---|---|
| `GET /foods`, `/exchange`, `/renal`, `/formulas` | ✅ | 1 hour |
| `GET /foods/lookup` | ✅ | 30 min |
| `GET /manufacturers` | ✅ | 24 hours |
| `GET /products` (list) | ✅ | 15 min |
| `GET /packaged*`, `/products/:id`, `/nutrition` | ❌ | — (change often or are low-traffic detail views) |
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
and `src/index.js` are the source of truth.

### Root

- `GET /` — returns CNR metadata, version, auth summary, and endpoint map

### Health

- `GET /health` *(public, rate-limited)* — pings Supabase, Cohere, and Groq
  in parallel and reports per-service status plus an overall
  `healthy`/`degraded` verdict. Useful for quickly narrowing down which
  upstream is the cause when a route starts failing, instead of guessing
  from a generic `500`.

Optional integrations (USDA FDC, FatSecret, the rate-limit/query-cache KV)
are reported as `configured`/`bound` or not, without a network call —
they're not pinged and don't affect the overall verdict, since the rest of
the API already degrades gracefully without them.

Response:

```json
{
  "status": "healthy",
  "version": "1.8.0",
  "checked_at": "2026-08-13T22:40:00.000Z",
  "services": {
    "supabase": { "status": "ok" },
    "cohere": { "status": "ok" },
    "groq": { "status": "error", "detail": "HTTP 401" },
    "usda_fdc": { "status": "configured" },
    "fatsecret": { "status": "not_configured" },
    "rate_limit_kv": { "status": "bound" }
  }
}
```

Returns `200` when `status: "healthy"`, `503` when `status: "degraded"`
(i.e. Supabase, Cohere, or Groq — the required upstreams — failed to
respond).

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

`GET /foods`, `/exchange`, `/renal`, `/formulas`, `/manufacturers`,
`/products`, and `/packaged` all support two pagination modes, chosen by
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
`/manufacturers/bulk`, and `/products/bulk` *(all admin)* accept a batch
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
- `food_name` is required on every item for `/foods/bulk` (mirrors the
  single-row `POST /foods` validation); the other five resources have no
  required-field check beyond a non-empty array, matching their single-row
  endpoints today.
- **All-or-nothing:** this is one PostgREST batch insert, not N sequential
  inserts. If any row in the batch violates a constraint (e.g. a duplicate
  unique key), the *entire* batch is rejected and nothing is inserted —
  intentional, so a bad row doesn't leave you guessing which rows silently
  didn't make it in. Fix the offending row (the error message from
  Postgres usually names the constraint) and resubmit.

### Foods

- `GET /foods`
- `GET /foods/:id`
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

**`GET /foods/lookup`** — external cascade for foods not in the local database. Order: local cache → USDA FDC (name search) → Open Food Facts (barcode) → FatSecret (name search, OAuth 1.0). First external hit is cached into `external_foods_cache` so subsequent lookups skip the upstream calls. Public, rate-limited to 20 req/min per IP.

- `search` → name search (tries USDA, then FatSecret)
- `barcode` → barcode lookup (Open Food Facts)
- `offset` (default `0`)

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

Query params for `GET /packaged`: `barcode`, `limit`, `offset`/`cursor`

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

### Manufacturers

- `GET /manufacturers` — supports `limit`, `offset`/`cursor` (see [Pagination](#pagination))
- `POST /manufacturers` *(admin)*
- `POST /manufacturers/bulk` *(admin)*
- `PATCH /manufacturers/:id` *(admin)*
- `DELETE /manufacturers/:id` *(admin)*

### Products

- `GET /products` — filters: `category`, `route`, `manufacturer_id`, `search`, `include_inactive`; supports `limit`, `offset`/`cursor`
- `GET /products/:id`
- `POST /products` *(admin)*
- `POST /products/bulk` *(admin)*
- `PUT /products/:id` *(admin)*
- `PATCH /products/:id` *(admin)*
- `DELETE /products/:id` *(admin — soft delete, sets `is_active: false`)*

### Nutrition

- `GET /nutrition?product_id=123`


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
  "intent": "food_search | barcode_search | nutrition_question | exchange_list | enteral_formula | general_chat",
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
`renal`, `formulas`, `manufacturers`, `products`, `packaged`, `nutrition`,
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
