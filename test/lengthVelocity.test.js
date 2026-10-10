import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLengthVelocityQuery, classifyLengthVelocity } from "../src/lengthVelocity.js";

// girls 3-9 months, from the WHO simplified field table
const girls3 = { sd_neg3: 6.7, sd_neg2: 7.8, sd_neg1: 9.1, median: 10.3, sd_pos1: 11.7, sd_pos2: 13.1, sd_pos3: 14.5 };
const q = (s) => parseLengthVelocityQuery(new URLSearchParams(s));

describe("parseLengthVelocityQuery", () => {
  test("computes increment from two lengths without float noise", () => {
    const r = q("sex=girls&start_age_months=3&length_start_cm=55.1&length_end_cm=70.6");
    assert.equal(r.sex, "girls");
    assert.equal(r.startMonths, 3);
    assert.equal(r.increment, 15.5);
  });
  test("accepts increment_cm directly and sex aliases", () => {
    assert.equal(q("sex=Male&start_age_months=0&increment_cm=17.7").sex, "boys");
    assert.equal(q("sex=f&start_age_months=18&increment_cm=5.6").increment, 5.6);
  });
  test("accepts end_age_months only when exactly start + 6", () => {
    assert.ok(!q("sex=girls&start_age_months=3&end_age_months=9&increment_cm=10").error);
    assert.ok(q("sex=girls&start_age_months=3&end_age_months=10&increment_cm=10").error);
  });
  test("rejects bad input", () => {
    assert.ok(q("start_age_months=3&increment_cm=10").error);                      // no sex
    assert.ok(q("sex=girls&increment_cm=10").error);                               // no start
    assert.ok(q("sex=girls&start_age_months=19&increment_cm=10").error);           // beyond 18-24
    assert.ok(q("sex=girls&start_age_months=-1&increment_cm=10").error);
    assert.ok(q("sex=girls&start_age_months=2.5&increment_cm=10").error);
    assert.ok(q("sex=girls&start_age_months=3").error);                            // no increment or lengths
    assert.ok(q("sex=girls&start_age_months=3&length_start_cm=60").error);         // only one length
    assert.ok(q("sex=girls&start_age_months=3&increment_cm=60").error);            // implausible
  });
});

describe("classifyLengthVelocity", () => {
  test("bands use strict cut-offs", () => {
    assert.equal(classifyLengthVelocity(girls3, 10.3).status, "within expected range");
    assert.equal(classifyLengthVelocity(girls3, 7.8).status, "within expected range"); // exactly -2SD
    assert.equal(classifyLengthVelocity(girls3, 7.7).status, "low increment");
    assert.equal(classifyLengthVelocity(girls3, 6.7).status, "low increment");          // exactly -3SD
    assert.equal(classifyLengthVelocity(girls3, 6.6).status, "very low increment");
    assert.equal(classifyLengthVelocity(girls3, 13.1).status, "within expected range"); // exactly +2SD
    assert.equal(classifyLengthVelocity(girls3, 13.2).status, "high increment");
    assert.equal(classifyLengthVelocity(girls3, 14.5).status, "high increment");        // exactly +3SD
    assert.equal(classifyLengthVelocity(girls3, 14.6).status, "very high increment");
  });
  test("z_approx interpolates and is null beyond +-3", () => {
    assert.equal(classifyLengthVelocity(girls3, 10.3).z_approx, 0);
    assert.equal(classifyLengthVelocity(girls3, 9.1).z_approx, -1);
    assert.equal(classifyLengthVelocity(girls3, 6.6).z_approx, null);
    assert.equal(classifyLengthVelocity(girls3, 14.6).z_approx, null);
  });
});

describe("seed file", () => {
  const { items } = JSON.parse(readFileSync(new URL("../scripts/who_length_velocity_seed.json", import.meta.url)));
  test("38 rows: 19 per sex, intervals 0-6 to 18-24, monotonic cut-offs", () => {
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
    assert.equal(get("girls", 0).median, 16.5);
    assert.equal(get("boys", 0).sd_pos3, 22.7);
    assert.equal(get("girls", 3).sd_neg2, 7.8);
    assert.equal(get("boys", 9).sd_neg2, 5);
    assert.equal(get("girls", 12).sd_pos1, 7.8);
    assert.equal(get("girls", 18).sd_neg3, 2.8);
    assert.equal(get("boys", 18).sd_pos3, 8.4);
  });
});
