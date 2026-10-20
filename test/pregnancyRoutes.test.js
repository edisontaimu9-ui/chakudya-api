// End-to-end through the Worker entry point: /pregnancy routes, auth and methods. The calculators use no database.
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
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.9.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

describe("/pregnancy", () => {
  test("every route needs a key", async () => {
    assert.equal((await call("GET", "/pregnancy/reference", null, null)).status, 401);
    assert.equal((await call("POST", "/pregnancy/plan", { status: "pregnant" }, null)).status, 401);
  });

  test("GET reference, with and without ?section=", async () => {
    const all = await read(await call("GET", "/pregnancy/reference"));
    assert.equal(all.status, 200);
    assert.ok(all.body.data.sections.includes("weight_gain"));
    const one = await read(await call("GET", "/pregnancy/reference?section=gdm"));
    assert.equal(one.body.data.gdm.screen_50g_one_hour.length, 3);
    assert.equal((await call("GET", "/pregnancy/reference?section=nope")).status, 400);
  });

  test("POST gestational-age defaults the reference date to today", async () => {
    const r = await read(await call("POST", "/pregnancy/gestational-age", { lmp: daysAgo(203) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.gestational_age.weeks, 29);
    assert.equal(r.body.data.trimester, 3);
    const fixed = await read(await call("POST", "/pregnancy/gestational-age", { lmp: "2026-04-01", reference_date: "2026-06-10" }));
    assert.equal(fixed.body.data.gestational_age.display, "10w0d");
  });

  test("POST weight-gain, plan and assess", async () => {
    const w = await read(await call("POST", "/pregnancy/weight-gain", { pre_pregnancy_weight_kg: 60, height_cm: 165 }));
    assert.equal(w.status, 200);
    assert.deepEqual(w.body.data.total_gain.kg, { min: 11.5, max: 16 });
    const p = await read(await call("POST", "/pregnancy/plan", { status: "pregnant", age_years: 28, pre_pregnancy_weight_kg: 60, height_cm: 162, pal_category: "low_active", lmp: daysAgo(203) }));
    assert.equal(p.status, 200);
    assert.equal(p.body.data.energy.add_on_kcal, 452);
    assert.equal(p.body.data.protein.g_per_kg, 1.1);
    const l = await read(await call("POST", "/pregnancy/plan", { status: "lactating", age_years: 28, pre_pregnancy_weight_kg: 60, height_cm: 162, pal_category: "low_active", months_postpartum: 8 }));
    assert.equal(l.body.data.energy.add_on_kcal, 400);
    const a = await read(await call("POST", "/pregnancy/assess", { trimester: 3, hemoglobin_g_dl: 10.4, glucose: { test: "screen_50g", one_hour_mg_dl: 142 } }));
    assert.equal(a.status, 200);
    assert.equal(a.body.data.sections.anemia.anemia, "anemia");
    assert.equal(a.body.data.sections.glucose.result, "positive_at_all_cutpoints");
  });

  test("errors, methods and unknown routes", async () => {
    assert.equal((await call("POST", "/pregnancy/plan", { status: "pregnant" })).status, 400);
    assert.equal((await call("POST", "/pregnancy/gestational-age", {})).status, 400);
    assert.ok([404, 405].includes((await call("GET", "/pregnancy/plan")).status));
    assert.ok([404, 405].includes((await call("POST", "/pregnancy/reference", {})).status));
    assert.ok([404, 405].includes((await call("POST", "/pregnancy/nope", {})).status));
    assert.equal((await call("POST", "/pregnancy/assess", "not json{")).status, 400);
  });
});
