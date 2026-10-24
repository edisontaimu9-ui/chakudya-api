/**
 * Chakudya Nutrition Registry (CNR) — Malawi's Intelligent Food & Nutrition Knowledge Platform
 * Cloudflare Worker · Supabase REST backend (no SDK, pure fetch)
 * ---------------------------------------------------------------
 * Author : Edison Taimu 
 * Version: 1.58.0
 * v1.58.0 changes: enteral nutrition prescription calculator (src/enteralNutrition.js, no SQL, any API key). POST /enteral-nutrition/calculate (formula volume, rate, energy, protein, formula water,
 *   free water flush, delivery adequacy; formula from enteral_formulas by formula_id or formula_name, or sent inline), GET /enteral-nutrition/reference.
 * v1.57.0 changes: critical care nutrition support calculators (src/criticalCare.js, no SQL, any API key), moved from the MCP server so the API is the single source. POST /critical-care/protein-by-stress,
 *   /npe-nitrogen-ratio, /nitrogen-balance, /carbohydrate, /propofol-fat, /electrolytes, /potassium-deficit, /fluid; GET /critical-care/fat, /cho-fat-ratio, /reference.
 * v1.56.0 changes: paediatric nutrition calculators (src/paediatric.js, no SQL, any API key). POST /paediatric/energy (Schofield and WHO 1985 BMR with activity and stress factor ranges,
 *   DRI/FAO 2004 kcal/kg/day, IOM EER through the energy engine), /protein (IOM healthy growth, ASPEN sick child), /fluid (Holliday-Segar), /preterm (requirements and monitoring),
 *   /growth-velocity (reference weight and length velocity), /catch-up (weight-age method with the WHO median weight-for-length/height read from who_weight_for_length_height, plus the
 *   growth-failure stress-factor method), /enteral-feeds (initiation, advancement, goal by age group), /plan (one call). GET /paediatric/reference. Alias: /pediatric.
 * v1.55.0 changes: dietary assessment (src/dietaryAssessment.js, no SQL, any API key). POST /dietary-assessment takes 1-7 days of intake (meals, ingredients or
 *   nutrient totals), resolves foods with the same resolver as /meals/analyze, and returns average intake against the DRI (EAR/RDA/AI/UL, sodium CDRR), energy against
 *   the IOM EER, macronutrient shares against the AMDR, food-group coverage, ranked nutrient gaps and excesses, and the foods richest in the top gaps. Adds 11 nutrients the
 *   foods table already holds (thiamin, riboflavin, niacin, B6, E, pantothenic acid, biotin, phosphorus, selenium, copper, manganese). GET /dietary-assessment/reference.
 *   resolveIngredientsList() takes an optional extraFields argument (default none, so /recipes/calculate and /meals/analyze are unchanged). CNR_VERSION now matches the header.
 * v1.54.0 changes: Nutrition Research & Surveillance Engine (src/surveillance.js, sql/037, SURVEILLANCE_STORE). POST /surveillance/records takes anonymised
 *   screening records (one or up to 100; raw measurements are classified with the WHO tables and discarded; only coarse fields are accepted, so a name or phone
 *   number is rejected). GET /surveillance/reference (any key); GET /surveillance/summary, /hotspots, /trends, /alerts, /insights (admin key): district hotspots
 *   against the national figure (exact binomial test, Benjamini-Hochberg), monthly trends (Cochran-Armitage) with year-on-year change, early warning (recent months
 *   vs baseline) and prioritised, actionable insights. Small cells (under SURVEILLANCE_MIN_CELL, default 10) are hidden. Programme data, not a random survey.
 * v1.53.0 changes: failure alerts and latency. (1) The health probe POSTs to ALERT_WEBHOOK_URL when the verdict flips (healthy <-> degraded) and holds for
 *   ALERT_CONFIRM_CHECKS probes (default 2); state lives in KV so a database outage still alerts; src/healthAlert.js. (2) GET /admin/usage now returns an
 *   estimated p95_ms per route and overall, from latency buckets added to route_usage by sql/036 (the Worker code that writes them is unchanged; the older
 *   columns are used if sql/036 has not been run). (3) upstream_failures: daily count of failed Cohere, Groq, USDA and FatSecret calls (sql/035, UPSTREAM_FAILURES_STORE).
 * v1.52.0 changes: scheduled health monitoring. A 5-minute cron runs the same checks as GET /health and stores one row per run in health_checks
 *   when HEALTH_CHECK_STORE=true. New GET /admin/health-history (root key only, ?hours=, max 720): uptime %, coverage, per-upstream uptime and probe latency
 *   (avg, p95, max), an outage timeline and daily uptime. A probe that cannot reach the database is parked in KV and written with the next one. Requires
 *   sql/034_add_health_checks.sql; the single 5-minute cron in wrangler.toml now also runs the hourly consolidation (Workers Free allows 5 crons per account); src/healthMonitor.js. GET /health now also returns ms per pinged service.
 * v1.51.0 changes: diabetes nutrition (no SQL, any API key). New resource /diabetes from Krause 16th ed. ch. 30, ADA Standards of Care 2026 and the UCT exchange lists:
 *   GET /diabetes/reference?section=, POST /diabetes/status (A1C/FPG/OGTT category, eAG), /glucose-targets, /carb-plan (carbohydrate distribution), /carb-count (label reading),
 *   /exchange-plan (reads exchange_lists), /glycemic-load (reads glycaemic_index_data), /insulin (500 and 1700 rules, mealtime dose), /hypoglycemia, /exercise, /plan.
 * v1.50.0 changes: renal targets linked to the existing food lists (no SQL, any API key). New POST /renal-nutrition/food-plan: runs /requirements, reads exchange_lists
 *   and renal_foods, and returns each exchange item as a share of the daily protein, sodium, potassium and phosphorus limits, per-group averages with the exchanges that fit
 *   before a limit is reached, and the matching renal_foods row. Column names are detected, not assumed (src/renalFoodLink.js). /requirements, /plan, /exchange and /renal are unchanged.
 * v1.49.0 changes: renal nutrition calculators from the KDOQI 2020 Nutrition in CKD guideline and Krause ch. 35 Tables 35.9, 35.10 and Box 35.3 (any API key, no SQL).
 *   New resource /renal-nutrition: GET /renal-nutrition/reference?section=, GET /renal-nutrition/emergency-diet (Box 35.3), POST /renal-nutrition/stage (CKD-EPI 2021 eGFR
 *   and KDIGO G/A category), /requirements (protein, energy, sodium, calcium, bicarbonate and the potassium and phosphorus rules by status: ckd_1_2, ckd_3_5, hd, pd,
 *   transplant, from KDOQI 2020, with IBW and the 95%/115% weight adjustment; the older Table 35.9 figures come back separately as legacy_krause), /labs (Table 35.10 blood values
 *   with diet actions, dialysis or normal-kidney ranges, SI units, Ca x P product), /adequacy (URR, Kt/V, eKt/V, nPNA, interdialytic weight gain) and /plan (all of them
 *   plus the monitoring schedule). src/renalNutrition.js. The food list at /renal is unchanged. No change to the /energy engine.
 * v1.48.0 changes: pregnancy and lactation calculators from Krause 16th ed. chapter 14 and Appendix 3 (any API key, no SQL). New resource /pregnancy:
 *   GET /pregnancy/reference?section=, POST /pregnancy/gestational-age (LMP | due date | weeks -> weeks+days, trimester, EDD, milestones),
 *   /weight-gain (pre-pregnancy BMI category, IOM totals and weekly rates, twins, status at a gestational age, weigh-in series),
 *   /plan (pregnant: energy from /energy/requirements with the trimester worked out, protein 0.8/1.1 g/kg, DRI pregnancy targets, twin table;
 *   lactating: add-on, 1800 kcal floor, protein, weight-loss rule), /assess (anemia by trimester with altitude/smoking, Table 14.4 labs,
 *   GDM glucose tests, preeclampsia criteria). src/pregnancy.js. Reuses the /energy engine and the DRI tables; no engine change.
 * v1.47.0 changes: weight management calculators from Krause 16th ed. chapter 21 (any API key, no SQL). New resource /weight-management:
 *   GET /weight-management/reference?section=, GET /weight-management/bariatric?procedure=, POST /weight-management/assess (adult BMI class,
 *   Table 21.3 risk with waist, waist-hip ratio, body fat, metabolic syndrome, treatment-option flags, unintentional-loss significance;
 *   children by BMI-for-age percentile), /loss-plan (maintenance from /energy/requirements minus 500-1000 kcal, rate bands, 5%/10% goals,
 *   protein 1.2 g/kg; refuses below 800 kcal, age 65+, BMI under 25, pregnancy), /gain-plan (maintenance plus 500-1000 kcal, Table 21.12
 *   boosters), /progress (rate, milestones, plateau, maintenance), /diet-pattern (AMDR, very-low-fat, ketogenic, nutrient gaps).
 *   src/weightManagement.js. Reuses the /energy engine, fhirNcp BMI class and Blackburn significance (now exported), foodEnergy, dri_data.
 * v1.46.0 changes: sports nutrition calculators from Krause 16th ed. chapter 23 (any API key, no SQL). New resource /sports:
 *   GET /sports/reference, POST /sports/energy (Cunningham REE, Box 23.2 activity factors, METs, TEF; Appendix 10 via activity_log),
 *   /sports/macros (g/kg by training profile, AMDR check), /sports/fuel-timing (pre, during, after), /sports/hydration (body-mass loss,
 *   rehydration, sodium, urine specific gravity), /sports/body-composition (lowest safe weight, weekly rates), /sports/supplement-dose
 *   (caffeine, creatine, beta-alanine, HMB, beetroot; withheld under 18, pregnant, nursing) and /sports/plan (all of them for one athlete).
 *   src/sportsNutrition.js; the Appendix 10 lookup is shared with /energy via src/energyLookup.js. No change to /energy or /activity-energy.
 * (1.45.0 also: a bare food name's everyday form (rice -> cooked, mango -> ripe) is inferred once per food by Groq and cached 30 days in KV (resolveImpliedForm), used as a soft ranking signal only; falls back to a tiny built-in map when unavailable.
 * (1.45.0 also: when the ranking is unsure on a query that states a state/variety, /foods/search asks Groq to reorder the same rows - src/foodIntentLlm.js,
 *   reorder-only, 2.5 s timeout, KV-cached, silently skipped without GROQ_API_KEY.)
 * v1.45.0 changes: intent-aware food search. No new endpoints, no contract, SQL or data changes. GET /foods/search, /foods/autocomplete (via its fuzzy
 *   backfill) and the lookup cascade (/foods/lookup and everything built on it) now rank the database shortlist with the scorer in src/foodMatching.js
 *   instead of trusting text similarity alone: exact/keyword match, preparation state (cooked, raw, soaked, dried, fermented, ... compared by meaning:
 *   "cooked" is related to boiled, in conflict with raw/soaked; Chichewa wophika/yaiwisi/woviika count), variety, dish vs ingredient, local names,
 *   and verified food_synonyms aliases that only fill gaps and never outrank a direct name match. A stated state/variety steers the ranking but can no
 *   longer hide rows (a second fetch on the food's own words runs when the first is thin), so "cooked rice" reaches "Rice, soaked" and "Brown cooked
 *   rice" = "Rice, Brown, Cooked". Lookup does not answer with a row whose state/variety conflicts with the query; it goes on to USDA/OFF/FatSecret
 *   and only falls back to that row if they find nothing. Spelling variants of one word (sima, mgayiwa) are folded. Same ids, values and response shape.
 *
 * v1.44.3 changes: the bare-"nsima" default is now deterministic. Plain maize nsima leads, refined flour ("Nsima ya ufa oyera") first as the
 *   everyday variant (DISH_PREFERRED_VARIANT), then whole-grain and degermed, then composite maize dishes ("Maize and soya ...") after every plain
 *   maize row, then other staples. Same order in the single-food matcher and in /foods/search and /foods/autocomplete. 1.44.2 only
 *   preferred "any maize-named row", so /foods/convert could land on the maize+soya porridge. Also: a name that contains every word of the query
 *   (main name, qualifiers or local-name parenthetical) gets a coverage bonus, so "nsima ya galamilu" reaches its own degermed row.
 *
 * v1.44.2 changes: a bare "nsima" now resolves to maize nsima instead of cassava (kondowole) everywhere a name becomes a food: the shared
 *   matcher in src/foodMatching.js (lookup, compare, substitutes, recipes, meals, ingredient parsing, /foods/convert, MCP) gets a default-staple
 *   rule (DISH_DEFAULT_STAPLE: nsima -> maize), and the list endpoints (GET /foods/search, /foods/autocomplete, synonym expansion) put maize
 *   rows first via preferDefaultStaple. Only a bare dish name is affected: "cassava nsima", "nsima ya kondowole" and "nsima ya ufa oyera"
 *   behave as before. GET /foods?search= stays alphabetical (paginated browse). No SQL.
 *   Also fixes a scoring gap in the same module: a query whose words split between the name and the Chichewa parenthetical ("maize nsima")
 *   now credits both words, so it reaches "Maize thick porridge, ..., (Nsima ya ufa oyera)" instead of losing to the shorter cassava row.
 *
 * v1.44.1 changes: GET /foods/convert tidy-up. The "100g" restatement is no longer listed as a household serving (and unit=serving no longer
 *   picks it); food.other_matches lists up to 5 other local name matches and warnings[] says when a name matched more than one food;
 *   warnings[] also flags a cooked-food cup/spoon serving applied to a food not named as cooked (rice "soaked" vs "cooked rice (150g)");
 *   quantities of 10 or more show one decimal (16.9 fl oz, not 16⅞).
 *
 * v1.44.0 changes: household and standard measures in one place. New src/measures.js holds one unit table built from the UCT Household
 *   Measurements Guide (tsp, Tbs, Dsp, heaped Dsp, 1/4-3 cups), the Kitchen Measurement Conversion Tables (US cup, fl oz, pint, quart, gallon, oz,
 *   lb) and Krause Appendix 2 (nutrition cup 240 ml, dry measure, #6-#60 portion scoops), with the printed tables kept as published.
 *   GET /foods/convert?q=rice&amount=2&unit=cup (also /foods/:id/convert and ?id=) takes a household or a standard measure of one food and
 *   returns both: grams, ml and oz/lb, the food's own servings (chipande, cup, piece) as counts, spoon/cup equivalents and the nutrients.
 *   GET /measures lists every unit, table and scoop size; GET /measures/convert does unit-to-unit (volume to volume, weight to weight).
 *   Behaviour change in the shared gram conversion (POST /recipes/calculate, /meals/analyze, /ingredients/parse): a volume unit (ml, l, tsp, tbsp,
 *   dsp, cup variants, scoops) now uses the food's own density when it has a cup or spoon serving (1 tbsp of cooked rice is 9 g, not 15 g);
 *   foods without one behave as before (1 g/ml, now flagged). Weight units and food-specific labels (chipande, piece) are unchanged.
 *   New units: us cup, scoop 6-60, dry pint/quart, tbs, plurals. No SQL.
 *
 * v1.43.0 changes: POST /energy/requirements takes activity_log [{activity, type?, minutes|hours}]. Each activity is looked up in the
 *   activity_energy_expenditure table (Appendix 10, kcal per hour at the person's weight), converted to METs and delta PAL, and added to the
 *   PAL that feeds the IOM equations. The reply carries an activity_log block with every step. No SQL: uses the v1.42.0 table.
 *   src/activityEnergy.js (activityLogToPalEntries), src/energyLookup.js (enrichActivityLog).
 *
 * v1.42.0 changes: physical activity energy expenditure from the database (Krause 16th ed. Appendix 10, kcal per hour by body weight).
 *   GET /activity-energy (browse, search, kcal per hour at a weight), POST /activity-energy/calculate (activities and minutes to kcal),
 *   POST /activity-energy/bulk (admin seed). Needs sql/033_add_activity_energy_expenditure.sql and scripts/activity_energy_seed.json;
 *   src/activityEnergy.js.
 *
 * v1.41.0 changes: POST /energy/requirements looks up a child's BMI-for-age percentile from the WHO tables when it is not supplied
 *   (src/energyLookup.js, src/bmiPercentile.js), so the IOM overweight child equations are chosen automatically. New POST /energy/food-energy:
 *   Atwater factors (4/9/4/7 kcal/g), percent-of-weight foods and alcohol drinks (oz x proof x 0.8); src/foodEnergy.js.
 *
 * v1.40.0 changes: energy requirements engine. POST /energy/requirements and GET /energy/factors (any API key). REE (Mifflin-St Jeor or
 *   measured), stress factors, activity factors, PAL, every IOM EER/TEE equation in Krause ch. 2 Box 2.1 with pregnancy and lactation
 *   add-ons. Extensible activity and stress registries; src/energyEngine.js. No database, no SQL.
 *
 * v1.39.0 changes: GET /admin/usage (root key only) - which endpoints get called most. One counter row per UTC day, method
 *   and route in route_usage, bumped by bump_route_usage() when ROUTE_USAGE_STORE=true. Requires sql/032_add_route_usage.sql;
 *   src/routeUsage.js. Counts only. Skips OPTIONS, / , /health and /admin/*.
 *
 * v1.38.0 changes: GET /admin/monitoring (root key only) - failed calls and slow endpoints for the admin monitor.
 *   Failed (5xx, 429, 4xx except 401/404) and slow (>= REQUEST_LOG_SLOW_MS, default 1500) requests are stored in request_log
 *   when REQUEST_LOG_STORE=true. Requires sql/031_add_request_log.sql; src/requestLog.js. Nothing stored by default.
 *
 * v1.37.0 changes: GET /admin/activity (root key only) - recent admin actions for the admin monitor: API keys created
 *   and revoked, packaged foods approved and rejected (with reviewer). Built from existing tables, no SQL; src/adminActivity.js.
 *
 * v1.36.0 changes: viewer support for the admin monitor. GET /rag/jobs takes ?status=, ?limit=, ?offset= and returns total;
 *   GET /fhir/AuditEvent takes ?operation= and ?_offset= and returns Bundle.total. Existing calls behave as before.
 *
 * v1.35.0 changes: GET /admin/overview (root key only) - read-only snapshot (registry counts, review queue,
 *   RAG ingest jobs, API key and usage totals) for the admin monitor page; src/adminOverview.js.
 *
 * v1.34.0 changes (authentication review):
 *  - Every operational route now needs a valid API key. The REQUIRE_API_KEY and
 *    FHIR_AUTH_MODE switches are gone: enforcement is always on, so a missing or
 *    mistyped variable can no longer open the API. The only routes that work with no
 *    credential are GET /, GET /health and the FHIR conformance reads (isOpenRoute).
 *    Two routes carry a different credential that their own handler verifies:
 *    /developer/keys (Supabase login token) and POST /rag/webhook (shared secret).
 *  - Developer accounts use Supabase Auth and consumer keys are managed through
 *    /developer/keys (unchanged). Privileged registry writes still need an admin key
 *    (routePolicy: every non-GET route that is not explicitly a user or compute route).
 *  - Removed OAuth 2.0 client_credentials: POST /oauth/token, GET
 *    /.well-known/oauth-authorization-server and /admin/oauth-clients, plus src/oauth.js
 *    and the OAUTH_SIGNING_SECRET secret. Bearer tokens are API keys only now.
 *    sql/030_drop_oauth_clients.sql drops the table once you have checked nothing uses it.
 *  - POST /fhir/ConceptMap/$translate is an operation, not a read, so it now needs a key.
 *  - The root key comparison is constant time. isAdmin() is renamed resolveCredential()
 *    because it resolves any valid key, not only admin ones.
 *
 * v1.32.0 changes:
 *  - Developer portal: people sign up on the docs site (Supabase Auth) and
 *    create their own consumer API keys via POST/GET/DELETE /developer/keys,
 *    authenticated with their login access token (verified against Supabase
 *    Auth, src/developer.js). Consumer keys are role "consumer": every admin
 *    route still rejects them (the role ranks 0), they get 3x each public
 *    route's rate limit in their own per-key bucket, FHIR scopes system/*.*
 *    (never AuditEvent), and per-key usage counts. Max 3 active keys per
 *    user; email must be confirmed. Requires sql/029_add_developer_keys.sql.
 *
 * v1.31.0 changes:
 *  - FHIR facade now covers the whole Nutrition Care Process (new
 *    src/fhirNcp.js): POST /fhir/Observation/$screen (MUST),
 *    /Observation/$assess-nutrition, /Condition/$diagnose (PES),
 *    /CarePlan/$intervene, /Goal/$evaluate (monitoring & evaluation) and
 *    /Bundle/$ncp-document (ADIME Composition). Stateless, no DB, no new
 *    secrets or SQL. CapabilityStatement updated.
 *
 * v1.30.0 changes:
 *  - Added OAuth 2.0 client_credentials (RFC 6749 §4.4) for machine-to-machine
 *    callers (MCP server, Thanzi Coach, apps). POST /oauth/token exchanges
 *    a client_id + client_secret (HTTP Basic or form/JSON body) for a
 *    1-hour HS256 JWT bearer token carrying the client's role; GET
 *    /.well-known/oauth-authorization-server publishes RFC 8414 metadata.
 *    isAdmin() now accepts these JWTs alongside the root key and per-consumer
 *    API keys, so the existing role gate, /batch forwarding and
 *    reviewed_by attribution all work with no route changes. Clients are
 *    managed root-only via POST/GET/DELETE /admin/oauth-clients (secret shown
 *    once, only its SHA-256 hash stored; revoking also blocks already-issued
 *    tokens via a KV denylist). Pure helpers live in src/oauth.js.
 *    Requires: sql/014_add_oauth_clients.sql and the OAUTH_SIGNING_SECRET
 *    secret. Existing API keys are unchanged and keep working.
 *
 * v1.28.0 changes:
 *  - Replaced pickBestFoodMatch()'s ranking logic entirely (now in the new
 *    src/foodMatching.js) — root cause: its only real disambiguation
 *    beyond exact/word-boundary matching was "shortest food_name wins",
 *    which has nothing to do with which candidate is actually the best
 *    semantic match (e.g. a bare "rice" query could resolve onto "Rice
 *    pudding" or "Rice, soaked" somewhat arbitrarily depending on which
 *    was shorter). Replaced with a multi-component scorer: base-name
 *    token overlap, exact-name match, a dish-word penalty so a genuinely
 *    different prepared dish ("Rice pudding") can't outrank the plain
 *    ingredient just for containing the word, and requested-vs-conflicting
 *    preparation-state/form/freshness/variety attribute matching (so
 *    "cooked rice" actively prefers a cooked record and is penalized
 *    against a conflicting one, while an attribute the query never asked
 *    about only applies a small specificity tiebreak, never a
 *    disqualification — the Malawi FCT frequently has no unqualified
 *    entry for a food at all). Also removed BARE_QUERY_PREFERRED_MATCH,
 *    a per-food hardcoded override (just `{ nsima: "ufa oyera" }`) — a
 *    bare query that only weakly ties across multiple candidates (e.g.
 *    "nsima" matching several candidates solely through their Chichewa-
 *    name parenthetical, with nothing in the query to prefer one base
 *    food over another) is now honestly flagged ambiguous instead of
 *    silently guessing; see pickBestFoodMatchDetailed(), surfaced on
 *    GET /foods/lookup's response as `ambiguous`/`alternates`. Every
 *    existing caller (ingredient parsing, /foods/compare, batch
 *    resolution) still calls pickBestFoodMatch() with its original
 *    signature/return shape, so this is a drop-in ranking improvement
 *    across all of them, not a per-endpoint fix. See
 *    src/foodMatching.js's doc comment and test/foodMatching.test.js for
 *    the full design and regression coverage.
 *
 * v1.27.1 changes:
 *  - sql/010_expand_food_synonyms_from_mfct.sql: expanded food_synonyms
 *    with terms mined from the authoritative Malawi FCT source CSV —
 *    more vegetables/fruits, additional local fish species names, and
 *    insect/wild-food staples (locust, caterpillar, lake flies, termites)
 *    that had zero synonym coverage before. Also fixes a wrong guess from
 *    009 (pumpkin's real FCT term is "Dzungu", not "thabwa"). No code
 *    changes in this version — pure data migration, additive/idempotent.
 *
 * v1.27.0 changes:
 *  - Advanced food search + autocomplete (sql/009_add_advanced_food_search.sql):
 *    - GET /foods/search gained category=, brand=, and ingredient= params.
 *      category= filters the existing typo-tolerant public.foods search to
 *      one category (fuzzy_food_search() gained an optional category_filter
 *      arg; search_term itself is now optional too, so category= alone is a
 *      "browse this category" query). brand= and ingredient= run the new
 *      fuzzy_packaged_search() over packaged_foods.brand /
 *      .ingredients_text instead. Every result in the response is now
 *      tagged with _source ("foods" | "packaged_foods") and _match_type
 *      ("fuzzy" | "synonym" | "brand" | "ingredient") — additive fields, so
 *      existing callers reading the old flat foods-row shape are unaffected.
 *    - Query expansion via the new food_synonyms table: a search for
 *      "chinangwa" now also searches "cassava" (and vice versa), same for
 *      ~60 other seeded Chichewa<->English staple/local-name pairs (see
 *      expandSynonyms()). expanded_terms is returned alongside data so
 *      callers can show "also searched: cassava".
 *    - GET /foods/autocomplete now checks the local Malawi FCT + packaged
 *      foods tables FIRST (new autocomplete_food_names()/
 *      autocomplete_packaged_names() RPCs — cheap substring match, ranked
 *      so a whole-name-prefix beats a mid-string one), backfills with
 *      fuzzy_food_search() if that's short on results (typo tolerance
 *      while typing — "nsim" -> Nsima, Nsima ya chimanga, Nsima ya
 *      kondowole, ...), then expands synonyms, and only THEN falls back to
 *      the existing FatSecret suggestions for terms with no local coverage.
 *      Previously this endpoint was 100% FatSecret and returned nothing
 *      Malawi/Chichewa-specific at all. FatSecret absence (no credentials
 *      configured) is no longer fatal — local results still return; only
 *      the external tier is skipped.
 *    - New GET /foods/by-category?category=...&max_results=... — plain
 *      category browse (no query text needed), thin wrapper over
 *      fuzzy_food_search(null, ..., category_filter).
 *
 * v1.26.0 changes:
 *  - Added POST /batch — lets one HTTP round trip carry several sub-requests
 *    (e.g. a handful of /foods/lookup calls plus a /rag/ask, or several
 *    /foods/:id reads) instead of forcing a client to make one call per
 *    item. Motivated by the MCP server, which was doing this fan-out itself
 *    over HTTP/service-binding per tool call — now it can send one batch
 *    and get every sub-result back together, cutting round trips (and
 *    Termux/mobile-network latency) proportionally to batch size.
 *    Body: { "requests": [ { "id"?, "method", "path", "body"? }, ... ] },
 *    max BATCH_MAX_REQUESTS (20) items. Each item is routed through the
 *    *exact same* auth + rate-limit + edge-cache + dispatch pipeline as a
 *    normal top-level request (see routeSingle(), factored out of router()
 *    for this reuse) — a sub-request needing an admin key still needs one
 *    (forwarded from the batch call's own Authorization header), and it
 *    still counts against that resource's own rate-limit bucket. This means
 *    batching cannot be used to bypass per-resource auth or rate limits;
 *    it only saves round trips. The batch endpoint itself also has its own
 *    (tighter) rate limit, since a single batch can fan out into a lot of
 *    backend work. Nested /batch sub-requests are rejected. Response:
 *    { status: "success", data: [ { id, status, body }, ... ], meta }, with
 *    per-item results always in request order and never short-circuited by
 *    one item's failure (each item gets its own status/body, HTTP 200 at
 *    the envelope level unless the batch request itself is malformed).
 *
 * v1.22.1 changes:
 *  - Fixed a false-positive in fuzzy_food_search() (v1.22.0): scoring the
 *    whole query as one string let a common word dominate and mask an
 *    unrelated word matching nothing — "Boiled rice" scored higher against
 *    "Beans, boiled, (Nyemba zowilitsa)" than against any real rice entry,
 *    because "boiled" appears verbatim in dozens of foods while "rice" had
 *    zero overlap with "Beans...". Caught via live WhatsApp testing.
 *    Fix: score each word of the query independently and require the
 *    WEAKEST word to still clear min_similarity, so a food only qualifies
 *    if every word in the query is genuinely represented in it. "Boiled
 *    rice" now correctly falls through to the next tier instead of
 *    confidently returning beans — Malawi FCT says "Rice, ..., cooked", not
 *    "Boiled rice", so there's no real match to make. Default
 *    min_similarity raised 0.3 -> 0.35 (now a per-word floor, not a
 *    whole-query score, so the semantics changed along with the number).
 *    All 5 original typo test cases (Chinagwa, Rice poridge, Nsima ya
 *    Kondewole, Ufa woera, bananna) still resolve correctly. See
 *    sql/008_add_fuzzy_food_search.sql for details and reasoning.
 *
 * v1.22.0 changes:
 *  - Added typo-tolerant fuzzy search over public.foods: GET /foods/search
 *    (new, public, rate-limited) and a new fallback tier in
 *    lookupFoodCascade (used by /foods/lookup and everything built on it —
 *    /recipes/calculate, /meals/analyze, the WhatsApp bot's bare-food-name
 *    lookup, etc.) that runs between the exact-ilike local match and the
 *    external-cache/API steps. Previously a misspelled Malawian food name
 *    (e.g. "Chinagwa" for "Chinangwa") found nothing locally — ilike
 *    requires an exact substring — and fell straight through to USDA/OFF/
 *    FatSecret, which don't index Chichewa names either, so it just failed.
 *    Implementation: sql/008_add_fuzzy_food_search.sql adds a
 *    fuzzy_food_search() Postgres function (pg_trgm's word_similarity(),
 *    NOT plain similarity() — food_name values are full FCT descriptions
 *    like "Cassava, tuber, raw, (Chinangwa chachiwisi)", and comparing a
 *    short query against that whole string scores too low even for a
 *    near-perfect partial match; word_similarity finds the best-matching
 *    substring instead) to shortlist via the new GIN trigram index on
 *    food_name, then levenshtein() edit distance to break ties. Wrapped by
 *    fuzzyFoodSearch() in this file.
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
import { pickBestFoodMatch, pickBestFoodMatchDetailed, defaultStapleFor, preferDefaultStaple, searchFoodsRanked, hasStatedAttributes, retrievalTermFor, conflictsWithQuery, rankingNeedsHelp } from "./foodMatching.js";
import { llmRerankFoods, inferDefaultForm } from "./foodIntentLlm.js";
import { parseQueryAttributes } from "./foodMatching.js";
import { parseBmiForAgeQuery, classifyBmiForAge } from "./bmiForAge.js";
import { parseHcVelocityQuery, classifyHcVelocity, normalizeSex as normalizeHcSex } from "./hcVelocity.js";
import { parseLengthVelocityQuery, classifyLengthVelocity } from "./lengthVelocity.js";
import { parseWeightVelocityQuery, classifyWeightVelocity } from "./weightVelocity.js";
import { parseMuacForAgeQuery, classifyMuacForAge } from "./muacForAge.js";
import { parseMuacFixedQuery, classifyMuacFixed } from "./muacFixed.js";
import { parseLhfaQuery, pickRowAndValue, classifyLhfa, defaultMeasured } from "./lengthHeightForAge.js";
import { parseWeightForAgeQuery, classifyWeightForAge } from "./weightForAge.js";
import { parseWflhQuery, resolveLookup, classifyWflh } from "./weightForLengthHeight.js";
import { parseBmiUnder5Query, resolveBmi, classifyBmiUnder5 } from "./bmiForAgeUnder5.js";
import { parseHcForAgeQuery, classifyHcForAge } from "./hcForAge.js";
import { parseAssessQuery, assessGrowth } from "./growthAssess.js";
import { handleRagPipeline, handleIngestQueue } from "./ragPipeline.js";
import { handleAdminOverview } from "./adminOverview.js";
import { handleAdminActivity } from "./adminActivity.js";
import { handleAdminMonitoring, logRequest } from "./requestLog.js";
import { handleAdminUsage, recordUsage } from "./routeUsage.js";
import { handleSurveillance } from "./surveillance.js";
import { parseAssessmentRequest, buildEnergyTarget, assessDiet, normalizeIntake, sumResolved, coverageOf, dietaryAssessmentReference, foodsColumnFor, EXTRA_FOOD_FIELDS } from "./dietaryAssessment.js";
import { trackedFetch, recordUpstreamFailure, isFatSecretError, flushUpstreamFailures } from "./upstreamFailures.js";
import { handleAdminHealthHistory, runHealthProbe, HEALTH_CRON } from "./healthMonitor.js";
import { computeEnergyRequirements, energyFactorCatalog } from "./energyEngine.js";
import { enrichBmiPercentile, enrichActivityLog, lookupActivityLogEnergy } from "./energyLookup.js";
import { computePaediatricEnergy, computePaediatricProtein, computePaediatricFluid, computePretermRequirements, computeGrowthVelocity, computeCatchUp, computeEnteralFeeds, computePaediatricPlan, idealWeightLookupFor, paediatricReferenceCatalog } from "./paediatric.js";
import { computeGestationalAge, computePregnancyWeightGain, computePregnancyPlan, computePregnancyAssessment, pregnancyReferenceCatalog } from "./pregnancy.js";
import { computeEnteralPlan, enteralReferenceCatalog, mapFormulaRow, pickFormulaByName } from "./enteralNutrition.js";
import { computeProteinByStress, computeNpeNitrogenRatio, computeNitrogenBalance, computeCarbohydrateRequirement, fatRequirement, computePropofolFat, choFatRatioReference, computeElectrolyteReplacement, computePotassiumDeficit, computeIcuFluid, criticalCareReferenceCatalog } from "./criticalCare.js";
import { computeRenalStage, computeRenalRequirements, computeRenalLabs, computeDialysisAdequacy, computeRenalPlan, emergencyDiet, renalReferenceCatalog } from "./renalNutrition.js";
import { linkRenalFoods } from "./renalFoodLink.js";
import { computeGlycemicStatus, computeGlucoseTargets, computeCarbPlan, computeCarbCount, computeExchangePlan, computeGlycemicLoad, computeInsulin, computeHypoglycemia, computeExerciseCarbs, computeDiabetesPlan, diabetesReferenceCatalog } from "./diabetesNutrition.js";
import { computeWeightAssessment, computeLossPlan, computeGainPlan, computeWeightProgress, computeDietPattern, computeBariatricGuidance, weightReferenceCatalog } from "./weightManagement.js";
import { computeSportsEnergy, computeSportsMacros, computeFuelTiming, computeHydration, computeBodyComposition, computeSupplementDoses, computeSportsPlan, sportsReferenceCatalog } from "./sportsNutrition.js";
import { computeFoodEnergy } from "./foodEnergy.js";
import { computeActivityEnergy, listActivities, parseWeight } from "./activityEnergy.js";
import {
  CONSUMER_ROLE, MAX_KEYS_PER_USER, consumerRateLimit, validateLabel, bumpUsage, readUsage,
  verifySupabaseUser, buildConsumerKeyRow, publicKeyView,
} from "./developer.js";
import {
  parseFentonQuery,
  classifyRow,
  parseProfileBody,
  parseSeriesBody,
  computeVelocity,
  summarizeTrend,
  SCREENING_NOTE,
  FENTON_REFERENCES_META,
  FENTON_YEARS,
  normalizeSex,
  normalizeMetric,
  ageInDays,
} from "./fentonPreterm.js";
import { renderFentonChartSVG } from "./fentonChart.js";
import {
  operationOutcome,
  parseEvaluateGrowth,
  decideGrowthRoute,
  buildFentonObservation,
  buildBmiForAgeObservation,
  bundleObservations,
  buildCapabilityStatement,
  toGrams,
  toKg,
  toCm,
} from "./fhir.js";
import { measurementsToAssessQuery, buildWhoGrowthBundle } from "./fhirGrowth.js";
import {
  resolveQuantityToGrams, describeAmount, deriveDensity, densityFormWarning, findUnit, convertUnits, parseQuantity, formatQuantity,
  volumeEquivalents, weightEquivalents, measureCatalog, UNIT_SURFACE_FORMS, UNITS,
} from "./measures.js";
import { ncpOperationFor, diagnosisCodesRequested, buildNcpCodeSystem } from "./fhirNcp.js";
import { staticConformanceResource } from "./fhirTerminology.js";
import { diagnosisOperationFor } from "./fhirDiagnosis.js";
import { interventionOperationFor } from "./fhirIntervention.js";
import { monitoringOperationFor } from "./fhirMonitoring.js";
import { documentOperationFor } from "./fhirDocument.js";
import { contextOperationFor } from "./fhirContext.js";
import {
  governanceOperationFor, decideAccess, classifyFhirRoute, parseScopes, operationOutcomeFor, legacyErrorMessage, buildAuditEvent, auditRow,
  auditSubject, auditSearchBundle, profileResource, conceptMapResource, FHIR_JSON,
} from "./fhirGovernance.js";
import { assessmentOperationFor, questionnaireResource, questionnaireSearchBundle } from "./fhirAssessment.js";
import { capSearchTerms } from "./searchTerms.js";

// ─── VERSION ─────────────────────────────────────────────────────────────────
// Single source of truth for the version reported by GET / (handleRoot).
// Bump this alongside the changelog comment at the top of this file — the two
// had drifted out of sync before (header said v1.4.0, GET / said v1.2.0).
const CNR_VERSION = "1.58.0";

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers": "X-Cache, X-Request-Id, Retry-After, WWW-Authenticate",
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

/**
 * 401 for a request with no valid API key. Tells the caller exactly how to get a key
 * and how to send it.
 */
function keyRequired(env) {
  const docs = (env && env.DOCS_URL) || "https://edisontaimu9-ui.github.io/Chakudya-docs";
  return json(
    {
      status: "error",
      code: "api_key_required",
      message: `An API key is required. Create a free key at ${docs}/#/account and send it as 'Authorization: Bearer YOUR_API_KEY'.`,
    },
    401,
    { "WWW-Authenticate": 'Bearer realm="chakudya"' }
  );
}

/**
 * The explicit allowlist of routes that work with no credential at all. Anything not
 * matched here needs a valid API key (consumer, reviewer or admin), and routePolicy()
 * can additionally demand the admin role. Keep this in sync with README.md, openapi.yaml
 * (the operations with `security: []`) and handleRoot().
 *
 *  - GET /        (answered in router() before the gate)
 *  - GET /health
 *  - GET /fhir/metadata and the other FHIR conformance reads (see classifyFhirRoute)
 */
function isOpenRoute(resource, method, param) {
  if (resource === "health" && method === "GET") return true;
  if (resource === "fhir" && method === "GET") return classifyFhirRoute(method, param).kind === "public";
  return false;
}

/**
 * Routes that skip the API-key check because they carry a different credential that
 * their handler verifies itself and fails closed on. They are not public: a request
 * without that credential is rejected with 401.
 *  - /developer/keys: the caller's Supabase login access token (handleDeveloperKeys)
 *  - POST /rag/webhook: the shared secret in x-webhook-secret (handleRagWebhook)
 */
function usesOwnCredential(resource, method, param) {
  if (resource === "developer" && param === "keys") return true;
  if (resource === "rag" && param === "webhook" && method === "POST") return true;
  return false;
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
 * Role hierarchy for per-consumer API keys (see /admin/keys and resolveCredential()).
 * The developer-portal role "consumer" is not listed here on purpose: it ranks 0, so it
 * is refused on every admin route.
 * "reviewer" is a subset of "admin" — can only reach routes that
 * explicitly opt in via routePolicy's requiredRole: "reviewer" (currently
 * just the packaged review queue: GET /packaged/pending, POST
 * /packaged/:id/approve|reject). Every other admin route implicitly
 * requires "admin" (the strictest/default), so a route added later that
 * forgets to set requiredRole fails closed rather than open.
 */
const ROLE_RANK = { reviewer: 1, admin: 2 };
const VALID_ROLES = Object.keys(ROLE_RANK);

/** Constant-time string compare, so the root key check leaks nothing through timing. */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// sha256Hex() is defined further down (used first by the query-cache
// helpers) — reused here for API key hashing too. Function declarations
// are hoisted, so the call below is safe regardless of file order.

/**
 * Resolves the bearer token on a request to a credential identity (any valid API key,
 * not only admin ones; the role says what it may do).
 *
 * Two kinds of valid credential:
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
 * "admin" (full access, the default — same as before roles
 * existed), "reviewer" (packaged-review + reads only, see routePolicy's
 * requiredRole checks and the role gate in authAndRateGate()) or "consumer"
 * (developer-portal key: every non-admin route, never an admin one). Falls back to
 * "admin" if the row predates the `role` column (safe default — an
 * existing key's access doesn't silently shrink when this feature ships).
 */
async function resolveCredential(request, env, db, ctx) {
  const token = getBearerToken(request);
  if (!token) return { valid: false };

  if (!env.ADMIN_API_KEY) {
    // Misconfiguration safety: if no root key is set, fail closed (deny
    // writes) rather than silently allowing unauthenticated writes.
    return { valid: false };
  }

  if (timingSafeEqual(token, env.ADMIN_API_KEY)) {
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

  return { valid: true, label: row.label, isRoot: false, keyId: row.id, role: row.role || "admin", fhirScopes: parseScopes(row.fhir_scopes) ?? [] };
}

// ─── FHIR ACCESS GATE + AUDIT CONTEXT ───────────────────────────────────────
//
// Per-request facts the audit trail needs (who, what route, whether denied).
// Keyed by the Request object so nothing leaks between requests.
const FHIR_REQUEST_CONTEXT = new WeakMap();

/**
 * Resolves the caller (if a Bearer token is present) and applies decideAccess().
 * Clinical operations always require a credential with the right scope (there
 * is no open mode). Conformance reads are the only open FHIR routes. AuditEvent
 * reads need the admin role or an explicit scope. Returns { response } to stop
 * the request, or {}.
 */
async function fhirAccessGate(request, env, db, ctx, method, param, action) {
  let identity = null;
  if (getBearerToken(request)) {
    const a = await resolveCredential(request, env, db, ctx);
    identity = a.valid ? { ...a, fhirScopes: a.fhirScopes ?? [] } : { valid: false };
  }
  const decision = decideAccess({ method, param, action, identity });
  FHIR_REQUEST_CONTEXT.set(request, { identity: identity?.valid ? identity : null, route: decision.route, denied: decision.allow ? null : decision.message });
  if (decision.allow) return {};
  const headers = decision.status === 401 ? { "WWW-Authenticate": 'Bearer realm="chakudya-fhir"' } : {};
  return { response: json(operationOutcomeFor(decision.status, decision.message, decision.code), decision.status, headers) };
}

/**
 * Adds FHIR content type, no-store and nosniff to /fhir responses, turns the
 * facade's generic error bodies into OperationOutcomes, and records the audit
 * event for the request (log line; stored when FHIR_AUDIT_STORE=true).
 */
async function finalizeFhirResponse(request, response, env, ctx, requestId, url, startedAt) {
  const headers = new Headers(response.headers);
  let body = response.body;
  const isJson = (headers.get("Content-Type") || "").includes("json");

  if (response.status >= 400 && isJson) {
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* keep as is */ }
    const msg = legacyErrorMessage(parsed);
    body = msg !== null ? JSON.stringify(operationOutcomeFor(response.status, msg)) : text;
  }
  if (isJson) headers.set("Content-Type", FHIR_JSON);
  headers.set("X-Content-Type-Options", "nosniff");
  if (request.method === "POST" || url.pathname.startsWith("/fhir/AuditEvent")) headers.set("Cache-Control", "no-store");
  const out = new Response(body, { status: response.status, headers });

  // Audit: every non-public request, and any failure. Never the body or query string.
  const rc = FHIR_REQUEST_CONTEXT.get(request);
  const audited = (rc && rc.route?.kind !== "public" && rc.route?.kind !== "other") || response.status >= 400;
  if (audited && env.FHIR_AUDIT_LOG !== "off") {
    const event = buildAuditEvent({
      base: url.origin, requestId, now: new Date().toISOString(), method: request.method, path: url.pathname,
      status: response.status, actor: rc?.identity ?? null, ip: clientIp(request),
      patient: env.FHIR_AUDIT_INCLUDE_PATIENT === "true" ? rc?.subject : undefined, denied: rc?.denied ?? undefined,
    });
    console.log(JSON.stringify({ level: "audit", type: "fhir_audit_event", request_id: requestId, duration_ms: Date.now() - startedAt, audit_event: event }));
    if (env.FHIR_AUDIT_STORE === "true") {
      const db = supabase(env);
      const write = db.insert("fhir_audit_events", auditRow(event)).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(write);
    }
  }
  return out;
}

/** GET /fhir/AuditEvent[?date=&outcome=&agent-name=&operation=&_count=&_offset=] and GET /fhir/AuditEvent/{id}. Access is checked by fhirAccessGate. */
async function handleFhirAuditEvent(request, url, db, env, id) {
  if (env.FHIR_AUDIT_STORE !== "true") {
    return json(operationOutcomeFor(501, "AuditEvent storage is not enabled on this deployment (set FHIR_AUDIT_STORE=true and run sql/028). Audit events are still written to the Worker logs.", "not-supported"), 501);
  }
  if (id) {
    if (!/^[A-Za-z0-9\-.]{1,64}$/.test(id)) return json(operationOutcomeFor(400, "Invalid AuditEvent id."), 400);
    const { ok, status, body } = await db.selectOne("fhir_audit_events", id);
    if (!ok) return json(operationOutcomeFor(status === 404 ? 404 : 502, status === 404 ? `AuditEvent/${id} not found.` : "Audit query failed (has sql/028 been run?)"), status === 404 ? 404 : 502);
    return json(body.event);
  }
  const filters = {};
  const q = url.searchParams;
  const dates = q.getAll("date");
  const OPS = { eq: "eq", ge: "gte", le: "lte", gt: "gt", lt: "lt" };
  const parts = [];
  for (const d of dates.slice(0, 2)) {
    const m = /^(eq|ge|le|gt|lt)?(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?)$/.exec(d);
    if (!m) return json(operationOutcomeFor(400, `Invalid date parameter "${d}". Use date=ge2026-10-01 style values.`), 400);
    parts.push([OPS[m[1] ?? "eq"], m[2]]);
  }
  if (parts.length === 1) filters.recorded = `${parts[0][0]}.${parts[0][1]}`;
  else if (parts.length === 2) filters.and = `(recorded.${parts[0][0]}.${parts[0][1]},recorded.${parts[1][0]}.${parts[1][1]})`;
  const outcome = q.get("outcome");
  if (outcome) {
    if (!/^(0|4|8|12)$/.test(outcome)) return json(operationOutcomeFor(400, "outcome must be 0, 4, 8 or 12."), 400);
    filters.outcome = `eq.${outcome}`;
  }
  const agent = q.get("agent-name");
  if (agent) filters.agent = `eq.${agent.slice(0, 120)}`;
  const operation = q.get("operation");
  if (operation) {
    // Substring match on the stored "METHOD /fhir/..." text. Strip characters that mean something in a PostgREST filter value.
    const needle = operation.replace(/[^A-Za-z0-9 /$._-]/g, "").slice(0, 80);
    if (needle) filters.operation = `ilike.*${needle}*`;
  }
  const count = Math.min(Math.max(parseInt(q.get("_count") || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.get("_offset") || "0", 10) || 0, 0);
  const { ok, body, total } = await db.select("fhir_audit_events", { filters, order: "recorded.desc", limit: count, offset, select: "id,event" });
  if (!ok || !Array.isArray(body)) return json(operationOutcomeFor(502, "Audit query failed (has sql/028 been run?)"), 502);
  return json(auditSearchBundle(url.origin, body, { count: typeof total === "number" ? total : undefined }));
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
  if (resource === "measures") {
    return { ttl: 86400 }; // 24 hours — static reference tables and pure unit arithmetic
  }
  if (resource === "foods" && param === "autocomplete") {
    return { ttl: 3600 }; // 1 hour — repeat partial-query lookups are common while typing
  }
  if (resource === "foods" && param === "substitutes") {
    return { ttl: 3600 }; // 1 hour — same reference-data reasoning as autocomplete
  }
  if (resource === "foods" && param === "search") {
    return { ttl: 3600 }; // 1 hour — same reference-data reasoning as autocomplete
  }
  if (["foods", "exchange", "renal", "formulas", "glycaemic-index", "bmi-for-age", "hc-velocity", "length-velocity", "weight-velocity", "muac-for-age", "muac", "length-height-for-age", "weight-for-age", "weight-for-length-height", "bmi-for-age-under-5", "hc-for-age", "growth", "fenton-preterm", "energy", "activity-energy", "sports", "weight-management", "pregnancy", "renal-nutrition", "diabetes", "critical-care"].includes(resource) && param !== "lookup") {
    return { ttl: 3600 }; // 1 hour — static reference data (includes GET /foods/compare)
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
 * - auth: "key"    any valid API key (consumer, reviewer or admin)
 *         "admin"  an admin credential (and requiredRole, default "admin")
 *         "login"  /developer/keys: a Supabase login token, checked by its handler
 *         "secret" POST /rag/webhook: a shared secret, checked by its handler
 * - rate: { limit, windowSeconds, scope: "ip" | "admin" }
 * Whether a route needs no credential at all is NOT decided here but by the explicit
 * allowlist isOpenRoute(); every other route is refused without a key in
 * authAndRateGate(). In the comments below, "public" means "no admin role needed",
 * not "no key needed". Tune the numbers as real usage patterns emerge.
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
  const isRagUpload = resource === "rag" && (param === "upload" || param === "enqueue") && method === "POST";
  const isRagJobs = resource === "rag" && param === "jobs" && method === "GET";
  const isRagWebhook = resource === "rag" && param === "webhook" && method === "POST";
  const isFoodsLookup = resource === "foods" && param === "lookup" && method === "GET";
  const isFoodsConvert = resource === "foods" && (param === "convert" || action === "convert") && method === "GET";
  const isFoodsSearch = resource === "foods" && param === "search" && method === "GET";
  const isFoodsByCategory = resource === "foods" && param === "by-category" && method === "GET";
  const isFoodsLocalCategories = resource === "foods" && param === "local-categories" && method === "GET";
  const isFoodsBabyFoods = resource === "foods" && param === "baby-foods" && method === "GET";
  const isFoodsAutocomplete = resource === "foods" && param === "autocomplete" && method === "GET";
  const isFoodsCategories = resource === "foods" && param === "categories" && method === "GET";
  const isFoodSubstitutes = resource === "foods" && param === "substitutes" && method === "GET";
  const isFoodsCompare = resource === "foods" && param === "compare" && method === "GET";
  const isFentonCompute =
    resource === "fenton-preterm" &&
    ["profile", "growth", "velocity"].includes(param) &&
    method === "POST";
  const isFentonChart = resource === "fenton-preterm" && param === "chart" && method === "GET";
  const isFentonReferences = resource === "fenton-preterm" && param === "references" && method === "GET";
  const isFhirMetadata = resource === "fhir" && param === "metadata" && method === "GET";
  const isFhirEvaluateGrowth = resource === "fhir" && param === "Observation" && action === "$evaluate-growth" && method === "POST";
  const isFhirNcpOperation = resource === "fhir" && method === "POST" && fhirOperationFor(param, action) !== null;
  const isFhirQuestionnaire = resource === "fhir" && method === "GET" && param === "Questionnaire";
  const isFhirNcpCodeSystem = resource === "fhir" && method === "GET" && Boolean(action) && ["CodeSystem", "OperationDefinition", "StructureDefinition", "ConceptMap"].includes(param);
  // AuditEvent reads are public in the rate-limit sense only; the FHIR access gate (fhirAccessGate) always demands a credential.
  const isFhirAudit = resource === "fhir" && method === "GET" && param === "AuditEvent";
  const isMemoryWrite = resource === "memory" && param === "write" && method === "POST";
  const isMemoryRecall = resource === "memory" && param === "recall" && (method === "GET" || method === "POST");
  const isMemoryConsolidate = resource === "memory" && param === "consolidate" && method === "POST";
  const isAdminKeys = resource === "admin" && (param === "keys" || param === "overview" || param === "activity" || param === "monitoring" || param === "usage" || param === "health-history");
  const isBulkInsert =
    ["foods", "exchange", "renal", "formulas", "drug-interactions", "glycaemic-index", "bmi-for-age", "hc-velocity", "length-velocity", "weight-velocity", "muac-for-age", "length-height-for-age", "weight-for-age", "weight-for-length-height", "bmi-for-age-under-5", "hc-for-age", "fenton-preterm", "activity-energy"].includes(resource) &&
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
  const isBatch = resource === "batch" && method === "POST";

  // Developer portal key management. Not an API-key route: the handler verifies the
  // caller's Supabase login token itself (see usesOwnCredential). Key creation is
  // capped tighter.
  if (resource === "developer") {
    return { auth: "login", rate: { limit: method === "POST" ? 10 : 30, windowSeconds: 60, scope: "ip" } };
  }

  // Batch — fans out into up to BATCH_MAX_REQUESTS sub-requests, each of
  // which pays its own cost against its own resource's rate limit. This
  // outer limit exists only to cap how many *batches* (i.e. how much total
  // fan-out) one IP can trigger per minute — the per-item costs are already
  // covered by each sub-request's own policy in routeSingle().
  if (isBatch) {
    return { auth: "key", rate: { limit: 10, windowSeconds: 60, scope: "ip" } };
  }

  // Favorites/history — no admin gate (same public, self-declared-identity
  // model as memory/write and memory/recall: the client supplies its own
  // user_id, there's no server-side account system). Writes capped tighter
  // than reads.
  if (isFavorites || isHistory) {
    return isWrite
      ? { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } }
      : { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Food log (nutrition diary) — same public, self-declared-identity model
  // as favorites/history above. Writes (log a meal, delete an entry) capped
  // tighter than reads; /log/summary is a read.
  if (isLog) {
    return isWrite
      ? { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } }
      : { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Nutrition Research & Surveillance Engine (src/surveillance.js). Sending anonymised records and reading the reference
  // need any valid key; the analysis reads (summary, hotspots, trends, alerts, insights) need an admin key.
  if (resource === "surveillance") {
    if (param === "records" && method === "POST") return { auth: "key", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
    if (param === "reference" && method === "GET") return { auth: "key", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
    return { auth: "admin", rate: { limit: 30, windowSeconds: 60, scope: "admin" } };
  }

  // API key management — admin-gated regardless of method (including GET,
  // which would otherwise fall through to the plain-reads default below).
  // Root-only enforcement (as opposed to any admin key) happens in
  // authAndRateGate(), since routePolicy() only resolves auth *level*, not identity.
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
    return { auth: "key", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // Foods lookup can trigger external API calls (USDA/OFF/FatSecret) — public
  // but capped to protect those quotas, separate from plain local reads.
  if (isFoodsLookup) {
    return { auth: "key", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // Measure conversion resolves a food by name (local first, then the external cascade) and does
  // arithmetic on it — the same cost profile as a lookup, a little cheaper because local usually hits.
  if (isFoodsConvert) {
    return { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // Measures reference (units, printed tables, unit-to-unit conversion): pure computation, no database.
  if (resource === "measures" && method === "GET") {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Fuzzy search — a single indexed Postgres RPC call (pg_trgm + levenshtein),
  // no external API cost, so it gets the same generous headroom as autocomplete.
  // by-category is the same cost profile (one local RPC call), same limit.
  if (isFoodsSearch || isFoodsByCategory || isFoodsLocalCategories || isFoodsBabyFoods) {
    return { auth: "key", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
  }

  // Autocomplete — a type-ahead UX fires one request per keystroke pause,
  // so this needs more headroom than a single lookup. Local-first (Malawi
  // FCT + packaged foods substring/fuzzy match, no external cost) since
  // v1.27.0; only falls through to a FatSecret Premier call when local
  // coverage is thin, so the same limit as plain local reads is fine now.
  if (isFoodsAutocomplete) {
    return { auth: "key", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
  }

  // Categories — near-static reference data, heavily cached at the edge
  // (see cachePolicy), so the rate limit mostly just protects cache misses.
  if (isFoodsCategories) {
    return { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // Community submissions: public, but tightly rate-limited to deter spam.
  if (isPackagedSubmit) {
    return { auth: "key", rate: { limit: 10, windowSeconds: 60, scope: "ip" } };
  }

  // Fenton preterm classify/profile/growth/velocity are all pure
  // computation over the seeded reference table (a DB lookup + arithmetic,
  // no external API call) — public, same tier as bmi-for-age's classify.
  // /chart adds SVG rendering server-side but is still cheap; cached at the
  // edge too (see cachePolicy) so repeat requests for the same curve don't
  // hit the DB at all.
  // Combined growth assessment fans out up to seven local reference lookups
  // per request (no external API cost) — public, a bit tighter than a single
  // classify call.
  if (resource === "growth" && param === "assess" && method === "GET") {
    return { auth: "key", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
  }
  // Energy requirements engine (src/energyEngine.js): pure arithmetic on the request body, no database,
  // no external calls. Any valid key. POST is a calculation, not a write.
  if (resource === "energy" && (((param === "requirements" || param === "food-energy") && method === "POST") || (param === "factors" && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Dietary assessment (src/dietaryAssessment.js): POST resolves up to 40 ingredients (one food lookup each) plus up to 3 ranking reads, so it gets the same
  // cap class as recipes/meals. The GET reference is static.
  if (resource === "dietary-assessment" && method === "POST" && !param) {
    return { auth: "key", rate: { limit: 10, windowSeconds: 60, scope: "ip" } };
  }
  if (resource === "dietary-assessment" && param === "reference" && method === "GET") {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Pregnancy and lactation calculators (src/pregnancy.js): arithmetic on the request body, static chapter tables, the energy engine and the
  // static DRI tables. No database reads or writes, so POST is a calculation. Any valid key.
  if (resource === "pregnancy" && ((["gestational-age", "weight-gain", "plan", "assess"].includes(param) && method === "POST") || (param === "reference" && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Paediatric nutrition calculators (src/paediatric.js): arithmetic on the request body and static tables. catch-up (and plan with catch_up:true) also reads one
  // who_weight_for_length_height row. No writes. Any valid key. /pediatric is an alias.
  if ((resource === "paediatric" || resource === "pediatric") && ((["energy", "protein", "fluid", "preterm", "growth-velocity", "catch-up", "enteral-feeds", "plan"].includes(param) && method === "POST") || (param === "reference" && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Enteral nutrition calculator (src/enteralNutrition.js): arithmetic on the request body. calculate may read enteral_formulas (read only) when formula_id or formula_name is sent. Any valid key.
  if (resource === "enteral-nutrition" && ((param === "calculate" && method === "POST") || (param === "reference" && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Critical care nutrition support calculators (src/criticalCare.js): arithmetic on the request body and static tables. No database access. POST calculates, GET returns tables. Any valid key.
  if (resource === "critical-care" && (([ "protein-by-stress", "npe-nitrogen-ratio", "nitrogen-balance", "carbohydrate", "propofol-fat", "electrolytes", "potassium-deficit", "fluid" ].includes(param) && method === "POST") || ([ "fat", "cho-fat-ratio", "reference" ].includes(param) && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Renal nutrition calculators (src/renalNutrition.js): arithmetic on the request body and static guideline tables. No database reads or writes,
  // so POST is a calculation. Any valid key. (The renal food list stays at /renal.) food-plan also reads exchange_lists and renal_foods (read only).
  if (resource === "renal-nutrition" && ((["stage", "requirements", "labs", "adequacy", "plan", "food-plan"].includes(param) && method === "POST") || ((param === "reference" || param === "emergency-diet") && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // /diabetes: POST calculators and GET reference. exchange-plan and glycemic-load also read exchange_lists and glycaemic_index_data (read only). Any valid key.
  if (resource === "diabetes" && ((["status", "glucose-targets", "carb-plan", "carb-count", "exchange-plan", "glycemic-load", "insulin", "hypoglycemia", "exercise", "plan"].includes(param) && method === "POST") || (param === "reference" && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Weight management calculators (src/weightManagement.js): arithmetic on the request body and static chapter tables. loss-plan and
  // gain-plan call the energy engine; activity_log (loss-plan, gain-plan) and a child's BMI percentile (assess) read existing tables.
  // No writes, so POST is a calculation. Any valid key.
  if (resource === "weight-management" && ((["assess", "loss-plan", "gain-plan", "progress", "diet-pattern"].includes(param) && method === "POST") || (["reference", "bariatric"].includes(param) && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Sports nutrition calculators (src/sportsNutrition.js): arithmetic on the request body. Only activity_log reads one reference
  // table (activity_energy_expenditure). No writes, so POST is a calculation. Any valid key.
  if (resource === "sports" && ((["energy", "macros", "fuel-timing", "hydration", "body-composition", "supplement-dose", "plan"].includes(param) && method === "POST") || (param === "reference" && method === "GET"))) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // Activity energy calculation (src/activityEnergy.js): reads one reference table, no writes. Any valid key.
  if (resource === "activity-energy" && param === "calculate" && method === "POST") {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  if (isFentonCompute) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  if (isFentonChart) {
    return { auth: "key", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
  }
  if (isFentonReferences) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  // FHIR facade — same public/cheap-computation tier as the classify
  // endpoints it wraps (no new backend cost, just a reshape).
  if (isFhirMetadata) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }
  if (isFhirEvaluateGrowth || isFhirNcpOperation || isFhirNcpCodeSystem || isFhirQuestionnaire || isFhirAudit) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Photo scan costs a Groq vision call per request — public but capped
  // harder than the manual submit form to control cost/abuse.
  if (isPackagedScan) {
    return { auth: "key", rate: { limit: 5, windowSeconds: 60, scope: "ip" } };
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
    return { auth: "key", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // RAG ingest writes to the knowledge base AND costs a Cohere call — admin only.
  if (isRagIngest) {
    return { auth: "admin", rate: { limit: 300, windowSeconds: 60, scope: "admin" } };
  }

  // Automated ingestion (upload/enqueue/job status) — admin only. Upload
  // stores a file and queues Cohere embedding work, so cap it tightly.
  if (isRagUpload) {
    return { auth: "admin", rate: { limit: 20, windowSeconds: 60, scope: "admin" } };
  }
  // Supabase storage trigger -> auto-ingest. Authenticated inside the handler
  // by the x-webhook-secret header (the admin key never lives in the database).
  if (isRagWebhook) {
    return { auth: "secret", rate: { limit: 60, windowSeconds: 60, scope: "ip" } };
  }
  if (isRagJobs) {
    return { auth: "admin", rate: { limit: 60, windowSeconds: 60, scope: "admin" } };
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
    return { auth: "key", rate: { limit: 15, windowSeconds: 60, scope: "ip" } };
  }

  // Memory write/recall each cost a Cohere embed call — public (the Oasis
  // client calls these directly during a chat, no admin key available
  // there) but capped like RAG retrieve/ingest.
  if (isMemoryWrite) {
    return { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }
  if (isMemoryRecall) {
    return { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
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
    return { auth: "key", rate: { limit: 15, windowSeconds: 60, scope: "ip" } };
  }

  // Ingredient text parsing — costs a Groq call per request (same cost
  // class as recipes/meals above), no persistence.
  if (isIngredientsParse) {
    return { auth: "key", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // DRI lookup/compare — pure in-memory computation, no DB or LLM call at
  // all, so it gets the generous plain-read allowance even for the POST
  // /dri/compare endpoint.
  if (isDri) {
    return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
  }

  // Drug-interaction keyword search — same cost class as the exchange/renal
  // keyword scans /rag/ask already runs internally (a full-table scan
  // capped by scan_limit), so it gets its own moderate cap rather than the
  // generous plain-read default.
  if (isDrugInteractionsSearch) {
    return { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // Food substitutes — fans out one ilike query per keyword in the matched
  // substitution group (multiKeywordFoodSearch), same cost class as the
  // scans above.
  if (isFoodSubstitutes) {
    return { auth: "key", rate: { limit: 30, windowSeconds: 60, scope: "ip" } };
  }

  // Nutrient comparison — resolves 2-6 foods per request, each potentially
  // falling back to the external lookup cascade, plus a small reference-
  // table read. Same cost class as substitutes.
  if (isFoodsCompare) {
    return { auth: "key", rate: { limit: 20, windowSeconds: 60, scope: "ip" } };
  }

  // All other writes (foods/exchange/renal/formulas/drug-interactions/packaged CRUD): admin only.
  if (isWrite) {
    return { auth: "admin", rate: { limit: 60, windowSeconds: 60, scope: "admin" } };
  }

  // Plain reads: public, generous but bounded.
  return { auth: "key", rate: { limit: 100, windowSeconds: 60, scope: "ip" } };
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
    async select(table, { filters = {}, limit = 50, offset = 0, order, select } = {}) {
      const url = buildUrl(table, { filters, order, select });
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
async function paginatedList(db, table, url, { filters = {}, order, enrichRow, select } = {}) {
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
      select,
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
  const { ok, status, body, total } = await db.select(table, { filters, limit, offset, order, select });
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
  const res = await trackedFetch(env, "cohere", "https://api.cohere.com/v1/embed", {
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
  let food = local.ok ? pickBestFoodMatch(local.body, foodName, { implied: await resolveImpliedForm(env, foodName) }) : null;
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

// ─── NUTRIENT COMPARISON (GET /foods/compare) ──────────────────────────────
//
// "Compare nsima vs rice vs potatoes" — resolves 2-6 foods the same way
// /foods/substitutes does (local ilike + pickBestFoodMatch, falling back to
// the external lookup cascade), then lines them up side by side across
// energy/macros/fiber/full micronutrient panel plus, where data exists,
// published glycaemic index/load figures from `glycaemic_index_data`.
//
// GI/GL is NEVER estimated or guessed here — CNR has no way to measure it
// and un-sourced numbers would be actively dangerous in a clinical tool.
// A food only gets a `glycaemic` block if a matching row exists in
// glycaemic_index_data (see matchGlycaemicIndexRows below); otherwise it
// gets `glycaemic: null` plus a fiber/carb-ratio *qualitative* note that is
// explicitly labelled as a heuristic, never presented as a GI value.

const COMPARE_MACRO_FIELDS = ["kcal", "energy_kcal", "protein_g", "carbs_g", "fiber_g", "fat_g"];
const COMPARE_MICRONUTRIENT_FIELDS = [
  "vita_rae_mcg", "vitc_mg", "vitd_mcg", "vitb12_mcg", "folate_mcg",
  "calcium_mg", "iron_mg", "zinc_mg", "magnesium_mg", "potassium_mg",
  "sodium_mg", "iodine_mcg",
];
const COMPARE_NUTRIENT_LABELS = {
  kcal: "Energy (kcal)", energy_kcal: "Energy (kcal)", protein_g: "Protein (g)",
  carbs_g: "Carbohydrate (g)", fiber_g: "Fiber (g)", fat_g: "Fat (g)",
  vita_rae_mcg: "Vitamin A (µg RAE)", vitc_mg: "Vitamin C (mg)", vitd_mcg: "Vitamin D (µg)",
  vitb12_mcg: "Vitamin B12 (µg)", folate_mcg: "Folate (µg)", calcium_mg: "Calcium (mg)",
  iron_mg: "Iron (mg)", zinc_mg: "Zinc (mg)", magnesium_mg: "Magnesium (mg)",
  potassium_mg: "Potassium (mg)", sodium_mg: "Sodium (mg)", iodine_mcg: "Iodine (µg)",
};

/**
 * Matches a resolved food's name against every glycaemic_index_data row's
 * match_keywords (simple substring test, same spirit as classifyCategory).
 * A food can legitimately match several rows (e.g. "nsima" matches all
 * three maize-porridge processing variants) — that's returned as-is rather
 * than collapsed to one number, since which processing method applies is
 * exactly the kind of thing CNR can't know from a food name alone.
 */
function matchGlycaemicIndexRows(giRows, foodName) {
  const name = (foodName || "").toLowerCase();
  if (!name) return [];
  return giRows.filter((row) =>
    (row.match_keywords || []).some((kw) => kw && name.includes(String(kw).toLowerCase()))
  );
}

/**
 * Qualitative, non-numeric glycaemic note for a food with no matching
 * glycaemic_index_data row. Deliberately mirrors the wording style of
 * evaluateDiabetes's fiber/carb heuristic (see CONDITION_EVALUATORS above)
 * but is clearly scoped as a heuristic, not a GI/GL substitute.
 */
function heuristicGlycaemicNote(carbs, fiber) {
  if (carbs == null) return "No GI/GL data on file, and carbohydrate content is unknown, so no glycaemic comment can be made.";
  if (carbs === 0) return "No GI/GL data on file, but this food carries no carbohydrate per 100g, so glycaemic impact is negligible.";
  const base = "No published GI/GL data on file for this food (see /glycaemic-index for what is covered).";
  if (fiber == null) return `${base} Fiber content is also unknown, so even a fiber-based heuristic isn't possible.`;
  const ratio = fiber / carbs;
  const heuristic =
    ratio < 0.1
      ? `Fiber is low relative to carbohydrate (${roundServingVal(fiber)}g fiber / ${roundServingVal(carbs)}g carb per 100g) — foods like this tend toward a faster glycaemic response, but this is a general heuristic, not a measured GI.`
      : `Fiber is reasonable relative to carbohydrate (${roundServingVal(fiber)}g fiber / ${roundServingVal(carbs)}g carb per 100g), which tends to blunt glycaemic response — again, a heuristic, not a measured GI.`;
  return `${base} ${heuristic}`;
}

/**
 * GET /foods/compare?foods=nsima,rice,potatoes
 * Resolves each comma-separated name (2-6 foods) the same way
 * /foods/substitutes resolves a single one, then returns:
 *  - foods[]: per-food per-100g energy/protein/carbs/fiber/fat/full
 *    micronutrient panel, plus a `glycaemic` block (measured, sourced
 *    GI/GL entries if any exist in glycaemic_index_data) or `null` with a
 *    clearly-labelled fiber/carb heuristic note instead.
 *  - nutrient_comparison: the same fields pivoted per-nutrient across all
 *    resolved foods, with the highest/lowest food flagged for each —
 *    convenient for "which has more X" without the caller re-deriving it.
 * Purely computational plus one small reference-table read — no writes.
 */
async function handleFoodsCompare(request, url, db, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const rawList = url.searchParams.get("foods") || url.searchParams.get("food_names") || "";
  const names = rawList.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length < 2) return err("'foods' query param is required — a comma-separated list of 2-6 food names, e.g. ?foods=nsima,rice,potatoes");
  if (names.length > 6) return err("Maximum 6 foods per comparison");

  const giResult = await db.select("glycaemic_index_data", { limit: 200 });
  const giRows = giResult.ok ? giResult.body : [];

  const resolved = [];
  const unresolved = [];

  for (const requestedName of names) {
    const local = await db.select("foods", {
      filters: { food_name: `ilike.*${escapeLikePattern(requestedName)}*` },
      limit: 25,
    });
    let food = local.ok ? pickBestFoodMatch(local.body, requestedName, { implied: await resolveImpliedForm(env, requestedName) }) : null;
    let matchedSource = food ? "local" : null;
    if (!food) {
      const cascade = await lookupFoodCascade(db, { query: requestedName }, env);
      if (cascade?.food) {
        food = cascade.food;
        matchedSource = cascade.source;
      }
    }
    if (!food) {
      unresolved.push(requestedName);
      continue;
    }

    const foodName = food.food_name || food.product_name || requestedName;
    const per100g = {};
    for (const field of [...COMPARE_MACRO_FIELDS, ...COMPARE_MICRONUTRIENT_FIELDS]) {
      per100g[field] = food[field] != null && food[field] !== "" ? roundServingVal(Number(food[field])) : null;
    }
    // Fold kcal/energy_kcal into one 'energy_kcal' figure for display so
    // local (kcal) and external (energy_kcal) sourced foods compare cleanly.
    per100g.energy_kcal = per100g.energy_kcal ?? per100g.kcal ?? null;
    delete per100g.kcal;

    const giMatches = matchGlycaemicIndexRows(giRows, foodName);
    const glycaemic = giMatches.length
      ? {
          entries: giMatches.map((m) => ({
            matched_as: m.food_name,
            gi_value: m.gi_value ?? null,
            gi_range: m.gi_low != null || m.gi_high != null ? { low: m.gi_low ?? null, high: m.gi_high ?? null } : null,
            gi_category: m.gi_category ?? null,
            gl_value: m.gl_value ?? null,
            reference_carb_g: m.reference_carb_g ?? null,
            population: m.population ?? null,
            method: m.method ?? null,
            source: m.source,
            notes: m.notes ?? null,
          })),
        }
      : null;

    resolved.push({
      requested_as: requestedName,
      food_name: foodName,
      matched_source: matchedSource,
      category: classifyCategory(foodName),
      per_100g: per100g,
      glycaemic,
      glycaemic_note: glycaemic
        ? "Measured GI/GL from published sources — see entries[].source. Multiple entries mean multiple processing methods/studies exist; pick the one that matches how the food is actually prepared."
        : heuristicGlycaemicNote(per100g.carbs_g, per100g.fiber_g),
    });
  }

  if (resolved.length < 2) {
    return err(
      `Could not resolve enough foods to compare (resolved: ${resolved.map((f) => f.food_name).join(", ") || "none"}; unresolved: ${unresolved.join(", ") || "none"}) — need at least 2`
    );
  }

  const nutrientComparison = {};
  for (const field of ["energy_kcal", "protein_g", "carbs_g", "fiber_g", "fat_g", ...COMPARE_MICRONUTRIENT_FIELDS]) {
    const values = {};
    for (const f of resolved) values[f.food_name] = f.per_100g[field] ?? null;
    const known = Object.entries(values).filter(([, v]) => v != null);
    nutrientComparison[field] = {
      label: COMPARE_NUTRIENT_LABELS[field] || field,
      values,
      highest: known.length ? known.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null,
      lowest: known.length ? known.reduce((a, b) => (b[1] < a[1] ? b : a))[0] : null,
    };
  }

  return success({
    foods: resolved,
    nutrient_comparison: nutrientComparison,
    ...(unresolved.length ? { unresolved } : {}),
    note: "Values are per 100g (Malawi FCT convention where locally sourced; per 100g/100ml as normalized for external-lookup results otherwise). Glycaemic figures are only shown where a published, sourced value exists in glycaemic_index_data — see GET /glycaemic-index to browse what's covered and POST /glycaemic-index/bulk (admin) to add more.",
  });
}

// ─── GLYCAEMIC INDEX / LOAD REFERENCE (/glycaemic-index) ───────────────────
//
// Standalone reference table (see sql/004_add_glycaemic_index.sql) — GI/GL
// is measured per specific preparation/variety and rarely lines up 1:1 with
// a `foods` row, so this is matched by keyword at query time (see
// matchGlycaemicIndexRows) rather than joined by foreign key. Every row
// must cite a real source; nothing here is estimated. Same CRUD shape as
// /exchange, /renal, /formulas — plain reads public, writes admin-only.
async function handleGlycaemicIndex(request, url, db, id) {
  const method = request.method;

  if (method === "GET") {
    if (id) {
      const { ok, status, body } = await db.selectOne("glycaemic_index_data", id);
      if (status === 404) return notFound("Glycaemic index entry");
      if (!ok) return err(body?.message || "Query failed", status);
      return success(body);
    }
    const search = url.searchParams.get("search") || "";
    const filters = {};
    if (search) filters["food_name"] = `ilike.*${escapeLikePattern(search)}*`;
    return await paginatedList(db, "glycaemic_index_data", url, { filters, order: "food_name.asc" });
  }

  if (method === "POST") {
    const payload = await parseBody(request);
    if (!payload || !payload.food_name) return err("'food_name' is required");
    if (!payload.match_keywords || !Array.isArray(payload.match_keywords) || !payload.match_keywords.length) {
      return err("'match_keywords' is required — a non-empty array of lowercase keywords to match this entry against food names");
    }
    if (!payload.source) return err("'source' (citation) is required — GI/GL values are never accepted without a traceable source");
    const { ok, status, body } = await db.insert("glycaemic_index_data", payload);
    if (!ok) return err(body?.message || "Insert failed", status);
    return success(body, { message: "Glycaemic index entry created" });
  }

  if (!id) return err("ID required for this method");

  if (method === "PUT" || method === "PATCH") {
    const payload = await parseBody(request);
    if (!payload) return err("Request body required");
    const { ok, status, body } = await db.update("glycaemic_index_data", id, payload, method);
    if (!ok) return err(body?.message || "Update failed", status);
    return success(body, { message: "Glycaemic index entry updated" });
  }

  if (method === "DELETE") {
    const { ok, status } = await db.remove("glycaemic_index_data", id);
    if (!ok) return err("Delete failed", status);
    return success(null, { message: `Glycaemic index entry ${id} deleted` });
  }

  return err("Method not allowed", 405);
}

// ─── BMI-FOR-AGE (/bmi-for-age) ────────────────────────────────────────────
//
// WHO 2007 BMI-for-age reference for 5y 1m to 19y 0m (see
// sql/012_add_bmi_for_age.sql and src/bmiForAge.js). Public reads; the table is
// filled once via POST /bmi-for-age/bulk (admin). Screening aid, not a diagnosis.
async function handleBmiForAge(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /bmi-for-age/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseBmiForAgeQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("bmi_for_age", {
      filters: { sex: `eq.${parsed.sex}`, age_months: `eq.${parsed.ageMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("BMI-for-age reference row (has sql/012 been run and the table seeded?)");

    const result = classifyBmiForAge(row, parsed.bmi);
    return success(
      {
        sex: parsed.sex,
        age_months: parsed.ageMonths,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. Cut-offs: severe thinness < -3SD, thinness < -2SD, normal -2SD to +1SD, overweight > +1SD, obesity > +2SD.",
      },
      { message: "BMI-for-age classification" }
    );
  }

  if (param) return notFound("BMI-for-age route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = ["girls", "girl", "female", "f"].includes(sex.toLowerCase()) ? "girls"
      : ["boys", "boy", "male", "m"].includes(sex.toLowerCase()) ? "boys" : null;
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const age = url.searchParams.get("age_months");
  if (age) {
    if (!Number.isInteger(Number(age))) return err("'age_months' must be a whole number");
    filters.age_months = `eq.${Number(age)}`;
  }
  return await paginatedList(db, "bmi_for_age", url, { filters, order: "age_months.asc" });
}

// ─── HEAD CIRCUMFERENCE VELOCITY (/hc-velocity) ───────────────────────────
//
// WHO 6-month head circumference increment standards, birth to 24 months (see
// sql/018_add_who_hc_velocity.sql and src/hcVelocity.js). Public reads; the
// table is filled once via POST /hc-velocity/bulk (admin). Screening aid, not
// a diagnosis. This is velocity (how fast the head grew), not HC-for-age.
async function handleHcVelocity(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /hc-velocity/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseHcVelocityQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_hc_velocity", {
      filters: { sex: `eq.${parsed.sex}`, interval_start_months: `eq.${parsed.startMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("HC velocity reference row (has sql/018 been run and the table seeded?)");

    const result = classifyHcVelocity(row, parsed.increment);
    return success(
      {
        sex: parsed.sex,
        interval: `${row.interval_start_months}-${row.interval_end_months} months`,
        interval_start_months: row.interval_start_months,
        interval_end_months: row.interval_end_months,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. This is the 6-month head circumference INCREMENT, not head circumference for age. Bands: very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. z_approx is linearly interpolated between the printed SD cut-offs (null beyond -3 or +3). Interpret with head circumference for age, clinical context and repeat measurement.",
      },
      { message: "Head circumference velocity classification" }
    );
  }

  if (param) return notFound("HC velocity route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const start = url.searchParams.get("start_age_months");
  if (start) {
    if (!Number.isInteger(Number(start))) return err("'start_age_months' must be a whole number");
    filters.interval_start_months = `eq.${Number(start)}`;
  }
  return await paginatedList(db, "who_hc_velocity", url, { filters, order: "interval_start_months.asc" });
}

// ─── LENGTH VELOCITY (/length-velocity) ───────────────────────────────────
//
// WHO 6-month length increment standards, birth to 24 months (see
// sql/019_add_who_length_velocity.sql and src/lengthVelocity.js). Public
// reads; the table is filled once via POST /length-velocity/bulk (admin).
// Screening aid, not a diagnosis. This is velocity (how fast the child grew),
// not length-for-age.
async function handleLengthVelocity(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /length-velocity/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseLengthVelocityQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_length_velocity", {
      filters: { sex: `eq.${parsed.sex}`, interval_start_months: `eq.${parsed.startMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("Length velocity reference row (has sql/019 been run and the table seeded?)");

    const result = classifyLengthVelocity(row, parsed.increment);
    return success(
      {
        sex: parsed.sex,
        interval: `${row.interval_start_months}-${row.interval_end_months} months`,
        interval_start_months: row.interval_start_months,
        interval_end_months: row.interval_end_months,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. This is the 6-month length INCREMENT, not length for age. Bands: very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. z_approx is linearly interpolated between the printed SD cut-offs (null beyond -3 or +3). Interpret with length-for-age and weight-for-length, clinical context and repeat measurement. Use recumbent length measured the same way at both visits.",
      },
      { message: "Length velocity classification" }
    );
  }

  if (param) return notFound("Length velocity route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const start = url.searchParams.get("start_age_months");
  if (start) {
    if (!Number.isInteger(Number(start))) return err("'start_age_months' must be a whole number");
    filters.interval_start_months = `eq.${Number(start)}`;
  }
  return await paginatedList(db, "who_length_velocity", url, { filters, order: "interval_start_months.asc" });
}

// ─── WEIGHT VELOCITY (/weight-velocity) ───────────────────────────────────
//
// WHO 6-month weight increment standards (grams), birth to 24 months (see
// sql/020_add_who_weight_velocity.sql and src/weightVelocity.js). Public
// reads; the table is filled once via POST /weight-velocity/bulk (admin).
// Besides the band it returns an exact LMS z-score and percentile. Screening
// aid, not a diagnosis. This is velocity, not weight-for-age.
async function handleWeightVelocity(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /weight-velocity/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseWeightVelocityQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_weight_velocity", {
      filters: { sex: `eq.${parsed.sex}`, interval_start_months: `eq.${parsed.startMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("Weight velocity reference row (has sql/020 been run and the table seeded?)");

    const result = classifyWeightVelocity(row, parsed.incrementG);
    return success(
      {
        sex: parsed.sex,
        interval: `${row.interval_start_months}-${row.interval_end_months} months`,
        interval_start_months: row.interval_start_months,
        interval_end_months: row.interval_end_months,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. This is the 6-month weight INCREMENT in grams, not weight for age. Bands: very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. z_score and percentile come from the WHO L, M, S and Delta parameters (null if the shifted increment is not positive). Weight gain varies with illness, feeding and scale error: interpret with weight-for-age, weight-for-length, clinical context and repeat weighing on the same scale.",
      },
      { message: "Weight velocity classification" }
    );
  }

  if (param) return notFound("Weight velocity route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const start = url.searchParams.get("start_age_months");
  if (start) {
    if (!Number.isInteger(Number(start))) return err("'start_age_months' must be a whole number");
    filters.interval_start_months = `eq.${Number(start)}`;
  }
  return await paginatedList(db, "who_weight_velocity", url, { filters, order: "interval_start_months.asc" });
}

// ─── MUAC-FOR-AGE (/muac-for-age) ─────────────────────────────────────────
//
// WHO arm circumference-for-age standards (cm), 3 to 60 months (see
// sql/021_add_who_muac_for_age.sql and src/muacForAge.js). Public reads; the
// table is filled via POST /muac-for-age/bulk (admin). Returns the band plus an
// exact LMS z-score and percentile. Screening aid, not a diagnosis. This is
// MUAC for age, not the fixed-cut-off MUAC tape (115 / 125 mm).
async function handleMuacForAge(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /muac-for-age/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseMuacForAgeQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_muac_for_age", {
      filters: { sex: `eq.${parsed.sex}`, age_months: `eq.${parsed.ageMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("MUAC-for-age reference row (has sql/021 been run and the table seeded for this age?)");

    const result = classifyMuacForAge(row, parsed.muacCm);
    return success(
      {
        sex: parsed.sex,
        age_months: row.age_months,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. This is arm circumference (MUAC) for AGE as a WHO z-score, not the fixed-cut-off MUAC tape used in community screening (115 mm / 125 mm for 6-59 months). Bands: very low < -3SD, low < -2SD, within expected range -2SD to +2SD, high > +2SD, very high > +3SD. z_score and percentile come from the WHO L, M and S values (beyond +/-3SD the z-score is extended linearly, as in the WHO tables). Interpret with weight-for-height/length, clinical signs and repeat measurement.",
      },
      { message: "MUAC-for-age classification" }
    );
  }

  if (param) return notFound("MUAC-for-age route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const age = url.searchParams.get("age_months");
  if (age) {
    if (!Number.isInteger(Number(age))) return err("'age_months' must be a whole number");
    filters.age_months = `eq.${Number(age)}`;
  }
  return await paginatedList(db, "who_muac_for_age", url, { filters, order: "age_months.asc" });
}

// ─── MUAC fixed cut-offs (/muac/classify) ─────────────────────────────────
//
// Severe / moderate / normal by age group, 6 months to adult (see
// src/muacFixed.js). Pure calculation: no database table, no seeding. Screening
// aid, not a diagnosis. Separate from the z-score route /muac-for-age.
async function handleMuacFixed(request, url, param) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  if (param !== "classify") return notFound("MUAC route (use /muac/classify)");
  const parsed = parseMuacFixedQuery(url.searchParams);
  if (parsed.error) return err(parsed.error);
  const result = classifyMuacFixed(parsed.ageMonths, parsed.muacCm, parsed.scheme);
  return success(
    {
      age_months: parsed.ageMonths,
      ...result,
      source: parsed.scheme === "cmam"
        ? "WHO/UNICEF community screening MUAC cut-offs for 6-59 months (115 mm / 125 mm), as used by CMAM programmes"
        : "WHO, Guideline for Integrated Approach to the National Care of HIV Infected Children (6 months - 14 years), 2008, as reproduced in the FANTA Ethiopia MUAC classification chart",
      note: parsed.scheme === "cmam"
        ? "Screening aid only, not a diagnosis. scheme=cmam: severe below 11.5 cm, moderate 11.5 to below 12.5 cm, normal 12.5 cm and above (6-59 months). Confirm with your national CMAM guideline and clinical assessment (oedema, weight-for-height/length)."
        : "Screening aid only, not a diagnosis. Fixed MUAC cut-offs by age group: severe below the first value, moderate from there up to and including the second, normal above it. Adults means 15 years and over (both sexes; pregnancy is not distinguished). For 6-59 months these cut-offs differ from the WHO/UNICEF community screening cut-offs (115 mm severe, 125 mm moderate) that most CMAM programmes use: check which one your programme follows (add &scheme=cmam for the 115/125 mm cut-offs). For MUAC as a WHO z-score for age (3-60 months) use /muac-for-age/classify.",
    },
    { message: "MUAC classification" }
  );
}

// ─── LENGTH/HEIGHT-FOR-AGE (/length-height-for-age) ───────────────────────
//
// WHO length/height-for-age (cm), birth to 19 years: 2006 standards to 60 months, 2007 reference 61-228 months (see
// sql/022_add_who_length_height_for_age.sql and src/lengthHeightForAge.js).
// Public reads; the table is filled once via POST /length-height-for-age/bulk
// (admin). Returns the stunting band plus an exact z-score and percentile.
// Length (lying) under 24 months, height (standing) from 24; a mismatched
// measuring position is converted by 0.7 cm and reported. Screening aid only.
async function handleLengthHeightForAge(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /length-height-for-age/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseLhfaQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_length_height_for_age", {
      filters: { sex: `eq.${parsed.sex}`, age_months: `eq.${parsed.ageMonths}` },
      limit: 2,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const picked = pickRowAndValue(Array.isArray(body) ? body : [], parsed.measured, parsed.valueCm);
    if (!picked) return notFound("Length/height-for-age reference row (has sql/022 been run and the table seeded?)");

    const result = classifyLhfa(picked.row, picked.valueCm);
    return success(
      {
        sex: parsed.sex,
        age_months: picked.row.age_months,
        measured: parsed.measured,
        entered_cm: parsed.valueCm,
        ...(picked.adjustment ? { position_adjustment: picked.adjustment } : {}),
        ...result,
        source: picked.row.source,
        note: "Screening aid only, not a diagnosis. Length/height-for-age (stunting) as a WHO z-score: severely stunted < -3SD, stunted < -2SD, normal -2SD to +2SD, tall > +2SD, very tall > +3SD (tallness is rarely a problem). Length (lying) is used under 24 months and height (standing) from 24 months; if the child was measured the other way, 0.7 cm is added or subtracted and reported in position_adjustment. implausible = true when |z| > 6, which usually means a measuring or recording error. Interpret with weight-for-height/length and clinical context; confirm age and repeat the measurement.",
      },
      { message: "Length/height-for-age classification" }
    );
  }

  if (param) return notFound("Length/height-for-age route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const age = url.searchParams.get("age_months");
  if (age) {
    if (!Number.isInteger(Number(age))) return err("'age_months' must be a whole number");
    filters.age_months = `eq.${Number(age)}`;
  }
  return await paginatedList(db, "who_length_height_for_age", url, { filters, order: "age_months.asc" });
}

// ─── WEIGHT-FOR-AGE (/weight-for-age) ─────────────────────────────────────
//
// WHO weight-for-age (kg), birth to 10 years: 2006 standards to 60 months,
// 2007 reference 61-120 months (see sql/024_add_who_weight_for_age.sql and
// src/weightForAge.js). Public reads; the table is filled once via
// POST /weight-for-age/bulk (admin). Returns the underweight band plus an
// exact z-score and percentile. Screening aid only; not for diagnosing
// overweight (use weight-for-length/height or BMI-for-age).
async function handleWeightForAge(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /weight-for-age/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseWeightForAgeQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_weight_for_age", {
      filters: { sex: `eq.${parsed.sex}`, age_months: `eq.${parsed.ageMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("Weight-for-age reference row (has sql/024 been run and the table seeded?)");

    const result = classifyWeightForAge(row, parsed.weightKg);
    return success(
      {
        sex: parsed.sex,
        age_months: row.age_months,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. Weight-for-age as a WHO z-score: severely underweight < -3SD, underweight < -2SD, normal -2SD to +2SD, high weight-for-age > +2SD, very high > +3SD. Weight-for-age is not used to diagnose overweight or obesity: a high value means check weight-for-length/height (under 5 years) or BMI-for-age (5 years and over). It also cannot tell wasting from stunting, so interpret with length/height-for-age and weight-for-length/height. WHO publishes weight-for-age only to 10 years. Beyond +/-3SD the z-score is extended linearly as in the WHO tables; implausible = true when z < -6 or z > +5, which usually means a measuring or recording error. Confirm the age and repeat the weighing.",
      },
      { message: "Weight-for-age classification" }
    );
  }

  if (param) return notFound("Weight-for-age route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const age = url.searchParams.get("age_months");
  if (age) {
    if (!Number.isInteger(Number(age))) return err("'age_months' must be a whole number");
    filters.age_months = `eq.${Number(age)}`;
  }
  return await paginatedList(db, "who_weight_for_age", url, { filters, order: "age_months.asc" });
}

// ─── WEIGHT-FOR-LENGTH/HEIGHT (/weight-for-length-height) ─────────────────
//
// WHO weight-for-length (birth to 2 years, lying) and weight-for-height
// (2 to 5 years, standing), looked up by length/height in 0.1 cm steps (see
// sql/025_add_who_weight_for_length_height.sql and src/weightForLengthHeight.js).
// The age picks the table; a mismatched measuring position is converted by
// 0.7 cm and reported. Public reads; the table is filled via
// POST /weight-for-length-height/bulk (admin, five seed parts). Returns the
// wasting/overweight band plus an exact z-score and percentile. Screening aid only.
async function handleWeightForLengthHeight(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /weight-for-length-height/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseWflhQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const lookup = resolveLookup(parsed.ageMonths, parsed.measured, parsed.lengthHeightCm);
    if (lookup.lookupCm < lookup.range.min || lookup.lookupCm > lookup.range.max) {
      return err(
        `Length/height ${lookup.lookupCm} cm is outside the WHO ${lookup.table === "lying" ? "weight-for-length" : "weight-for-height"} table (${lookup.range.min} to ${lookup.range.max} cm) for this age. Check the measurement and the age.`,
        422
      );
    }

    const { ok, status, body } = await db.select("who_weight_for_length_height", {
      filters: {
        sex: `eq.${parsed.sex}`,
        measured: `eq.${lookup.table}`,
        length_height_cm: `eq.${lookup.lookupCm.toFixed(1)}`,
      },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("Weight-for-length/height reference row (has sql/025 been run and all five seed parts loaded?)");

    const result = classifyWflh(row, parsed.weightKg);
    return success(
      {
        sex: parsed.sex,
        age_months: parsed.ageMonths,
        measured: parsed.measured,
        entered_length_height_cm: parsed.lengthHeightCm,
        lookup_length_height_cm: lookup.lookupCm,
        ...(lookup.adjustment ? { position_adjustment: lookup.adjustment } : {}),
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. Weight-for-length/height as a WHO z-score: severe wasting < -3SD, moderate wasting < -2SD, normal -2SD to +1SD, possible risk of overweight > +1SD, overweight > +2SD, obesity > +3SD. The age picks the table: weight-for-length (lying) under 24 months, weight-for-height (standing) from 24 months; if the child was measured the other way 0.7 cm is added or subtracted and reported in position_adjustment. The length/height is rounded to the nearest 0.1 cm to find the table row. Beyond +/-3SD the z-score is extended linearly as in the WHO tables; implausible = true when |z| > 5, which usually means a measuring or recording error. Bilateral pitting oedema means severe acute malnutrition whatever the z-score; combine with MUAC and clinical assessment, and confirm age, length/height and weight.",
      },
      { message: "Weight-for-length/height classification" }
    );
  }

  if (param) return notFound("Weight-for-length/height route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const measured = url.searchParams.get("measured");
  if (measured) {
    if (!["lying", "standing"].includes(measured)) return err("'measured' must be lying or standing");
    filters.measured = `eq.${measured}`;
  }
  const lh = url.searchParams.get("length_height_cm");
  if (lh) {
    if (!Number.isFinite(Number(lh))) return err("'length_height_cm' must be a number");
    filters.length_height_cm = `eq.${Number(lh).toFixed(1)}`;
  }
  return await paginatedList(db, "who_weight_for_length_height", url, { filters, order: "length_height_cm.asc" });
}

// ─── BMI-FOR-AGE UNDER 5 (/bmi-for-age-under-5) ───────────────────────────
//
// WHO BMI-for-age (kg/m2), birth to 5 years (see
// sql/026_add_who_bmi_for_age_under_5.sql and src/bmiForAgeUnder5.js). The
// 5-19 year table is /bmi-for-age. Age picks the table (lying under 24 months,
// standing from 24); weight + length/height is converted to BMI after any
// 0.7 cm position adjustment, or a BMI can be passed directly. Public reads;
// the table is filled once via POST /bmi-for-age-under-5/bulk (admin).
// Screening aid only.
async function handleBmiForAgeUnder5(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /bmi-for-age-under-5/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseBmiUnder5Query(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const resolved = resolveBmi(parsed);
    if (!Number.isFinite(resolved.bmi) || resolved.bmi < 5 || resolved.bmi > 40) {
      return err("Computed BMI is not plausible (check the weight and the length/height units)");
    }

    const { ok, status, body } = await db.select("who_bmi_for_age_under_5", {
      filters: { sex: `eq.${parsed.sex}`, age_months: `eq.${parsed.ageMonths}`, measured: `eq.${resolved.table}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("BMI-for-age (under 5) reference row (has sql/026 been run and the table seeded?)");

    const result = classifyBmiUnder5(row, resolved.bmi);
    return success(
      {
        sex: parsed.sex,
        age_months: parsed.ageMonths,
        bmi_computed_from_weight_and_length_height: resolved.computed,
        ...(resolved.computed
          ? { weight_kg: parsed.weightKg, entered_length_height_cm: parsed.lengthHeightCm, used_length_height_cm: resolved.usedLengthHeightCm }
          : {}),
        ...(resolved.adjustment ? { position_adjustment: resolved.adjustment } : {}),
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. BMI-for-age (under 5) as a WHO z-score: severe wasting < -3SD, moderate wasting < -2SD, normal -2SD to +1SD, possible risk of overweight > +1SD, overweight > +2SD, obesity > +3SD. BMI = weight (kg) / length-or-height (m) squared; the age picks the table (lying under 24 months, standing from 24), and a child measured the other way has 0.7 cm added or subtracted before BMI is computed. A BMI passed directly is used as is. For 5 to 19 years use /bmi-for-age/classify; for acute malnutrition screening also use /weight-for-length-height, MUAC and clinical signs (bilateral pitting oedema means severe acute malnutrition whatever the z-score). Beyond +/-3SD the z-score is extended linearly as in the WHO tables; implausible = true when |z| > 5, which usually means a measuring or recording error.",
      },
      { message: "BMI-for-age (under 5) classification" }
    );
  }

  if (param) return notFound("BMI-for-age (under 5) route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const age = url.searchParams.get("age_months");
  if (age) {
    if (!Number.isInteger(Number(age))) return err("'age_months' must be a whole number");
    filters.age_months = `eq.${Number(age)}`;
  }
  return await paginatedList(db, "who_bmi_for_age_under_5", url, { filters, order: "age_months.asc" });
}

// ─── HEAD CIRCUMFERENCE-FOR-AGE (/hc-for-age) ─────────────────────────────
//
// WHO head circumference-for-age (cm), birth to 5 years (see
// sql/027_add_who_hc_for_age.sql and src/hcForAge.js). The 6-month increment
// is /hc-velocity. Public reads; the table is filled once via
// POST /hc-for-age/bulk (admin). Returns the microcephaly/macrocephaly band
// plus an exact z-score and percentile. Screening aid only.
async function handleHcForAge(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /hc-for-age/bulk (admin).", 405);
  }

  if (param === "classify") {
    const parsed = parseHcForAgeQuery(url.searchParams);
    if (parsed.error) return err(parsed.error);

    const { ok, status, body } = await db.select("who_hc_for_age", {
      filters: { sex: `eq.${parsed.sex}`, age_months: `eq.${parsed.ageMonths}` },
      limit: 1,
    });
    if (!ok) return err(body?.message || "Query failed", status);
    const row = Array.isArray(body) ? body[0] : null;
    if (!row) return notFound("Head circumference-for-age reference row (has sql/027 been run and the table seeded?)");

    const result = classifyHcForAge(row, parsed.hcCm);
    return success(
      {
        sex: parsed.sex,
        age_months: row.age_months,
        ...result,
        source: row.source,
        note: "Screening aid only, not a diagnosis. Head circumference-for-age as a WHO z-score: severe microcephaly < -3SD, microcephaly < -2SD, normal -2SD to +2SD, macrocephaly > +2SD, severe macrocephaly > +3SD. A single value outside the range is a reason to examine the child and track the trend (also consider parental head sizes, prematurity and the measuring technique), not a diagnosis. implausible = true when |z| > 5, which usually means a measuring or recording error. For growth in the last 6 months use /hc-velocity/classify.",
      },
      { message: "Head circumference-for-age classification" }
    );
  }

  if (param) return notFound("Head circumference-for-age route");

  const filters = {};
  const sex = url.searchParams.get("sex");
  if (sex) {
    const n = normalizeHcSex(sex);
    if (!n) return err("'sex' must be girls or boys");
    filters.sex = `eq.${n}`;
  }
  const age = url.searchParams.get("age_months");
  if (age) {
    if (!Number.isInteger(Number(age))) return err("'age_months' must be a whole number");
    filters.age_months = `eq.${Number(age)}`;
  }
  return await paginatedList(db, "who_hc_for_age", url, { filters, order: "age_months.asc" });
}

// ─── COMBINED GROWTH ASSESSMENT (/growth/assess) ──────────────────────────
//
// One call, every applicable WHO indicator for the measurements given (see
// src/growthAssess.js). It reuses the single-indicator modules, so each result
// is identical to its own endpoint. Public, read-only. Screening aid only.
async function handleGrowth(request, url, db, param) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  if (param !== "assess") return notFound("Growth route (use /growth/assess)");
  const parsed = parseAssessQuery(url.searchParams);
  if (parsed.error) return err(parsed.error);

  const fetchRows = async (table, filters, limit) => {
    const { ok, status, body } = await db.select(table, { filters, limit });
    if (!ok) throw new Error(body?.message || `Query failed (${status})`);
    return Array.isArray(body) ? body : [];
  };
  const result = await assessGrowth(parsed, fetchRows);
  return success(
    {
      sex: parsed.sex,
      age_months: parsed.ageMonths,
      ...result,
      note: "Screening aid only, not a diagnosis. Each indicator is the same calculation as its own endpoint (/length-height-for-age, /weight-for-age, /weight-for-length-height, /bmi-for-age-under-5 or /bmi-for-age, /hc-for-age, /muac-for-age, /muac/classify). Indicators without the needed measurement, or outside their WHO age range, are listed in not_assessed. A bad value in one measurement only errors that indicator. attention lists everything outside the normal range, most serious first (severity: severe, concern, watch). acute_malnutrition_signals combines weight-for-length/height and MUAC but cannot assess oedema. Interpret with the child's history, clinical signs and growth trend, and confirm age and measurements.",
    },
    { message: "Growth assessment" }
  );
}

// Fenton preterm growth chart — classify ONLY. See sql/013_add_fenton_preterm.sql
// and src/fentonPreterm.js for the license condition this exists under: no
// list/dump route, ever. This function intentionally has no bare-GET listing
// branch (unlike handleBmiForAge above) — /classify is the only read path.
// Shared step-lookup used by every Fenton read handler (classify, profile,
// growth, velocity, chart). Returns { ok, row } or { ok: false, errRes }.
async function lookupFentonRow(db, referenceYear, sex, metric, timeDays) {
  const { ok, status, body } = await db.select("fenton_preterm_lms", {
    filters: {
      reference_year: `eq.${referenceYear}`,
      sex: `eq.${sex}`,
      metric: `eq.${metric}`,
      time_days: `lte.${timeDays}`,
    },
    order: "time_days.desc",
    limit: 1,
  });
  if (!ok) return { ok: false, errRes: err(body?.message || "Query failed", status) };
  const row = Array.isArray(body) ? body[0] : null;
  if (!row) {
    return {
      ok: false,
      errRes: notFound(
        "Fenton reference row for this age (has sql/013 been run and the table seeded for this reference_year/metric?)"
      ),
    };
  }
  return { ok: true, row };
}

// Fetches every row for one (reference_year, sex, metric), ordered by age —
// used by the chart renderer, which needs the whole curve to draw a line.
async function lookupFentonRows(db, referenceYear, sex, metric) {
  const { ok, status, body } = await db.select("fenton_preterm_lms", {
    filters: { reference_year: `eq.${referenceYear}`, sex: `eq.${sex}`, metric: `eq.${metric}` },
    order: "time_days.asc",
    limit: 500,
  });
  if (!ok) return { ok: false, errRes: err(body?.message || "Query failed", status) };
  const rows = Array.isArray(body) ? body : [];
  if (rows.length === 0) {
    return { ok: false, errRes: notFound("No seeded rows for this reference_year/sex/metric.") };
  }
  return { ok: true, rows };
}

async function handleFentonPreterm(request, url, db, param) {
  if (request.method !== "GET") {
    return err("Method not allowed. Seed rows with POST /fenton-preterm/bulk (admin).", 405);
  }
  if (param !== "classify") {
    return notFound(
      "Fenton preterm route. Available: GET /fenton-preterm/classify, POST .../profile, POST .../growth, " +
        "POST .../velocity, GET .../chart, GET .../references."
    );
  }

  const parsed = parseFentonQuery(url.searchParams);
  if (parsed.error) return err(parsed.error);

  const looked = await lookupFentonRow(db, parsed.referenceYear, parsed.sex, parsed.metric, parsed.timeDays);
  if (!looked.ok) return looked.errRes;

  const { z, percentile, status } = classifyRow(looked.row, parsed.value, parsed.metric);

  return success(
    {
      sex: parsed.sex,
      metric: parsed.metric,
      reference_year: parsed.referenceYear,
      gest_age_weeks: parsed.gestAgeWeeks,
      day: parsed.day,
      value: parsed.value,
      z,
      percentile,
      status,
      note: SCREENING_NOTE,
    },
    { message: "Fenton preterm growth chart classification" }
  );
}

// POST /fenton-preterm/profile — weight + length + HC at one timepoint.
async function handleFentonProfile(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const parsed = parseProfileBody(body);
  if (parsed.error) return err(parsed.error);

  const result = {};
  for (const metric of Object.keys(parsed.values)) {
    const looked = await lookupFentonRow(db, parsed.referenceYear, parsed.sex, metric, parsed.timeDaysByMetric[metric]);
    if (!looked.ok) return looked.errRes;
    const { z, percentile, status } = classifyRow(looked.row, parsed.values[metric], metric);
    result[metric] = { value: parsed.values[metric], z, percentile, status };
  }

  return success(
    {
      sex: parsed.sex,
      reference_year: parsed.referenceYear,
      gest_age_weeks: parsed.gestAgeWeeks,
      day: parsed.day,
      metrics: result,
      note: SCREENING_NOTE,
    },
    { message: "Fenton preterm growth profile" }
  );
}

// POST /fenton-preterm/growth — a series of same-metric measurements over
// time -> classified trajectory + a descriptive trend summary. Response
// shape is deliberately chart-ready (age + value + z/percentile per point).
async function handleFentonGrowth(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const parsed = parseSeriesBody(body);
  if (parsed.error) return err(parsed.error);

  const points = [];
  for (const m of parsed.measurements) {
    const looked = await lookupFentonRow(db, parsed.referenceYear, parsed.sex, parsed.metric, m.timeDays);
    if (!looked.ok) return looked.errRes;
    const { z, percentile, status } = classifyRow(looked.row, m.value, parsed.metric);
    points.push({ gest_age_weeks: m.gestAgeWeeks, day: m.day, value: m.value, z, percentile, status });
  }

  return success(
    {
      sex: parsed.sex,
      metric: parsed.metric,
      reference_year: parsed.referenceYear,
      points,
      trend: summarizeTrend(points),
      note: SCREENING_NOTE,
    },
    { message: "Fenton preterm growth trajectory" }
  );
}

// POST /fenton-preterm/velocity — growth velocity between consecutive
// measurements of the same metric (2+ points -> N-1 velocities).
async function handleFentonVelocity(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const parsed = parseSeriesBody(body);
  if (parsed.error) return err(parsed.error);
  if (parsed.measurements.length < 2) {
    return err("'measurements' needs at least 2 points to compute a velocity.");
  }

  const intervals = [];
  for (let i = 1; i < parsed.measurements.length; i++) {
    const v = computeVelocity(parsed.metric, parsed.measurements[i - 1], parsed.measurements[i]);
    if (v.error) return err(v.error);
    intervals.push({
      from: { gest_age_weeks: parsed.measurements[i - 1].gestAgeWeeks, day: parsed.measurements[i - 1].day, value: parsed.measurements[i - 1].value },
      to: { gest_age_weeks: parsed.measurements[i].gestAgeWeeks, day: parsed.measurements[i].day, value: parsed.measurements[i].value },
      ...v,
    });
  }

  return success(
    { sex: parsed.sex, metric: parsed.metric, reference_year: parsed.referenceYear, intervals },
    { message: "Fenton preterm growth velocity" }
  );
}

// GET /fenton-preterm/chart?sex=&metric=&reference_year=&points=28w0d:900,30w0d:1200
// Renders an SVG image server-side. The reference curve is computed from
// the LMS table in this request's handler ONLY to draw pixel coordinates —
// it is never returned as JSON. See src/fentonChart.js.
async function handleFentonChart(request, url, db) {
  const sex = normalizeSex(url.searchParams.get("sex"));
  if (!sex) return err("'sex' is required: boys or girls");
  const metric = normalizeMetric(url.searchParams.get("metric"));
  if (!metric) return err("'metric' is required: weight, length, or hc");
  const yearRaw = url.searchParams.get("reference_year");
  const referenceYear = yearRaw ? Number(yearRaw) : 2025;
  if (!FENTON_YEARS.includes(referenceYear)) return err("'reference_year' must be 2013 or 2025 (default 2025)");

  // Optional overlay points: "28w0d:900,30w0d:1200,32w0d:1500" (day optional, defaults 0)
  let points = [];
  const pointsRaw = url.searchParams.get("points");
  if (pointsRaw) {
    for (const chunk of pointsRaw.split(",")) {
      const m = /^([0-9]+(?:\.[0-9]+)?)w(?:([0-6])d)?:([0-9]+(?:\.[0-9]+)?)$/.exec(chunk.trim());
      if (!m) return err(`Invalid 'points' entry "${chunk}". Expected e.g. 28w0d:900 or 28w:900.`);
      points.push({ gestAgeWeeks: Number(m[1]), day: m[2] ? Number(m[2]) : 0, value: Number(m[3]) });
    }
  }

  const looked = await lookupFentonRows(db, referenceYear, sex, metric);
  if (!looked.ok) return looked.errRes;

  const svg = renderFentonChartSVG({ rows: looked.rows, metric, sex, referenceYear, points });
  return new Response(svg, {
    status: 200,
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
}

// ─── FHIR facade (/fhir/*) — growth/anthropometry, Phase 1 ────────────────
//
// Stateless translation layer over the classify endpoints above — see
// src/fhir.js for the full scope note (Fenton preterm + WHO BMI-for-age
// only; no WHO 0-59-month coverage yet; no OpenHIM registration yet).

async function handleFhirMetadata(url, env = {}) {
  return json(buildCapabilityStatement(url.origin));
}

async function handleFhirEvaluateGrowth(request, db, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(operationOutcome("error", "Invalid JSON body."), 400);
  }

  const parsed = parseEvaluateGrowth(body);
  if (parsed.error) return json(parsed.outcome, 400);

  const route = decideGrowthRoute(parsed);
  if (route.error) return json(route.outcome, 422);

  const base = url.origin;

  if (route.route === "fenton") {
    const sex = normalizeSex(parsed.sex);
    const referenceYear = parsed.referenceYear ?? 2025;
    const timeDays = ageInDays(parsed.gestationalAgeWeeks, parsed.gestationalAgeDays);
    const observations = [];

    for (const m of parsed.measurements) {
      if (m.type === "bmi") {
        return json(
          operationOutcome("error", "measurement.type 'bmi' is not valid for a gestational-age (Fenton) evaluation — use weight, length, or hc."),
          400
        );
      }
      const metric = m.type;
      const unit = metric === "weight" ? "g" : "cm";
      const value = metric === "weight" ? toGrams(m.value) : toCm(m.value);
      if (value === null) {
        return json(
          operationOutcome("error", `measurement.value for "${metric}" needs a recognized unit (g/kg for weight, cm/m for length/hc).`),
          400
        );
      }

      const looked = await lookupFentonRow(db, referenceYear, sex, metric, timeDays);
      if (!looked.ok) return looked.errRes;
      const { z, percentile, status } = classifyRow(looked.row, value, metric);

      const obs = buildFentonObservation(
        base,
        { sex, gestAgeWeeks: parsed.gestationalAgeWeeks, day: parsed.gestationalAgeDays, metric, value, unit },
        { z, percentile, status, note: SCREENING_NOTE, reference_year: referenceYear }
      );
      obs.effectiveDateTime = parsed.effectiveDateTime;
      observations.push(obs);
    }

    return json(bundleObservations(observations));
  }

  if (route.route === "who-growth") {
    const mapped = measurementsToAssessQuery({
      sex: parsed.sex, ageMonths: route.ageMonths, measurements: parsed.measurements,
      measured: parsed.measured, muacScheme: parsed.muacScheme,
    });
    if (mapped.error) return json(operationOutcome("error", mapped.error), 400);
    const q = parseAssessQuery(mapped.query);
    if (q.error) return json(operationOutcome("error", q.error), 400);
    const fetchRows = async (table, filters, limit) => {
      const { ok, status, body: rows } = await db.select(table, { filters, limit });
      if (!ok) throw new Error(rows?.message || `Query failed (${status})`);
      return Array.isArray(rows) ? rows : [];
    };
    let result;
    try {
      result = await assessGrowth(q, fetchRows);
    } catch (e) {
      return json(operationOutcome("error", e.message || "Growth lookup failed", "exception"), 502);
    }
    return json(buildWhoGrowthBundle(base, route.ageMonths, result, parsed.effectiveDateTime));
  }

  // route.route === "bmi-for-age"
  const sex = normalizeSex(parsed.sex);
  const bmiMeasurement = parsed.measurements.find((m) => m.type === "bmi");
  const weightMeasurement = parsed.measurements.find((m) => m.type === "weight");
  const lengthMeasurement = parsed.measurements.find((m) => m.type === "length");

  let bmi;
  if (bmiMeasurement) {
    bmi = bmiMeasurement.value?.value;
  } else if (weightMeasurement && lengthMeasurement) {
    const kg = toKg(weightMeasurement.value);
    const cm = toCm(lengthMeasurement.value);
    if (kg === null || cm === null) {
      return json(operationOutcome("error", "weight/length units not recognized (kg/g for weight, cm/m for length)."), 400);
    }
    const meters = cm / 100;
    bmi = kg / (meters * meters);
  } else {
    return json(
      operationOutcome("error", "For a postnatal (BMI-for-age) evaluation, provide either a 'bmi' measurement, or both 'weight' and 'length' measurements together."),
      400
    );
  }
  if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) {
    return json(operationOutcome("error", "Computed/provided BMI is not plausible."), 400);
  }

  const { ok, status, body: rows } = await db.select("bmi_for_age", {
    filters: { sex: `eq.${sex}`, age_months: `eq.${route.ageMonths}` },
    limit: 1,
  });
  if (!ok) return json(operationOutcome("error", rows?.message || "Query failed"), status);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return json(operationOutcome("error", "BMI-for-age reference row not found (has sql/012 been run and seeded?)"), 404);

  const result = classifyBmiForAge(row, bmi);
  const obs = buildBmiForAgeObservation(base, { ageMonths: route.ageMonths }, {
    ...result,
    note: "Screening aid only, not a diagnosis. Cut-offs: severe thinness < -3SD, thinness < -2SD, normal -2SD to +1SD, overweight > +1SD, obesity > +2SD.",
  });
  obs.effectiveDateTime = parsed.effectiveDateTime;

  return json(obs);
}

// One lookup over the NCP operations (src/fhirNcp.js) and the assessment
// foundation operations (src/fhirAssessment.js); all are pure and DB-free.
const fhirOperationFor = (param, action) => governanceOperationFor(param, action) ?? contextOperationFor(param, action) ?? documentOperationFor(param, action) ?? monitoringOperationFor(param, action) ?? interventionOperationFor(param, action) ?? diagnosisOperationFor(param, action) ?? ncpOperationFor(param, action) ?? assessmentOperationFor(param, action);

// NCP operations (src/fhirNcp.js) — pure functions, no DB. Stateless: the
// request body is never stored or logged by this handler.
async function handleFhirNcpOperation(request, url, db, param, operation) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(operationOutcome("error", "Invalid JSON body."), 400);
  }
  const ctx = { base: url.origin, now: new Date().toISOString() };
  const rc = FHIR_REQUEST_CONTEXT.get(request);
  if (rc) rc.subject = auditSubject(body); // used only if FHIR_AUDIT_INCLUDE_PATIENT=true

  // $diagnose resolves NI-/NC-/NB- codes against the Supabase terminology
  // table; fetch just the codes this request names (pure op stays DB-free).
  if (param === "Condition") {
    const codes = diagnosisCodesRequested(body);
    if (codes.length) {
      const { ok, body: rows } = await db.select("ncp_diagnosis_terms", {
        filters: { code: `in.(${codes.join(",")})` },
        limit: 100,
      });
      if (ok && Array.isArray(rows)) ctx.terms = Object.fromEntries(rows.map((r) => [r.code, r]));
      else ctx.termsError = rows?.message || "query failed";
    }
  }

  const result = operation(body, ctx);
  return result.ok ? json(result.body) : json(result.outcome, result.status);
}

// GET /fhir/CodeSystem/ncp-diagnosis — the terminology as a FHIR CodeSystem.
async function handleFhirNcpCodeSystem(url, db) {
  const { ok, status, body: rows } = await db.select("ncp_diagnosis_terms", { limit: 200, order: "code.asc" });
  if (!ok || !Array.isArray(rows)) {
    return json(operationOutcome("error", rows?.message || "Terminology query failed (has sql/017 been run?)"), status || 500);
  }
  return json(buildNcpCodeSystem(url.origin, rows));
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
  [["nsima"], { label: "1 chipande (approx. 150-200g)", grams: 175 }],
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
  [["bread"], { label: "1 slice (±42g)", grams: 42 }],
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
  "safa_g", "sugar_total_g",
  "vita_rae_mcg", "vitc_mg", "vitd_mcg", "vitb12_mcg", "folate_mcg",
  "calcium_mg", "iron_mg", "zinc_mg", "magnesium_mg", "potassium_mg",
  "sodium_mg", "iodine_mcg",
];

/**
 * Lean column set for GET /foods list/search results (see handleFoods) —
 * identity + amount + energy + the same macro/micro panel SERVING_SCALE_FIELDS
 * already treats as "the ones that matter" for a serving/label. Deliberately
 * excludes the provenance/extended-panel columns added by
 * sql/006_expand_foods_full_fct.sql (mfct_code, moisture_g, ash_g, the
 * secondary vitamin/mineral columns, data_quality_flags, etc.) — those stay
 * available via GET /foods/:id (full row, unchanged) for anything that needs
 * the raw source data, but a search result list shouldn't be that heavy.
 * "energy_kcal" isn't a foods column (only relevant for packaged/product
 * rows elsewhere that reuse SERVING_SCALE_FIELDS), so it's dropped here.
 */
const FOODS_SEARCH_FIELDS = [
  "id", "food_name", "category", "measure", "weight_g",
  ...SERVING_SCALE_FIELDS.filter((f) => f !== "energy_kcal"),
].join(",");

// Human-readable names for the vitamins/minerals block on a nutrition
// label (buildNutritionLabel below) — every micronutrient SERVING_SCALE_FIELDS
// carries except sodium, which gets its own mandatory top-level field.
const LABEL_MICRONUTRIENT_NAMES = {
  vita_rae_mcg: "Vitamin A (mcg RAE)",
  vitc_mg: "Vitamin C (mg)",
  vitd_mcg: "Vitamin D (mcg)",
  vitb12_mcg: "Vitamin B12 (mcg)",
  folate_mcg: "Folate (mcg)",
  calcium_mg: "Calcium (mg)",
  iron_mg: "Iron (mg)",
  zinc_mg: "Zinc (mg)",
  magnesium_mg: "Magnesium (mg)",
  potassium_mg: "Potassium (mg)",
  iodine_mcg: "Iodine (mcg)",
};

// The two distinct Codex texts a nutrition label actually rests on — kept
// separate because they're separate standards, not interchangeable names
// for the same thing:
//   CXS 1-1985  — General Standard for the Labelling of Pre-packaged Foods
//                  (what MUST appear on a label at all: name, ingredients, etc.)
//   CXG 2-1985  — Guidelines on Nutrition Labelling
//                  (the nutrition-declaration content this endpoint builds)
// `standard: "codex_stan_1-1985"` is kept below, unchanged, for existing
// callers that already read it — labelling_standard/nutrition_labelling_guideline
// are the corrected, separated references.
const CODEX_LABELLING_STANDARD = "CXS 1-1985";
const CODEX_NUTRITION_LABELLING_GUIDELINE = "CXG 2-1985";

// kcal -> kJ, the standard Codex/FAO conversion factor. Only used when a
// food has kcal but no directly-sourced kj value — see buildNutritionLabel.
const KCAL_TO_KJ_FACTOR = 4.184;

// Maps a `foods` DB column to the column name data_quality_flags actually
// uses. The ingestion script (scripts/reload_foods_from_mfct.cjs) stores
// data_quality_flags verbatim from the source CSV, whose column names don't
// always match the renamed DB columns (e.g. CSV "vitamin_b12_mcg" -> DB
// "vitb12_mcg"; CSV "added_sugar_g" -> DB "sugar_added_g") — this table
// lets us look a DB field's flag up correctly instead of silently never
// matching. Only fields that ever appear on a label need an entry here.
const QUALITY_FLAG_FIELD_MAP = {
  kcal: "energy_kcal",
  kj: "energy_kj",
  protein_g: "protein_g",
  carbs_g: "carbohydrate_available_g",
  sugar_total_g: "total_sugar_g",
  fat_g: "fat_g",
  safa_g: "safa_g",
  fiber_g: "fiber_g",
  sodium_mg: "sodium_mg",
  vita_rae_mcg: "vitamin_a_rae_mcg",
  vitc_mg: "vitamin_c_mg",
  vitd_mcg: "vitamin_d_mcg",
  vitb12_mcg: "vitamin_b12_mcg",
  folate_mcg: "folate_mcg",
  calcium_mg: "calcium_mg",
  iron_mg: "iron_mg",
  zinc_mg: "zinc_mg",
  magnesium_mg: "magnesium_mg",
  potassium_mg: "potassium_mg",
  iodine_mcg: "iodine_mcg",
};

/** Parses a `data_quality_flags` string ("key:flag;key2:flag2") into a lookup object. Never throws on malformed input. */
function parseDataQualityFlags(flagsStr) {
  const out = {};
  if (!flagsStr || typeof flagsStr !== "string") return out;
  for (const pair of flagsStr.split(";")) {
    const [key, val] = pair.split(":");
    if (key && key.trim()) out[key.trim()] = (val || "").trim();
  }
  return out;
}

/**
 * Status for one label field — never conflates "0" (genuinely zero) with
 * missing data: only a null/undefined value is ever "not_available".
 * "estimated" only applies when the source FCT itself flagged that field
 * as assumed/estimated/low_confidence in data_quality_flags (see
 * QUALITY_FLAG_FIELD_MAP) — otherwise a present value is "available".
 */
function fieldStatus(dbField, value, qualityFlags) {
  if (value == null) return "not_available";
  const flagKey = QUALITY_FLAG_FIELD_MAP[dbField];
  const flag = flagKey ? qualityFlags[flagKey] : null;
  if (flag && ["assumed", "estimated", "low_confidence"].includes(flag.toLowerCase())) return "estimated";
  return "available";
}

/**
 * Reshapes an already-scaled nutrients object (the `nutrients` field from a
 * buildServingSizes() entry, or /recipes/calculate's nutrients_per_serving)
 * into a standardized Codex-style nutrition label. CXG 2-1985 (Guidelines on
 * Nutrition Labelling, as amended) is the actual basis for the nutrition
 * declaration content — energy, protein, available carbohydrate, fat,
 * saturated fat, sodium, and total sugars; fibre and vitamins/minerals are
 * included here too since producers generally want them shown even though
 * the guideline itself only requires them when a nutrition claim is made
 * about them. `missing_fields` flags which mandatory values this food/recipe
 * doesn't have data for yet, rather than silently rendering them blank.
 *
 * `options` (all optional — omitting them preserves the original,
 * single-argument behavior used by POST /recipes/calculate, which has no
 * single food row/quality-flags/100g-reference to draw on):
 *   - qualityFlags   — parseDataQualityFlags() output for the source food row.
 *   - reference100g  — the food's raw per-100g nutrients (buildServingSizes'
 *                       "reference" tier), exposed alongside the serving
 *                       values so a caller can see how they were derived.
 *   - servingSource   — the serving_sizes tier this serving came from ("fct",
 *                       "local_intelligence", "category_estimate", "reference").
 */
function buildNutritionLabel(nutrients, servingLabel, servingGrams, options = {}) {
  const { qualityFlags = {}, reference100g = null, servingSource = null } = options;

  const vitaminsMinerals = {};
  const vitaminsMineralsDetail = {};
  for (const [field, name] of Object.entries(LABEL_MICRONUTRIENT_NAMES)) {
    const value = nutrients[field] ?? null;
    if (value != null) vitaminsMinerals[name] = value;
    vitaminsMineralsDetail[name] = { value, status: fieldStatus(field, value, qualityFlags) };
  }

  const kcal = nutrients.kcal ?? nutrients.energy_kcal ?? null;
  // kJ: prefer a directly-sourced value; only fall back to converting from
  // kcal (and mark that conversion as "estimated", since it isn't itself a
  // measured value) when the source has no kJ figure of its own.
  const kjDirect = nutrients.kj ?? null;
  const kj = kjDirect ?? (kcal != null ? Math.round(kcal * KCAL_TO_KJ_FACTOR * 100) / 100 : null);
  const kjStatus = kjDirect != null ? fieldStatus("kj", kjDirect, qualityFlags) : kcal != null ? "estimated" : "not_available";

  const label = {
    // Legacy fields — unchanged shape/meaning, existing clients keep working.
    serving_size: servingLabel,
    serving_grams: servingGrams,
    calories: kcal,
    total_fat_g: nutrients.fat_g ?? null,
    saturated_fat_g: nutrients.safa_g ?? null,
    carbohydrates_g: nutrients.carbs_g ?? null,
    fiber_g: nutrients.fiber_g ?? null,
    sugars_g: nutrients.sugar_total_g ?? null,
    protein_g: nutrients.protein_g ?? null,
    sodium_mg: nutrients.sodium_mg ?? null,
    vitamins_minerals: vitaminsMinerals,
    standard: "codex_stan_1-1985",

    // New: corrected/separated Codex references.
    labelling_standard: CODEX_LABELLING_STANDARD,
    nutrition_labelling_guideline: CODEX_NUTRITION_LABELLING_GUIDELINE,

    // New: explicit energy pair, calculated consistently from the same
    // source nutrients as `calories` above.
    energy_kcal: kcal,
    energy_kj: kj,

    // New: structured nutrition declaration — same values as the legacy
    // flat fields, paired with an availability/estimation status so "0"
    // (genuinely zero) is never confused with missing data.
    nutrition_declaration: {
      energy: { kcal, kj, kcal_status: fieldStatus("kcal", kcal, qualityFlags), kj_status: kjStatus },
      protein_g: { value: nutrients.protein_g ?? null, status: fieldStatus("protein_g", nutrients.protein_g ?? null, qualityFlags) },
      carbohydrate_g: { value: nutrients.carbs_g ?? null, status: fieldStatus("carbs_g", nutrients.carbs_g ?? null, qualityFlags) },
      total_sugars_g: { value: nutrients.sugar_total_g ?? null, status: fieldStatus("sugar_total_g", nutrients.sugar_total_g ?? null, qualityFlags) },
      total_fat_g: { value: nutrients.fat_g ?? null, status: fieldStatus("fat_g", nutrients.fat_g ?? null, qualityFlags) },
      saturated_fat_g: { value: nutrients.safa_g ?? null, status: fieldStatus("safa_g", nutrients.safa_g ?? null, qualityFlags) },
      dietary_fibre_g: { value: nutrients.fiber_g ?? null, status: fieldStatus("fiber_g", nutrients.fiber_g ?? null, qualityFlags) },
      sodium_mg: { value: nutrients.sodium_mg ?? null, status: fieldStatus("sodium_mg", nutrients.sodium_mg ?? null, qualityFlags) },
    },

    // New: same vitamins/minerals, each paired with its availability status.
    vitamins_minerals_detail: vitaminsMineralsDetail,

    // New: calculation transparency — is this serving's weight a real
    // measured amount or a curated estimate, and are the nutrient values
    // themselves the database's own 100g figures or scaled from them.
    calculation: {
      serving_weight_grams: servingGrams,
      serving_weight_source: servingSource === "fct" || servingSource === "reference" ? "measured" : servingSource ? "estimated" : null,
      serving_weight_basis: servingSource,
      value_basis: servingGrams === 100 ? "direct_from_database" : "calculated_from_per_100g_reference",
    },
  };

  // New: the raw per-100g basis these serving values were scaled from, so a
  // caller can see the derivation rather than only the final numbers.
  // Only present when a single food's 100g reference nutrients were passed
  // in (not available for /recipes/calculate, which sums several foods).
  if (reference100g) {
    label.per_100g_reference = {
      calories: reference100g.kcal ?? null,
      energy_kj: reference100g.kj ?? null,
      total_fat_g: reference100g.fat_g ?? null,
      saturated_fat_g: reference100g.safa_g ?? null,
      carbohydrates_g: reference100g.carbs_g ?? null,
      fiber_g: reference100g.fiber_g ?? null,
      sugars_g: reference100g.sugar_total_g ?? null,
      protein_g: reference100g.protein_g ?? null,
      sodium_mg: reference100g.sodium_mg ?? null,
      vitamins_minerals: Object.fromEntries(
        Object.entries(LABEL_MICRONUTRIENT_NAMES)
          .map(([field, name]) => [name, reference100g[field] ?? null])
          .filter(([, v]) => v != null)
      ),
    };
  }

  const mandatory = ["calories", "total_fat_g", "saturated_fat_g", "carbohydrates_g", "sugars_g", "protein_g", "sodium_mg"];
  const missing = mandatory.filter((f) => label[f] == null);
  if (missing.length) label.missing_fields = missing;

  return label;
}

function roundServingVal(n) {
  return n == null || n === "" || isNaN(n) ? null : Math.round(Number(n) * 100) / 100;
}

/**
 * The raw per-100g/100ml nutrients straight off a food row (scale=1), for
 * exposing alongside a scaled serving as `per_100g_reference` on a
 * nutrition label. Computed directly from the row rather than pulled from
 * buildServingSizes()'s "reference" tier, because that tier gets deduped
 * away whenever the food's own `measure`/`weight_g` is already ~100g (true
 * for every row loaded via scripts/reload_foods_from_mfct.cjs, which always
 * sets measure="100g") — so a distinct "reference"-sourced entry often
 * doesn't exist even though the 100g basis obviously still does.
 */
function extractPer100gNutrients(food) {
  const nutrients = {};
  if (!food) return nutrients;
  for (const field of SERVING_SCALE_FIELDS) {
    if (food[field] != null && food[field] !== "") nutrients[field] = roundServingVal(Number(food[field]));
  }
  return nutrients;
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

// Unit sizes (g, kg, oz, lb, ml, tsp, tbsp, dsp, cup, us cup, fl oz, scoops ...) now live in
// src/measures.js, which holds the UCT household guide, the kitchen conversion tables and Krause
// Appendix 2 in one table. "cup" is the 250 ml metric household cup (not the 240 ml US cup, which
// is "us cup"); oz is the weight ounce (28.35 g) and "fl oz" is kept distinct (29.57 ml).

/**
 * Converts one ingredient's {quantity, unit} to grams for a given food row (see
 * resolveQuantityToGrams in src/measures.js for the tiers). Weight units are exact; volume units use
 * the food's own serving in that unit, else the food's own density (from its cup/spoon serving), else
 * 1 g/ml, flagged. Returns { grams, basis, density_g_per_ml? } or { grams: null, reason }.
 */
function resolveIngredientGrams(food, quantity, unit) {
  return resolveQuantityToGrams(() => buildServingSizes(food), quantity, unit);
}

// pickBestFoodMatch()/pickBestFoodMatchDetailed() now live in
// ./foodMatching.js — a general multi-component scorer (base-name
// overlap, exact match, requested-vs-conflicting preparation/form/
// freshness/variety attributes, a dish-word penalty so "Rice pudding"
// can't outrank "Rice" for a bare "rice" query, and a specificity penalty
// for unrequested qualifiers) that replaced the old "shortest food_name
// wins" tiebreak and a per-food hardcoded override table (BARE_QUERY_
// PREFERRED_MATCH, previously just `{ nsima: "ufa oyera" }`). See that
// file's doc comment for the full root-cause writeup and design, and
// foodMatching.test.js for the regression suite. A bare query like
// "nsima" that only weakly matches multiple candidates (via their
// Chichewa-name parenthetical, with nothing in the query to prefer one
// base food over another) is now honestly reported as ambiguous rather
// than silently guessing — see pickBestFoodMatchDetailed's `ambiguous`/
// `alternates` fields, surfaced on GET /foods/lookup's response.

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

// Every unit resolveIngredientGrams() understands (the unit table in src/measures.js, plurals and
// alternate spellings included), plus the count-like slice/handful/pinch and "piece(s)".
const KNOWN_INGREDIENT_UNITS = new Set([
  ...UNIT_SURFACE_FORMS,
  "slice", "slices", "handful", "handfuls", "pinch", "pinches",
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
    const res = await trackedFetch(env, "groq", "https://api.groq.com/openai/v1/chat/completions", {
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
/**
 * Finds the food row for one ingredient-style item ({food_id} or {food_name}): local `foods` first
 * (ilike + pickBestFoodMatch), then the lookupFoodCascade() external tiers. Shared by
 * resolveIngredientsList() and GET /foods/convert so both resolve a name identically.
 * Returns { food, matchedSource, alternatives? } (food null when nothing matched; alternatives are up to 5 other local name matches) or { error } when neither id nor name was given.
 */
async function findFoodForIngredient(item, db, env) {
  if (item.food_id != null) {
    const { ok, body } = await db.selectOne("foods", item.food_id);
    return ok && body ? { food: body, matchedSource: "food_id" } : { food: null, matchedSource: null };
  }
  if (item.food_name) {
    const local = await db.select("foods", {
      filters: { food_name: `ilike.*${escapeLikePattern(item.food_name)}*` },
      limit: 25,
    });
    const bestLocal = local.ok ? pickBestFoodMatch(local.body, item.food_name, { implied: await resolveImpliedForm(env, item.food_name) }) : null;
    if (bestLocal) {
      const alternatives = (local.body || [])
        .filter((f) => f.id !== bestLocal.id)
        .slice(0, 5)
        .map((f) => ({ id: f.id, food_name: f.food_name }));
      return { food: bestLocal, matchedSource: "local", alternatives };
    }
    const cascade = await lookupFoodCascade(db, { query: item.food_name }, env);
    if (cascade?.food) return { food: cascade.food, matchedSource: cascade.source };
    return { food: null, matchedSource: null };
  }
  return { error: "provide either 'food_id' or 'food_name'" };
}

async function resolveIngredientsList(ingredients, db, env, extraFields = []) {
  const resolvedIngredients = [];
  const unresolvedIngredients = [];

  for (const item of ingredients) {
    const quantity = Number(item?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      unresolvedIngredients.push({ input: item, reason: "missing or invalid 'quantity'" });
      continue;
    }

    const found = await findFoodForIngredient(item, db, env);
    if (found.error) {
      unresolvedIngredients.push({ input: item, reason: found.error });
      continue;
    }
    const { food, matchedSource } = found;

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
    for (const field of [...SERVING_SCALE_FIELDS, ...extraFields]) {
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

  const gramsPerServing = roundServingVal(totalGrams / servings);

  return success({
    servings,
    total_grams: roundServingVal(totalGrams),
    grams_per_serving: gramsPerServing,
    total_nutrients: totalNutrients,
    nutrients_per_serving: nutrientsPerServing,
    // Same Codex-style shape as GET /foods/:id/label, built from this
    // recipe's own per-serving totals rather than a single food row.
    nutrition_label: buildNutritionLabel(nutrientsPerServing, `1 serving (${gramsPerServing}g)`, gramsPerServing),
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

/**
 * Median (z = 0) WHO weight-for-length/height for a child under 5 years: the "ideal weight for length/height" in the catch-up growth method.
 * Same table and lookup rules as GET /weight-for-length-height/classify. q = { sex: "girls"|"boys", ageMonths, heightCm, measured? }.
 */
async function lookupIdealWeight(db, q) {
  const table = q.measured || defaultMeasured(q.ageMonths);
  const lookup = resolveLookup(q.ageMonths, table, q.heightCm);
  if (lookup.lookupCm < lookup.range.min || lookup.lookupCm > lookup.range.max) {
    return { error: `Length/height ${lookup.lookupCm} cm is outside the WHO table (${lookup.range.min} to ${lookup.range.max} cm) for this age.` };
  }
  const { ok, body } = await db.select("who_weight_for_length_height", {
    filters: { sex: `eq.${q.sex}`, measured: `eq.${lookup.table}`, length_height_cm: `eq.${lookup.lookupCm.toFixed(1)}` },
    limit: 1,
  });
  const row = ok && Array.isArray(body) ? body[0] : null;
  const m = row ? Number(row.lms_m) : NaN;
  if (!Number.isFinite(m) || m <= 0) return { error: "The WHO weight-for-length/height row was not found (has sql/025 been run and all five seed parts loaded?)." };
  return { kg: m, source: `WHO median weight-for-${lookup.table === "lying" ? "length" : "height"} at ${lookup.lookupCm} cm (${row.source || "WHO Child Growth Standards 2006"})` };
}

/** POST /paediatric/catch-up and POST /paediatric/plan (catch_up: true): fills in the ideal weight from the WHO table when the caller did not send one. */
async function withIdealWeight(body, db) {
  const lk = idealWeightLookupFor(body);
  if (!lk) return { body, opts: {} };
  const r = await lookupIdealWeight(db, lk);
  if (r.error) return { error: `${r.error} Send 'ideal_weight_kg' instead.` };
  return { body, opts: { idealWeightKg: r.kg, idealWeightSource: r.source } };
}

/**
 * POST /enteral-nutrition/calculate
 * Formula comes from the body ({formula:{kcal_per_ml, protein_g_per_l, water_ml_per_l}} or formula_kcal_per_ml etc.), or from enteral_formulas via formula_id or
 * formula_name (read only). Values sent in the body override the looked-up ones. The enteral_formulas column names are read through a list of likely names
 * (src/enteralNutrition.js mapFormulaRow); if a value cannot be read from the row the response says which, with the row's column names.
 */
async function handleEnteralCalculate(body, db) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return err("Body must be a JSON object");
  const hasId = body.formula_id !== undefined && body.formula_id !== null && body.formula_id !== "";
  const hasName = typeof body.formula_name === "string" && body.formula_name.trim() !== "";
  let input = body;
  if (hasId || hasName) {
    let row = null;
    if (hasId) {
      const r = await db.selectOne("enteral_formulas", String(body.formula_id));
      if (!r.ok) return err(r.status === 404 ? `No enteral formula with id '${body.formula_id}'` : "Could not read enteral_formulas", r.status === 404 ? 404 : 502);
      row = r.body;
    } else {
      const r = await db.select("enteral_formulas", { limit: 1000 });
      if (!r.ok) return err("Could not read enteral_formulas", 502);
      const picked = pickFormulaByName(r.body, body.formula_name);
      if (picked.error) return err(picked.error, picked.matches ? 422 : 404);
      row = picked.row;
    }
    const mapped = mapFormulaRow(row);
    const inline = (body.formula && typeof body.formula === "object") ? body.formula : {};
    const pickVal = (k, flat) => (inline[k] !== undefined && inline[k] !== null && inline[k] !== "" ? inline[k] : (body[flat] !== undefined && body[flat] !== null && body[flat] !== "" ? body[flat] : mapped[k]));
    const merged = { kcal_per_ml: pickVal("kcal_per_ml", "formula_kcal_per_ml"), protein_g_per_l: pickVal("protein_g_per_l", "formula_protein_g_per_l"), water_ml_per_l: pickVal("water_ml_per_l", "formula_water_ml_per_l") };
    if (merged.kcal_per_ml === null || merged.kcal_per_ml === undefined) {
      return err(`Formula '${mapped.name || body.formula_id || body.formula_name}' was found but its energy density could not be read from the row (columns: ${Object.keys(row || {}).join(", ")}). Send formula.kcal_per_ml in the body.`, 422);
    }
    input = { ...body, formula: { ...merged, name: mapped.name, source: `enteral_formulas row${mapped.columns && Object.keys(mapped.columns).length ? " (" + Object.entries(mapped.columns).map(([f, c]) => `${f} from ${c}`).join(", ") + ")" : ""}` } };
  }
  const result = computeEnteralPlan(input);
  if (!result.ok) return err(result.error);
  return success(result.data, { message: "Enteral nutrition: calculate" });
}

/**
 * POST /dietary-assessment
 * Body: { age | life_stage, sex?, life_stage_type?, weight_kg?, height_cm?, pal_category?, trimester?, months_postpartum?, energy_target_kcal?,
 *         suggest_foods?: boolean (default true),
 *         days: [{ date?, meals: [{ meal_type?, ingredients }] | ingredients: [...] | intake: { nutrient totals } }] }
 * (For one day, meals / ingredients / intake may be sent at the top level.)
 * Foods are resolved exactly as in /meals/analyze (resolveIngredientsList), summed per day, then assessDiet() (src/dietaryAssessment.js) compares the average with
 * the DRI, the IOM energy target and the AMDR, and ranks the gaps. The foods richest in the top gap nutrients come from up to 3 ranked reads of `foods`.
 * Writes nothing.
 */
async function handleDietaryAssessment(request, db, env) {
  const body = await parseBody(request);
  if (body === null) return err("Invalid JSON body");
  const parsed = parseAssessmentRequest(body);
  if (!parsed.ok) return err(parsed.error);
  const req = parsed.data;

  const fields = [...SERVING_SCALE_FIELDS, ...EXTRA_FOOD_FIELDS];
  const days = [];
  const allResolved = [];
  const unresolved = [];
  let skippedDays = 0;

  for (const [i, d] of req.days.entries()) {
    if (d.intake) {
      days.push({ date: d.date, totals: d.intake, groups: null });
      continue;
    }
    const { resolvedIngredients, unresolvedIngredients } = await resolveIngredientsList(d.items, db, env, EXTRA_FOOD_FIELDS);
    for (const u of unresolvedIngredients) unresolved.push({ day: d.date || `day ${i + 1}`, ...u });
    if (!resolvedIngredients.length) {
      skippedDays++;
      continue;
    }
    allResolved.push(...resolvedIngredients);
    days.push({
      date: d.date,
      totals: normalizeIntake(sumResolved(resolvedIngredients, fields)),
      groups: [...new Set(resolvedIngredients.map((ing) => ing.category).filter(Boolean))],
    });
  }

  const result = assessDiet({
    stage: req.stage,
    ageYears: req.ageYears,
    weightKg: req.weightKg,
    days,
    energy: buildEnergyTarget(req),
    coverage: coverageOf(allResolved, fields),
    skippedDays,
  });
  if (!result.ok) {
    return json({ status: "error", message: `${result.error}. Check 'unresolved_ingredients'.`, unresolved_ingredients: unresolved }, 422);
  }
  const data = result.data;
  data.days = days.map((d) => ({ date: d.date, kcal: d.totals.kcal ?? null, food_groups: d.groups }));
  data.unresolved_ingredients = unresolved;

  // Foods richest in the top gap nutrients (per 100 g). Best effort: a failed read just omits the section.
  if (req.suggestFoods && data.summary.priority_gaps.length) {
    const wanted = data.summary.priority_gaps.filter((g) => g.confidence !== "low").slice(0, 3);
    const suggestions = [];
    for (const g of wanted) {
      const col = foodsColumnFor(g.nutrient);
      try {
        const r = await db.select("foods", { filters: { [col]: "not.is.null" }, order: `${col}.desc`, limit: 5, select: `id,food_name,category,measure,weight_g,${col}` });
        if (r.ok && Array.isArray(r.body) && r.body.length) {
          suggestions.push({
            nutrient: g.nutrient,
            label: g.label,
            per: "100 g of the food as listed",
            foods: r.body.map((f) => ({ id: f.id, food_name: f.food_name, category: f.category, amount_per_100g: f[col], unit: g.unit.replace("/d", ""), measure: f.measure ?? null })),
          });
        }
      } catch (_) {
        // omit
      }
    }
    if (suggestions.length) {
      data.suggested_foods = suggestions;
      data.notes.push("suggested_foods ranks foods by nutrient density per 100 g. Check the usual portion size and what is available and affordable before recommending one.");
    }
  }

  return success(data, { message: "Dietary assessment" });
}

function normalizeFood(source, raw) {
  // Produces the common shape stored in external_foods_cache and returned
  // to the client, regardless of which upstream API it came from. Micros
  // use the same field names as public.foods (vita_rae_mcg, vitc_mg, etc.)
  // so downstream code (labels, /foods/compare) can treat a cached external
  // hit the same as a local row. Not every source can populate every
  // field — see the source-specific extraction in fetchFromUSDA/
  // fetchFromOpenFoodFacts/fetchFromFatSecretBarcode for what's actually
  // available and why (e.g. FatSecret's vitamin_a/vitamin_c/calcium/iron
  // are %DV, not absolute values, so those are deliberately left null for
  // FatSecret-sourced foods rather than storing a misleading number).
  return {
    food_name: raw.food_name ?? "",
    category: raw.category ?? classifyCategory(raw.food_name),
    energy_kcal: raw.energy_kcal ?? null,
    protein_g: raw.protein_g ?? null,
    fat_g: raw.fat_g ?? null,
    carbs_g: raw.carbs_g ?? null,
    fiber_g: raw.fiber_g ?? null,
    vita_rae_mcg: raw.vita_rae_mcg ?? null,
    vitc_mg: raw.vitc_mg ?? null,
    vitd_mcg: raw.vitd_mcg ?? null,
    vitb12_mcg: raw.vitb12_mcg ?? null,
    folate_mcg: raw.folate_mcg ?? null,
    calcium_mg: raw.calcium_mg ?? null,
    iron_mg: raw.iron_mg ?? null,
    zinc_mg: raw.zinc_mg ?? null,
    magnesium_mg: raw.magnesium_mg ?? null,
    potassium_mg: raw.potassium_mg ?? null,
    sodium_mg: raw.sodium_mg ?? null,
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
  // Strip a bare trailing "s" (length > 3 so we don't mangle real short
  // words like "gas" or "yas") so "Burritos" overlaps a USDA/FatSecret
  // entry named singular "burrito" instead of scoring 0% and getting
  // rejected outright.
  const singularize = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const normalize = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map(singularize);

  const queryWords = [...new Set(normalize(query))];
  if (!queryWords.length) return 0;
  const candidateWords = new Set(normalize(candidateName));
  const matched = queryWords.filter((w) => candidateWords.has(w)).length;
  return matched / queryWords.length;
}

async function fetchFromUSDA(query, env) {
  if (!env.USDA_FDC_API_KEY) return null;
  // Foundation/SR Legacy alone only covers raw/minimally-processed
  // ingredients — prepared/composite dishes (hummus, burritos, hot dogs)
  // mostly live in Survey (FNDDS). Branded is deliberately left out: it's
  // dominated by specific commercial products, not generic dish lookups.
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search` +
    `?api_key=${env.USDA_FDC_API_KEY}` +
    `&query=${encodeURIComponent(query)}` +
    `&pageSize=5&dataType=${encodeURIComponent("Foundation,SR Legacy,Survey (FNDDS)")}`;
  const res = await trackedFetch(env, "usda", url);
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
    fiber_g: getNutrient("Fiber, total dietary"),
    vita_rae_mcg: getNutrient("Vitamin A, RAE"),
    vitc_mg: getNutrient("Vitamin C, total ascorbic acid"),
    vitd_mcg: getNutrient("Vitamin D (D2 + D3)"),
    vitb12_mcg: getNutrient("Vitamin B-12"),
    folate_mcg: getNutrient("Folate, total"),
    calcium_mg: getNutrient("Calcium, Ca"),
    iron_mg: getNutrient("Iron, Fe"),
    zinc_mg: getNutrient("Zinc, Zn"),
    magnesium_mg: getNutrient("Magnesium, Mg"),
    potassium_mg: getNutrient("Potassium, K"),
    sodium_mg: getNutrient("Sodium, Na"),
    external_id: String(food.fdcId),
    raw_data: {
      fdcId: food.fdcId,
      dataType: food.dataType,
      publishedDate: food.publishedDate,
      nutrients: trimmedNutrients,
    },
  });
}

// Open Food Facts' nutriments object expresses EVERY nutrient in grams as
// its base unit (docs: https://openfoodfacts.github.io/openfoodfacts-server/api/ref-nutrients/),
// including vitamins/minerals that are conventionally mg or mcg elsewhere
// (e.g. "vitamin-a_100g": 0.0000015 for 1.5 mcg). Converts a raw gram value
// to mg or mcg so it lines up with the same units public.foods uses.
function offGramsTo(value, unit) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return unit === "mcg" ? n * 1e6 : n * 1000; // unit: "mg" | "mcg"
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
    fiber_g: n["fiber_100g"] ?? null,
    // OFF rarely populates the vitamin fields for packaged products, but
    // when it does they're grams — convert to the mg/mcg public.foods uses.
    vita_rae_mcg: offGramsTo(n["vitamin-a_100g"], "mcg"),
    vitc_mg: offGramsTo(n["vitamin-c_100g"], "mg"),
    vitd_mcg: offGramsTo(n["vitamin-d_100g"], "mcg"),
    vitb12_mcg: offGramsTo(n["vitamin-b12_100g"], "mcg"),
    folate_mcg: offGramsTo(n["folates_100g"], "mcg"),
    calcium_mg: offGramsTo(n["calcium_100g"], "mg"),
    iron_mg: offGramsTo(n["iron_100g"], "mg"),
    zinc_mg: offGramsTo(n["zinc_100g"], "mg"),
    magnesium_mg: offGramsTo(n["magnesium_100g"], "mg"),
    potassium_mg: offGramsTo(n["potassium_100g"], "mg"),
    sodium_mg: offGramsTo(n["sodium_100g"], "mg"),
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

  const res = await trackedFetch(env, "fatsecret", signedUrl);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  // Error 211 = "No food item detected" for this barcode; missing scope
  // (14) or any other error also just falls through to the next source.
  if (isFatSecretError(data)) recordUpstreamFailure(env, "fatsecret");
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
    fiber_g: scaleVal(serving.fiber),
    sodium_mg: scaleVal(serving.sodium),
    potassium_mg: scaleVal(serving.potassium),
    // FatSecret's classic serving object reports vitamin_a, vitamin_c,
    // calcium, and iron as %DV strings (e.g. "10" meaning 10% of a daily
    // value), not absolute mg/mcg amounts — unlike fiber/sodium/potassium
    // above, which are genuine absolute values. Converting a %DV to mg/mcg
    // needs a reference DV that isn't given in the response and varies by
    // regulatory region, so rather than guess (and risk a wrong number in
    // a clinical nutrition tool) these are left null for FatSecret-sourced
    // foods. USDA and Open Food Facts both give absolute values and are
    // populated normally.
    barcode,
    external_id: food.food_id,
    raw_data: {
      food_id: food.food_id,
      food_type: food.food_type ?? null,
      brand_name: food.brand_name ?? null,
      food_url: food.food_url ?? null,
      serving_basis: `${serving.metric_serving_amount}${serving.metric_serving_unit}`,
      scaled_to_100: scale !== 1,
      vitamin_a_pct_dv: serving.vitamin_a ?? null,
      vitamin_c_pct_dv: serving.vitamin_c ?? null,
      calcium_pct_dv: serving.calcium ?? null,
      iron_pct_dv: serving.iron ?? null,
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

  const searchRes = await trackedFetch(env, "fatsecret", signedUrl);
  if (!searchRes.ok) return null;
  const data = await searchRes.json().catch(() => null);
  if (isFatSecretError(data)) recordUpstreamFailure(env, "fatsecret");
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

  // foods.search's food_description is macros-only text ("Per 100g -
  // Calories: 52kcal | Fat: 0.17g | ..."), so a name-search result used to
  // come back with no fiber/sodium/potassium/vitamins/calcium/iron at all —
  // unlike the barcode path (fetchFromFatSecretBarcode), which already
  // calls food.get and gets the full serving object. Do the same follow-up
  // call here so a name-search match carries the same micronutrient panel.
  // A failure here just means we fall back to the macros-only result below,
  // same behaviour as before this call existed.
  let microFields = {};
  let microRawData = {};
  try {
    const detailUrl = await signFatSecretRequest(
      { method: "food.get.v2", food_id: food.food_id, format: "json" },
      env.FATSECRET_CONSUMER_KEY,
      env.FATSECRET_CONSUMER_SECRET
    );
    const detailRes = await trackedFetch(env, "fatsecret", detailUrl);
    if (detailRes.ok) {
      const detailData = await detailRes.json().catch(() => null);
      if (isFatSecretError(detailData)) recordUpstreamFailure(env, "fatsecret");
      const detailFood = detailData?.food;
      const picked = detailFood && !detailData?.error
        ? pickFatSecretServing(detailFood.servings?.serving)
        : null;
      if (picked) {
        const { serving: s, scale: detailScale } = picked;
        const scaleDetailVal = (n) =>
          n == null || n === "" ? null : Math.round(parseFloat(n) * detailScale * 100) / 100;
        microFields = {
          fiber_g: scaleDetailVal(s.fiber),
          sodium_mg: scaleDetailVal(s.sodium),
          potassium_mg: scaleDetailVal(s.potassium),
        };
        // Same caveat as fetchFromFatSecretBarcode: FatSecret's classic
        // serving object gives vitamin_a/vitamin_c/calcium/iron as %DV
        // strings, not absolute mg/mcg — left out of the normalized fields
        // (only in raw_data) rather than guessing a reference DV.
        microRawData = {
          vitamin_a_pct_dv: s.vitamin_a ?? null,
          vitamin_c_pct_dv: s.vitamin_c ?? null,
          calcium_pct_dv: s.calcium ?? null,
          iron_pct_dv: s.iron ?? null,
        };
      }
    }
  } catch (e) {
    console.error("FatSecret food.get.v2 detail fetch failed:", e?.message || e);
  }

  return normalizeFood("fatsecret", {
    food_name: food.food_name,
    energy_kcal: scaleVal(grab("Calories")),
    fat_g: scaleVal(grab("Fat")),
    carbs_g: scaleVal(grab("Carbs")),
    protein_g: scaleVal(grab("Protein")),
    ...microFields,
    external_id: food.food_id,
    raw_data: {
      food_id: food.food_id,
      food_type: food.food_type ?? null,
      food_description: food.food_description ?? null,
      food_url: food.food_url ?? null,
      serving_basis: `${basis.amount}${basis.unit}`,
      scaled_to_100: basis.amount !== 100,
      ...microRawData,
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

  const res = await trackedFetch(env, "fatsecret", signedUrl);
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

  const res = await trackedFetch(env, "fatsecret", signedUrl);
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
// Local-first as-you-type suggestions: Malawi FCT + packaged foods
// (brand/product) substring match (cheap, every keystroke), backfilled with
// fuzzy_food_search for typo tolerance if that's short on results, then
// Chichewa<->English synonym expansion, and only THEN — if there's still
// room — FatSecret's global suggestions to cover anything with no local
// entry. Missing FatSecret credentials no longer fail the whole request;
// local + synonym results still return, just without the external tier.
async function handleFoodsAutocomplete(request, url, db, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const expression = (url.searchParams.get("q") || url.searchParams.get("expression") || "").trim();
  if (!expression) return err("'q' query param is required");

  const maxResults = Math.min(Math.max(intParam(url, "max_results", 4), 1), 10);

  const suggestions = [];
  const seen = new Set();
  const addSuggestion = (name, matchType, extra = {}) => {
    if (typeof name !== "string" || !name.trim()) return;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({ name: name.trim(), _match_type: matchType, ...extra });
  };

  const localFoods = await autocompleteFoodsLocal(db, expression, maxResults);
  for (const f of localFoods) addSuggestion(f.food_name, "local_fct", { id: f.id, category: f.category ?? null });

  if (suggestions.length < maxResults) {
    const localPackaged = await autocompletePackagedLocal(db, expression, maxResults - suggestions.length);
    for (const p of localPackaged) {
      addSuggestion(p.packaged_food?.product_name, "local_packaged", {
        id: p.packaged_food?.id ?? null,
        brand: p.packaged_food?.brand ?? null,
        matched_field: p.matched_field,
      });
    }
  }

  const expandedTerms = await expandSynonyms(db, expression);
  for (const term of expandedTerms) {
    if (suggestions.length >= maxResults) break;
    const synFoods = await autocompleteFoodsLocal(db, term, maxResults - suggestions.length);
    for (const f of synFoods) addSuggestion(f.food_name, "synonym", { id: f.id, category: f.category ?? null, matched_term: term });
  }

  let note;
  if (suggestions.length < maxResults) {
    const external = await fetchFatSecretAutocomplete(expression, maxResults - suggestions.length, env);
    if (external === null) {
      note = "FatSecret credentials not configured on this deployment — CNR's FatSecret-backed tier skipped; local results only.";
    } else {
      for (const name of external) addSuggestion(name, "fatsecret");
    }
  }

  return success(suggestions.slice(0, maxResults), {
    query: expression,
    ...(expandedTerms.length ? { expanded_terms: expandedTerms } : {}),
    ...(note ? { note } : {}),
  });
}

// GET /foods/search?q=...&max_results=...&min_similarity=...&category=...&brand=...&ingredient=...
// Typo-tolerant search, now spanning more than just public.foods.food_name:
//   - q (optional if category/brand/ingredient given): fuzzy search over
//     public.foods, expanded through food_synonyms (Chichewa<->English and
//     other local-name aliases) so e.g. "chinangwa" also searches "cassava".
//   - category: restricts the q search (or, with no q, browses) foods.category.
//   - brand: fuzzy search over packaged_foods.brand — brand search.
//   - ingredient: fuzzy search over packaged_foods.ingredients_text — search
//     by ingredient.
// brand=/ingredient= run independently of the foods-table search and are
// merged into the same results array, each row tagged _source/_match_type
// so a caller can tell what matched. Like before, this never falls back to
// external APIs and never caches an external result — purely local.
async function handleFoodsSearch(request, url, db, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const q = (url.searchParams.get("q") || "").trim();
  const category = (url.searchParams.get("category") || "").trim();
  const brand = (url.searchParams.get("brand") || "").trim();
  const ingredient = (url.searchParams.get("ingredient") || "").trim();
  if (!q && !category && !brand && !ingredient) {
    return err("At least one of 'q', 'category', 'brand', or 'ingredient' is required");
  }

  const maxResults = Math.min(Math.max(intParam(url, "max_results", 8), 1), 25);
  const minSimilarityParam = url.searchParams.get("min_similarity");
  const minSimilarityRaw = minSimilarityParam !== null ? parseFloat(minSimilarityParam) : 0.35;
  const minSimilarity = Number.isNaN(minSimilarityRaw) ? 0.35 : Math.min(Math.max(minSimilarityRaw, 0), 1);

  const results = [];
  let expandedTerms = [];

  if (q || category) {
    const primary = await fuzzyFoodSearch(db, q, { maxResults, minSimilarity, category, env });
    for (const row of primary) results.push({ ...row, _source: "foods", _match_type: q ? "fuzzy" : "category" });

    if (q && results.length < maxResults) {
      expandedTerms = await expandSynonyms(db, q);
      // A multi-word query ("mpunga wophika") matches no synonym term as a whole. When it states a
      // preparation/variety or found nothing, look each food word up on its own (exact term, max 3 words)
      // and rank what the alias terms return against what the user typed.
      let viaWords = false;
      if (!expandedTerms.length && (results.length === 0 || hasStatedAttributes(q))) {
        const words = retrievalTermFor(q).split(" ").filter((w) => w.length >= 3).slice(0, 3);
        const found = new Set();
        for (const w of words) for (const t of await expandSynonyms(db, w, { exact: true })) found.add(t);
        expandedTerms = [...found];
        viaWords = expandedTerms.length > 0;
      }
      const seenIds = new Set(results.map((r) => r.id));
      for (const term of expandedTerms) {
        if (results.length >= maxResults) break;
        const synRows = await fuzzyFoodSearch(db, term, {
          maxResults: maxResults - results.length,
          minSimilarity,
          category,
          env,
          ...(viaWords ? { rankQuery: q, aliases: expandedTerms } : {}),
        });
        for (const row of synRows) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
          results.push({ ...row, _source: "foods", _match_type: "synonym", _matched_term: term });
        }
      }
    }
  }

  // Optional LLM tie-breaker (src/foodIntentLlm.js): only when the ranking above is unsure on a query that
  // states a preparation/variety. It can only reorder the food rows already found; cached 7 days in KV.
  if (q && env.GROQ_API_KEY) {
    const foodRows = results.filter((r) => r._source === "foods");
    if (rankingNeedsHelp(foodRows, q)) {
      const ids = foodRows.slice(0, 10).map((r) => r.id);
      const cacheKey = [q.toLowerCase(), ids.join(",")];
      let order = null;
      try {
        order = (await getQueryCache(env, "foodintent", cacheKey))?.order || null;
      } catch { /* cache is best-effort */ }
      let reordered = null;
      if (order) {
        const byId = new Map(foodRows.map((r) => [String(r.id), r]));
        reordered = [...order.map((id) => byId.get(id)).filter(Boolean), ...foodRows.filter((r) => !order.includes(String(r.id)))];
      } else {
        const out = await llmRerankFoods({ env, query: q, rows: foodRows });
        if (out.used) {
          reordered = out.rows;
          try {
            await env.RATE_LIMIT_KV?.put(
              `foodintent:${await sha256Hex(cacheKey.join("|"))}`,
              JSON.stringify({ order: out.order }),
              { expirationTtl: 7 * 24 * 3600 }
            );
          } catch { /* cache is best-effort */ }
        }
      }
      if (reordered) {
        let i = 0;
        for (let k = 0; k < results.length; k++) if (results[k]._source === "foods") results[k] = reordered[i++];
      }
    }
  }

  if (brand) {
    const brandMatches = await fuzzyPackagedSearch(db, brand, { maxResults, minSimilarity, field: "brand" });
    for (const m of brandMatches) results.push({ ...m.packaged_food, _source: "packaged_foods", _match_type: "brand", _score: m.score });
  }

  if (ingredient) {
    const ingredientMatches = await fuzzyPackagedSearch(db, ingredient, { maxResults, minSimilarity, field: "ingredients" });
    for (const m of ingredientMatches) results.push({ ...m.packaged_food, _source: "packaged_foods", _match_type: "ingredient", _score: m.score });
  }

  // Each source above is already capped at maxResults individually; when
  // more than one of q/category/brand/ingredient is given at once, results
  // combine across sources rather than truncating to a single maxResults
  // total, so a brand=+ingredient= combo (say) doesn't starve one tier of
  // the other's budget.
  return success(results, {
    count: results.length,
    ...(q ? { query: q } : {}),
    ...(category ? { category } : {}),
    ...(brand ? { brand } : {}),
    ...(ingredient ? { ingredient } : {}),
    ...(expandedTerms.length ? { expanded_terms: expandedTerms } : {}),
  });
}

// GET /foods/by-category?category=...&max_results=...
// Plain category browse — no query text needed. Thin wrapper over
// fuzzy_food_search(null, ..., category_filter) via fuzzyFoodSearch(db, "").
async function handleFoodsByCategory(request, url, db) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const category = (url.searchParams.get("category") || "").trim();
  if (!category) return err("'category' query param is required");

  const maxResults = Math.min(Math.max(intParam(url, "max_results", 20), 1), 100);
  const results = await fuzzyFoodSearch(db, "", { maxResults, category });
  return success(
    results.map((row) => ({ ...row, _source: "foods", _match_type: "category" })),
    { count: results.length, category }
  );
}

// GET /foods/local-categories
// The category values public.foods really uses (e.g. "Staples", "Animal", "Baby foods"), each with a
// food count. These are the values to pass to /foods/by-category and to category= on /foods and
// /foods/search. GET /foods/categories below is a different list (FatSecret's taxonomy) and its names
// do not match the local table, so don't mix the two.
async function handleFoodsLocalCategories(request, db) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const PAGE = 1000; // PostgREST's default row cap per request
  const MAX_PAGES = 10;
  const counts = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { ok, body } = await db.select("foods", { select: "category", order: "id.asc", limit: PAGE, offset: page * PAGE });
    if (!ok || !Array.isArray(body)) return err("Could not read food categories", 502);
    for (const row of body) {
      const name = typeof row.category === "string" ? row.category.trim() : "";
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    if (body.length < PAGE) break;
  }
  const categories = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return success(categories, { count: categories.length });
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
// error. qwen/qwen3.8-27b (current default below) is a PREVIEW model on
// Groq's side — fine for testing, but re-check before leaning on it hard for
// production, since preview models can be pulled without much notice.

const DEFAULT_GROQ_VISION_MODEL = "qwen/qwen3.8-27b"; // qwen3.6-27b was removed from Groq (model_not_found, Oct 2026)

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
// The micronutrient names below are shared as-is between the two lists —
// same field name in the AI schema and the DB column, matching the panel
// public.foods and public.external_foods_cache already use (see
// sql/001_add_micronutrients_to_foods.sql / 007_add_external_cache_micros.sql)
// so a packaged-food result can be displayed the same way as a local one.
const PACKAGED_FOOD_MICRONUTRIENT_FIELDS = [
  "calcium_mg", "iron_mg", "zinc_mg", "magnesium_mg", "potassium_mg",
  "folate_mcg", "vita_rae_mcg", "vitc_mg", "vitd_mcg", "vitb12_mcg", "iodine_mcg",
];
const PACKAGED_FOOD_NUTRIENT_FIELDS = [
  "energy_kcal", "protein_g", "fat_g", "saturated_fat_g",
  "carbs_g", "sugars_g", "fiber_g", "sodium_mg", "salt_g",
  ...PACKAGED_FOOD_MICRONUTRIENT_FIELDS,
];
const PACKAGED_FOOD_DB_NUTRIENT_FIELDS = [
  "energy_kcal", "protein_g", "fat_g", "saturated_fat_g",
  "carbs_g", "sugar_g", "fiber_g", "sodium_mg", "salt_g",
  ...PACKAGED_FOOD_MICRONUTRIENT_FIELDS,
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
  "calcium_mg": number|null,
  "iron_mg": number|null,
  "zinc_mg": number|null,
  "magnesium_mg": number|null,
  "potassium_mg": number|null,
  "folate_mcg": number|null,
  "vita_rae_mcg": number|null,    // Vitamin A, as printed (RAE mcg — convert from IU if that's what's printed: mcg RAE = IU / 3.3 for a mixed/food source)
  "vitc_mg": number|null,         // Vitamin C
  "vitd_mcg": number|null,        // Vitamin D
  "vitb12_mcg": number|null,      // Vitamin B12
  "iodine_mcg": number|null,
  "ingredients_text": string|null,
  "allergens": string|null,
  "confidence": number            // your own confidence 0.0-1.0 that the extracted values are accurate
}

Rules:
- If energy is printed in kJ only, convert to kcal (divide by 4.184) and note that in nothing else — just return the kcal number.
- Micronutrients (calcium, iron, zinc, magnesium, potassium, folate, vitamins A/C/D/B12, iodine) are frequently printed as "% Daily Value" / "%NRV" rather than an absolute amount — if ONLY a percentage is printed with no absolute mg/mcg figure alongside it, leave that field null rather than guessing a reference value to convert from.
- If a field is not visible or not printed in ANY photo, use null. Do not guess or invent numbers.
- If none of the photos show a legible nutrition label, set "label_detected": false and set numeric fields to null (a barcode-only or front-of-pack-only photo does not count as a legible label).
- Copy printed numbers EXACTLY as they appear (e.g. printed "3.10g" -> 3.1, "4.60g" -> 4.6). Never round, average, or substitute a "typical" value for the product type.
- Energy: only fill energy_kcal if an energy/calorie/kJ line is actually printed. If the panel shows no energy line, set energy_kcal to null — do NOT compute it from the macros.
- Units: keep the basis exactly as printed. "per 100 ml" -> "per": "100ml" (liquids such as milk, juice, oil); "per 100 g" -> "per": "100g". Never convert ml to g or relabel one as the other.
- Amounts printed as grams for a mineral (e.g. calcium "0.10g") must be converted to mg for the *_mg fields (0.10 g = 100 mg). Do not invent a different mg value.
- Read the digits character by character; if a digit is blurred or unreadable, return null for that field rather than a best guess.
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

  const res = await trackedFetch(env, "groq", "https://api.groq.com/openai/v1/chat/completions", {
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
    console.error("Groq vision request failed:", res.status, model, JSON.stringify(e).slice(0, 500));
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

async function lookupFoodCascade(db, { query, barcode, skipLocal = false }, env) {
  // 1. Local curated data
  if (query && !skipLocal) {
    // Fetch several candidates (same limit as pickBestFoodMatch's other
    // callers) and let it pick the best one — not just whichever row
    // Postgres happens to return first for a bare `limit: 1` (previously
    // this was always the lowest `id` match, e.g. "nsima" resolved to
    // food id 9, "Cassava thick porridge, (Nsima ya kondowole)", a variant
    // rarely eaten day-to-day, purely because it happened to have the
    // lowest id among ilike matches — not because it was the best match).
    const local = await db.select("foods", {
      filters: { food_name: `ilike.*${escapeLikePattern(query)}*` },
      limit: 25,
    });
    if (local.ok && local.body?.length) {
      const { match, ambiguous, alternates } = pickBestFoodMatchDetailed(local.body, query, { implied: await resolveImpliedForm(env, query) });
      if (match) {
        return {
          food: withExternalShape(match, "local"),
          source: "local",
          cached: false,
          ambiguous,
          alternates: ambiguous ? alternates.map((r) => ({ id: r.id, food_name: r.food_name })) : undefined,
        };
      }
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

  // 1.5 Fuzzy/typo-tolerant match against local curated data — catches a
  // misspelled Malawian food name (e.g. "Chinagwa" for "Chinangwa") before
  // falling through to external APIs that don't index Chichewa names
  // anyway. See fuzzyFoodSearch/sql/008_add_fuzzy_food_search.sql.
  // The shortlist is ranked by intent (preparation state, variety, dish vs ingredient), so "brown cooked
  // rice" and "Rice, Brown, Cooked" reach the same record. A row that names a DIFFERENT state or variety
  // than the one asked for ("Rice, soaked" for "cooked rice") is not returned as the answer here: the
  // lookup carries on to the wider tier (USDA/Open Food Facts/FatSecret), and only if that finds nothing
  // is the local row returned as a last resort.
  let conflictingLocal = null;
  if (query && !skipLocal) {
    const fuzzy = await fuzzyFoodSearch(db, query, { maxResults: 8, env });
    if (fuzzy[0]) {
      if (!conflictsWithQuery(fuzzy[0], query)) {
        return { food: withExternalShape(fuzzy[0], "local_fuzzy"), source: "local_fuzzy", cached: false };
      }
      conflictingLocal = fuzzy[0];
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

  if (!result) {
    return conflictingLocal
      ? { food: withExternalShape(conflictingLocal, "local_fuzzy"), source: "local_fuzzy", cached: false }
      : null;
  }

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

  // Automated ingestion pipeline (upload / enqueue / jobs) — src/ragPipeline.js.
  // Handled before parseBody because /rag/upload is multipart, not JSON.
  if (param === "upload" || param === "enqueue" || param === "jobs" || param === "webhook") {
    const parts = url.pathname.split("/").filter(Boolean);
    const jobId = parts[parts.indexOf("rag") + 2] || null;
    return await handleRagPipeline(request, url, db, env, param, jobId, { success, err });
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
    const res = await trackedFetch(env, "groq", "https://api.groq.com/openai/v1/chat/completions", {
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
  // Cap and dedupe: each term costs one Supabase call per source, and a long
  // query (e.g. one with an appended instruction) can exceed Cloudflare's
  // per-invocation subrequest limit. See src/searchTerms.js.
  const terms = keywords.length ? capSearchTerms(keywords) : [rawQuery];
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

/**
 * The form a bare food name most likely means ("rice" -> cooked, "mango" -> ripe, raw), inferred once per
 * food by the LLM and cached in KV for 30 days (a "no default" answer is cached too). Returns
 * { state?, freshness? }, null for "no clear default", or undefined when it cannot be determined (no key,
 * timeout, query already states a state): the matcher then uses its small built-in fallback. Never blocks a
 * search for longer than the model's 2.5 s timeout, and only the first search of a new food name pays it.
 */
async function resolveImpliedForm(env, query) {
  try {
    if (!env?.GROQ_API_KEY || !query) return undefined;
    const attrs = parseQueryAttributes(query);
    if (attrs.stated.state) return undefined;
    const term = retrievalTermFor(query).toLowerCase();
    if (!term || term.split(" ").length > 3 || term.length < 3) return undefined;
    const cached = await getQueryCache(env, "foodform", [term]).catch(() => null);
    if (cached && "form" in cached) return cached.form;
    const out = await inferDefaultForm({ env, term });
    if (!out.ok) return undefined;
    await env.RATE_LIMIT_KV?.put(`foodform:${await sha256Hex(term)}`, JSON.stringify({ form: out.form }), {
      expirationTtl: 30 * 24 * 3600,
    }).catch(() => {});
    return out.form;
  } catch {
    return undefined;
  }
}

/**
 * Typo-tolerant + category-filterable search over public.foods (Malawi FCT)
 * — see sql/008_add_fuzzy_food_search.sql and
 * sql/009_add_advanced_food_search.sql for the fuzzy_food_search() Postgres
 * function this wraps (pg_trgm word_similarity to shortlist via the GIN
 * trigram index, levenshtein() edit distance to rank ties; category_filter
 * and an optional query as of 009). Used by GET /foods/search and
 * GET /foods/by-category directly, and as a fallback tier in
 * lookupFoodCascade when the exact ilike match misses — catches misspelled
 * Malawian food names before falling through to external APIs that don't
 * have them. Pass an empty query with a category to browse that category
 * with no text match.
 */
async function fuzzyFoodSearch(db, query, { maxResults = 8, minSimilarity = 0.35, category = "", rankQuery = "", aliases = [], env = null } = {}) {
  if (!query && !category) return [];
  const fetchRows = async (term, width) => {
    const { ok, body } = await db.rpc("fuzzy_food_search", {
      search_term: term || null,
      max_results: width,
      min_similarity: minSimilarity,
      category_filter: category || null,
    });
    return ok && Array.isArray(body) ? body : [];
  };
  // Category browse (no text) keeps the database order.
  if (!query) return fetchRows(null, maxResults);
  // The database shortlists by per-word text similarity only. Ask for a wider shortlist, then rank it by
  // intent (src/foodMatching.js): exact/keyword match, preparation state, variety, dish vs ingredient,
  // local names, verified aliases. A bare dish name ("nsima") still leads with its everyday staple.
  // rankQuery/aliases: when this call searches an alias term, rank against what the user actually typed.
  const implied = env ? await resolveImpliedForm(env, rankQuery || query) : undefined;
  return searchFoodsRanked(fetchRows, query, { maxResults, rankQuery, aliases, implied });
}

/**
 * Typo-tolerant search over public.packaged_foods (brand name, product
 * name, or ingredients text) — see fuzzy_packaged_search() in
 * sql/009_add_advanced_food_search.sql. Returns
 * [{ packaged_food, matched_field, score }, ...]; approved rows only.
 * Used by GET /foods/search's brand= and ingredient= params.
 */
async function fuzzyPackagedSearch(db, query, { maxResults = 8, minSimilarity = 0.3, field = "all" } = {}) {
  if (!query) return [];
  const { ok, body } = await db.rpc("fuzzy_packaged_search", {
    search_term: query,
    max_results: maxResults,
    min_similarity: minSimilarity,
    search_field: field,
  });
  return ok && Array.isArray(body) ? body : [];
}

/**
 * Cheap as-you-type substring match over public.foods.food_name (see
 * autocomplete_food_names() in sql/009_add_advanced_food_search.sql), with
 * a fuzzy_food_search() backfill for typo tolerance when the substring
 * match alone falls short of maxResults — e.g. "chikondi" mistyped as
 * "chikondy" still surfaces something once the substring tier comes up empty.
 */
async function autocompleteFoodsLocal(db, prefix, maxResults) {
  if (!prefix) return [];
  // Same staple preference as fuzzyFoodSearch: widen, put maize first for a bare "nsima", trim.
  const staple = defaultStapleFor(prefix);
  if (!staple) return autocompleteFoodsLocalRaw(db, prefix, maxResults);
  const rows = await autocompleteFoodsLocalRaw(db, prefix, Math.min(maxResults * 3, 30));
  return preferDefaultStaple(rows, prefix).slice(0, maxResults);
}

async function autocompleteFoodsLocalRaw(db, prefix, maxResults) {
  const { ok, body } = await db.rpc("autocomplete_food_names", { prefix, max_results: maxResults });
  const substringMatches = ok && Array.isArray(body) ? body : [];
  if (substringMatches.length >= maxResults) return substringMatches;

  const seenIds = new Set(substringMatches.map((r) => r.id));
  const fuzzyMatches = await fuzzyFoodSearch(db, prefix, { maxResults: maxResults - substringMatches.length, minSimilarity: 0.3 });
  for (const row of fuzzyMatches) {
    if (!seenIds.has(row.id)) {
      seenIds.add(row.id);
      substringMatches.push(row);
    }
  }
  return substringMatches;
}

/**
 * Cheap as-you-type substring match over packaged_foods.product_name/
 * brand (see autocomplete_packaged_names() in
 * sql/009_add_advanced_food_search.sql). Approved rows only. Returns
 * [{ packaged_food, matched_field }, ...].
 */
async function autocompletePackagedLocal(db, prefix, maxResults) {
  if (!prefix || maxResults <= 0) return [];
  const { ok, body } = await db.rpc("autocomplete_packaged_names", { prefix, max_results: maxResults });
  return ok && Array.isArray(body) ? body : [];
}

/**
 * Looks up which food_synonyms group(s) `term` belongs to and returns every
 * OTHER term in those groups (deduped, original term excluded) — see the
 * food_synonyms table comment in sql/009_add_advanced_food_search.sql for
 * why this is a plain query-expansion table rather than a foods.id link.
 * Used to bridge Chichewa<->English and other local-name searches: a query
 * for "chinangwa" also re-runs the search for "cassava", and vice versa.
 */
async function expandSynonyms(db, term, { exact = false } = {}) {
  if (!term) return [];
  const normalized = term.trim().toLowerCase();
  if (!normalized) return [];

  // exact: the whole term must equal a synonym term (used per word of a multi-word query, where a
  // substring match would pull in groups that merely contain the word).
  const { ok: groupsOk, body: groupRows } = await db.select("food_synonyms", {
    filters: { term: exact ? `ilike.${escapeLikePattern(normalized)}` : `ilike.*${escapeLikePattern(normalized)}*` },
    select: "group_key",
    limit: 10,
  });
  if (!groupsOk || !Array.isArray(groupRows) || !groupRows.length) return [];

  const groupKeys = [...new Set(groupRows.map((r) => r.group_key))];
  const { ok: termsOk, body: termRows } = await db.select("food_synonyms", {
    filters: { group_key: `in.(${groupKeys.map((g) => `"${g}"`).join(",")})` },
    select: "term",
    limit: 100,
  });
  if (!termsOk || !Array.isArray(termRows)) return [];

  const related = [...new Set(termRows.map((r) => r.term.trim().toLowerCase()))].filter(
    (t) => t && t !== normalized
  );
  return related;
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
    const res = await trackedFetch(env, "cohere", "https://api.cohere.com/v1/rerank", {
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

  const systemPrompt = `You are Chakudya AI, a grounded nutrition assistant for Malawi's Chakudya Nutrition Registry. Answer ONLY using the numbered context snippets provided by the user. When a numeric nutrient or serving-size value is available from a malawi_fct or packaged_foods snippet AND a knowledge_base snippet disagrees with it, use the malawi_fct/packaged_foods value and ignore the conflicting knowledge_base figure — malawi_fct/packaged_foods come from Chakudya's own structured registry (any "Household serving(s)" figures on a malawi_fct snippet are already correctly computed for that food's real serving weight), while knowledge_base snippets are unstructured reference documents that may define a household measure differently. Only fall back to a knowledge_base value when no malawi_fct/packaged_foods snippet covers that food at all. When knowledge_base snippets come from a Malawi Ministry of Health or other Malawi national guideline (the snippet title says so, for example \"Malawi Ministry of Health\" or \"Ncst Guidelines\") and a knowledge_base snippet from a non-Malawi reference covers the same point differently, build the answer on the Malawi guideline and keep its category labels and groupings exactly as written (for example Choose, Choose carefully, Limit): do not move a food into a stricter or looser category because the other snippet does. Add the other reference's different or stricter advice only as a separate short sentence with its own citation, or leave it out. Where the Malawi guideline is silent on a point, use the other snippets as usual. Never add your own category names or descriptions for a food that the snippets do not use (for example, do not call a plant oil animal-derived). Do not repeat the same citation number twice in one sentence. Cite the snippet number(s) you used inline in plain ASCII square brackets only — [1] or [2][3], using the standard "[" and "]" characters, never full-width or other Unicode bracket variants — that bracketed number is the only attribution you should ever give. Never write phrases like "based on the context", "according to the source/document/snippet", "the text states", "as shown in", or similar attribution wording in the body of the answer; state facts directly and naturally, as though they were your own knowledge, and let the bracketed citation do the attribution work. If the snippets don't contain enough information to answer confidently, say so plainly instead of guessing — do not invent nutrient values, brand details, or clinical guidance that isn't in the context. Keep answers concise and clinically accurate for a Malawian dietetics context.`;
  const userPrompt = `Context:\n${contextBlock}\n\nQuestion: ${query}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let fullAnswer = "";

  try {
    for (let attempt = 0; attempt <= MAX_ANSWER_CONTINUATIONS; attempt++) {
      const res = await trackedFetch(env, "groq", "https://api.groq.com/openai/v1/chat/completions", {
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
    // Append pre-computed household-serving figures (Serving-Size
    // Intelligence — buildServingSizes()) alongside the raw per-100g row,
    // so the LLM has a ready, correct "1 chunk (200g) = X kcal" number for
    // this exact food instead of doing its own arithmetic from per-100g
    // columns, or reaching for a differently-defined serving weight out of
    // a knowledge_base document (see v1.20.1's weight_g/measure trust fix —
    // this is what makes that fix actually reach RAG answers, not just the
    // structured /foods endpoints).
    const servingLines = buildServingSizes(row)
      .filter((s) => s.source !== "reference")
      .map((s) => `${s.label} = ${Object.entries(s.nutrients).map(([k, v]) => `${k}: ${v}`).join(", ")}`)
      .join(" | ");
    const text = servingLines ? `${rowToText(row)}. Household serving(s) — ${servingLines}` : rowToText(row);
    candidates.push({ source: "malawi_fct", title: row.food_name || "Food", text, score: null });
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
    const res = await trackedFetch(env, "groq", "https://api.groq.com/openai/v1/chat/completions", {
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

/** Runs a check and adds how long it took (ms), for the health history and the /health response. */
async function timedCheck(fn) {
  const t = Date.now();
  const r = await fn();
  return r.status === "not_configured" ? r : { ...r, ms: Date.now() - t };
}

/** The checks behind GET /health, shared with the scheduled probe (src/healthMonitor.js). */
async function collectHealth(env) {
  const [supabase_, cohere_, groq_, openFoodFacts_] = await Promise.all([
    timedCheck(() => checkSupabase(env)),
    timedCheck(() => checkCohere(env)),
    timedCheck(() => checkGroq(env)),
    timedCheck(() => checkOpenFoodFacts()),
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
  return { services, degraded };
}

async function handleHealth(request, env) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const { services, degraded } = await collectHealth(env);

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
    api_key_required: true,
    name: "Chakudya Nutrition Registry (CNR)",
    tagline: "Malawi's Intelligent Food & Nutrition Knowledge Platform",
    version: CNR_VERSION,
    maintainer: "Edison Taimu",
    auth:
      "Every operational route needs 'Authorization: Bearer <API key>': a free consumer key from the developer console, or an admin/reviewer key. Works without a key: GET /, GET /health and the FHIR conformance reads (GET /fhir/metadata, /fhir/CodeSystem/{name}, /fhir/OperationDefinition/{id}, /fhir/StructureDefinition/{name}, /fhir/ConceptMap/{id}, /fhir/Questionnaire). /developer/keys takes your Supabase login token instead of an API key, and POST /rag/webhook takes a shared secret. Registry writes (foods, exchange, renal, formulas, drug-interactions, glycaemic-index and the WHO/Fenton reference tables, packaged CRUD and review, RAG ingest/upload/delete, bulk inserts, key management) additionally need an admin key; the packaged review queue also accepts a reviewer key. POST /packaged/submit, /packaged/scan, /rag/retrieve, /rag/ask, /memory/write, /memory/recall and the other compute and user-data routes need a consumer key (or any admin key), not an admin one.",
    open_endpoints: [
      "GET /",
      "GET /health",
      "GET /fhir/metadata and the other FHIR conformance reads (CodeSystem, OperationDefinition, StructureDefinition, ConceptMap, Questionnaire)",
    ],
    // Rate limiting and the RAG/memory query cache both fail OPEN (silently)
    // if RATE_LIMIT_KV isn't bound — meaning the API keeps working but with
    // no rate limiting and no caching, and nothing else would tell you that.
    // Check this flag after any deploy or dashboard binding change instead
    // of finding out the hard way via a manual MISS/HIT test cycle.
    kv_bound: !!env?.RATE_LIMIT_KV,
    endpoints: {
      health: [
        "GET  /health           (no key needed, rate-limited) → pings Supabase/Cohere/Groq/Open Food Facts in parallel, reports per-service status + overall healthy/degraded",
      ],
      developer_keys: [
        "POST   /developer/keys       (login token) → body {label}; creates a consumer key (max 3 active per account, email must be confirmed); returns the raw key ONCE",
        "GET    /developer/keys       (login token) → your active keys with last-used time and usage counts",
        "DELETE /developer/keys/:id   (login token) → revoke one of your keys",
        "Send your Supabase login access token as 'Authorization: Bearer <token>' on these three routes only. Consumer keys then go on every other route the same way and get 3x the standard rate limit.",
      ],
      admin_keys: [
        "POST   /energy/requirements   (API key) → body {sex, age_years|age_months, weight_kg, height_cm, activity_factor?: minimal|moderate|strenuous, pal?|pal_category?|activities?, stress?: [{id: fever|custom, ...}], measured_ree_kcal?, pregnancy?, lactation?} → REE, stress, activity, every applicable IOM equation and one recommended figure with the reason",
        "POST   /energy/food-energy     (API key) → body {protein_g, fat_g, carbohydrate_g, alcohol_g} or {weight_g, protein_pct, fat_pct, carbohydrate_pct} or {alcohol: {volume_oz, proof|abv_percent}} → kcal, kJ, per-nutrient breakdown",
        "GET    /activity-energy        (API key) → ?q=, ?activity=, ?weight_kg= or ?weight_lb= → activity list from the database; with a weight, kcal per hour at that weight",
        "POST   /activity-energy/calculate (API key) → body {weight_kg|weight_lb, activities: [{activity, type?, minutes|hours}]} → kcal per activity and total (Krause 16th ed. Appendix 10)",
        "GET    /pregnancy/reference     (API key) → chapter 14 tables: weight gain (Table 14.11), energy add-ons, protein, twins (14.12), lab ranges (14.4), anemia (14.5), GDM (14.14), preeclampsia (Box 14.4), adolescent risks, lactation, known issues. Optional ?section=",
        "POST   /pregnancy/gestational-age (API key) → body one of {lmp | edd | ga_weeks (+ga_days)} [+reference_date, default today UTC] → weeks+days, trimester, EDD, milestones (dating conventions are not from the chapter)",
        "POST   /pregnancy/weight-gain   (API key) → body {pre_pregnancy_weight_kg + height_cm | prepregnancy_bmi, multiples?, age_years?, current_weight_kg + lmp|edd|ga_weeks?, weigh_ins?: [{date, weight_kg}] + lmp|edd} → category, IOM total and weekly rate, twins, status at the gestational age",
        "POST   /pregnancy/plan          (API key) → body {status: pregnant|lactating, age_years (14-50), pre_pregnancy_weight_kg, height_cm, pal_category|pal|activities|activity_factor | maintenance_kcal, pregnant: lmp|edd|ga_weeks, current_weight_kg?, multiples?; lactating: months_postpartum} → energy from /energy/requirements, protein, DRI targets, twin table, lactation rules",
        "POST   /pregnancy/assess        (API key) → body {lmp|edd|ga_weeks|trimester, hemoglobin_g_dl?, hematocrit_percent?, altitude_m?, smoker?, labs?: {...}, glucose?: {test, ...}, blood_pressure?: {systolic_mmhg, diastolic_mmhg, ...}} → anemia, Table 14.4 labs, GDM test, preeclampsia criteria (each section independent)",
        "GET    /renal-nutrition/reference     (API key) → ?section= kdoqi_2020|legacy_krause|labs|adequacy|weight_adjustment|monitoring|ckd_stages|emergency_diet|known_issues: KDOQI 2020 statements, Krause Tables 35.9 and 35.10, where the two disagree.",
        "GET    /renal-nutrition/emergency-diet (API key) → Box 35.3 emergency dialysis diet: choices per day, kit, storage.",
        "POST   /renal-nutrition/stage         (API key) → body {sex, age_years, creatinine_mg_dl|creatinine_umol_l, acr_mg_g?} → CKD-EPI 2021 eGFR, G and A category, the status to send to /requirements.",
        "POST   /renal-nutrition/requirements  (API key) → body {status: ckd_1_2|ckd_3_5|hd|pd|transplant, weight_kg, height_cm?, sex?, diabetes?, ckd_stage?, edema_free_weight_kg?, weight_basis?} → KDOQI 2020 protein, energy, sodium, calcium, bicarbonate, K and P rules with amounts per day, plus legacy_krause.",
        "POST   /renal-nutrition/labs          (API key) → body {labs: {potassium_meq_l, phosphorus_mg_dl, ...SI keys accepted}, context?: dialysis|general, diabetes?, on_epo?} → low/in range/high with the diet action, Ca x P product.",
        "POST   /renal-nutrition/adequacy      (API key) → body {modality: hd|pd, pre_bun_mg_dl+post_bun_mg_dl, session_hours+uf_litres+post_weight_kg?, ekt_v?, weekly_kt_v?, npna?, pre_dialysis_weight_kg+dry_weight_kg?} → URR, Kt/V, eKt/V, nPNA, interdialytic weight gain against targets.",
        "POST   /renal-nutrition/plan          (API key) → body {status|creatinine+sex+age_years, weight_kg, labs?, adequacy?, ...} → stage, requirements, labs, adequacy and the KDOQI monitoring schedule in one call.",
        "POST   /renal-nutrition/food-plan     (API key) → body = /requirements body + {exchange_type?, q?, limit?, share_flag_pct?, potassium_mg_per_day_max?, phosphorus_mg_per_day_max?, legacy_krause_limits?} → each exchange_lists item as % of the daily protein, sodium, potassium and phosphorus limits, per-group exchanges that fit, and the matching renal_foods row. Read only.",
        "GET    /diabetes/reference           (API key) → ?section= diagnosis|a1c_eag|glycemic_targets|pregnancy_targets|hypoglycemia|insulin_rules|insulin_action_times|exercise|sick_day|nutrition_recommendations|food_list_values|medication_nutrition|known_issues",
        "POST   /diabetes/status              (API key) → body {a1c_percent|a1c_mmol_mol, fpg_mg_dl|fpg_mmol_l, ogtt_2h_mg_dl|ogtt_2h_mmol_l, random_mg_dl|random_mmol_l, classic_symptoms?, a1c_unreliable?} → normal|prediabetes|diabetes (KR Table 30.1) and eAG.",
        "POST   /diabetes/glucose-targets     (API key) → body {population?: nonpregnant_adult|pregnancy} → ADA 2026 A1C, pre/postprandial and CGM targets, or pregnancy targets.",
        "POST   /diabetes/carb-plan           (API key) → body {carb_g_per_day | energy_kcal+carb_pct | sex, meals?, snacks?, population?: general|gdm, meal_weights?} → carbohydrate per meal and snack in grams and 15 g exchanges.",
        "POST   /diabetes/carb-count          (API key) → body {total_carb_g, fibre_g?, sugar_alcohol_g?, servings?} → counted carbohydrate from a food label (KR half-fibre rule).",
        "POST   /diabetes/exchange-plan       (API key) → body {exchanges?: {type: n}, meals?: {meal: {type: n}}, carb_plan?: {...}, exchange_type?, q?, limit?} → links carbohydrate targets to exchange_lists. Read only.",
        "POST   /diabetes/glycemic-load       (API key) → body {foods: [{food, carbs_g, gi?}]} → GI from glycaemic_index_data, GL per food and meal. Read only.",
        "POST   /diabetes/insulin             (API key) → body {tdd_units|icr_g_per_unit+cf_mg_dl_per_unit, carbs_g?, current_glucose_mg_dl?, target_glucose_mg_dl?} → 500 and 1700 rules, mealtime and correction dose. Starting estimate for the prescriber.",
        "POST   /diabetes/hypoglycemia        (API key) → body {glucose_mg_dl|glucose_mmol_l, assistance_needed?, able_to_swallow?, on_alpha_glucosidase_inhibitor?} → ADA level 1-3 and treatment steps.",
        "POST   /diabetes/exercise            (API key) → body {duration_min, on_insulin_or_secretagogue?, pre_exercise_glucose_mg_dl?, intensity?, ketones_present?} → extra carbohydrate for activity.",
        "POST   /diabetes/plan                (API key) → body {labs?, population?, carb?: {...}} → status, glucose targets and carbohydrate plan in one call.",
        "GET    /weight-management/reference   (API key) → chapter 21 tables: BMI classes, Table 21.3 risk, metabolic syndrome, rate bands, energy floors, AMDR, diet adequacy, activity targets, Table 21.11/21.12, known issues. Optional ?section=",
        "GET    /weight-management/bariatric   (API key) ?procedure=lagb|lsg|rygb|bpd_ds [&sex=&childbearing_age=true&pregnant=true] → diet stages (Table 21.9) and vitamin/mineral supplementation (Table 21.10, misprints flagged)",
        "POST   /weight-management/assess      (API key) → adult {sex, age_years, weight_kg, height_cm, waist_cm?, hip_cm?, body_fat_percent?, usual_weight_kg+period_days?, comorbidity_count?, systolic_mmhg?, diastolic_mmhg?, triglycerides_mg_dl?, hdl_mg_dl?, fasting_glucose_mg_dl?} or child (2-18 y) {sex, age_years, weight_kg, height_cm | bmi_for_age_percentile, secondary_complications?} → BMI class, risk, metabolic syndrome, treatment options or age-based goal",
        "POST   /weight-management/loss-plan   (API key) → {sex, age_years, weight_kg, height_cm, pal_category|pal|activities|activity_log|activity_factor | maintenance_kcal, deficit_kcal? (500-1000) | intake_kcal?, target_weight_kg?, comorbidity_count?} → intake, rate, 5%/10% goals, protein 1.2 g/kg, macros, maintenance at goal; refuses under 800 kcal, age 65+, BMI under 25, pregnancy",
        "POST   /weight-management/gain-plan   (API key) → {sex, age_years, weight_kg, height_cm, activity inputs | maintenance_kcal, surplus_kcal? (500-1000), target_weight_kg?} → maintenance + 500-1000 kcal, protein 12-15% and fat 30%, rate, target range, Table 21.12 boosters; refuses BMI 25 or more",
        "POST   /weight-management/progress    (API key) → {goal: loss|gain|maintain, weigh_ins: [{date, weight_kg}], height_cm?, start_weight_kg?, target_weight_kg?, recent_days?, weight_before_loss_kg?} → % change, rate vs guideline, 5%/10% milestones, plateau, maintenance check",
        "POST   /weight-management/diet-pattern (API key) → {carbohydrate_g, protein_g, fat_g, alcohol_g?, weight_kg?, age_years?, energy_restriction?, vlcd?} → energy, AMDR comparison, pattern tags, nutrients at risk, protein g/kg",
        "GET    /sports/reference        (API key) → chapter 23 tables: activity factors, kcal/kg tiers, macro targets, fuel timing, hydration, body-fat standards, known chapter issues",
        "POST   /sports/energy           (API key) → body {weight_kg, lean_body_mass_kg | body_fat_percent, activity_level (sedentary|lightly_active|moderately_active|very_active|extra_active) | activity_multiplier, exercise?: [{mets, minutes}], activity_log?: [{activity, type?, minutes|hours}], tef?, sex?, age_years?, height_cm?} → Cunningham REE, activity, TEF, total kcal, kcal/kg check",
        "POST   /sports/macros           (API key) → body {weight_kg, profile: general_fitness|general_training|endurance|elite_endurance|resistance_hypertrophy, energy_kcal?, age_years?, intake?: {carbohydrate_g, protein_g, fat_g}} → g and g/kg ranges, protein per meal, AMDR and intake checks",
        "POST   /sports/fuel-timing      (API key) → body {weight_kg, duration_min?, hours_before_event?, recovery_hours?, drink?: {carbohydrate_g, serving_g|serving_ml}} → pre-event, during-exercise and recovery carbohydrate, drink concentration check",
        "POST   /sports/hydration        (API key) → body {weight_before_kg, weight_after_kg, fluid_intake_ml?, urine_ml?, duration_min?, urine_specific_gravity?, age_years?, ambient_c?, hours_to_next_session?} → body-mass loss %, rehydration volume, sweat estimate, in-exercise fluid and sodium, urine SG band",
        "POST   /sports/body-composition (API key) → body {sex, weight_kg, body_fat_percent, age_years?, target_weight_kg?} → fat and lean mass, lowest safe and highest optimal weight, weekly loss/gain rates, weeks to target",
        "POST   /sports/supplement-dose  (API key) → body {weight_kg, age_years, supplements?: [caffeine|creatine|beta_alanine|hmb|beetroot_juice], pregnant?, lactating?} → chapter doses; withheld under 18, pregnant or nursing",
        "POST   /sports/plan             (API key) → one athlete: top-level body and activity fields plus optional profile, event, hydration, weight_goal, supplements objects → each section as its own endpoint would return it",
        "POST   /surveillance/records    (API key) → one anonymised screening record, or {records:[...]} up to 100: {submission_id, consent_confirmed:true, observed_on?, district, sex?, age_months|age_years, setting?, source?, measurements?:{weight_kg,length_cm|height_cm,muac_cm}, outcomes?:{...}}; measurements are classified (WHO) and discarded; unknown fields are rejected; needs SURVEILLANCE_STORE=true and sql/037",
        "GET    /surveillance/reference  (API key) → districts, population groups, indicators and statuses, accepted fields, privacy rules, method notes",
        "GET    /surveillance/summary    (admin key) → records by group, setting and region, districts reporting, national prevalence per indicator (?from=&to=&months=)",
        "GET    /surveillance/hotspots   (admin key) → districts significantly above the national figure for an indicator (?population_group=&indicator=&min_n=); pass indicator to list every district",
        "GET    /surveillance/trends     (admin key) → monthly series, trend test and change vs the same month last year (?indicator= required, ?population_group=&district=&months=)",
        "GET    /surveillance/alerts     (admin key) → early warning: districts where the recent months are higher than the baseline (?recent_months=3&baseline_months=9&min_increase_pp=2)",
        "GET    /surveillance/insights   (admin key) → hotspots, rising districts, national trends and data gaps as prioritised insights with suggested actions and research questions",
        "GET    /energy/factors         (API key) → activity and stress factors, PAL categories, activity table, IOM equations, reference tables",
        "GET    /admin/usage      (root key only) → calls per endpoint, daily totals, top routes and estimated p95 latency from route_usage (?days=, max 30); needs ROUTE_USAGE_STORE=true and sql/032 (sql/036 for p95)",
        "GET    /admin/health-history (root key only) → uptime %, per-upstream uptime and latency, outage timeline from the 5-minute health probe (?hours=, max 720); needs HEALTH_CHECK_STORE=true and sql/034",
        "GET    /admin/monitoring (root key only) → failed calls and slow endpoints from request_log (?hours=, max 168); needs REQUEST_LOG_STORE=true and sql/031",
        "GET    /admin/activity   (root key only) → recent admin actions: keys created/revoked, packaged foods approved/rejected (?limit=, max 100)",
        "GET    /admin/overview   (root key only) → read-only snapshot for the admin monitor: registry record counts, packaged review queue, RAG ingest jobs, API key and usage totals",
        "GET    /admin/keys       (root key only) → list keys (never returns the raw key or its hash)",
        "POST   /admin/keys       (root key only) → body {label, role?}; role: admin (default, full access) | reviewer (packaged review + reads only); returns the raw key ONCE, store it now",
        "DELETE /admin/keys/:id   (root key only) → revoke (soft — sets revoked_at, doesn't delete the row)",
      ],
      foods: [
        "GET  /foods?search=...&category=...  → list/search results are trimmed to identity + amount (measure/weight_g) + energy + macros + micros (see FOODS_SEARCH_FIELDS); GET /foods/:id still returns the full row incl. mfct_code/moisture_g/etc.",
        "GET  /foods?with_servings=true",
        "GET  /foods/:id?with_servings=true     → add ?with_servings=true for a serving_sizes[] array (household measures, e.g. \"1 cup\", each with nutrients pre-scaled from the 100g basis)",
        "GET  /foods/lookup?q=...|barcode=...&with_servings=true&tier=wider   (API key, rate-limited) → CNR's wider data tier: local cache → USDA FDC → Open Food Facts → FatSecret; ?with_servings=true adds serving_sizes[] as above. ?tier=wider skips the local/fuzzy steps and forces USDA/OFF/FatSecret directly — for when the local Malawi FCT entry is a different preparation than what was actually asked for (e.g. 'rice, cooked' vs. the local 'Rice, soaked' entry). All sources now include fiber + the same micronutrient panel as public.foods where available — FatSecret is the exception for vitamin_a/vitamin_c/calcium/iron specifically (its API only gives %DV for those four, not absolute values, so they're left null rather than guessed; see raw_data.*_pct_dv on fatsecret-sourced results)",
        "GET  /foods/search?q=&max_results=&min_similarity=&category=&brand=&ingredient=  (API key, rate-limited) → typo-tolerant local search over public.foods (pg_trgm word_similarity + levenshtein ranking, see sql/008_add_fuzzy_food_search.sql + sql/009_add_advanced_food_search.sql), expanded through food_synonyms (Chichewa<->English + local-name aliases — a search for 'chinangwa' also searches 'cassava'). category= filters/narrows the q search (or, with no q, browses that category). brand= and ingredient= search packaged_foods.brand/.ingredients_text instead (brand search, search-by-ingredient) and merge into the same results array. Every result is tagged _source ('foods'|'packaged_foods') and _match_type ('fuzzy'|'synonym'|'category'|'brand'|'ingredient'). No external API calls, never caches an external result — purely local. Also used internally as a fallback tier in lookupFoodCascade (/foods/lookup and everything built on it) when the exact ilike match misses.",
        "GET  /foods/by-category?category=...&max_results=  (API key, rate-limited) → plain category browse over public.foods, no query text needed",
        "GET  /foods/baby-foods?search=&limit=&cursor=  (API key, rate-limited) → only the \"Baby foods\" rows (infant cereals, jarred baby food). GET /foods?search= leaves these out unless the query has a baby word, category=Baby foods, or include_baby_foods=true",
        "GET  /foods/local-categories           (API key, rate-limited) → the category values public.foods actually uses, each with a count; use these with /foods/by-category and category=",
        "GET  /foods/autocomplete?q=...&max_results=  (API key, rate-limited) → local-first as-you-type suggestions: Malawi FCT + packaged foods (brand/product) substring match, backfilled with fuzzy search for typo tolerance ('nsim' -> Nsima, Nsima ya chimanga, Nsima ya kondowole, ...), then food_synonyms expansion, then FatSecret Premier suggestions last for anything with no local coverage (skipped, not fatal, if FatSecret isn't configured)",
        "GET  /foods/categories                 (API key, rate-limited, cached 24h) → FatSecret Premier food category list (a different taxonomy from the local table; see /foods/local-categories)",
        "GET  /foods/substitutes?food_name=chicken&limit=  (API key, rate-limited, cached 1h) → Malawi-specific substitution suggestions, ranked by nutritional closeness, with a full nutrient comparison vs the original — see SUBSTITUTION_GROUP_OVERRIDES",
        "GET  /foods/convert?q=rice&amount=2&unit=cup   (API key, rate-limited, cached 1h; also GET /foods/:id/convert?amount=&unit= and ?id=) → one food, one amount, either way round. Give a household measure (tsp, tbsp, dsp, h dsp, cup, us cup, scoop 16, chipande, piece, slice ...) and get the standard weight; give a standard measure (g, kg, oz, lb, ml, l, fl oz) and get the household equivalents. Always returns standard {grams, kilograms, milliliters, other_weight_units}, household {servings[] (the food's own chipande/cup/piece as fractional counts), volume {suggested, all[]} (spoons and cups, only when the food has a density from its own cup/spoon serving)}, nutrients for that amount, density_g_per_ml, and assumptions[] (1 g/ml is assumed and flagged for a volume with no density on file). Same food matching and gram conversion as POST /recipes/calculate. 'cup' is the 250 ml metric household cup (UCT guide); 'us cup' is 240 ml (Krause). amount accepts 2, 0.5, 1/2, 1 1/2",
        "GET  /foods/compare?foods=nsima,rice,potatoes  (API key, rate-limited, cached 1h) → 2-6 foods side by side: per-100g energy/protein/carbs/fiber/fat/full micronutrient panel + nutrient_comparison (highest/lowest flagged per nutrient) + glycaemic block from glycaemic_index_data where a sourced GI/GL value exists (never estimated)",
        "GET  /foods/:id/label?serving=  (API key, rate-limited, cached 1h) → Codex-oriented nutrition label for one food. References CXS 1-1985 (General Standard for the Labelling of Pre-packaged Foods, `labelling_standard`) and CXG 2-1985 (Guidelines on Nutrition Labelling, `nutrition_labelling_guideline`) separately. Legacy flat fields (serving_size, calories, total_fat_g, saturated_fat_g, carbohydrates_g, fiber_g, sugars_g, protein_g, sodium_mg, vitamins_minerals, standard) are unchanged; adds energy_kcal/energy_kj, a structured nutrition_declaration and vitamins_minerals_detail (each field paired with status: available/not_available/estimated — a genuine 0 is never shown as missing, and 'estimated' only appears where the source FCT's data_quality_flags itself flags that value as assumed), per_100g_reference (the raw 100g basis a scaled serving was derived from), and a calculation block (serving_weight_source: measured/estimated, value_basis: direct_from_database/calculated_from_per_100g_reference). Defaults to the most specific serving Serving-Size Intelligence has (chipande/mtanda, cup, tablespoon, handful, piece, etc. — see SERVING_SIZE_KEYWORDS); ?serving= picks another by label text (e.g. ?serving=100g) — an unrecognized ?serving= falls back to the default rather than erroring, flagged via requested_serving.matched=false. missing_fields flags any mandatory value this food doesn't have data for. Invalid (non-numeric) food IDs and non-positive serving weights return 400/422 with a clear message. POST /recipes/calculate returns the same nutrition_label shape for a whole recipe (its own per-serving totals — no single food row, so no per_100g_reference or quality-flag-based 'estimated' status there)",
        "POST /foods            (admin)",
        "POST /foods/bulk       (admin) → body {items:[...]}, max 500, batch insert in one request",
        "PUT  /foods/:id        (admin)",
        "PATCH /foods/:id       (admin)",
        "DELETE /foods/:id      (admin)",
      ],
      glycaemic_index: [
        "GET  /glycaemic-index?search=...      → published GI/GL reference rows (see sql/004_add_glycaemic_index.sql); backs the glycaemic block on GET /foods/compare",
        "GET  /glycaemic-index/:id",
        "POST /glycaemic-index         (admin) → requires food_name, match_keywords[], source (citation) — no GI/GL value accepted without a traceable source",
        "POST /glycaemic-index/bulk    (admin) → body {items:[...]}, max 500; seed file: scripts/glycaemic_index_seed.json",
        "PUT  /glycaemic-index/:id     (admin)",
        "PATCH /glycaemic-index/:id    (admin)",
        "DELETE /glycaemic-index/:id   (admin)",
      ],
      bmi_for_age: [
        "GET  /bmi-for-age/classify?sex=girls&age_months=95&weight_kg=26&height_cm=121.1  → WHO 2007 BMI-for-age status for 5y 1m to 19y 0m (or pass &bmi= instead of weight/height); screening aid, see sql/012_add_bmi_for_age.sql",
        "GET  /bmi-for-age?sex=&age_months=   → raw reference rows (-3SD to +3SD cut-offs)",
        "POST /bmi-for-age/bulk        (admin) → body {items:[...]}, 336 rows; seed file: scripts/bmi_for_age_seed.json",
      ],
      hc_velocity: [
        "GET  /hc-velocity/classify?sex=girls&start_age_months=3&hc_start_cm=40.2&hc_end_cm=44.0  → WHO 6-month head circumference increment band (0-24 months; or pass &increment_cm= instead); screening aid, see sql/018_add_who_hc_velocity.sql",
        "GET  /hc-velocity?sex=&start_age_months=   → raw reference rows (-3SD to +3SD increments, cm)",
        "POST /hc-velocity/bulk        (admin) → body {items:[...]}, 38 rows; seed file: scripts/who_hc_velocity_seed.json",
      ],
      length_velocity: [
        "GET  /length-velocity/classify?sex=girls&start_age_months=3&length_start_cm=61.0&length_end_cm=71.3  → WHO 6-month length increment band (0-24 months; or pass &increment_cm= instead); screening aid, see sql/019_add_who_length_velocity.sql",
        "GET  /length-velocity?sex=&start_age_months=   → raw reference rows (-3SD to +3SD increments, cm)",
        "POST /length-velocity/bulk    (admin) → body {items:[...]}, 38 rows; seed file: scripts/who_length_velocity_seed.json",
      ],
      weight_velocity: [
        "GET  /weight-velocity/classify?sex=girls&start_age_months=3&weight_start_kg=5.8&weight_end_kg=8.2  → WHO 6-month weight increment band + exact z-score and percentile (0-24 months; or pass &increment_g= instead); screening aid, see sql/020_add_who_weight_velocity.sql",
        "GET  /weight-velocity?sex=&start_age_months=   → raw reference rows (-3SD to +3SD increments, grams, plus L/M/S/Delta)",
        "POST /weight-velocity/bulk    (admin) → body {items:[...]}, 38 rows; seed file: scripts/who_weight_velocity_seed.json",
      ],
      muac_for_age: [
        "GET  /muac-for-age/classify?sex=girls&age_months=12&muac_cm=13.5  → WHO arm circumference-for-age band + exact z-score and percentile (3-60 months; or pass &muac_mm= instead); screening aid, see sql/021_add_who_muac_for_age.sql",
        "GET  /muac-for-age?sex=&age_months=   → raw reference rows (-3SD to +3SD, cm, plus L/M/S)",
        "POST /muac-for-age/bulk    (admin) → body {items:[...]}; seed file: scripts/muac_for_age_seed.json",
      ],
      muac: [
        "GET  /muac/classify?age_months=18&muac_cm=11.8  → fixed-cut-off MUAC class (severe / moderate / normal), 6 months to adult; or pass &muac_mm=; add &scheme=cmam for the 115/125 mm community cut-offs (6-59 months). Calculation only, no table. Screening aid",
      ],
      length_height_for_age: [
        "GET  /length-height-for-age/classify?sex=girls&age_months=18&length_cm=78  → WHO length/height-for-age stunting band + exact z-score and percentile (0-228 months = birth to 19 years; length = lying under 24 months, height = standing from 24; optional &measured=lying|standing converts by 0.7 cm if needed); screening aid, see sql/022_add_who_length_height_for_age.sql",
        "GET  /length-height-for-age?sex=&age_months=   → raw reference rows (-3SD to +3SD, cm, plus L/M/S)",
        "POST /length-height-for-age/bulk    (admin) → body {items:[...]}; seed files: scripts/length_height_for_age_seed.json (124 rows, 0-60 months) and scripts/height_for_age_5_19_seed.json (336 rows, 61-228 months; run sql/023 first)",
      ],
      weight_for_age: [
        "GET  /weight-for-age/classify?sex=girls&age_months=12&weight_kg=8.5  → WHO weight-for-age underweight band + exact z-score and percentile (0-120 months = birth to 10 years; or pass &weight_g=); screening aid, see sql/024_add_who_weight_for_age.sql",
        "GET  /weight-for-age?sex=&age_months=   → raw reference rows (-3SD to +3SD, kg, plus L/M/S)",
        "POST /weight-for-age/bulk    (admin) → body {items:[...]}, 242 rows; seed file: scripts/weight_for_age_seed.json",
      ],
      weight_for_length_height: [
        "GET  /weight-for-length-height/classify?sex=girls&age_months=18&weight_kg=9.2&length_cm=78  → WHO weight-for-length (under 24 months, lying) / weight-for-height (24-60 months, standing) wasting/overweight band + exact z-score and percentile; optional &measured=lying|standing converts by 0.7 cm; screening aid, see sql/025_add_who_weight_for_length_height.sql",
        "GET  /weight-for-length-height?sex=&measured=&length_height_cm=   → raw reference rows (-3SD to +3SD, kg, plus L/M/S)",
        "POST /weight-for-length-height/bulk    (admin) → body {items:[...]}, 2404 rows in five seed parts: scripts/weight_for_length_height_seed_1.json ... _5.json (max 500 per request)",
      ],
      bmi_for_age_under_5: [
        "GET  /bmi-for-age-under-5/classify?sex=girls&age_months=18&weight_kg=9.2&length_cm=78  → WHO BMI-for-age band (0-60 months) + exact z-score and percentile; or pass &bmi= directly; optional &measured=lying|standing converts by 0.7 cm before BMI is computed; screening aid, see sql/026_add_who_bmi_for_age_under_5.sql. 5-19 years: /bmi-for-age",
        "GET  /bmi-for-age-under-5?sex=&age_months=   → raw reference rows (-3SD to +3SD, kg/m2, plus L/M/S)",
        "POST /bmi-for-age-under-5/bulk    (admin) → body {items:[...]}, 124 rows; seed file: scripts/bmi_for_age_under5_seed.json",
      ],
      hc_for_age: [
        "GET  /hc-for-age/classify?sex=girls&age_months=6&hc_cm=42  → WHO head circumference-for-age band (microcephaly / macrocephaly) + exact z-score and percentile (0-60 months; or pass &hc_mm=); screening aid, see sql/027_add_who_hc_for_age.sql. 6-month increments: /hc-velocity",
        "GET  /hc-for-age?sex=&age_months=   → raw reference rows (-3SD to +3SD, cm, plus L/M/S)",
        "POST /hc-for-age/bulk    (admin) → body {items:[...]}, 122 rows; seed file: scripts/hc_for_age_seed.json",
      ],
      growth: [
        "GET  /growth/assess?sex=girls&age_months=18&weight_kg=9.2&length_cm=78&hc_cm=45&muac_cm=13.5  → every applicable WHO indicator for the measurements given (length/height-for-age, weight-for-age, weight-for-length/height, BMI-for-age, head circumference-for-age, MUAC z-score and fixed MUAC), plus an attention list and acute-malnutrition signals; optional &measured=lying|standing and &muac_scheme=who_hiv_2008|cmam; at least one measurement required",
      ],
      fenton_preterm: [
        "GET  /fenton-preterm/classify?sex=&metric=weight|length|hc&reference_year=2013|2025&gest_age_weeks=&day=&value=  → z-score, percentile, status (2013/2025 Fenton preterm growth chart; screening aid, see sql/013_add_fenton_preterm.sql)",
        "POST /fenton-preterm/profile  → body {sex, reference_year?, gest_age_weeks, day?, weight?, length?, hc?} → classify weight+length+HC together at one timepoint (at least one metric required)",
        "POST /fenton-preterm/growth   → body {sex, metric, reference_year?, measurements:[{gest_age_weeks, day?, value}, ...]} → classified trajectory + descriptive trend (percentile-crossing flags)",
        "POST /fenton-preterm/velocity → same body shape as growth, 2+ points → g/kg/day (weight) or cm/week (length/hc) between each consecutive pair",
        "GET  /fenton-preterm/chart?sex=&metric=&reference_year=&points=28w0d:900,30w0d:1200  → server-rendered SVG growth chart image (P3/P10/P50/P90/P97 curves, optional overlay points); never returns numeric curve data",
        "GET  /fenton-preterm/references → static metadata: years, sexes, metrics, exact valid age ranges, citations, license summary — no L/M/S values",
        "No list/dump route for the raw table — licensed from Dr. Tanis Fenton (CC BY-NC-ND 4.0, non-commercial, this app only); raw L/M/S values are never returned to end users, in any of the above.",
        "POST /fenton-preterm/bulk     (admin) → body {items:[...]}, 2284 rows across 5 files; seed files: scripts/fenton_preterm_seed_1.json .. _5.json",
      ],
      fhir: [
        "GET  /fhir/metadata (no key needed) → FHIR R4 CapabilityStatement",
        "POST /fhir/Observation/$evaluate-growth → body: FHIR Parameters {sex, gestationalAgeWeeks+day OR birthDate, measurement:[{type: weight|length|hc|muac|bmi, value}, ...], measured?, muacScheme?, referenceYear?, effectiveDateTime?} → Observation or Bundle of Observations (birthDate: every WHO indicator, birth to 19 years)",
        "POST /fhir/Bundle/$nutrition-assessment → NCP step 1 foundation: Patient + Encounter + anthropometry/biochemical/clinical/dietary/NFPE Observations + QuestionnaireResponses → one linked, validated Bundle",
        "POST /fhir/QuestionnaireResponse/$validate → check a QuestionnaireResponse against a built-in form",
        "GET  /fhir/Questionnaire, /fhir/Questionnaire/{nutrition-screening|nfpe|diet-history} (no key needed) → the built-in assessment forms",
        "POST /fhir/Observation/$screen → NCP screening (MUST, adults)",
        "POST /fhir/Observation/$assess-nutrition → NCP assessment: BMI, % weight change, energy/protein needs + intake, GLIM, FH/AD/BD/PD/CH indicators",
        "POST /fhir/Condition/$diagnose → NCP diagnosis: PES statements → Condition",
        "POST /fhir/CarePlan/$intervene → NCP intervention: goals, NutritionOrder, education/counseling/coordination → CarePlan Bundle",
        "POST /fhir/Goal/$evaluate → NCP monitoring & evaluation: goal achievementStatus vs baseline/target",
        "POST /fhir/CarePlan/$monitor → NCP step 4 follow-up: Observations/QuestionnaireResponses linked to patient, encounter and plan, change from baseline, Goal status, plan-review Tasks and a draft revised CarePlan",
        "POST /fhir/Bundle/$ncp-document → complete ADIME note: Composition + document Bundle, identified and validated (structure, references, links)",
        "POST /fhir/Bundle/$care-context → NCP step 6: Organization, Practitioner, PractitionerRole and CareTeam resources (who did the work, their role, the facility, the multidisciplinary team)",
        "POST /fhir/Bundle/$validate-document → check any document Bundle; returns an OperationOutcome",
        "GET  /fhir/CodeSystem/ncp-diagnosis (no key needed) → NCP nutrition diagnostic terminology (2006 ed., NI/NC/NB; stored in Supabase table ncp_diagnosis_terms)",
        "GET  /fhir/CodeSystem/{name}, /fhir/OperationDefinition/{id}, /fhir/StructureDefinition/{name}, /fhir/ConceptMap/{id} (no key needed) → conformance resources for every canonical URL the facade emits (see /fhir/metadata)",
        "Every other /fhir operation (all the POST operations above, ConceptMap/$translate and $validate included) needs 'Authorization: Bearer <API key>' with the right FHIR scope; consumer keys carry system/*.*. GET /fhir/AuditEvent needs the admin role.",
        "Stateless facade, no storage. $evaluate-growth wraps fenton-preterm and the WHO indicators (length/height, weight, weight-for-length/height, BMI, head circumference, MUAC) from birth to 19 years. Not yet registered with any OpenHIM/HIE instance. See src/fhir.js and src/fhirNcp.js.",
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
        "POST /packaged/submit           (API key, rate-limited — community contribution, status=pending)",
        "POST /packaged/scan             (API key, rate-limited — photo of nutrition label -> OCR/AI -> status=pending)",
        "POST /packaged/:id/approve      (admin) → status=approved (optional body = field corrections)",
        "POST /packaged/:id/reject       (admin) → status=rejected (body requires 'reason')",
        "PUT  /packaged/:id              (admin)",
        "PATCH /packaged/:id             (admin)",
        "DELETE /packaged/:id            (admin)",
      ],
      rag: [
        "POST /rag/retrieve     (API key, rate-limited) → semantic search (query, context, top_k)",
        "POST /rag/ingest       (admin) → add document chunk (content, source, context)",
        "POST /rag/upload       (admin, multipart: file, source, context, replace) → auto-ingest PDF/DOCX/TXT/MD/CSV/HTML via queue",
        "POST /rag/enqueue      (admin) → {path, source} for a file already in the rag-uploads bucket, or {job_id} to retry",
        "GET  /rag/jobs[/:id]   (admin) → ingestion job status; list takes ?status=queued|processing|done|failed, ?limit= (max 100), ?offset=",
        "DELETE /rag/source?source=... (admin) → bulk-delete all chunks for one document (use before re-ingesting a fixed document, since ingest never overwrites)",
        "POST /rag/ask          (API key, rate-limited) → RAG Search Orchestrator: intent detection -> fan-out search (semantic + Malawi FCT + packaged/OCR foods + exchange/renal/formula DBs + barcode + USDA/OFF/FatSecret fallback) -> rerank -> grounded LLM answer with citations (query, context, top_k, session_id)",
      ],
      memory: [
        "POST /memory/write        (API key, rate-limited) → capture a session fact (session_id, content)",
        "POST /memory/recall       (API key, rate-limited) → top-K relevant memory for a session (session_id, query, top_k) — preferred; GET with the same params still works but is deprecated since it puts clinical text in the URL/logs",
        "POST /memory/consolidate  (admin) → summarize a session's facts (session_id) — also run hourly by cron",
      ],
      favorites: [
        "GET    /favorites?user_id=...&resource_type=...   (API key, rate-limited)",
        "POST   /favorites   (API key, rate-limited) → body {user_id, resource_type, resource_id}, idempotent",
        "DELETE /favorites   (API key, rate-limited) → body {user_id, resource_type, resource_id}",
      ],
      history: [
        "GET  /history?user_id=...&resource_type=...   (API key, rate-limited) → recently viewed, viewed_at desc",
        "POST /history   (API key, rate-limited) → body {user_id, resource_type, resource_id}, upserts viewed_at",
      ],
      food_log: [
        "GET    /log?user_id=...&date=YYYY-MM-DD   (API key, rate-limited) → diary entries, newest first; date filter optional",
        "GET    /log/:id                           (API key, rate-limited) → single entry",
        "POST   /log        (API key, rate-limited) → body {user_id, meal_type: breakfast|lunch|snack|dinner, calories, food_name?, entry_date?}",
        "DELETE /log/:id?user_id=...                (API key, rate-limited) → delete one entry (scoped to user_id)",
        "GET    /log/summary?user_id=...&period=daily|weekly&date=YYYY-MM-DD   (API key, rate-limited) → kcal totals + by_meal breakdown; weekly adds by_date[] and average_daily_calories",
      ],
      recipes: [
        "POST /recipes/calculate   (API key, rate-limited) → body {servings?, ingredients:[{food_id?|food_name, quantity, unit?}]}; resolves each ingredient (local foods, falling back to the same local→external cascade as /foods/lookup), converts quantity/unit to grams (see Serving-Size Intelligence), and returns total_nutrients + nutrients_per_serving + a per-ingredient breakdown + any unresolved_ingredients",
      ],
      paediatric: [
        "POST /paediatric/energy   (API key) → body {sex, age_months|age_years, weight_kg, height_cm?, pal_category?, activity_level?|activity_factor?, stress_condition?|stress_factor?} → Schofield and WHO 1985 BMR, BMR x activity x stress (range), DRI/FAO 2004 kcal/kg/day, IOM EER, recommended, macronutrient grams by AMDR",
        "POST /paediatric/protein   (API key) → {age_months|age_years, weight_kg, clinical_status? healthy|sick, energy_kcal?} → IOM healthy-growth and ASPEN sick-child g/kg/day and g/day",
        "POST /paediatric/fluid   (API key) → {weight_kg} → Holliday-Segar maintenance (mL/day, mL/kg/day, mL/hr)",
        "POST /paediatric/preterm   (API key) → {weight_g, monitoring?} → preterm fluid, energy and protein by weight band, and growth monitoring against targets",
        "POST /paediatric/growth-velocity   (API key) → {sex, age_months, days, weight_g_start/end, height_cm_start/end} → weight g/day and length mm/day against the reference velocity",
        "POST /paediatric/catch-up   (API key) → {sex, age_months, weight_kg, height_cm?|ideal_weight_kg?, weight_age_months?} → catch-up kcal/kg and g/kg (weight-age method; under 5 years the WHO median weight-for-length/height is read from who_weight_for_length_height) and the growth-failure stress-factor estimate",
        "POST /paediatric/enteral-feeds   (API key) → {age_months, weight_kg, route? continuous|bolus, formula_kcal_per_ml?, energy_target_kcal?} → initiation, advancement and goal for the weight, steps and hours to goal, goal volume and energy",
        "POST /paediatric/plan   (API key) → energy, protein, fluid and macronutrients in one call; optional catch_up:true or ideal_weight_kg, and feeding_route",
        "GET  /paediatric/reference[?section=]   (API key) → the tables behind the calculators and their sources. /pediatric works as an alias",
      ],
      "enteral-nutrition": [
        "POST /enteral-nutrition/calculate   (API key) → {formula_id | formula_name | formula:{kcal_per_ml, protein_g_per_l, water_ml_per_l}, kcal_needs, protein_needs_g?, fluid_needs_ml?, weight_kg?, mode?, hours_per_day?, refeeding_risk?, ...} → volume, rate, kcal, protein, formula water, free water flush, adequacy and 65% delivery scenario",
        "GET  /enteral-nutrition/reference[?section=]   (API key) → steps, limits, modes and request fields",
      ],
      "critical-care": [
        "POST /critical-care/protein-by-stress   (API key) → {stress_level? 0-3, weight_kg?} → g/kg/day (and g/day) by metabolic stress; omit stress_level for the whole table",
        "POST /critical-care/npe-nitrogen-ratio   (API key) → {npe_kcal, protein_g} → NPE:N2 ratio and stress interpretation",
        "POST /critical-care/nitrogen-balance   (API key) → {urine_volume_l, urinary_urea_mmol_l} → urinary N, total urinary N, total N output and the stress grade (general ICU, not burns)",
        "POST /critical-care/carbohydrate   (API key) → {weight_kg?} → usual, minimum and maximum carbohydrate, with g/day when weight is sent",
        "GET  /critical-care/fat   (API key) → usual, minimum and maximum fat, acute pancreatitis rule",
        "POST /critical-care/propofol-fat   (API key) → {propofol_percent: 1|2, volume_ml} → propofol mg and fat g delivered",
        "GET  /critical-care/cho-fat-ratio   (API key) → CHO:fat ratios of NPE by indication",
        "POST /critical-care/electrolytes   (API key) → {electrolyte? phosphate|potassium|magnesium} → replacement dosing",
        "POST /critical-care/potassium-deficit   (API key) → {serum_k_mmol_l} → deficit band and expected rise per 20 mmol KCl",
        "POST /critical-care/fluid   (API key) → {weight_kg} → 30-35 mL/kg/day reference range",
        "GET  /critical-care/reference[?section=]   (API key) → the tables behind the calculators and the known issues in the source",
      ],
      "dietary-assessment": [
        "POST /dietary-assessment   (API key, rate-limited) → body {age|life_stage, sex?, life_stage_type?, weight_kg?, height_cm?, pal_category?, trimester?, months_postpartum?, energy_target_kcal?, suggest_foods?, days:[{date?, meals:[{meal_type?, ingredients}] | ingredients | intake:{totals}}]} (1-7 days, max 40 ingredients; one day may be sent at the top level) → average intake vs DRI (EAR/RDA/AI/UL, sodium CDRR) per nutrient incl. 11 extra nutrients, energy vs IOM EER, macro % vs AMDR, food-group coverage, ranked gaps (likely_inadequate / borderline / possibly_low) and excesses, confidence from data coverage, and the foods richest in the top gaps; screening only, not a diagnosis",
        "GET  /dietary-assessment/reference   (API key) → assessable nutrients, status definitions, accepted input, method notes",
      ],
      meals: [
        "POST /meals/analyze   (API key, rate-limited) → body {meal_type?, ingredients:[{food_id?|food_name, quantity, unit?}], daily_targets?:{kcal,protein_g,carbs_g,fat_g}}; same ingredient resolution as /recipes/calculate, no servings — returns total_nutrients, macronutrient_breakdown (kcal + % from protein/carbs/fat, Atwater 4/4/9, compared against the standard adult AMDR range), food_groups_present/food_groups_missing (from the core Grains/Legumes/Protein/Vegetables/Fruits/Dairy set), and — only if daily_targets was supplied — daily_target_comparison; purely descriptive, never invents a personalized target itself",
      ],
      measures: [
        "GET  /measures   (API key, rate-limited, cached 24h) → every unit (id, ml or grams, system, aliases, source), the printed reference tables as published (UCT household guide, kitchen conversion tables, Krause Appendix 2: liquid equivalents, dry measure, weights, metric conversion factors) and the #6-#60 portion scoop sizes. ?section=units|scoop_sizes|reference_tables|sources returns one part",
        "GET  /measures/convert?amount=3&from=tbsp&to=ml   (API key, rate-limited, cached 24h) → unit to unit with no food: volume to volume, weight to weight; omit 'to' for every unit of that kind. Weight-to-volume needs a food: use GET /foods/convert",
      ],
      ingredients: [
        "POST /ingredients/parse   (API key, rate-limited) → body {text}; parses free text like \"2 eggs, 1 cup rice, 100g chicken and ½ avocado\" into ingredients:[{food_name, quantity, unit}] — the exact shape /recipes/calculate and /meals/analyze accept. Groq LLM parse, falls back to a local regex parser if GROQ_API_KEY isn't configured or the LLM call fails. A bare count with no stated unit (\"2 eggs\") comes back as unit:\"serving\", not grams.",
      ],
      drug_interactions: [
        "GET  /drug-interactions?category=&severity=&limit=&offset=/cursor=   (API key, rate-limited) → paginated list of drug-nutrient interaction entries",
        "GET  /drug-interactions/:id   (API key, rate-limited) → single entry",
        "GET  /drug-interactions/search?q=warfarin   (API key, rate-limited) → keyword scan across drug/aliases/category/subcategory/tags/effects/implications (same approach as /rag/ask's exchange/renal/formula lookups) — 'drug' also accepted as the param name",
        "POST /drug-interactions   (admin) → body: {drug, aliases?, category?, subcategory?, effects?, implications?, severity?, tags?}",
        "POST /drug-interactions/bulk   (admin) → body {items:[...]}, up to 500 rows",
        "PUT/PATCH/DELETE /drug-interactions/:id   (admin)",
      ],
      dri: [
        "GET  /dri/life-stages   (API key, rate-limited) → every DRI life-stage group (code, label, sex, age range)",
        "GET  /dri?nutrient=&life_stage=   OR   ?nutrient=&age=&sex=&life_stage_type=   (API key, rate-limited) → EAR/RDA/AI/UL for one nutrient (or every nutrient if 'nutrient' is omitted) at the resolved life stage, plus that life stage's AMDR and sodium CDRR when returning the full set",
        "POST /dri/compare   (API key, rate-limited) → body {age|life_stage, sex?, life_stage_type?, intake:{nutrient_key: amount}}; compares intake (same field names as /recipes/calculate or /meals/analyze's total_nutrients) against RDA/AI, flags UL if exceeded — only nutrients CNR's foods table actually tracks are comparable, see 'trackable' on GET /dri",
      ],
      batch: [
        `POST /batch   (API key, rate-limited, max ${BATCH_MAX_REQUESTS} sub-requests) → body {requests:[{id?, method, path, body?}, ...]}; runs each sub-request through the same auth/rate-limit/cache pipeline as calling it directly (forwards Authorization/apikey/CF-Connecting-IP from the batch call), in parallel, and returns {status:'success', data:[{id, status, body}, ...], meta:{total, succeeded, failed, duration_ms}} with one entry per sub-request in the original order — one failed sub-request doesn't fail the others. Nested /batch sub-requests are rejected.`,
      ],
    },
  });
}

// ── /foods ────────────────────────────────────────────────────────────────────

// GET /foods/lookup?q=banana
// GET /foods/lookup?barcode=6007048001598
// GET /foods/lookup?q=rice+cooked&tier=wider
// Checks local data first, then previously-cached external results, then
// falls through to USDA FDC / Open Food Facts / FatSecret and caches
// whatever it finds so the next lookup for the same food is a local hit.
// ?tier=wider skips the local/fuzzy steps and goes straight to the cached/
// external steps — for a caller that already has a local match but wants
// the wider USDA/OFF/FatSecret data specifically (e.g. the local Malawi
// FCT entry is for a different preparation than what was asked for, like
// "Rice, soaked" vs. a plain "rice, cooked" ask).
async function handleFoodsLookup(request, url, db, env) {
  if (request.method !== "GET") return err("Only GET is supported for lookup", 405);

  const query = url.searchParams.get("q") || "";
  const barcode = url.searchParams.get("barcode") || "";
  if (!query && !barcode) return err("Provide 'q' (food name) or 'barcode'");
  const wider = url.searchParams.get("tier") === "wider";

  const result = await lookupFoodCascade(db, { query, barcode, skipLocal: wider }, env);
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
    ...(result.ambiguous
      ? {
          ambiguous: true,
          note:
            "This match wasn't confident — the query didn't clearly favour it over other similarly-named foods. See 'alternates'.",
          alternates: result.alternates,
        }
      : {}),
  });
}

/**
 * GET /foods/:id/label?serving=<label substring>
 * Standardized Codex-style nutrition label for one food. Defaults to the
 * most specific serving Serving-Size Intelligence has for this food (tier
 * 1/2/3 — see buildServingSizes); pass ?serving= to match a different one
 * by (partial, case-insensitive) label text, e.g. ?serving=100g for the raw
 * per-100g reference basis. `alternate_servings` lists the others so a
 * caller can offer a picker without a second request.
 */
async function handleFoodsLabel(request, url, db, id) {
  if (request.method !== "GET") return err("Only GET is supported for /foods/:id/label", 405);

  // Validate the food ID up front with a clear message, rather than letting
  // a malformed id fall through to a generic 404 from the DB query.
  if (!id || !/^\d+$/.test(String(id))) {
    return err(`Invalid food ID '${id}' — must be a positive integer`, 400);
  }

  try {
    const { ok, status, body } = await db.selectOne("foods", id);
    if (status === 404) return notFound("Food");
    if (!ok) return err(body?.message || "Query failed", status);

    const servingSizes = buildServingSizes(body);
    if (!servingSizes.length) return err("No serving-size data available to build a label from", 422);

    const requestedRaw = url.searchParams.get("serving") || "";
    const requested = requestedRaw.toLowerCase();
    const matchedServing = requested ? servingSizes.find((s) => s.label.toLowerCase().includes(requested)) : null;
    // Unknown serving name: fall back to the most specific tier available
    // (same as before) rather than erroring, but flag it via
    // requested_serving.matched so a caller can tell the request didn't
    // resolve to what it asked for.
    const chosen = matchedServing || servingSizes[0];

    if (!(Number(chosen.grams) > 0) || !isFinite(Number(chosen.grams))) {
      return err(`Invalid serving weight (${chosen.grams}g) for this food — cannot build a label from it`, 422);
    }

    const qualityFlags = parseDataQualityFlags(body.data_quality_flags);
    const reference100g = extractPer100gNutrients(body);

    const label = buildNutritionLabel(chosen.nutrients, chosen.label, chosen.grams, {
      qualityFlags,
      reference100g: Object.keys(reference100g).length ? reference100g : null,
      servingSource: chosen.source,
    });

    return success(label, {
      food_id: body.id,
      food_name: body.food_name,
      serving_source: chosen.source,
      alternate_servings: servingSizes.filter((s) => s !== chosen).map(({ label, grams, source }) => ({ label, grams, source })),
      requested_serving: {
        requested: requestedRaw || null,
        matched: !requestedRaw || !!matchedServing,
        resolved_label: chosen.label,
      },
    });
  } catch (e) {
    return err(`Label calculation failed: ${e?.message || String(e)}`, 500);
  }
}

/**
 * GET /foods/convert?q=rice&amount=2&unit=cup
 * GET /foods/convert?id=12&amount=300&unit=g      GET /foods/:id/convert?amount=2&unit=chipande
 *
 * One food, one amount, either way round: give a household measure (cup, tbsp, dsp, scoop 16, chipande,
 * piece ...) and get the standard weight, or give a standard measure (g, kg, oz, ml ...) and get the
 * household equivalents. The reply always carries both, plus the nutrients for that amount. Uses the
 * same food matching and gram conversion as POST /recipes/calculate (resolveIngredientGrams), so the
 * numbers agree. Spoon/cup equivalents need a density, taken from the food's own cup or spoon serving;
 * with none on file they are left out (a weight input) or 1 g/ml is assumed and flagged (a volume input).
 */
async function handleFoodsConvert(request, url, db, env, idFromPath = null) {
  if (request.method !== "GET") return err("Only GET is supported for /foods/convert", 405);

  const idParam = idFromPath ?? url.searchParams.get("id");
  const q = (url.searchParams.get("q") || url.searchParams.get("food") || "").trim();
  if (idParam == null && !q) return err("Provide 'q' (food name) or 'id'");
  if (idParam != null && !/^\d+$/.test(String(idParam))) {
    return err(`Invalid food ID '${idParam}' — must be a positive integer`, 400);
  }

  const amountRaw = url.searchParams.get("amount");
  const amount = amountRaw == null || amountRaw === "" ? 1 : parseQuantity(amountRaw);
  if (!(amount > 0) || !Number.isFinite(amount)) {
    return err("'amount' must be a positive number, e.g. 2, 0.5, 1/2 or 1 1/2");
  }
  const unitRaw = (url.searchParams.get("unit") || "g").trim();

  try {
    const found = await findFoodForIngredient(idParam != null ? { food_id: idParam } : { food_name: q }, db, env);
    if (!found.food) return notFound("Food");
    const food = found.food;

    const servings = buildServingSizes(food);
    const resolved = resolveIngredientGrams(food, amount, unitRaw);
    if (resolved.grams == null) return err(resolved.reason, 422);
    const grams = resolved.grams;

    const density = resolved.density_g_per_ml ?? deriveDensity(servings)?.gPerMl ?? null;
    const described = describeAmount({ grams, servings, densityGPerMl: density });

    const scale = grams / 100;
    const nutrients = {};
    for (const field of SERVING_SCALE_FIELDS) {
      if (food[field] != null && food[field] !== "") nutrients[field] = roundServingVal(Number(food[field]) * scale);
    }

    const unitDef = findUnit(unitRaw);
    const inputKind = !unitDef
      ? "food_specific_serving"
      : unitDef.kind === "mass"
      ? "standard_weight"
      : unitDef.household
      ? "household_volume"
      : "standard_volume";

    const assumptions = [];
    if (resolved.assumed_density) {
      assumptions.push("This food has no cup or spoon serving on file, so 1 g/ml (water-like) was assumed to turn the volume into grams. Treat the grams as a rough estimate for dense or airy foods.");
    }
    if (density == null) {
      assumptions.push("This food has no cup or spoon serving on file, so spoon and cup equivalents are left out rather than guessed. Its own servings are listed under household.servings.");
    }

    const densityBasis = resolved.density_basis ?? deriveDensity(servings)?.basis ?? null;
    const warnings = [];
    const formWarning = densityFormWarning(food.food_name || food.product_name || q, densityBasis);
    if (formWarning) warnings.push(formWarning);
    if ((found.alternatives || []).length > 0 && idParam == null) {
      warnings.push(`'${q}' matched more than one food; this used '${food.food_name}'. Repeat with id=<id> (see food.other_matches) for a different one.`);
    }

    return success(
      {
        food: {
          id: food.id ?? null,
          food_name: food.food_name || food.product_name || q || null,
          matched_source: found.matchedSource,
          other_matches: found.alternatives || [],
        },
        input: {
          amount,
          unit: unitRaw,
          unit_id: unitDef?.id ?? null,
          kind: inputKind,
          system: unitDef?.system ?? null,
          how_converted: resolved.basis,
        },
        standard: described.standard,
        household: described.household,
        density_g_per_ml: density != null ? roundServingVal(density) : null,
        density_basis: densityBasis,
        nutrients,
        assumptions,
        warnings,
      },
      {
        message: "Standard and household measures for this amount",
        note: "Nutrients are for the amount asked for, scaled from the per-100g values. 'cup' is the 250 ml metric household cup; use 'us cup' for 240 ml. GET /measures lists every unit and its source.",
      }
    );
  } catch (e) {
    return err(`Measure conversion failed: ${e?.message || String(e)}`, 500);
  }
}

/**
 * GET /measures                         every unit, the printed reference tables and the scoop sizes
 * GET /measures?section=units|scoop_sizes|reference_tables|sources
 * GET /measures/convert?amount=3&from=tbsp[&to=ml]   unit-to-unit, no food (volume to volume, weight to weight)
 */
function handleMeasures(request, url, param) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  if (!param) {
    const catalog = measureCatalog();
    const section = url.searchParams.get("section");
    if (section) {
      if (!(section in catalog) || section === "note") {
        return err("'section' must be one of: units, scoop_sizes, reference_tables, sources");
      }
      return success(catalog[section], { message: `Measures: ${section}`, note: catalog.note });
    }
    return success(catalog, { message: "Household and standard measures" });
  }

  if (param === "convert") {
    const amount = parseQuantity(url.searchParams.get("amount") ?? "1");
    if (!(amount >= 0) || !Number.isFinite(amount)) return err("'amount' must be a number, e.g. 3, 0.5 or 1/2");
    const fromRaw = url.searchParams.get("from");
    if (!fromRaw) return err("'from' is required, e.g. from=tbsp (see GET /measures for every unit)");
    const from = findUnit(fromRaw);
    if (!from) return err(`Unknown unit '${fromRaw}' — see GET /measures for every unit`);

    const toRaw = url.searchParams.get("to");
    const targets = toRaw
      ? [toRaw]
      : UNITS.filter((u) => u.kind === from.kind && !u.id.startsWith("scoop_") && !u.id.startsWith("dry_") && u.id !== from.id).map((u) => u.id);

    const results = [];
    for (const t of targets) {
      const c = convertUnits(amount, fromRaw, t);
      if (!c.ok) return err(c.error, 422);
      results.push({
        unit: c.to.id,
        label: c.to.label,
        quantity: Math.round(c.value * 1000) / 1000,
        display_quantity: formatQuantity(c.value),
      });
    }
    return success(
      { amount, from: { id: from.id, label: from.label, system: from.system }, results },
      { message: "Unit conversion", note: "Volume converts to volume and weight to weight. For weight-to-volume (grams of rice to cups) use GET /foods/convert." }
    );
  }

  return notFound("Measures route");
}

// Baby and infant products (branded infant cereals, jarred baby food) are a separate group of rows in
// public.foods, category "Baby foods". They sort alphabetically ahead of ordinary foods ("Baby food (jar), banana"
// before "Banana"), so a plain name search is kept free of them. Use GET /foods/baby-foods to search them, or
// pass category=Baby foods, or include_baby_foods=true.
const BABY_FOODS_CATEGORY = "Baby foods";
const BABY_INTENT_RE = /\b(baby|babies|infant|infants|toddler|weaning|nestum|cerelac|lactogen|formula|puree|purée)\b/i;

/** True when a free-text search should leave "Baby foods" rows out: no explicit category, no baby wording, not opted back in. */
function shouldExcludeBabyFoods(url, search, category) {
  if (!search || category) return false;
  if (isTruthyParam(url.searchParams.get("include_baby_foods"))) return false;
  return !BABY_INTENT_RE.test(search);
}

// GET /foods/baby-foods?search=...&limit=...&cursor=...
// Browse or search only the "Baby foods" rows. Same paging and row shape as GET /foods.
async function handleBabyFoods(request, url, db) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  const search = (url.searchParams.get("search") || "").trim();
  const filters = { category: `eq.${BABY_FOODS_CATEGORY}` };
  if (search) filters.food_name = `ilike.*${escapeLikePattern(search)}*`;
  const withServings = isTruthyParam(url.searchParams.get("with_servings"));
  return await paginatedList(db, "foods", url, {
    filters,
    order: "food_name.asc",
    select: FOODS_SEARCH_FIELDS,
    enrichRow: withServings ? (row) => ({ ...row, serving_sizes: buildServingSizes(row) }) : undefined,
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

    // Keep baby-food products out of an ordinary name search (see BABY_FOODS_CATEGORY). The "or" keeps rows with no
    // category. If the search would then find nothing (e.g. "nestum" without a baby word), fall back to including them.
    if (shouldExcludeBabyFoods(url, search, category)) {
      const withoutBaby = { ...filters, or: `(category.is.null,category.neq.${BABY_FOODS_CATEGORY})` };
      const probe = await db.select("foods", { filters: withoutBaby, limit: 1, select: "id" });
      if (probe.ok && Array.isArray(probe.body) && probe.body.length > 0) {
        filters.or = withoutBaby.or;
      }
    }

    const withServings = isTruthyParam(url.searchParams.get("with_servings"));
    return await paginatedList(db, "foods", url, {
      filters,
      order: "food_name.asc",
      select: FOODS_SEARCH_FIELDS,
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
// GS1 check-digit validation for EAN-8 / UPC-A / EAN-13 / GTIN-14.
function isValidGs1Barcode(digits) {
  if (!/^\d+$/.test(digits || "") || ![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

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

  // Many local labels (e.g. UHT milk) print macros but no energy line. Estimate kcal from the macros
  // with the standard Atwater factors (4/4/9) and mark it as an estimate so it is never mistaken
  // for a printed value. Only when protein, carbs and fat are all present.
  let energyEstimated = false;
  if (scaled.energy_kcal == null) {
    const p = Number(scaled.protein_g), c = Number(scaled.carbs_g), f = Number(scaled.fat_g);
    if ([scaled.protein_g, scaled.carbs_g, scaled.fat_g].every((v) => v != null && Number.isFinite(Number(v)))) {
      scaled.energy_kcal = Math.round(p * 4 + c * 4 + f * 9);
      energyEstimated = true;
    }
  }

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
    // payload.barcode comes from the client (already decoded/validated there); extracted.barcode is
    // a vision-model read of printed digits, so only trust it if its GS1 check digit adds up.
    barcode: payload.barcode || (isValidGs1Barcode(String(extracted.barcode || "").replace(/\D/g, "")) ? String(extracted.barcode).replace(/\D/g, "") : null),
    product_name: productName || "Unknown product (from photo)",
    brand: extracted.brand ?? null,
    serving_size: extracted.serving_size ?? (extracted.per === "100ml" ? "100 ml" : extracted.per === "100g" ? "100 g" : null),
    energy_kcal: scaled.energy_kcal ?? null,
    protein_g: scaled.protein_g ?? null,
    fat_g: scaled.fat_g ?? null,
    saturated_fat_g: scaled.saturated_fat_g ?? null,
    carbs_g: scaled.carbs_g ?? null,
    sugar_g: scaled.sugars_g ?? null,
    fiber_g: scaled.fiber_g ?? null,
    sodium_mg: scaled.sodium_mg ?? null,
    salt_g: scaled.salt_g ?? null,
    // Same field names in `scaled` and the DB column for every micro (no
    // "sugars_g"-vs-"sugar_g"-style rename needed here) — see
    // PACKAGED_FOOD_MICRONUTRIENT_FIELDS.
    calcium_mg: scaled.calcium_mg ?? null,
    iron_mg: scaled.iron_mg ?? null,
    zinc_mg: scaled.zinc_mg ?? null,
    magnesium_mg: scaled.magnesium_mg ?? null,
    potassium_mg: scaled.potassium_mg ?? null,
    folate_mcg: scaled.folate_mcg ?? null,
    vita_rae_mcg: scaled.vita_rae_mcg ?? null,
    vitc_mg: scaled.vitc_mg ?? null,
    vitd_mcg: scaled.vitd_mcg ?? null,
    vitb12_mcg: scaled.vitb12_mcg ?? null,
    iodine_mcg: scaled.iodine_mcg ?? null,
    ingredients_text: extracted.ingredients_text ?? null,
    allergens: extracted.allergens ?? null,
    ocr_raw: energyEstimated ? { ...extracted, energy_estimated: true } : extracted,
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

  if (energyEstimated) message += " Energy was not printed on the label, so kcal is estimated from protein/carbs/fat.";

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


/** Validates an optional `fhir_scopes` body field. Returns { value } (string or undefined) or { error }. */
function readFhirScopesField(payload) {
  const raw = payload?.fhir_scopes;
  if (raw == null || raw === "") return { value: undefined };
  const parsed = parseScopes(raw);
  if (parsed === null || parsed.length === 0) {
    return { error: "'fhir_scopes' must be space-separated scopes like \"system/Bundle.write system/*.read\" (system/<ResourceType|*>.<read|write|*>)" };
  }
  return { value: (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)).filter(Boolean).join(" ") };
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

    const fs = readFhirScopesField(payload);
    if (fs.error) return err(fs.error);

    const rawKey = generateApiKey();
    const hash = await sha256Hex(rawKey);

    const { ok, status, body } = await db.insert("api_keys", { key_hash: hash, label, role, ...(fs.value ? { fhir_scopes: fs.value } : {}) });
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

// ─── /developer/keys ─────────────────────────────────────────────────────────
//
// Self-service consumer keys for the developer portal. Auth is the caller's
// Supabase login access token, checked against Supabase Auth on every call.
// A developer can only ever see, create or revoke their own keys.

async function handleDeveloperKeys(request, db, env, idParam) {
  const token = getBearerToken(request);
  if (!token) return unauthorized("Sign in first and send your login access token as 'Authorization: Bearer <token>'");
  const who = await verifySupabaseUser(env, token);
  if (!who.ok) return who.status === 401 ? unauthorized(who.error) : err(who.error, who.status);
  const user = who.user;
  const mine = { owner_user_id: `eq.${user.id}`, role: `eq.${CONSUMER_ROLE}`, revoked_at: "is.null" };
  const method = request.method;

  if (method === "GET" && !idParam) {
    const { ok, status, body } = await db.select("api_keys", { filters: mine, order: "created_at.desc", limit: 50 });
    if (!ok) return err(body?.message || "Query failed", status);
    const rows = Array.isArray(body) ? body : [];
    const views = await Promise.all(rows.map(async (r) => publicKeyView(r, await readUsage(env, r.id))));
    return success(views, { email: user.email, max_keys: MAX_KEYS_PER_USER });
  }

  if (method === "POST" && !idParam) {
    if (!user.emailConfirmed) return err("Confirm your email address first (check your inbox), then create a key", 403);
    const payload = await parseBody(request);
    const lbl = validateLabel(payload?.label);
    if (lbl.error) return err(lbl.error);

    const existing = await db.select("api_keys", { filters: mine, limit: MAX_KEYS_PER_USER + 1 });
    if (!existing.ok) return err(existing.body?.message || "Query failed", existing.status);
    if ((Array.isArray(existing.body) ? existing.body.length : 0) >= MAX_KEYS_PER_USER) {
      return err(`You already have ${MAX_KEYS_PER_USER} active keys. Revoke one before creating another`, 409);
    }

    const rawKey = generateApiKey();
    const row = buildConsumerKeyRow({ keyHash: await sha256Hex(rawKey), label: lbl.value, user, rawKey });
    const ins = await db.insert("api_keys", row);
    if (!ins.ok) return err(ins.body?.message || "Key creation failed", ins.status);

    return success(publicKeyView({ ...ins.body, key_prefix: row.key_prefix }), {
      message: "API key created. Copy it now, it will not be shown again",
      key: rawKey,
    });
  }

  if (method === "DELETE") {
    if (!idParam || !/^\d+$/.test(idParam)) return err("Key id required, e.g. DELETE /developer/keys/5");
    const found = await db.select("api_keys", { filters: { ...mine, id: `eq.${idParam}` }, limit: 1 });
    if (!found.ok) return err(found.body?.message || "Query failed", found.status);
    if (!Array.isArray(found.body) || !found.body.length) return notFound("API key");
    const upd = await db.update("api_keys", idParam, { revoked_at: new Date().toISOString() }, "PATCH");
    if (!upd.ok) return err(upd.body?.message || "Revoke failed", upd.status);
    return success({ id: Number(idParam) }, { message: `API key ${idParam} revoked` });
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
    case "fhir": {
      if (param === "metadata") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        return await handleFhirMetadata(url, env);
      }
      if (param === "Observation" && action === "$evaluate-growth") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleFhirEvaluateGrowth(request, db, url);
      }
      {
        const ncpOp = request.method === "POST" ? fhirOperationFor(param, action) : null;
        if (ncpOp) return await handleFhirNcpOperation(request, url, db, param, ncpOp);
        if (fhirOperationFor(param, action)) return err("Method not allowed", 405);
        // Built-in assessment forms (src/fhirAssessment.js): GET /fhir/Questionnaire[/{id}]
        if (param === "Questionnaire") {
          if (request.method !== "GET") return err("Method not allowed", 405);
          if (!action) return json(questionnaireSearchBundle(url.origin));
          const q = questionnaireResource(url.origin, action);
          return q ? json(q) : json(operationOutcome("error", `Questionnaire/${action} not found.`, "not-found"), 404);
        }
        if (param === "AuditEvent") {
          if (request.method !== "GET") return json(operationOutcomeFor(405, "AuditEvent is read-only and immutable."), 405);
          return await handleFhirAuditEvent(request, url, db, env, action);
        }
        if (param === "CodeSystem" && action === "ncp-diagnosis") {
          if (request.method !== "GET") return err("Method not allowed", 405);
          return await handleFhirNcpCodeSystem(url, db);
        }
        // Static conformance resources: every CodeSystem / OperationDefinition /
        // StructureDefinition URL the facade emits resolves here.
        if (["CodeSystem", "OperationDefinition", "StructureDefinition", "ConceptMap"].includes(param) && action) {
          if (request.method !== "GET") return err("Method not allowed", 405);
          const def = param === "ConceptMap"
            ? conceptMapResource(url.origin, action)
            : (param === "StructureDefinition" && profileResource(url.origin, action)) || staticConformanceResource(param, action, url.origin);
          return def
            ? json(def)
            : json(operationOutcome("error", `${param}/${action} not found.`, "not-found"), 404);
        }
      }
      return notFound(
        "FHIR route. Available: GET /fhir/metadata, POST /fhir/Observation/$evaluate-growth, " +
          "POST /fhir/Observation/$screen, POST /fhir/Observation/$assess-nutrition, POST /fhir/Condition/$diagnose, " +
          "POST /fhir/CarePlan/$intervene, POST /fhir/CarePlan/$monitor, POST /fhir/Goal/$evaluate, POST /fhir/Bundle/$ncp-document, " +
          "POST /fhir/Bundle/$nutrition-assessment, POST /fhir/QuestionnaireResponse/$validate, GET /fhir/Questionnaire[/{id}], " +
          "POST /fhir/Bundle/$care-context, POST /fhir/Bundle/$validate-document, POST /fhir/$validate, POST /fhir/ConceptMap/$translate, GET /fhir/AuditEvent[/{id}] (admin), " +
          "GET /fhir/CodeSystem/{name}, GET /fhir/OperationDefinition/{id}, GET /fhir/StructureDefinition/{name}, GET /fhir/ConceptMap/{id}."
      );
    }

    case "health": {
      return await handleHealth(request, env);
    }

    case "admin": {
      if (param === "keys") {
        return await handleAdminKeys(request, db, action || null);
      }
      if (param === "overview") {
        return await handleAdminOverview(request, db, env, { success, err });
      }
      if (param === "activity") {
        return await handleAdminActivity(request, db, { success, err });
      }
      if (param === "monitoring") {
        return await handleAdminMonitoring(request, db, env, { success, err });
      }
      if (param === "usage") {
        return await handleAdminUsage(request, db, env, { success, err });
      }
      if (param === "health-history") {
        return await handleAdminHealthHistory(request, db, env, { success, err });
      }
      return notFound();
    }

    case "developer": {
      if (param === "keys") return await handleDeveloperKeys(request, db, env, action || null);
      return notFound();
    }

    case "measures": {
      return handleMeasures(request, url, param || null);
    }

    case "foods": {
      if (param === "lookup") {
        return await handleFoodsLookup(request, url, db, env);
      }
      if (param === "search") {
        return await handleFoodsSearch(request, url, db, env);
      }
      if (param === "autocomplete") {
        return await handleFoodsAutocomplete(request, url, db, env);
      }
      if (param === "categories") {
        return await handleFoodsCategories(request, env);
      }
      if (param === "by-category") {
        return await handleFoodsByCategory(request, url, db);
      }
      if (param === "local-categories") {
        return await handleFoodsLocalCategories(request, db);
      }
      if (param === "baby-foods") {
        return await handleBabyFoods(request, url, db);
      }
      if (param === "substitutes") {
        return await handleFoodSubstitutes(request, url, db, env);
      }
      if (param === "compare") {
        return await handleFoodsCompare(request, url, db, env);
      }
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "foods", { requiredField: "food_name", label: "foods" });
      }
      if (param === "convert") {
        return await handleFoodsConvert(request, url, db, env);
      }
      if (param && action === "label") {
        return await handleFoodsLabel(request, url, db, param);
      }
      if (param && action === "convert") {
        return await handleFoodsConvert(request, url, db, env, param);
      }
      const id = param || null;
      return await handleFoods(request, url, db, id);
    }

    case "glycaemic-index": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "glycaemic_index_data", {
          requiredField: "food_name",
          label: "glycaemic index entries",
        });
      }
      const id = param || null;
      return await handleGlycaemicIndex(request, url, db, id);
    }

    case "bmi-for-age": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "bmi_for_age", {
          requiredField: "sex",
          label: "BMI-for-age rows",
        });
      }
      return await handleBmiForAge(request, url, db, param || null);
    }

    case "hc-velocity": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_hc_velocity", {
          requiredField: "sex",
          label: "HC velocity rows",
        });
      }
      return await handleHcVelocity(request, url, db, param || null);
    }

    case "length-velocity": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_length_velocity", {
          requiredField: "sex",
          label: "length velocity rows",
        });
      }
      return await handleLengthVelocity(request, url, db, param || null);
    }

    case "weight-velocity": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_weight_velocity", {
          requiredField: "sex",
          label: "weight velocity rows",
        });
      }
      return await handleWeightVelocity(request, url, db, param || null);
    }

    case "muac-for-age": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_muac_for_age", {
          requiredField: "sex",
          label: "MUAC-for-age rows",
        });
      }
      return await handleMuacForAge(request, url, db, param || null);
    }

    case "muac": {
      return await handleMuacFixed(request, url, param || null);
    }

    case "length-height-for-age": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_length_height_for_age", {
          requiredField: "sex",
          label: "length/height-for-age rows",
        });
      }
      return await handleLengthHeightForAge(request, url, db, param || null);
    }

    case "weight-for-age": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_weight_for_age", {
          requiredField: "sex",
          label: "weight-for-age rows",
        });
      }
      return await handleWeightForAge(request, url, db, param || null);
    }

    case "weight-for-length-height": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_weight_for_length_height", {
          requiredField: "sex",
          label: "weight-for-length/height rows",
        });
      }
      return await handleWeightForLengthHeight(request, url, db, param || null);
    }

    case "bmi-for-age-under-5": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_bmi_for_age_under_5", {
          requiredField: "sex",
          label: "BMI-for-age (under 5) rows",
        });
      }
      return await handleBmiForAgeUnder5(request, url, db, param || null);
    }

    case "hc-for-age": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "who_hc_for_age", {
          requiredField: "sex",
          label: "head circumference-for-age rows",
        });
      }
      return await handleHcForAge(request, url, db, param || null);
    }

    case "growth": {
      return await handleGrowth(request, url, db, param || null);
    }

    case "surveillance": {
      const fetchRows = async (table, filters, limit) => {
        const { ok, status, body } = await db.select(table, { filters, limit });
        if (!ok) throw new Error(body?.message || `Query failed (${status})`);
        return Array.isArray(body) ? body : [];
      };
      return await handleSurveillance(request, url, db, env, param || null, { success, err, notFound, parseBody, json }, fetchRows);
    }

    case "energy": {
      if (param === "factors") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        return success(energyFactorCatalog(), { message: "Energy engine factors, equations and reference tables" });
      }
      if (param === "requirements") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        // Children 3-18 y with weight and height but no percentile: look it up in the WHO tables first.
        // activity_log: look the activities up in the database (Krause Appendix 10) and turn them into PAL entries.
        const withLog = await enrichActivityLog(body, db);
        if (withLog.error) return err(withLog.error, withLog.status || 400);
        const enriched = await enrichBmiPercentile(withLog.body, db);
        const result = computeEnergyRequirements(enriched);
        if (!result.ok) return err(result.error);
        if (withLog.activityLog) {
          result.data.activity_log = withLog.activityLog;
          for (const w of withLog.activityLog.warnings) if (!result.data.warnings.includes(w)) result.data.warnings.push(w);
        }
        return success(result.data, { message: "Energy requirement estimate" });
      }
      if (param === "food-energy") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        const result = computeFoodEnergy(body);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Food energy" });
      }
      return notFound();
    }

    case "pregnancy": {
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = pregnancyReferenceCatalog(url.searchParams.get("section") ?? undefined);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Pregnancy and lactation reference tables" });
      }
      const pregCalc = { "gestational-age": computeGestationalAge, "weight-gain": computePregnancyWeightGain, plan: computePregnancyPlan, assess: computePregnancyAssessment };
      if (param && pregCalc[param]) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        // Gestational age is counted to reference_date, which defaults to today's date on the server (UTC).
        const result = pregCalc[param](body, { today: new Date().toISOString().slice(0, 10) });
        if (!result.ok) return err(result.error);
        return success(result.data, { message: `Pregnancy: ${param}` });
      }
      return notFound();
    }

    case "renal-nutrition": {
      if (param === "reference" || param === "emergency-diet") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = param === "reference" ? renalReferenceCatalog(url.searchParams.get("section") ?? undefined) : emergencyDiet();
        if (!result.ok) return err(result.error);
        return success(result.data, { message: param === "reference" ? "Renal nutrition reference tables" : "Emergency dialysis diet plan (Box 35.3)" });
      }
      if (param === "food-plan") {
        // Links the requirements to exchange_lists and renal_foods. Read only. The two reads run in parallel (2 subrequests).
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        const [ex, rn] = await Promise.all([db.select("exchange_lists", { limit: 500, offset: 0 }), db.select("renal_foods", { limit: 500, offset: 0 })]);
        const result = linkRenalFoods(body, ex.ok ? ex.body : [], rn.ok ? rn.body : []);
        if (!result.ok) return err(result.error);
        if (!ex.ok) result.data.warnings.push("exchange_lists could not be read.");
        if (!rn.ok) result.data.warnings.push("renal_foods could not be read.");
        return success(result.data, { message: "Renal targets linked to the food exchange list" });
      }
      const renalCalc = { stage: computeRenalStage, requirements: computeRenalRequirements, labs: computeRenalLabs, adequacy: computeDialysisAdequacy, plan: computeRenalPlan };
      if (param && renalCalc[param]) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        const result = renalCalc[param](body);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: `Renal nutrition: ${param}` });
      }
      return notFound();
    }

    case "diabetes": {
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = diabetesReferenceCatalog(url.searchParams.get("section"));
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Diabetes nutrition reference tables" });
      }
      const diabetesCalc = { status: computeGlycemicStatus, "glucose-targets": computeGlucoseTargets, "carb-plan": computeCarbPlan, "carb-count": computeCarbCount, insulin: computeInsulin, hypoglycemia: computeHypoglycemia, exercise: computeExerciseCarbs, plan: computeDiabetesPlan };
      if (param && (diabetesCalc[param] || param === "exchange-plan" || param === "glycemic-load")) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        let result;
        if (param === "exchange-plan") {
          // Read only: one select of exchange_lists (about 300 rows).
          const ex = await db.select("exchange_lists", { limit: 500, offset: 0 });
          if (!ex.ok) return err("exchange_lists could not be read", 502);
          result = computeExchangePlan(body, ex.body);
        } else if (param === "glycemic-load") {
          const gi = await db.select("glycaemic_index_data", { limit: 200 });
          result = computeGlycemicLoad(body, gi.ok ? gi.body : [], matchGlycaemicIndexRows);
          if (result.ok && !gi.ok) result.data.warnings.push("glycaemic_index_data could not be read, so only gi values you sent were used.");
        } else {
          result = diabetesCalc[param](body);
        }
        if (!result.ok) return err(result.error);
        return success(result.data, { message: `Diabetes nutrition: ${param}` });
      }
      return notFound();
    }

    case "weight-management": {
      if (param === "reference" || param === "bariatric") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const q = Object.fromEntries(url.searchParams);
        const result = param === "reference" ? weightReferenceCatalog(q.section) : computeBariatricGuidance(q);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: param === "reference" ? "Weight management reference tables" : "Bariatric surgery diet stages and supplementation" });
      }
      const weightCalc = { assess: computeWeightAssessment, "loss-plan": computeLossPlan, "gain-plan": computeGainPlan, progress: computeWeightProgress, "diet-pattern": computeDietPattern };
      if (param && weightCalc[param]) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        let input = body; let activityLog = null;
        if (param === "loss-plan" || param === "gain-plan") {
          // activity_log: look the activities up (Krause Appendix 10) and turn them into PAL entries for the energy engine, as /energy does.
          const withLog = await enrichActivityLog(body, db);
          if (withLog.error) return err(withLog.error, withLog.status || 400);
          input = withLog.body; activityLog = withLog.activityLog;
        } else if (param === "assess") {
          // Children 3-18 y with weight and height but no percentile: look it up in the WHO tables, as /energy does.
          input = await enrichBmiPercentile(body, db);
        }
        const result = weightCalc[param](input);
        if (!result.ok) return err(input && input.bmi_percentile_lookup_error && !input.bmi_for_age_percentile ? `${result.error} (lookup: ${input.bmi_percentile_lookup_error})` : result.error);
        if (activityLog) result.data.activity_log = activityLog;
        return success(result.data, { message: `Weight management: ${param}` });
      }
      return notFound();
    }

    case "sports": {
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        return success(sportsReferenceCatalog(), { message: "Sports nutrition reference tables, factors and known chapter issues" });
      }
      const sportsCalc = { energy: computeSportsEnergy, macros: computeSportsMacros, "fuel-timing": computeFuelTiming, hydration: computeHydration, "body-composition": computeBodyComposition, "supplement-dose": computeSupplementDoses, plan: computeSportsPlan };
      if (param && sportsCalc[param]) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        // activity_log (energy and plan): look the activities up in the database (Krause Appendix 10).
        let activityLog = null;
        if (param === "energy" || param === "plan") {
          const looked = await lookupActivityLogEnergy(body, db);
          if (looked.error) return err(looked.error, looked.status || 400);
          activityLog = looked.activityLog;
        }
        const result = sportsCalc[param](body, { activityLog });
        if (!result.ok) return err(result.error);
        return success(result.data, { message: param === "plan" ? "Sports nutrition plan" : `Sports nutrition: ${param}` });
      }
      return notFound();
    }

    case "activity-energy": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "activity_energy_expenditure", {
          requiredField: "activity",
          label: "activity energy rows",
        });
      }
      if (param === "calculate") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        const rows = await db.select("activity_energy_expenditure", { limit: 500, order: "activity.asc,type.asc" });
        if (!rows.ok) return err("Activity table could not be read (has sql/033 been run and seeded?)", 502);
        if (!Array.isArray(rows.body) || !rows.body.length) return err("Activity table is empty. Seed it with POST /activity-energy/bulk (admin)", 503);
        const result = computeActivityEnergy(body, rows.body);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Activity energy estimate" });
      }
      if (param) return notFound();
      if (request.method !== "GET") return err("Method not allowed. Seed rows with POST /activity-energy/bulk (admin).", 405);
      let weightLb = null;
      if (url.searchParams.get("weight_kg") || url.searchParams.get("weight_lb")) {
        const w = parseWeight({ weight_kg: url.searchParams.get("weight_kg") ?? undefined, weight_lb: url.searchParams.get("weight_lb") ?? undefined });
        if (w.error) return err(w.error);
        weightLb = w.lb;
      }
      const rows = await db.select("activity_energy_expenditure", { limit: 500, order: "activity.asc,type.asc" });
      if (!rows.ok) return err("Activity table could not be read (has sql/033 been run and seeded?)", 502);
      const list = listActivities(Array.isArray(rows.body) ? rows.body : [], { q: url.searchParams.get("q"), activity: url.searchParams.get("activity"), weightLb });
      return success(list, { message: `${list.length} activities`, count: list.length });
    }

    case "fenton-preterm": {
      if (param === "bulk") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleBulkInsert(request, db, "fenton_preterm_lms", {
          requiredField: "metric",
          label: "Fenton preterm reference rows",
        });
      }
      if (param === "profile") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleFentonProfile(request, db);
      }
      if (param === "growth") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleFentonGrowth(request, db);
      }
      if (param === "velocity") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        return await handleFentonVelocity(request, db);
      }
      if (param === "chart") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        return await handleFentonChart(request, url, db);
      }
      if (param === "references") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        return success(FENTON_REFERENCES_META, { message: "Fenton preterm growth chart reference metadata" });
      }
      return await handleFentonPreterm(request, url, db, param || null);
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

    case "paediatric":
    case "pediatric": {
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = paediatricReferenceCatalog(url.searchParams.get("section") ?? undefined);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Paediatric nutrition reference tables" });
      }
      const paedCalc = { energy: computePaediatricEnergy, protein: computePaediatricProtein, fluid: computePaediatricFluid, preterm: computePretermRequirements, "growth-velocity": computeGrowthVelocity, "enteral-feeds": computeEnteralFeeds };
      if (param && (paedCalc[param] || param === "catch-up" || param === "plan")) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        let result;
        if (param === "catch-up" || (param === "plan" && body && body.catch_up === true && (body.ideal_weight_kg == null || body.ideal_weight_kg === ""))) {
          const w = await withIdealWeight(body, db);
          if (w.error) return err(w.error, 422);
          result = param === "catch-up" ? computeCatchUp(body, w.opts) : computePaediatricPlan(w.opts.idealWeightKg ? { ...body, ideal_weight_kg: w.opts.idealWeightKg } : body);
        } else if (param === "plan") result = computePaediatricPlan(body);
        else result = paedCalc[param](body);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: `Paediatric nutrition: ${param}` });
      }
      return notFound();
    }

    case "enteral-nutrition": {
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = enteralReferenceCatalog(url.searchParams.get("section") ?? undefined);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Enteral nutrition reference" });
      }
      if (param === "calculate") {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        return await handleEnteralCalculate(body, db);
      }
      return notFound();
    }

    case "critical-care": {
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = criticalCareReferenceCatalog(url.searchParams.get("section") ?? undefined);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: "Critical care nutrition reference tables" });
      }
      const ccGet = { fat: fatRequirement, "cho-fat-ratio": choFatRatioReference };
      if (param && ccGet[param]) {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const result = ccGet[param]();
        return success(result.data, { message: `Critical care nutrition: ${param}` });
      }
      const ccCalc = { "protein-by-stress": computeProteinByStress, "npe-nitrogen-ratio": computeNpeNitrogenRatio, "nitrogen-balance": computeNitrogenBalance, carbohydrate: computeCarbohydrateRequirement, "propofol-fat": computePropofolFat, electrolytes: computeElectrolyteReplacement, "potassium-deficit": computePotassiumDeficit, fluid: computeIcuFluid };
      if (param && ccCalc[param]) {
        if (request.method !== "POST") return err("Method not allowed", 405);
        const body = await parseBody(request);
        if (body === null) return err("Invalid JSON body");
        const result = ccCalc[param](body);
        if (!result.ok) return err(result.error);
        return success(result.data, { message: `Critical care nutrition: ${param}` });
      }
      return notFound();
    }

    case "dietary-assessment": {
      if (!param) {
        if (request.method !== "POST") return err("Only POST is supported for /dietary-assessment", 405);
        return await handleDietaryAssessment(request, db, env);
      }
      if (param === "reference") {
        if (request.method !== "GET") return err("Method not allowed", 405);
        const ref = dietaryAssessmentReference();
        return success(ref.data, { message: "Dietary assessment reference" });
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

/**
 * Resolves the auth + rate-limit policy for one (resource, method, param,
 * action) tuple and enforces it. Shared by routeSingle() (top-level
 * requests) and handleBatch() (the /batch envelope itself), so both go
 * through identical gating logic instead of two copies drifting apart.
 *
 * Returns either { response: <Response> } — the caller should return this
 * immediately without dispatching — or { policy, admin } on success, where
 * `admin` is the resolved admin identity (or null for public routes).
 */
async function authAndRateGate(request, env, ctx, db, resource, method, param, action) {
  const policy = routePolicy(resource, method, param, action);

  // FHIR governance: scopes, AuditEvent protection (src/fhirGovernance.js). Always on.
  if (resource === "fhir") {
    const fg = await fhirAccessGate(request, env, db, ctx, method, param, action);
    if (fg.response) return fg;
  }

  let admin = null;
  if (policy.auth === "admin") {
    admin = await resolveCredential(request, env, db, ctx);
    if (!admin.valid) return { response: unauthorized() };

    // Managing other API keys is root-only — a per-consumer key can't
    // mint or revoke keys, so a single leaked non-root key can't escalate.
    if (resource === "admin" && (param === "keys" || param === "overview" || param === "activity" || param === "monitoring" || param === "usage" || param === "health-history") && !admin.isRoot) {
      return { response: unauthorized("Only the root admin key can manage API keys") };
    }

    // Scoped roles — "reviewer" keys can only reach routes that opted into
    // requiredRole: "reviewer" (the packaged review queue); everything
    // else needs the default "admin" role. Root always passes regardless
    // of role, same as it bypasses the key-management check above.
    // Unknown/corrupt role values rank as 0 (fail closed — denied by
    // default) rather than comparing against `undefined`, which JS would
    // silently treat as passing (undefined < N is always false). A developer
    // "consumer" key ranks 0, so it is refused here.
    const requiredRole = policy.requiredRole || "admin";
    const currentRank = ROLE_RANK[admin.role] || 0;
    if (!admin.isRoot && currentRank < ROLE_RANK[requiredRole]) {
      return {
        response: unauthorized(`This action requires the '${requiredRole}' role (this key has '${admin.role}')`),
      };
    }
  }

  // Every other route needs a valid API key unless it is on the explicit allowlist
  // (isOpenRoute) or authenticates with its own credential (usesOwnCredential).
  // A valid consumer key also gets its own per-key bucket at 3x the route's limit
  // instead of the shared per-IP one. On an open route a key is only looked up if
  // the caller sent one, so GET /health stays cheap for anonymous monitors.
  let consumer = null;
  if (policy.auth !== "admin" && !usesOwnCredential(resource, method, param)) {
    const open = isOpenRoute(resource, method, param);
    if (!open || getBearerToken(request)) {
      const caller = await resolveCredential(request, env, db, ctx);
      if (!open && !caller.valid) return { response: keyRequired(env) };
      if (caller.valid && caller.role === CONSUMER_ROLE && caller.keyId != null) consumer = caller;
    }
  }

  const rateBucketKey = consumer
    ? `key:${consumer.keyId}:${resource || "root"}`
    : policy.rate.scope === "admin"
      ? `admin:${getBearerToken(request) || "unknown"}`
      : `ip:${clientIp(request)}:${resource || "root"}`;

  // Admin-authenticated requests are exempt from rate limiting — the admin
  // key itself is the access control; volume caps only apply to public routes.
  if (policy.auth !== "admin") {
    const { allowed, retryAfter } = await checkRateLimit(
      env,
      rateBucketKey,
      consumer ? consumerRateLimit(policy.rate.limit) : policy.rate.limit,
      policy.rate.windowSeconds
    );
    if (!allowed) return { response: rateLimited(retryAfter) };
    if (consumer && ctx?.waitUntil) ctx.waitUntil(bumpUsage(env, consumer.keyId).catch(() => {}));
  }

  return { policy, admin };
}

/**
 * Routes a single request (top-level or a /batch sub-request) through the
 * full pipeline: auth + rate limit gate, edge cache lookup/fill, dispatch
 * to the resource handler, and cache purge on successful admin writes.
 * Pulled out of router() so /batch can send each of its sub-requests
 * through exactly this same path — same auth rules, same rate-limit
 * buckets, same caching — rather than a parallel, easier-to-drift copy.
 */
async function routeSingle(request, url, segments, env, ctx, requestId) {
  const db = supabase(env);
  const [resource, param, action] = segments;

  const gate = await authAndRateGate(request, env, ctx, db, resource, request.method, param, action);
  if (gate.response) return gate.response;
  const { admin } = gate;

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

// ─── BATCH ───────────────────────────────────────────────────────────────────

// Cap on sub-requests per /batch call. Each sub-request runs the full
// routeSingle() pipeline — including its own Supabase (and sometimes
// Cohere/Groq/external-API) calls — so this isn't just a payload-size
// guard, it's a fan-out guard: a generous cap here multiplies straight
// into backend load and CPU time for one incoming HTTP request.
const BATCH_MAX_REQUESTS = 20;
const BATCH_ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * POST /batch — { "requests": [ { "id"?, "method", "path", "body"? }, ... ] }
 *
 * Runs every sub-request through routeSingle() — same auth, same
 * per-resource rate-limit bucket, same edge cache — and returns all results
 * together, in request order, regardless of individual failures. This is a
 * fan-out convenience for the *caller* (fewer round trips), not a way to
 * dodge per-resource auth/rate limits: each item still needs whatever
 * Authorization the underlying route requires (forwarded from the batch
 * call's own headers) and still consumes that route's own rate-limit
 * budget.
 *
 * Sub-requests run concurrently (Promise.all) since they're independent —
 * order in the response array is preserved regardless.
 */
async function handleBatch(request, env, ctx, requestId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return err("Invalid JSON body");
  }

  const items = payload && Array.isArray(payload.requests) ? payload.requests : null;
  if (!items) {
    return err('Body must be { "requests": [ { "method", "path", "body"? , "id"? }, ... ] }');
  }
  if (!items.length) return err("`requests` must contain at least one item");
  if (items.length > BATCH_MAX_REQUESTS) {
    return err(`Too many sub-requests — max ${BATCH_MAX_REQUESTS} per batch, got ${items.length}`);
  }

  const origin = new URL(request.url).origin;

  // Forward the identity/rate-limit-relevant headers from the batch call
  // itself so every sub-request is authenticated/limited as if the caller
  // had hit it directly — an admin-only sub-route still needs a valid
  // admin bearer token, and per-IP rate limiting still sees the real
  // client IP rather than defaulting to "unknown".
  const forwardedHeaders = {};
  const authHeader = request.headers.get("Authorization");
  if (authHeader) forwardedHeaders["Authorization"] = authHeader;
  const apikeyHeader = request.headers.get("apikey");
  if (apikeyHeader) forwardedHeaders["apikey"] = apikeyHeader;
  const clientIpHeader = request.headers.get("CF-Connecting-IP");
  if (clientIpHeader) forwardedHeaders["CF-Connecting-IP"] = clientIpHeader;

  async function runOne(item, index) {
    const subId = item && item.id !== undefined && item.id !== null ? String(item.id) : String(index);

    const method = String((item && item.method) || "GET").toUpperCase();
    if (!BATCH_ALLOWED_METHODS.has(method)) {
      return { id: subId, status: 400, body: { status: "error", message: `Unsupported method '${method}'` } };
    }

    const path = item && typeof item.path === "string" ? item.path : null;
    if (!path || !path.startsWith("/")) {
      return {
        id: subId,
        status: 400,
        body: { status: "error", message: "Each sub-request needs a `path` starting with '/'" },
      };
    }

    let subUrl;
    try {
      subUrl = new URL(path, origin);
    } catch {
      return { id: subId, status: 400, body: { status: "error", message: "Invalid `path`" } };
    }

    const subPathname = subUrl.pathname.replace(/\/$/, "") || "/";
    const subSegments = subPathname.split("/").filter(Boolean);
    if (subSegments[0] === "batch") {
      return {
        id: subId,
        status: 400,
        body: { status: "error", message: "Batches cannot contain nested /batch sub-requests" },
      };
    }

    const init = { method, headers: { ...forwardedHeaders } };
    if (method !== "GET" && item && item.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(item.body);
    }

    let subResponse;
    try {
      const subRequest = new Request(subUrl.toString(), init);
      subResponse = await routeSingle(subRequest, subUrl, subSegments, env, ctx, `${requestId}:${subId}`);
    } catch (e) {
      return { id: subId, status: 500, body: { status: "error", message: "Sub-request failed" } };
    }

    const text = await subResponse.text();
    let subBody;
    try {
      subBody = text ? JSON.parse(text) : null;
    } catch {
      subBody = text;
    }

    return { id: subId, status: subResponse.status, body: subBody };
  }

  const startedAt = Date.now();
  const results = await Promise.all(items.map((item, index) => runOne(item, index)));
  const succeeded = results.filter((r) => r.status < 400).length;

  return json({
    status: "success",
    data: results,
    meta: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      duration_ms: Date.now() - startedAt,
    },
  });
}

async function router(request, env, ctx, requestId) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const segments = pathname.split("/").filter(Boolean);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET /
  if (pathname === "/" && request.method === "GET") {
    return handleRoot(env);
  }

  const [resource] = segments;

  // /batch is a composite endpoint — it fans out to routeSingle() per
  // sub-request rather than dispatching to a single resource handler, so
  // it's handled before (instead of inside) the normal single-route
  // pipeline. It still goes through its own auth/rate-limit gate first.
  if (resource === "batch") {
    if (request.method !== "POST") return err("Method not allowed", 405);
    const db = supabase(env);
    const gate = await authAndRateGate(request, env, ctx, db, resource, request.method, null, null);
    if (gate.response) return gate.response;
    try {
      return await handleBatch(request, env, ctx, requestId);
    } catch (e) {
      return serverErr(e, requestId);
    }
  }

  return await routeSingle(request, url, segments, env, ctx, requestId);
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

    if (url.pathname === "/fhir" || url.pathname.startsWith("/fhir/")) {
      if (request.method !== "OPTIONS") {
        try {
          response = await finalizeFhirResponse(request, response, env, ctx, requestId, url, startedAt);
        } catch (e) {
          response = serverErr(e, requestId);
        }
      }
    }

    const tagged = new Response(response.body, response);
    tagged.headers.set("X-Request-Id", requestId);
    ctx.waitUntil(flushUpstreamFailures()); // upstream_failures writes queued during this request

    // Failed and slow calls go to request_log for the admin monitor (off unless REQUEST_LOG_STORE=true).
    // Per-route call counts go to route_usage (off unless ROUTE_USAGE_STORE=true).
    try {
      if (env.REQUEST_LOG_STORE === "true" || env.ROUTE_USAGE_STORE === "true") {
        const mdb = supabase(env);
        const info = {
          requestId, method: request.method, path: url.pathname, status: tagged.status,
          durationMs: Date.now() - startedAt, cache: tagged.headers.get("X-Cache") || undefined,
        };
        logRequest(env, ctx, mdb, info);
        recordUsage(env, ctx, mdb, info);
      }
    } catch (_) { /* monitoring must never break a response */ }

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
    // One cron ("*/5 * * * *") drives both jobs, because the Workers Free plan allows only 5 cron triggers per account.
    //  - every run: health probe -> health_checks (off unless HEALTH_CHECK_STORE=true)
    //  - the run at minute :00 of each hour: session-memory consolidation (the old hourly job)
    // Any other cron string (a manual test trigger) runs consolidation only, as before.
    const isProbeCron = event.cron === HEALTH_CRON;
    if (isProbeCron) {
      const db = env.SUPABASE_URL && env.SUPABASE_KEY ? supabase(env) : null;
      ctx.waitUntil(runHealthProbe(env, db, collectHealth).catch((e) => console.error("[health-probe] failed:", e?.message || e)));
    }
    if (!isProbeCron || new Date(event.scheduledTime ?? Date.now()).getUTCMinutes() === 0) {
      ctx.waitUntil(runScheduledConsolidation(env));
    }
    ctx.waitUntil(flushUpstreamFailures());
  },

  // Cloudflare Queues consumer — automated RAG ingestion (src/ragPipeline.js)
  async queue(batch, env, ctx) {
    await handleIngestQueue(batch, env, supabase(env));
    await flushUpstreamFailures();
  },
};
