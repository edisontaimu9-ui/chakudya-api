// End-to-end through the Worker entry point: POST /dietary-assessment and GET /dietary-assessment/reference, with the database mocked.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };

const MAIZE = { id: 1, food_name: "Maize flour, whole", category: "Cereals", measure: "100 g", weight_g: 100, kcal: 360, protein_g: 9, carbs_g: 73, fat_g: 4, fiber_g: 7, iron_mg: 2.5, calcium_mg: 10, sodium_mg: 5, thiamin_mg: 0.4, copper_mg: 0.2, manganese_mcg: 500 };
const BEANS = { id: 2, food_name: "Beans, dried", category: "Legumes", measure: "100 g", weight_g: 100, kcal: 330, protein_g: 22, carbs_g: 55, fat_g: 1.5, fiber_g: 15, iron_mg: 6, calcium_mg: 140, sodium_mg: 10 };
const RICH = [{ id: 9, food_name: "Dried fish, small", category: "Fish", measure: "100 g", weight_g: 100, iron_mg: 20 }];
const calls = [];

before(() => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.search);
    let rows = [];
    if (u.pathname.endsWith("/foods")) {
      const order = u.searchParams.get("order") || "";
      const name = u.searchParams.get("food_name") || "";
      if (order.includes(".desc")) rows = RICH;
      else if (/maize/i.test(name)) rows = [MAIZE];
      else if (/bean/i.test(name)) rows = [BEANS];
    }
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
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.9.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("/dietary-assessment", () => {
  test("needs a key; only POST on the root path, only GET on reference", async () => {
    assert.equal((await call("POST", "/dietary-assessment", { age: 25 }, null)).status, 401);
    assert.equal((await call("GET", "/dietary-assessment/reference", null, null)).status, 401);
    assert.equal((await call("GET", "/dietary-assessment")).status, 405);
    assert.ok([404, 405].includes((await call("POST", "/dietary-assessment/reference", {})).status));
    assert.equal((await call("POST", "/dietary-assessment/nope", {})).status, 404);
  });

  test("GET reference", async () => {
    const r = await read(await call("GET", "/dietary-assessment/reference"));
    assert.equal(r.status, 200);
    assert.ok(r.body.data.assessable_nutrients.length >= 26);
  });

  test("400 on bad input", async () => {
    assert.equal((await call("POST", "/dietary-assessment", { age: 25, sex: "female" })).status, 400);
    assert.equal((await call("POST", "/dietary-assessment", { sex: "female", days: [{ intake: { kcal: 1 } }] })).status, 400);
  });

  test("analyses meals over two days: resolves foods, finds gaps, suggests foods", async () => {
    const r = await read(await call("POST", "/dietary-assessment", {
      age: 25, sex: "female", weight_kg: 60, height_cm: 162, pal_category: "low_active",
      days: [
        { date: "2026-10-20", meals: [{ meal_type: "lunch", ingredients: [{ food_name: "maize flour", quantity: 300 }, { food_name: "beans", quantity: 100 }] }] },
        { date: "2026-10-21", ingredients: [{ food_name: "maize flour", quantity: 250 }, { food_name: "unknown thing", quantity: 50 }] },
      ],
    }));
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.days_assessed, 2);
    assert.equal(d.life_stage, "female_19_30");
    const iron = d.nutrients.find((n) => n.nutrient === "iron_mg");
    assert.ok(Math.abs(iron.average_intake - 9.875) < 0.02, `iron ${iron.average_intake}`); // day 1 13.5, day 2 6.25
    assert.equal(iron.status, "between_ear_and_rda");
    assert.equal(iron.days_below_target, 2);
    assert.equal(iron.data_coverage_percent, 100);
    // extra nutrients and unit conversion (copper mg -> mcg)
    assert.ok(d.nutrients.find((n) => n.nutrient === "thiamin_mg"));
    assert.ok(d.nutrients.find((n) => n.nutrient === "copper_mcg").average_intake > 0);
    // an ingredient that cannot be found is reported, not silently dropped
    assert.equal(d.unresolved_ingredients.length, 1);
    assert.equal(d.unresolved_ingredients[0].day, "2026-10-21");
    // energy target from the IOM engine, food groups, foods richest in the gap
    assert.ok(d.energy.target_kcal > 1500);
    assert.equal(d.food_groups.frequency_days.Legumes, 1);
    assert.ok(d.food_groups.missing_every_day.includes("Fruits"));
    assert.ok(d.gaps.length > 0);
    assert.ok(d.suggested_foods.length >= 1);
    assert.equal(d.suggested_foods[0].foods[0].food_name, "Dried fish, small");
    assert.ok(d.notes.some((n) => /suggested_foods/.test(n)));
  });

  test("suggest_foods:false skips the ranking reads", async () => {
    calls.length = 0;
    const r = await read(await call("POST", "/dietary-assessment", { age: 25, sex: "female", suggest_foods: false, intake: { iron_mg: 4, kcal: 1500 } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.suggested_foods, undefined);
    assert.equal(calls.length, 0);
  });

  test("intake-only days need no food lookups", async () => {
    calls.length = 0;
    const r = await read(await call("POST", "/dietary-assessment", {
      life_stage: "male_19_30", energy_target_kcal: 2600, suggest_foods: false,
      days: [{ intake: { kcal: 2400, protein_g: 80, carbs_g: 330, fat_g: 70, sodium_mg: 3000, copper_mg: 1 } }],
    }));
    assert.equal(r.status, 200);
    assert.equal(calls.length, 0);
    assert.equal(r.body.data.energy.status, "within_10_percent");
    assert.equal(r.body.data.nutrients.find((n) => n.nutrient === "sodium_mg").status, "above_cdrr");
  });

  test("422 when no ingredient can be resolved", async () => {
    const r = await read(await call("POST", "/dietary-assessment", { age: 25, sex: "female", ingredients: [{ food_name: "zzz nothing", quantity: 10 }] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.unresolved_ingredients.length, 1);
  });
});
