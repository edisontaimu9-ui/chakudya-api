// Paediatric nutrition calculators: energy, protein, fluid, preterm, growth velocity, catch-up, enteral feeds, plan, reference. Pure functions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computePaediatricEnergy, computePaediatricProtein, computePaediatricFluid, computePretermRequirements, computeGrowthVelocity,
  computeCatchUp, computeEnteralFeeds, computePaediatricPlan, idealWeightLookupFor, paediatricReferenceCatalog, driFaoTee, maintenanceFluid,
} from "../src/paediatric.js";

const d = (r) => { assert.equal(r.ok, true, r.error); return r.data; };

describe("fluid (Holliday-Segar)", () => {
  test("bands", () => {
    assert.deepEqual(maintenanceFluid(8), { min: 800, max: 1200, standard: 800, formula: "0-10 kg: 100-150 mL/kg/day (Holliday-Segar 100 mL/kg)" });
    assert.equal(maintenanceFluid(15).standard, 1250);
    assert.equal(maintenanceFluid(20).standard, 1500);
    assert.equal(maintenanceFluid(25).standard, 1600);
  });
  test("route function: mL/day, mL/kg, mL/hr", () => {
    const f = d(computePaediatricFluid({ weight_kg: 25 }));
    assert.equal(f.daily_ml.standard, 1600);
    assert.equal(f.ml_per_hour.standard, 66.7);
    assert.equal(f.ml_per_kg_day.standard, 64);
    assert.equal(d(computePaediatricFluid({ weight_g: 3200 })).daily_ml.min, 320);
    assert.equal(computePaediatricFluid({}).ok, false);
    assert.equal(computePaediatricFluid({ weight_kg: 900 }).ok, false);
  });
});

describe("DRI/FAO table lookup", () => {
  test("monthly under 12 months, yearly after", () => {
    assert.equal(driFaoTee("female", 0.5).kcal_per_kg_day, 107);
    assert.equal(driFaoTee("male", 8).kcal_per_kg_day, 79);
    assert.equal(driFaoTee("male", 11.9).kcal_per_kg_day, 81);
    assert.equal(driFaoTee("female", 72).kcal_per_kg_day, 69);
    assert.equal(driFaoTee("male", 12).kcal_per_kg_day, 82);
    assert.equal(driFaoTee("male", 17.5 * 12).kcal_per_kg_day, 50);
    assert.equal(driFaoTee("male", 18 * 12), null);
  });
});

describe("energy", () => {
  test("Schofield and WHO 1985 BMR, hand-checked", () => {
    const e = d(computePaediatricEnergy({ sex: "female", age_years: 6, weight_kg: 20, height_cm: 115, pal_category: "low_active" }));
    const sch = e.bmr_estimates.find((x) => x.id === "schofield_1985");
    const who = e.bmr_estimates.find((x) => x.id === "who_1985");
    assert.equal(sch.bmr_kcal, 897);   // 16.969*20 + 1.618*115 + 371.2
    assert.equal(who.bmr_kcal, 949);   // 22.5*20 + 499
    assert.equal(e.dri_fao_2004.kcal, 1380); // 69 kcal/kg x 20
    assert.equal(e.iom_eer.id, "eer_girls_3_8");
    assert.equal(e.recommended.id, "eer_girls_3_8");
    assert.ok(e.macronutrient_distribution.grams_per_day.protein.max > 0);
  });
  test("boys 0-3 Schofield with height", () => {
    const e = d(computePaediatricEnergy({ sex: "male", age_months: 12, weight_kg: 10, height_cm: 75 }));
    assert.equal(e.bmr_estimates[0].bmr_kcal, 522); // 0.167*10 + 15.174*75 - 617.6
    assert.equal(e.bmr_estimates[1].bmr_kcal, 555); // 60.9*10 - 54
  });
  test("activity and stress factors become a range and switch the recommendation", () => {
    const e = d(computePaediatricEnergy({ sex: "female", age_years: 6, weight_kg: 20, height_cm: 115, activity_level: "light", stress_condition: "infection_sepsis" }));
    const s = e.bmr_estimates[0];
    assert.equal(s.tee_kcal.low, Math.round(896.65 * 1.3 * 1.2));
    assert.equal(s.tee_kcal.high, Math.round(896.65 * 1.5 * 1.6));
    assert.equal(e.recommended.id, "schofield_1985");
    assert.ok(e.warnings.some((w) => /Both an activity factor and a stress factor/.test(w)));
    const g = d(computePaediatricEnergy({ sex: "male", age_years: 3, weight_kg: 12, stress_condition: "growth_failure", stress_position: "high" }));
    assert.equal(g.stress_factor.value, 2);
    assert.equal(g.bmr_estimates[0].id, "who_1985"); // no height, so WHO only
  });
  test("custom factors and validation", () => {
    const e = d(computePaediatricEnergy({ sex: "male", age_years: 8, weight_kg: 25, stress_factor: 1.2 }));
    assert.equal(e.stress_factor.value, 1.2);
    assert.equal(computePaediatricEnergy({ age_years: 8, weight_kg: 25 }).ok, false);
    assert.equal(computePaediatricEnergy({ sex: "male", age_years: 19, weight_kg: 25 }).ok, false);
    assert.equal(computePaediatricEnergy({ sex: "male", age_years: 8, weight_kg: 900 }).ok, false);
    assert.equal(computePaediatricEnergy({ sex: "male", age_years: 8, weight_kg: 25, activity_level: "nope" }).ok, false);
    assert.equal(computePaediatricEnergy({ sex: "male", age_years: 8, weight_kg: 25, stress_condition: "burn", stress_position: 2 }).ok, false);
  });
  test("an infant uses the IOM 0-35 month equation", () => {
    const e = d(computePaediatricEnergy({ sex: "female", age_months: 5, weight_kg: 6.5 }));
    assert.equal(e.iom_eer.kcal, 89 * 6.5 - 100 + 56 > 0 ? Math.round(89 * 6.5 - 100 + 56) : 0);
  });
});

describe("protein", () => {
  test("healthy growth bands (IOM)", () => {
    const kg = (m) => d(computePaediatricProtein({ age_months: m, weight_kg: 10 })).healthy_child.g_per_kg_day;
    assert.equal(kg(3), 1.52);
    assert.equal(kg(8), 1.5);
    assert.equal(kg(30), 1.1);
    assert.equal(kg(120), 0.95);
    assert.equal(kg(16 * 12), 0.85);
  });
  test("sick child dose (ASPEN) and the recommendation follows clinical_status", () => {
    assert.deepEqual(d(computePaediatricProtein({ age_months: 18, weight_kg: 10, clinical_status: "sick" })).recommended.g_per_kg_day, { min: 3, max: 3 });
    const s = d(computePaediatricProtein({ age_months: 60, weight_kg: 18, clinical_status: "sick" }));
    assert.deepEqual(s.recommended.g_per_day, { min: 27, max: 36 });
    assert.deepEqual(d(computePaediatricProtein({ age_months: 15 * 12, weight_kg: 50, clinical_status: "sick" })).recommended.g_per_kg_day, { min: 1.5, max: 1.5 });
    assert.equal(d(computePaediatricProtein({ age_months: 60, weight_kg: 18 })).recommended.basis, "healthy_child");
    assert.equal(computePaediatricProtein({ age_months: 60, weight_kg: 18, clinical_status: "ill" }).ok, false);
  });
  test("protein as a share of energy against the AMDR", () => {
    const p = d(computePaediatricProtein({ age_months: 60, weight_kg: 18, energy_kcal: 1500 }));
    assert.equal(p.protein_vs_energy.protein_g_used, 17.1);
    assert.equal(p.protein_vs_energy.percent_of_energy, 4.6);
    assert.equal(p.protein_vs_energy.within_amdr, false); // 4-18 y range is 10-30%
  });
});

describe("preterm", () => {
  test("protein by weight band, boundaries", () => {
    const band = (g) => d(computePretermRequirements({ weight_g: g })).requirements.protein;
    assert.deepEqual(band(900).g_per_kg_day, { min: 3.5, max: 4.5 });
    assert.equal(band(1000).band, "1000-1500 g");
    assert.equal(band(1500).band, "1000-1500 g");
    assert.deepEqual(band(1800).g_per_kg_day, { min: 3, max: 4 });
    assert.deepEqual(band(2400).g_per_kg_day, { min: 2.5, max: 3.5 });
    assert.deepEqual(band(2600).g_per_kg_day, { min: 2, max: 2.5 });
  });
  test("fluid and energy per day", () => {
    const r = d(computePretermRequirements({ weight_g: 1200 })).requirements;
    assert.deepEqual(r.fluid.ml_per_day, { min: 144, max: 240 });
    assert.deepEqual(r.energy.kcal_per_day, { min: 132, max: 156 });
  });
  test("monitoring against targets", () => {
    const m = d(computePretermRequirements({
      weight_g: 1200,
      monitoring: { birth_weight_g: 1000, nadir_weight_g: 880, days_to_regain_birth_weight: 16, weight_g_start: 1200, weight_g_end: 1300, days: 5, length_cm_start: 38, length_cm_end: 39, hc_cm_start: 27, hc_cm_end: 27.5 },
    })).monitoring;
    assert.equal(m.initial_weight_loss.percent, 12);
    assert.equal(m.initial_weight_loss.status, "within_limit");
    assert.equal(m.regain_birth_weight.status, "late");
    assert.equal(m.weight_gain.g_per_kg_day, 16); // 20 g/day over a mean 1.25 kg
    assert.equal(m.weight_gain.status, "within_target");
    assert.equal(m.length.cm_per_week, 1.4);
    assert.equal(m.length.status, "meets_target");
    assert.equal(m.head_circumference.cm_per_week, 0.7);
    assert.equal(m.head_circumference.status, "below_target");
    assert.equal(computePretermRequirements({ weight_g: 1200, monitoring: {} }).ok, false);
    assert.equal(computePretermRequirements({ weight_g: 50 }).ok, false);
  });
});

describe("growth velocity", () => {
  test("infant boy within the reference", () => {
    const v = d(computeGrowthVelocity({ sex: "male", age_months: 2, days: 30, weight_g_start: 4200, weight_g_end: 4800, height_cm_start: 55, height_cm_end: 57.5 }));
    assert.equal(v.weight.g_per_day, 20);
    assert.equal(v.weight.status, "within_reference"); // boys 2-3 months 19-36
    assert.equal(v.length_height.mm_per_day, 0.833);
    assert.equal(v.length_height.status, "within_reference");
    assert.match(v.summary, /within/);
  });
  test("below the reference, and girls 3-6 months has no usable weight range", () => {
    const low = d(computeGrowthVelocity({ sex: "female", age_months: 7, days: 30, weight_gain_g_per_day: 3 }));
    assert.equal(low.weight.status, "below_reference");
    assert.match(low.summary, /below/);
    const none = d(computeGrowthVelocity({ sex: "female", age_months: 4, days: 30, weight_g_start: 6000, weight_g_end: 6300 }));
    assert.equal(none.weight.status, "no_reference");
  });
  test("children 2 to under 11 years, and out-of-range ages", () => {
    const c = d(computeGrowthVelocity({ sex: "male", age_years: 3, days: 90, weight_kg_start: 14, weight_kg_end: 14.4 }));
    assert.equal(c.weight.g_per_day, 4.44);
    assert.equal(c.weight.status, "within_reference"); // 3.5-5
    assert.equal(computeGrowthVelocity({ sex: "male", age_years: 12, days: 30, weight_gain_g_per_day: 5 }).ok, false);
    assert.equal(computeGrowthVelocity({ sex: "male", age_years: 3 }).ok, false);
    assert.equal(computeGrowthVelocity({ sex: "male", age_years: 3, weight_kg_start: 14, weight_kg_end: 14.4 }).ok, false); // no days
  });
});

describe("catch-up growth", () => {
  test("weight-age method, hand-checked", () => {
    const c = d(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 9, ideal_weight_kg: 12 }));
    assert.equal(c.energy.catch_up_kcal_per_kg_day, 112);  // 84 x 12 / 9
    assert.equal(c.energy.catch_up_kcal_per_day, 1008);
    assert.equal(c.protein.catch_up_g_per_kg_day, 1.47);   // 1.1 x 12 / 9
    assert.equal(c.percent_of_ideal_weight, 75);
    assert.equal(c.waterlow_weight_for_height, "moderate wasting");
    assert.equal(c.weight_deficit_kg, 3);
    assert.equal(c.ideal_weight_source, "supplied by the caller");
    assert.equal(c.alternative_stress_factor_method.bmr_method, "WHO (1985)");
  });
  test("weight-age and the stress-factor method with height", () => {
    const c = d(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 9, ideal_weight_kg: 12, weight_age_months: 12, height_cm: 82 }));
    assert.equal(c.energy.reference_kcal_per_kg_day_for_weight_age, 82); // boys 1-2 y
    assert.equal(c.alternative_stress_factor_method.bmr_method, "Schofield (1985)");
    assert.equal(c.alternative_stress_factor_method.kcal_per_day.high, Math.round((c.alternative_stress_factor_method.bmr_kcal * 2)));
  });
  test("uses the looked-up ideal weight and says where it came from", () => {
    const c = d(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 9 }, { idealWeightKg: 12.2, idealWeightSource: "WHO median" }));
    assert.equal(c.ideal_weight_kg, 12.2);
    assert.equal(c.ideal_weight_source, "WHO median");
  });
  test("needs an ideal weight; warns when not underweight and when severe", () => {
    assert.match(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 9 }).error, /ideal weight/);
    assert.ok(d(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 13, ideal_weight_kg: 12 })).warnings.some((w) => /not indicated/.test(w)));
    assert.ok(d(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 7, ideal_weight_kg: 12 })).warnings.some((w) => /refeeding/.test(w)));
    assert.equal(computeCatchUp({ sex: "male", age_months: 24, weight_kg: 9, ideal_weight_kg: 900 }).ok, false);
  });
  test("idealWeightLookupFor only asks for a lookup under 5 years with a height", () => {
    assert.deepEqual(idealWeightLookupFor({ sex: "male", age_months: 24, height_cm: 82 }), { sex: "boys", ageMonths: 24, heightCm: 82, measured: undefined });
    assert.equal(idealWeightLookupFor({ sex: "female", age_months: 24, height_cm: 82 }).sex, "girls");
    assert.equal(idealWeightLookupFor({ sex: "male", age_months: 80, height_cm: 110 }), null);
    assert.equal(idealWeightLookupFor({ sex: "male", age_months: 24 }), null);
    assert.equal(idealWeightLookupFor({ sex: "male", age_months: 24, height_cm: 82, ideal_weight_kg: 12 }), null);
  });
});

describe("enteral feeds", () => {
  test("infant continuous, scaled to weight", () => {
    const f = d(computeEnteralFeeds({ age_months: 8, weight_kg: 8, route: "continuous", formula_kcal_per_ml: 0.67, energy_target_kcal: 700 })).feeds.continuous;
    assert.deepEqual([f.initiation.min, f.initiation.max], [8, 16]);
    assert.deepEqual([f.advancement.min, f.advancement.max], [8, 16]);
    assert.deepEqual([f.goal.min, f.goal.max], [48, 48]);
    assert.deepEqual(f.steps_to_goal, { min: 2, max: 5 });
    assert.deepEqual(f.hours_to_goal, { min: 4, max: 40 });
    assert.equal(f.goal_volume_ml_per_day.min, 1152);
    assert.equal(f.goal_volume_ml_per_kg_day.min, 144);
    assert.equal(f.goal_energy.kcal_per_day.min, 772);
    assert.equal(f.goal_energy.percent_of_energy_target.min, 110);
  });
  test("1-6 years bolus", () => {
    const f = d(computeEnteralFeeds({ age_months: 36, weight_kg: 15, route: "bolus" })).feeds.bolus;
    assert.deepEqual([f.initiation.min, f.initiation.max], [75, 150]);
    assert.deepEqual([f.advancement.min, f.advancement.max], [30, 45]);
    assert.deepEqual([f.goal.min, f.goal.max], [225, 300]);
    assert.deepEqual(f.goal_volume_ml_per_day, { min: 900, max: 1800 });
  });
  test("over 7 years, absolute rates", () => {
    const f = d(computeEnteralFeeds({ age_months: 96, weight_kg: 30, route: "continuous" })).feeds.continuous;
    assert.deepEqual([f.initiation.min, f.goal.min, f.goal.max], [25, 100, 150]);
    assert.deepEqual(f.steps_to_goal, { min: 3, max: 5 });
    assert.deepEqual(f.goal_volume_ml_per_day, { min: 2400, max: 3600 });
  });
  test("age group boundaries and defaults", () => {
    assert.equal(d(computeEnteralFeeds({ age_months: 11, weight_kg: 8 })).age_group, "0-12 months");
    assert.equal(d(computeEnteralFeeds({ age_months: 12, weight_kg: 10 })).age_group, "1-6 years");
    assert.equal(d(computeEnteralFeeds({ age_months: 83, weight_kg: 20 })).age_group, "1-6 years");
    assert.equal(d(computeEnteralFeeds({ age_months: 84, weight_kg: 20 })).age_group, "7 years and over");
    assert.deepEqual(Object.keys(d(computeEnteralFeeds({ age_months: 24, weight_kg: 12 })).feeds), ["continuous", "bolus"]);
    assert.equal(computeEnteralFeeds({ age_months: 24, weight_kg: 12, route: "pump" }).ok, false);
    assert.equal(computeEnteralFeeds({ age_months: 24, weight_kg: 12, formula_kcal_per_ml: 9 }).ok, false);
  });
});

describe("plan and reference", () => {
  test("one call gives energy, protein, fluid and macros", () => {
    const p = d(computePaediatricPlan({ sex: "female", age_years: 6, weight_kg: 20, height_cm: 115, pal_category: "low_active" }));
    assert.equal(p.energy.recommended.id, "eer_girls_3_8");
    assert.equal(p.protein.g_per_day, 19);
    assert.equal(p.fluid.daily_ml.standard, 1500);
    assert.ok(p.macronutrient_distribution);
    assert.equal(p.catch_up, undefined);
  });
  test("catch-up and feeding are added when asked", () => {
    const p = d(computePaediatricPlan({ sex: "female", age_years: 6, weight_kg: 17, height_cm: 110, pal_category: "low_active", ideal_weight_kg: 19, feeding_route: "continuous", clinical_status: "sick" }));
    assert.ok(p.catch_up.energy.catch_up_kcal_per_kg_day > 0);
    assert.equal(p.enteral_feeds.age_group, "1-6 years");
    assert.equal(p.protein.g_per_kg_day.max, 2);
  });
  test("reference sections", () => {
    const all = d(paediatricReferenceCatalog());
    for (const s of ["fluid", "energy_equations", "activity_factors", "stress_factors", "dri_fao_2004_tee", "protein", "preterm", "growth_velocity", "enteral_feeds"]) assert.ok(all.sections.includes(s), s);
    assert.equal(d(paediatricReferenceCatalog("dri_fao_2004_tee")).dri_fao_2004_tee.years_1_18.length, 17);
    assert.equal(paediatricReferenceCatalog("nope").ok, false);
    assert.match(d(paediatricReferenceCatalog("growth_velocity")).growth_velocity.known_issue, /3-6 months/);
  });
  test("no source in the output names a teaching sheet", () => {
    const text = JSON.stringify(paediatricReferenceCatalog().data);
    assert.doesNotMatch(text, /BND|resource sheet|Resources/i);
  });
});
