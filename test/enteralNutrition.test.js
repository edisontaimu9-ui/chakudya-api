import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeEnteralPlan, mapFormulaRow, pickFormulaByName, enteralReferenceCatalog } from "../src/enteralNutrition.js";

const F = { kcal_per_ml: 1.2, protein_g_per_l: 55.5, water_ml_per_l: 807 };
const base = { kcal_needs: 1800, protein_needs_g: 100, fluid_needs_ml: 2100, weight_kg: 70, formula: F };

describe("computeEnteralPlan", () => {
  test("continuous, worked example (guide steps 6-11)", () => {
    const { data: d } = computeEnteralPlan(base);
    assert.equal(d.prescription.rate_ml_per_hr, 63); // 1500 / 24 = 62.5 -> 63
    assert.equal(d.prescription.volume_ml_per_day, 1512);
    assert.equal(d.delivered_by_prescription.total_kcal, 1814);
    assert.equal(d.delivered_by_prescription.protein_g, 83.9);
    assert.equal(d.delivered_by_prescription.formula_water_ml, 1220);
    assert.equal(d.prescription.free_water_flush.ml_per_flush, 145); // 880 / 6 = 146.7 -> 145
    assert.equal(d.delivered_by_prescription.total_fluid_ml, 2090);
    assert.equal(d.adequacy.protein_pct_of_needs, 84);
    assert.equal(d.delivery_scenarios[0].pct_of_prescribed_delivered, 65);
    assert.equal(d.delivery_scenarios[0].energy_kcal, 1179);
    assert.deepEqual(d.buffer_rates.map((b) => b.rate_ml_per_hr), [75, 68]);
  });

  test("medication calories come off the formula target", () => {
    const { data: d } = computeEnteralPlan({ ...base, medication_kcal: 300 });
    assert.equal(d.needs.formula_kcal_target, 1500);
    assert.equal(d.prescription.rate_ml_per_hr, 52); // 1250 / 24 = 52.08
    assert.equal(d.delivered_by_prescription.total_kcal, 1798); // 1248 ml x 1.2 = 1498 formula + 300 medication
  });

  test("volume-based rounds to 100 ml and gives no rate", () => {
    const { data: d } = computeEnteralPlan({ ...base, mode: "volume_based" });
    assert.equal(d.prescription.volume_ml_per_day, 1500);
    assert.equal(d.prescription.rate_ml_per_hr, null);
    assert.equal(d.buffer_rates, null);
  });

  test("bolus", () => {
    const { data: d } = computeEnteralPlan({ ...base, mode: "bolus", feeds_per_day: 5 });
    assert.equal(d.prescription.bolus.feeds_per_day, 5);
    assert.equal(d.prescription.bolus.ml_per_feed, 300);
    assert.equal(d.prescription.volume_ml_per_day, 1500);
  });

  test("trophic uses 10-20 ml/hr", () => {
    const { data: d } = computeEnteralPlan({ ...base, mode: "trophic", trophic_rate_ml_hr: 20 });
    assert.equal(d.prescription.volume_ml_per_day, 480);
    assert.equal(d.delivered_by_prescription.total_kcal, 576);
  });

  test("adult refeeding starts at 10-20 kcal/kg and warns on nothing else", () => {
    const { data: d } = computeEnteralPlan({ ...base, weight_kg: 60, refeeding_risk: true, refeeding_kcal_per_kg: 15 });
    assert.equal(d.needs.formula_kcal_target, 900);
    assert.deepEqual(d.refeeding.start_kcal_range, [600, 1200]);
    assert.ok(d.notes.some((n) => /Protein is .* short/.test(n)));
  });

  test("paediatric refeeding starts at 40-50% of goal", () => {
    const { data: d } = computeEnteralPlan({ ...base, patient_type: "paediatric", refeeding_risk: true, refeeding_start_pct: 40 });
    assert.equal(d.needs.formula_kcal_target, 720);
  });

  test("flush minimum 30 ml and 5 ml rounding", () => {
    const { data: d } = computeEnteralPlan({ ...base, fluid_needs_ml: 1300 });
    assert.equal(d.prescription.free_water_flush.ml_per_flush, 30);
    assert.equal(d.prescription.free_water_flush.minimum_applied, true);
    const q6 = computeEnteralPlan({ ...base, flush_every_hours: 6 }).data;
    assert.equal(q6.prescription.free_water_flush.ml_per_flush, 220); // 880 / 4
  });

  test("rate above 150 ml/hr warns for adults only", () => {
    const hi = { ...base, kcal_needs: 4500 };
    assert.ok(computeEnteralPlan(hi).data.warnings.some((w) => /150 ml\/hr/.test(w)));
    assert.ok(!computeEnteralPlan({ ...hi, patient_type: "paediatric" }).data.warnings.some((w) => /150 ml\/hr/.test(w)));
  });

  test("half-rate start for high-risk tolerance", () => {
    const { data: d } = computeEnteralPlan({ ...base, high_risk_tolerance: true });
    assert.equal(d.advancement.start_rate_ml_per_hr, 32);
    assert.equal(d.advancement.every_hours, 4);
  });

  test("protein modular closes the protein gap", () => {
    const { data: d } = computeEnteralPlan({ ...base, protein_modular: { protein_g_per_serving: 6, kcal_per_serving: 25 } });
    assert.equal(d.prescription.protein_modular.servings_per_day, 3); // gap 16.1 g
    assert.equal(d.delivered_by_prescription.protein_g, 101.9);
  });

  test("delivered_volume_ml gives an actual adequacy scenario", () => {
    const { data: d } = computeEnteralPlan({ ...base, delivered_volume_ml: 756 });
    const s = d.delivery_scenarios.at(-1);
    assert.equal(s.pct_of_prescribed_delivered, 50);
  });

  test("validation", () => {
    assert.equal(computeEnteralPlan({ ...base, formula: {} }).ok, false);
    assert.equal(computeEnteralPlan({ formula: F }).ok, false);
    assert.equal(computeEnteralPlan({ ...base, mode: "nope" }).ok, false);
    assert.equal(computeEnteralPlan({ ...base, refeeding_risk: true, weight_kg: undefined }).ok, false);
    assert.equal(computeEnteralPlan({ ...base, hours_per_day: 30 }).ok, false);
    assert.equal(computeEnteralPlan([]).ok, false);
  });
});

describe("formula rows", () => {
  test("maps common column names and units", () => {
    const m = mapFormulaRow({ formula_name: "Test 1.5", kcal_per_100ml: 150, protein_g_per_100ml: 6.3, water_ml_per_100ml: 76 });
    assert.equal(m.kcal_per_ml, 1.5);
    assert.equal(m.protein_g_per_l, 63);
    assert.equal(m.water_ml_per_l, 760);
    assert.equal(m.name, "Test 1.5");
    assert.equal(mapFormulaRow({ name: "x" }).kcal_per_ml, null);
    const real = mapFormulaRow({ id: 1, formula: "Ensure Original (Abbott)", kcal_per_ml: 1.06, protein_g_per_l: 37 });
    assert.equal(real.name, "Ensure Original (Abbott)");
    assert.equal(real.water_ml_per_l, null);
  });
  test("pick by name", () => {
    const rows = [{ formula: "Alpha 1.0" }, { formula: "Alpha 1.5" }, { name: "Beta" }];
    assert.equal(pickFormulaByName(rows, "beta").row.name, "Beta");
    assert.equal(pickFormulaByName(rows, "alpha").matches.length, 2);
    assert.match(pickFormulaByName(rows, "zzz").error, /No enteral formula/);
  });
  test("reference catalog", () => {
    assert.ok(enteralReferenceCatalog().data.steps.length > 10);
    assert.equal(enteralReferenceCatalog("limits").data.data.max_adult_rate_ml_per_hr, 150);
    assert.equal(enteralReferenceCatalog("nope").ok, false);
  });
});
