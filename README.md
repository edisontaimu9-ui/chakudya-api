# Chakudya API 🌽

**Malawi's first open Food & Nutrition Database**

A lightweight Cloudflare Worker that exposes a REST API over a Supabase database covering Malawian foods, exchange lists, renal nutrition data, enteral formulas, and packaged foods.

---

## Features

- REST API for food and nutrition datasets
- Cloudflare Worker runtime (no traditional server required)
- Supabase as the backend datastore
- Consistent JSON response format
- CORS enabled for browser and mobile app clients

---

## Project Structure

```text
chakudya-api/
├── src/
│   └── index.js       # Single worker entry point
└── wrangler.toml      # Cloudflare Worker config
```

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) (free tier works)
- [Supabase project](https://supabase.com)
- Node.js (LTS recommended)
- npm / npx

---

## Setup

### 1) Clone repository

```bash
git clone https://github.com/edisontaimu9-ui/chakudya-api.git
cd chakudya-api
```

### 2) Configure Cloudflare account

Open `wrangler.toml` and set:

```toml
account_id = "YOUR_ACCOUNT_ID"
```

You can find your Cloudflare account ID in the Cloudflare dashboard.

### 3) Add required secrets

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
```

### 4) Run locally

```bash
npx wrangler dev
```

### 5) Deploy

```bash
npx wrangler deploy
```

After deployment, your API will be available at:

```text
https://chakudya-api.<your-subdomain>.workers.dev
```

---

## API Endpoints

### Root

- `GET /` — API info, version, and endpoint map

### Foods

- `GET /foods`
- `GET /foods/:id`
- `POST /foods`
- `PUT /foods/:id`
- `PATCH /foods/:id`
- `DELETE /foods/:id`

Query params for `GET /foods`:

- `search` (string)
- `category` (string)
- `limit` (number, default `50`)
- `offset` (number, default `0`)

### Exchange Lists

- `GET /exchange`
- `POST /exchange`
- `PUT /exchange/:id`
- `PATCH /exchange/:id`
- `DELETE /exchange/:id`

Query params: `type`, `limit`, `offset`

### Renal Foods

- `GET /renal`
- `POST /renal`
- `PUT /renal/:id`
- `PATCH /renal/:id`
- `DELETE /renal/:id`

Query params: `limit`, `offset`

### Enteral Formulas

- `GET /formulas`
- `POST /formulas`
- `PUT /formulas/:id`
- `PATCH /formulas/:id`
- `DELETE /formulas/:id`

Query params: `route`, `limit`, `offset`

### Packaged Foods

- `GET /packaged`
- `POST /packaged/submit`
- `PUT /packaged/:id`
- `PATCH /packaged/:id`
- `DELETE /packaged/:id`

Query params: `barcode`, `limit`, `offset`

---

## Response Format

### Success (list)

```json
{
  "status": "success",
  "count": 312,
  "limit": 50,
  "offset": 0,
  "data": []
}
```

### Success (single / mutation)

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

## Common HTTP Status Codes

- `200` Success
- `204` Preflight OK
- `400` Bad request / validation issue
- `404` Resource or route not found
- `405` Method not allowed
- `500` Internal server error

---

## CORS

The API returns:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, apikey
```

---

## Quick Examples

```bash
# List foods
curl https://chakudya-api.<your-subdomain>.workers.dev/foods

# Search foods
curl "https://chakudya-api.<your-subdomain>.workers.dev/foods?search=nsima&limit=10"

# Create food
curl -X POST https://chakudya-api.<your-subdomain>.workers.dev/foods \
  -H "Content-Type: application/json" \
  -d '{"name":"Matemba","category":"fish","energy_kcal":320}'
```

---

## Integrations

Designed to support:

- **Oasis CNST** (clinical nutrition workflows)
- **Thanzi** (consumer calorie tracking)

---

## Maintainer

**Taimu Tech Solutions** · Edison Taimu  
Blantyre, Malawi  
BSc Nutrition & Dietetics (KUHeS) · Self-taught Web Developer
