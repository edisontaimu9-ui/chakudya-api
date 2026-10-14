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
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret", FHIR_AUTH_MODE: "enforce",
  RATE_LIMIT_KV: { get: async (k) => kvStore.get(k) ?? null, put: async (k, v) => { kvStore.set(k, v); } } };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = (method, path, token, body) => worker.fetch(new Request("https://api.test" + path, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
  body: body && method !== "GET" ? JSON.stringify(body) : undefined }), env, ctx);


const envOn = { ...env, REQUIRE_API_KEY: "true" };
const callOn = (method, path, token, body) => worker.fetch(new Request("https://api.test" + path, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
  body: body && method !== "GET" ? JSON.stringify(body) : undefined }), envOn, ctx);
const callOff = (method, path, token, body) => worker.fetch(new Request("https://api.test" + path, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": "8.8.8.8" },
  body: body && method !== "GET" ? JSON.stringify(body) : undefined }), env, ctx);

describe("REQUIRE_API_KEY", () => {
  let key;
  test("mint a consumer key", async () => {
    const r = await call("POST", "/developer/keys", "tok-ok", { label: "Docs site" });
    key = (await r.json()).key;
    assert.match(key, /^cnr_/);
  });

  test("off by default: anonymous requests still work", async () => {
    assert.notEqual((await callOff("GET", "/foods/categories")).status, 401);
    assert.notEqual((await callOff("POST", "/meals/analyze", null, { ingredients: [] })).status, 401);
  });

  test("on: anonymous requests to formerly public routes are refused with guidance", async () => {
    for (const [m, p] of [["GET", "/foods"], ["GET", "/foods/lookup?q=nsima"], ["GET", "/dri/life-stages"], ["GET", "/growth/assess"], ["POST", "/rag/ask"], ["POST", "/meals/analyze"], ["GET", "/glycaemic-index"], ["GET", "/memory/recall"]]) {
      const r = await callOn(m, p, null, {});
      assert.equal(r.status, 401, `${m} ${p}`);
      const b = await r.json();
      assert.equal(b.code, "api_key_required");
      assert.match(b.message, /Authorization: Bearer/);
      assert.match(r.headers.get("WWW-Authenticate") || "", /Bearer/);
    }
  });

  test("on: a bad or revoked-looking key is refused", async () => {
    assert.equal((await callOn("GET", "/foods", "cnr_" + "0".repeat(64))).status, 401);
    assert.equal((await callOn("GET", "/foods", "not-a-key")).status, 401);
  });

  test("on: a consumer key and the root key get through", async () => {
    assert.notEqual((await callOn("GET", "/foods/categories", key)).status, 401);
    assert.notEqual((await callOn("GET", "/foods/categories", "root-secret")).status, 401);
    assert.notEqual((await callOn("POST", "/meals/analyze", key, { ingredients: [] })).status, 401);
  });

  test("on: admin routes still refuse a consumer key", async () => {
    assert.equal((await callOn("POST", "/foods", key, {})).status, 401);
    assert.equal((await callOn("GET", "/admin/keys", key)).status, 401);
  });

  test("on: exempt routes stay reachable without a key", async () => {
    for (const [m, p] of [["GET", "/"], ["GET", "/health"], ["GET", "/.well-known/oauth-authorization-server"], ["POST", "/oauth/token"], ["POST", "/rag/webhook"], ["GET", "/fhir/metadata"], ["POST", "/developer/keys"]]) {
      const r = await callOn(m, p, null, {});
      const b = await r.clone().json().catch(() => ({}));
      assert.notEqual(b.code, "api_key_required", `${m} ${p} should not demand an API key`);
    }
  });

  test("on: /batch needs a key and passes it to every sub-request", async () => {
    const anon = await callOn("POST", "/batch", null, { requests: [{ method: "GET", path: "/foods/categories" }] });
    assert.equal(anon.status, 401);
    const ok = await callOn("POST", "/batch", key, { requests: [{ id: "a", method: "GET", path: "/foods/categories" }] });
    assert.equal(ok.status, 200);
    const b = await ok.json();
    assert.notEqual(b.data[0].status, 401);
  });

  test("on: root metadata advertises the requirement", async () => {
    const b = await (await callOn("GET", "/")).json();
    assert.equal(b.data.api_key_required, true);
    assert.equal((await (await callOff("GET", "/")).json()).data.api_key_required, false);
  });
});
