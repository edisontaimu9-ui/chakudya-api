import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEnergyRequirements, mifflinStJeor, palFromActivities, palCategoryFor, metEnergyKcal, interpretRQ,
  driReferenceAdultEER, registerActivityFactor, registerStressFactor, energyFactorCatalog, IOM_EQUATIONS, normalizeSexMF,
} from "../src/energyEngine.js";

const run = (i) => computeEnergyRequirements(i);
const est = (d, id) => d.estimates.find((e) => e.id === id);

test("Mifflin-St Jeor matches the chapter's equations", () => {
  assert.equal(mifflinStJeor({ sex: "male", weightKg: 80, heightCm: 175, ageYears: 40 }), 800 + 1093.75 - 200 + 5);
  assert.equal(mifflinStJeor({ sex: "female", weightKg: 65, heightCm: 177, ageYears: 30 }), 650 + 1106.25 - 150 - 161);
});

test("IOM adult equations reproduce Table 2.2 reference values (active PAL)", () => {
  const woman = run({ sex: "female", age_years: 19, weight_kg: 57, height_cm: 163, pal_category: "active" });
  assert.equal(est(woman.data, "eer_women_19").kcal, 2403);
  assert.equal(driReferenceAdultEER("female", 19), 2403);
  const man = run({ sex: "male", age_years: 19, weight_kg: 70, height_cm: 177, pal_category: "active" });
  assert.equal(est(man.data, "eer_men_19").kcal, 3067);
  assert.equal(driReferenceAdultEER("male", 29), 2967);
});

test("the chapter's worked example (30 y woman, 65 kg, 1.77 m, PA 1.27) gives 2551, not the printed 2251", () => {
  const r = run({ sex: "female", age_years: 30, weight_kg: 65, height_cm: 177, pal_category: "active" });
  assert.equal(est(r.data, "eer_women_19").kcal, 2551);
  assert.equal(est(r.data, "eer_women_19").pa_coefficient, 1.27);
});

test("pregnancy and lactation add-ons reproduce Table 2.2", () => {
  const base = { sex: "female", age_years: 19, weight_kg: 57, height_cm: 163, pal_category: "active" };
  assert.equal(run({ ...base, pregnancy: { trimester: 1 } }).data.estimates.at(-1).kcal, 2403);
  assert.equal(run({ ...base, pregnancy: { trimester: 2 } }).data.estimates.at(-1).kcal, 2743);
  assert.equal(run({ ...base, pregnancy: { trimester: 3 } }).data.estimates.at(-1).kcal, 2855);
  assert.equal(run({ ...base, lactation: { months_postpartum: 3 } }).data.estimates.at(-1).kcal, 2733);
  assert.equal(run({ ...base, lactation: { months_postpartum: 9 } }).data.estimates.at(-1).kcal, 2803);
  assert.match(run({ ...base, lactation: { months_postpartum: 3 } }).data.notes.join(" "), /500 - 70/);
  assert.equal(run({ ...base, pregnancy: { trimester: 2 }, lactation: { months_postpartum: 3 } }).ok, false);
  assert.equal(run({ ...base, sex: "male", pregnancy: { trimester: 2 } }).ok, false);
});

test("infant and child equations", () => {
  const infant = run({ sex: "female", age_months: 3, weight_kg: 6 });
  assert.equal(infant.data.estimates[0].kcal, 89 * 6 - 100 + 175);
  const boy = run({ sex: "male", age_years: 6, weight_kg: 20, height_cm: 115, pal_category: "low_active" });
  assert.equal(est(boy.data, "eer_boys_3_8").kcal, Math.round(88.5 - 61.9 * 6 + 1.13 * (26.7 * 20 + 903 * 1.15) + 20));
  const over = run({ sex: "male", age_years: 6, weight_kg: 30, height_cm: 115, pal_category: "sedentary", bmi_for_age_percentile: 92 });
  assert.ok(est(over.data, "tee_boys_overweight_3_18"));
  assert.equal(est(over.data, "eer_boys_3_8"), undefined);
  assert.equal(run({ sex: "male", age_years: 6, weight_kg: 20, height_cm: 115, pal_category: "low_active" }).data.warnings.some((w) => /bmi_for_age_percentile/.test(w)), true);
});

test("adult BMI picks the right IOM equation and lists the other applicable one", () => {
  const normal = run({ sex: "male", age_years: 30, weight_kg: 70, height_cm: 175, pal_category: "sedentary" }).data;
  assert.equal(normal.estimates.find((e) => e.id === "eer_men_19").alternatives[0].id, "tee_men_all_19");
  const heavy = run({ sex: "female", age_years: 40, weight_kg: 95, height_cm: 160, pal_category: "low_active" }).data;
  assert.equal(heavy.inputs_used.bmi, 37.1);
  const e = heavy.estimates.find((x) => x.id === "tee_women_overweight_19");
  assert.ok(e);
  const thin = run({ sex: "female", age_years: 40, weight_kg: 40, height_cm: 165, pal_category: "low_active" });
  assert.equal(thin.data.estimates.some((x) => x.id.startsWith("eer_") || x.id.startsWith("tee_")), false);
  assert.match(thin.data.warnings.join(" "), /below 18.5/);
});

test("every IOM equation has four PA coefficients starting at 1", () => {
  for (const e of IOM_EQUATIONS) { assert.equal(e.pa.length, 4); assert.equal(e.pa[0], 1); }
});

test("REE x stress x activity, and the recommended pick", () => {
  const r = run({ sex: "male", age_years: 40, weight_kg: 80, height_cm: 175, activity_factor: "minimal", activity_position: "mid", stress: [{ id: "fever", temperature_c: 38.5 }] }).data;
  const ree = 10 * 80 + 6.25 * 175 - 5 * 40 + 5;
  assert.equal(r.ree.kcal, Math.round(ree * 10) / 10);
  assert.equal(r.stress.multiplier, 1.195);
  assert.equal(est(r, "ree_x_activity").kcal, Math.round(ree * 1.195 * 1.15));
  assert.equal(r.recommended.id, "ree_x_activity");
  const f = run({ sex: "male", age_years: 40, weight_kg: 80, height_cm: 175, activity_factor: "minimal", stress: [{ id: "fever", temperature_f: 101.6 }] }).data;
  assert.equal(f.stress.multiplier, 1.21);
  const cool = run({ sex: "male", age_years: 40, weight_kg: 80, height_cm: 175, activity_factor: "moderate", stress: [{ id: "fever", temperature_c: 36.5 }] }).data;
  assert.equal(cool.stress.multiplier, 1);
});

test("activity positions and ranges", () => {
  const base = { sex: "female", age_years: 30, weight_kg: 60, height_cm: 165 };
  const ree = 600 + 1031.25 - 150 - 161;
  assert.equal(est(run({ ...base, activity_factor: "moderate", activity_position: "low" }).data, "ree_x_activity").kcal, Math.round(ree * 1.25));
  assert.equal(est(run({ ...base, activity_factor: "moderate", activity_position: "high" }).data, "ree_x_activity").kcal, Math.round(ree * 1.4));
  assert.equal(est(run({ ...base, activity_factor: "strenuous", activity_position: 1 }).data, "ree_x_activity").kcal, Math.round(ree * 1.6));
  assert.equal(run({ ...base, activity_factor: "extreme" }).ok, false);
  assert.equal(run({ ...base, activity_factor: "moderate", activity_position: 2 }).ok, false);
});

test("measured REE replaces the prediction and is preferred", () => {
  const r = run({ sex: "female", age_years: 50, weight_kg: 70, height_cm: 160, measured_ree_kcal: 1500, activity_factor: "minimal", pal_category: "sedentary", rq: { vco2: 800, vo2: 1000 } }).data;
  assert.equal(r.ree.method, "measured");
  assert.equal(r.recommended.id, "ree_x_activity");
  assert.equal(r.rq.rq, 0.8);
  const child = run({ sex: "female", age_years: 10, weight_kg: 30, height_cm: 135, pal_category: "active" }).data;
  assert.equal(child.ree, null);
  assert.match(child.notes.join(" "), /under 18/);
});

test("PAL from an activity log follows the chapter's worked example (PAL 1.8)", () => {
  const p = palFromActivities([
    { id: "vacuuming", hours: 1 }, { label: "walking the dog", delta_pal_per_hour: 0.11, hours: 1 },
    { id: "light_activity_sitting", hours: 4 }, { id: "walking_4mph", hours: 1 }, { id: "ice_skating", minutes: 30 },
  ], 65);
  assert.equal(p.delta_pal_total, 0.7);
  assert.equal(p.pal, 1.8);
  assert.equal(palCategoryFor(p.pal), "active");
  assert.equal(metEnergyKcal(4.5, 65, 1), 292.5);
  assert.ok(palFromActivities([{ id: "nope", hours: 1 }]).error);
  assert.ok(palFromActivities([{ id: "swimming", hours: 20 }, { id: "swimming", hours: 5 }]).error);
  const viaEngine = run({ sex: "female", age_years: 30, weight_kg: 65, height_cm: 177, activities: [{ id: "vacuuming", hours: 1 }] }).data;
  assert.equal(viaEngine.inputs_used.pal, 1.24);
  assert.equal(viaEngine.inputs_used.pal_category, "sedentary");
});

test("PAL categories follow Table 2.3", () => {
  assert.equal(palCategoryFor(1), "sedentary");
  assert.equal(palCategoryFor(1.39), "sedentary");
  assert.equal(palCategoryFor(1.4), "low_active");
  assert.equal(palCategoryFor(1.6), "active");
  assert.equal(palCategoryFor(1.89), "active");
  assert.equal(palCategoryFor(1.9), "very_active");
  assert.equal(palCategoryFor(2.5), "very_active");
  assert.equal(palCategoryFor(2.6), null);
});

test("RQ interpretation", () => {
  assert.equal(interpretRQ(1100, 1000).flags.length, 1);
  assert.equal(interpretRQ(640, 1000).flags.length, 1);
  assert.equal(interpretRQ(700, 1000).closest_reference.fuel, "fat");
  assert.ok(interpretRQ(0, 1000).error);
});

test("validation", () => {
  assert.equal(run(null).ok, false);
  assert.equal(run({ age_years: 30, weight_kg: 60 }).ok, false);
  assert.equal(run({ sex: "female", weight_kg: 60 }).ok, false);
  assert.equal(run({ sex: "female", age_years: 30, weight_kg: 6000 }).ok, false);
  assert.equal(run({ sex: "female", age_years: 30, weight_kg: 60, height_cm: 16 }).ok, false);
  const reeOnly = run({ sex: "female", age_years: 30, weight_kg: 60, height_cm: 165 });
  assert.equal(reeOnly.ok, true); // REE alone is still useful
  assert.equal(reeOnly.data.recommended, null);
  assert.equal(reeOnly.data.estimates.length, 0);
  assert.equal(run({ sex: "female", age_years: 10, weight_kg: 30 }).ok, false); // a child with no height and no PAL: nothing to calculate
  assert.equal(run({ sex: "female", age_years: 30, weight_kg: 60, height_cm: 165, activity_factor: "minimal", stress: [{ id: "nope" }] }).ok, false);
  assert.equal(run({ sex: "female", age_years: 30, weight_kg: 60, height_cm: 165, activity_factor: "minimal", stress: [{ id: "fever" }] }).ok, false);
  assert.equal(normalizeSexMF("Women"), "female");
  assert.equal(normalizeSexMF("x"), null);
});

test("custom stress factor and registry extension", () => {
  const base = { sex: "male", age_years: 40, weight_kg: 80, height_cm: 175, activity_factor: "minimal", activity_position: "low" };
  const r = run({ ...base, stress: [{ id: "custom", label: "Clinician set", multiplier: 1.3 }] }).data;
  assert.equal(r.stress.multiplier, 1.3);
  assert.equal(run({ ...base, stress: [{ id: "custom", multiplier: 9 }] }).ok, false);
  registerStressFactor({ id: "test_factor", label: "Test", source: "unit test", compute: (p) => ({ multiplier: 1.1, detail: "fixed" }) });
  registerActivityFactor({ id: "test_level", label: "Test level", min: 0.05, max: 0.1, source: "unit test" });
  const x = run({ ...base, activity_factor: "test_level", stress: [{ id: "test_factor" }] }).data;
  assert.equal(x.stress.multiplier, 1.1);
  assert.equal(x.activity.factor.id, "test_level");
  assert.throws(() => registerActivityFactor({ id: "Bad Id", min: 0, max: 1, source: "x" }));
  assert.throws(() => registerStressFactor({ id: "no_fn", source: "x" }));
});

test("factor catalog lists registries and reference tables", () => {
  const c = energyFactorCatalog();
  assert.ok(c.activity_factors.some((a) => a.id === "moderate" && a.min_percent === 25 && a.max_percent === 40));
  assert.ok(c.stress_factors.some((s) => s.id === "fever"));
  assert.equal(c.activities.length, 24);
  assert.equal(c.iom_equations.length, 12);
  assert.equal(c.pal_categories.length, 4);
  assert.equal(c.pregnancy_add_kcal[3], 452);
});
