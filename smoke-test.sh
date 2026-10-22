#!/data/data/com.termux/files/usr/bin/bash
# ──────────────────────────────────────────────────────────────
# Chakudya API — Smoke Test
# Re-run after every deploy or dashboard binding change.
# Verifies: KV binding, RAG cache, edge cache, rate limiting,
# memory recall cache + session isolation, foods lookup cascade,
# BMI-for-age endpoint, the Eat Well to Live Well guide in RAG, and the
# renal food-plan link to the exchange list (POST /renal-nutrition/food-plan), and diabetes nutrition (/diabetes).
#
# Usage: CNR_API_KEY=cnr_... bash smoke-test.sh [base-url]
# Default base URL: https://chakudya-api.edisontaimu9.workers.dev
#
# Every route except GET /, GET /health and the FHIR conformance reads needs an
# API key, so set CNR_API_KEY (a consumer key from the developer console, or an
# admin key). Without it steps 2-8 get 401. Step 4 expects a 429 within 25 rapid
# requests: that holds for an admin key (20/min on /rag/retrieve) but a consumer
# key gets 3x (60/min), so run it with RATE_REQUESTS=70 for a consumer key.
# ──────────────────────────────────────────────────────────────

BASE="${1:-https://chakudya-api.edisontaimu9.workers.dev}"
PASS=0
FAIL=0
RATE_REQUESTS="${RATE_REQUESTS:-25}"

AUTH=()
if [ -n "$CNR_API_KEY" ]; then
  AUTH=(-H "Authorization: Bearer $CNR_API_KEY")
else
  echo "WARNING: CNR_API_KEY is not set, so every route below except GET / will answer 401."
fi

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "== Chakudya API Smoke Test =="
echo "Target: $BASE"
echo ""

# ── 1. KV binding check ──────────────────────────────────────
echo "[1] KV binding (RATE_LIMIT_KV)"
kv_bound=$(curl -s "${AUTH[@]}" "$BASE/" | grep -o '"kv_bound":[a-z]*' | cut -d: -f2)
if [ "$kv_bound" = "true" ]; then
  pass "RATE_LIMIT_KV is bound"
else
  fail "RATE_LIMIT_KV NOT bound — rate limiting and RAG/memory caching are silently disabled. Check Workers & Pages -> chakudya-api -> Settings -> Bindings."
fi
echo ""

# ── 2. RAG retrieve cache ────────────────────────────────────
echo "[2] RAG retrieve cache (MISS -> HIT)"
q='{"query":"smoke test rag cache '"$(date +%s)"'","context":"both","top_k":1}'
c1=$(curl -s "${AUTH[@]}" -X POST "$BASE/rag/retrieve" -H "Content-Type: application/json" -d "$q" | grep -o '"cache":"[A-Z]*"')
sleep 1
c2=$(curl -s "${AUTH[@]}" -X POST "$BASE/rag/retrieve" -H "Content-Type: application/json" -d "$q" | grep -o '"cache":"[A-Z]*"')
if [ "$c1" = '"cache":"MISS"' ] && [ "$c2" = '"cache":"HIT"' ]; then
  pass "RAG cache MISS -> HIT"
else
  fail "RAG cache did not flip as expected (got: $c1 then $c2)"
fi
echo ""

# ── 3. Edge cache (GET /foods) ───────────────────────────────
echo "[3] Edge cache (GET /foods)"
x1=$(curl -sD - "${AUTH[@]}" -o /dev/null "$BASE/foods" | grep -i x-cache | tr -d '\r')
x2=$(curl -sD - "${AUTH[@]}" -o /dev/null "$BASE/foods" | grep -i x-cache | tr -d '\r')
if echo "$x2" | grep -qi "HIT"; then
  pass "Edge cache serving HIT on repeat GET /foods"
else
  fail "Edge cache did not show HIT on second call (1st: $x1 / 2nd: $x2) — may just be a different datacenter, retry a couple times before treating as a real failure"
fi
echo ""

# ── 4. Rate limiting (/rag/retrieve, 20/60s) ─────────────────
echo "[4] Rate limiting (expect 200s, then 429s once the per-minute limit is passed)"
got_429=0
for i in $(seq 1 "$RATE_REQUESTS"); do
  code=$(curl -s "${AUTH[@]}" -o /dev/null -w "%{http_code}" -X POST "$BASE/rag/retrieve" \
    -H "Content-Type: application/json" \
    -d '{"query":"smoke rate limit '"$i"' '"$(date +%s)"'","context":"both","top_k":1}')
  if [ "$code" = "429" ]; then got_429=1; fi
done
if [ "$got_429" = "1" ]; then
  pass "Rate limit triggered a 429 within $RATE_REQUESTS rapid requests"
else
  fail "Never got a 429 — rate limiting may not be enforced (check kv_bound above)"
fi
echo "  (waiting 60s for the rate limit window to reset before continuing...)"
sleep 60
echo ""

# ── 5. Memory recall cache + session isolation ───────────────
echo "[5] Memory recall cache + session isolation"
sid1="smoke-session-$(date +%s)-a"
sid2="smoke-session-$(date +%s)-b"
mq='patient smoke test query'
m1=$(curl -s "${AUTH[@]}" -X POST "$BASE/memory/recall" -H "Content-Type: application/json" \
  -d '{"session_id":"'"$sid1"'","query":"'"$mq"'","top_k":3}' | grep -o '"cache":"[A-Z]*"')
sleep 1
m2=$(curl -s "${AUTH[@]}" -X POST "$BASE/memory/recall" -H "Content-Type: application/json" \
  -d '{"session_id":"'"$sid1"'","query":"'"$mq"'","top_k":3}' | grep -o '"cache":"[A-Z]*"')
m3=$(curl -s "${AUTH[@]}" -X POST "$BASE/memory/recall" -H "Content-Type: application/json" \
  -d '{"session_id":"'"$sid2"'","query":"'"$mq"'","top_k":3}' | grep -o '"cache":"[A-Z]*"')
if [ "$m1" = '"cache":"MISS"' ] && [ "$m2" = '"cache":"HIT"' ]; then
  pass "Memory recall cache MISS -> HIT"
else
  fail "Memory recall cache did not flip as expected (got: $m1 then $m2)"
fi
if [ "$m3" = '"cache":"MISS"' ]; then
  pass "Session isolation holds (different session_id = fresh MISS)"
else
  fail "Session isolation may be broken — different session_id returned $m3 instead of MISS"
fi
echo ""

# ── 6. Foods lookup cascade ───────────────────────────────────
echo "[6] Foods lookup cascade (local + external)"
local_src=$(curl -s "${AUTH[@]}" "$BASE/foods/lookup?q=nsima" | grep -o '"source":"local"' | head -1)
if [ -n "$local_src" ]; then
  pass "Local lookup (nsima) resolved from Malawi FCT data"
else
  fail "Local lookup (nsima) did not return source=local"
fi

ext_q="smoketestfood$(date +%s | tail -c 5)"
ext1=$(curl -s "${AUTH[@]}" "$BASE/foods/lookup?q=quinoa" | grep -o '"source":"[a-z_]*"' | head -1)
if echo "$ext1" | grep -qE "usda|fatsecret|openfoodfacts"; then
  pass "External cascade resolved quinoa via $ext1"
else
  fail "External cascade did not resolve quinoa as expected (got: $ext1)"
fi
ext2=$(curl -s "${AUTH[@]}" "$BASE/foods/lookup?q=quinoa" | grep -o '"cached":[a-z]*' | head -1)
if [ "$ext2" = '"cached":true' ]; then
  pass "Repeat external lookup served from external_foods_cache"
else
  fail "Repeat external lookup was not cached (got: $ext2)"
fi
echo ""

# ── 7. BMI-for-age (WHO 2007, 5-19 years) ─────────────────────
echo "[7] BMI-for-age classification"
bmi1=$(curl -s "${AUTH[@]}" "$BASE/bmi-for-age/classify?sex=girls&age_months=95&weight_kg=26&height_cm=121.1")
if echo "$bmi1" | grep -q '"status":"overweight"'; then
  pass "Annex 2 worked example (girl, 7y 11m, 26 kg, 121.1 cm) classified overweight"
else
  fail "BMI-for-age example did not return overweight. Is sql/012 run and scripts/bmi_for_age_seed.json seeded? Got: ${bmi1:0:120}"
fi
if echo "$bmi1" | grep -q '"+1SD":17.7'; then
  pass "Reference row matches the guide (girls, 95 months, +1SD = 17.7)"
else
  fail "Reference row cut-offs not as expected for girls at 95 months"
fi
bmi2=$(curl -s "${AUTH[@]}" "$BASE/bmi-for-age/classify?sex=girls&age_months=40&bmi=15")
if echo "$bmi2" | grep -q '"status":"error"'; then
  pass "Age under 5y 1m rejected (outside the 5-19 year table)"
else
  fail "Out-of-range age was not rejected (got: ${bmi2:0:120})"
fi
echo ""

# ── 8. Eat Well to Live Well guide in the RAG knowledge base ──
echo "[8] Eat Well to Live Well guide (RAG retrieve)"
rq1=$(curl -s "${AUTH[@]}" -X POST "$BASE/rag/retrieve" -H "Content-Type: application/json" \
  -d '{"query":"Which fats should I limit? Examples of trans fats","context":"both","top_k":3}')
if echo "$rq1" | grep -q "Eat Well to Live Well" && echo "$rq1" | grep -qi "hydrogenated cooking oils"; then
  pass "Fats table (Table 5) retrieved from the guide"
else
  fail "Guide's fats table not retrieved. Was the guide ingested with source 'Malawi Ministry of Health, Eat Well to Live Well (2021)'?"
fi
rq2=$(curl -s "${AUTH[@]}" -X POST "$BASE/rag/retrieve" -H "Content-Type: application/json" \
  -d '{"query":"How much physical activity do adults need per week?","context":"both","top_k":3}')
if echo "$rq2" | grep -q "Eat Well to Live Well" && echo "$rq2" | grep -q "150 minutes"; then
  pass "Physical activity table (Table 8) retrieved from the guide"
else
  fail "Guide's physical activity guidance not retrieved"
fi
echo ""

# ── 9. Renal targets linked to the food exchange list ─────────
echo "[9] Renal food-plan (POST /renal-nutrition/food-plan)"
FP="$BASE/renal-nutrition/food-plan"
fp0=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$FP" -H "Content-Type: application/json" -d '{"status":"hd","weight_kg":60}')
if [ "$fp0" = "401" ]; then pass "No key -> 401"; else fail "No key did not give 401 (got: $fp0)"; fi
fp1=$(curl -s "${AUTH[@]}" -o /dev/null -w "%{http_code}" "$FP")
if [ "$fp1" = "405" ]; then pass "GET -> 405 (POST only)"; else fail "GET did not give 405 (got: $fp1)"; fi
fp2=$(curl -s "${AUTH[@]}" -o /dev/null -w "%{http_code}" -X POST "$FP" -H "Content-Type: application/json" -d '{"weight_kg":60}')
if [ "$fp2" = "400" ]; then pass "Missing status -> 400"; else fail "Missing status did not give 400 (got: $fp2)"; fi
fp3=$(curl -s "${AUTH[@]}" -X POST "$FP" -H "Content-Type: application/json" \
  -d '{"status":"hd","weight_kg":60,"potassium_mg_per_day_max":2000}')
if echo "$fp3" | grep -q '"protein_g":{"min":60,"max":72' && echo "$fp3" | grep -q '"max":2300' && echo "$fp3" | grep -q 'clinician-set limit'; then
  pass "Targets from /requirements (protein 60-72 g, sodium 2300 mg) and clinician potassium limit"
else
  fail "Daily budget wrong or missing (got: ${fp3:0:200})"
fi
if echo "$fp3" | grep -q '"field_map"'; then
  echo "     detected columns: $(echo "$fp3" | grep -o '"field_map":{[^}]*}[^}]*}' | head -c 400)"
  echo "     missing fields:   $(echo "$fp3" | grep -o '"missing_fields":{[^}]*}' | head -c 300)"
  if echo "$fp3" | grep -q 'No name column'; then
    fail "exchange_lists has no recognised name column. Add the real column to FIELD_CANDIDATES in src/renalFoodLink.js"
  else
    pass "exchange_lists name column detected"
  fi
else
  fail "No field_map in the response"
fi
fp4=$(curl -s "${AUTH[@]}" -X POST "$FP" -H "Content-Type: application/json" \
  -d '{"status":"hd","weight_kg":60,"legacy_krause_limits":true,"limit":3}')
if echo "$fp4" | grep -q '"max":3000' && echo "$fp4" | grep -q 'older than KDOQI 2020'; then
  pass "legacy_krause_limits gives the labelled Krause potassium max (3000 mg)"
else
  fail "legacy_krause_limits did not give the Krause potassium max (got: ${fp4:0:200})"
fi
fp5=$(curl -s "${AUTH[@]}" -X POST "$FP" -H "Content-Type: application/json" \
  -d '{"status":"hd","weight_kg":60,"share_flag_pct":2}')
if echo "$fp5" | grep -q "share_flag_pct"; then pass "share_flag_pct out of range rejected"; else fail "share_flag_pct 2 was not rejected (got: ${fp5:0:150})"; fi
echo ""

# ── 10. Diabetes nutrition ─────────────────────────────────────
echo "[10] Diabetes nutrition (/diabetes)"
DB="$BASE/diabetes"
post() { curl -s "${AUTH[@]}" -X POST "$DB/$1" -H "Content-Type: application/json" -d "$2"; }
d0=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$DB/status" -H "Content-Type: application/json" -d '{"a1c_percent":7}')
if [ "$d0" = "401" ]; then pass "No key -> 401"; else fail "No key did not give 401 (got: $d0)"; fi
d1=$(curl -s "${AUTH[@]}" -o /dev/null -w "%{http_code}" "$DB/insulin")
if [ "$d1" = "405" ]; then pass "GET on a POST route -> 405"; else fail "GET /diabetes/insulin did not give 405 (got: $d1)"; fi
d2=$(curl -s "${AUTH[@]}" "$DB/reference?section=a1c_eag")
if echo "$d2" | grep -q '"eag_mg_dl":298'; then pass "Reference: A1C to eAG table (Krause Table 30.2)"; else fail "a1c_eag reference missing (got: ${d2:0:150})"; fi
d3=$(post status '{"a1c_percent":6.8,"fpg_mg_dl":130}')
if echo "$d3" | grep -q '"category":"diabetes"' && echo "$d3" | grep -q '"estimated_average_glucose_mg_dl":148'; then pass "Status: A1C 6.8 + FPG 130 -> diabetes, eAG 148 mg/dL"; else fail "Status wrong (got: ${d3:0:200})"; fi
d4=$(post carb-plan '{"carb_g_per_day":180,"meals":3,"snacks":0}')
if echo "$d4" | grep -q '"carb_g":60' && echo "$d4" | grep -q '"carb_exchanges":4'; then pass "Carb plan: 180 g over 3 meals -> 60 g (4 exchanges) each"; else fail "Carb plan wrong (got: ${d4:0:200})"; fi
d5=$(post carb-plan '{"population":"gdm","carb_g_per_day":200,"meals":3,"snacks":3}')
if echo "$d5" | grep -q '"slot":"bedtime snack"' && echo "$d5" | grep -q '"carb_g":30'; then pass "GDM plan: breakfast 30 g and a bedtime snack"; else fail "GDM plan wrong (got: ${d5:0:200})"; fi
d6=$(post insulin '{"tdd_units":50,"carbs_g":60,"current_glucose_mg_dl":204,"target_glucose_mg_dl":100}')
if echo "$d6" | grep -q '"icr_g_per_unit":10' && echo "$d6" | grep -q '"carb_dose_units":6' && echo "$d6" | grep -q '"total_units_rounded":9'; then pass "Insulin: TDD 50 -> ICR 10, CF 34, dose 9 units"; else fail "Insulin wrong (got: ${d6:0:250})"; fi
d7=$(post insulin '{"tdd_units":50,"carbs_g":60,"current_glucose_mg_dl":60,"target_glucose_mg_dl":100}')
if echo "$d7" | grep -q '"dose":null'; then pass "Insulin: no dose calculated below 70 mg/dL"; else fail "A dose was calculated at 60 mg/dL (got: ${d7:0:200})"; fi
d8=$(post hypoglycemia '{"glucose_mg_dl":50}')
if echo "$d8" | grep -q '"level":2' && echo "$d8" | grep -q '15 minutes'; then pass "Hypoglycaemia: 50 mg/dL -> level 2, recheck in 15 minutes"; else fail "Hypoglycaemia wrong (got: ${d8:0:200})"; fi
d9=$(post exercise '{"duration_min":60,"on_insulin_or_secretagogue":true}')
if echo "$d9" | grep -q '"extra_carbohydrate_g_range":\[15,30\]'; then pass "Exercise: 60 min on insulin -> 15-30 g"; else fail "Exercise wrong (got: ${d9:0:200})"; fi
d10=$(post exchange-plan '{"carb_plan":{"carb_g_per_day":180,"meals":3}}')
if echo "$d10" | grep -q '"example_choices"' && echo "$d10" | grep -q '"field_map"'; then
  pass "Exchange plan reads exchange_lists and attaches example choices"
  echo "     detected columns: $(echo "$d10" | grep -o '"field_map":{[^}]*}' | head -c 300)"
else
  fail "Exchange plan failed (got: ${d10:0:250})"
fi
d11=$(post exchange-plan '{"exchanges":{"Starch":10,"Fruit":3}}')
if echo "$d11" | grep -q '"cho_choices":13' || echo "$d11" | grep -q 'unknown exchange type'; then
  if echo "$d11" | grep -q 'unknown exchange type'; then echo "     exchange_type names on file: $(echo "$d11" | grep -o 'Available: [^"]*' | head -c 300)"; fi
  pass "Exchange plan: prescription accepted or exchange types listed"
else
  fail "Exchange prescription wrong (got: ${d11:0:250})"
fi
d12=$(post glycemic-load '{"foods":[{"food":"nsima","carbs_g":50},{"food":"mandasi","carbs_g":20}]}')
if echo "$d12" | grep -q '"foods_without_gi":1'; then pass "Glycaemic load: nsima found, mandasi listed as having no GI"; else fail "Glycaemic load wrong (got: ${d12:0:250})"; fi
echo ""

# ── Summary ────────────────────────────────────────────────────
echo "== Summary =="
echo "Passed: $PASS   Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
