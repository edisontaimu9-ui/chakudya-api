import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWeightForAgeQuery, classifyWeightForAge, wfaZ } from "../src/weightForAge.js";

const items = JSON.parse(readFileSync(new URL("../scripts/weight_for_age_seed.json", import.meta.url))).items;
const get = (sex, m) => items.find((r) => r.sex === sex && r.age_months === m);
const q = (s) => parseWeightForAgeQuery(new URLSearchParams(s));

describe("seed file", () => {
  test("covers months 0-120 for both sexes, 242 unique rows", () => {
    assert.equal(items.length, 242);
    for (const sex of ["girls", "boys"]) for (let m = 0; m <= 120; m++) assert.ok(get(sex, m), `missing ${sex} ${m}`);
    assert.equal(new Set(items.map((r) => `${r.sex}:${r.age_months}`)).size, 242);
    assert.ok(items.length <= 500);
  });
  test("every cut-off matches its own L, M, S within 0.0011 kg and increases", () => {
    const zs = { sd_neg3: -3, sd_neg2: -2, sd_neg1: -1, median: 0, sd_pos1: 1, sd_pos2: 2, sd_pos3: 3 };
    for (const r of items) {
      for (const [k, z] of Object.entries(zs)) {
        const x = r.lms_l === 0 ? r.lms_m * Math.exp(r.lms_s * z) : r.lms_m * Math.pow(1 + r.lms_l * r.lms_s * z, 1 / r.lms_l);
        assert.ok(Math.abs(x - r[k]) <= 0.0011, `${r.sex} ${r.age_months} ${k}: ${x} vs ${r[k]}`);
      }
      assert.ok(r.sd_neg3 < r.sd_neg2 && r.sd_neg2 < r.sd_neg1 && r.sd_neg1 < r.median && r.median < r.sd_pos1 && r.sd_pos1 < r.sd_pos2 && r.sd_pos2 < r.sd_pos3);
    }
  });
});

describe("parseWeightForAgeQuery", () => {
  test("accepts kg and grams, sex aliases", () => {
    assert.equal(q("sex=girls&age_months=12&weight_kg=8.5").weightKg, 8.5);
    assert.equal(q("sex=Male&age_months=12&weight_g=8500").weightKg, 8.5);
    assert.equal(q("sex=Male&age_months=12&weight_g=8500").sex, "boys");
    assert.ok(!q("sex=girls&age_months=0&weight_kg=3.2").error);
    assert.ok(!q("sex=girls&age_months=120&weight_kg=31").error);
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=12&weight_kg=8").error);
    assert.ok(q("sex=girls&weight_kg=8").error);
    assert.ok(q("sex=girls&age_months=121&weight_kg=30").error);
    assert.ok(q("sex=girls&age_months=-1&weight_kg=3").error);
    assert.ok(q("sex=girls&age_months=12.5&weight_kg=8").error);
    assert.ok(q("sex=girls&age_months=12").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=8500").error); // grams typed as kg
  });
});

describe("classifyWeightForAge", () => {
  const r = get("girls", 12);
  test("bands are strict", () => {
    assert.equal(classifyWeightForAge(r, r.median).status, "normal");
    assert.equal(classifyWeightForAge(r, r.sd_neg2).status, "normal");
    assert.equal(classifyWeightForAge(r, r.sd_neg2 - 0.001).status, "underweight");
    assert.equal(classifyWeightForAge(r, r.sd_neg3).status, "underweight");
    assert.equal(classifyWeightForAge(r, r.sd_neg3 - 0.001).status, "severely underweight");
    assert.equal(classifyWeightForAge(r, r.sd_pos2).status, "normal");
    assert.equal(classifyWeightForAge(r, r.sd_pos2 + 0.001).status, "high weight-for-age");
    assert.equal(classifyWeightForAge(r, r.sd_pos3 + 0.001).status, "very high weight-for-age");
  });
  test("z-score, percentile at the median and at -2SD / -3SD", () => {
    const m = classifyWeightForAge(r, r.lms_m);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    assert.equal(classifyWeightForAge(r, r.sd_neg2).z_score, -2);
    assert.equal(classifyWeightForAge(r, r.sd_neg2).percentile, 2.3);
    assert.equal(classifyWeightForAge(r, r.sd_neg3).z_score, -3);
  });
  test("beyond +/-3 SD extends linearly like WHO's +/-4 SD columns (2007 table month 61 girls: SD4neg 10.742, SD4 34.118)", () => {
    const g = get("girls", 61);
    assert.ok(Math.abs(wfaZ(g, 10.742) - -4) < 0.01);
    assert.ok(Math.abs(wfaZ(g, 34.118) - 4) < 0.01);
  });
  test("implausible flag: z < -6 or > +5", () => {
    const g = get("girls", 61);
    assert.equal(classifyWeightForAge(g, 18).implausible, false);
    assert.equal(classifyWeightForAge(g, 6.5).implausible, true);   // z about -6.8 with extension
    assert.equal(classifyWeightForAge(g, 50).implausible, true);    // z > +5
  });
  test("known WHO values: girls birth median 3.232 kg, boys 60 months median ~18.34 kg", () => {
    assert.ok(Math.abs(get("girls", 0).median - 3.232) < 0.001);
    assert.ok(Math.abs(get("boys", 60).lms_m - 18.3366) < 0.0001);
  });
  test("a 6-month-old girl: 5.5 kg is underweight, 5.0 kg severely underweight (-3SD 5.085, -2SD 5.729)", () => {
    const g = get("girls", 6);
    assert.equal(classifyWeightForAge(g, 5.5).status, "underweight");
    assert.equal(classifyWeightForAge(g, 5.0).status, "severely underweight");
  });
});
