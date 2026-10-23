// Dietary assessment: request parsing, unit mapping, DRI comparison, gaps, energy, macros, food groups. Pure functions, no database.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DRI_LIFE_STAGES } from "../src/dri_data.js";
import {
  parseAssessmentRequest, buildEnergyTarget, assessDiet, normalizeIntake, sumResolved, coverageOf,
  assessableNutrients, foodsColumnFor, dietaryAssessmentReference, MAX_DAYS, MAX_INGREDIENTS,
} from "../src/dietaryAssessment.js";

const stage = DRI_LIFE_STAGES.find((s) => s.code === "female_19_30");
const run = (days, extra = {}) => assessDiet({ stage, ageYears: 25, weightKg: 60, days, energy: null, coverage: null, ...extra });
const find = (data, key) => data.nutrients.find((n) => n.nutrient === key);

describe("normalizeIntake / sumResolved / coverageOf", () => {
  test("maps foods columns to DRI units and drops bad values", () => {
    const out = normalizeIntake({ copper_mg: 0.9, manganese_mcg: 2300, iron_mg: "8", zinc_mg: -1, bad: "x", energy_kcal: 1800 });
    assert.equal(out.copper_mcg, 900);
    assert.equal(out.manganese_mg, 2.3);
    assert.equal(out.iron_mg, 8);
    assert.equal(out.zinc_mg, undefined);
    assert.equal(out.bad, undefined);
    assert.equal(out.kcal, 1800);
    assert.equal(out.energy_kcal, undefined);
  });
  test("sums only fields someone has, and reports coverage per DRI key", () => {
    const resolved = [{ nutrients: { iron_mg: 2, copper_mg: 0.1 } }, { nutrients: { iron_mg: 3 } }, { nutrients: {} }];
    assert.deepEqual(sumResolved(resolved, ["iron_mg", "zinc_mg", "copper_mg"]), { iron_mg: 5, copper_mg: 0.1 });
    const cov = coverageOf(resolved, ["iron_mg", "copper_mg"]);
    assert.equal(cov.iron_mg, 67);
    assert.equal(cov.copper_mcg, 33);
    assert.equal(coverageOf([], ["iron_mg"]), null);
  });
  test("every assessable nutrient maps back to a foods column", () => {
    for (const k of assessableNutrients()) assert.ok(foodsColumnFor(k));
    assert.equal(foodsColumnFor("copper_mcg"), "copper_mg");
    assert.equal(foodsColumnFor("manganese_mg"), "manganese_mcg");
  });
});

describe("parseAssessmentRequest", () => {
  const ok = { age: 25, sex: "female", days: [{ ingredients: [{ food_name: "maize", quantity: 100 }] }] };
  test("accepts days, or one day at the top level", () => {
    const a = parseAssessmentRequest(ok);
    assert.equal(a.ok, true);
    assert.equal(a.data.stage.code, "female_19_30");
    assert.equal(a.data.days.length, 1);
    const b = parseAssessmentRequest({ age: 25, sex: "female", intake: { kcal: 1800 } });
    assert.equal(b.ok, true);
    assert.deepEqual(b.data.days[0].intake, { kcal: 1800 });
  });
  test("flattens meals", () => {
    const r = parseAssessmentRequest({ life_stage: "male_19_30", days: [{ date: "2026-10-20", meals: [{ meal_type: "lunch", ingredients: [{ food_name: "a", quantity: 1 }] }, { ingredients: [{ food_name: "b", quantity: 1 }] }] }] });
    assert.equal(r.data.days[0].items.length, 2);
    assert.equal(r.data.days[0].date, "2026-10-20");
  });
  test("rejects bad input with a clear message", () => {
    assert.match(parseAssessmentRequest(null).error, /JSON object/);
    assert.match(parseAssessmentRequest({ days: [] }).error, /life_stage|age/);
    assert.match(parseAssessmentRequest({ age: 25, sex: "female" }).error, /'days' is required/);
    assert.match(parseAssessmentRequest({ age: 25, sex: "female", days: [] }).error, /not be empty/);
    assert.match(parseAssessmentRequest({ ...ok, life_stage: "nope" }).error, /Unknown life_stage/);
    assert.match(parseAssessmentRequest({ age: 25, sex: "female", days: [{ date: "20/10/2026", intake: { kcal: 1 } }] }).error, /YYYY-MM-DD/);
    assert.match(parseAssessmentRequest({ age: 25, sex: "female", days: [{ ingredients: [], intake: { kcal: 1 } }] }).error, /exactly one/);
    assert.match(parseAssessmentRequest({ age: 25, sex: "female", days: [{ intake: { junk: "x" } }] }).error, /no numeric/);
    assert.match(parseAssessmentRequest({ ...ok, weight_kg: 900 }).error, /weight_kg/);
    assert.match(parseAssessmentRequest({ age: 25, sex: "female", days: Array(MAX_DAYS + 1).fill({ intake: { kcal: 1 } }) }).error, /At most/);
    const many = { age: 25, sex: "female", days: [{ ingredients: Array(MAX_INGREDIENTS + 1).fill({ food_name: "a", quantity: 1 }) }] };
    assert.match(parseAssessmentRequest(many).error, /ingredients per request/);
  });
});

describe("buildEnergyTarget", () => {
  test("uses the caller's target, or explains what is missing", () => {
    assert.deepEqual(buildEnergyTarget({ energyTargetKcal: 2100 }), { kcal: 2100, source: "supplied by the caller" });
    assert.match(buildEnergyTarget({ weightKg: null }).note, /weight_kg/);
    assert.match(buildEnergyTarget({ weightKg: 60, sex: null }).note, /sex/);
  });
  test("calculates the IOM EER from weight, height and PAL", () => {
    const t = buildEnergyTarget({ weightKg: 60, heightCm: 162, sex: "female", ageYears: 25, palCategory: "low_active", stage });
    assert.ok(t.kcal > 1800 && t.kcal < 2600, `kcal ${t.kcal}`);
    assert.match(t.source, /IOM/);
  });
  test("asks for a trimester when pregnant", () => {
    const preg = DRI_LIFE_STAGES.find((s) => s.code === "pregnancy_19_30");
    const t = buildEnergyTarget({ weightKg: 60, heightCm: 162, sex: "female", ageYears: 25, palCategory: "low_active", stage: preg });
    assert.match(t.note, /trimester/);
  });
});

describe("assessDiet", () => {
  test("classifies EAR/RDA nutrients: below EAR, borderline, adequate", () => {
    const r = run([{ date: null, totals: { iron_mg: 5, calcium_mg: 900, vitc_mg: 80 }, groups: null }]);
    assert.equal(r.ok, true);
    const iron = find(r.data, "iron_mg");   // EAR 8.1, RDA 18
    assert.equal(iron.status, "below_ear");
    assert.equal(iron.gap_level, "likely_inadequate");
    assert.equal(iron.target, 18);
    assert.equal(iron.percent_of_ear, 61.7);
    assert.equal(find(r.data, "calcium_mg").status, "between_ear_and_rda"); // EAR 800, RDA 1000
    assert.equal(find(r.data, "vitc_mg").status, "meets_rda");
    assert.ok(r.data.adequate_nutrients.includes("vitc_mg"));
  });
  test("AI nutrients are 'possibly low', not inadequate", () => {
    const r = run([{ totals: { fiber_g: 10, potassium_mg: 1000 }, groups: null }]);
    assert.equal(find(r.data, "fiber_g").status, "below_ai");
    assert.equal(find(r.data, "fiber_g").gap_level, "possibly_low");
    assert.equal(find(r.data, "potassium_mg").gap_level, "possibly_low");
    const ok = run([{ totals: { fiber_g: 40 }, groups: null }]);
    assert.equal(find(ok.data, "fiber_g").status, "meets_ai");
  });
  test("sodium is a limit and below the AI is not a gap", () => {
    const hi = run([{ totals: { sodium_mg: 3500 }, groups: null }]);
    assert.equal(find(hi.data, "sodium_mg").status, "above_cdrr");
    assert.equal(hi.data.excesses[0].nutrient, "sodium_mg");
    assert.equal(hi.data.summary.above_limit_count, 1);
    const lo = run([{ totals: { sodium_mg: 600 }, groups: null }]);
    assert.equal(find(lo.data, "sodium_mg").status, "within_cdrr");
    assert.equal(lo.data.gaps.length, 0);
  });
  test("flags the UL and explains when it only covers supplements", () => {
    const r = run([{ totals: { folate_mcg: 1500, zinc_mg: 50 }, groups: null }]);
    assert.equal(find(r.data, "zinc_mg").exceeds_ul, true);
    assert.equal(find(r.data, "folate_mcg").exceeds_ul, true);
    assert.match(find(r.data, "folate_mcg").notes.join(" "), /folic acid/);
    assert.equal(r.data.excesses.length, 2);
  });
  test("averages over days and counts days below target", () => {
    const r = run([{ totals: { iron_mg: 6 } }, { totals: { iron_mg: 22 } }, { totals: {} }]);
    const iron = find(r.data, "iron_mg");
    assert.equal(iron.average_intake, 9.33);
    assert.equal(iron.days_below_target, 2);
    assert.equal(r.data.days_assessed, 3);
  });
  test("ranks gaps: likely inadequate first, then by how far below", () => {
    const r = run([{ totals: { iron_mg: 5, zinc_mg: 7, calcium_mg: 900, fiber_g: 5 } }]);
    const order = r.data.gaps.map((g) => g.nutrient);
    assert.equal(order[0], "iron_mg");
    assert.ok(order.indexOf("calcium_mg") < order.indexOf("fiber_g"));
    assert.equal(r.data.summary.priority_gaps[0].nutrient, "iron_mg");
    assert.match(r.data.summary.headline, /likely inadequate/);
  });
  test("low data coverage lowers confidence and says so", () => {
    const r = run([{ totals: { iron_mg: 5, zinc_mg: 5 } }], { coverage: { iron_mg: 40, zinc_mg: 100 } });
    assert.equal(find(r.data, "iron_mg").confidence, "low");
    assert.match(find(r.data, "iron_mg").notes.join(" "), /missing data/);
    assert.equal(find(r.data, "zinc_mg").confidence, "ok");
  });
  test("nutrients with no data are listed, not scored as zero", () => {
    const r = run([{ totals: { iron_mg: 10 } }]);
    assert.equal(find(r.data, "selenium_mcg"), undefined);
    assert.ok(r.data.not_assessed.some((x) => x.nutrient === "selenium_mcg" && /no food/.test(x.reason)));
  });
  test("extra nutrients are compared (thiamin, copper after conversion)", () => {
    const r = run([{ totals: normalizeIntake({ thiamin_mg: 0.5, copper_mg: 0.9 }) }]);
    assert.equal(find(r.data, "thiamin_mg").status, "below_ear");
    assert.equal(find(r.data, "copper_mcg").status, "meets_rda"); // RDA 900
  });
  test("energy against the target, and macros against the AMDR", () => {
    const day = { totals: { kcal: 1500, protein_g: 40, carbs_g: 250, fat_g: 20 } };
    const r = run([day], { energy: { kcal: 2000, source: "supplied by the caller" } });
    assert.equal(r.data.energy.average_intake_kcal, 1500);
    assert.equal(r.data.energy.percent_of_target, 75);
    assert.equal(r.data.energy.status, "below_target");
    const m = r.data.macronutrients;
    assert.equal(m.percent_of_energy.carbs, 74.6);   // 1000 of 1340 kcal (160 + 1000 + 180)
    assert.equal(m.amdr.carbs.status, "above");
    assert.equal(m.amdr.fat.status, "below");
    assert.equal(m.protein_g_per_kg, 0.67);
  });
  test("food group coverage across days", () => {
    const r = run([
      { totals: { iron_mg: 5 }, groups: ["Grains", "Vegetables"] },
      { totals: { iron_mg: 5 }, groups: ["Grains", "Protein"] },
      { totals: { iron_mg: 5 }, groups: null },
    ]);
    const g = r.data.food_groups;
    assert.equal(g.days_with_food_data, 2);
    assert.equal(g.frequency_days.Grains, 2);
    assert.deepEqual(g.missing_every_day, ["Legumes", "Fruits", "Dairy"]);
    assert.deepEqual(g.missing_some_days, ["Protein", "Vegetables"]);
    assert.equal(run([{ totals: { iron_mg: 5 } }]).data.food_groups, null);
  });
  test("short records get a warning; empty input is an error", () => {
    assert.match(run([{ totals: { iron_mg: 5 } }]).data.notes[0], /Only 1 day/);
    assert.equal(run([]).ok, false);
  });
  test("reference lists every assessable nutrient", () => {
    const ref = dietaryAssessmentReference().data;
    assert.equal(ref.assessable_nutrients.length, assessableNutrients().length);
    assert.ok(ref.statuses.below_ear);
  });
});
