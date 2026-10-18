import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSportsEnergy, computeSportsMacros, computeFuelTiming, computeHydration, computeBodyComposition,
  computeSupplementDoses, computeSportsPlan, sportsReferenceCatalog, ACTIVITY_LEVELS, KNOWN_ISSUES,
} from "../src/sportsNutrition.js";

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("Box 23.2: 79.5 kg athlete, 71.6 kg lean, extra active = REE 2075, 3942 with activity, TEF 394, 4336 total", () => {
  const r = computeSportsEnergy({ weight_kg: 79.5, lean_body_mass_kg: 71.6, activity_level: "extra_active" });
  assert.equal(r.ok, true);
  near(r.data.ree_kcal, 2075, 0.5);
  near(r.data.activity.base_kcal, 3942, 1);
  near(r.data.tef_kcal, 394, 1);
  near(r.data.total_kcal, 4336, 1);
  assert.match(r.data.notes.join(" "), /Do not mix the two methods/);
});

test("body fat input gives the same lean mass: 79.5 kg at 10% fat", () => {
  const r = computeSportsEnergy({ weight_kg: 79.5, body_fat_percent: 10, activity_level: "extra_active" });
  assert.equal(r.ok, true);
  near(r.data.inputs_used.lean_body_mass_kg, 71.6, 0.1);
  near(r.data.total_kcal, 4336, 3);
});

test("case study: FFM 74 kg gives REE 2128 and the printed 1.2 / 1.4 / 1.6 totals (TEF off)", () => {
  const f = (m) => computeSportsEnergy({ weight_kg: 78.9, lean_body_mass_kg: 74, activity_multiplier: m, tef: false }).data;
  assert.equal(f(1.2).ree_kcal, 2128);
  assert.equal(f(1.2).total_kcal, 2554); // chapter prints 2553 (truncated)
  near(f(1.4).total_kcal, 2979, 1);
  near(f(1.6).total_kcal, 3404, 1);
});

test("case study: 1.73 x 2128 is 3681, not the printed 4581", () => {
  const d = computeSportsEnergy({ weight_kg: 78.9, lean_body_mass_kg: 74, activity_multiplier: 1.73, tef: false }).data;
  near(d.total_kcal, 3681, 1);
  assert.ok(KNOWN_ISSUES.some((i) => i.id === "case_study_activity_arithmetic"));
});

test("METs: 4.5 METs, 80 kg, 30 min = 189 kcal with the chapter constant", () => {
  const d = computeSportsEnergy({ weight_kg: 80, lean_body_mass_kg: 65, exercise: [{ mets: 4.5, minutes: 30 }], tef: false }).data;
  assert.equal(d.activity.exercise[0].kcal, 189);
  assert.equal(d.activity.exercise[0].kcal_per_minute, 6.3);
});

test("energy: activity log from the table is added, and a double-count warning appears", () => {
  const d = computeSportsEnergy({ weight_kg: 74, lean_body_mass_kg: 66, activity_level: "very_active" }, { activityLog: { total: { kcal: 600 } } });
  assert.equal(d.ok, true);
  assert.equal(d.data.activity.exercise_from_activity_log_kcal, 600);
  assert.match(d.data.warnings.join(" "), /counts it twice/);
  assert.match(d.data.warnings.join(" "), /Appendix 10 does not say/);
});

test("energy: Mifflin cross-check, kcal/kg tiers and validation", () => {
  const d = computeSportsEnergy({ weight_kg: 80, body_fat_percent: 12, activity_level: "moderately_active", sex: "male", age_years: 30, height_cm: 180 }).data;
  assert.ok(d.mifflin_cross_check.ree_kcal > 1500);
  assert.equal(d.kcal_per_kg_tiers.length, 4);
  assert.equal(computeSportsEnergy(null).ok, false);
  assert.equal(computeSportsEnergy({ weight_kg: 80, activity_level: "sedentary" }).ok, false); // no lean mass
  assert.equal(computeSportsEnergy({ weight_kg: 80, body_fat_percent: 10, lean_body_mass_kg: 70, activity_level: "sedentary" }).ok, false);
  assert.equal(computeSportsEnergy({ weight_kg: 80, body_fat_percent: 10 }).ok, false); // no activity
  assert.equal(computeSportsEnergy({ weight_kg: 80, body_fat_percent: 10, activity_level: "couch" }).ok, false);
  assert.equal(computeSportsEnergy({ weight_kg: 80, body_fat_percent: 10, activity_level: "sedentary", activity_multiplier: 1.4 }).ok, false);
  assert.equal(computeSportsEnergy({ weight_kg: 80, lean_body_mass_kg: 90, activity_level: "sedentary" }).ok, false);
  assert.equal(ACTIVITY_LEVELS.map((l) => l.factor).join(","), "1.2,1.375,1.55,1.725,1.9");
});

test("macros: case study athlete 79 kg eats 249 g carbohydrate = 3.15 g/kg, below the 5-7 g/kg minimum", () => {
  const d = computeSportsMacros({ weight_kg: 79, profile: "general_training", intake: { carbohydrate_g: 249, protein_g: 216, fat_g: 130 } });
  assert.equal(d.ok, true);
  assert.equal(d.data.macronutrients.carbohydrate.grams.min, 395);
  assert.equal(d.data.macronutrients.carbohydrate.grams.max, 553);
  assert.equal(d.data.intake_check.nutrients.carbohydrate.status, "below");
  assert.equal(d.data.intake_check.nutrients.protein.status, "above");
  assert.match(d.data.warnings.join(" "), /below the 5 g\/kg minimum/);
});

test("macros: elite endurance 60 kg = up to 720 g carbohydrate (7-12 g/kg = 420-720 g)", () => {
  const d = computeSportsMacros({ weight_kg: 60, profile: "elite_endurance" }).data;
  assert.equal(d.macronutrients.carbohydrate.grams.min, 420);
  assert.equal(d.macronutrients.carbohydrate.grams.max, 720);
});

test("macros: energy check, AMDR and the resistance protein rules", () => {
  const d = computeSportsMacros({ weight_kg: 80, profile: "resistance_hypertrophy", energy_kcal: 3500, age_years: 25 }).data;
  assert.equal(d.energy_check.at_midpoints.carbohydrate.grams, 480);
  assert.equal(d.energy_check.at_midpoints.protein.grams, 128);
  assert.equal(d.amdr_check.age_bucket, "adults");
  assert.equal(d.protein_distribution.per_meal_g, 24);
  assert.equal(d.protein_distribution.before_sleep_g.min, 27.5);
  const small = computeSportsMacros({ weight_kg: 80, profile: "endurance", energy_kcal: 1500 });
  assert.match(small.data.warnings.join(" "), /exceed the energy/);
  assert.equal(computeSportsMacros({ weight_kg: 80 }).ok, false);
  assert.equal(computeSportsMacros({ weight_kg: 80, profile: "bogus" }).ok, false);
  assert.equal(computeSportsMacros({ weight_kg: 80, profile: "endurance", intake: { carbohydrate_g: -3 } }).ok, false);
});

test("fuel timing: 4 g/kg at 4 h, 1 g/kg at 1 h, capped, with Box 23.4 tiers", () => {
  const f = (hb) => computeFuelTiming({ weight_kg: 70, hours_before_event: hb }).data.before;
  assert.equal(f(4).carbohydrate_g_per_kg, 4);
  assert.equal(f(4).carbohydrate_g, 280);
  assert.equal(f(1).carbohydrate_g_per_kg, 1);
  assert.deepEqual(f(1).meal_energy_tier.kcal, { min: 100, max: 150 });
  assert.deepEqual(f(2).meal_energy_tier.kcal, { min: 300, max: 400 });
  assert.deepEqual(f(4).meal_energy_tier.kcal, { min: 600, max: 700 });
  assert.equal(f(1.5).meal_energy_tier, null);
  assert.equal(f(6).carbohydrate_g_per_kg, 4);
});

test("fuel timing: nothing under 60 min, 25-30 g per 30 min after, recovery 1.2 g/kg/h", () => {
  assert.equal(computeFuelTiming({ weight_kg: 70, duration_min: 45 }).data.during.applies, false);
  const d = computeFuelTiming({ weight_kg: 70, duration_min: 120, recovery_hours: 4 }).data;
  assert.deepEqual(d.during.carbohydrate_g_total, { min: 100, max: 120 });
  assert.equal(d.after.carbohydrate_g_per_hour, 84);
  assert.equal(d.after.carbohydrate_g_total, 336);
  assert.deepEqual(d.after.protein_g_for_total, { min: 17, max: 30 });
});

test("drink concentration: 14-16 g per 8 oz is 6%, over 10% flags GI distress", () => {
  const six = computeFuelTiming({ weight_kg: 70, drink: { carbohydrate_g: 14.4 } }).data.drink_check;
  assert.equal(six.concentration_percent, 6);
  assert.equal(six.band, "5_to_8");
  assert.equal(computeFuelTiming({ weight_kg: 70, drink: { carbohydrate_g: 30 } }).data.drink_check.band, "above_10");
  assert.equal(computeFuelTiming({ weight_kg: 70, drink: { carbohydrate_g: 9 } }).data.drink_check.band, "below_4");
  assert.equal(computeFuelTiming({ weight_kg: 70, drink: { carbohydrate_g: 10, serving_g: 100, serving_ml: 100 } }).ok, false);
  assert.equal(computeFuelTiming({}).ok, false);
});

test("hydration: 70 kg to 68.6 kg is a 2% loss, rehydrate 125-150% of the loss, 80% before the next session", () => {
  const d = computeHydration({ weight_before_kg: 70, weight_after_kg: 68.6, hours_to_next_session: 3, fluid_intake_ml: 500, urine_ml: 100, duration_min: 90 }).data;
  assert.equal(d.body_mass.loss_percent, 2);
  assert.equal(d.body_mass.level, "2_percent_or_more");
  assert.deepEqual(d.rehydration.volume_ml, { min: 1750, max: 2100 });
  assert.equal(d.rehydration.before_next_session.volume_ml, 1120);
  assert.equal(d.sweat_estimate.sweat_loss_ml, 1800);
  assert.equal(d.sweat_estimate.per_hour_ml, 1200);
  assert.ok(d.during_exercise.planned_total_ml.max > d.during_exercise.planned_total_ml.min);
  assert.ok(d.sodium.planned_mg.max > 0);
  assert.match(d.warnings.join(" "), /2% loss/);
});

test("hydration: weight gain warns about hyponatremia, urine SG bands, children, heat", () => {
  assert.match(computeHydration({ weight_before_kg: 70, weight_after_kg: 70.8 }).data.warnings.join(" "), /hyponatremia/);
  const band = (sg) => computeHydration({ urine_specific_gravity: sg }).data.urine_specific_gravity.band;
  assert.equal(band(1.005), "hydrated");
  assert.equal(band(1.02), "possible_mild_dehydration");
  assert.equal(band(1.035), "above_range"); // the case study's first reading
  assert.equal(computeHydration({ duration_min: 30, age_years: 8 }).data.population.group, "child_10_or_under");
  assert.equal(computeHydration({ duration_min: 30, age_years: 14 }).data.population.additional_ml, 237);
  assert.match(computeHydration({ duration_min: 30, ambient_c: 38 }).data.warnings.join(" "), /36 C/);
  assert.equal(computeHydration({}).ok, false);
  assert.equal(computeHydration({ weight_before_kg: 70 }).ok, false);
});

test("body composition: 79.5 kg male at 10% fat", () => {
  const d = computeBodyComposition({ sex: "male", weight_kg: 79.5, body_fat_percent: 10 }).data;
  assert.equal(d.fat_mass_kg, 7.95);
  assert.equal(d.lean_body_mass_kg, 71.55);
  assert.equal(d.status, "within_healthy_range");
  assert.equal(d.weights_kg.lowest_safe, 75.3); // 71.55 / 0.95
  assert.equal(d.weights_kg.highest_optimal, 91.7); // 71.55 / 0.78
  assert.equal(d.reference.lowest_body_fat_percent, 5);
});

test("body composition: adolescent floor, below-floor warning, target below lowest safe weight, weeks to target", () => {
  const teen = computeBodyComposition({ sex: "female", weight_kg: 55, body_fat_percent: 13, age_years: 16 }).data;
  assert.equal(teen.reference.lowest_body_fat_percent, 14);
  assert.equal(teen.status, "below_lowest_reference");
  assert.match(teen.warnings.join(" "), /below the lowest reference/);
  const low = computeBodyComposition({ sex: "male", weight_kg: 80, body_fat_percent: 10, target_weight_kg: 70 }).data;
  assert.equal(low.target_check.status, "below_lowest_safe_weight");
  assert.equal(low.target_check.weeks, null);
  const ok = computeBodyComposition({ sex: "male", weight_kg: 80, body_fat_percent: 15, target_weight_kg: 76 }).data;
  assert.equal(ok.target_check.status, "reachable");
  assert.ok(ok.target_check.weeks.max >= ok.target_check.weeks.min);
  const gain = computeBodyComposition({ sex: "female", weight_kg: 60, body_fat_percent: 22, target_weight_kg: 62 }).data;
  assert.deepEqual(gain.weekly_rates.gain.lean_lb_per_week, { min: 0.25, max: 0.75 });
  assert.equal(computeBodyComposition({ weight_kg: 70, body_fat_percent: 12 }).ok, false);
});

test("supplement doses: caffeine 3 mg/kg, creatine regimens, beta-alanine, and withheld for minors, pregnancy, nursing", () => {
  const d = computeSupplementDoses({ weight_kg: 68, age_years: 25 }).data;
  assert.equal(d.doses_given, true);
  const by = Object.fromEntries(d.supplements.map((s) => [s.id, s]));
  assert.equal(by.caffeine.dose_mg, 204);
  assert.equal(by.creatine.without_loading.first_phase_days.min, 5);
  assert.equal(by.creatine.without_loading.g_per_day_first_phase, 20.4);
  assert.equal(by.creatine.without_loading.maintenance_g_per_day, 2);
  assert.equal(by.beta_alanine.dose_from_weight_g_per_day, 4.4);
  assert.equal(by.hmb.dose_g_per_day, 3);
  const minor = computeSupplementDoses({ weight_kg: 60, age_years: 16, supplements: ["creatine"] }).data;
  assert.equal(minor.doses_given, false);
  assert.match(minor.reason, /under 18/);
  assert.match(minor.reason, /Academy of Pediatrics/);
  assert.equal(computeSupplementDoses({ weight_kg: 60, age_years: 30, pregnant: true }).data.doses_given, false);
  assert.equal(computeSupplementDoses({ weight_kg: 60, age_years: 30, lactating: true }).data.doses_given, false);
  assert.equal(computeSupplementDoses({ weight_kg: 60 }).ok, false); // age is required
  assert.equal(computeSupplementDoses({ weight_kg: 60, age_years: 30, supplements: ["bogus"] }).ok, false);
});

test("plan: chains energy into macros, and a bad section only errors itself", () => {
  const r = computeSportsPlan({ sex: "male", age_years: 30, weight_kg: 79.5, body_fat_percent: 10, activity_level: "extra_active", profile: "endurance", event: { duration_min: 120, hours_before_event: 4 }, hydration: { weight_before_kg: 79.5, weight_after_kg: 78 }, supplements: { supplements: ["caffeine"] } });
  assert.equal(r.ok, true);
  const s = r.data.sections;
  assert.ok(s.energy && s.macros && s.fuel_timing && s.hydration && s.body_composition && s.supplements);
  assert.equal(s.macros.energy_check.energy_kcal, s.energy.total_kcal);
  const bad = computeSportsPlan({ weight_kg: 79.5, body_fat_percent: 10, activity_level: "couch", profile: "endurance" });
  assert.equal(bad.ok, true);
  assert.ok(bad.data.errors.energy);
  assert.ok(bad.data.sections.macros);
  assert.equal(computeSportsPlan({}).ok, false);
  assert.equal(computeSportsPlan(null).ok, false);
});

test("reference catalog lists the known chapter issues and the related endpoints", () => {
  const c = sportsReferenceCatalog();
  assert.equal(c.energy.activity_levels.length, 5);
  assert.ok(c.known_issues.length >= 6);
  assert.ok(c.related_endpoints.some((e) => e.includes("/energy/requirements")));
  assert.equal(c.macronutrients.endurance.carbohydrate_g_per_kg.max, 10);
});
