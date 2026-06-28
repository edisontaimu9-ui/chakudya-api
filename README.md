# Chakudya API 🌽

**Malawi's first open Food & Nutrition Database**

A lightweight Cloudflare Worker that exposes a REST API over a Supabase database covering Malawian foods, exchange lists, renal nutrition data, enteral formulas, and packaged foods. No npm packages — pure `fetch`, deployable from Termux.

---

## Project Structure

```
chakudya-api/
├── src/
│   └── index.js       # Single worker entry point
└── wrangler.toml      # Cloudflare Worker config
```

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) (free tier works)
- [Supabase project](https://supabase.com) with the tables listed below
- Node.js + npx available (for Wrangler CLI)
- Termux or any terminal

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `foods` | Core Malawian food composition data |
| `exchange_lists` | Dietetic exchange list entries |
| `renal_foods` | Renal-specific food data (K, P, Na values) |
| `enteral_formulas` | Enteral/parenteral formula specs |
| `packaged_foods` | Packaged/branded food products with barcodes |

---

## Setup

**1. Clone and enter the project**
```bash
git clone https://github.com/YOUR_USERNAME/chakudya-api.git
cd chakudya-api
```

**2. Fill in your account ID**

Open `wrangler.toml` and replace the placeholder:
```toml
account_id = "YOUR_ACCOUNT_ID_HERE"
```
Find your account ID at `https://dash.cloudflare.com` in the right sidebar.

**3. Add secrets**

Never hardcode credentials. Add them via Wrangler CLI:
```bash
npx wrangler secret put SUPABASE_URL
# paste your Supabase project URL e.g. https://xxxx.supabase.co

npx wrangler secret put SUPABASE_KEY
# paste your Supabase anon or service_role key
```

Or add them in the Cloudflare Dashboard under:
`Workers & Pages → chakudya-api → Settings → Variables → Secrets`

**4. Deploy**
```bash
npx wrangler deploy
```

Your API will be live at:
`https://chakudya-api.YOUR_SUBDOMAIN.workers.dev`

---

## Endpoints

### Root

```
GET /
```
Returns API info, version, and full endpoint map.

---

### Foods `/foods`

| Method | Path | Description |
|---|---|---|
| GET | `/foods` | List foods |
| GET | `/foods/:id` | Single food by ID |
| POST | `/foods` | Add a food |
| PUT | `/foods/:id` | Replace a food |
| PATCH | `/foods/:id` | Partial update |
| DELETE | `/foods/:id` | Delete a food |

**Query params for `GET /foods`**

| Param | Type | Description |
|---|---|---|
| `search` | string | Case-insensitive name search |
| `category` | string | Filter by category |
| `limit` | number | Results per page (default 50) |
| `offset` | number | Pagination offset (default 0) |

```bash
GET /foods?search=nsima&limit=10
GET /foods?category=legumes&offset=20
```

---

### Exchange Lists `/exchange`

| Method | Path | Description |
|---|---|---|
| GET | `/exchange` | List exchange entries |
| POST | `/exchange` | Add an entry |
| PUT | `/exchange/:id` | Replace an entry |
| PATCH | `/exchange/:id` | Partial update |
| DELETE | `/exchange/:id` | Delete an entry |

**Query params for `GET /exchange`**

| Param | Type | Description |
|---|---|---|
| `type` | string | Filter by exchange type |
| `limit` | number | Default 50 |
| `offset` | number | Default 0 |

---

### Renal Foods `/renal`

| Method | Path | Description |
|---|---|---|
| GET | `/renal` | List renal food entries |
| POST | `/renal` | Add an entry |
| PUT | `/renal/:id` | Replace an entry |
| PATCH | `/renal/:id` | Partial update |
| DELETE | `/renal/:id` | Delete an entry |

**Query params for `GET /renal`**

| Param | Type | Description |
|---|---|---|
| `limit` | number | Default 50 |
| `offset` | number | Default 0 |

---

### Enteral Formulas `/formulas`

| Method | Path | Description |
|---|---|---|
| GET | `/formulas` | List formulas |
| POST | `/formulas` | Add a formula |
| PUT | `/formulas/:id` | Replace a formula |
| PATCH | `/formulas/:id` | Partial update |
| DELETE | `/formulas/:id` | Delete a formula |

**Query params for `GET /formulas`**

| Param | Type | Description |
|---|---|---|
| `route` | string | Filter by delivery route (e.g. `NGT`, `PEG`) |
| `limit` | number | Default 50 |
| `offset` | number | Default 0 |

---

### Packaged Foods `/packaged`

| Method | Path | Description |
|---|---|---|
| GET | `/packaged` | List packaged foods |
| POST | `/packaged/submit` | Submit a new product for review |
| PUT | `/packaged/:id` | Replace a product |
| PATCH | `/packaged/:id` | Partial update |
| DELETE | `/packaged/:id` | Delete a product |

**Query params for `GET /packaged`**

| Param | Type | Description |
|---|---|---|
| `barcode` | string | Exact barcode lookup |
| `limit` | number | Default 50 |
| `offset` | number | Default 0 |

> Submissions via `POST /packaged/submit` are auto-tagged `status: "pending"` and `submitted_at` timestamp for moderation.

---

## Response Format

All responses follow a consistent envelope:

**List response**
```json
{
  "status": "success",
  "count": 312,
  "limit": 50,
  "offset": 0,
  "data": [ ... ]
}
```

**Single / mutation response**
```json
{
  "status": "success",
  "message": "Food created",
  "data": { ... }
}
```

**Error response**
```json
{
  "status": "error",
  "message": "Description of what went wrong"
}
```

| HTTP Code | Meaning |
|---|---|
| 200 | Success |
| 204 | Preflight OK |
| 400 | Bad request / missing field |
| 404 | Resource or route not found |
| 405 | Method not allowed |
| 500 | Internal server error |

---

## CORS

All responses include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, apikey
```

Safe to call from any browser-based app, including PWAs.

---

## Example Requests

```bash
# List foods
curl https://chakudya-api.YOUR_SUBDOMAIN.workers.dev/foods

# Search
curl "https://chakudya-api.YOUR_SUBDOMAIN.workers.dev/foods?search=matemba&limit=5"

# Add a food
curl -X POST https://chakudya-api.YOUR_SUBDOMAIN.workers.dev/foods \
  -H "Content-Type: application/json" \
  -d '{"name":"Matemba","category":"fish","energy_kcal":320}'

# Barcode lookup
curl "https://chakudya-api.YOUR_SUBDOMAIN.workers.dev/packaged?barcode=6001234567890"

# Submit packaged food
curl -X POST https://chakudya-api.YOUR_SUBDOMAIN.workers.dev/packaged/submit \
  -H "Content-Type: application/json" \
  -d '{"barcode":"6001234567890","name":"ONGA Mchuzi Mix","brand":"ONGA"}'
```

---

## Integration with Oasis CNST / Thanzi

The API is designed to serve as the shared data backbone for:

- **Oasis CNST** — clinical nutrition PWA; integrates with the layered food search system (local FCT → regional FCT → FatSecret)
- **Thanzi** — consumer calorie tracking PWA targeting Malawian users

Point either app's food search at this Worker's `/foods` endpoint and swap the local `foodData.js` lookups for live API calls.

---

## Maintainer

**Taimu Tech Solutions** · Edison Taimu  
Blantyre, Malawi  
BSc Nutrition & Dietetics (KUHeS) · Self-taught Web Developer
