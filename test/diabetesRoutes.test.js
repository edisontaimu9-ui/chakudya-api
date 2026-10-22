// End-to-end through the Worker entry point: /diabetes routes, auth, methods, and the two routes that read the food tables.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
const tables = {
  exchange_lists: [
    { id: 1, food_name: "Brown / wholewheat bread", exchange_type: "Starch", portion: "1 slice (±42 g)", kcal: 80, kj: 335, protein_g: 3, carbs_g: 15, fat_g: 0 },
    { id: 20, food_name: "Apple (raw)", exchange_type: "Fruit", portion: "1 medium", kcal: 60, kj: 250, protein_g: 0, carbs_g: 15, fat_g: 0 },
  ],
  glycaemic_index_data: [{ food_name: "Maize stiff porridge (nsima), whole maize flour", match_keywords: ["nsima"], gi_value: 94.06, gi_category: "high", source: "Mlotha 2016", population: "Malawi" }],
};
let fail = false;
before(() => { globalThis.fetch = async (u) => { const t = Object.keys(tables).find((k) => String(u).includes(k)); return fail ? new Response("[]", { status: 500 }) : new Response(JSON.stringify(t ? tables[t] : []), { status: 200, headers: { "Content-Type": "application/json" } }); }; });
after(() => { globalThis.fetch = realFetch; });

const kv = new Map();
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret", RATE_LIMIT_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const ctx = { waitUntil: () => {} };
let ip = 10;
const call = (method, path, body, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.9.${Math.floor(ip / 250)}.${ip++ % 250}` }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("/diabetes", () => {
  test("every route needs a key", async () => {
    assert.equal((await call("GET", "/diabetes/reference", null, null)).status, 401);
    assert.equal((await call("POST", "/diabetes/status", { a1c_percent: 7 }, null)).status, 401);
    assert.equal((await call("POST", "/diabetes/exchange-plan", {}, null)).status, 401);
  });
  test("methods", async () => {
    assert.equal((await call("GET", "/diabetes/insulin")).status, 405);
    assert.equal((await call("POST", "/diabetes/reference", {})).status, 405);
    assert.equal((await call("GET", "/diabetes/nothing")).status, 404);
  });
  test("reference", async () => {
    const all = await read(await call("GET", "/diabetes/reference")); assert.equal(all.status, 200); assert.ok(all.body.data.sections.length >= 10);
    assert.equal((await read(await call("GET", "/diabetes/reference?section=a1c_eag"))).body.data.rows.length, 17);
    assert.equal((await call("GET", "/diabetes/reference?section=zzz")).status, 400);
  });
  test("status, targets, carb-plan, carb-count, insulin, hypoglycemia, exercise, plan", async () => {
    assert.equal((await read(await call("POST", "/diabetes/status", { a1c_percent: 6.8, fpg_mg_dl: 130 }))).body.data.category, "diabetes");
    assert.equal((await read(await call("POST", "/diabetes/glucose-targets", { population: "gdm" }))).body.data.targets.fasting_mg_dl, "<95 (5.3 mmol/L)");
    assert.equal((await read(await call("POST", "/diabetes/carb-plan", { carb_g_per_day: 180, meals: 3 }))).body.data.distribution[0].carb_g, 60);
    assert.equal((await read(await call("POST", "/diabetes/carb-count", { total_carb_g: 30, fibre_g: 8 }))).body.data.per_serving.counted_carb_g, 26);
    assert.equal((await read(await call("POST", "/diabetes/insulin", { tdd_units: 50, carbs_g: 60 }))).body.data.dose.carb_dose_units, 6);
    assert.equal((await read(await call("POST", "/diabetes/hypoglycemia", { glucose_mg_dl: 60 }))).body.data.level, 1);
    assert.deepEqual((await read(await call("POST", "/diabetes/exercise", { duration_min: 60, on_insulin_or_secretagogue: true }))).body.data.extra_carbohydrate_g_range, [15, 30]);
    assert.equal((await read(await call("POST", "/diabetes/plan", { labs: { a1c_percent: 8 }, carb: { carb_g_per_day: 180 } }))).body.data.glycemic_status.category, "diabetes");
  });
  test("bad bodies are 400", async () => {
    for (const [path, body] of [["status", {}], ["carb-plan", {}], ["insulin", {}], ["hypoglycemia", {}], ["exercise", {}], ["carb-count", {}]]) assert.equal((await call("POST", `/diabetes/${path}`, body)).status, 400, path);
  });
  test("exchange-plan reads exchange_lists", async () => {
    const r = await read(await call("POST", "/diabetes/exchange-plan", { exchanges: { starch: 4, fruit: 2 } }));
    assert.equal(r.status, 200); assert.equal(r.body.data.day.totals.carbs_g, 90); assert.equal(r.body.data.day.cho_choices, 6);
    assert.equal((await call("POST", "/diabetes/exchange-plan", { exchanges: { pizza: 1 } })).status, 400);
  });
  test("exchange-plan: unreadable table is a 502", async () => {
    fail = true; const s = (await call("POST", "/diabetes/exchange-plan", {})).status; fail = false; assert.equal(s, 502);
  });
  test("glycemic-load uses glycaemic_index_data and the existing matcher", async () => {
    const r = await read(await call("POST", "/diabetes/glycemic-load", { foods: [{ food: "Nsima", carbs_g: 50 }, { food: "mandasi", carbs_g: 20 }] }));
    assert.equal(r.status, 200); assert.equal(r.body.data.foods[0].gl, 47); assert.equal(r.body.data.meal.foods_without_gi, 1);
  });
});
