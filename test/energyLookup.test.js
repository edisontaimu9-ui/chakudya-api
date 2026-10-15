import { test } from "node:test";
import assert from "node:assert/strict";
import { percentileFromSdCutoffs, percentileFromLms } from "../src/bmiPercentile.js";
import { enrichBmiPercentile } from "../src/energyLookup.js";
import { computeEnergyRequirements } from "../src/energyEngine.js";

const sdRow = { sd_neg3: 12, sd_neg2: 13, sd_neg1: 14, median: 16, sd_pos1: 18, sd_pos2: 21, sd_pos3: 25 };
const lmsRow = { lms_l: -2, lms_m: 16, lms_s: 0.1, sd_neg3: 10, sd_neg2: 11.5, sd_neg1: 13.5, median: 16, sd_pos1: 19, sd_pos2: 22, sd_pos3: 26 };

test("percentile from SD cut-offs interpolates and extends past +/-3 SD", () => {
  assert.equal(percentileFromSdCutoffs(sdRow, 16).percentile, 50);
  assert.equal(percentileFromSdCutoffs(sdRow, 18).z, 1);
  assert.equal(percentileFromSdCutoffs(sdRow, 18).percentile, 84.1);
  assert.equal(percentileFromSdCutoffs(sdRow, 19.5).z, 1.5);
  const at85 = percentileFromSdCutoffs(sdRow, 18 + 0.036 * 3).percentile;
  assert.ok(at85 >= 84.9 && at85 <= 85.1, String(at85));
  assert.ok(percentileFromSdCutoffs(sdRow, 28).z > 3);
  assert.ok(percentileFromSdCutoffs(sdRow, 10).z < -3);
  assert.equal(percentileFromSdCutoffs({ ...sdRow, sd_pos1: "x" }, 18), null);
  assert.equal(percentileFromSdCutoffs({ ...sdRow, sd_pos1: 12 }, 18), null);
});

test("percentile from LMS is exact at the median", () => {
  const p = percentileFromLms(lmsRow, 16);
  assert.equal(p.z, 0);
  assert.equal(p.percentile, 50);
  assert.ok(percentileFromLms(lmsRow, 21).percentile > 90);
});

function fakeDb({ under5 = lmsRow, older = sdRow, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async select(table, opts) {
      calls.push([table, opts.filters]);
      if (fail) throw new Error("boom");
      const row = table === "who_bmi_for_age_under_5" ? under5 : table === "bmi_for_age" ? older : null;
      return { ok: true, body: row ? [row] : [] };
    },
  };
}

test("lookup fills the percentile for a 10 y boy from bmi_for_age", async () => {
  const db = fakeDb();
  const out = await enrichBmiPercentile({ sex: "male", age_years: 10, weight_kg: 45, height_cm: 140 }, db);
  assert.ok(out.bmi_for_age_percentile > 85);
  assert.match(out.bmi_percentile_source, /5-19 years, boys, 120 months/);
  assert.deepEqual(db.calls[0], ["bmi_for_age", { sex: "eq.boys", age_months: "eq.120" }]);
});

test("lookup uses the under-5 table (standing) for 3 and 4 year olds", async () => {
  const db = fakeDb();
  const out = await enrichBmiPercentile({ sex: "female", age_months: 48, weight_kg: 16, height_cm: 100 }, db);
  assert.equal(out.bmi_for_age_percentile, 50);
  assert.deepEqual(db.calls[0], ["who_bmi_for_age_under_5", { sex: "eq.girls", age_months: "eq.48", measured: "eq.standing" }]);
});

test("lookup leaves the body alone when not needed or not possible", async () => {
  const db = fakeDb();
  const given = { sex: "male", age_years: 10, weight_kg: 45, height_cm: 140, bmi_for_age_percentile: 60 };
  assert.equal(await enrichBmiPercentile(given, db), given);
  const adult = { sex: "male", age_years: 30, weight_kg: 70, height_cm: 175 };
  assert.equal(await enrichBmiPercentile(adult, db), adult);
  const infant = { sex: "male", age_months: 8, weight_kg: 8, height_cm: 70 };
  assert.equal(await enrichBmiPercentile(infant, db), infant);
  const noHeight = { sex: "male", age_years: 10, weight_kg: 30 };
  assert.equal(await enrichBmiPercentile(noHeight, db), noHeight);
  assert.equal(db.calls.length, 0);
  assert.equal(await enrichBmiPercentile(null, db), null);
});

test("lookup failure or missing row sets a reason and never throws", async () => {
  const noRow = await enrichBmiPercentile({ sex: "male", age_years: 10, weight_kg: 45, height_cm: 140 }, fakeDb({ older: null }));
  assert.match(noRow.bmi_percentile_lookup_error, /sql\/012/);
  const boom = await enrichBmiPercentile({ sex: "male", age_years: 10, weight_kg: 45, height_cm: 140 }, fakeDb({ fail: true }));
  assert.match(boom.bmi_percentile_lookup_error, /failed/);
});

test("engine picks the overweight child equation from a looked-up percentile and reports where it came from", async () => {
  const body = await enrichBmiPercentile({ sex: "male", age_years: 10, weight_kg: 45, height_cm: 140, pal_category: "low_active" }, fakeDb());
  const r = computeEnergyRequirements(body);
  assert.ok(r.data.estimates.some((e) => e.id === "tee_boys_overweight_3_18"));
  assert.equal(r.data.estimates.some((e) => e.id === "eer_boys_9_18"), false);
  assert.ok(r.data.inputs_used.bmi_for_age_percentile > 85);
  assert.match(r.data.inputs_used.bmi_percentile_source, /WHO BMI-for-age/);
  assert.equal(r.data.warnings.some((w) => /No BMI-for-age percentile/.test(w)), false);
});

test("engine warns with the reason when the lookup failed, and rejects a silly percentile", async () => {
  const body = await enrichBmiPercentile({ sex: "male", age_years: 10, weight_kg: 45, height_cm: 140, pal_category: "low_active" }, fakeDb({ older: null }));
  const r = computeEnergyRequirements(body);
  assert.ok(r.data.estimates.some((e) => e.id === "eer_boys_9_18"));
  assert.match(r.data.warnings.join(" "), /could not be looked up/);
  assert.equal(computeEnergyRequirements({ sex: "male", age_years: 10, weight_kg: 30, height_cm: 135, pal_category: "active", bmi_for_age_percentile: 120 }).ok, false);
});
