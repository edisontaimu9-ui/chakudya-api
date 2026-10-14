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
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret",
  RATE_LIMIT_KV: { get: async (k) => kvStore.get(k) ?? null, put: async (k, v) => { kvStore.set(k, v); } } };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = (method, path, token, body) => worker.fetch(new Request("https://api.test" + path, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
  body: body && method !== "GET" ? JSON.stringify(body) : undefined }), env, ctx);

describe("developer keys", () => {
  let key, id;
  test("needs a login token", async () => assert.equal((await call("POST", "/developer/keys", null, { label: "a" })).status, 401));
  test("rejects a bad login token", async () => assert.equal((await call("POST", "/developer/keys", "nope", { label: "a" })).status, 401));
  test("unconfirmed email cannot create", async () => assert.equal((await call("POST", "/developer/keys", "tok-new", { label: "a" })).status, 403));
  test("creates a key and shows it once", async () => {
    const r = await call("POST", "/developer/keys", "tok-ok", { label: "My app" });
    assert.equal(r.status, 200);
    const b = await r.json(); key = b.key; id = b.data.id;
    assert.match(key, /^cnr_[0-9a-f]{64}$/);
    assert.ok(!rows[0].key_hash.includes("cnr_") && rows[0].role === "consumer" && rows[0].owner_user_id === "u1");
    const list = await (await call("GET", "/developer/keys", "tok-ok")).json();
    assert.equal(list.data.length, 1);
    assert.ok(!JSON.stringify(list).includes(key) && !JSON.stringify(list).includes("key_hash"));
  });
  test("another user sees none of it", async () => {
    users["tok-two"] = { id: "u3", email: "two@example.com", email_confirmed_at: "x" };
    assert.equal((await (await call("GET", "/developer/keys", "tok-two")).json()).data.length, 0);
    assert.equal((await call("DELETE", `/developer/keys/${id}`, "tok-two")).status, 404);
  });
  test("consumer key is refused on admin routes", async () => {
    for (const [m, p] of [["GET", "/admin/keys"], ["POST", "/foods"], ["POST", "/rag/ingest"], ["GET", "/packaged/pending"], ["DELETE", "/foods/1"]]) {
      assert.equal((await call(m, p, key, {})).status, 401, `${m} ${p}`);
    }
  });
  test("consumer key cannot manage developer keys with itself", async () => {
    assert.equal((await call("GET", "/developer/keys", key)).status, 401);
  });
  test("works on public routes, own 3x bucket, usage counted", async () => {
    const r = await call("GET", "/fhir/metadata", key);
    assert.equal(r.status, 200);
    await Promise.all(pending);
    assert.ok([...kvStore.keys()].some((k) => k.startsWith(`rl:key:${id}:fhir:`)));
    assert.equal(kvStore.get([...kvStore.keys()].find((k) => k.startsWith(`usage:${id}:`))), "1");
    const list = await (await call("GET", "/developer/keys", "tok-ok")).json();
    assert.equal(list.data[0].usage.today, 1);
  });
  test("per-key limit is 3x", async () => {
    kvStore.set(`rl:key:${id}:fhir:${Math.floor(Date.now() / 60000)}`, "299");
    assert.equal((await call("GET", "/fhir/metadata", key)).status, 200);
    assert.equal((await call("GET", "/fhir/metadata", key)).status, 429);
    assert.equal((await call("GET", "/fhir/metadata", null)).status, 200); // anonymous unaffected
  });
  test("FHIR (always enforced): consumer allowed on clinical ops, never AuditEvent", async () => {
    const ok = await call("POST", "/fhir/Condition/$diagnose", key, { resourceType: "Parameters", parameter: [] });
    assert.ok(![401, 403].includes(ok.status), `status ${ok.status}`);
    assert.equal((await call("POST", "/fhir/Condition/$diagnose", null, {})).status, 401);
    assert.equal((await call("GET", "/fhir/AuditEvent", key)).status, 403);
  });
  test("limit of 3 keys, then revoke frees a slot and kills the key", async () => {
    kvStore.clear(); // reset the per-IP key-creation rate limit used up above
    await call("POST", "/developer/keys", "tok-ok", { label: "b" });
    await call("POST", "/developer/keys", "tok-ok", { label: "c" });
    assert.equal((await call("POST", "/developer/keys", "tok-ok", { label: "d" })).status, 409);
    assert.equal((await call("DELETE", `/developer/keys/${id}`, "tok-ok")).status, 200);
    assert.equal((await call("POST", "/developer/keys", "tok-ok", { label: "d" })).status, 200);
    kvStore.clear();
    assert.equal((await call("POST", "/fhir/Condition/$diagnose", key, {})).status, 401); // revoked
  });
});
