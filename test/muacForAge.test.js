import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMuacForAgeQuery, classifyMuacForAge, muacZ } from "../src/muacForAge.js";

const { items } = JSON.parse(readFileSync(new URL("../scripts/muac_for_age_seed.json", import.meta.url)));
const get = (sex, m) => items.find((r) => r.sex === sex && r.age_months === m);
const q = (s) => parseMuacForAgeQuery(new URLSearchParams(s));

describe("seed file", () => {
  test("rows are unique per sex and month, within 3-60, both sexes present", () => {
    const keys = items.map((r) => `${r.sex}:${r.age_months}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(items.every((r) => r.age_months >= 3 && r.age_months <= 60));
    assert.ok(items.some((r) => r.sex === "girls") && items.some((r) => r.sex === "boys"));
    assert.ok(items.length <= 500);
  });
  test("every stored cut-off matches its own L, M, S within 0.001 cm", () => {
    const zs = { sd_neg3: -3, sd_neg2: -2, sd_neg1: -1, median: 0, sd_pos1: 1, sd_pos2: 2, sd_pos3: 3 };
    for (const r of items) {
      for (const [k, z] of Object.entries(zs)) {
        const x = r.lms_m * Math.pow(1 + r.lms_l * r.lms_s * z, 1 / r.lms_l);
        assert.ok(Math.abs(x - r[k]) <= 0.0011, `${r.sex} ${r.age_months} ${k}: ${x} vs ${r[k]}`);
      }
      assert.ok(r.sd_neg3 < r.sd_neg2 && r.sd_neg2 < r.sd_neg1 && r.sd_neg1 < r.median && r.median < r.sd_pos1 && r.sd_pos1 < r.sd_pos2 && r.sd_pos2 < r.sd_pos3);
    }
  });
  test("age_days follows round(months x 30.4375)", () => {
    for (const r of items) assert.equal(r.age_days, Math.round(r.age_months * 30.4375));
  });
});

describe("parseMuacForAgeQuery", () => {
  test("accepts cm, converts mm, accepts sex aliases", () => {
    assert.equal(q("sex=girls&age_months=12&muac_cm=13.5").muacCm, 13.5);
    assert.equal(q("sex=Male&age_months=12&muac_mm=135").muacCm, 13.5);
    assert.equal(q("sex=Male&age_months=12&muac_mm=135").sex, "boys");
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=12&muac_cm=13").error);                    // no sex
    assert.ok(q("sex=girls&muac_cm=13").error);                        // no age
    assert.ok(q("sex=girls&age_months=2&muac_cm=13").error);           // too young
    assert.ok(q("sex=girls&age_months=61&muac_cm=13").error);          // too old
    assert.ok(q("sex=girls&age_months=12.5&muac_cm=13").error);        // not whole
    assert.ok(q("sex=girls&age_months=12").error);                     // no muac
    assert.ok(q("sex=girls&age_months=12&muac_cm=135").error);         // mm passed as cm
  });
});

describe("classifyMuacForAge", () => {
  const g12 = get("girls", 12); // -3SD 11.139, -2SD 12.066, +2SD 16.805, +3SD 18.312
  test("bands use strict cut-offs", () => {
    assert.equal(classifyMuacForAge(g12, 14.206).status, "within expected range");
    assert.equal(classifyMuacForAge(g12, 12.066).status, "within expected range"); // exactly -2SD
    assert.equal(classifyMuacForAge(g12, 12.065).status, "low");
    assert.equal(classifyMuacForAge(g12, 11.139).status, "low");                   // exactly -3SD
    assert.equal(classifyMuacForAge(g12, 11.138).status, "very low");
    assert.equal(classifyMuacForAge(g12, 16.805).status, "within expected range"); // exactly +2SD
    assert.equal(classifyMuacForAge(g12, 16.806).status, "high");
    assert.equal(classifyMuacForAge(g12, 18.313).status, "very high");
  });
  test("z-score and percentile at the median and at cut-offs", () => {
    const m = classifyMuacForAge(g12, 14.2062);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    assert.equal(classifyMuacForAge(g12, 12.066).z_score, -2);
    assert.equal(classifyMuacForAge(g12, 12.066).percentile, 2.3);
    assert.equal(classifyMuacForAge(g12, 11.139).z_score, -3);
  });
  test("beyond +/-3 SD the z-score extends linearly like WHO's +/-4 SD columns", () => {
    const r = get("boys", 3); // WHO table day 91: SD4neg 9.763, SD4 17.833
    assert.ok(Math.abs(muacZ(r, 9.763) - -4) < 0.01);
    assert.ok(Math.abs(muacZ(r, 17.833) - 4) < 0.01);
  });
  test("a 3-month-old boy at 11.0 cm is below -2SD and flagged low", () => {
    const r = classifyMuacForAge(get("boys", 3), 11.0);
    assert.equal(r.status, "low"); // boys 3 mo: -3SD 10.658, -2SD 11.554
    assert.ok(r.z_score < -2 && r.z_score > -3);
  });
});
