// Paediatric routes through the Worker entry point, with the database mocked (WHO weight-for-length/height lookup for catch-up).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };

const calls = [];
let wfRows = [{ sex: "boys", measured: "standing", length_height_cm: 82, lms_m: 11.5, source: "WHO Child Growth Standards 2006" }];
before(() => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const rows = u.pathname.endsWith("/who_weight_for_length_height") ? wfRows : [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } });
  };
});
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

describe("/paediatric", () => {
  test("needs a key; method and path checks", async () => {
    assert.equal((await call("POST", "/paediatric/fluid", { weight_kg: 10 }, null)).status, 401);
    assert.equal((await call("GET", "/paediatric/reference", null, null)).status, 401);
    assert.equal((await call("GET", "/paediatric/fluid")).status, 405);
    assert.equal((await call("POST", "/paediatric/reference", {})).status, 405);
    assert.equal((await call("POST", "/paediatric/nope", {})).status, 404);
  });

  test("calculators, and /pediatric is an alias", async () => {
    const f = await read(await call("POST", "/paediatric/fluid", { weight_kg: 15 }));
    assert.equal(f.status, 200);
    assert.equal(f.body.data.daily_ml.standard, 1250);
    const a = await read(await call("POST", "/pediatric/fluid", { weight_kg: 15 }));
    assert.equal(a.body.data.daily_ml.standard, 1250);
    const e = await read(await call("POST", "/paediatric/energy", { sex: "female", age_years: 6, weight_kg: 20, height_cm: 115, pal_category: "low_active" }));
    assert.equal(e.body.data.iom_eer.id, "eer_girls_3_8");
    const p = await read(await call("POST", "/paediatric/protein", { age_months: 30, weight_kg: 12, clinical_status: "sick" }));
    assert.deepEqual(p.body.data.recommended.g_per_day, { min: 18, max: 24 });
    const pt = await read(await call("POST", "/paediatric/preterm", { weight_g: 1200 }));
    assert.equal(pt.body.data.requirements.protein.band, "1000-1500 g");
    const v = await read(await call("POST", "/paediatric/growth-velocity", { sex: "male", age_months: 2, days: 30, weight_gain_g_per_day: 20 }));
    assert.equal(v.body.data.weight.status, "within_reference");
    const ef = await read(await call("POST", "/paediatric/enteral-feeds", { age_months: 36, weight_kg: 15, route: "bolus" }));
    assert.equal(ef.body.data.feeds.bolus.goal.max, 300);
  });

  test("400 on bad input", async () => {
    assert.equal((await call("POST", "/paediatric/energy", { age_years: 6, weight_kg: 20 })).status, 400);
    assert.equal((await call("POST", "/paediatric/fluid", {})).status, 400);
  });

  test("reference and one section", async () => {
    const all = await read(await call("GET", "/paediatric/reference"));
    assert.ok(all.body.data.sections.includes("enteral_feeds"));
    const one = await read(await call("GET", "/paediatric/reference?section=preterm"));
    assert.ok(one.body.data.preterm.protein_g_per_kg_day.length === 5);
    assert.equal((await call("GET", "/paediatric/reference?section=zzz")).status, 400);
  });

  test("catch-up reads the WHO median weight and uses it as the ideal weight", async () => {
    calls.length = 0;
    const r = await read(await call("POST", "/paediatric/catch-up", { sex: "male", age_months: 24, weight_kg: 9, height_cm: 82 }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.ideal_weight_kg, 11.5);
    assert.match(r.body.data.ideal_weight_source, /WHO median weight-for-height at 82/);
    assert.equal(r.body.data.energy.catch_up_kcal_per_kg_day, Math.round((84 * 11.5) / 9));
    const q = calls.find((u) => u.pathname.endsWith("/who_weight_for_length_height")).search;
    assert.match(q, /sex=eq\.boys/);
    assert.match(q, /measured=eq\.standing/);
    assert.match(q, /length_height_cm=eq\.82\.0/);
  });

  test("catch-up with ideal_weight_kg makes no lookup; without any ideal weight it asks for one", async () => {
    calls.length = 0;
    const r = await read(await call("POST", "/paediatric/catch-up", { sex: "male", age_months: 100, weight_kg: 18, ideal_weight_kg: 21 }));
    assert.equal(r.status, 200);
    assert.equal(calls.length, 0);
    const miss = await read(await call("POST", "/paediatric/catch-up", { sex: "male", age_months: 100, weight_kg: 18 }));
    assert.equal(miss.status, 400);
    assert.match(miss.body.message, /ideal weight/i);
  });

  test("422 when the WHO row is missing, and the message says what to send", async () => {
    const saved = wfRows;
    wfRows = [];
    const r = await read(await call("POST", "/paediatric/catch-up", { sex: "male", age_months: 24, weight_kg: 9, height_cm: 82 }));
    wfRows = saved;
    assert.equal(r.status, 422);
    assert.match(r.body.message, /ideal_weight_kg/);
  });

  test("plan with catch_up:true looks up the ideal weight", async () => {
    const r = await read(await call("POST", "/paediatric/plan", { sex: "male", age_months: 24, weight_kg: 9, height_cm: 82, catch_up: true, feeding_route: "continuous" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.catch_up.ideal_weight_kg, 11.5);
    assert.equal(r.body.data.enteral_feeds.age_group, "1-6 years");
    const plain = await read(await call("POST", "/paediatric/plan", { sex: "male", age_months: 24, weight_kg: 9, height_cm: 82 }));
    assert.equal(plain.body.data.catch_up, undefined);
  });
});
