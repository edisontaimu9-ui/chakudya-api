import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWeightAssessment, computeLossPlan, computeGainPlan, computeWeightProgress, computeDietPattern, computeBariatricGuidance,
  weightReferenceCatalog, REFERENCE_SECTION_IDS, ENERGY_BOOSTERS, KNOWN_ISSUES,
} from "../src/weightManagement.js";

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// Norma, the chapter's case study: 45-year-old, 5 ft 4 in (162.6 cm), 195 lb (88.5 kg), BP 160/90, BMI 33.5.
const NORMA = { sex: "female", age_years: 45, weight_kg: 88.45, height_cm: 162.56, systolic_mmhg: 160, diastolic_mmhg: 90 };

test("assess: the chapter's case study BMI of 33.5 is obesity class I", () => {
  const r = computeWeightAssessment(NORMA);
  assert.equal(r.ok, true);
  assert.equal(r.data.bmi, 33.5);
  assert.equal(r.data.bmi_class.id, "obesity_class_1");
  assert.equal(r.data.bmi_class.nih_obesity_class, "I");
});

test("assess: Table 21.3 risk by BMI class and waist, and the waist boundary", () => {
  const risk = (kg, waist, sex = "female") => computeWeightAssessment({ sex, age_years: 40, weight_kg: kg, height_cm: 170, waist_cm: waist }).data.waist.disease_risk;
  assert.equal(risk(75, 80), "Increased"); // BMI 25.95, waist normal
  assert.equal(risk(75, 95), "High"); // overweight, waist high (over 88)
  assert.equal(risk(95, 80), "High"); // BMI 32.9 obesity I, normal waist
  assert.equal(risk(95, 95), "Very High");
  assert.equal(risk(120, 80), "Extremely High"); // BMI 41.5, class III
});

test("assess: class III is extremely high at either waist", () => {
  const d = computeWeightAssessment({ sex: "male", age_years: 40, weight_kg: 125, height_cm: 175, waist_cm: 95 }).data;
  assert.equal(d.bmi_class.id, "obesity_class_3");
  assert.equal(d.waist.disease_risk, "Extremely High");
});

test("assess: no risk grade for normal BMI, but a high waist is still flagged", () => {
  const d = computeWeightAssessment({ sex: "female", age_years: 40, weight_kg: 62, height_cm: 165, waist_cm: 92 }).data;
  assert.equal(d.waist.disease_risk, null);
  assert.match(d.warnings.join(" "), /normal BMI/);
});

test("assess: metabolic syndrome present, possible and not present", () => {
  const full = computeWeightAssessment({ ...NORMA, waist_cm: 100, triglycerides_mg_dl: 160, hdl_mg_dl: 45, fasting_glucose_mg_dl: 90 }).data.metabolic_syndrome;
  assert.equal(full.status, "present"); // waist, TG, HDL (women under 50), BP 160/90
  assert.deepEqual(full.criteria_not_met, ["glucose"]);
  assert.equal(computeWeightAssessment(NORMA).data.metabolic_syndrome.status, "possible"); // only BP known
  const none = computeWeightAssessment({ sex: "male", age_years: 40, weight_kg: 70, height_cm: 175, waist_cm: 80, triglycerides_mg_dl: 100, hdl_mg_dl: 55, systolic_mmhg: 118, diastolic_mmhg: 76, fasting_glucose_mg_dl: 88 }).data.metabolic_syndrome;
  assert.equal(none.status, "not_present");
  assert.equal(computeWeightAssessment({ sex: "male", age_years: 40, weight_kg: 90, height_cm: 175, waist_cm: 102 }).data.metabolic_syndrome.criteria_met[0], "waist"); // 'or more' for the criterion
});

test("assess: waist-hip ratio, body fat, treatment options by BMI and comorbidity", () => {
  const d = computeWeightAssessment({ sex: "female", age_years: 40, weight_kg: 95, height_cm: 170, waist_cm: 100, hip_cm: 105, body_fat_percent: 38, comorbidity_count: 0 }).data;
  assert.equal(d.waist_hip_ratio.high_risk, true); // 0.95 over 0.8
  assert.equal(d.body_fat.obese_by_body_fat, true);
  const by = Object.fromEntries(d.treatment_options.map((o) => [o.option.slice(0, 8), o.eligible]));
  assert.equal(by["Reduced-"], true); assert.equal(by.Pharmaco, true); assert.equal(by["Very-low"], true); assert.equal(by.Bariatri, false); // BMI 32.9, no comorbidity
  const co = computeWeightAssessment({ sex: "female", age_years: 40, weight_kg: 105, height_cm: 170, comorbidity_count: 2 }).data; // BMI 36.3
  assert.equal(co.treatment_options.find((o) => o.option.startsWith("Bariatric")).eligible, true);
  const mid = computeWeightAssessment({ sex: "female", age_years: 40, weight_kg: 82, height_cm: 170, comorbidity_count: 1 }).data; // BMI 28.4
  assert.equal(mid.treatment_options.find((o) => o.option.startsWith("Pharmaco")).eligible, true); // 27+ with comorbidity
});

test("assess: underweight, older adult and unintentional weight loss", () => {
  const u = computeWeightAssessment({ sex: "female", age_years: 30, weight_kg: 45, height_cm: 168 }).data;
  assert.equal(u.bmi_class.id, "underweight");
  assert.match(u.next_steps.join(" "), /gain-plan/);
  const sev = computeWeightAssessment({ sex: "male", age_years: 30, weight_kg: 44, height_cm: 175 }).data; // BMI 14.4
  assert.match(sev.warnings.join(" "), /below 16/);
  const old = computeWeightAssessment({ sex: "male", age_years: 72, weight_kg: 65, height_cm: 175 }).data; // BMI 21.2
  assert.equal(old.older_adult.weight_loss_advised, false);
  assert.equal(old.older_adult.bmi_below_desirable, true);
  const loss = computeWeightAssessment({ sex: "male", age_years: 50, weight_kg: 70, height_cm: 175, usual_weight_kg: 80, period_days: 60 }).data.weight_change;
  assert.equal(loss.loss_percent, 12.5);
  assert.ok(loss.significance);
  assert.equal(computeWeightAssessment({ sex: "male", age_years: 50, weight_kg: 70, height_cm: 175, usual_weight_kg: 80 }).ok, false); // period_days required
});

test("assess: children by percentile, age rules 2-5 and 6+", () => {
  const c = (age, p, comp) => computeWeightAssessment({ sex: "male", age_years: age, bmi_for_age_percentile: p, secondary_complications: comp }).data;
  assert.equal(c(4, 90, false).band, "overweight");
  assert.equal(c(4, 90, false).weight_loss_may_be_advised, false);
  assert.match(c(4, 90, false).goal, /prolonged weight maintenance or slowing/);
  assert.equal(c(4, 96, true).weight_loss_may_be_advised, true);
  assert.equal(c(4, 96, false).weight_loss_may_be_advised, false); // age 2-5 needs a complication
  assert.equal(c(8, 90, false).weight_loss_may_be_advised, false);
  assert.equal(c(8, 90, true).weight_loss_may_be_advised, true);
  assert.equal(c(8, 96, false).weight_loss_may_be_advised, true);
  assert.equal(c(8, 3, false).band, "underweight");
  assert.equal(c(8, 50, false).band, "below_85th");
  assert.equal(c(8, 96, false).needs_workup, true);
  assert.equal(computeWeightAssessment({ sex: "male", age_years: 8, weight_kg: 30, height_cm: 130 }).ok, false); // percentile needed
  assert.equal(computeWeightAssessment({ sex: "male", age_years: 1, bmi_for_age_percentile: 50 }).ok, false);
});

test("loss plan: Norma gets maintenance from the energy engine minus 500, with the chapter's rate band", () => {
  const r = computeLossPlan({ ...NORMA, height_cm: 162.56, pal_category: "sedentary" });
  assert.equal(r.ok, true);
  const d = r.data;
  assert.equal(d.maintenance.estimate_id, "tee_women_overweight_19");
  assert.equal(d.deficit_plan.intake_kcal, d.maintenance.kcal - 500);
  assert.deepEqual(d.deficit_plan.rate.chapter_guideline.lb_per_week, { min: 0.5, max: 1 }); // BMI 27-35
  assert.equal(d.deficit_plan.rate.static_expectation.lb_per_week, 1); // 500 x 7 / 3500
  assert.equal(d.deficit_plan.goals[0].percent_of_initial, 5);
  assert.equal(d.deficit_plan.protein.grams, Math.round(1.2 * NORMA.weight_kg));
  assert.ok(d.maintenance_at_goal.estimates[0].maintenance_kcal < d.maintenance.kcal); // smaller body needs less
  assert.equal(d.treatment_options.length, 4);
});

test("loss plan: BMI over 35 uses 1-2 lb/week, and a target gives weeks and a 10% note", () => {
  const d = computeLossPlan({ sex: "male", age_years: 40, weight_kg: 130, height_cm: 175, pal_category: "low_active", target_weight_kg: 100 }).data;
  assert.deepEqual(d.deficit_plan.rate.chapter_guideline.lb_per_week, { min: 1, max: 2 });
  assert.equal(d.deficit_plan.target_check.percent_of_initial, 23.1);
  assert.match(d.notes.join(" "), /above 10%/);
  assert.ok(d.deficit_plan.target_check.weeks_at_guideline.min > 0);
});

test("loss plan: safety refusals", () => {
  const base = { sex: "female", age_years: 35, weight_kg: 85, height_cm: 165, pal_category: "sedentary" };
  assert.equal(computeLossPlan({ ...base, weight_kg: 50 }).ok, false); // BMI 18.4
  assert.equal(computeLossPlan({ ...base, weight_kg: 60 }).ok, false); // BMI 22
  assert.equal(computeLossPlan({ ...base, pregnant: true }).ok, false);
  assert.equal(computeLossPlan({ ...base, age_years: 17 }).ok, false);
  assert.equal(computeLossPlan({ ...base, deficit_kcal: 1500 }).ok, false); // outside 500-1000
  assert.equal(computeLossPlan({ ...base, deficit_kcal: 600, intake_kcal: 1500 }).ok, false);
  const vlcd = computeLossPlan({ ...base, intake_kcal: 700 });
  assert.equal(vlcd.ok, false);
  const floor = computeLossPlan({ ...base, maintenance_kcal: 1400, deficit_kcal: 700 }); // leaves 700 kcal
  assert.equal(floor.ok, false);
  assert.match(floor.error, /800 kcal/);
  assert.equal(computeLossPlan({ ...base, target_weight_kg: 90 }).ok, false); // above current
  assert.equal(computeLossPlan({ ...base, target_weight_kg: 45 }).ok, false); // BMI under 18.5
  assert.equal(computeLossPlan({ ...base, pal_category: undefined }).ok, false); // no activity input
});

test("loss plan: age 65+ gets maintenance only, no deficit", () => {
  const d = computeLossPlan({ sex: "female", age_years: 70, weight_kg: 85, height_cm: 160, pal_category: "sedentary" }).data;
  assert.equal(d.deficit_plan, null);
  assert.ok(d.maintenance.kcal > 0);
  assert.match(d.warnings.join(" "), /not advised/);
});

test("loss plan: supplement flag under 1200 kcal for women, and a supplied maintenance", () => {
  const d = computeLossPlan({ sex: "female", age_years: 40, weight_kg: 85, height_cm: 165, maintenance_kcal: 1700, deficit_kcal: 500 }).data;
  assert.equal(d.deficit_plan.intake_kcal, 1200);
  assert.equal(d.deficit_plan.supplement.recommended, false); // not below 1200
  const low = computeLossPlan({ sex: "female", age_years: 40, weight_kg: 85, height_cm: 165, maintenance_kcal: 1650, deficit_kcal: 500 }).data;
  assert.equal(low.deficit_plan.supplement.recommended, true);
  assert.match(low.maintenance_at_goal.note, /maintenance_kcal was supplied/);
  const men = computeLossPlan({ sex: "male", age_years: 40, weight_kg: 100, height_cm: 175, maintenance_kcal: 2200, deficit_kcal: 500 }).data; // 1700
  assert.equal(men.deficit_plan.supplement.recommended, true); // 1800 printed threshold for men
});

test("gain plan: the chapter's 2400 kcal example gives 2900 to 3400", () => {
  const d = computeGainPlan({ sex: "male", age_years: 30, weight_kg: 50, height_cm: 175, maintenance_kcal: 2400 }).data;
  assert.equal(d.energy.start_kcal, 2900);
  assert.equal(d.energy.goal_kcal, 3400);
  assert.deepEqual(d.expected_rate.lb_per_week, { min: 1, max: 2 });
  assert.equal(d.target_range.lowest_weight_kg, 56.7); // BMI 18.5 at 175 cm
  assert.equal(d.macronutrients.levels[0].protein_g.min, 87); // 12% of 2900 / 4
  assert.equal(d.macronutrients.levels[0].fat_g, 97); // 30% of 2900 / 9
  assert.equal(d.energy_boosters.length, 5);
  assert.equal(d.bmi_class.id, "underweight");
  assert.match(d.warnings.join(" "), /Assess the cause/);
});

test("gain plan: older adult target, target check, severe thinness, refusals", () => {
  const old = computeGainPlan({ sex: "female", age_years: 75, weight_kg: 52, height_cm: 160, maintenance_kcal: 1700, surplus_kcal: 500 }).data; // BMI 20.3
  assert.equal(old.target_range.lowest_bmi, 23);
  assert.equal(old.energy.goal_kcal, null);
  assert.equal(computeGainPlan({ sex: "male", age_years: 30, weight_kg: 48, height_cm: 175, maintenance_kcal: 2200, target_weight_kg: 60 }).data.target_check.gain_kg, 12);
  assert.match(computeGainPlan({ sex: "male", age_years: 30, weight_kg: 45, height_cm: 175, maintenance_kcal: 2000 }).data.warnings.join(" "), /below 16/);
  assert.equal(computeGainPlan({ sex: "male", age_years: 30, weight_kg: 85, height_cm: 175, maintenance_kcal: 2600 }).ok, false); // BMI 27.8
  assert.equal(computeGainPlan({ sex: "male", age_years: 30, weight_kg: 50, height_cm: 175, maintenance_kcal: 2400, target_weight_kg: 90 }).ok, false);
  assert.equal(computeGainPlan({ sex: "male", age_years: 15, weight_kg: 45, height_cm: 170, maintenance_kcal: 2400 }).ok, false);
  assert.equal(computeGainPlan({ sex: "male", age_years: 30, weight_kg: 50, height_cm: 175 }).ok, false); // underweight needs an activity input or maintenance
});

test("gain plan: an underweight adult can use activity_factor with the engine's REE", () => {
  const d = computeGainPlan({ sex: "female", age_years: 30, weight_kg: 46, height_cm: 168, activity_factor: "moderate" });
  assert.equal(d.ok, true);
  assert.equal(d.data.maintenance.source, "POST /energy/requirements (chapter 2 engine)");
});

test("energy boosters: item sums match Table 21.12 totals (two printed totals are a little off)", () => {
  const off = ENERGY_BOOSTERS.filter((b) => b.kcal_sum !== b.printed_total.kcal || b.protein_g_sum !== b.printed_total.protein_g).map((b) => `${b.tier_kcal}${b.option}`);
  assert.deepEqual(off, ["1500B"]); // items add to 1532 kcal and 41 g; the table prints 1530 and 40 (the +500 B banana row prints 8 g, which the printed total uses)
});

test("progress: loss within the guideline, milestones, and no plateau", () => {
  const wi = [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-02-01", weight_kg: 98.8 }, { date: "2026-03-01", weight_kg: 97.4 }, { date: "2026-04-01", weight_kg: 96 }];
  const d = computeWeightProgress({ goal: "loss", weigh_ins: wi, height_cm: 170, target_weight_kg: 85 }).data; // BMI 34.6 -> 0.5-1 lb/week
  assert.equal(d.summary.change_percent_of_start, -4);
  assert.equal(d.loss.milestones[0].reached, false);
  assert.equal(d.loss.average_rate_status, "within_guideline"); // 4 kg over 12.9 weeks = 0.68 lb/week, inside 0.5-1
});

test("progress: too fast, too slow, plateau, target", () => {
  const fast = computeWeightProgress({ goal: "loss", height_cm: 170, weigh_ins: [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-01-29", weight_kg: 92 }] }).data;
  assert.equal(fast.loss.average_rate_status, "faster_than_guideline");
  const flat = computeWeightProgress({ goal: "loss", height_cm: 170, weigh_ins: [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-02-01", weight_kg: 95 }, { date: "2026-03-01", weight_kg: 94.8 }, { date: "2026-03-29", weight_kg: 94.8 }] });
  assert.equal(flat.data.loss.plateau.suspected, true);
  assert.match(flat.data.notes.join(" "), /Possible plateau/);
  const none = computeWeightProgress({ goal: "loss", weigh_ins: [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-01-20", weight_kg: 101 }] }).data;
  assert.equal(none.loss.average_rate_status, "no_loss_or_gain");
  const t = computeWeightProgress({ goal: "loss", height_cm: 170, target_weight_kg: 90, weigh_ins: [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-02-05", weight_kg: 96 }] }).data.loss.target;
  assert.equal(t.kg_to_go, 6);
  assert.equal(t.percent_of_planned_loss_done, 40);
});

test("progress: gain, maintain (National Weight Control Registry), and unplanned loss", () => {
  const g = computeWeightProgress({ goal: "gain", weigh_ins: [{ date: "2026-01-01", weight_kg: 50 }, { date: "2026-01-29", weight_kg: 52.5 }] }).data; // 2.5 kg / 4 wk = 1.38 lb/wk
  assert.equal(g.gain.average_rate_status, "within_expected");
  const m = computeWeightProgress({ goal: "maintain", weight_before_loss_kg: 100, weigh_ins: [{ date: "2025-01-01", weight_kg: 88 }, { date: "2026-02-01", weight_kg: 89 }] }).data.maintenance;
  assert.equal(m.nwcr_criteria.kept_off_at_least_10_percent, true);
  assert.equal(m.nwcr_criteria.at_least_a_year, true);
  assert.equal(m.nwcr_criteria.met, true);
  const un = computeWeightProgress({ goal: "gain", weigh_ins: [{ date: "2026-01-01", weight_kg: 60 }, { date: "2026-01-29", weight_kg: 55 }] }).data;
  assert.ok(un.unintentional_loss.significance);
  assert.match(un.warnings.join(" ") + un.gain.average_rate_status, /no_gain_or_loss/);
});

test("progress: validation", () => {
  const ok = [{ date: "2026-01-01", weight_kg: 100 }, { date: "2026-01-20", weight_kg: 99 }];
  assert.equal(computeWeightProgress({ goal: "x", weigh_ins: ok }).ok, false);
  assert.equal(computeWeightProgress({ goal: "loss", weigh_ins: [ok[0]] }).ok, false);
  assert.equal(computeWeightProgress({ goal: "loss", weigh_ins: [ok[0], { date: "2026-01-03", weight_kg: 99 }] }).ok, false); // under 7 days
  assert.equal(computeWeightProgress({ goal: "loss", weigh_ins: [ok[0], { date: "2026-13-40", weight_kg: 99 }] }).ok, false);
  assert.equal(computeWeightProgress({ goal: "loss", weigh_ins: [ok[0], ok[0]] }).ok, false); // same date
  assert.equal(computeWeightProgress({ goal: "loss", weigh_ins: [ok[0], { date: "2026-01-20", weight_kg: 9 }] }).ok, false);
});

test("diet pattern: balanced, ketogenic, very low fat, alcohol and protein per kg", () => {
  const bal = computeDietPattern({ carbohydrate_g: 200, protein_g: 90, fat_g: 55, weight_kg: 75, energy_restriction: true }).data; // 1655 kcal: 48/22/30
  assert.deepEqual(bal.pattern_tags, ["balanced_within_amdr"]);
  assert.equal(bal.protein.g_per_kg, 1.2);
  assert.equal(bal.protein.status, "meets");
  const keto = computeDietPattern({ carbohydrate_g: 30, protein_g: 100, fat_g: 140 }).data;
  assert.ok(keto.pattern_tags.includes("ketogenic_range"));
  assert.ok(keto.nutrients_at_risk.includes("magnesium"));
  assert.ok(keto.metabolic_effects.some((m) => /uric acid/.test(m)));
  assert.match(keto.notes.join(" "), /60% or more water/);
  const vlf = computeDietPattern({ carbohydrate_g: 300, protein_g: 80, fat_g: 15 }).data;
  assert.ok(vlf.pattern_tags.includes("very_low_fat"));
  assert.ok(vlf.nutrients_at_risk.includes("zinc"));
  const zone = computeDietPattern({ carbohydrate_g: 160, protein_g: 125, fat_g: 55 }).data; // about 39/31/30
  assert.ok(zone.pattern_tags.includes("high_protein_low_carbohydrate_pattern"));
  const alc = computeDietPattern({ carbohydrate_g: 180, protein_g: 80, fat_g: 50, alcohol_g: 60 }).data; // 420 kcal of 1910
  assert.match(alc.warnings.join(" "), /10% or more of energy/);
  const low = computeDietPattern({ carbohydrate_g: 100, protein_g: 40, fat_g: 40, weight_kg: 80, energy_restriction: true }).data;
  assert.equal(low.protein.status, "below");
  assert.match(low.warnings.join(" "), /below the 1.2 g\/kg/);
  assert.equal(computeDietPattern({}).ok, false);
});

test("diet pattern: children use the chapter's ranges and show the DRI beside them", () => {
  const d = computeDietPattern({ carbohydrate_g: 220, protein_g: 60, fat_g: 55, age_years: 10 }).data;
  assert.deepEqual(d.compare_with_ranges.carbohydrate.range, { min: 45, max: 60 });
  assert.ok(d.compare_with_ranges.dri_amdr_for_age_shown_beside);
});

test("bariatric: procedure-specific supplements and the misprints flagged, not corrected", () => {
  const byp = computeBariatricGuidance({ procedure: "rygb", sex: "female", childbearing_age: "true" }).data;
  assert.equal(byp.diet_progression.length, 5);
  const find = (d, n) => d.supplements.find((s) => s.nutrient === n);
  assert.match(find(byp, "Folate (folic acid)").recommendation, /800 to 1000/);
  assert.match(find(byp, "Calcium").recommendation, /1200 to 1500/);
  assert.equal(find(byp, "Vitamin A and K").vitamin_a.suspect, true);
  assert.equal(find(byp, "Vitamin A and K").vitamin_a.as_printed, "5000-1000 IU");
  assert.equal(find(byp, "Vitamin D").target.suspect, true);
  const bpd = computeBariatricGuidance({ procedure: "bpd-ds" }).data;
  assert.match(find(bpd, "Calcium").recommendation, /1800 to 2400/);
  assert.equal(find(bpd, "Zinc").amount.as_printed, "1622 mg/d");
  assert.match(find(bpd, "Copper").recommendation, /2 mg/);
  assert.equal(bpd.diet_progression, null);
  const lagbM = computeBariatricGuidance({ procedure: "lagb", sex: "male" }).data;
  assert.match(find(lagbM, "Iron").recommendation, /18 mg/);
  assert.match(find(computeBariatricGuidance({ procedure: "lagb", sex: "female" }).data, "Iron").recommendation, /not covered/);
  assert.match(computeBariatricGuidance({ procedure: "rygb", pregnant: true }).data.warnings.join(" "), /vitamins A and K/);
  assert.equal(computeBariatricGuidance({ procedure: "nope" }).ok, false);
  assert.equal(computeBariatricGuidance({}).ok, false);
});

test("reference: every section works, unknown section is an error, known issues are listed", () => {
  const all = weightReferenceCatalog();
  assert.equal(all.ok, true);
  for (const id of REFERENCE_SECTION_IDS) assert.ok(all.data[id], id);
  assert.equal(weightReferenceCatalog("rates").data.rates.kcal_per_lb_fat, 3500);
  assert.equal(weightReferenceCatalog("nope").ok, false);
  assert.ok(KNOWN_ISSUES.length >= 10);
  assert.ok(all.data.related_endpoints.some((e) => e.includes("/energy/requirements")));
});
