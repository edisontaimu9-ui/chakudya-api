// /critical-care routes through the Worker entry point. No database is touched.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
before(() => {
  globalThis.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" } });
});
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

describe("/critical-care", () => {
  test("needs a key; method and path checks", async () => {
    assert.equal((await call("POST", "/critical-care/fluid", { weight_kg: 70 }, null)).status, 401);
    assert.equal((await call("GET", "/critical-care/reference", null, null)).status, 401);
    assert.equal((await call("GET", "/critical-care/fluid")).status, 405);
    assert.equal((await call("POST", "/critical-care/fat", {})).status, 405);
    assert.equal((await call("POST", "/critical-care/reference", {})).status, 405);
    assert.equal((await call("POST", "/critical-care/nope", {})).status, 404);
  });

  test("calculators", async () => {
    const f = await read(await call("POST", "/critical-care/fluid", { weight_kg: 70 }));
    assert.equal(f.status, 200);
    assert.equal(f.body.data.fluid_ml_per_day_high, 2450);
    const p = await read(await call("POST", "/critical-care/protein-by-stress", { stress_level: 3, weight_kg: 60 }));
    assert.equal(p.body.data.protein_g_per_day_high, 150);
    const n = await read(await call("POST", "/critical-care/nitrogen-balance", { urine_volume_l: 2, urinary_urea_mmol_l: 250 }));
    assert.equal(n.body.data.total_nitrogen_output_g_per_24h, 20.8);
    const r = await read(await call("POST", "/critical-care/npe-nitrogen-ratio", { npe_kcal: 1500, protein_g: 75 }));
    assert.equal(r.body.data.npe_to_n2_ratio, "125:1");
    const c = await read(await call("POST", "/critical-care/carbohydrate", { weight_kg: 70 }));
    assert.equal(c.body.data.minimum_requirements.text, "150 - 200 g/24h");
    const pr = await read(await call("POST", "/critical-care/propofol-fat", { propofol_percent: "2", volume_ml: 50 }));
    assert.equal(pr.body.data.fat_g_total, 5);
    const e = await read(await call("POST", "/critical-care/electrolytes", {}));
    assert.ok(e.body.data.magnesium);
    const k = await read(await call("POST", "/critical-care/potassium-deficit", { serum_k_mmol_l: 2.6 }));
    assert.equal(k.body.data.estimated_deficit, "200-400 mmol K deficit");
  });

  test("GET reference tables", async () => {
    const fat = await read(await call("GET", "/critical-care/fat"));
    assert.equal(fat.status, 200);
    assert.match(fat.body.data.usual_requirements, /30 - 40%/);
    const ratio = await read(await call("GET", "/critical-care/cho-fat-ratio"));
    assert.equal(ratio.body.data.ratios[0].cho_fat_npe_ratio, "70:30");
    const ref = await read(await call("GET", "/critical-care/reference?section=known_issues"));
    assert.ok(ref.body.data.data.length >= 3);
    assert.equal((await call("GET", "/critical-care/reference?section=zzz")).status, 400);
  });

  test("400 on bad input and bad JSON", async () => {
    assert.equal((await call("POST", "/critical-care/fluid", { weight_kg: -1 })).status, 400);
    assert.equal((await call("POST", "/critical-care/propofol-fat", { propofol_percent: "3", volume_ml: 5 })).status, 400);
    const bad = await worker.fetch(new Request("https://api.test/critical-care/fluid", { method: "POST", headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json", "CF-Connecting-IP": "10.9.99.1" }, body: "{oops" }), env, ctx);
    assert.equal(bad.status, 400);
  });
});
