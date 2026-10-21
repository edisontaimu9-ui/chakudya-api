<div align="center">

# Chakudya Nutrition Registry 🌽

**Malawi's intelligent food and nutrition knowledge platform**

An open, Malawi-focused nutrition API for health apps, researchers, dietitians and developers.

[Docs site](https://edisontaimu9-ui.github.io/Chakudya-docs/) ·
[API reference](docs/API-REFERENCE.md) ·
[OpenAPI spec](openapi.yaml) ·
[JS SDK](https://github.com/edisontaimu9-ui/Chakudya-sdk) ·
[MCP server](https://github.com/edisontaimu9-ui/chakudya-mcp-server-cloudflare)

</div>

---

## What it is

Chakudya (CNR) is a Cloudflare Worker backed by Supabase. It serves Malawian food composition data, clinical nutrition tools, WHO growth standards and a retrieval-augmented (RAG) knowledge base, all behind one JSON API.

It is built for:

- nutrition and dietetics apps and clinical decision support
- meal planning, food and barcode scanners
- research tools and educational apps
- AI assistants that need grounded nutrition data

## What it provides

| Area | Main routes | What you get |
|---|---|---|
| **Foods** | `/foods`, `/foods/lookup`, `/foods/compare`, `/foods/convert`, `/foods/substitutes` | Malawi food composition (FCT) values, with a USDA, Open Food Facts and FatSecret fallback, side-by-side comparison, household-measure conversion and "what can I use instead" suggestions |
| **Packaged foods** | `/packaged`, `/packaged/scan`, `/packaged/submit` | Barcode lookup, photo-based label reading, community submissions and an admin review queue |
| **Clinical tools** | `/exchange`, `/renal`, `/formulas`, `/drug-interactions`, `/glycaemic-index`, `/dri` | Exchange lists, renal data, enteral formulas, drug-nutrient interactions, sourced GI/GL values and dietary reference intakes |
| **Energy and measures** | `/energy`, `/activity-energy`, `/measures` | Energy requirement engine, activity energy table, unit and household-measure conversion |
| **Sports nutrition** | `/sports/energy`, `/sports/macros`, `/sports/fuel-timing`, `/sports/hydration`, `/sports/body-composition`, `/sports/supplement-dose`, `/sports/plan` | Athlete energy (Cunningham), macros per kg, fuel timing, hydration, body composition and supplement doses from Krause chapter 23 |
| **Weight management** | `/weight-management/assess`, `/loss-plan`, `/gain-plan`, `/progress`, `/diet-pattern`, `/reference`, `/bariatric` | BMI class and risk, loss and gain plans built on the energy engine, progress tracking, diet-pattern check and bariatric supplementation from Krause chapter 21 |
| **Pregnancy and lactation** | `/pregnancy/gestational-age`, `/weight-gain`, `/plan`, `/assess`, `/reference` | Gestational age, IOM weight gain, trimester energy and protein, DRI targets, twins, lactation, anemia, lab, GDM and preeclampsia screens from Krause chapter 14 |
| **Renal nutrition** | `/renal-nutrition/stage`, `/requirements`, `/labs`, `/adequacy`, `/plan`, `/reference`, `/emergency-diet` | CKD stage (eGFR), KDOQI 2020 protein, energy, sodium, calcium and potassium/phosphorus rules by status, ESRD blood-value interpretation, dialysis adequacy and the emergency dialysis diet from KDOQI 2020 and Krause chapter 35 |
| **Growth** | `/growth/assess`, `/weight-for-age`, `/length-height-for-age`, `/weight-for-length-height`, `/bmi-for-age`, `/hc-for-age`, `/muac`, `/fenton-preterm` | WHO child growth indicators from birth to 19 years in one call, MUAC screening and preterm (Fenton) charts |
| **Meals** | `/recipes/calculate`, `/meals/analyze`, `/ingredients/parse` | Recipe and meal nutrition from plain ingredient lists or free text |
| **AI and memory** | `/rag/ask`, `/rag/retrieve`, `/memory/*` | Cited answers over ingested clinical documents, and per-session memory for assistants |
| **FHIR R4** | `/fhir/*` | Stateless Nutrition Care Process operations: screening, assessment, diagnosis, intervention, monitoring and the ADIME document |
| **User data** | `/favorites`, `/history`, `/log` | Saved foods, view history and a nutrition diary, keyed by a client-supplied `user_id` |
| **Batch** | `POST /batch` | Up to 20 sub-requests in one call |

## Quick start

Every operational route needs an API key. Sign in on the [docs site](https://edisontaimu9-ui.github.io/Chakudya-docs/), confirm your email and create a key on the account page, then:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "https://chakudya-api.edisontaimu9.workers.dev/foods/lookup?q=nsima"
```

A combined WHO growth assessment for an 18-month-old girl:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "https://chakudya-api.edisontaimu9.workers.dev/growth/assess?sex=girls&age_months=18&weight_kg=9.2&length_cm=78&muac_cm=13.5"
```

Responses use one envelope:

```json
{ "status": "success", "count": 1, "data": [] }
```

Errors return `{ "status": "error", "message": "..." }`. Rate-limited requests get `429` with a `Retry-After` header.

## Authentication at a glance

| Credential | Can do |
|---|---|
| **Consumer key** (from the docs site) | Read and compute on every data route; 3x the standard rate limits |
| **Reviewer key** | Everything above, plus the packaged-food review queue |
| **Admin key** | Registry writes, bulk inserts and RAG ingestion |
| **No key** | `GET /`, `GET /health` and the FHIR conformance reads only |

Full details are in [Authentication Model](docs/API-REFERENCE.md#authentication-model) and [API keys](docs/API-REFERENCE.md#api-keys).

## Tech stack

- **Runtime:** Cloudflare Workers, deployed on push to `main` by GitHub Actions
- **Database:** Supabase (PostgreSQL + pgvector), accessed over REST
- **Embeddings and rerank:** Cohere
- **LLM steps** (intent detection, answers, label reading): Groq
- **Caching and rate limits:** Cloudflare Cache API and KV

## Run your own

```bash
git clone https://github.com/edisontaimu9-ui/chakudya-api.git
cd chakudya-api
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put COHERE_API_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler deploy
```

You also need the KV namespace, the Supabase migrations in [`sql/`](sql) and the seed files in [`scripts/`](scripts). The full walkthrough, optional USDA and FatSecret keys and a post-deploy [smoke test](docs/API-REFERENCE.md#smoke-test) are in the [API reference](docs/API-REFERENCE.md#setup).

## Project layout

```text
chakudya-api/
├── src/            Worker entry (index.js) and one module per feature
├── sql/            Numbered Supabase migrations
├── scripts/        Seed files and loaders
├── test/           node --test suites (run with npm test)
├── docs/           Full API reference
├── openapi.yaml    OpenAPI 3.0.3 spec
├── smoke-test.sh   Post-deploy verification
└── wrangler.toml   Worker config
```

## Data sources and licensing

- **Malawi Food Composition Table**, plus Ministry of Health guidance, for local foods and BMI-for-age (5-19 years).
- **WHO Child Growth Standards and growth reference** for the growth indicators and MUAC.
- **USDA FoodData Central, Open Food Facts and FatSecret** as optional fallbacks for foods not held locally.
- **Fenton preterm growth charts** are used under CC BY-NC-ND 4.0 with extra conditions from Dr. Tanis Fenton: the underlying values are never exposed and never shared. The API only returns computed results and rendered charts, never the raw reference data.

All clinical outputs are **screening and decision aids, not diagnoses or medical advice**. Confirm with clinical judgement.

## Maintainer

**Edison Taimu** · Blantyre, Malawi

- BSc Nutrition & Dietetics (KUHeS), self-taught web developer
- Email: [edisontaimu9@gmail.com](mailto:edisontaimu9@gmail.com)
- LinkedIn: [edison-taimu](https://www.linkedin.com/in/edison-taimu-a37415367)
- X: [@edisontaimu](https://x.com/edisontaimu)
