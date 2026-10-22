import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeGlycemicStatus, computeGlucoseTargets, computeCarbPlan, computeCarbCount, computeExchangePlan, computeGlycemicLoad, computeInsulin, computeHypoglycemia, computeExerciseCarbs, computeDiabetesPlan, diabetesReferenceCatalog, a1cToEag, a1cToMmolMol } from "../src/diabetesNutrition.js";

describe("glycaemic status", () => {
  test("A1C to eAG reproduces Krause Table 30.2", () => {
    const table = [[4, 68], [5, 97], [6, 126], [7, 154], [8, 183], [9, 212], [10, 240], [11, 269], [12, 298]];
    for (const [a, g] of table) assert.ok(Math.abs(a1cToEag(a) - g) <= 1, `A1C ${a}`);
  });
  test("mmol/mol matches the printed pairs", () => { assert.equal(a1cToMmolMol(6.5), 48); assert.equal(a1cToMmolMol(7), 53); assert.equal(a1cToMmolMol(5.7), 39); });
  test("categories follow Table 30.1 and the highest test wins", () => {
    assert.equal(computeGlycemicStatus({ a1c_percent: 5.4 }).data.category, "normal");
    assert.equal(computeGlycemicStatus({ a1c_percent: 6.0 }).data.category, "prediabetes");
    assert.equal(computeGlycemicStatus({ a1c_percent: 6.5 }).data.category, "diabetes");
    assert.equal(computeGlycemicStatus({ a1c_percent: 5.5, fpg_mg_dl: 126 }).data.category, "diabetes");
    assert.equal(computeGlycemicStatus({ fpg_mmol_l: 5.6 }).data.category, "prediabetes");
    assert.equal(computeGlycemicStatus({ ogtt_2h_mg_dl: 199 }).data.category, "prediabetes");
    assert.equal(computeGlycemicStatus({ ogtt_2h_mg_dl: 200 }).data.category, "diabetes");
  });
  test("a random glucose counts only with symptoms", () => {
    const a = computeGlycemicStatus({ random_mg_dl: 250, a1c_percent: 5.5 });
    assert.equal(a.data.category, "normal"); assert.ok(a.data.warnings.some((w) => w.includes("classic symptoms")));
    assert.equal(computeGlycemicStatus({ random_mg_dl: 250, classic_symptoms: true }).data.category, "diabetes");
    assert.equal(computeGlycemicStatus({ random_mg_dl: 250 }).ok, false);
  });
  test("unreliable A1C is left out", () => {
    const r = computeGlycemicStatus({ a1c_percent: 7, fpg_mg_dl: 90, a1c_unreliable: true });
    assert.equal(r.data.category, "normal"); assert.equal(r.data.tests.find((t) => t.test === "A1C").used, false);
  });
  test("bad input", () => { assert.equal(computeGlycemicStatus({}).ok, false); assert.equal(computeGlycemicStatus({ a1c_percent: 40 }).ok, false); assert.equal(computeGlycemicStatus({ fpg_mg_dl: 5 }).ok, false); });
});

describe("glucose targets", () => {
  test("nonpregnant adult is ADA 2026", () => {
    const t = computeGlucoseTargets({}).data.targets;
    assert.ok(t.a1c.startsWith("<7.0%")); assert.equal(t.preprandial_capillary_glucose_mg_dl, "80-130 (4.4-7.2 mmol/L)");
    assert.equal(t.cgm.time_in_range_70_180_pct, ">70"); assert.equal(t.cgm.time_below_70_pct, "<4"); assert.equal(t.cgm_older_adults.time_below_70_pct, "<1");
  });
  test("pregnancy targets", () => {
    const t = computeGlucoseTargets({ population: "gdm" }).data.targets;
    assert.equal(t.fasting_mg_dl, "<95 (5.3 mmol/L)"); assert.ok(t.a1c.includes("<6%"));
  });
  test("unknown population", () => assert.equal(computeGlucoseTargets({ population: "child" }).ok, false));
});

describe("carbohydrate plan", () => {
  test("Krause starting point for a woman: 3-4 servings per meal, 1-2 per snack", () => {
    const d = computeCarbPlan({ sex: "female", meals: 3, snacks: 1 }).data;
    assert.deepEqual(d.daily.carb_g_range, [150, 210]);
    assert.deepEqual(d.distribution[0].carb_exchanges_range, [3, 4]);
    assert.equal(d.distribution.length, 4);
  });
  test("percentage of energy: 1900 kcal at 50% gives 237.5 g, as in the worksheet example (about 230 g)", () => {
    const d = computeCarbPlan({ energy_kcal: 1900, carb_pct: 50, meals: 3, snacks: 3 }).data;
    assert.equal(d.daily.carb_g, 238); assert.equal(d.daily.carb_pct_of_energy, 50);
    const sum = d.distribution.reduce((a, s) => a + s.carb_g, 0); assert.ok(Math.abs(sum - 238) <= 3);
  });
  test("clinician carb_g_per_day is split evenly, with weights when sent", () => {
    const even = computeCarbPlan({ carb_g_per_day: 180, meals: 3 }).data.distribution.map((s) => s.carb_g);
    assert.deepEqual(even, [60, 60, 60]);
    const w = computeCarbPlan({ carb_g_per_day: 180, meals: 3, meal_weights: [1, 2, 3] }).data.distribution.map((s) => s.carb_g);
    assert.deepEqual(w, [30, 60, 90]);
    assert.equal(computeCarbPlan({ carb_g_per_day: 180, meals: 3, meal_weights: [1, 2] }).ok, false);
  });
  test("GDM: breakfast capped near 30 g, bedtime snack, 175 g minimum warned", () => {
    const d = computeCarbPlan({ population: "gdm", carb_g_per_day: 200, meals: 3, snacks: 3 }).data;
    assert.equal(d.distribution[0].slot, "breakfast"); assert.equal(d.distribution[0].carb_g, 30);
    assert.equal(d.distribution.at(-1).slot, "bedtime snack");
    assert.ok(Math.abs(d.distribution.reduce((a, s) => a + s.carb_g, 0) - 200) <= 3);
    const low = computeCarbPlan({ population: "gdm", carb_g_per_day: 150, meals: 3, snacks: 3 }).data;
    assert.ok(low.warnings.some((w) => w.includes("175")));
  });
  test("needs a basis", () => { assert.equal(computeCarbPlan({}).ok, false); assert.equal(computeCarbPlan({ carb_g_per_day: 180, meals: 9 }).ok, false); });
  test("label reading subtracts half the fibre only above 5 g", () => {
    assert.equal(computeCarbCount({ total_carb_g: 30, fibre_g: 4 }).data.per_serving.counted_carb_g, 30);
    assert.equal(computeCarbCount({ total_carb_g: 30, fibre_g: 8 }).data.per_serving.counted_carb_g, 26);
    assert.equal(computeCarbCount({ total_carb_g: 30, fibre_g: 4, sugar_alcohol_g: 4, servings: 2 }).data.counted_carb_g, 52);
    assert.equal(computeCarbCount({ fibre_g: 4 }).ok, false);
  });
});

describe("exchange plan on the live exchange_lists shape", () => {
  const rows = [
    { id: 1, food_name: "Brown / wholewheat bread", exchange_type: "Starch", portion: "1 slice (±42 g)", kcal: 80, kj: 335, protein_g: 3, carbs_g: 15, fat_g: 0 },
    { id: 2, food_name: "Pita bread", exchange_type: "Starch", portion: "½ pita", kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 0 },
    { id: 20, food_name: "Apple (raw)", exchange_type: "Fruit", portion: "1 medium", kcal: 60, protein_g: 0, carbs_g: 15, fat_g: 0 },
    { id: 30, food_name: "Skim milk", exchange_type: "Milk", portion: "1 cup (250 ml)", kcal: 80, protein_g: 8, carbs_g: 12, fat_g: 0 },
    { id: 40, food_name: "Asparagus", exchange_type: "Vegetables", portion: "1 cup raw", kcal: 25, protein_g: 2, carbs_g: 5, fat_g: 0 },
    { id: 50, food_name: "Lean mince", exchange_type: "Lean meat", portion: "30 g", kcal: 45, protein_g: 7, carbs_g: 0, fat_g: 2 },
    { id: 60, food_name: "Oil", exchange_type: "Fat", portion: "1 tsp", kcal: 45, protein_g: 0, carbs_g: 0, fat_g: 5 },
  ];
  test("types are summarised and carbohydrate choices identified", () => {
    const d = computeExchangePlan({}, rows).data;
    assert.equal(d.field_map.name, "food_name"); assert.equal(d.counts.groups, 6);
    const starch = d.exchange_types.find((t) => t.group === "Starch");
    assert.deepEqual(starch.per_exchange, { kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 0 }); assert.equal(starch.counts_as_carb_choice, true);
    assert.equal(d.exchange_types.find((t) => t.group === "Vegetables").counts_as_carb_choice, false);
    assert.equal(d.items.find((i) => i.name === "Apple (raw)").carb_exchanges, 1);
  });
  test("a daily prescription is totalled by the Krause 4-4-9 method", () => {
    const d = computeExchangePlan({ exchanges: { starch: 10, fruit: 3, milk: 2, vegetables: 2, "lean meat": 6, fat: 5 } }, rows).data.day;
    assert.equal(d.totals.carbs_g, 150 + 45 + 24 + 10);
    assert.equal(d.totals.protein_g, 30 + 0 + 16 + 4 + 42);
    assert.equal(d.totals.fat_g, 12 + 25);
    assert.equal(d.totals.kcal_by_4_4_9, 229 * 4 + 92 * 4 + 37 * 9);
    assert.equal(d.cho_choices, 15);
  });
  test("per-meal counts", () => {
    const d = computeExchangePlan({ meals: { breakfast: { starch: 2, milk: 1, fruit: 1 }, lunch: { starch: 3, vegetables: 2 } } }, rows).data;
    assert.equal(d.meals[0].cho_choices, 4); assert.equal(d.meals[0].totals.carbs_g, 57); assert.equal(d.meals[1].cho_choices, 3);
  });
  test("links a carbohydrate plan to example choices", () => {
    const d = computeExchangePlan({ carb_plan: { carb_g_per_day: 180, meals: 3 } }, rows).data.carb_plan;
    assert.equal(d.slots.length, 3); assert.equal(d.slots[0].carb_exchanges, 4);
    assert.ok(d.slots[0].example_choices.length > 0);
    assert.ok(d.slots[0].example_choices.every((c) => c.carbs_g >= 10));
  });
  test("unknown type lists what is available; empty or unknown columns are reported", () => {
    const r = computeExchangePlan({ exchanges: { pizza: 1 } }, rows); assert.equal(r.ok, false); assert.ok(r.error.includes("Starch"));
    assert.equal(computeExchangePlan({}, []).ok, false);
    assert.equal(computeExchangePlan({}, [{ label: "x" }]).ok, false);
  });
});

describe("glycaemic load", () => {
  const gi = [{ food_name: "Maize stiff porridge (nsima)", match_keywords: ["nsima"], gi_value: 94.06, source: "Mlotha 2016", population: "Malawi" }];
  const match = (rows, name) => rows.filter((r) => r.match_keywords.some((k) => name.toLowerCase().includes(k)));
  test("GL = GI x carbs / 100, summed", () => {
    const d = computeGlycemicLoad({ foods: [{ food: "nsima", carbs_g: 50 }, { food: "tomato relish", carbs_g: 5, gi: 30 }] }, gi, match).data;
    assert.equal(d.foods[0].gl, 47.0); assert.equal(d.foods[1].gl, 1.5); assert.equal(d.meal.gl_total, 48.5); assert.equal(d.meal.carb_g_total, 55);
  });
  test("foods with no GI are listed, not guessed", () => {
    const d = computeGlycemicLoad({ foods: [{ food: "mandasi", carbs_g: 30 }] }, gi, match).data;
    assert.equal(d.foods[0].gl, null); assert.equal(d.meal.foods_without_gi, 1); assert.ok(d.warnings[0].includes("mandasi"));
  });
  test("bad input", () => { assert.equal(computeGlycemicLoad({ foods: [] }, gi, match).ok, false); assert.equal(computeGlycemicLoad({ foods: [{ food: "x" }] }, gi, match).ok, false); });
});

describe("insulin", () => {
  test("500 and 1700 rules match the Krause worked examples (TDD 50: ICR 10, CF 34 rounds from 1700/50)", () => {
    const d = computeInsulin({ tdd_units: 50 }).data.ratios;
    assert.equal(d.icr_g_per_unit, 10); assert.equal(d.cf_mg_dl_per_unit, 34);
  });
  test("mealtime plus correction dose", () => {
    const d = computeInsulin({ tdd_units: 50, carbs_g: 60, current_glucose_mg_dl: 204, target_glucose_mg_dl: 100 }).data.dose;
    assert.equal(d.carb_dose_units, 6); assert.equal(d.correction_units, 3.06); assert.equal(d.total_units_exact, 9.06); assert.equal(d.total_units_rounded, 9);
  });
  test("clinician-set ratios override the rules", () => {
    const d = computeInsulin({ icr_g_per_unit: 12, cf_mg_dl_per_unit: 40, carbs_g: 48 }).data;
    assert.equal(d.dose.carb_dose_units, 4); assert.equal(d.ratios.icr_source, "clinician-set insulin-to-carbohydrate ratio");
  });
  test("no correction at or below target; no dose when glucose is below 70", () => {
    assert.equal(computeInsulin({ tdd_units: 50, current_glucose_mg_dl: 90, target_glucose_mg_dl: 100 }).data.dose.correction_units, 0);
    const low = computeInsulin({ tdd_units: 50, carbs_g: 60, current_glucose_mg_dl: 60, target_glucose_mg_dl: 100 }).data;
    assert.equal(low.dose, null); assert.ok(low.stop.includes("below 70"));
  });
  test("a correction needs a target; weight gives a TDD range only", () => {
    assert.equal(computeInsulin({ tdd_units: 50, current_glucose_mg_dl: 200 }).ok, false);
    const e = computeInsulin({ weight_kg: 60, diabetes_type: "t1dm" }).data.tdd_estimate; assert.deepEqual(e.units_per_day, [30, 60]);
    assert.equal(computeInsulin({ weight_kg: 60 }).ok, false); assert.equal(computeInsulin({}).ok, false); assert.equal(computeInsulin({ tdd_units: 2 }).ok, false);
  });
  test("mmol/L input is accepted", () => {
    const d = computeInsulin({ tdd_units: 50, current_glucose_mmol_l: 11.3, target_glucose_mmol_l: 5.6 }).data.dose;
    assert.ok(d.correction_units > 2.9 && d.correction_units < 3.4);
  });
});

describe("hypoglycaemia", () => {
  test("levels", () => {
    assert.equal(computeHypoglycemia({ glucose_mg_dl: 65 }).data.level, 1);
    assert.equal(computeHypoglycemia({ glucose_mg_dl: 53 }).data.level, 2);
    assert.equal(computeHypoglycemia({ glucose_mmol_l: 2.8 }).data.level, 2);
    assert.equal(computeHypoglycemia({ glucose_mg_dl: 90 }).data.level, null);
    assert.equal(computeHypoglycemia({ assistance_needed: true }).data.level, 3);
  });
  test("level 1 treatment is 15-20 g glucose with a 15 minute recheck", () => {
    const d = computeHypoglycemia({ glucose_mg_dl: 60 }).data;
    assert.deepEqual(d.carbs_to_treat_g, [15, 20]); assert.ok(d.steps.some((s) => s.includes("15 minutes")));
  });
  test("unable to swallow: no oral treatment, glucagon", () => {
    const d = computeHypoglycemia({ glucose_mg_dl: 45, able_to_swallow: false }).data;
    assert.ok(d.steps[0].startsWith("Do not give food")); assert.equal(d.carbs_to_treat_g, null);
  });
  test("alpha-glucosidase inhibitor: glucose, not sucrose", () => {
    assert.ok(computeHypoglycemia({ glucose_mg_dl: 60, on_alpha_glucosidase_inhibitor: true }).data.steps[0].includes("not table sugar"));
  });
  test("needs input", () => assert.equal(computeHypoglycemia({}).ok, false));
});

describe("exercise", () => {
  test("15 g per 30-60 min on insulin", () => {
    const d = computeExerciseCarbs({ duration_min: 60, on_insulin_or_secretagogue: true }).data;
    assert.deepEqual(d.extra_carbohydrate_g_range, [15, 30]);
  });
  test("under 30 min, and not on insulin", () => {
    assert.equal(computeExerciseCarbs({ duration_min: 20, on_insulin_or_secretagogue: true, pre_exercise_glucose_mg_dl: 150 }).data.extra_carbohydrate_g, 0);
    assert.equal(computeExerciseCarbs({ duration_min: 90 }).data.extra_carbohydrate_g, 0);
  });
  test("ketones warn, both thresholds are shown", () => {
    const d = computeExerciseCarbs({ duration_min: 45, on_insulin_or_secretagogue: true, pre_exercise_glucose_mg_dl: 95, ketones_present: true }).data;
    assert.ok(d.warnings.some((w) => w.includes("Ketones"))); assert.ok(d.notes.some((n) => n.includes("90 mg/dL")));
  });
});

describe("plan and reference", () => {
  test("plan combines status, targets and carb plan", () => {
    const d = computeDiabetesPlan({ labs: { a1c_percent: 8.1 }, carb: { energy_kcal: 1800, carb_pct: 45 } }).data;
    assert.equal(d.glycemic_status.category, "diabetes"); assert.ok(d.glucose_targets.targets); assert.equal(d.carb_plan.daily.carb_g, 203);
    assert.equal(d.glycemic_status.sources, undefined);
  });
  test("reference lists sections and returns one", () => {
    assert.ok(diabetesReferenceCatalog().data.sections.length >= 10);
    assert.equal(diabetesReferenceCatalog("a1c_eag").data.rows.length, 17);
    assert.ok(diabetesReferenceCatalog("known_issues").data.items.some((i) => i.topic.includes("Random glucose")));
    assert.equal(diabetesReferenceCatalog("nope").ok, false);
  });
});
