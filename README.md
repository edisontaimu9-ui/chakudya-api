# Chakudya API 🌽

**Malawi’s first open Food & Nutrition Database**

A Cloudflare Worker API backed by Supabase for Malawian food and nutrition data, including semantic RAG search support.

---

## What’s in this API

- Food composition data (`/foods`)
- Exchange lists (`/exchange`)
- Renal food entries (`/renal`)
- Enteral formulas (`/formulas`)
- Packaged foods + community submission flow (`/packaged`, `/packaged/submit`)
- RAG semantic retrieval and ingestion (`/rag/retrieve`, `/rag/ingest`)

---

## Runtime & Tech

- **Runtime:** Cloudflare Workers
- **Database:** Supabase REST (`/rest/v1`)
- **Embeddings:** Cohere (`embed-multilingual-v3.0`)
- **Rate limiting:** Cloudflare KV
- **Current API version:** `1.1.0`

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

> If `ADMIN_API_KEY` is missing, admin routes fail closed (writes denied).

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

Public exceptions:

- `POST /packaged/submit` (public, rate-limited)
- `POST /rag/retrieve` (public, rate-limited)
- All `GET` endpoints

---

## Rate Limits (from `index.js` policy)

- **Standard reads (`GET`)**: `100/min` per IP per resource
- **Packaged submit (`POST /packaged/submit`)**: `10/min` per IP
- **RAG retrieve (`POST /rag/retrieve`)**: `20/min` per IP
- **Admin writes (general)**: `60/min` per admin token
- **RAG ingest (`POST /rag/ingest`)**: `30/min` per admin token

When exceeded:

- HTTP `429`
- `Retry-After` header returned

---

## Endpoints

### Root

- `GET /` — returns API metadata, version, auth summary, and endpoint map

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

**Taimu Tech Solutions** · Edison Taimu  
Blantyre, Malawi  
BSc Nutrition & Dietetics (KUHeS) · Self-taught Web Developer
