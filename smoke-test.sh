#!/data/data/com.termux/files/usr/bin/bash
# ──────────────────────────────────────────────────────────────
# Chakudya API — Smoke Test
# Re-run after every deploy or dashboard binding change.
# Verifies: KV binding, RAG cache, edge cache, rate limiting,
# memory recall cache + session isolation, foods lookup cascade.
#
# Usage: bash smoke-test.sh [base-url]
# Default base URL: https://chakudya-api.edisontaimu9.workers.dev
# ──────────────────────────────────────────────────────────────

BASE="${1:-https://chakudya-api.edisontaimu9.workers.dev}"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "== Chakudya API Smoke Test =="
echo "Target: $BASE"
echo ""

# ── 1. KV binding check ──────────────────────────────────────
echo "[1] KV binding (RATE_LIMIT_KV)"
kv_bound=$(curl -s "$BASE/" | grep -o '"kv_bound":[a-z]*' | cut -d: -f2)
if [ "$kv_bound" = "true" ]; then
  pass "RATE_LIMIT_KV is bound"
else
  fail "RATE_LIMIT_KV NOT bound — rate limiting and RAG/memory caching are silently disabled. Check Workers & Pages -> chakudya-api -> Settings -> Bindings."
fi
echo ""

# ── 2. RAG retrieve cache ────────────────────────────────────
echo "[2] RAG retrieve cache (MISS -> HIT)"
q='{"query":"smoke test rag cache '"$(date +%s)"'","context":"both","top_k":1}'
c1=$(curl -s -X POST "$BASE/rag/retrieve" -H "Content-Type: application/json" -d "$q" | grep -o '"cache":"[A-Z]*"')
sleep 1
c2=$(curl -s -X POST "$BASE/rag/retrieve" -H "Content-Type: application/json" -d "$q" | grep -o '"cache":"[A-Z]*"')
if [ "$c1" = '"cache":"MISS"' ] && [ "$c2" = '"cache":"HIT"' ]; then
  pass "RAG cache MISS -> HIT"
else
  fail "RAG cache did not flip as expected (got: $c1 then $c2)"
fi
echo ""

# ── 3. Edge cache (GET /foods) ───────────────────────────────
echo "[3] Edge cache (GET /foods)"
x1=$(curl -sD - -o /dev/null "$BASE/foods" | grep -i x-cache | tr -d '\r')
x2=$(curl -sD - -o /dev/null "$BASE/foods" | grep -i x-cache | tr -d '\r')
if echo "$x2" | grep -qi "HIT"; then
  pass "Edge cache serving HIT on repeat GET /foods"
else
  fail "Edge cache did not show HIT on second call (1st: $x1 / 2nd: $x2) — may just be a different datacenter, retry a couple times before treating as a real failure"
fi
echo ""

# ── 4. Rate limiting (/rag/retrieve, 20/60s) ─────────────────
echo "[4] Rate limiting (expect 200 x20 then 429s)"
got_429=0
for i in $(seq 1 25); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/rag/retrieve" \
    -H "Content-Type: application/json" \
    -d '{"query":"smoke rate limit '"$i"' '"$(date +%s)"'","context":"both","top_k":1}')
  if [ "$code" = "429" ]; then got_429=1; fi
done
if [ "$got_429" = "1" ]; then
  pass "Rate limit triggered a 429 within 25 rapid requests"
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
m1=$(curl -s -X POST "$BASE/memory/recall" -H "Content-Type: application/json" \
  -d '{"session_id":"'"$sid1"'","query":"'"$mq"'","top_k":3}' | grep -o '"cache":"[A-Z]*"')
sleep 1
m2=$(curl -s -X POST "$BASE/memory/recall" -H "Content-Type: application/json" \
  -d '{"session_id":"'"$sid1"'","query":"'"$mq"'","top_k":3}' | grep -o '"cache":"[A-Z]*"')
m3=$(curl -s -X POST "$BASE/memory/recall" -H "Content-Type: application/json" \
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
local_src=$(curl -s "$BASE/foods/lookup?q=nsima" | grep -o '"source":"local"' | head -1)
if [ -n "$local_src" ]; then
  pass "Local lookup (nsima) resolved from Malawi FCT data"
else
  fail "Local lookup (nsima) did not return source=local"
fi

ext_q="smoketestfood$(date +%s | tail -c 5)"
ext1=$(curl -s "$BASE/foods/lookup?q=quinoa" | grep -o '"source":"[a-z_]*"' | head -1)
if echo "$ext1" | grep -qE "usda|fatsecret|openfoodfacts"; then
  pass "External cascade resolved quinoa via $ext1"
else
  fail "External cascade did not resolve quinoa as expected (got: $ext1)"
fi
ext2=$(curl -s "$BASE/foods/lookup?q=quinoa" | grep -o '"cached":[a-z]*' | head -1)
if [ "$ext2" = '"cached":true' ]; then
  pass "Repeat external lookup served from external_foods_cache"
else
  fail "Repeat external lookup was not cached (got: $ext2)"
fi
echo ""

# ── Summary ────────────────────────────────────────────────────
echo "== Summary =="
echo "Passed: $PASS   Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
