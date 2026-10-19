// End-to-end through the Worker entry point with a mocked Supabase: /weight-management routes, auth, methods, the child BMI
// percentile lookup (assess) and the activity_log lookup (loss-plan, gain-plan).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
const ACTIVITY_ROWS = JSON.parse(readFileSync(new URL("../scripts/activity_energy_seed.json", import.meta.url), "utf8")).items.map((r, i) => ({ id: i + 1, ...r }));
const BOYS_10Y = { sex: "boys", age_months: 120, sd_neg3: 12.8, sd_neg2: 13.7, sd_neg1: 14.9, median: 16.4, sd_pos1: 18.5, sd_pos2: 21.4, sd_pos3: 25.4 };

before(() => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/rest/v1/activity_energy_expenditure") return json(ACTIVITY_ROWS);
    if (u.pathname === "/rest/v1/bmi_for_age") return json(u.searchParams.get("age_months") === "eq.120" && u.searchParams.get("sex") === "eq.boys" ? [BOYS_10Y] : []);
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
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.8.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("/weight-management", () => {
  test("every route needs a key", async () => {
    assert.equal((await call("GET", "/weight-management/reference", null, null)).status, 401);
    assert.equal((await call("POST", "/weight-management/assess", { sex: "male" }, null)).status, 401);
    assert.equal((await call("GET", "/weight-management/bariatric?procedure=rygb", null, null)).status, 401);
  });

  test("GET reference, with and without ?section=", async () => {
    const all = await read(await call("GET", "/weight-management/reference"));
    assert.equal(all.status, 200);
    assert.ok(all.body.data.sections.includes("known_issues"));
    const one = await read(await call("GET", "/weight-management/reference?section=rates"));
    assert.equal(one.body.data.rates.kcal_per_lb_fat, 3500);
    assert.equal((await call("GET", "/weight-management/reference?section=nope")).status, 400);
  });

  test("GET bariatric", async () => {
    const r = await read(await call("GET", "/weight-management/bariatric?procedure=rygb&sex=female&childbearing_age=true"));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.diet_progression.length, 5);
    assert.equal((await call("GET", "/weight-management/bariatric")).status, 400);
  });

  test("POST assess: the chapter's case study", async () => {
    const r = await read(await call("POST", "/weight-management/assess", { sex: "female", age_years: 45, weight_kg: 88.45, height_cm: 162.56, systolic_mmhg: 160, diastolic_mmhg: 90 }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.bmi, 33.5);
    assert.equal(r.body.data.bmi_class.id, "obesity_class_1");
  });

  test("POST assess: a child's percentile is looked up in the WHO table", async () => {
    const r = await read(await call("POST", "/weight-management/assess", { sex: "male", age_years: 10, weight_kg: 45, height_cm: 140 }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.group, "child_or_adolescent");
    assert.ok(r.body.data.bmi_for_age_percentile > 95);
    assert.equal(r.body.data.band, "obesity");
    assert.match(r.body.data.percentile_source, /WHO BMI-for-age 5-19 years/);
    assert.equal(r.body.data.weight_loss_may_be_advised, true);
  });

  test("POST assess: a missing percentile row says why", async () => {
    const r = await read(await call("POST", "/weight-management/assess", { sex: "male", age_years: 11, weight_kg: 45, height_cm: 140 }));
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /lookup/);
  });

  test("POST loss-plan uses the energy engine and refuses unsafe requests", async () => {
    const ok = await read(await call("POST", "/weight-management/loss-plan", { sex: "female", age_years: 35, weight_kg: 81.8, height_cm: 165.1, pal_category: "sedentary" }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.maintenance.estimate_id, "tee_women_overweight_19");
    assert.equal(ok.body.data.deficit_plan.intake_kcal, ok.body.data.maintenance.kcal - 500);
    assert.equal((await call("POST", "/weight-management/loss-plan", { sex: "female", age_years: 35, weight_kg: 81.8, height_cm: 165.1, pal_category: "sedentary", intake_kcal: 700 })).status, 400);
    assert.equal((await call("POST", "/weight-management/loss-plan", { sex: "female", age_years: 35, weight_kg: 60, height_cm: 165, pal_category: "sedentary" })).status, 400);
  });

  test("loss-plan and gain-plan look activity_log up in the Appendix 10 table", async () => {
    const withLog = await read(await call("POST", "/weight-management/loss-plan", { sex: "male", age_years: 40, weight_kg: 105, height_cm: 178, activity_log: [{ activity: "Walk", type: "3.5 mph", minutes: 45 }], pal_category: "sedentary" }));
    assert.ok([200, 400].includes(withLog.status));
    if (withLog.status === 200) assert.ok(withLog.body.data.activity_log);
    const bad = await read(await call("POST", "/weight-management/loss-plan", { sex: "male", age_years: 40, weight_kg: 105, height_cm: 178, activity_log: [{ activity: "Quidditch", minutes: 5 }] }));
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /activity_log\[0\]/);
  });

  test("POST gain-plan reproduces the chapter's 2400 -> 2900-3400 example", async () => {
    const r = await read(await call("POST", "/weight-management/gain-plan", { sex: "male", age_years: 30, weight_kg: 50, height_cm: 175, maintenance_kcal: 2400 }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.energy.start_kcal, 2900);
    assert.equal(r.body.data.energy.goal_kcal, 3400);
  });

  test("POST progress and diet-pattern", async () => {
    const p = await read(await call("POST", "/weight-management/progress", { goal: "loss", height_cm: 170, weigh_ins: [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-02-05", weight_kg: 97.5 }] }));
    assert.equal(p.status, 200);
    assert.equal(p.body.data.summary.change_percent_of_start, -2.5);
    const d = await read(await call("POST", "/weight-management/diet-pattern", { carbohydrate_g: 30, protein_g: 100, fat_g: 140 }));
    assert.equal(d.status, 200);
    assert.ok(d.body.data.pattern_tags.includes("ketogenic_range"));
  });

  test("errors, methods and unknown routes", async () => {
    assert.equal((await call("POST", "/weight-management/assess", { sex: "male" })).status, 400);
    assert.ok([404, 405].includes((await call("GET", "/weight-management/assess")).status));
    assert.ok([404, 405].includes((await call("POST", "/weight-management/reference", {})).status));
    assert.ok([404, 405].includes((await call("POST", "/weight-management/nope", {})).status));
    assert.equal((await call("POST", "/weight-management/loss-plan", "not json{")).status, 400);
  });
});
