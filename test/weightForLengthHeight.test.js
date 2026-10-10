import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWflhQuery, resolveLookup, classifyWflh, wflhZ } from "../src/weightForLengthHeight.js";

const items = [];
for (let n = 1; n <= 5; n++) {
  const part = JSON.parse(readFileSync(new URL(`../scripts/weight_for_length_height_seed_${n}.json`, import.meta.url))).items;
  assert.ok(part.length <= 500);
  items.push(...part);
}
const get = (sex, measured, cm) => items.find((r) => r.sex === sex && r.measured === measured && r.length_height_cm === cm);
const q = (s) => parseWflhQuery(new URLSearchParams(s));

describe("seed files", () => {
  test("2404 unique rows with the expected ranges", () => {
    assert.equal(items.length, 2404);
    assert.equal(new Set(items.map((r) => `${r.sex}:${r.measured}:${r.length_height_cm}`)).size, 2404);
    for (const sex of ["girls", "boys"]) {
      assert.equal(items.filter((r) => r.sex === sex && r.measured === "lying").length, 651);
      assert.equal(items.filter((r) => r.sex === sex && r.measured === "standing").length, 551);
      for (let i = 0; i <= 650; i += 25) assert.ok(get(sex, "lying", Math.round((45 + i / 10) * 10) / 10));
      assert.ok(get(sex, "lying", 110) && get(sex, "lying", 45));
      assert.ok(get(sex, "standing", 65) && get(sex, "standing", 120));
    }
  });
  test("every cut-off matches its own L, M, S within 0.0011 kg and increases", () => {
    const zs = { sd_neg3: -3, sd_neg2: -2, sd_neg1: -1, median: 0, sd_pos1: 1, sd_pos2: 2, sd_pos3: 3 };
    for (const r of items) {
      for (const [k, z] of Object.entries(zs)) {
        const x = r.lms_m * Math.pow(1 + r.lms_l * r.lms_s * z, 1 / r.lms_l);
        assert.ok(Math.abs(x - r[k]) <= 0.0011, `${r.sex} ${r.measured} ${r.length_height_cm} ${k}`);
      }
      assert.ok(r.sd_neg3 < r.sd_neg2 && r.sd_neg2 < r.sd_neg1 && r.sd_neg1 < r.median && r.median < r.sd_pos1 && r.sd_pos1 < r.sd_pos2 && r.sd_pos2 < r.sd_pos3);
    }
  });
});

describe("parseWflhQuery", () => {
  test("defaults measured by age, accepts kg/g and cm/mm", () => {
    const a = q("sex=girls&age_months=12&weight_kg=9&length_cm=75");
    assert.equal(a.measured, "lying");
    assert.equal(q("sex=girls&age_months=30&weight_g=12000&height_cm=90").weightKg, 12);
    assert.equal(q("sex=girls&age_months=30&weight_kg=12&height_mm=900").lengthHeightCm, 90);
    assert.equal(q("sex=Male&age_months=30&weight_kg=12&height_cm=90").sex, "boys");
    assert.equal(q("sex=girls&age_months=12&weight_kg=9&length_cm=75&measured=standing").measured, "standing");
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=12&weight_kg=9&length_cm=75").error);
    assert.ok(q("sex=girls&weight_kg=9&length_cm=75").error);
    assert.ok(q("sex=girls&age_months=61&weight_kg=9&length_cm=75").error);
    assert.ok(q("sex=girls&age_months=12&length_cm=75").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9000&length_cm=75").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9&length_cm=750").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9&length_cm=75&measured=sitting").error);
  });
});

describe("resolveLookup", () => {
  test("under 24 months uses the lying table, from 24 the standing table", () => {
    assert.equal(resolveLookup(23, "lying", 80).table, "lying");
    assert.equal(resolveLookup(24, "standing", 85).table, "standing");
    assert.equal(resolveLookup(12, "lying", 74.96).lookupCm, 75);
  });
  test("mismatched position converts by 0.7 cm and reports it", () => {
    const a = resolveLookup(30, "lying", 90);        // lying value, standing table
    assert.equal(a.table, "standing");
    assert.equal(a.lookupCm, 89.3);
    assert.equal(a.adjustment.adjustment_cm, -0.7);
    const b = resolveLookup(12, "standing", 73);     // standing value, lying table
    assert.equal(b.table, "lying");
    assert.equal(b.lookupCm, 73.7);
    assert.equal(b.adjustment.adjustment_cm, 0.7);
    assert.equal(resolveLookup(12, "lying", 73).adjustment, null);
  });
  test("ranges", () => {
    assert.deepEqual(resolveLookup(12, "lying", 80).range, { min: 45, max: 110 });
    assert.deepEqual(resolveLookup(40, "standing", 100).range, { min: 65, max: 120 });
  });
});

describe("classifyWflh", () => {
  const r = get("boys", "lying", 75);
  test("bands are strict (normal -2SD..+1SD; risk >+1SD; overweight >+2SD; obesity >+3SD)", () => {
    assert.equal(classifyWflh(r, r.median).status, "normal");
    assert.equal(classifyWflh(r, r.sd_neg2).status, "normal");
    assert.equal(classifyWflh(r, r.sd_neg2 - 0.001).status, "moderate wasting");
    assert.equal(classifyWflh(r, r.sd_neg3).status, "moderate wasting");
    assert.equal(classifyWflh(r, r.sd_neg3 - 0.001).status, "severe wasting");
    assert.equal(classifyWflh(r, r.sd_pos1).status, "normal");
    assert.equal(classifyWflh(r, r.sd_pos1 + 0.001).status, "possible risk of overweight");
    assert.equal(classifyWflh(r, r.sd_pos2 + 0.001).status, "overweight");
    assert.equal(classifyWflh(r, r.sd_pos3 + 0.001).status, "obesity");
  });
  test("z-score and percentile at median and cut-offs; implausible flag", () => {
    const m = classifyWflh(r, r.lms_m);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    assert.equal(classifyWflh(r, r.sd_neg2).z_score, -2);
    assert.equal(classifyWflh(r, r.sd_neg3).z_score, -3);
    assert.equal(classifyWflh(r, r.median).implausible, false);
    assert.equal(classifyWflh(r, 3).implausible, true);
    assert.equal(classifyWflh(r, 20).implausible, true);
  });
  test("beyond +/-3 SD the z-score follows WHO's +/-4 SD columns (girls lying 45.0: SD4neg 1.737, SD4 3.584)", () => {
    const g = get("girls", "lying", 45);
    assert.ok(Math.abs(wflhZ(g, 1.737) - -4) < 0.01);
    assert.ok(Math.abs(wflhZ(g, 3.584) - 4) < 0.01);
  });
  test("known WHO values: girls 45.0 cm median 2.4607 kg; boys standing 65.0 cm median 7.4327 kg", () => {
    assert.equal(get("girls", "lying", 45).lms_m, 2.4607);
    assert.equal(get("boys", "standing", 65).lms_m, 7.4327);
  });
  test("labels the reference used", () => {
    assert.equal(classifyWflh(r, r.median).reference, "weight-for-length (lying down)");
    assert.equal(classifyWflh(get("girls", "standing", 90), 12).reference, "weight-for-height (standing)");
  });
});
