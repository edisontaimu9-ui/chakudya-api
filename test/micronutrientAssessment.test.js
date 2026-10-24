import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { computeMicronutrientAssessment, micronutrientRequirements } from "../src/micronutrientAssessment.js";

const intake = { iron_mg: 9, calcium_mg: 600, vitc_mg: 40, zinc_mg: 6, folate_mcg: 250, vita_rae_mcg: 400, thiamin_mg: 1.0, riboflavin_mg: 0.8, vitb12_mcg: 1.5, magnesium_mg: 200, sodium_mg: 2600 };

describe("computeMicronutrientAssessment", () => {
  test("classifies against EAR/RDA and ranks gaps", () => {
    const { data: d } = computeMicronutrientAssessment({ age: 25, sex: "female", intake });
    assert.equal(d.life_stage, "female_19_30");
    assert.equal(d.summary.gap_counts.likely_inadequate, 8);
    assert.equal(d.summary.gap_counts.borderline, 2);
    const iron = d.nutrients.find((n) => n.nutrient === "iron_mg");
    assert.equal(iron.gap_level, "borderline");
    assert.equal(iron.target, 18);
    assert.equal(iron.ear, 8.1);
    assert.equal(d.nutrients.find((n) => n.nutrient === "sodium_mg").status, "above_cdrr");
    assert.equal(d.excesses.length, 1);
    assert.ok(d.potential_inadequacies[0].gap_level === "likely_inadequate");
    assert.ok(d.nutrients.every((n) => !["protein_g", "carbs_g", "fiber_g"].includes(n.nutrient)));
  });
  test("nutrients not sent are listed, not treated as zero", () => {
    const { data: d } = computeMicronutrientAssessment({ age: 25, sex: "female", intake: { iron_mg: 18 } });
    assert.equal(d.summary.gap_counts.likely_inadequate, 0);
    assert.ok(d.not_provided.some((n) => n.nutrient === "zinc_mg"));
    assert.deepEqual(d.adequate, ["iron_mg"]);
  });
  test("several days are averaged; plant-based notes on request", () => {
    const { data: d } = computeMicronutrientAssessment({ age: 25, sex: "female", plant_based_diet: true, days: [{ intake: { iron_mg: 10 } }, { intake: { iron_mg: 20 } }] });
    assert.equal(d.nutrients[0].average_intake, 15);
    assert.equal(d.days_assessed, 2);
    assert.ok(d.plant_based_diet_notes.length >= 5);
  });
  test("pregnancy raises the iron target", () => {
    const { data: d } = computeMicronutrientAssessment({ age: 28, sex: "female", life_stage_type: "pregnancy", intake: { iron_mg: 20 } });
    assert.equal(d.nutrients[0].target, 27);
  });
  test("validation", () => {
    assert.equal(computeMicronutrientAssessment({ age: 25, sex: "female", ingredients: [{}] }).ok, false);
    assert.equal(computeMicronutrientAssessment({ age: 25, sex: "female", intake: { kcal: 1800 } }).ok, false);
    assert.equal(computeMicronutrientAssessment({ sex: "female", intake }).ok, false);
    assert.equal(computeMicronutrientAssessment({ age: 25, intake }).ok, false);
  });
});

describe("micronutrientRequirements", () => {
  test("by age and sex, with group filter", () => {
    const r = micronutrientRequirements({ age: 25, sex: "female", group: "mineral" }).data;
    assert.ok(r.requirements.every((x) => x.group === "mineral"));
    assert.equal(r.requirements.find((x) => x.nutrient === "iron_mg").rda, 18);
    const m = micronutrientRequirements({ age: 25, sex: "male" }).data.requirements.find((x) => x.nutrient === "iron_mg");
    assert.equal(m.rda, 8);
    assert.equal(micronutrientRequirements({ age: 25, sex: "female", group: "x" }).ok, false);
  });
});

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
before(() => { globalThis.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" } }); });
after(() => { globalThis.fetch = realFetch; });
const kv = new Map();
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret", RATE_LIMIT_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
let ip = 10;
const call = (method, path, body, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.7.${Math.floor(ip / 250)}.${ip++ % 250}` }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} });
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("/micronutrients routes", () => {
  test("auth, methods, paths", async () => {
    assert.equal((await call("POST", "/micronutrients/assess", { age: 25, sex: "female", intake }, null)).status, 401);
    assert.equal((await call("GET", "/micronutrients/assess")).status, 405);
    assert.equal((await call("POST", "/micronutrients/requirements", {})).status, 405);
    assert.equal((await call("POST", "/micronutrients/nope", {})).status, 404);
  });
  test("assess, requirements, reference", async () => {
    const a = await read(await call("POST", "/micronutrients/assess", { age: 25, sex: "female", intake }));
    assert.equal(a.status, 200);
    assert.equal(a.body.data.summary.gap_counts.likely_inadequate, 8);
    const r = await read(await call("GET", "/micronutrients/requirements?age=25&sex=female&group=vitamin"));
    assert.equal(r.status, 200);
    assert.ok(r.body.data.requirements.length > 5);
    assert.equal((await call("GET", "/micronutrients/requirements?sex=female")).status, 400);
    const ref = await read(await call("GET", "/micronutrients/reference"));
    assert.ok(ref.body.data.nutrients.length > 15);
    assert.equal((await call("POST", "/micronutrients/assess", { age: 25, sex: "female", meals: [] })).status, 400);
  });
});
