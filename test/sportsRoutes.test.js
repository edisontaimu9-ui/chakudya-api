// End-to-end through the Worker entry point with a mocked Supabase: /sports routes, auth, method checks and the
// activity_log lookup shared with /energy.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
const ACTIVITY_ROWS = JSON.parse(readFileSync(new URL("../scripts/activity_energy_seed.json", import.meta.url), "utf8")).items.map((r, i) => ({ id: i + 1, ...r }));
let activityRows = ACTIVITY_ROWS;

before(() => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/rest/v1/activity_energy_expenditure") return json(activityRows);
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
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.7.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });

describe("/sports", () => {
  test("every route needs a key", async () => {
    assert.equal((await call("GET", "/sports/reference", null, null)).status, 401);
    assert.equal((await call("POST", "/sports/energy", { weight_kg: 80 }, null)).status, 401);
  });

  test("GET /sports/reference", async () => {
    const { status, body } = await read(await call("GET", "/sports/reference"));
    assert.equal(status, 200);
    assert.equal(body.data.energy.activity_levels.length, 5);
    assert.ok(body.data.known_issues.length >= 6);
  });

  test("POST /sports/energy reproduces Box 23.2", async () => {
    const { status, body } = await read(await call("POST", "/sports/energy", { weight_kg: 79.5, lean_body_mass_kg: 71.6, activity_level: "extra_active" }));
    assert.equal(status, 200);
    assert.ok(Math.abs(body.data.total_kcal - 4336) <= 1);
  });

  test("POST /sports/energy looks activity_log up in the Appendix 10 table", async () => {
    const { status, body } = await read(await call("POST", "/sports/energy", { weight_kg: 65, body_fat_percent: 14, activity_level: "sedentary", activity_log: [{ activity: "Run", type: "6 mph, 10 min/mile", minutes: 30 }] }));
    assert.equal(status, 200);
    assert.ok(body.data.activity.exercise_from_activity_log_kcal > 200);
    assert.ok(body.data.total_kcal > body.data.ree_kcal * 1.2);
  });

  test("activity_log problems keep their status", async () => {
    let r = await read(await call("POST", "/sports/energy", { weight_kg: 65, body_fat_percent: 14, activity_level: "sedentary", activity_log: [{ activity: "Quidditch", minutes: 5 }] }));
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /activity_log\[0\]/);
    activityRows = [];
    r = await read(await call("POST", "/sports/energy", { weight_kg: 65, body_fat_percent: 14, activity_level: "sedentary", activity_log: [{ activity: "Run", minutes: 5 }] }));
    assert.equal(r.status, 503);
    activityRows = ACTIVITY_ROWS;
  });

  test("the other calculators answer through the Worker", async () => {
    assert.equal((await read(await call("POST", "/sports/macros", { weight_kg: 79, profile: "endurance" }))).body.data.macronutrients.carbohydrate.grams.max, 790);
    assert.equal((await read(await call("POST", "/sports/fuel-timing", { weight_kg: 70, hours_before_event: 4 }))).body.data.before.carbohydrate_g, 280);
    assert.equal((await read(await call("POST", "/sports/hydration", { weight_before_kg: 70, weight_after_kg: 68.6 }))).body.data.body_mass.loss_percent, 2);
    assert.equal((await read(await call("POST", "/sports/body-composition", { sex: "male", weight_kg: 79.5, body_fat_percent: 10 }))).body.data.weights_kg.lowest_safe, 75.3);
    assert.equal((await read(await call("POST", "/sports/supplement-dose", { weight_kg: 60, age_years: 15 }))).body.data.doses_given, false);
  });

  test("POST /sports/plan", async () => {
    const { status, body } = await read(await call("POST", "/sports/plan", { sex: "male", weight_kg: 79.5, body_fat_percent: 10, activity_level: "very_active", profile: "endurance", event: { duration_min: 90 } }));
    assert.equal(status, 200);
    assert.ok(body.data.sections.energy && body.data.sections.macros && body.data.sections.fuel_timing);
  });

  test("errors, methods and unknown routes", async () => {
    assert.equal((await call("POST", "/sports/energy", { weight_kg: 80 })).status, 400);
    assert.ok([404, 405].includes((await call("GET", "/sports/energy")).status));
    assert.ok([404, 405].includes((await call("POST", "/sports/reference", {})).status));
    assert.equal((await call("POST", "/sports/nope", {})).status, 404);
    assert.equal((await call("POST", "/sports/macros", "not json{")).status, 400);
  });
});
