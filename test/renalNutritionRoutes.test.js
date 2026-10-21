// End-to-end through the Worker entry point: /renal-nutrition routes, auth and methods. The calculators use no database.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
before(() => { globalThis.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }); });
after(() => { globalThis.fetch = realFetch; });

const kv = new Map();
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret", RATE_LIMIT_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const ctx = { waitUntil: () => {} };
let ip = 10;
const call = (method, path, body, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.8.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("/renal-nutrition", () => {
  test("every route needs a key", async () => {
    assert.equal((await call("GET", "/renal-nutrition/reference", null, null)).status, 401);
    assert.equal((await call("GET", "/renal-nutrition/emergency-diet", null, null)).status, 401);
    assert.equal((await call("POST", "/renal-nutrition/requirements", { status: "hd", weight_kg: 60 }, null)).status, 401);
  });

  test("GET reference, with and without ?section=, and emergency-diet", async () => {
    const all = await read(await call("GET", "/renal-nutrition/reference"));
    assert.equal(all.status, 200);
    assert.ok(all.body.data.sections.includes("legacy_krause"));
    const one = await read(await call("GET", "/renal-nutrition/reference?section=known_issues"));
    assert.ok(one.body.data.known_issues.length > 5);
    assert.equal((await call("GET", "/renal-nutrition/reference?section=nope")).status, 400);
    const e = await read(await call("GET", "/renal-nutrition/emergency-diet"));
    assert.equal(e.status, 200); assert.equal(e.body.data.groups.length, 6);
  });

  test("POST stage, requirements, labs, adequacy and plan", async () => {
    const s = await read(await call("POST", "/renal-nutrition/stage", { sex: "male", age_years: 67, creatinine_mg_dl: 3.3 }));
    assert.equal(s.status, 200); assert.equal(s.body.data.g_category.id, "G4");
    const q = await read(await call("POST", "/renal-nutrition/requirements", { status: "hd", weight_kg: 60, height_cm: 165, sex: "female" }));
    assert.equal(q.status, 200); assert.deepEqual(q.body.data.targets.protein.g_per_day, { min: 60, max: 72 });
    const l = await read(await call("POST", "/renal-nutrition/labs", { labs: { potassium_meq_l: 6.1 } }));
    assert.equal(l.body.data.results[0].status, "high");
    const a = await read(await call("POST", "/renal-nutrition/adequacy", { modality: "hd", pre_bun_mg_dl: 60, post_bun_mg_dl: 20 }));
    assert.equal(a.body.data.sections.urr.percent, 66.7);
    const p = await read(await call("POST", "/renal-nutrition/plan", { sex: "male", age_years: 67, creatinine_mg_dl: 3.3, weight_kg: 48, height_cm: 170 }));
    assert.equal(p.status, 200); assert.equal(p.body.data.status, "ckd_3_5");
  });

  test("errors, methods and unknown routes; the renal food list is untouched", async () => {
    assert.equal((await call("POST", "/renal-nutrition/requirements", { status: "hd" })).status, 400);
    assert.equal((await call("POST", "/renal-nutrition/stage", {})).status, 400);
    assert.ok([404, 405].includes((await call("GET", "/renal-nutrition/plan")).status));
    assert.ok([404, 405].includes((await call("POST", "/renal-nutrition/reference", {})).status));
    assert.ok([404, 405].includes((await call("POST", "/renal-nutrition/emergency-diet", {})).status));
    assert.ok([404, 405].includes((await call("POST", "/renal-nutrition/nope", {})).status));
    assert.equal((await call("POST", "/renal-nutrition/labs", "not json{")).status, 400);
    assert.equal((await call("GET", "/renal")).status, 200);
  });
});
