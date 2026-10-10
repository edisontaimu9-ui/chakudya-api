import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWeightVelocityQuery, classifyWeightVelocity, lmsZ, normalCdf } from "../src/weightVelocity.js";

const { items } = JSON.parse(readFileSync(new URL("../scripts/who_weight_velocity_seed.json", import.meta.url)));
const get = (sex, s) => items.find((r) => r.sex === sex && r.interval_start_months === s);
const q = (s) => parseWeightVelocityQuery(new URLSearchParams(s));

describe("parseWeightVelocityQuery", () => {
  test("converts kg to grams without float noise", () => {
    const r = q("sex=girls&start_age_months=3&weight_start_kg=5.8&weight_end_kg=8.2");
    assert.equal(r.incrementG, 2400);
    assert.equal(q("sex=boys&start_age_months=0&weight_start_kg=3.3&weight_end_kg=7.88").incrementG, 4580);
  });
  test("accepts increment_g directly and sex aliases", () => {
    assert.equal(q("sex=Male&start_age_months=0&increment_g=4580").sex, "boys");
    assert.equal(q("sex=f&start_age_months=18&increment_g=1191").incrementG, 1191);
  });
  test("accepts end_age_months only when exactly start + 6", () => {
    assert.ok(!q("sex=girls&start_age_months=3&end_age_months=9&increment_g=2400").error);
    assert.ok(q("sex=girls&start_age_months=3&end_age_months=10&increment_g=2400").error);
  });
  test("rejects bad input, including kg/g mix-ups", () => {
    assert.ok(q("start_age_months=3&increment_g=2400").error);                      // no sex
    assert.ok(q("sex=girls&increment_g=2400").error);                               // no start
    assert.ok(q("sex=girls&start_age_months=19&increment_g=2400").error);
    assert.ok(q("sex=girls&start_age_months=2.5&increment_g=2400").error);
    assert.ok(q("sex=girls&start_age_months=3").error);                             // no increment or weights
    assert.ok(q("sex=girls&start_age_months=3&weight_start_kg=5").error);           // only one weight
    assert.ok(q("sex=girls&start_age_months=3&increment_g=24000").error);           // grams typo
  });
});

describe("classifyWeightVelocity", () => {
  const boys0 = get("boys", 0);
  test("bands use strict cut-offs (boys 0-6 mo: 2524 / 3151 / ... / 7158)", () => {
    assert.equal(classifyWeightVelocity(boys0, 4580).status, "within expected range");
    assert.equal(classifyWeightVelocity(boys0, 3151).status, "within expected range"); // exactly -2SD
    assert.equal(classifyWeightVelocity(boys0, 3150).status, "low increment");
    assert.equal(classifyWeightVelocity(boys0, 2524).status, "low increment");          // exactly -3SD
    assert.equal(classifyWeightVelocity(boys0, 2523).status, "very low increment");
    assert.equal(classifyWeightVelocity(boys0, 6241).status, "within expected range"); // exactly +2SD
    assert.equal(classifyWeightVelocity(boys0, 6242).status, "high increment");
    assert.equal(classifyWeightVelocity(boys0, 7159).status, "very high increment");
  });
  test("z_score and percentile come out right at the median and at -2 SD", () => {
    const m = classifyWeightVelocity(boys0, 4580);
    assert.equal(m.z_score, 0);
    assert.equal(m.percentile, 50);
    const lo = classifyWeightVelocity(boys0, 3151);
    assert.equal(lo.z_score, -2);
    assert.equal(lo.percentile, 2.3);
  });
  test("girls 0-6 mo: printed 3rd percentile (2924 g) is ~ the 3rd percentile", () => {
    const r = classifyWeightVelocity(get("girls", 0), 2924);
    assert.equal(r.percentile, 3);
  });
  test("negative increments use the Delta shift; z is null only when shifted value is not positive", () => {
    const b = get("boys", 14); // -3SD is -11 g, Delta 350
    assert.equal(classifyWeightVelocity(b, -11).status, "low increment");
    assert.equal(classifyWeightVelocity(b, -12).status, "very low increment");
    assert.ok(Number.isFinite(classifyWeightVelocity(b, -100).z_score));
    assert.equal(lmsZ(b, -350), null);
    assert.equal(classifyWeightVelocity(b, -400).z_score, null);
  });
  test("normalCdf sanity", () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
  });
});

describe("seed file", () => {
  test("38 rows: 19 per sex, intervals 0-6 to 18-24, monotonic cut-offs, Delta 450 girls / 350 boys", () => {
    assert.equal(items.length, 38);
    for (const sex of ["girls", "boys"]) {
      const rows = items.filter((r) => r.sex === sex);
      assert.equal(rows.length, 19);
      assert.deepEqual(rows.map((r) => r.interval_start_months), [...Array(19).keys()]);
      for (const r of rows) {
        assert.equal(r.interval_end_months, r.interval_start_months + 6);
        assert.equal(r.delta_g, sex === "girls" ? 450 : 350);
        const v = [r.sd_neg3, r.sd_neg2, r.sd_neg1, r.median, r.sd_pos1, r.sd_pos2, r.sd_pos3];
        assert.deepEqual(v, [...v].sort((a, b) => a - b));
        assert.ok(r.source);
      }
    }
  });
  test("every stored cut-off agrees with its own L, M, S, Delta within 1.5 g (printed values are rounded)", () => {
    const Z = [-3, -2, -1, 0, 1, 2, 3];
    const keys = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"];
    for (const r of items) {
      keys.forEach((k, i) => {
        const x = r.lms_m * Math.pow(1 + r.lms_l * r.lms_s * Z[i], 1 / r.lms_l) - r.delta_g;
        assert.ok(Math.abs(x - r[k]) <= 1.5, `${r.sex} ${r.interval_start_months} ${k}: ${x} vs ${r[k]}`);
      });
    }
  });
  test("spot-checks against the printed tables", () => {
    assert.equal(get("boys", 0).median, 4580);
    assert.equal(get("boys", 0).sd_pos3, 7158);
    assert.equal(get("boys", 13).sd_neg3, 0);
    assert.equal(get("boys", 18).sd_neg3, -31);
    assert.equal(get("boys", 18).sd_pos3, 2687);
    assert.equal(get("girls", 0).median, 4079);
    assert.equal(get("girls", 18).median, 1191);
    assert.equal(get("girls", 6).median, 1618);
    assert.equal(get("girls", 10).sd_neg3, -2);   // printed z-table (a derived value would round to -3)
    assert.equal(get("girls", 14).sd_neg3, -26);  // printed z-table (a derived value would round to -27)
  });
});
