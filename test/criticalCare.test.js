import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeProteinByStress, computeNpeNitrogenRatio, computeNitrogenBalance, computeCarbohydrateRequirement, fatRequirement,
  computePropofolFat, choFatRatioReference, computeElectrolyteReplacement, computePotassiumDeficit, computeIcuFluid, criticalCareReferenceCatalog,
} from "../src/criticalCare.js";

describe("critical care calculators", () => {
  test("protein by stress: one level with weight, whole table without", () => {
    const r = computeProteinByStress({ stress_level: 2, weight_kg: 70 });
    assert.equal(r.ok, true);
    assert.equal(r.data.label, "Moderate");
    assert.equal(r.data.protein_g_per_day_low, 84);
    assert.equal(r.data.protein_g_per_day_high, 105);
    const all = computeProteinByStress({});
    assert.equal(all.data.stress_levels.length, 4);
    assert.equal(all.data.stress_levels[3].protein_g_per_kg_range, "1.6 - 2.5 g/kg");
    assert.equal(all.data.stress_levels[0].protein_g_per_day_low, undefined);
  });

  test("protein by stress rejects bad input", () => {
    assert.equal(computeProteinByStress({ stress_level: 4 }).ok, false);
    assert.equal(computeProteinByStress({ stress_level: 1.5 }).ok, false);
    assert.equal(computeProteinByStress({ weight_kg: -5 }).ok, false);
    assert.equal(computeProteinByStress({ weight_kg: "abc" }).ok, false);
  });

  test("NPE:N2 ratio and its bands", () => {
    const r = computeNpeNitrogenRatio({ npe_kcal: 1500, protein_g: 75 });
    assert.equal(r.data.nitrogen_g, 12);
    assert.equal(r.data.npe_to_n2_ratio, "125:1");
    assert.equal(r.data.interpretation, "Moderate stress");
    assert.equal(computeNpeNitrogenRatio({ npe_kcal: 2000, protein_g: 50 }).data.interpretation, "Normal / mildly elevated");
    assert.equal(computeNpeNitrogenRatio({ npe_kcal: 1000, protein_g: 75 }).data.interpretation, "Severe stress");
    assert.match(computeNpeNitrogenRatio({ npe_kcal: 500, protein_g: 75 }).data.interpretation, /^Below the charted range/);
    assert.equal(computeNpeNitrogenRatio({ npe_kcal: 1500 }).ok, false);
  });

  test("nitrogen balance: formulas and grading", () => {
    const r = computeNitrogenBalance({ urine_volume_l: 2, urinary_urea_mmol_l: 250 });
    assert.equal(r.data.urinary_nitrogen_g, 14);
    assert.equal(r.data.total_urinary_nitrogen_g_per_24h, 16.8);
    assert.equal(r.data.total_nitrogen_output_g_per_24h, 20.8);
    assert.equal(r.data.interpretation.label, "Severe");
    assert.equal(r.data.interpretation.protein_g_per_kg_range, "1.9 - 2.5 g/kg");
    const mild = computeNitrogenBalance({ urine_volume_l: 1, urinary_urea_mmol_l: 50 });
    assert.equal(mild.data.total_nitrogen_output_g_per_24h, 5.68);
    assert.equal(mild.data.interpretation.label, "Mild");
    assert.equal(computeNitrogenBalance({ urine_volume_l: 0.1, urinary_urea_mmol_l: 0 }).data.interpretation.label, "Normal");
    assert.equal(computeNitrogenBalance({ urine_volume_l: 0, urinary_urea_mmol_l: 10 }).ok, false);
  });

  test("carbohydrate: g/day only when weight is sent", () => {
    const r = computeCarbohydrateRequirement({ weight_kg: 70 });
    assert.equal(r.data.usual_requirements.usual_low_g_per_day, 201.6);
    assert.equal(r.data.usual_requirements.usual_high_g_per_day, 403.2);
    assert.equal(r.data.maximum_recommendations.no_metabolic_stress.g_per_day, 655.2);
    assert.equal(r.data.maximum_recommendations.severe_stress.g_per_day, 453.6);
    assert.ok(r.data.usual_requirements.unit_warning);
    assert.equal(computeCarbohydrateRequirement({}).data.maximum_recommendations.tpn.g_per_day, undefined);
  });

  test("fat and CHO:fat references", () => {
    assert.match(fatRequirement().data.maximum_recommendations, /ESPEN 2009/);
    assert.equal(choFatRatioReference().data.ratios.length, 3);
  });

  test("propofol fat", () => {
    const r = computePropofolFat({ propofol_percent: "1", volume_ml: 100 });
    assert.equal(r.data.propofol_mg_total, 1000);
    assert.equal(r.data.fat_g_total, 10);
    assert.equal(computePropofolFat({ propofol_percent: 2, volume_ml: 50 }).data.propofol_mg_total, 1000);
    assert.equal(computePropofolFat({ propofol_percent: "5", volume_ml: 50 }).ok, false);
    assert.equal(computePropofolFat({ propofol_percent: "1" }).ok, false);
  });

  test("electrolytes: all, one, and unknown", () => {
    assert.deepEqual(Object.keys(computeElectrolyteReplacement({}).data).filter((k) => ["phosphate", "potassium", "magnesium"].includes(k)), ["phosphate", "potassium", "magnesium"]);
    const k = computeElectrolyteReplacement({ electrolyte: "Potassium" });
    assert.equal(k.data.electrolyte, "potassium");
    assert.match(k.data.expected_rise, /0\.25 mmol\/L/);
    assert.equal(computeElectrolyteReplacement({ electrolyte: "zinc" }).ok, false);
  });

  test("potassium deficit bands", () => {
    assert.equal(computePotassiumDeficit({ serum_k_mmol_l: 3.5 }).data.estimated_deficit, "100-200 mmol K deficit");
    assert.equal(computePotassiumDeficit({ serum_k_mmol_l: 3 }).data.estimated_deficit, "100-200 mmol K deficit");
    assert.equal(computePotassiumDeficit({ serum_k_mmol_l: 2.5 }).data.estimated_deficit, "200-400 mmol K deficit");
    assert.match(computePotassiumDeficit({ serum_k_mmol_l: 4.2 }).data.estimated_deficit, /Outside the charted bands/);
    assert.equal(computePotassiumDeficit({}).ok, false);
  });

  test("ICU fluid", () => {
    const r = computeIcuFluid({ weight_kg: 70 });
    assert.equal(r.data.fluid_ml_per_day_low, 2100);
    assert.equal(r.data.fluid_ml_per_day_high, 2450);
    assert.equal(computeIcuFluid({ weight_kg: 0 }).ok, false);
  });

  test("reference catalog, sections and known issues", () => {
    const all = criticalCareReferenceCatalog();
    assert.ok(all.data.sections.includes("known_issues"));
    assert.equal(criticalCareReferenceCatalog("urinary_nitrogen").data.data.length, 4);
    assert.equal(criticalCareReferenceCatalog("nope").ok, false);
    assert.ok(all.data.known_issues.some((x) => /equation selection/i.test(x)));
  });

  test("non-object bodies are rejected", () => {
    for (const f of [computeProteinByStress, computeNpeNitrogenRatio, computeNitrogenBalance, computeCarbohydrateRequirement, computePropofolFat, computeElectrolyteReplacement, computePotassiumDeficit, computeIcuFluid]) {
      assert.equal(f([1, 2]).ok, false);
    }
  });
});
