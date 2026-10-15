// End-to-end through the Worker entry point with a mocked Supabase: /measures, /foods/convert and the
// recipe calculator's use of the same gram conversion.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
// Cloudflare's edge cache does not exist under node: a cache that never hits.
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
const FOODS = [
  { id: 1, food_name: "Rice, cooked", kcal: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3, measure: null, weight_g: null },
  { id: 2, food_name: "Nsima (maize stiff porridge)", kcal: 110, protein_g: 2.5, carbs_g: 24, fat_g: 0.5, measure: null, weight_g: null },
  { id: 3, food_name: "Milk, whole", kcal: 61, protein_g: 3.2, carbs_g: 4.8, fat_g: 3.3, measure: null, weight_g: null },
  { id: 4, food_name: "Rice, soaked, (Mpunga woviika)", kcal: 80, protein_g: 1.3, carbs_g: 18, fat_g: 0.1, measure: "100g", weight_g: 100 },
  { id: 5, food_name: "Milk, skim", kcal: 35, protein_g: 3.4, carbs_g: 5, fat_g: 0.1, measure: null, weight_g: null },
];

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/rest/v1/foods") {
      const id = u.searchParams.get("id");
      const name = u.searchParams.get("food_name");
      let rows = FOODS;
      if (id) rows = rows.filter((f) => `eq.${f.id}` === id);
      if (name) {
        const needle = name.replace(/^ilike\.\*/, "").replace(/\*$/, "").toLowerCase();
        rows = rows.filter((f) => f.food_name.toLowerCase().includes(needle));
      }
      return json(rows);
    }
    return json([]);
  };
});
after(() => { globalThis.fetch = realFetch; });

const kv = new Map();
const env = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret",
  RATE_LIMIT_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
};
const ctx = { waitUntil: () => {} };
let ip = 10;
const call = (method, path, body, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.2.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("GET /measures", () => {
  test("needs a key", async () => {
    assert.equal((await call("GET", "/measures", null, null)).status, 401);
  });
  test("returns units, tables and scoop sizes", async () => {
    const { status, body } = await read(await call("GET", "/measures"));
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.units.find((u) => u.id === "cup").ml, 250);
    assert.equal(d.units.find((u) => u.id === "us_cup").ml, 240);
    assert.equal(d.units.find((u) => u.id === "dsp").ml, 20);
    assert.equal(d.scoop_sizes.length, 10);
    assert.ok(d.reference_tables.household_metric_uct);
  });
  test("one section", async () => {
    const { status, body } = await read(await call("GET", "/measures?section=scoop_sizes"));
    assert.equal(status, 200);
    assert.equal(body.data[0].number, 6);
    assert.equal((await call("GET", "/measures?section=bogus")).status, 400);
  });
  test("unit to unit", async () => {
    let r = await read(await call("GET", "/measures/convert?amount=3&from=tbsp&to=ml"));
    assert.equal(r.body.data.results[0].quantity, 45);
    r = await read(await call("GET", "/measures/convert?amount=1/2&from=cup"));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.results.find((x) => x.unit === "ml").quantity, 125);
    assert.equal((await call("GET", "/measures/convert?amount=1&from=cup&to=g")).status, 422);
    assert.equal((await call("GET", "/measures/convert?amount=1&from=nope")).status, 400);
    assert.equal((await call("GET", "/measures/convert?amount=1")).status, 400);
  });
});

describe("GET /foods/convert", () => {
  test("household in, standard out: 2 cups of rice", async () => {
    const { status, body } = await read(await call("GET", "/foods/convert?q=rice&amount=2&unit=cup"));
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.food.food_name, "Rice, cooked");
    assert.equal(d.standard.grams, 300);
    assert.equal(d.standard.milliliters, 500);
    assert.equal(d.input.kind, "household_volume");
    assert.equal(d.household.servings[0].quantity, 2);
    assert.equal(d.nutrients.kcal, 390);
    assert.equal(d.density_g_per_ml, 0.6);
    assert.deepEqual(d.assumptions, []);
  });
  test("standard in, household out: 300 g of rice", async () => {
    const d = (await read(await call("GET", "/foods/convert?q=rice&amount=300&unit=g"))).body.data;
    assert.equal(d.input.kind, "standard_weight");
    assert.equal(d.household.volume.suggested.unit, "cup");
    assert.equal(d.household.volume.suggested.quantity, 2);
    assert.equal(d.household.servings[0].display_quantity, "2");
  });
  test("a spoon uses the food's density, a fraction works, by id too", async () => {
    let d = (await read(await call("GET", "/foods/convert?q=rice&amount=1&unit=tbsp"))).body.data;
    assert.equal(d.standard.grams, 9);
    d = (await read(await call("GET", "/foods/convert?q=rice&amount=1/2&unit=cup"))).body.data;
    assert.equal(d.standard.grams, 75);
    d = (await read(await call("GET", "/foods/1/convert?amount=3&unit=oz"))).body.data;
    assert.equal(d.standard.grams, 85.05);
    d = (await read(await call("GET", "/foods/convert?id=1&amount=1&unit=scoop%2016"))).body.data;
    assert.equal(d.standard.grams, 36);
  });
  test("chipande both ways; no density means no spoon equivalents", async () => {
    let d = (await read(await call("GET", "/foods/convert?q=nsima&amount=2&unit=chipande"))).body.data;
    assert.equal(d.input.kind, "food_specific_serving");
    assert.equal(d.standard.grams, 350);
    assert.equal(d.household.volume, null);
    assert.match(d.assumptions[0], /left out/);
    d = (await read(await call("GET", "/foods/convert?q=nsima&amount=350&unit=g"))).body.data;
    assert.equal(d.household.servings[0].quantity, 2);
  });
  test("volume input with no density on file is flagged", async () => {
    const d = (await read(await call("GET", "/foods/convert?q=nsima&amount=200&unit=ml"))).body.data;
    assert.equal(d.standard.grams, 200);
    assert.match(d.assumptions[0], /1 g\/ml/);
    assert.equal(d.household.volume.suggested.unit, "cup");
  });
  test("milk: 500 ml is two cups", async () => {
    const d = (await read(await call("GET", "/foods/convert?q=milk&amount=500&unit=ml"))).body.data;
    assert.equal(d.standard.grams, 500);
    assert.equal(d.household.volume.suggested.quantity, 2);
  });
  test("a name that matches several foods says so and lists the others", async () => {
    const d = (await read(await call("GET", "/foods/convert?q=milk&amount=250&unit=ml"))).body;
    assert.equal(d.data.food.other_matches.length, 1);
    assert.match(d.data.warnings.join(" "), /matched more than one food/);
    const byId = (await read(await call("GET", "/foods/convert?id=3&amount=250&unit=ml"))).body.data;
    assert.deepEqual(byId.warnings, []);
  });
  test("a cooked-rice cup applied to soaked rice carries a warning", async () => {
    const d = (await read(await call("GET", "/foods/convert?q=soaked&amount=1&unit=cup"))).body.data;
    assert.equal(d.food.id, 4);
    assert.match(d.warnings.join(" "), /cooked food/);
    assert.equal(d.household.servings.every((s) => !/^100\s?g$/i.test(s.label)), true);
  });
  test("errors", async () => {
    assert.equal((await call("GET", "/foods/convert?amount=2&unit=cup")).status, 400);
    assert.equal((await call("GET", "/foods/convert?q=rice&amount=-1&unit=cup")).status, 400);
    assert.equal((await call("GET", "/foods/convert?q=rice&amount=1&unit=bucket")).status, 422);
    assert.equal((await call("GET", "/foods/abc/convert?amount=1&unit=g")).status, 400);
    assert.equal((await call("GET", "/foods/convert?q=rice&amount=1&unit=g", null, null)).status, 401);
  });
});

describe("recipes use the same conversion", () => {
  test("2 cups of rice is still 300 g; a tablespoon is now rice's own", async () => {
    const r = await read(await call("POST", "/recipes/calculate", {
      servings: 1,
      ingredients: [{ food_name: "rice", quantity: 2, unit: "cup" }, { food_name: "rice", quantity: 1, unit: "tbsp" }, { food_name: "nsima", quantity: 2, unit: "chipande" }],
    }));
    assert.equal(r.status, 200);
    const ing = r.body.data.ingredients || r.body.data.resolved_ingredients || r.body.data.breakdown;
    assert.ok(ing, JSON.stringify(Object.keys(r.body.data)));
    assert.equal(ing[0].grams, 300);
    assert.equal(ing[1].grams, 9);
    assert.equal(ing[2].grams, 350);
  });
});
