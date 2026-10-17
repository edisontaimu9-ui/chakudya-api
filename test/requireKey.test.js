// End-to-end through the Worker entry point with a mocked Supabase (REST + Auth).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
const rows = []; let nextId = 1;
const users = { "tok-ok": { id: "u1", email: "dev@example.com", email_confirmed_at: "2026-01-01" }, "tok-new": { id: "u2", email: "new@example.com" } };

function match(r, filters) {
  return Object.entries(filters).every(([k, f]) => {
    if (f === "is.null") return r[k] == null;
    if (f.startsWith("eq.")) return String(r[k]) === f.slice(3);
    return true;
  });
}
before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || "GET";
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/auth/v1/user") {
      const t = (init.headers?.Authorization || "").replace("Bearer ", "");
      return users[t] ? json(users[t]) : json({ msg: "bad" }, 401);
    }
    if (u.pathname === "/rest/v1/api_keys") {
      const filters = {}; for (const [k, v] of u.searchParams) if (!["select", "order", "limit", "offset"].includes(k)) filters[k] = v;
      if (method === "GET") return json(rows.filter((r) => match(r, filters)));
      if (method === "POST") { const row = { id: nextId++, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null, ...JSON.parse(init.body) }; rows.push(row); return json([row], 201); }
      if (method === "PATCH") { const hit = rows.filter((r) => match(r, filters)); hit.forEach((r) => Object.assign(r, JSON.parse(init.body))); return json(hit); }
    }
    return json([]);
  };
});
after(() => { globalThis.fetch = realFetch; });

const kvStore = new Map();
// No REQUIRE_API_KEY and no FHIR_AUTH_MODE on purpose: enforcement must not depend on either.
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret", INGEST_WEBHOOK_SECRET: "hook-secret",
  RATE_LIMIT_KV: { get: async (k) => kvStore.get(k) ?? null, put: async (k, v) => { kvStore.set(k, v); } } };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
let ipCounter = 10;
const call = (method, path, token, body, extraHeaders = {}, envOverride = env) => worker.fetch(new Request("https://api.test" + path, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.1.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`, ...extraHeaders },
  body: body && method !== "GET" ? JSON.stringify(body) : undefined }), envOverride, ctx);

const OPERATIONAL = [
  ["GET", "/foods"], ["GET", "/foods/1"], ["GET", "/foods/lookup?q=nsima"], ["GET", "/foods/search?q=nsima"], ["GET", "/foods/categories"], ["GET", "/foods/local-categories"], ["GET", "/foods/baby-foods"],
  ["GET", "/foods/compare?foods=nsima,rice"], ["GET", "/exchange"], ["GET", "/renal"], ["GET", "/formulas"], ["GET", "/glycaemic-index"],
  ["GET", "/drug-interactions"], ["GET", "/dri/life-stages"], ["POST", "/dri/compare"], ["GET", "/growth/assess"],
  ["GET", "/muac/classify?age_months=18&muac_cm=11.8"], ["GET", "/bmi-for-age/classify"], ["GET", "/weight-for-age/classify"],
  ["GET", "/fenton-preterm/references"], ["POST", "/fenton-preterm/profile"], ["GET", "/packaged"],
  ["POST", "/packaged/submit"], ["POST", "/packaged/scan"], ["POST", "/rag/retrieve"], ["POST", "/rag/ask"],
  ["POST", "/memory/write"], ["GET", "/memory/recall"], ["POST", "/memory/recall"], ["GET", "/favorites"], ["POST", "/history"],
  ["GET", "/log"], ["POST", "/log"], ["POST", "/recipes/calculate"], ["POST", "/meals/analyze"], ["POST", "/ingredients/parse"],
  ["POST", "/batch"], ["GET", "/bmi-for-age"], ["GET", "/does-not-exist"],
  ["POST", "/fhir/Condition/$diagnose"], ["POST", "/fhir/Observation/$evaluate-growth"], ["POST", "/fhir/ConceptMap/$translate"],
  ["POST", "/fhir/$validate"], ["GET", "/fhir/Patient"],
];

// Registry writes and privileged reads: an admin credential is required.
const ADMIN_ONLY = [
  ["POST", "/foods"], ["PUT", "/foods/1"], ["PATCH", "/foods/1"], ["DELETE", "/foods/1"], ["POST", "/foods/bulk"],
  ["POST", "/exchange"], ["PUT", "/renal/1"], ["POST", "/formulas"], ["DELETE", "/formulas/1"],
  ["POST", "/glycaemic-index"], ["POST", "/glycaemic-index/bulk"], ["POST", "/drug-interactions"], ["DELETE", "/drug-interactions/1"],
  ["POST", "/bmi-for-age/bulk"], ["POST", "/weight-for-age/bulk"], ["POST", "/fenton-preterm/bulk"],
  ["PATCH", "/packaged/1"], ["DELETE", "/packaged/1"], ["GET", "/packaged/pending"], ["POST", "/packaged/1/approve"], ["POST", "/packaged/1/reject"],
  ["POST", "/rag/ingest"], ["POST", "/rag/upload"], ["POST", "/rag/enqueue"], ["GET", "/rag/jobs"], ["DELETE", "/rag/source"],
  ["POST", "/memory/consolidate"], ["GET", "/admin/keys"], ["POST", "/admin/keys"], ["DELETE", "/admin/keys/1"],
  ["GET", "/fhir/AuditEvent"],
];

describe("API key enforcement", () => {
  let key;
  test("mint a consumer key through the developer portal", async () => {
    const r = await call("POST", "/developer/keys", "tok-ok", { label: "Docs site" });
    assert.equal(r.status, 200);
    key = (await r.json()).key;
    assert.match(key, /^cnr_/);
  });

  test("anonymous requests to every operational route are refused with guidance", async () => {
    for (const [m, p] of OPERATIONAL) {
      const r = await call(m, p, null, {});
      assert.equal(r.status, 401, `${m} ${p}`);
      const b = await r.json();
      if (p.startsWith("/fhir/")) {
        assert.equal(b.resourceType, "OperationOutcome", `${m} ${p}`);
      } else {
        assert.equal(b.code, "api_key_required", `${m} ${p}`);
        assert.match(b.message, /Authorization: Bearer/);
        assert.match(r.headers.get("WWW-Authenticate") || "", /Bearer/);
      }
    }
  });

  test("anonymous writes to the root path are refused too", async () => {
    assert.equal((await call("POST", "/", null, {})).status, 401);
  });

  test("enforcement does not depend on REQUIRE_API_KEY or FHIR_AUTH_MODE", async () => {
    for (const extra of [{ REQUIRE_API_KEY: "false" }, { REQUIRE_API_KEY: "" , FHIR_AUTH_MODE: "open" }]) {
      const e = { ...env, ...extra };
      assert.equal((await call("GET", "/foods", null, null, {}, e)).status, 401);
      assert.equal((await call("POST", "/meals/analyze", null, { ingredients: [] }, {}, e)).status, 401);
      assert.equal((await call("POST", "/fhir/Condition/$diagnose", null, {}, {}, e)).status, 401);
    }
  });

  test("a bad key, a revoked-looking key and a JWT are refused", async () => {
    assert.equal((await call("GET", "/foods", "cnr_" + "0".repeat(64))).status, 401);
    assert.equal((await call("GET", "/foods", "not-a-key")).status, 401);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwicm9sZSI6ImFkbWluIn0.c2ln";
    assert.equal((await call("GET", "/foods", jwt)).status, 401);
    assert.equal((await call("POST", "/foods", jwt, {})).status, 401);
  });

  test("a consumer key and the root key get through on operational routes", async () => {
    for (const token of [key, "root-secret"]) {
      assert.notEqual((await call("GET", "/foods/categories", token)).status, 401);
      assert.notEqual((await call("POST", "/meals/analyze", token, { ingredients: [] })).status, 401);
      assert.notEqual((await call("POST", "/fhir/Condition/$diagnose", token, { resourceType: "Parameters", parameter: [] })).status, 401);
    }
  });

  test("registry writes and privileged reads need an admin credential; a consumer key is refused", async () => {
    for (const [m, p] of ADMIN_ONLY) {
      assert.equal((await call(m, p, null, {})).status, 401, `anonymous ${m} ${p}`);
      const c = await call(m, p, key, {});
      assert.ok([401, 403].includes(c.status), `consumer ${m} ${p} -> ${c.status}`);
      if (!p.startsWith("/fhir/")) assert.match((await c.json()).message, /role|root admin key/, `${m} ${p}`);
    }
  });

  test("the root key reaches admin routes", async () => {
    for (const [m, p] of [["POST", "/foods"], ["GET", "/admin/keys"], ["GET", "/packaged/pending"], ["POST", "/glycaemic-index"]]) {
      const r = await call(m, p, "root-secret", {});
      assert.notEqual(r.status, 401, `${m} ${p}`);
      assert.notEqual(r.status, 403, `${m} ${p}`);
    }
  });

  test("only GET /, GET /health and the FHIR conformance reads work with no credential", async () => {
    for (const [m, p] of [["GET", "/"], ["GET", "/health"], ["GET", "/fhir/metadata"], ["GET", "/fhir/Questionnaire"],
      ["GET", "/fhir/Questionnaire/nfpe"], ["GET", "/fhir/StructureDefinition/adime-composition"], ["GET", "/fhir/ConceptMap/assessment-item-to-loinc"]]) {
      const r = await call(m, p);
      const b = await r.clone().json().catch(() => ({}));
      assert.notEqual(r.status, 401, `${m} ${p}`);
      assert.notEqual(b.code, "api_key_required", `${m} ${p}`);
    }
    assert.equal((await call("POST", "/health")).status, 401, "only GET /health is open");
    assert.equal((await call("POST", "/fhir/metadata", null, {})).status, 401, "only GET metadata is open");
  });

  test("routes with their own credential reject a request that lacks it", async () => {
    const dev = await call("POST", "/developer/keys", null, { label: "x" });
    assert.equal(dev.status, 401);
    assert.notEqual((await dev.json()).code, "api_key_required", "the handler asks for a login token instead");
    assert.equal((await call("POST", "/developer/keys", key, { label: "x" })).status, 401, "an API key is not a login token");
    assert.equal((await call("GET", "/developer/other")).status, 401);

    const wrong = await call("POST", "/rag/webhook", null, {}, { "x-webhook-secret": "nope" });
    assert.equal(wrong.status, 401);
    assert.notEqual((await wrong.json()).code, "api_key_required");
    assert.equal((await call("POST", "/rag/webhook", null, {}, {}, { ...env, INGEST_WEBHOOK_SECRET: undefined })).status, 503, "unconfigured secret fails closed");
    assert.equal((await call("GET", "/rag/webhook")).status, 401, "only POST /rag/webhook skips the key check");
  });

  test("OAuth is gone: no token endpoint, no metadata, no client admin", async () => {
    for (const [m, p] of [["POST", "/oauth/token"], ["GET", "/.well-known/oauth-authorization-server"]]) {
      assert.equal((await call(m, p, null, {})).status, 401, `${m} ${p} anonymous`);
      assert.equal((await call(m, p, "root-secret", {})).status, 404, `${m} ${p} with the root key`);
    }
    assert.equal((await call("GET", "/oauth/token", key)).status, 404, "a consumer key just gets 404");
    assert.equal((await call("POST", "/oauth/token", key, {})).status, 401, "and no token is minted for a POST");
    for (const [m, p] of [["GET", "/admin/oauth-clients"], ["POST", "/admin/oauth-clients"], ["DELETE", "/admin/oauth-clients/1"]]) {
      assert.equal((await call(m, p, "root-secret", {})).status, 404, `${m} ${p}`);
    }
  });

  test("/batch needs a key and passes it to every sub-request", async () => {
    const anon = await call("POST", "/batch", null, { requests: [{ method: "GET", path: "/foods/categories" }] });
    assert.equal(anon.status, 401);
    const ok = await call("POST", "/batch", key, { requests: [{ id: "a", method: "GET", path: "/foods/categories" }, { id: "b", method: "POST", path: "/foods", body: {} }] });
    assert.equal(ok.status, 200);
    const b = await ok.json();
    assert.notEqual(b.data[0].status, 401);
    assert.equal(b.data[1].status, 401, "a consumer key still cannot write registry data through /batch");
  });

  test("GET / documents the real allowlist and no longer mentions OAuth", async () => {
    const b = (await (await call("GET", "/")).json()).data;
    assert.equal(b.api_key_required, true);
    assert.deepEqual(b.open_endpoints.map((x) => x.split(" ").slice(0, 2).join(" ")), ["GET /", "GET /health", "GET /fhir/metadata"]);
    assert.match(b.auth, /Bearer <API key>/);
    assert.match(b.auth, /admin key/);
    assert.doesNotMatch(JSON.stringify(b), /oauth\/token|oauth-clients|OAuth token/i);
    assert.doesNotMatch(JSON.stringify(b.endpoints), /\(public/);
  });
});
