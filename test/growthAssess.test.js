import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAssessQuery, assessGrowth, severityOf } from "../src/growthAssess.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../scripts/${f}`, import.meta.url))).items;
const tables = {
  who_length_height_for_age: [...load("length_height_for_age_seed.json"), ...load("height_for_age_5_19_seed.json")],
  who_weight_for_age: load("weight_for_age_seed.json"),
  who_weight_for_length_height: [1, 2, 3, 4, 5].flatMap((n) => load(`weight_for_length_height_seed_${n}.json`)),
  who_bmi_for_age_under_5: load("bmi_for_age_under5_seed.json"),
  bmi_for_age: load("bmi_for_age_seed.json"),
  who_hc_for_age: load("hc_for_age_seed.json"),
  who_muac_for_age: [...load("muac_for_age_seed.json"), ...load("muac_for_age_seed_36_60.json")],
};
// In-memory stand-in for db.select: applies PostgREST-style eq.* filters.
const fetchRows = async (table, filters, limit) => {
  const rows = (tables[table] || []).filter((r) => Object.entries(filters).every(([k, v]) => {
    const want = String(v).replace(/^eq\./, "");
    return typeof r[k] === "number" ? Number(want) === r[k] : String(r[k]) === want;
  }));
  return rows.slice(0, limit);
};
const assess = async (qs) => {
  const q = parseAssessQuery(new URLSearchParams(qs));
  assert.ok(!q.error, q.error);
  return assessGrowth(q, fetchRows);
};

describe("parseAssessQuery", () => {
  test("requires sex, age, and at least one measurement", () => {
    assert.ok(parseAssessQuery(new URLSearchParams("age_months=12&weight_kg=9")).error);
    assert.ok(parseAssessQuery(new URLSearchParams("sex=girls&weight_kg=9")).error);
    assert.ok(parseAssessQuery(new URLSearchParams("sex=girls&age_months=12")).error);
    assert.ok(parseAssessQuery(new URLSearchParams("sex=girls&age_months=229&weight_kg=9")).error);
    assert.ok(parseAssessQuery(new URLSearchParams("sex=girls&age_months=12&weight_kg=9&muac_scheme=x")).error);
    assert.ok(!parseAssessQuery(new URLSearchParams("sex=F&age_months=12&weight_kg=9")).error);
  });
});

describe("assessGrowth", () => {
  test("18-month girl with every measurement: all seven indicators, matching the single endpoints", async () => {
    const r = await assess("sex=girls&age_months=18&weight_kg=9.2&length_cm=78&hc_cm=45&muac_cm=13.5");
    assert.deepEqual(Object.keys(r.indicators), ["length_height_for_age", "weight_for_age", "weight_for_length_height", "bmi_for_age", "hc_for_age", "muac_for_age", "muac_fixed"]);
    assert.equal(r.not_assessed.length, 0);
    for (const [k, v] of Object.entries(r.indicators)) assert.ok(!v.error, `${k}: ${v.error}`);
    // values seen on the live single endpoints
    assert.equal(r.indicators.weight_for_length_height.status, "normal");
    assert.equal(r.indicators.weight_for_length_height.z_score, -0.6);
    assert.equal(r.indicators.bmi_for_age.bmi, 15.12);
    assert.equal(r.indicators.bmi_for_age.z_score, -0.46);
    assert.equal(r.indicators.length_height_for_age.status, "normal");
    assert.equal(r.indicators.muac_fixed.status, "normal"); // default chart at 18 months: normal is above 13 cm, and 13.5 > 13
  });
  test("only a weight: weight-for-age runs, the rest are listed with reasons", async () => {
    const r = await assess("sex=girls&age_months=6&weight_kg=5.5");
    assert.deepEqual(Object.keys(r.indicators), ["weight_for_age"]);
    assert.equal(r.indicators.weight_for_age.status, "underweight");
    assert.equal(r.indicators.weight_for_age.z_score, -2.34);
    assert.ok(r.not_assessed.find((n) => n.indicator === "length_height_for_age" && /length/.test(n.reason)));
    assert.deepEqual(r.attention.map((a) => a.indicator), ["weight_for_age"]);
    assert.equal(r.attention[0].severity, "concern");
    assert.equal(r.acute_malnutrition_signals, null);
  });
  test("10-year-old boy: height-for-age, weight-for-age (<=120 months) and 5-19 BMI; no under-5 indicators", async () => {
    const r = await assess("sex=boys&age_months=120&height_cm=120&weight_kg=20");
    assert.equal(r.indicators.length_height_for_age.status, "stunted");
    assert.equal(r.indicators.length_height_for_age.z_score, -2.79);
    assert.ok(r.indicators.weight_for_age.status);
    assert.ok(r.indicators.bmi_for_age.reference.includes("5-19"));
    assert.ok(r.not_assessed.find((n) => n.indicator === "weight_for_length_height"));
    assert.ok(!r.indicators.hc_for_age);
  });
  test("15-year-old: weight-for-age is skipped (WHO stops at 10 years), BMI-for-age 5-19 runs", async () => {
    const r = await assess("sex=girls&age_months=180&height_cm=155&weight_kg=48");
    assert.ok(r.not_assessed.find((n) => n.indicator === "weight_for_age"));
    assert.ok(r.indicators.bmi_for_age.status);
    assert.ok(r.indicators.length_height_for_age.status);
  });
  test("severe malnutrition picture raises severe attention and acute signals", async () => {
    const r = await assess("sex=girls&age_months=12&weight_kg=6&length_cm=74&muac_cm=11");
    assert.equal(r.indicators.weight_for_length_height.status, "severe wasting");
    assert.equal(r.acute_malnutrition_signals.level, "severe");
    assert.ok(r.acute_malnutrition_signals.reasons.length >= 2);
    assert.equal(r.acute_malnutrition_signals.oedema_assessed, false);
    assert.equal(r.attention[0].severity, "severe");
  });
  test("moderate MUAC only gives moderate signal", async () => {
    const r = await assess("sex=girls&age_months=18&muac_cm=12");
    assert.equal(r.acute_malnutrition_signals.level, "moderate");
  });
  test("healthy child: no attention items, acute level none", async () => {
    const r = await assess("sex=girls&age_months=18&weight_kg=9.7&length_cm=80&hc_cm=46&muac_cm=14.5");
    assert.deepEqual(r.attention, []);
    assert.equal(r.acute_malnutrition_signals.level, "none");
  });
  test("a bad value only errors its own indicator (MUAC typed in mm as cm)", async () => {
    const r = await assess("sex=girls&age_months=18&weight_kg=9.2&length_cm=78&muac_cm=135");
    assert.ok(r.indicators.muac_for_age.error);
    assert.ok(r.indicators.muac_fixed.error);
    assert.ok(!r.indicators.weight_for_age.error);
  });
  test("position adjustment is passed through (30 months measured lying)", async () => {
    const r = await assess("sex=girls&age_months=30&weight_kg=12&length_cm=90&measured=lying");
    assert.equal(r.indicators.length_height_for_age.position_adjustment.adjustment_cm, -0.7);
    assert.equal(r.indicators.weight_for_length_height.position_adjustment.adjustment_cm, -0.7);
    assert.equal(r.indicators.bmi_for_age.position_adjustment.adjustment_cm, -0.7);
  });
  test("fixed MUAC defaults to cmam for 6-59 months so it agrees with the acute signals", async () => {
    const r = await assess("sex=girls&age_months=12&muac_cm=11");
    assert.equal(r.indicators.muac_fixed.scheme, "cmam");
    assert.equal(r.indicators.muac_fixed.status, "severe");
    assert.equal(r.acute_malnutrition_signals.level, "severe");
    const old = await assess("sex=girls&age_months=100&muac_cm=15");
    assert.equal(old.indicators.muac_fixed.scheme, "who_hiv_2008");
    const chart = await assess("sex=girls&age_months=12&muac_cm=11&muac_scheme=who_hiv_2008");
    assert.equal(chart.indicators.muac_fixed.status, "moderate");
  });

  test("muac_scheme=cmam is used for the fixed MUAC result; out-of-range age is skipped", async () => {
    const r = await assess("sex=girls&age_months=18&muac_cm=11.2&muac_scheme=cmam");
    assert.equal(r.indicators.muac_fixed.status, "severe");
    assert.equal(r.indicators.muac_fixed.scheme, "cmam");
    const old = await assess("sex=girls&age_months=100&muac_cm=15&muac_scheme=cmam");
    assert.ok(old.not_assessed.find((n) => n.indicator === "muac_fixed"));
    assert.ok(old.not_assessed.find((n) => n.indicator === "muac_for_age"));
  });
  test("an unseeded table reports an error for that indicator only", async () => {
    const saved = tables.who_hc_for_age.splice(0);
    try {
      const r = await assess("sex=girls&age_months=6&hc_cm=42&weight_kg=7.3");
      assert.match(r.indicators.hc_for_age.error, /not found/);
      assert.ok(r.indicators.weight_for_age.status);
    } finally { tables.who_hc_for_age.push(...saved); }
  });
});

describe("severityOf", () => {
  test("maps statuses", () => {
    assert.equal(severityOf("normal"), "ok");
    assert.equal(severityOf("within expected range"), "ok");
    assert.equal(severityOf("possible risk of overweight"), "watch");
    assert.equal(severityOf("stunted"), "concern");
    assert.equal(severityOf("moderate wasting"), "concern");
    assert.equal(severityOf("severe wasting"), "severe");
    assert.equal(severityOf("severely stunted"), "severe");
    assert.equal(severityOf("obesity"), "concern");
    assert.equal(severityOf("tall"), "watch");
    assert.equal(severityOf("very tall"), "watch");        // tallness is rarely a problem
    assert.equal(severityOf("very high weight-for-age"), "watch");
    assert.equal(severityOf("very high"), "watch");
    assert.equal(severityOf("very low"), "severe");        // MUAC-for-age below -3SD
    assert.equal(severityOf("low"), "concern");
  });
});
