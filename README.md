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
- **Current CNR version:** `1.3.0`

---

## Project Structure

```text
chakudya-api/
├── src/
│   └── index.js       # Worker entry and all route handlers
└── wrangler.toml      # Cloudflare Worker config
```

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

### 4) Bind KV namespace

Create KV and bind it as `RATE_LIMIT_KV` in `wrangler.toml` / Cloudflare dashboard.

### 5) Run & deploy

```bash
npx wrangler dev
npx wrangler deploy
```

---

## Authentication Model

`Authorization: Bearer <ADMIN_API_KEY>` is required for:

- All write routes (`POST`, `PUT`, `PATCH`, `DELETE`) on:
  - `/foods`
  - `/exchange`
  - `/renal`
  - `/formulas`
  - `/packaged/:id`
- `POST /rag/ingest`
- `POST /memory/consolidate` (also runs automatically via hourly cron, bypassing HTTP auth)

Public exceptions:

- `POST /packaged/submit` (public, rate-limited)
- `POST /rag/retrieve` (public, rate-limited)
- `POST /memory/write` (public, rate-limited)
- `GET /memory/recall` (public, rate-limited)
- All `GET` endpoints

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

## Endpoints

### Root

- `GET /` — returns CNR metadata, version, auth summary, and endpoint map

### Foods

- `GET /foods`
- `GET /foods/:id`
- `POST /foods` *(admin)*
- `PUT /foods/:id` *(admin)*
- `PATCH /foods/:id` *(admin)*
- `DELETE /foods/:id` *(admin)*

Query params for `GET /foods`:

- `search` → maps to `food_name ilike`
- `category`
- `limit` (default `50`, capped at `100`)

**`GET /foods/lookup`** — external cascade for foods not in the local database. Order: local cache → USDA FDC (name search) → Open Food Facts (barcode) → FatSecret (name search, OAuth 1.0). First external hit is cached into `external_foods_cache` so subsequent lookups skip the upstream calls. Public, rate-limited to 20 req/min per IP.

- `search` → name search (tries USDA, then FatSecret)
- `barcode` → barcode lookup (Open Food Facts)
- `offset` (default `0`)

### Exchange

- `GET /exchange`
- `POST /exchange` *(admin)*
- `PUT /exchange/:id` *(admin)*
- `PATCH /exchange/:id` *(admin)*
- `DELETE /exchange/:id` *(admin)*

Query params: `type`, `limit`, `offset`

### Renal

- `GET /renal`
- `POST /renal` *(admin)*
- `PUT /renal/:id` *(admin)*
- `PATCH /renal/:id` *(admin)*
- `DELETE /renal/:id` *(admin)*

Query params: `limit`, `offset`

### Formulas

- `GET /formulas`
- `POST /formulas` *(admin)*
- `PUT /formulas/:id` *(admin)*
- `PATCH /formulas/:id` *(admin)*
- `DELETE /formulas/:id` *(admin)*

Query params: `route`, `limit`, `offset`

### Packaged

- `GET /packaged`
- `POST /packaged/submit` *(public, rate-limited)*
- `POST /packaged/scan` *(public, rate-limited)*
- `PUT /packaged/:id` *(admin)*
- `PATCH /packaged/:id` *(admin)*
- `DELETE /packaged/:id` *(admin)*

Query params for `GET /packaged`: `barcode`, `limit`, `offset`

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

### Memory (Write → Consolidate → Recall → Apply)

Per-session clinical scratchpad for Oasis AI. Scoped by `session_id` (the
app's own `SESSION_ID`, regenerated per page load) — this is intentionally
session-scoped working memory, not a long-term cross-visit profile.

- `POST /memory/write` *(public, rate-limited)*
- `GET /memory/recall` *(public, rate-limited)*
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

`GET /memory/recall?session_id=...&query=...&top_k=5` — top-K most relevant
memory rows (facts and/or summaries) for that session ("Recall"), ranked by
cosine similarity to `query`.

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
