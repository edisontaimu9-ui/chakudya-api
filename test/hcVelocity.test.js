import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHcVelocityQuery, classifyHcVelocity, approxZ } from "../src/hcVelocity.js";

// girls 3-9 months, from the WHO simplified field table
const girls3 = { sd_neg3: 2.8, sd_neg2: 3.3, sd_neg1: 3.8, median: 4.3, sd_pos1: 4.9, sd_pos2: 5.6, sd_pos3: 6.3 };
const q = (s) => parseHcVelocityQuery(new URLSearchParams(s));

describe("parseHcVelocityQuery", () => {
  test("computes increment from two measurements without float noise", () => {
    const r = q("sex=girls&start_age_months=3&hc_start_cm=41.2&hc_end_cm=45.3");
    assert.equal(r.sex, "girls");
    assert.equal(r.startMonths, 3);
    assert.equal(r.increment, 4.1);
  });
  test("accepts increment_cm directly and sex aliases", () => {
    assert.equal(q("sex=Male&start_age_months=0&increment_cm=8.9").sex, "boys");
    assert.equal(q("sex=f&start_age_months=18&increment_cm=0.8").increment, 0.8);
  });
  test("accepts end_age_months only when exactly start + 6", () => {
    assert.ok(!q("sex=girls&start_age_months=3&end_age_months=9&increment_cm=4").error);
    assert.ok(q("sex=girls&start_age_months=3&end_age_months=10&increment_cm=4").error);
  });
  test("rejects bad input", () => {
    assert.ok(q("start_age_months=3&increment_cm=4").error);                       // no sex
    assert.ok(q("sex=girls&increment_cm=4").error);                                // no start
    assert.ok(q("sex=girls&start_age_months=19&increment_cm=4").error);            // beyond 18-24
    assert.ok(q("sex=girls&start_age_months=-1&increment_cm=4").error);
    assert.ok(q("sex=girls&start_age_months=2.5&increment_cm=4").error);
    assert.ok(q("sex=girls&start_age_months=3").error);                            // no increment or HCs
    assert.ok(q("sex=girls&start_age_months=3&hc_start_cm=41").error);             // only one HC
    assert.ok(q("sex=girls&start_age_months=3&increment_cm=40").error);            // implausible
  });
});

describe("classifyHcVelocity", () => {
  test("bands use strict cut-offs", () => {
    assert.equal(classifyHcVelocity(girls3, 4.3).status, "within expected range");
    assert.equal(classifyHcVelocity(girls3, 3.3).status, "within expected range"); // exactly -2SD is not below it
    assert.equal(classifyHcVelocity(girls3, 3.2).status, "low increment");
    assert.equal(classifyHcVelocity(girls3, 2.8).status, "low increment");          // exactly -3SD is not below it
    assert.equal(classifyHcVelocity(girls3, 2.7).status, "very low increment");
    assert.equal(classifyHcVelocity(girls3, 5.6).status, "within expected range"); // exactly +2SD
    assert.equal(classifyHcVelocity(girls3, 5.7).status, "high increment");
    assert.equal(classifyHcVelocity(girls3, 6.3).status, "high increment");         // exactly +3SD
    assert.equal(classifyHcVelocity(girls3, 6.4).status, "very high increment");
  });
  test("z_approx interpolates between printed SDs and is null beyond +-3", () => {
    const c = classifyHcVelocity(girls3, 4.3);
    assert.equal(c.z_approx, 0);
    assert.equal(classifyHcVelocity(girls3, 3.8).z_approx, -1);
    assert.equal(classifyHcVelocity(girls3, 4.6).z_approx, 0.5);
    assert.equal(classifyHcVelocity(girls3, 2.7).z_approx, null);
    assert.equal(classifyHcVelocity(girls3, 6.4).z_approx, null);
  });
  test("tied low-tail cut-offs (girls 17-23 mo: 0.0 / 0.3) do not divide by zero", () => {
    const row = { sd_neg3: 0.0, sd_neg2: 0.3, sd_neg1: 0.6, median: 0.9, sd_pos1: 1.2, sd_pos2: 1.5, sd_pos3: 1.9 };
    assert.equal(classifyHcVelocity(row, 0.3).status, "within expected range");
    assert.equal(classifyHcVelocity(row, 0.2).status, "low increment");
    assert.ok(Number.isFinite(classifyHcVelocity(row, 0.0).z_approx));
  });
});

describe("seed file", () => {
  const { items } = JSON.parse(readFileSync(new URL("../scripts/who_hc_velocity_seed.json", import.meta.url)));
  test("38 rows: 19 per sex, intervals 0-6 to 18-24, unique, monotonic cut-offs", () => {
    assert.equal(items.length, 38);
    for (const sex of ["girls", "boys"]) {
      const rows = items.filter((r) => r.sex === sex);
      assert.equal(rows.length, 19);
      assert.deepEqual(rows.map((r) => r.interval_start_months), [...Array(19).keys()]);
      for (const r of rows) {
        assert.equal(r.interval_end_months, r.interval_start_months + 6);
        const v = [r.sd_neg3, r.sd_neg2, r.sd_neg1, r.median, r.sd_pos1, r.sd_pos2, r.sd_pos3];
        assert.deepEqual(v, [...v].sort((a, b) => a - b));
        assert.ok(r.source);
      }
    }
  });
  test("spot-checks against the printed WHO tables", () => {
    const get = (sex, s) => items.find((r) => r.sex === sex && r.interval_start_months === s);
    assert.equal(get("girls", 0).median, 8.3);
    assert.equal(get("boys", 0).sd_pos3, 12.1);
    assert.equal(get("girls", 3).sd_neg2, 3.3);
    assert.equal(get("boys", 9).sd_neg1, 1.4);
    assert.equal(get("girls", 18).sd_pos3, 1.7);
    assert.equal(get("boys", 18).sd_neg3, 0.0);
  });
});
