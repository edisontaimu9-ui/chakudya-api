import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBmiUnder5Query, resolveBmi, classifyBmiUnder5, bmiZ } from "../src/bmiForAgeUnder5.js";

const items = JSON.parse(readFileSync(new URL("../scripts/bmi_for_age_under5_seed.json", import.meta.url))).items;
const get = (sex, m, measured) => items.find((r) => r.sex === sex && r.age_months === m && r.measured === measured);
const q = (s) => parseBmiUnder5Query(new URLSearchParams(s));

describe("seed file", () => {
  test("124 unique rows: months 0-60, month 24 has lying and standing", () => {
    assert.equal(items.length, 124);
    assert.equal(new Set(items.map((r) => `${r.sex}:${r.age_months}:${r.measured}`)).size, 124);
    for (const sex of ["girls", "boys"]) {
      for (let m = 0; m <= 60; m++) {
        const rows = items.filter((r) => r.sex === sex && r.age_months === m);
        assert.equal(rows.length, m === 24 ? 2 : 1, `${sex} ${m}`);
      }
      assert.equal(get(sex, 23, "lying").measured, "lying");
      assert.equal(get(sex, 25, "standing").measured, "standing");
    }
  });
  test("cut-offs match their own L, M, S within 0.001 and increase", () => {
    const zs = { sd_neg3: -3, sd_neg2: -2, sd_neg1: -1, median: 0, sd_pos1: 1, sd_pos2: 2, sd_pos3: 3 };
    for (const r of items) {
      for (const [k, z] of Object.entries(zs)) {
        const x = r.lms_m * Math.pow(1 + r.lms_l * r.lms_s * z, 1 / r.lms_l);
        assert.ok(Math.abs(x - r[k]) <= 0.0011, `${r.sex} ${r.age_months} ${r.measured} ${k}`);
      }
      assert.ok(r.sd_neg3 < r.sd_neg2 && r.sd_neg2 < r.sd_neg1 && r.sd_neg1 < r.median && r.median < r.sd_pos1 && r.sd_pos1 < r.sd_pos2 && r.sd_pos2 < r.sd_pos3);
    }
  });
});

describe("parseBmiUnder5Query", () => {
  test("accepts bmi directly, or weight + length/height (kg/g, cm/mm)", () => {
    assert.equal(q("sex=girls&age_months=12&bmi=16").bmi, 16);
    const a = q("sex=girls&age_months=12&weight_kg=9.2&length_cm=78");
    assert.equal(a.weightKg, 9.2);
    assert.equal(a.measured, "lying");
    assert.equal(q("sex=Male&age_months=30&weight_g=12000&height_mm=900").lengthHeightCm, 90);
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=12&bmi=16").error);
    assert.ok(q("sex=girls&bmi=16").error);
    assert.ok(q("sex=girls&age_months=61&bmi=16").error);
    assert.ok(q("sex=girls&age_months=12").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9").error);          // no length
    assert.ok(q("sex=girls&age_months=12&length_cm=78").error);         // no weight
    assert.ok(q("sex=girls&age_months=12&bmi=160").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9000&length_cm=78").error);
    assert.ok(q("sex=girls&age_months=12&weight_kg=9&length_cm=78&measured=sitting").error);
  });
});

describe("resolveBmi", () => {
  test("computes BMI = kg / m^2, table by age", () => {
    const r = resolveBmi(q("sex=girls&age_months=12&weight_kg=9.2&length_cm=78"));
    assert.equal(r.table, "lying");
    assert.ok(Math.abs(r.bmi - 9.2 / (0.78 * 0.78)) < 1e-9);
    assert.equal(r.adjustment, null);
    assert.equal(r.computed, true);
  });
  test("direct BMI is used as is", () => {
    const r = resolveBmi(q("sex=girls&age_months=30&bmi=15.5"));
    assert.equal(r.bmi, 15.5);
    assert.equal(r.table, "standing");
    assert.equal(r.computed, false);
  });
  test("mismatched position: 0.7 cm applied BEFORE computing BMI", () => {
    const a = resolveBmi(q("sex=girls&age_months=30&weight_kg=12&length_cm=90&measured=lying")); // lying, standing table
    assert.equal(a.usedLengthHeightCm, 89.3);
    assert.ok(Math.abs(a.bmi - 12 / (0.893 * 0.893)) < 1e-9);
    assert.equal(a.adjustment.adjustment_cm, -0.7);
    const b = resolveBmi(q("sex=girls&age_months=12&weight_kg=9&height_cm=73&measured=standing")); // standing, lying table
    assert.equal(b.usedLengthHeightCm, 73.7);
    assert.equal(b.adjustment.adjustment_cm, 0.7);
  });
});

describe("classifyBmiUnder5", () => {
  const r = get("girls", 12, "lying");
  test("bands are strict", () => {
    assert.equal(classifyBmiUnder5(r, r.median).status, "normal");
    assert.equal(classifyBmiUnder5(r, r.sd_neg2).status, "normal");
    assert.equal(classifyBmiUnder5(r, r.sd_neg2 - 0.001).status, "moderate wasting");
    assert.equal(classifyBmiUnder5(r, r.sd_neg3).status, "moderate wasting");
    assert.equal(classifyBmiUnder5(r, r.sd_neg3 - 0.001).status, "severe wasting");
    assert.equal(classifyBmiUnder5(r, r.sd_pos1).status, "normal");
    assert.equal(classifyBmiUnder5(r, r.sd_pos1 + 0.001).status, "possible risk of overweight");
    assert.equal(classifyBmiUnder5(r, r.sd_pos2 + 0.001).status, "overweight");
    assert.equal(classifyBmiUnder5(r, r.sd_pos3 + 0.001).status, "obesity");
  });
  test("z-score, percentile, implausible flag, reference label", () => {
    const m = classifyBmiUnder5(r, r.lms_m);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    assert.equal(classifyBmiUnder5(r, r.sd_neg2).z_score, -2);
    assert.equal(classifyBmiUnder5(r, 7).implausible, true);
    assert.equal(classifyBmiUnder5(r, r.median).implausible, false);
    assert.equal(m.reference, "BMI-for-age (length, lying down)");
    assert.equal(classifyBmiUnder5(get("boys", 40, "standing"), 15).reference, "BMI-for-age (height, standing)");
  });
  test("extension beyond +/-3 SD is monotonic and continuous at the cut-off", () => {
    assert.ok(Math.abs(bmiZ(r, r.sd_pos3) - 3) < 1e-6);
    assert.ok(bmiZ(r, r.sd_pos3 + 1) > 3);
    assert.ok(bmiZ(r, r.sd_neg3 - 1) < -3);
  });
  test("known WHO values: boys birth BMI median 13.4069; girls 60 months median 15.2747", () => {
    assert.equal(get("boys", 0, "lying").lms_m, 13.4069);
    assert.equal(get("girls", 60, "standing").lms_m, 15.2747);
  });
});
