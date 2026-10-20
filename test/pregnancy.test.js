import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGestationalAge, computePregnancyWeightGain, computePregnancyPlan, computePregnancyAssessment, pregnancyReferenceCatalog,
  prepregnancyCategory, REFERENCE_SECTION_IDS, KNOWN_ISSUES, TWINS_TABLE, LAB_RANGES,
} from "../src/pregnancy.js";

const ctx = { today: "2026-10-20" };
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("gestational age: from LMP, due date and weeks agree with each other", () => {
  const a = computeGestationalAge({ lmp: "2026-04-01" }, ctx).data;
  assert.equal(a.gestational_age.display, "28w6d");
  assert.equal(a.edd, "2027-01-06"); // LMP + 280 days
  assert.equal(a.trimester, 3);
  const b = computeGestationalAge({ edd: "2027-01-06" }, ctx).data;
  assert.equal(b.lmp, "2026-04-01");
  assert.equal(b.gestational_age.total_days, 202);
  const c = computeGestationalAge({ ga_weeks: 28, ga_days: 6 }, ctx).data;
  assert.equal(c.lmp, "2026-04-01");
  assert.equal(c.edd, "2027-01-06");
  assert.equal(computeGestationalAge({ lmp: "2026-04-01", reference_date: "2026-06-10" }).data.gestational_age.display, "10w0d");
});

test("gestational age: trimester boundaries and milestones", () => {
  const at = (w, d = 0) => computeGestationalAge({ ga_weeks: w, ga_days: d }, ctx).data;
  assert.equal(at(13, 6).trimester, 1);
  assert.equal(at(14, 0).trimester, 2);
  assert.equal(at(27, 6).trimester, 2);
  assert.equal(at(28, 0).trimester, 3);
  assert.equal(at(19, 6).milestones.protein_phase, "first_half");
  assert.equal(at(20, 0).milestones.protein_phase, "second_half");
  assert.equal(at(23, 0).milestones.gdm_screening_window.status, "not_yet");
  assert.equal(at(26, 0).milestones.gdm_screening_window.status, "in_window");
  assert.equal(at(30, 0).milestones.gdm_screening_window.status, "past");
  assert.equal(at(19, 0).milestones.preeclampsia_criteria_apply, false);
  assert.equal(at(20, 0).milestones.preeclampsia_criteria_apply, true);
  assert.match(at(10).notes.join(" "), /not from the chapter/);
  assert.match(at(43).warnings.join(" "), /post-term/);
});

test("gestational age: validation", () => {
  assert.equal(computeGestationalAge({}, ctx).ok, false);
  assert.equal(computeGestationalAge({ lmp: "2026-04-01", edd: "2027-01-06" }, ctx).ok, false); // two inputs
  assert.equal(computeGestationalAge({ lmp: "2026-13-01" }, ctx).ok, false);
  assert.equal(computeGestationalAge({ lmp: "2026-12-01" }, ctx).ok, false); // after the reference date
  assert.equal(computeGestationalAge({ lmp: "2025-01-01" }, ctx).ok, false); // over 45 weeks
  assert.equal(computeGestationalAge({ ga_weeks: 12.5 }, ctx).ok, false);
  assert.equal(computeGestationalAge({ ga_weeks: 12, ga_days: 7 }, ctx).ok, false);
  assert.equal(computeGestationalAge({ lmp: "2026-04-01" }).ok, false); // no reference date available
  assert.equal(computeGestationalAge(null, ctx).ok, false);
});

// Appendix 3, prenatal weight category table (inches and pounds): [inches, underweight up to, normal min, normal max, overweight min, overweight max, obese from]
const APPENDIX_3 = [
  [54, 76, 77, 103, 104, 123, 124], [55, 79, 80, 107, 108, 128, 129], [56, 82, 83, 111, 112, 133, 134], [57, 84, 85, 115, 116, 138, 139], [58, 88, 89, 119, 120, 143, 144],
  [59, 91, 92, 123, 124, 148, 149], [60, 94, 95, 127, 128, 153, 154], [61, 97, 98, 131, 132, 158, 159], [62, 100, 101, 136, 137, 163, 164], [63, 103, 104, 140, 141, 168, 169],
  [64, 107, 108, 145, 146, 174, 175], [65, 110, 111, 149, 150, 179, 180], [66, 114, 115, 154, 155, 185, 186], [67, 117, 118, 159, 160, 191, 192], [68, 121, 122, 163, 164, 196, 197],
  [69, 124, 125, 168, 169, 202, 203], [70, 128, 129, 173, 174, 208, 209], [71, 132, 133, 178, 179, 214, 215], [72, 135, 136, 183, 184, 220, 221], [73, 139, 140, 189, 190, 226, 227], [74, 143, 144, 194, 195, 233, 234],
];
test("Appendix 3: the printed height/weight rows agree with the BMI bands (edge weights can differ by up to about 1.5 lb)", () => {
  for (const [inch, uw, nmin, nmax, omin, omax, ob] of APPENDIX_3) {
    const at = (bmi) => (bmi * inch * inch) / 703;
    for (const [bmi, printed] of [[18.5, uw], [18.5, nmin], [24.9, nmax], [25, omin], [29.9, omax], [30, ob]]) near(at(bmi), printed, 1.6);
    const cat = (lbs) => prepregnancyCategory((lbs * 703) / (inch * inch));
    assert.equal(cat(uw - 2), "underweight");
    assert.equal(cat(nmin + 2), "normal");
    assert.equal(cat(nmax - 2), "normal");
    assert.equal(cat(omin + 2), "overweight");
    assert.equal(cat(omax - 2), "overweight");
    assert.equal(cat(ob + 2), "obese");
  }
});

test("Appendix 3 (metric) and the weight-gain categories for a 162.6 cm woman", () => {
  const cat = (kg) => computePregnancyWeightGain({ pre_pregnancy_weight_kg: kg, height_cm: 162.6 }).data.prepregnancy_category.id;
  assert.equal(cat(48), "underweight"); // table: normal starts at 48.9
  assert.equal(cat(49.5), "normal");
  assert.equal(cat(65), "normal"); // table: normal to 65.9
  assert.equal(cat(67), "overweight"); // 66.0 to 79.2
  assert.equal(cat(78), "overweight");
  assert.equal(cat(81), "obese");
  const t = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 70, height_cm: 162.6 }).data;
  near(t.inputs_used.bmi, 26.5, 0.05);
});

test("weight gain: Table 14.11 totals and weekly rates for every category", () => {
  const f = (kg, h = 165) => computePregnancyWeightGain({ pre_pregnancy_weight_kg: kg, height_cm: h }).data;
  const uw = f(48); assert.deepEqual(uw.total_gain.kg, { min: 12.5, max: 18 }); assert.deepEqual(uw.total_gain.lb, { min: 28, max: 40 }); assert.deepEqual(uw.weekly_rate_2nd_3rd_trimester.kg, { min: 0.44, max: 0.58 });
  const nm = f(60); assert.deepEqual(nm.total_gain.kg, { min: 11.5, max: 16 }); assert.deepEqual(nm.weekly_rate_2nd_3rd_trimester.lb, { min: 0.8, max: 1 }); assert.deepEqual(nm.first_trimester_allowance.kg, { min: 1, max: 3 });
  const ow = f(75); assert.deepEqual(ow.total_gain.kg, { min: 7, max: 11.5 }); assert.deepEqual(ow.weekly_rate_2nd_3rd_trimester.kg, { min: 0.23, max: 0.33 });
  const ob = f(95); assert.deepEqual(ob.total_gain.kg, { min: 5, max: 9 }); assert.deepEqual(ob.weekly_rate_2nd_3rd_trimester.lb, { min: 0.4, max: 0.6 }); assert.deepEqual(ob.first_trimester_allowance.kg, { min: 0.5, max: 2 });
});

test("weight gain: twins, triplets, quads and the underweight twin gap", () => {
  const tw = (kg, m = 2) => computePregnancyWeightGain({ pre_pregnancy_weight_kg: kg, height_cm: 165, multiples: m });
  assert.deepEqual(tw(60).data.total_gain.kg, { min: 17, max: 25 });
  assert.deepEqual(tw(75).data.total_gain.lb, { min: 31, max: 50 });
  assert.deepEqual(tw(95).data.total_gain.kg, { min: 11, max: 19 });
  assert.equal(tw(48).data.total_gain, null);
  assert.match(tw(48).data.notes.join(" "), /insufficient/);
  assert.match(tw(60, 3).data.multiples_note, /36 pounds/);
  assert.match(tw(60, 4).data.multiples_note, /quadruplets/);
  assert.equal(tw(60, 5).ok, false);
});

test("weight gain: status at a gestational age (approximate straight line) and early pregnancy", () => {
  const base = { pre_pregnancy_weight_kg: 60, height_cm: 165, lmp: "2026-04-01" }; // 28w6d on the test date
  const at = (kg) => computePregnancyWeightGain({ ...base, current_weight_kg: kg }, ctx).data.current;
  near(at(70).expected_kg.min, 7.2, 0.1); near(at(70).expected_kg.max, 10.6, 0.1);
  assert.equal(at(66).status, "below"); // 6 kg
  assert.equal(at(69).status, "within"); // 9 kg
  assert.equal(at(75).status, "above"); // 15 kg
  const early = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, lmp: "2026-08-20", current_weight_kg: 66 }, ctx).data.current; // 9w, gain 6 kg
  assert.equal(early.status, "above_first_trimester_allowance");
  const ok = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, lmp: "2026-08-20", current_weight_kg: 61.5 }, ctx).data.current;
  assert.equal(ok.status, "within_or_below_first_trimester_allowance");
  const obeseTri1 = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 95, height_cm: 165, lmp: "2026-08-20", current_weight_kg: 98 }, ctx).data.current;
  assert.equal(obeseTri1.status, "above_first_trimester_allowance"); // 3 kg over the 0.5-2 kg allowance
  assert.match(computePregnancyWeightGain({ ...base, current_weight_kg: 75 }, ctx).data.warnings.join(" "), /large-for-gestational-age/);
  assert.match(computePregnancyWeightGain({ ...base, current_weight_kg: 66 }, ctx).data.warnings.join(" "), /small-for-gestational-age/);
});

test("weight gain: the expected range meets the printed totals at 40 weeks", () => {
  const d = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, ga_weeks: 40, current_weight_kg: 72 }, ctx).data.current;
  assert.deepEqual(d.expected_kg, { min: 11.5, max: 16 });
  assert.equal(d.status, "within"); // 12 kg
});

test("weight gain: weigh-in series and recent rate", () => {
  const d = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, lmp: "2026-03-01", weigh_ins: [{ date: "2026-06-14", weight_kg: 63 }, { date: "2026-07-12", weight_kg: 66.2 }, { date: "2026-08-09", weight_kg: 69.8 }] }, ctx).data;
  assert.equal(d.series.length, 3);
  assert.equal(d.series[0].gestational_weeks, 15);
  assert.equal(d.recent_rate.kg_per_week, 0.9); // 3.6 kg over 4 weeks, above the 0.35-0.5 band
  assert.equal(d.recent_rate.status, "above");
  assert.equal(computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, weigh_ins: [{ date: "2026-06-14", weight_kg: 63 }] }, ctx).ok, false); // needs lmp or edd
  assert.equal(computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, lmp: "2026-03-01", weigh_ins: [{ date: "2025-01-01", weight_kg: 63 }] }, ctx).ok, false);
});

test("weight gain: adolescent, BMI input and validation", () => {
  const teen = computePregnancyWeightGain({ pre_pregnancy_weight_kg: 50, height_cm: 160, age_years: 16 }).data;
  assert.ok(teen.adolescent_risk_factors.length > 5);
  assert.equal(computePregnancyWeightGain({ prepregnancy_bmi: 27 }).data.prepregnancy_category.id, "overweight");
  assert.equal(computePregnancyWeightGain({ prepregnancy_bmi: 27, pre_pregnancy_weight_kg: 60 }).ok, false);
  assert.equal(computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60 }).ok, false); // no height
  assert.equal(computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, current_weight_kg: 62 }, ctx).ok, false); // no gestational age
  assert.equal(computePregnancyWeightGain({ current_weight_kg: 62, prepregnancy_bmi: 22, lmp: "2026-04-01" }, ctx).ok, false); // needs the pre-pregnancy weight
  assert.equal(computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 165, multiples: 1.5 }).ok, false);
  assert.equal(prepregnancyCategory(18.49), "underweight"); assert.equal(prepregnancyCategory(24.99), "normal"); assert.equal(prepregnancyCategory(29.99), "overweight"); assert.equal(prepregnancyCategory(30), "obese");
});

const PLAN = { status: "pregnant", age_years: 28, pre_pregnancy_weight_kg: 60, height_cm: 162, pal_category: "low_active" };
test("plan: the engine's chapter add-ons by trimester (0, +340, +452)", () => {
  const e = (lmp) => computePregnancyPlan({ ...PLAN, lmp }, ctx).data.energy;
  const t1 = e("2026-08-20"), t2 = e("2026-06-01"), t3 = e("2026-04-01");
  assert.equal(t1.add_on_kcal, 0); assert.equal(t2.add_on_kcal, 340); assert.equal(t3.add_on_kcal, 452);
  assert.equal(t2.kcal - t1.kcal, 340); assert.equal(t3.kcal - t1.kcal, 452);
  assert.equal(t3.estimate_id, "eer_women_19");
  assert.match(t3.source, /energy\/requirements/);
  assert.match(computePregnancyPlan({ ...PLAN, lmp: "2026-08-20" }, ctx).data.notes.join(" "), /first trimester/);
});

test("plan: protein 0.8 g/kg before 20 weeks and 1.1 g/kg after, on current weight", () => {
  const early = computePregnancyPlan({ ...PLAN, lmp: "2026-07-01", current_weight_kg: 62 }, ctx).data.protein; // 16w
  assert.equal(early.g_per_kg, 0.8); assert.equal(early.grams, 50);
  const late = computePregnancyPlan({ ...PLAN, lmp: "2026-04-01", current_weight_kg: 66 }, ctx).data.protein; // 28w6d
  assert.equal(late.g_per_kg, 1.1); assert.equal(late.grams, 73); assert.equal(late.basis, "current weight"); assert.equal(late.dri_reference_woman_g, 71);
  assert.match(computePregnancyPlan({ ...PLAN, lmp: "2026-04-01" }, ctx).data.protein.basis, /pre-pregnancy/);
});

test("plan: DRI pregnancy targets and percent of the non-pregnant value", () => {
  const d = computePregnancyPlan({ ...PLAN, lmp: "2026-04-01" }, ctx).data.dri_targets;
  assert.equal(d.stage.code, "pregnancy_19_30");
  const row = (k) => d.rows.find((r) => r.key === k);
  assert.equal(row("iron_mg").rda, 27); assert.equal(row("folate_mcg").rda, 600);
  assert.equal(row("iron_mg").percent_of_nonpregnant, 150); // 27 / 18
  assert.equal(row("calcium_mg").rda, 1000);
  const teen = computePregnancyPlan({ ...PLAN, age_years: 16, lmp: "2026-04-01" }, ctx).data;
  assert.equal(teen.dri_targets.rows.find((r) => r.key === "calcium_mg").rda, 1300);
  assert.ok(teen.adolescent_risk_factors.length > 5);
});

test("plan: supplied maintenance, twins, triplets and refusals", () => {
  const m = computePregnancyPlan({ status: "pregnant", age_years: 28, pre_pregnancy_weight_kg: 60, height_cm: 162, maintenance_kcal: 2100, lmp: "2026-04-01" }, ctx).data.energy;
  assert.equal(m.kcal, 2552); assert.equal(m.add_on_kcal, 452);
  const tw = computePregnancyPlan({ ...PLAN, lmp: "2026-04-01", multiples: 2, current_weight_kg: 66 }, ctx).data;
  assert.deepEqual(tw.twins.energy_kcal, { min: 3000, max: 3500 });
  assert.equal(tw.twins.protein_g, 175); assert.equal(tw.twins.carbohydrate_g, 350); assert.equal(tw.twins.fat_g, 156);
  assert.deepEqual(tw.twins.per_kg_estimate.kcal, { min: 2640, max: 2970 }); // 40-45 x 66
  assert.ok(tw.energy.singleton_estimate_not_for_multiples);
  assert.deepEqual(computePregnancyWeightGain({ pre_pregnancy_weight_kg: 60, height_cm: 162, multiples: 2 }).data.total_gain.kg, tw.weight_gain_goal.total_gain.kg);
  assert.match(computePregnancyPlan({ ...PLAN, lmp: "2026-04-01", multiples: 3 }, ctx).data.multiples_note, /triplets/);
  assert.equal(computePregnancyPlan({ ...PLAN, age_years: 12, lmp: "2026-04-01" }, ctx).ok, false);
  assert.equal(computePregnancyPlan({ ...PLAN }, ctx).ok, false); // no gestational age
  assert.equal(computePregnancyPlan({ status: "x" }, ctx).ok, false);
  assert.equal(computePregnancyPlan({ ...PLAN, pal_category: undefined, lmp: "2026-04-01" }, ctx).ok, false); // no activity input
});

test("plan: weight-gain goal rides along with the current weight", () => {
  const d = computePregnancyPlan({ ...PLAN, lmp: "2026-04-01", current_weight_kg: 75 }, ctx).data;
  assert.equal(d.weight_gain_goal.current.status, "above");
});

test("lactation: +330 then +400, the 1800 kcal floor and the weight-loss rule", () => {
  const L = (m, extra = {}) => computePregnancyPlan({ status: "lactating", age_years: 28, pre_pregnancy_weight_kg: 60, height_cm: 162, pal_category: "low_active", months_postpartum: m, ...extra }, ctx).data;
  assert.equal(L(3).energy.add_on_kcal, 330); assert.equal(L(9).energy.add_on_kcal, 400);
  assert.equal(L(9).energy.kcal - L(3).energy.kcal, 70);
  assert.equal(L(3).energy.minimum_kcal, 1800);
  assert.equal(L(1).weight_loss.loss_may_be_considered, false); assert.equal(L(3).weight_loss.loss_may_be_considered, true);
  assert.equal(L(3).protein.additional_g, 25);
  assert.equal(L(3).dri_targets.stage.code, "lactation_19_30");
  const low = L(3, { maintenance_kcal: 1300, pal_category: undefined });
  assert.match(low.warnings.join(" "), /below 1800/);
  assert.equal(computePregnancyPlan({ status: "lactating", age_years: 28, pre_pregnancy_weight_kg: 60, height_cm: 162, pal_category: "low_active" }, ctx).ok, false); // months required
});

test("assess: anemia cut-points by trimester, altitude and smoking", () => {
  const a = (extra) => computePregnancyAssessment({ lmp: "2026-04-01", ...extra }, ctx).data.sections.anemia;
  assert.equal(a({ hemoglobin_g_dl: 10.9 }).hemoglobin.status, "anemia"); // T3 cut-point 11.0
  assert.equal(a({ hemoglobin_g_dl: 11.0 }).hemoglobin.status, "not_anemic");
  assert.equal(a({ hematocrit_percent: 32.9 }).hematocrit.status, "anemia"); // T3 33.0
  const t2 = computePregnancyAssessment({ lmp: "2026-06-01", hemoglobin_g_dl: 10.6 }, ctx).data.sections.anemia; // T2 cut-point 10.5
  assert.equal(t2.hemoglobin.status, "not_anemic");
  const alt = a({ hemoglobin_g_dl: 11.4, altitude_m: 1500 }); // 4921 ft -> +0.3 -> 11.3? 1500 m = 4921 ft (4000-4999: +0.3)
  assert.equal(alt.hemoglobin.adjusted_cutpoint_g_dl, 11.3);
  assert.equal(alt.hemoglobin.status, "not_anemic");
  assert.equal(a({ hemoglobin_g_dl: 11.9, altitude_m: 2000 }).hemoglobin.status, "not_anemic"); // 6562 ft: cut-point 11.7 to 11.8
  const range = a({ hemoglobin_g_dl: 11.75, altitude_m: 2000 }).hemoglobin; // cut-point 11.7 to 11.8
  assert.equal(range.status, "borderline_altitude_adjustment_is_a_range");
  assert.equal(a({ hematocrit_percent: 38, altitude_m: 3500 }).hematocrit.adjusted_cutpoint_percent, 41); // 33 + 8
  const smoke = a({ hemoglobin_g_dl: 11.2, cigarettes_per_day: 20 }); // 1 pack: +0.5 -> 11.5
  assert.equal(smoke.hemoglobin.adjusted_cutpoint_g_dl, 11.5); assert.equal(smoke.hemoglobin.status, "anemia");
  assert.equal(computePregnancyAssessment({ hemoglobin_g_dl: 10 }, ctx).data.errors.anemia.includes("trimester"), true);
  assert.equal(computePregnancyAssessment({ trimester: 1, hemoglobin_g_dl: 10.9 }, ctx).data.sections.anemia.hemoglobin.status, "anemia");
});

test("assess: Table 14.4 labs by trimester", () => {
  const l = (labs, extra = { lmp: "2026-04-01" }) => computePregnancyAssessment({ ...extra, labs }, ctx).data.sections.labs.results;
  const alb = l({ albumin_g_dl: 2.2 })[0]; assert.equal(alb.status_for_trimester, "below"); assert.deepEqual(alb.trimester_range, { min: 2.3, max: 4.2 }); // T3
  assert.equal(l({ albumin_g_dl: 3.0 })[0].status_for_trimester, "within"); assert.equal(l({ albumin_g_dl: 3.0 })[0].status_vs_nonpregnant, "below"); // normal for pregnancy
  assert.equal(l({ triglycerides_mg_dl: 300 })[0].status_for_trimester, "within");
  assert.equal(l({ cholesterol_mg_dl: 360 })[0].status_for_trimester, "above");
  assert.equal(l({ vitamin_c_mg_dl: 1 }, { trimester: 1 })[0].trimester_range, null); // not printed for T1
  assert.match(l({ vitamin_c_mg_dl: 1 }, { trimester: 1 })[0].note, /No range/);
  assert.equal(Object.keys(LAB_RANGES).length, 18);
  assert.match(computePregnancyAssessment({ lmp: "2026-04-01", labs: { nope: 1 } }, ctx).data.errors.labs, /unknown lab/);
  const none = computePregnancyAssessment({ labs: { albumin_g_dl: 3 } }, ctx).data;
  assert.equal(none.sections.labs.results[0].status_for_trimester, null);
  assert.match(none.notes.join(" "), /No gestational age/);
});

test("assess: GDM glucose tests (Table 14.14)", () => {
  const g = (glucose, extra = { lmp: "2026-04-01" }) => computePregnancyAssessment({ ...extra, glucose }, ctx).data.sections.glucose;
  const s = g({ test: "screen_50g", one_hour_mg_dl: 135 });
  assert.deepEqual(s.thresholds.map((t) => t.positive), [true, true, false]); assert.equal(s.result, "positive_at_some_cutpoints");
  assert.equal(g({ test: "screen_50g", one_hour_mg_dl: 125 }).result, "negative_at_all_cutpoints");
  assert.equal(g({ test: "screen_50g", one_hour_mg_dl: 150 }).result, "positive_at_all_cutpoints");
  const o = g({ test: "ogtt_100g", fasting_mg_dl: 96, one_hour_mg_dl: 185, two_hour_mg_dl: 150, three_hour_mg_dl: 130 }); // CC: fasting and 1h; NDDG: none
  assert.equal(o.carpenter_coustan.gdm, true); assert.equal(o.nddg.gdm, false); assert.equal(o.result, "gdm_criteria_met");
  assert.equal(g({ test: "ogtt_100g", fasting_mg_dl: 96, one_hour_mg_dl: 170, two_hour_mg_dl: 150, three_hour_mg_dl: 130 }).result, "gdm_criteria_not_met"); // only one value
  const t75 = g({ test: "ogtt_75g", fasting_mg_dl: 93, one_hour_mg_dl: 150, two_hour_mg_dl: 140 });
  assert.equal(t75.iadpsg.gdm, true); assert.equal(t75.who.gdm_or_above, true); assert.equal(t75.result, "gdm_criteria_met");
  assert.equal(g({ test: "ogtt_75g", fasting_mg_dl: 126, one_hour_mg_dl: 150, two_hour_mg_dl: 140 }).result, "diabetes_in_pregnancy_range"); // fasting above 125
  assert.equal(g({ test: "ogtt_75g", fasting_mg_dl: 85, one_hour_mg_dl: 150, two_hour_mg_dl: 200 }).result, "diabetes_in_pregnancy_range"); // 2 h 200
  assert.equal(g({ test: "ogtt_75g", fasting_mg_dl: 85, one_hour_mg_dl: 150, two_hour_mg_dl: 140 }).result, "gdm_criteria_not_met");
  assert.equal(g({ test: "random", random_mg_dl: 210, symptoms: true }).result, "diabetes_in_pregnancy_range");
  assert.equal(g({ test: "random", random_mg_dl: 210 }).result, "high_without_symptoms_needs_confirmation");
  assert.equal(g({ test: "screen_50g", one_hour_mg_dl: 150 }).screening_window.status, "in_window"); // 28w6d is still inside 24 to 28 weeks
  assert.equal(g({ test: "screen_50g", one_hour_mg_dl: 150 }, { ga_weeks: 30 }).screening_window.status, "past");
  assert.match(computePregnancyAssessment({ glucose: { test: "x" } }, ctx).data.errors.glucose, /required/);
  assert.match(computePregnancyAssessment({ glucose: { test: "screen_50g" } }, ctx).data.errors.glucose, /one_hour/);
});

test("assess: preeclampsia criteria (Box 14.4)", () => {
  const b = (bp, extra = { lmp: "2026-04-01" }) => computePregnancyAssessment({ ...extra, blood_pressure: bp }, ctx).data.sections.blood_pressure;
  assert.equal(b({ systolic_mmhg: 150, diastolic_mmhg: 95, bp_confirmed: true, urine_protein_24h_mg: 400 }).status, "preeclampsia_criteria_met");
  assert.equal(b({ systolic_mmhg: 150, diastolic_mmhg: 95, urine_protein_24h_mg: 400 }).status, "preeclampsia_criteria_possible_if_bp_confirmed");
  assert.equal(b({ systolic_mmhg: 150, diastolic_mmhg: 95, bp_confirmed: true }).status, "blood_pressure_criterion_met_without_proteinuria_or_organ_feature");
  assert.equal(b({ systolic_mmhg: 150, diastolic_mmhg: 95, bp_confirmed: true, protein_creatinine_ratio: 0.3 }).proteinuria_met, true);
  assert.equal(b({ systolic_mmhg: 150, diastolic_mmhg: 95, bp_confirmed: true, dipstick_plus: 2 }).proteinuria_met, true);
  const organ = b({ systolic_mmhg: 150, diastolic_mmhg: 95, bp_confirmed: true, labs: { platelets_per_ul: 90000 }, cerebral_or_visual_symptoms: true });
  assert.deepEqual(organ.new_onset_features, ["platelets under 100,000/µL", "cerebral or visual symptoms"]); assert.equal(organ.status, "preeclampsia_criteria_met");
  assert.equal(b({ systolic_mmhg: 118, diastolic_mmhg: 76 }).status, "blood_pressure_criterion_not_met");
  const early = b({ systolic_mmhg: 145, diastolic_mmhg: 92 }, { lmp: "2026-07-01" }); // 16 weeks
  assert.equal(early.status, "elevated_bp_before_20_weeks_or_gestation_unknown"); assert.equal(early.bp_criterion_met, false);
  assert.equal(b({ systolic_mmhg: 165, diastolic_mmhg: 100, bp_confirmed: true, dipstick_plus: 2 }, { lmp: "2026-07-01" }).status, "preeclampsia_criteria_met"); // severe range at any time
  const unknown = b({ systolic_mmhg: 145, diastolic_mmhg: 92 }, { trimester: 3 });
  assert.match(unknown.notes.join(" "), /Gestational age was not given/);
  assert.match(computePregnancyAssessment({ blood_pressure: { systolic_mmhg: 140 } }, ctx).data.errors.blood_pressure, /diastolic/);
});

test("assess: sections are independent, and validation", () => {
  const d = computePregnancyAssessment({ lmp: "2026-04-01", hemoglobin_g_dl: 10.2, glucose: { test: "x" }, blood_pressure: { systolic_mmhg: 118, diastolic_mmhg: 76 } }, ctx).data;
  assert.ok(d.sections.anemia && d.sections.blood_pressure); assert.ok(d.errors.glucose);
  assert.ok(d.not_assessed.some((n) => n.section === "labs"));
  assert.equal(computePregnancyAssessment({}, ctx).ok, false);
  assert.equal(computePregnancyAssessment({ trimester: 4, hemoglobin_g_dl: 10 }, ctx).ok, false);
  assert.equal(computePregnancyAssessment({ lmp: "2027-01-01", hemoglobin_g_dl: 10 }, ctx).ok, false);
  assert.equal(computePregnancyAssessment(null, ctx).ok, false);
});

test("reference: every section, known issues, twin table arithmetic", () => {
  const all = pregnancyReferenceCatalog();
  assert.equal(all.ok, true);
  for (const id of REFERENCE_SECTION_IDS) assert.ok(all.data[id], id);
  assert.equal(pregnancyReferenceCatalog("energy").data.energy.add_on_kcal_per_day.trimester_3, 452);
  assert.equal(pregnancyReferenceCatalog("nope").ok, false);
  assert.ok(KNOWN_ISSUES.length >= 9);
  // twin table: protein 20%, carbohydrate 40%, fat 40% of the upper energy figure
  for (const k of ["underweight", "normal", "overweight", "obese"]) {
    const kcal = TWINS_TABLE.energy_kcal[k][1];
    near(TWINS_TABLE.protein_g[k], (kcal * 0.2) / 4, 1); near(TWINS_TABLE.carbohydrate_g[k], (kcal * 0.4) / 4, 1); near(TWINS_TABLE.fat_g[k], (kcal * 0.4) / 9, 1);
  }
});
