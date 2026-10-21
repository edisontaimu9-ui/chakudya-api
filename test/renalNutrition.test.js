import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ckdEpi2021, gCategory, hamwiIbwKg, computeRenalStage, computeRenalRequirements, computeRenalLabs, computeDialysisAdequacy,
  computeRenalPlan, emergencyDiet, renalReferenceCatalog, monitoringSchedule, REFERENCE_SECTION_IDS, LAB_IDS,
} from "../src/renalNutrition.js";

describe("CKD stage", () => {
  test("CKD-EPI 2021 reference values", () => {
    assert.equal(Math.round(ckdEpi2021(1.0, 50, "male") * 10) / 10, 91.7);
    assert.equal(Math.round(ckdEpi2021(1.0, 40, "female")), 73);
  });
  test("G categories at the boundaries", () => {
    assert.equal(gCategory(90).id, "G1"); assert.equal(gCategory(89.9).id, "G2"); assert.equal(gCategory(60).id, "G2");
    assert.equal(gCategory(59.9).id, "G3a"); assert.equal(gCategory(45).id, "G3a"); assert.equal(gCategory(44.9).id, "G3b");
    assert.equal(gCategory(30).id, "G3b"); assert.equal(gCategory(29.9).id, "G4"); assert.equal(gCategory(15).id, "G4"); assert.equal(gCategory(14.9).id, "G5");
  });
  test("textbook case: 67-year-old man, creatinine 3.3 mg/dL is G4", () => {
    const r = computeRenalStage({ sex: "male", age_years: 67, creatinine_mg_dl: 3.3 });
    assert.ok(r.ok);
    assert.equal(r.data.egfr_ml_min_1_73m2, 19.7);
    assert.equal(r.data.g_category.id, "G4");
    assert.equal(r.data.requirements_status, "ckd_3_5");
    assert.equal(r.data.requirements_ckd_stage, 4);
  });
  test("umol/L input, albuminuria category, and refusals", () => {
    const r = computeRenalStage({ sex: "female", age_years: 40, creatinine_umol_l: 88.4, acr_mg_g: 120 });
    assert.equal(r.data.inputs_used.creatinine_mg_dl, 1);
    assert.equal(r.data.a_category.id, "A2");
    assert.equal(computeRenalStage({ sex: "male", age_years: 15, creatinine_mg_dl: 1 }).ok, false);
    assert.equal(computeRenalStage({ sex: "x", age_years: 40, creatinine_mg_dl: 1 }).ok, false);
    assert.equal(computeRenalStage({ sex: "male", age_years: 40 }).ok, false);
  });
  test("stages 1-2 map to ckd_1_2 with no CKD stage for calcium", () => {
    const r = computeRenalStage({ sex: "male", age_years: 30, creatinine_mg_dl: 0.9 });
    assert.equal(r.data.requirements_status, "ckd_1_2");
    assert.equal(r.data.requirements_ckd_stage, null);
  });
});

describe("requirements", () => {
  test("Hamwi IBW", () => {
    assert.equal(Math.round(hamwiIbwKg("female", 152.4) * 10) / 10, 45.4);
    assert.equal(Math.round(hamwiIbwKg("male", 177.8) * 10) / 10, 75.3);
    assert.ok(hamwiIbwKg("male", 170, "large") > hamwiIbwKg("male", 170, "small"));
  });
  test("hemodialysis: 1.0-1.2 g/kg and 25-35 kcal/kg on actual weight inside 95-115% of IBW", () => {
    const r = computeRenalRequirements({ status: "hd", weight_kg: 60, height_cm: 165, sex: "female" });
    assert.ok(r.ok);
    assert.equal(r.data.weight.basis_used, "actual");
    assert.deepEqual(r.data.targets.protein.g_per_day, { min: 60, max: 72 });
    assert.deepEqual(r.data.targets.energy.kcal_per_day, { min: 1500, max: 2100 });
    assert.equal(r.data.targets.sodium.mg_per_day_max, 2300);
    assert.equal(r.data.targets.protein.statement, "KDOQI 2020 3.0.3");
    assert.deepEqual(r.data.legacy_krause[0].protein_g_per_kg_ibw, [1.2, 1.2]);
    assert.ok(r.data.legacy_krause[0].totals_at_ibw.protein_g_per_day.min > 0);
  });
  test("CKD 3-5: 0.55-0.60 g/kg, with VLPD alternative; diabetes 0.6-0.8", () => {
    const a = computeRenalRequirements({ status: "ckd_3_5", weight_kg: 70 });
    assert.deepEqual(a.data.targets.protein.g_per_kg, { min: 0.55, max: 0.6 });
    assert.deepEqual(a.data.targets.protein.g_per_day, { min: 38.5, max: 42 });
    assert.deepEqual(a.data.targets.protein.alternative_very_low_protein.g_per_kg, { min: 0.28, max: 0.43 });
    const b = computeRenalRequirements({ status: "ckd_3_5", weight_kg: 70, diabetes: true });
    assert.deepEqual(b.data.targets.protein.g_per_kg, { min: 0.6, max: 0.8 });
    assert.equal(b.data.targets.protein.statement, "KDOQI 2020 3.0.2");
  });
  test("underweight patient is adjusted and warned", () => {
    const r = computeRenalRequirements({ status: "ckd_3_5", weight_kg: 48, height_cm: 170, sex: "male", ckd_stage: 4 });
    assert.equal(r.data.weight.basis_used, "adjusted_edema_free");
    assert.equal(r.data.weight.weight_used_kg, 52.7);
    assert.ok(r.data.warnings.some((w) => /outside the 95-115% band/.test(w)));
    const actual = computeRenalRequirements({ status: "ckd_3_5", weight_kg: 48, height_cm: 170, sex: "male", weight_basis: "actual" });
    assert.equal(actual.data.weight.weight_used_kg, 48);
  });
  test("no height or sex: no IBW, still returns per-kg targets", () => {
    const r = computeRenalRequirements({ status: "pd", weight_kg: 65 });
    assert.ok(r.ok); assert.equal(r.data.weight.ibw_kg, null);
    assert.equal(r.data.legacy_krause[0].totals_at_ibw, undefined);
    assert.equal(computeRenalRequirements({ status: "pd", weight_kg: 65, weight_basis: "ibw" }).ok, false);
  });
  test("calcium only for CKD 3-4; fruit and vegetables only up to stage 4", () => {
    assert.deepEqual(computeRenalRequirements({ status: "ckd_3_5", weight_kg: 70, ckd_stage: 3 }).data.targets.calcium.mg_per_day, { min: 800, max: 1000 });
    assert.equal(computeRenalRequirements({ status: "ckd_3_5", weight_kg: 70, ckd_stage: 5 }).data.targets.calcium.mg_per_day, null);
    assert.equal(computeRenalRequirements({ status: "ckd_3_5", weight_kg: 70, ckd_stage: 5 }).data.targets.fruit_and_vegetables, undefined);
    assert.ok(computeRenalRequirements({ status: "ckd_1_2", weight_kg: 70 }).data.targets.fruit_and_vegetables);
  });
  test("gaps in the 2020 guideline come back as null with a reason, not a number", () => {
    const one = computeRenalRequirements({ status: "ckd_1_2", weight_kg: 70 }).data.targets;
    assert.equal(one.protein.restriction, null); assert.equal(one.sodium.limit, null);
    const tx = computeRenalRequirements({ status: "transplant", weight_kg: 70, weeks_post_transplant: 3 });
    assert.equal(tx.data.targets.protein.restriction, null);
    assert.equal(tx.data.legacy_krause.length, 1);
    assert.deepEqual(tx.data.legacy_krause[0].protein_g_per_kg_ibw, [1.3, 2]);
    assert.equal(computeRenalRequirements({ status: "transplant", weight_kg: 70 }).data.legacy_krause.length, 2);
    assert.equal(computeRenalRequirements({ status: "hd", weight_kg: 70 }).data.targets.potassium.target.includes("serum potassium"), true);
  });
  test("validation", () => {
    assert.equal(computeRenalRequirements({ status: "nope", weight_kg: 70 }).ok, false);
    assert.equal(computeRenalRequirements({ status: "hd" }).ok, false);
    assert.equal(computeRenalRequirements({ status: "hd", weight_kg: 70, age_years: 12 }).ok, false);
    assert.equal(computeRenalRequirements({ status: "hd", weight_kg: 70, frame: "huge" }).ok, false);
    assert.equal(computeRenalRequirements(null).ok, false);
    assert.ok(computeRenalRequirements({ status: "hd", weight_kg: 70, metabolically_stable: false }).data.warnings.length >= 1);
  });
});

describe("labs", () => {
  test("dialysis ranges, actions and Ca x P", () => {
    const r = computeRenalLabs({ labs: { potassium_meq_l: 6.1, phosphorus_mg_dl: 6.7, calcium_mg_dl: 9.0, albumin_g_dl: 2.8, sodium_meq_l: 140 } });
    assert.ok(r.ok);
    const by = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
    assert.equal(by.potassium.status, "high"); assert.match(by.potassium.diet_action, /250 mg/);
    assert.equal(by.phosphorus.status, "high"); assert.match(by.phosphorus.diet_action, /binders/);
    assert.equal(by.sodium.status, "in_range");
    assert.equal(by.albumin.status, "low"); assert.ok(by.albumin.edema_risk);
    assert.equal(r.data.calcium_phosphorus_product.value, 60.3);
    assert.equal(r.data.calcium_phosphorus_product.status, "above_limit");
    assert.deepEqual(r.data.out_of_range.sort(), ["Albumin low", "Phosphorus high", "Potassium high"].sort());
  });
  test("phosphorus of 5.5 is fine on dialysis (3-6) but high for normal kidneys (2.5-4.8)", () => {
    assert.equal(computeRenalLabs({ labs: { phosphorus_mg_dl: 5.5 } }).data.results[0].status, "in_range");
    assert.equal(computeRenalLabs({ labs: { phosphorus_mg_dl: 5.5 }, context: "general" }).data.results[0].status, "high");
  });
  test("SI units convert", () => {
    const r = computeRenalLabs({ labs: { creatinine_umol_l: 884, urea_mmol_l: 20, phosphate_mmol_l: 2, calcium_mmol_l: 2.5, glucose_mmol_l: 10, albumin_g_l: 38 } });
    const by = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
    assert.equal(by.creatinine.value, 10); assert.equal(by.bun.value, 56.02);
    assert.equal(by.phosphorus.value, 6.19); assert.equal(by.calcium.value, 10.02);
    assert.equal(by.glucose.value, 180.16); assert.equal(by.albumin.value, 3.8);
    assert.ok(r.data.unit_conversions.creatinine_umol_l);
  });
  test("ferritin by EPO use, glucose by diabetes, flat body also works", () => {
    assert.equal(computeRenalLabs({ labs: { ferritin_mcg_l: 200 } }).data.results[0].status, "low");
    assert.equal(computeRenalLabs({ labs: { ferritin_mcg_l: 200 }, on_epo: false }).data.results[0].status, "in_range");
    assert.equal(computeRenalLabs({ labs: { glucose_mg_dl: 250 } }).data.results[0].status, "high");
    assert.equal(computeRenalLabs({ labs: { glucose_mg_dl: 250 }, diabetes: true }).data.results[0].status, "in_range");
    assert.equal(computeRenalLabs({ potassium_meq_l: 4.4 }).data.results[0].status, "in_range");
  });
  test("a direction with no printed action says so; bad input refuses", () => {
    const r = computeRenalLabs({ labs: { magnesium_mg_dl: 1.0 } });
    assert.match(r.data.results[0].diet_action, /no diet action/);
    assert.equal(computeRenalLabs({ labs: {} }).ok, false);
    assert.equal(computeRenalLabs({ labs: { potassium_meq_l: "x" } }).ok, false);
    assert.equal(computeRenalLabs({ labs: { potassium_meq_l: 5 }, context: "home" }).ok, false);
    assert.ok(LAB_IDS.length === 13);
  });
});

describe("dialysis adequacy", () => {
  test("URR, Daugirdas Kt/V and eKt/V, interdialytic gain, nPNA", () => {
    const r = computeDialysisAdequacy({ modality: "hd", pre_bun_mg_dl: 60, post_bun_mg_dl: 20, session_hours: 4, uf_litres: 2.5, post_weight_kg: 70, npna: 1.5, pre_dialysis_weight_kg: 73, dry_weight_kg: 70 });
    assert.ok(r.ok);
    assert.equal(r.data.sections.urr.percent, 66.7); assert.equal(r.data.sections.urr.adequate, true);
    assert.equal(r.data.sections.kinetic_modeling.sp_kt_v, 1.3); assert.equal(r.data.sections.kinetic_modeling.ekt_v, 1.14);
    assert.equal(r.data.sections.kinetic_modeling.ekt_v_adequate, false);
    assert.equal(r.data.sections.interdialytic_weight_gain.status, "above_limit");
    assert.equal(r.data.sections.npna.status, "high");
    assert.equal(r.data.flags.length, 3);
  });
  test("urea in mmol/L gives the same URR; URR below 65 fails", () => {
    assert.equal(computeDialysisAdequacy({ modality: "hd", pre_urea_mmol_l: 30, post_urea_mmol_l: 12 }).data.sections.urr.percent, 60);
    assert.equal(computeDialysisAdequacy({ modality: "hd", pre_bun_mg_dl: 50, post_bun_mg_dl: 25 }).data.sections.urr.adequate, false);
  });
  test("peritoneal dialysis: weekly Kt/V of 2", () => {
    assert.equal(computeDialysisAdequacy({ modality: "pd", weekly_kt_v: 2.1 }).data.sections.weekly_kt_v.adequate, true);
    assert.equal(computeDialysisAdequacy({ modality: "pd", weekly_kt_v: 1.7 }).data.sections.weekly_kt_v.adequate, false);
    assert.ok(computeDialysisAdequacy({ modality: "pd", weekly_kt_v: 2.1, kt_v: 1.4 }).data.warnings.length);
  });
  test("nPNA accepts the KDOQI name nPCR; low nPNA", () => {
    assert.equal(computeDialysisAdequacy({ modality: "hd", npcr: 0.6 }).data.sections.npna.status, "low");
    assert.equal(computeDialysisAdequacy({ modality: "hd", npna: 1.0 }).data.sections.npna.status, "in_range");
  });
  test("refusals", () => {
    assert.equal(computeDialysisAdequacy({}).ok, false);
    assert.equal(computeDialysisAdequacy({ modality: "hd" }).ok, false);
    assert.equal(computeDialysisAdequacy({ modality: "hd", pre_bun_mg_dl: 20, post_bun_mg_dl: 60 }).ok, false);
    assert.equal(computeDialysisAdequacy({ modality: "hd", pre_bun_mg_dl: 60 }).ok, false);
    assert.equal(computeDialysisAdequacy({ modality: "hd", pre_dialysis_weight_kg: 70 }).ok, false);
    assert.equal(computeDialysisAdequacy({ modality: "xx" }).ok, false);
  });
});

describe("plan, monitoring, emergency diet, reference", () => {
  test("plan from creatinine alone derives the status and runs every part given", () => {
    const r = computeRenalPlan({ sex: "male", age_years: 67, creatinine_mg_dl: 3.3, weight_kg: 48, height_cm: 170, diabetes: true, labs: { potassium_meq_l: 5.8, phosphorus_mg_dl: 6.7 } });
    assert.ok(r.ok);
    assert.equal(r.data.status, "ckd_3_5");
    assert.equal(r.data.stage.g_category.id, "G4");
    assert.deepEqual(r.data.requirements.targets.protein.g_per_kg, { min: 0.6, max: 0.8 });
    assert.equal(r.data.labs.context, "general");
    assert.equal(r.data.monitoring.weight_and_bmi.frequency, "at least every 3 months (CKD 4-5)");
    assert.deepEqual(r.data.errors, {});
  });
  test("dialysis plan uses dialysis ranges and takes adequacy", () => {
    const r = computeRenalPlan({ status: "hd", weight_kg: 62, labs: { phosphorus_mg_dl: 5.5 }, adequacy: { pre_bun_mg_dl: 70, post_bun_mg_dl: 20 } });
    assert.equal(r.data.labs.context, "dialysis"); assert.equal(r.data.labs.results[0].status, "in_range");
    assert.equal(r.data.adequacy.sections.urr.adequate, true);
    assert.equal(r.data.monitoring.weight_and_bmi.frequency, "at least monthly");
    assert.ok(r.data.monitoring.composite_index);
  });
  test("one part failing does not sink the plan; nothing to do refuses", () => {
    const r = computeRenalPlan({ status: "hd", weight_kg: 62, labs: { potassium_meq_l: "x" } });
    assert.ok(r.ok); assert.ok(r.data.errors.labs); assert.ok(r.data.requirements);
    assert.equal(computeRenalPlan({ weight_kg: 60 }).ok, false);
    assert.equal(computeRenalPlan({ status: "x", weight_kg: 60 }).ok, false);
    assert.equal(computeRenalPlan({ status: "hd" }).ok, false);
  });
  test("monitoring schedule by status", () => {
    assert.equal(monitoringSchedule("transplant").weight_and_bmi.frequency, "at least every 3 months");
    assert.match(monitoringSchedule("ckd_3_5", 3).weight_and_bmi.frequency, /6 months/);
    assert.equal(monitoringSchedule("ckd_1_2").nutrition_screening, undefined);
  });
  test("emergency diet and reference", () => {
    const e = emergencyDiet().data;
    assert.equal(e.groups.length, 6); assert.equal(e.groups[1].choices_per_day[1], 10); assert.ok(e.emergency_kit.length >= 10);
    const all = renalReferenceCatalog().data;
    for (const id of REFERENCE_SECTION_IDS) assert.ok(all[id], id);
    assert.equal(renalReferenceCatalog("known_issues").data.known_issues.length, 12);
    assert.equal(renalReferenceCatalog("nope").ok, false);
    assert.ok(renalReferenceCatalog("kdoqi_2020").data.kdoqi_2020.statements.some((s) => s.id === "3.0.3"));
  });
});
