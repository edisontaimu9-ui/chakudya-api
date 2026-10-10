import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLhfaQuery, pickRowAndValue, classifyLhfa, defaultMeasured } from "../src/lengthHeightForAge.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../scripts/${f}`, import.meta.url))).items;
const items0to5 = load("length_height_for_age_seed.json");
const items5to19 = load("height_for_age_5_19_seed.json");
const items = [...items0to5, ...items5to19];
const rowsFor = (sex, m) => items.filter((r) => r.sex === sex && r.age_months === m);
const q = (s) => parseLhfaQuery(new URLSearchParams(s));

describe("seed file", () => {
  test("covers months 0-60 both sexes; month 24 has lying and standing rows", () => {
    for (const sex of ["girls", "boys"]) {
      for (let m = 0; m <= 228; m++) {
        const r = rowsFor(sex, m);
        assert.ok(r.length >= 1, `missing ${sex} ${m}`);
        assert.equal(r.length, m === 24 ? 2 : 1);
        assert.equal(r[0].measured, m < 24 ? "lying" : m > 24 ? "standing" : r[0].measured);
      }
    }
    assert.equal(items0to5.length, 124);
    assert.equal(items5to19.length, 336);
    assert.ok(items5to19.every((r) => r.age_months >= 61 && r.age_months <= 228 && r.measured === "standing"));
    assert.equal(new Set(items.map((r) => `${r.sex}:${r.age_months}:${r.measured}`)).size, 460);
  });
  test("cut-offs match their own L, M, S within 0.001 cm and increase", () => {
    const zs = { sd_neg3: -3, sd_neg2: -2, sd_neg1: -1, median: 0, sd_pos1: 1, sd_pos2: 2, sd_pos3: 3 };
    for (const r of items) {
      for (const [k, z] of Object.entries(zs)) {
        const x = r.lms_m * (1 + r.lms_l * r.lms_s * z);
        if (r.lms_l === 1) assert.ok(Math.abs(x - r[k]) <= 0.0011, `${r.sex} ${r.age_months} ${k}`);
      }
      assert.ok(r.sd_neg3 < r.sd_neg2 && r.sd_neg2 < r.sd_neg1 && r.sd_neg1 < r.median && r.median < r.sd_pos1 && r.sd_pos1 < r.sd_pos2 && r.sd_pos2 < r.sd_pos3);
    }
  });
});

describe("parseLhfaQuery", () => {
  test("defaults measured by age; accepts length/height and mm", () => {
    assert.equal(q("sex=girls&age_months=12&length_cm=74").measured, "lying");
    assert.equal(q("sex=girls&age_months=30&height_cm=90").measured, "standing");
    assert.equal(q("sex=girls&age_months=24&height_cm=86").measured, "standing");
    assert.equal(q("sex=Male&age_months=12&length_mm=740").valueCm, 74);
    assert.equal(q("sex=girls&age_months=12&length_cm=74&measured=standing").measured, "standing");
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=12&length_cm=74").error);
    assert.ok(q("sex=girls&length_cm=74").error);
    assert.ok(q("sex=girls&age_months=229&length_cm=74").error);
    assert.ok(!q("sex=girls&age_months=120&height_cm=135").error);
    assert.equal(q("sex=girls&age_months=120&height_cm=135").measured, "standing");
    assert.ok(q("sex=girls&age_months=-1&length_cm=74").error);
    assert.ok(q("sex=girls&age_months=12").error);
    assert.ok(q("sex=girls&age_months=12&length_cm=740").error);
    assert.ok(q("sex=girls&age_months=12&length_cm=74&measured=sitting").error);
  });
  test("defaultMeasured boundary", () => {
    assert.equal(defaultMeasured(23), "lying");
    assert.equal(defaultMeasured(24), "standing");
  });
});

describe("classification", () => {
  const b12 = rowsFor("boys", 12); // boys 12 mo lying
  const row = b12[0];
  const pick = (rows, measured, v) => pickRowAndValue(rows, measured, v);
  test("bands are strict", () => {
    const { median, sd_neg2, sd_neg3, sd_pos2, sd_pos3 } = row;
    assert.equal(classifyLhfa(row, median).status, "normal");
    assert.equal(classifyLhfa(row, sd_neg2).status, "normal");
    assert.equal(classifyLhfa(row, sd_neg2 - 0.001).status, "stunted");
    assert.equal(classifyLhfa(row, sd_neg3).status, "stunted");
    assert.equal(classifyLhfa(row, sd_neg3 - 0.001).status, "severely stunted");
    assert.equal(classifyLhfa(row, sd_pos2).status, "normal");
    assert.equal(classifyLhfa(row, sd_pos2 + 0.001).status, "tall");
    assert.equal(classifyLhfa(row, sd_pos3 + 0.001).status, "very tall");
  });
  test("z-score, percentile, and implausible flag", () => {
    const m = classifyLhfa(row, row.lms_m);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    assert.equal(m.implausible, false);
    assert.equal(classifyLhfa(row, row.sd_neg2).z_score, -2);
    assert.equal(classifyLhfa(row, row.lms_m * (1 - 0.0 + 7 * row.lms_s)).implausible, true);
  });
  test("exact position uses the matching row, no adjustment", () => {
    const p = pick(rowsFor("boys", 12), "lying", 76);
    assert.equal(p.adjustment, null);
    assert.equal(p.valueCm, 76);
    const m24 = rowsFor("boys", 24);
    assert.equal(pick(m24, "lying", 87.8161).row.measured, "lying");
    assert.equal(pick(m24, "standing", 87.1161).row.measured, "standing");
  });
  test("lying measurement on a 30-month-old: subtract 0.7 cm and use the standing table", () => {
    const p = pick(rowsFor("girls", 30), "lying", 90);
    assert.equal(p.row.measured, "standing");
    assert.equal(p.valueCm, 89.3);
    assert.equal(p.adjustment.adjustment_cm, -0.7);
  });
  test("standing measurement on a 12-month-old: add 0.7 cm and use the lying table", () => {
    const p = pick(rowsFor("girls", 12), "standing", 73);
    assert.equal(p.row.measured, "lying");
    assert.equal(p.valueCm, 73.7);
    assert.equal(p.adjustment.adjustment_cm, 0.7);
  });
  test("WHO 2007 rows: girls 19y median is ~163.15 cm; a 10-year-old boy at 120 cm is stunted", () => {
    assert.ok(Math.abs(rowsFor("girls", 228)[0].median - 163.155) < 0.001);
    const b = rowsFor("boys", 120)[0];
    assert.ok(Math.abs(b.median - b.lms_m) < 0.001);
    const r = classifyLhfa(b, 120);
    assert.ok(r.status === "stunted" || r.status === "severely stunted");
  });
  test("known WHO value: boys birth median is 49.9 cm, -2SD 46.1, -3SD 44.2 (printed)", () => {
    const r = rowsFor("boys", 0)[0];
    assert.ok(Math.abs(r.median - 49.884) < 0.001);
    assert.ok(Math.abs(r.sd_neg2 - 46.1) < 0.05 && Math.abs(r.sd_neg3 - 44.2) < 0.05);
  });
});
