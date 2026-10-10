import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHcForAgeQuery, classifyHcForAge, hcZ } from "../src/hcForAge.js";

const items = JSON.parse(readFileSync(new URL("../scripts/hc_for_age_seed.json", import.meta.url))).items;
const get = (sex, m) => items.find((r) => r.sex === sex && r.age_months === m);
const q = (s) => parseHcForAgeQuery(new URLSearchParams(s));

describe("seed file", () => {
  test("122 unique rows covering months 0-60 for both sexes", () => {
    assert.equal(items.length, 122);
    assert.equal(new Set(items.map((r) => `${r.sex}:${r.age_months}`)).size, 122);
    for (const sex of ["girls", "boys"]) for (let m = 0; m <= 60; m++) assert.ok(get(sex, m), `missing ${sex} ${m}`);
  });
  test("cut-offs match their own L, M, S within 0.0011 cm and increase", () => {
    const zs = { sd_neg3: -3, sd_neg2: -2, sd_neg1: -1, median: 0, sd_pos1: 1, sd_pos2: 2, sd_pos3: 3 };
    for (const r of items) {
      assert.equal(r.lms_l, 1);
      for (const [k, z] of Object.entries(zs)) {
        assert.ok(Math.abs(r.lms_m * (1 + r.lms_s * z) - r[k]) <= 0.0011, `${r.sex} ${r.age_months} ${k}`);
      }
      assert.ok(r.sd_neg3 < r.sd_neg2 && r.sd_neg2 < r.sd_neg1 && r.sd_neg1 < r.median && r.median < r.sd_pos1 && r.sd_pos1 < r.sd_pos2 && r.sd_pos2 < r.sd_pos3);
    }
  });
});

describe("parseHcForAgeQuery", () => {
  test("accepts cm and mm, sex aliases", () => {
    assert.equal(q("sex=girls&age_months=6&hc_cm=42").hcCm, 42);
    assert.equal(q("sex=Male&age_months=6&hc_mm=420").hcCm, 42);
    assert.equal(q("sex=Male&age_months=6&hc_mm=420").sex, "boys");
    assert.ok(!q("sex=girls&age_months=0&hc_cm=34").error);
    assert.ok(!q("sex=girls&age_months=60&hc_cm=50").error);
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=6&hc_cm=42").error);
    assert.ok(q("sex=girls&hc_cm=42").error);
    assert.ok(q("sex=girls&age_months=61&hc_cm=42").error);
    assert.ok(q("sex=girls&age_months=-1&hc_cm=34").error);
    assert.ok(q("sex=girls&age_months=6.5&hc_cm=42").error);
    assert.ok(q("sex=girls&age_months=6").error);
    assert.ok(q("sex=girls&age_months=6&hc_cm=420").error);   // mm typed as cm
  });
});

describe("classifyHcForAge", () => {
  const r = get("girls", 6);
  test("bands are strict", () => {
    assert.equal(classifyHcForAge(r, r.median).status, "normal");
    assert.equal(classifyHcForAge(r, r.sd_neg2).status, "normal");
    assert.equal(classifyHcForAge(r, r.sd_neg2 - 0.001).status, "microcephaly");
    assert.equal(classifyHcForAge(r, r.sd_neg3).status, "microcephaly");
    assert.equal(classifyHcForAge(r, r.sd_neg3 - 0.001).status, "severe microcephaly");
    assert.equal(classifyHcForAge(r, r.sd_pos2).status, "normal");
    assert.equal(classifyHcForAge(r, r.sd_pos2 + 0.001).status, "macrocephaly");
    assert.equal(classifyHcForAge(r, r.sd_pos3 + 0.001).status, "severe macrocephaly");
  });
  test("z-score, percentile, implausible flag", () => {
    const m = classifyHcForAge(r, r.lms_m);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    assert.equal(m.implausible, false);
    assert.equal(classifyHcForAge(r, r.sd_neg2).z_score, -2);
    assert.equal(classifyHcForAge(r, r.sd_neg2).percentile, 2.3);
    assert.equal(classifyHcForAge(r, 30).implausible, true);
    assert.ok(hcZ(r, r.sd_pos3 + 1) > 3);   // no extension: plain linear z
  });
  test("known WHO values: girls birth median 33.8787 cm, boys 60 months median 50.7375 cm", () => {
    assert.equal(get("girls", 0).lms_m, 33.8787);
    assert.equal(get("boys", 60).lms_m, 50.7375);
  });
});
