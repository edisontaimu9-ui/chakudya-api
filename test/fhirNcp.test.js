import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateScreen,
  evaluateAssessNutrition,
  evaluateDiagnose,
  evaluateIntervene,
  evaluateGoals,
  evaluateNcpDocument,
  ncpOperationFor,
  diagnosisCodesRequested,
  buildNcpCodeSystem,
} from "../src/fhirNcp.js";
import { buildCapabilityStatement, buildFentonObservation, buildBmiForAgeObservation } from "../src/fhir.js";
import {
  codeSystemResource, operationDefinitionResource, structureDefinitionResource, staticConformanceResource,
  STATIC_CODE_SYSTEM_NAMES, OPERATION_DEFINITION_IDS, STRUCTURE_DEFINITION_NAMES,
} from "../src/fhirTerminology.js";

let n = 0;
const ctx = { base: "https://x.test", now: "2026-10-10T08:00:00.000Z", uuid: () => `id-${++n}` };

const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const obsBy = (bundle, code) => bundle.entry.map((e) => e.resource).find((r) => r.code?.coding?.some((c) => c.code === code));

// ─── $screen (MUST) ───────────────────────────────────────────────────────
test("MUST: low risk scores 0", () => {
  const r = evaluateScreen(P([
    { name: "weight", valueQuantity: q(70, "kg") },
    { name: "height", valueQuantity: q(170, "cm") },
    { name: "weightLossPercent3to6Months", valueDecimal: 0 },
    { name: "acuteDiseaseNoIntake", valueBoolean: false },
  ]), ctx);
  assert.equal(r.ok, true);
  const o = r.body.entry[0].resource;
  assert.equal(o.valueInteger, 0);
  assert.equal(o.component.at(-2).valueCodeableConcept.coding[0].code, "low");
});

test("MUST: boundaries (BMI 18.5 -> 1, loss 10% -> 1, loss >10 -> 2) and high risk", () => {
  const run = (bmi, loss, acute) => evaluateScreen(P([
    { name: "bmi", valueDecimal: bmi },
    { name: "weightLossPercent3to6Months", valueDecimal: loss },
    { name: "acuteDiseaseNoIntake", valueBoolean: acute },
  ]), ctx).body.entry[0].resource.valueInteger;
  assert.equal(run(20, 0, false), 1);
  assert.equal(run(20.1, 0, false), 0);
  assert.equal(run(18.4, 0, false), 2);
  assert.equal(run(25, 5, false), 1);
  assert.equal(run(25, 10, false), 1);
  assert.equal(run(25, 10.1, false), 2);
  assert.equal(run(25, 0, true), 2);
  assert.equal(run(18, 12, true), 6);
});

test("MUST: errors are OperationOutcomes", () => {
  const r = evaluateScreen(P([{ name: "bmi", valueDecimal: 22 }]), ctx);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.outcome.resourceType, "OperationOutcome");
  assert.equal(evaluateScreen({ resourceType: "Bundle" }, ctx).ok, false);
});

// ─── $screen — NRS-2002 ───────────────────────────────────────────────────
function nrs({ bmi = 24, loss = 0, months, intake = 100, impaired, sev, age = 50, extra = [] }) {
  return P([
    { name: "tool", valueCode: "nrs-2002" },
    { name: "bmi", valueDecimal: bmi },
    { name: "weightLossPercent", valueDecimal: loss },
    ...(months !== undefined ? [{ name: "weightLossPeriodMonths", valueDecimal: months }] : []),
    { name: "intakePercentOfRequirement", valueDecimal: intake },
    ...(impaired !== undefined ? [{ name: "impairedGeneralCondition", valueBoolean: impaired }] : []),
    ...(sev !== undefined ? [{ name: "diseaseSeverityScore", valueInteger: sev }] : []),
    { name: "ageYears", valueInteger: age },
    ...extra,
  ]);
}
const nrsObs = (b) => evaluateScreen(b, ctx).body.entry[0].resource;
const nrsComp = (o, code) => o.component.find((c) => c.code.coding[0].code === code);
const nrsRisk = (o) => nrsComp(o, "nrs-risk-category").valueCodeableConcept.coding[0].code;
const nrsStatus = (o) => nrsComp(o, "nrs-nutritional-status-score").valueInteger;

test("NRS-2002: all four initial questions negative skips final screening", () => {
  const o = nrsObs(nrs({ sev: 2, age: 80 })); // BMI 24, no loss, intake 100, not severely ill
  assert.equal(o.valueInteger, undefined);
  assert.equal(nrsRisk(o), "final-screening-not-required");
  assert.equal(nrsComp(o, "nrs-initial-screening-positive").valueBoolean, false);
  assert.match(o.note[0].text, /weekly/);
});

test("NRS-2002: severe undernutrition (BMI < 18.5 + impaired condition) is score 3 and at risk", () => {
  const o = nrsObs(nrs({ bmi: 17.9, impaired: true, sev: 0 }));
  assert.equal(nrsStatus(o), 3);
  assert.equal(o.valueInteger, 3);
  assert.equal(nrsRisk(o), "at-risk");
});

test("NRS-2002: BMI 18.5-20.5 counts as 2 only with impaired general condition", () => {
  assert.equal(nrsStatus(nrsObs(nrs({ bmi: 19, impaired: true, sev: 0 }))), 2);
  assert.equal(nrsStatus(nrsObs(nrs({ bmi: 19, impaired: false, intake: 80, sev: 0 }))), 0);
  // BMI exactly 20.5 is not "< 20.5": it only scores (band 18.5-20.5) once another initial question is YES
  assert.equal(nrsRisk(nrsObs(nrs({ bmi: 20.5, impaired: true, sev: 0 }))), "final-screening-not-required");
  assert.equal(nrsStatus(nrsObs(nrs({ bmi: 20.5, impaired: true, intake: 90, sev: 0 }))), 2);
  assert.equal(evaluateScreen(nrs({ bmi: 19, sev: 0 }), ctx).ok, false); // impaired condition must be stated
});

test("NRS-2002: weight-loss bands (>5% in 3 mo = 1, >5% in 2 mo = 2, >5% in 1 mo or >15% in 3 mo = 3)", () => {
  const st = (loss, months) => nrsStatus(nrsObs(nrs({ loss, months, sev: 0 })));
  assert.equal(st(5, 3), 0); // must be MORE than 5%
  assert.equal(st(6, 3), 1);
  assert.equal(st(6, 2), 2);
  assert.equal(st(6, 1), 3);
  assert.equal(st(16, 3), 3);
  assert.equal(st(15, 3), 1);
  // a loss over 4 months is outside the "last 3 months" window: it neither triggers screening nor scores
  assert.equal(nrsRisk(nrsObs(nrs({ loss: 20, months: 4, sev: 0 }))), "final-screening-not-required");
  assert.equal(nrsStatus(nrsObs(nrs({ loss: 20, months: 4, intake: 90, sev: 0 }))), 0);
});

test("NRS-2002: intake bands, including the appendix's overlapping ranges (highest score wins, overlap disclosed)", () => {
  const st = (intake) => nrsStatus(nrsObs(nrs({ intake, sev: 0 })));
  assert.equal(st(76), 0);
  assert.equal(st(75), 1);
  assert.equal(st(61), 1);
  assert.equal(st(26), 2);
  assert.equal(st(25), 3);
  assert.equal(st(0), 3);
  const overlap = nrsObs(nrs({ intake: 55, sev: 0 })); // in both 50-75 (1) and 20-60 (2)
  assert.equal(nrsStatus(overlap), 2);
  assert.match(overlap.note[0].text, /overlap/);
  assert.doesNotMatch(nrsObs(nrs({ intake: 70, sev: 0 })).note[0].text, /overlap/);
});

test("NRS-2002: total = status + disease severity + 1 at age 70+; threshold is 3", () => {
  assert.equal(nrsObs(nrs({ intake: 70, sev: 1, age: 50 })).valueInteger, 2);
  assert.equal(nrsRisk(nrsObs(nrs({ intake: 70, sev: 1, age: 50 }))), "not-at-risk");
  const older = nrsObs(nrs({ intake: 70, sev: 1, age: 70 })); // 1 + 1 + 1
  assert.equal(older.valueInteger, 3);
  assert.equal(nrsComp(older, "nrs-age-adjustment").valueInteger, 1);
  assert.equal(nrsRisk(older), "at-risk");
  assert.equal(nrsComp(nrsObs(nrs({ intake: 70, sev: 1, age: 69 })), "nrs-age-adjustment").valueInteger, 0);
  // severe disease alone (ICU) is a positive initial screen and scores 3
  const icu = nrsObs(nrs({ sev: 3 }));
  assert.equal(icu.valueInteger, 3);
  assert.equal(nrsRisk(icu), "at-risk");
});

test("NRS-2002: severity score is required once initial screening is positive; inputs validated", () => {
  const needSev = evaluateScreen(nrs({ intake: 50 }), ctx);
  assert.equal(needSev.ok, false);
  assert.match(needSev.outcome.issue[0].diagnostics, /diseaseSeverityScore/);
  assert.equal(evaluateScreen(nrs({ intake: 50, sev: 4 }), ctx).ok, false);
  assert.equal(evaluateScreen(nrs({ loss: 7, sev: 1 }), ctx).ok, false); // months required with a loss
  assert.equal(evaluateScreen(P([{ name: "tool", valueCode: "nrs-2002" }, { name: "bmi", valueDecimal: 22 }]), ctx).ok, false);
  assert.equal(evaluateScreen(nrs({ age: 12, sev: 1, intake: 50 }), ctx).status, 422);
  assert.equal(evaluateScreen(P([{ name: "tool", valueCode: "mna" }]), ctx).ok, false);
});

test("NRS-2002: explicit initial-question overrides are honoured; default tool stays MUST", () => {
  // normal numbers but the clinician says intake was reduced -> initial screening positive
  const o = nrsObs(nrs({ intake: 100, sev: 0, extra: [{ name: "reducedIntakeLastWeek", valueBoolean: true }] }));
  assert.equal(nrsComp(o, "nrs-initial-screening-positive").valueBoolean, true);
  const must = evaluateScreen(P([{ name: "bmi", valueDecimal: 22 }, { name: "weightLossPercent3to6Months", valueDecimal: 0 }, { name: "acuteDiseaseNoIntake", valueBoolean: false }]), ctx);
  assert.equal(must.body.entry[0].resource.code.coding[0].code, "must");
});

// ─── $screen — MNA ────────────────────────────────────────────────────────
const MNA_SCREEN_ITEM_NAMES = ["foodIntakeDeclineScore", "weightLossKg3Months", "weightLossUnknown", "mobilityScore", "psychologicalStressOrAcuteDisease", "neuropsychologicalScore"];
const MNA_ASSESS_ITEM_NAMES = ["livesIndependently", "moreThan3PrescriptionDrugs", "pressureSoresOrUlcers", "fullMealsPerDay", "dairyDaily", "legumesOrEggsTwiceWeekly", "meatFishPoultryDaily", "fruitOrVegetablesTwoPlusServings", "fluidCupsPerDay", "modeOfFeedingScore", "selfViewNutritionScore", "selfViewHealthScore", "midArmCircumferenceCm", "calfCircumferenceCm"];
const MNA_SCREEN_10 = { foodIntakeDeclineScore: 2, weightLossKg3Months: 0, mobilityScore: 2, psychologicalStressOrAcuteDisease: true, neuropsychologicalScore: 2, bmi: 20 }; // 2+3+2+0+2+1 = 10
const MNA_SCREEN_14 = { ...MNA_SCREEN_10, psychologicalStressOrAcuteDisease: false, bmi: 24 }; // 2+3+2+2+2+3 = 14
const MNA_ASSESS_0 = {
  livesIndependently: false, moreThan3PrescriptionDrugs: true, pressureSoresOrUlcers: true, fullMealsPerDay: 1,
  dairyDaily: false, legumesOrEggsTwiceWeekly: false, meatFishPoultryDaily: false, fruitOrVegetablesTwoPlusServings: false,
  fluidCupsPerDay: 2, modeOfFeedingScore: 0, selfViewNutritionScore: 0, selfViewHealthScore: 0, midArmCircumferenceCm: 18, calfCircumferenceCm: 25,
};
const MNA_ASSESS_MAX = {
  livesIndependently: true, moreThan3PrescriptionDrugs: false, pressureSoresOrUlcers: false, fullMealsPerDay: 3,
  dairyDaily: true, legumesOrEggsTwiceWeekly: true, meatFishPoultryDaily: true, fruitOrVegetablesTwoPlusServings: true,
  fluidCupsPerDay: 6, modeOfFeedingScore: 2, selfViewNutritionScore: 2, selfViewHealthScore: 2, midArmCircumferenceCm: 23, calfCircumferenceCm: 32,
};
const mnaParam = ([name, v]) =>
  typeof v === "boolean" ? { name, valueBoolean: v } : Number.isInteger(v) ? { name, valueInteger: v } : { name, valueDecimal: v };
const mna = (over = {}, base = { ...MNA_SCREEN_10, ...MNA_ASSESS_0 }) =>
  P([{ name: "tool", valueCode: "mna" }, ...Object.entries({ ...base, ...over }).filter(([, v]) => v !== undefined).map(mnaParam)]);
const mnaObs = (b) => { const r = evaluateScreen(b, ctx); assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body.entry[0].resource; };
const mnaRisk = (o) => nrsComp(o, "mna-risk-category").valueCodeableConcept.coding[0].code;
const mnaAssessed = (over) => nrsComp(mnaObs(mna(over)), "mna-assessment-score").valueQuantity.value;

test("MNA: screening score 12-14 stops at normal (no assessment, no total)", () => {
  const o = mnaObs(mna({}, MNA_SCREEN_14));
  assert.equal(nrsComp(o, "mna-screening-score").valueInteger, 14);
  assert.equal(mnaRisk(o), "normal");
  assert.equal(o.valueQuantity, undefined);
  assert.equal(nrsComp(o, "mna-assessment-score"), undefined);
  assert.equal(o.interpretation[0].coding[0].code, "N");
  assert.match(o.note[0].text, /normal nutritional status \(12-14\)/);
  // exactly 12 still stops; assessment items sent anyway are ignored
  const twelve = mnaObs(mna({ bmi: 18, ...MNA_ASSESS_MAX }, MNA_SCREEN_14)); // 2+3+2+2+2+0 = 11 -> assessment needed
  assert.equal(nrsComp(twelve, "mna-screening-score").valueInteger, 11);
  const stop = mnaObs(mna({ bmi: 20, ...MNA_ASSESS_0 }, MNA_SCREEN_14)); // 2+3+2+2+2+1 = 12
  assert.equal(nrsComp(stop, "mna-screening-score").valueInteger, 12);
  assert.equal(nrsComp(stop, "mna-assessment-score"), undefined);
});

test("MNA: screening 11 or less requires the assessment items and names the missing ones", () => {
  const noAssess = evaluateScreen(mna({}, MNA_SCREEN_10), ctx);
  assert.equal(noAssess.ok, false);
  assert.equal(noAssess.status, 400);
  const msg = noAssess.outcome.issue[0].diagnostics ?? JSON.stringify(noAssess.outcome);
  assert.match(msg, /11 or less/);
  for (const n of ["livesIndependently", "fluidCupsPerDay", "midArmCircumferenceCm", "calfCircumferenceCm"]) assert.match(msg, new RegExp(n));
  const partial = evaluateScreen(mna({ calfCircumferenceCm: undefined }), ctx);
  assert.equal(partial.ok, false);
  assert.match(JSON.stringify(partial.outcome), /calfCircumferenceCm/);
});

test("MNA: total = screening + assessment; Malnutrition Indicator Score bands (24 / 23.5 / 17 / 16.5)", () => {
  const full = mnaObs(mna(MNA_ASSESS_MAX)); // 10 + 16
  assert.equal(full.valueQuantity.value, 26);
  assert.equal(nrsComp(full, "mna-assessment-score").valueQuantity.value, 16);
  assert.equal(mnaRisk(full), "normal");
  const t24 = mnaObs(mna({ ...MNA_ASSESS_MAX, selfViewNutritionScore: 0 })); // 10 + 14
  assert.equal(t24.valueQuantity.value, 24);
  assert.equal(mnaRisk(t24), "normal");
  const t235 = mnaObs(mna({ ...MNA_ASSESS_MAX, selfViewNutritionScore: 0, fluidCupsPerDay: 4 })); // 10 + 13.5
  assert.equal(t235.valueQuantity.value, 23.5);
  assert.equal(mnaRisk(t235), "at-risk");
  assert.equal(t235.interpretation[0].coding[0].code, "A");
  const t17 = mnaObs(mna({ livesIndependently: true, moreThan3PrescriptionDrugs: false, pressureSoresOrUlcers: false, fullMealsPerDay: 3, dairyDaily: true, legumesOrEggsTwiceWeekly: true, meatFishPoultryDaily: true, fruitOrVegetablesTwoPlusServings: true })); // 10 + 7
  assert.equal(t17.valueQuantity.value, 17);
  assert.equal(mnaRisk(t17), "at-risk");
  const t165 = mnaObs(mna({ livesIndependently: true, moreThan3PrescriptionDrugs: false, pressureSoresOrUlcers: false, fullMealsPerDay: 3, dairyDaily: true, legumesOrEggsTwiceWeekly: true, fruitOrVegetablesTwoPlusServings: true })); // 10 + 6.5
  assert.equal(t165.valueQuantity.value, 16.5);
  assert.equal(mnaRisk(t165), "malnourished");
  assert.equal(t165.interpretation[0].coding[0].code, "AA");
  assert.equal(mnaRisk(mnaObs(mna({}, { ...MNA_SCREEN_10, ...MNA_ASSESS_0 }))), "malnourished");
});

test("MNA: assessment item scoring and boundaries (J, K, M, N-P, Q, R)", () => {
  assert.equal(mnaAssessed({}), 0);
  assert.deepEqual([1, 2, 3, 4].map((v) => mnaAssessed({ fullMealsPerDay: v })), [0, 1, 2, 2]);
  const k = (a, b, c) => mnaAssessed({ dairyDaily: a, legumesOrEggsTwiceWeekly: b, meatFishPoultryDaily: c });
  assert.deepEqual([k(false, false, false), k(true, false, false), k(true, true, false), k(true, true, true)], [0, 0, 0.5, 1]);
  assert.deepEqual([2.9, 3, 5, 5.1].map((v) => mnaAssessed({ fluidCupsPerDay: v })), [0, 0.5, 0.5, 1]);
  assert.deepEqual([20.9, 21, 22, 22.1].map((v) => mnaAssessed({ midArmCircumferenceCm: v })), [0, 0.5, 0.5, 1]);
  assert.deepEqual([30.9, 31].map((v) => mnaAssessed({ calfCircumferenceCm: v })), [0, 1]);
  assert.deepEqual([0, 0.5, 1, 2].map((v) => mnaAssessed({ selfViewHealthScore: v })), [0, 0.5, 1, 2]);
  assert.deepEqual([0, 1, 2].map((v) => mnaAssessed({ modeOfFeedingScore: v })), [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map((v) => mnaAssessed({ selfViewNutritionScore: v })), [0, 1, 2]);
  assert.equal(mnaAssessed({ livesIndependently: true }), 1);
  assert.equal(mnaAssessed({ moreThan3PrescriptionDrugs: false }), 1);
  assert.equal(mnaAssessed({ pressureSoresOrUlcers: false }), 1);
  assert.equal(mnaAssessed({ fruitOrVegetablesTwoPlusServings: true }), 1);
});

test("MNA: screening item scoring (B weight loss, F BMI, D stress) and disclosed gaps", () => {
  // screening subtotal read back from the screening-only path (keeps BMI >= 23 so A+C+E stay at max)
  const scr = (over) => nrsComp(mnaObs(mna(over, { ...MNA_SCREEN_14, ...MNA_ASSESS_0 })), "mna-screening-score").valueInteger;
  const b = (kg) => scr({ weightLossKg3Months: kg }) - 11; // A2 + C2 + D2 + E2 + F3 = 11
  assert.deepEqual([4, 3.01, 3, 1, 0.5, 0, -2].map(b), [0, 0, 2, 2, 3, 3, 3]);
  assert.equal(scr({ weightLossKg3Months: undefined, weightLossUnknown: true }) - 11, 1);
  const f = (bmi) => scr({ bmi }) - 10; // A2 + B3 + C2 + D2 + E2 = 11 -> F = scr - 11
  assert.deepEqual([18.9, 19, 20.9, 21, 22.9, 23].map((v) => f(v) - 1), [0, 1, 1, 2, 2, 3]);
  assert.equal(scr({ psychologicalStressOrAcuteDisease: true }), 12);
  const gap = mnaObs(mna({ weightLossKg3Months: 0.5 }, { ...MNA_SCREEN_14, ...MNA_ASSESS_0 }));
  assert.match(gap.note[0].text, /no band for a weight loss under 1 kg/);
  assert.doesNotMatch(mnaObs(mna({}, MNA_SCREEN_14)).note[0].text, /no band/);
});

test("MNA: BMI from weight + height; age handling; subject carried", () => {
  const wh = P([{ name: "tool", valueCode: "mna" }, ...Object.entries({ ...MNA_SCREEN_14, bmi: undefined }).filter(([, v]) => v !== undefined).map(mnaParam),
    { name: "weight", valueQuantity: q(72, "kg") }, { name: "height", valueQuantity: q(170, "cm") }, { name: "subject", valueString: "Patient/42" }, { name: "ageYears", valueInteger: 78 }]);
  const o = mnaObs(wh);
  assert.equal(o.subject.reference, "Patient/42");
  assert.equal(o.component.at(-1).valueQuantity.value, 24.9);
  assert.doesNotMatch(o.note[0].text, /developed for older adults/);
  assert.match(mnaObs(mna({ ageYears: 50 }, MNA_SCREEN_14)).note[0].text, /developed for older adults and this patient is 50/);
  assert.equal(evaluateScreen(mna({ ageYears: 12 }, MNA_SCREEN_14), ctx).status, 422);
});

test("MNA: malformed inputs are 400 OperationOutcomes; missing screening items are all listed", () => {
  const bad400 = (over, base) => { const r = evaluateScreen(mna(over, base), ctx); assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(r.outcome.resourceType, "OperationOutcome"); return JSON.stringify(r.outcome); };
  bad400({ foodIntakeDeclineScore: 3 }, MNA_SCREEN_14);
  bad400({ mobilityScore: 1.5 }, MNA_SCREEN_14);
  bad400({ psychologicalStressOrAcuteDisease: 1 }, MNA_SCREEN_14);
  bad400({ weightLossKg3Months: 500 }, MNA_SCREEN_14);
  bad400({ bmi: 150 }, MNA_SCREEN_14);
  bad400({ selfViewHealthScore: 1.5 });
  bad400({ midArmCircumferenceCm: 400 });
  bad400({ fullMealsPerDay: -1 });
  const none = evaluateScreen(P([{ name: "tool", valueCode: "mna" }]), ctx);
  assert.equal(none.ok, false);
  const text = JSON.stringify(none.outcome);
  for (const n of ["foodIntakeDeclineScore", "mobilityScore", "psychologicalStressOrAcuteDisease", "neuropsychologicalScore", "weightLossKg3Months", "bmi"]) assert.match(text, new RegExp(n));
  assert.match(JSON.stringify(evaluateScreen(P([{ name: "tool", valueCode: "nope" }]), ctx).outcome), /nrs-2002 or mna/);
});

// ─── $assess-nutrition ────────────────────────────────────────────────────
const adult = [
  { name: "sex", valueCode: "male" },
  { name: "ageYears", valueInteger: 40 },
  { name: "weight", valueQuantity: q(60, "kg") },
  { name: "height", valueQuantity: q(175, "cm") },
];

test("assess: BMI, WHO class, and Mifflin-St Jeor BEE", () => {
  const r = evaluateAssessNutrition(P([...adult, { name: "energyFactor", valueDecimal: 1.3 }]), ctx);
  assert.equal(r.ok, true);
  const bmi = obsBy(r.body, "39156-5");
  assert.equal(bmi.valueQuantity.value, 19.6);
  assert.equal(bmi.component[0].valueCodeableConcept.coding[0].code, "normal");
  const en = obsBy(r.body, "energy-requirement");
  // 10*60 + 6.25*175 - 5*40 + 5 = 1498.75
  assert.equal(en.component[0].valueQuantity.value, 1499);
  assert.equal(en.valueQuantity.value, Math.round(1498.75 * 1.3));
});

test("assess: BEE for female uses -161", () => {
  const r = evaluateAssessNutrition(P([
    { name: "sex", valueCode: "female" }, { name: "ageYears", valueInteger: 30 },
    { name: "weight", valueQuantity: q(60, "kg") }, { name: "height", valueQuantity: q(165, "cm") },
    { name: "energyFactor", valueDecimal: 1 },
  ]), ctx);
  // 600 + 1031.25 - 150 - 161 = 1320.25
  assert.equal(obsBy(r.body, "energy-requirement").component[0].valueQuantity.value, 1320);
});

test("assess: weight loss is graded only on a standard interval", () => {
  const withPeriod = (days) => evaluateAssessNutrition(P([
    ...adult,
    { name: "usualWeight", valueQuantity: q(70, "kg") },
    { name: "usualWeightPeriodDays", valueInteger: days },
  ]), ctx);
  const o = obsBy(withPeriod(91).body, "weight-change-percent"); // 14.3% in 3 months
  assert.equal(o.valueQuantity.value, 14.3);
  assert.equal(o.component[1].valueCodeableConcept.coding[0].code, "severe");
  const odd = obsBy(withPeriod(45).body, "weight-change-percent");
  assert.equal(odd.component[1].valueCodeableConcept.coding[0].code, "no-standard-threshold");
});

test("assess: intake adequacy is computed against the requirement", () => {
  const r = evaluateAssessNutrition(P([
    ...adult,
    { name: "energyFactor", valueDecimal: 1.3 },
    { name: "energyIntakeKcalPerDay", valueDecimal: 975 },
    { name: "proteinGPerKg", valueDecimal: 1.2 },
    { name: "proteinIntakeGPerDay", valueDecimal: 36 },
  ]), ctx);
  assert.equal(obsBy(r.body, "energy-intake-adequacy").valueQuantity.value, 50); // 975 / 1948 = 50%
  assert.equal(obsBy(r.body, "protein-intake-adequacy").valueQuantity.value, 50); // 36 / 72
});

test("assess: GLIM needs phenotypic + etiologic and grades severity", () => {
  const glim = (extra) => obsBy(evaluateAssessNutrition(P([
    ...adult,
    { name: "usualWeight", valueQuantity: q(70, "kg") },
    { name: "usualWeightPeriodDays", valueInteger: 91 },
    { name: "screeningPositive", valueBoolean: true },
    ...extra,
  ]), ctx).body, "glim-malnutrition");

  // weight loss 14.3% in 3 months (phenotypic, severe) + chronic disease inflammation
  const g = glim([{ name: "inflammation", valueCode: "chronic-disease" }]);
  assert.equal(g.valueBoolean, true);
  const sev = g.component.find((c) => c.code.coding[0].code === "severity");
  assert.equal(sev.valueCodeableConcept.coding[0].code, "severe");

  // phenotypic only (no etiologic) -> not met
  const g2 = glim([{ name: "inflammation", valueCode: "none" }, { name: "intakePercentOfRequirement", valueDecimal: 100 }, { name: "intakeReductionDays", valueInteger: 30 }]);
  assert.equal(g2.valueBoolean, false);
});

test("assess: GLIM is skipped after a negative screen; flagged when screen status is missing", () => {
  const neg = evaluateAssessNutrition(P([...adult, { name: "screeningPositive", valueBoolean: false }, { name: "inflammation", valueCode: "chronic-disease" }]), ctx);
  assert.equal(obsBy(neg.body, "glim-malnutrition"), undefined);
  const unk = evaluateAssessNutrition(P([...adult, { name: "inflammation", valueCode: "chronic-disease" }]), ctx);
  assert.match(obsBy(unk.body, "glim-malnutrition").note[0].text, /screeningPositive/);
});

test("assess: Asian BMI cut-offs differ from the default set", () => {
  const run = (set) => obsBy(evaluateAssessNutrition(P([
    { name: "sex", valueCode: "female" }, { name: "ageYears", valueInteger: 40 },
    { name: "weight", valueQuantity: q(52, "kg") }, { name: "height", valueQuantity: q(160, "cm") }, // BMI 20.3
    { name: "screeningPositive", valueBoolean: true },
    { name: "inflammation", valueCode: "chronic-disease" },
    { name: "glimBmiCutoffSet", valueCode: set },
  ]), ctx).body, "glim-malnutrition");
  // 20.3 is not < 20 (default) nor < 18.5 (asian) -> no low BMI either way
  assert.equal(run("default").valueBoolean, false);
  assert.equal(run("asian").valueBoolean, false);
});

test("assess: indicators map to NCP domains; BD also gets the laboratory category", () => {
  const r = evaluateAssessNutrition(P([
    ...adult,
    part("indicator", [
      { name: "domain", valueCode: "BD" },
      { name: "display", valueString: "Haemoglobin" },
      { name: "code", valueString: "718-7" },
      { name: "system", valueString: "http://loinc.org" },
      { name: "value", valueQuantity: q(9.1, "g/dL") },
    ]),
    part("indicator", [
      { name: "domain", valueCode: "FH" },
      { name: "display", valueString: "Meals per day" },
      { name: "value", valueString: "1" },
    ]),
  ]), ctx);
  assert.equal(r.ok, true);
  const hb = obsBy(r.body, "718-7");
  const cats = hb.category.flatMap((c) => c.coding.map((x) => x.code));
  assert.ok(cats.includes("nutrition-assessment") && cats.includes("BD") && cats.includes("laboratory"));
  assert.equal(evaluateAssessNutrition(P([...adult, part("indicator", [{ name: "domain", valueCode: "ZZ" }, { name: "display", valueString: "x" }, { name: "value", valueString: "1" }])]), ctx).ok, false);
});

test("assess: children are redirected to $evaluate-growth", () => {
  const r = evaluateAssessNutrition(P([{ name: "ageYears", valueInteger: 9 }, { name: "weight", valueQuantity: q(25, "kg") }]), ctx);
  assert.equal(r.status, 422);
  assert.match(r.outcome.issue[0].diagnostics, /evaluate-growth/);
});

test("assess: refuses to guess units", () => {
  assert.equal(evaluateAssessNutrition(P([...adult.slice(0, 2), { name: "weight", valueQuantity: q(130, "lb") }]), ctx).ok, false);
});

// ─── $diagnose ────────────────────────────────────────────────────────────
const pes = (over = []) => part("diagnosis", [
  { name: "domain", valueCode: "intake" },
  { name: "problem", valueString: "Inadequate oral intake" },
  { name: "etiology", valueString: "poor appetite" },
  { name: "etiology", valueString: "oral thrush" },
  { name: "signsSymptoms", valueString: "intake ~50% of estimated needs for 2 weeks" },
  ...over,
]);

test("diagnose: builds a Condition with a PES statement", () => {
  const r = evaluateDiagnose(P([{ name: "subject", valueString: "Patient/42" }, pes([{ name: "severity", valueCode: "moderate" }])]), ctx);
  assert.equal(r.ok, true);
  const c = r.body.entry[0].resource;
  assert.equal(c.resourceType, "Condition");
  assert.equal(c.subject.reference, "Patient/42");
  assert.equal(c.note[0].text, "Inadequate oral intake related to poor appetite; oral thrush as evidenced by intake ~50% of estimated needs for 2 weeks.");
  assert.equal(c.severity.coding[0].code, "6736007");
  assert.equal(c.verificationStatus.coding[0].code, "provisional");
});

test("diagnose: PES needs etiology and signs; domain validated; subject required", () => {
  const missingE = part("diagnosis", [{ name: "domain", valueCode: "clinical" }, { name: "problem", valueString: "Underweight" }, { name: "signsSymptoms", valueString: "BMI 17" }]);
  assert.match(evaluateDiagnose(P([{ name: "subject", valueString: "Patient/1" }, missingE]), ctx).outcome.issue[0].diagnostics, /etiology/);
  const badDomain = part("diagnosis", [{ name: "domain", valueCode: "nope" }, { name: "problem", valueString: "x" }]);
  assert.match(evaluateDiagnose(P([{ name: "subject", valueString: "Patient/1" }, badDomain]), ctx).outcome.issue[0].diagnostics, /domain/);
  assert.equal(evaluateDiagnose(P([pes()]), ctx).ok, false);
});

test("diagnose: problemCode shortcut and pass-through coding; unknown code without system is rejected", () => {
  const ok = evaluateDiagnose(P([{ name: "subject", valueString: "Patient/1" }, pes([{ name: "problemCode", valueString: "malnutrition" }])]), ctx);
  assert.equal(ok.body.entry[0].resource.code.coding[0].code, "44054006");
  const own = evaluateDiagnose(P([{ name: "subject", valueString: "Patient/1" }, pes([{ name: "problemSystem", valueString: "urn:my:terms" }, { name: "problemCode", valueString: "NI-2.1" }])]), ctx);
  assert.equal(own.body.entry[0].resource.code.coding[0].system, "urn:my:terms");
  assert.equal(evaluateDiagnose(P([{ name: "subject", valueString: "Patient/1" }, pes([{ name: "problemCode", valueString: "NI-2.1" }])]), ctx).ok, false);
});

// ─── $intervene ───────────────────────────────────────────────────────────
const plan = () => P([
  { name: "subject", valueString: "Patient/42" },
  { name: "addresses", valueString: "Condition/7" },
  part("goal", [
    { name: "description", valueString: "Reach 65 kg" },
    { name: "measure", valueString: "Body weight" },
    { name: "direction", valueCode: "increase" },
    { name: "baseline", valueQuantity: q(60, "kg") },
    { name: "target", valueQuantity: q(65, "kg") },
    { name: "dueDate", valueDate: "2026-12-31" },
  ]),
  part("nutritionOrder", [
    { name: "kind", valueCode: "oral-diet" },
    { name: "type", valueString: "High-energy high-protein diet" },
    part("nutrient", [{ name: "name", valueString: "Energy" }, { name: "amount", valueQuantity: q(2000, "kcal/d") }]),
    { name: "texture", valueString: "soft" },
  ]),
  part("nutritionOrder", [{ name: "kind", valueCode: "supplement" }, { name: "productName", valueString: "RUSF" }, { name: "quantity", valueQuantity: q(1, "sachet") }]),
  part("education", [{ name: "topic", valueString: "Energy-dense local foods" }, { name: "audience", valueString: "Caregiver" }]),
  part("counseling", [{ name: "topic", valueString: "Meal frequency" }, { name: "approach", valueString: "Motivational interviewing" }]),
  part("coordination", [{ name: "reason", valueString: "Oral thrush review" }, { name: "with", valueString: "Physician" }]),
]);

test("intervene: CarePlan links goals and activities by fullUrl; defaults are conservative", () => {
  const r = evaluateIntervene(plan(), ctx);
  assert.equal(r.ok, true);
  const types = r.body.entry.map((e) => e.resource.resourceType);
  assert.deepEqual(types.filter((t) => t === "NutritionOrder").length, 2);
  assert.equal(types.filter((t) => t === "ServiceRequest").length, 3);
  assert.equal(types.filter((t) => t === "Goal").length, 1);
  const cp = r.body.entry[0].resource;
  assert.equal(cp.resourceType, "CarePlan");
  assert.equal(cp.status, "draft");
  assert.equal(cp.intent, "proposal");
  const urls = new Set(r.body.entry.map((e) => e.fullUrl));
  for (const g of cp.goal) assert.ok(urls.has(g.reference));
  for (const a of cp.activity) assert.ok(urls.has(a.reference.reference));
  const goal = r.body.entry.find((e) => e.resource.resourceType === "Goal").resource;
  assert.equal(goal.lifecycleStatus, "proposed");
  assert.equal(goal.target[0].detailQuantity.value, 65);
  const diet = r.body.entry.find((e) => e.resource.oralDiet).resource;
  assert.equal(diet.oralDiet.nutrient[0].amount.value, 2000);
  assert.equal(diet.patient.reference, "Patient/42");
});

test("intervene: validates kinds, statuses and required content", () => {
  assert.equal(evaluateIntervene(P([{ name: "subject", valueString: "Patient/1" }, part("nutritionOrder", [{ name: "kind", valueCode: "iv" }])]), ctx).ok, false);
  assert.equal(evaluateIntervene(P([{ name: "subject", valueString: "Patient/1" }, { name: "status", valueCode: "completed" }, part("education", [{ name: "topic", valueString: "x" }])]), ctx).ok, false);
  assert.equal(evaluateIntervene(P([{ name: "subject", valueString: "Patient/1" }]), ctx).ok, false);
  const active = evaluateIntervene(P([{ name: "subject", valueString: "Patient/1" }, { name: "status", valueCode: "active" }, { name: "intent", valueCode: "order" }, part("counseling", [{ name: "topic", valueString: "x" }])]), ctx);
  assert.equal(active.body.entry[0].resource.status, "active");
});

// ─── Goal/$evaluate ───────────────────────────────────────────────────────
const goalP = (direction, { baseline, target, current, extra = [] }) => P([
  { name: "subject", valueString: "Patient/42" },
  part("goal", [
    { name: "description", valueString: "g" },
    { name: "direction", valueCode: direction },
    ...(baseline !== undefined ? [{ name: "baseline", valueQuantity: q(baseline, "kg") }] : []),
    ...(target !== undefined ? [{ name: "target", valueQuantity: q(target, "kg") }] : []),
    { name: "current", valueQuantity: q(current, "kg") },
    ...extra,
  ]),
]);
const statusOf = (r) => r.body.entry.find((e) => e.resource.resourceType === "Goal").resource.achievementStatus.coding[0].code;

test("goals: increase — improving / worsening / no-change / achieved", () => {
  assert.equal(statusOf(evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 62 }), ctx)), "improving");
  assert.equal(statusOf(evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 58 }), ctx)), "worsening");
  assert.equal(statusOf(evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 60 }), ctx)), "no-change");
  assert.equal(statusOf(evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 65.5 }), ctx)), "achieved");
});

test("goals: decrease and maintain", () => {
  assert.equal(statusOf(evaluateGoals(goalP("decrease", { baseline: 90, target: 80, current: 85 }), ctx)), "improving");
  assert.equal(statusOf(evaluateGoals(goalP("decrease", { baseline: 90, target: 80, current: 79 }), ctx)), "achieved");
  const keep = (cur) => evaluateGoals(goalP("maintain", { current: cur, extra: [{ name: "lowerBound", valueQuantity: q(60, "kg") }, { name: "upperBound", valueQuantity: q(66, "kg") }] }), ctx);
  assert.equal(statusOf(keep(63)), "sustaining");
  assert.equal(statusOf(keep(58)), "not-achieved");
});

test("goals: without a baseline direction is not guessed; unit mismatch is an error", () => {
  assert.equal(statusOf(evaluateGoals(goalP("increase", { target: 65, current: 62 }), ctx)), "in-progress");
  const mismatch = P([{ name: "subject", valueString: "Patient/1" }, part("goal", [{ name: "description", valueString: "g" }, { name: "direction", valueCode: "increase" }, { name: "target", valueQuantity: q(65, "kg") }, { name: "current", valueQuantity: q(62000, "g") }])]);
  assert.match(evaluateGoals(mismatch, ctx).outcome.issue[0].diagnostics, /unit mismatch/);
});

test("goals: each Goal references a monitoring Observation as its outcome", () => {
  const r = evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 62 }), ctx);
  const goal = r.body.entry.find((e) => e.resource.resourceType === "Goal").resource;
  const obsEntry = r.body.entry.find((e) => e.fullUrl === goal.outcomeReference[0].reference);
  assert.equal(obsEntry.resource.resourceType, "Observation");
  assert.equal(obsEntry.resource.valueQuantity.value, 62);
});

// ─── $ncp-document ────────────────────────────────────────────────────────
test("ncp-document: full ADIME round trip from the other operations' Bundles", () => {
  const screen = evaluateScreen(P([{ name: "bmi", valueDecimal: 17 }, { name: "weightLossPercent3to6Months", valueDecimal: 12 }, { name: "acuteDiseaseNoIntake", valueBoolean: false }, { name: "subject", valueString: "Patient/42" }]), ctx).body;
  const assess = evaluateAssessNutrition(P([...adult, { name: "subject", valueString: "Patient/42" }]), ctx).body;
  const dx = evaluateDiagnose(P([{ name: "subject", valueString: "Patient/42" }, pes()]), ctx).body;
  const iv = evaluateIntervene(plan(), ctx).body;
  const me = evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 62 }), ctx).body;

  const doc = evaluateNcpDocument(P([
    { name: "subject", valueString: "Patient/42" },
    { name: "author", valueString: "Practitioner/9" },
    ...[screen, assess, dx, iv, me].map((b) => ({ name: "resource", resource: b })),
  ]), ctx);
  assert.equal(doc.ok, true);
  const b = doc.body;
  assert.equal(b.type, "document");
  const comp = b.entry[0].resource;
  assert.equal(comp.resourceType, "Composition");
  assert.equal(comp.author[0].reference, "Practitioner/9");
  assert.deepEqual(comp.section.map((s) => s.code.coding[0].code), [
    "nutrition-screening", "nutrition-assessment", "nutrition-diagnosis", "nutrition-intervention", "nutrition-monitoring",
  ]);
  // Every section reference resolves to a bundle entry (urn:uuid links preserved)
  const urls = new Set(b.entry.map((e) => e.fullUrl));
  for (const s of comp.section) for (const e of s.entry ?? []) assert.ok(urls.has(e.reference), e.reference);
  // The CarePlan's own references still resolve inside the document
  const cp = b.entry.find((e) => e.resource.resourceType === "CarePlan").resource;
  for (const a of cp.activity) assert.ok(urls.has(a.reference.reference));
  // Monitoring Goal (with achievementStatus) lands in M&E, not Intervention
  const interventionTypes = comp.section[3].entry.map((e) => b.entry.find((x) => x.fullUrl === e.reference).resource);
  assert.ok(interventionTypes.every((r) => !(r.resourceType === "Goal" && r.achievementStatus)));
});

test("ncp-document: empty ADIME sections get an emptyReason; mismatched patients are rejected", () => {
  const dx = evaluateDiagnose(P([{ name: "subject", valueString: "Patient/42" }, pes()]), ctx).body;
  const doc = evaluateNcpDocument(P([{ name: "subject", valueString: "Patient/42" }, { name: "author", valueString: "A. Dietitian" }, { name: "resource", resource: dx }]), ctx);
  const comp = doc.body.entry[0].resource;
  assert.equal(comp.author[0].display, "A. Dietitian");
  assert.equal(comp.section.find((s) => s.code.coding[0].code === "nutrition-assessment").emptyReason.coding[0].code, "notstarted");
  assert.equal(comp.section.some((s) => s.code.coding[0].code === "nutrition-screening"), false);

  const other = evaluateNcpDocument(P([{ name: "subject", valueString: "Patient/99" }, { name: "author", valueString: "X" }, { name: "resource", resource: dx }]), ctx);
  assert.equal(other.ok, false);
  assert.match(other.outcome.issue[0].diagnostics, /one patient/i);
});

test("ncp-document: unsupported resource types and missing author are rejected; narrative is escaped", () => {
  const base = [{ name: "subject", valueString: "Patient/1" }];
  assert.equal(evaluateNcpDocument(P([...base, { name: "author", valueString: "X" }, { name: "resource", resource: { resourceType: "Patient" } }]), ctx).ok, false);
  assert.equal(evaluateNcpDocument(P([...base, { name: "resource", resource: { resourceType: "Observation", code: { text: "x" } } }]), ctx).ok, false);
  const doc = evaluateNcpDocument(P([...base, { name: "author", valueString: "X" }, { name: "resource", resource: { resourceType: "Observation", code: { text: "<script>alert(1)</script>" }, valueString: "a" } }]), ctx);
  const divs = doc.body.entry[0].resource.section.filter((x) => x.text).map((x) => x.text.div).join("");
  assert.ok(divs.includes("&lt;script&gt;") && !divs.includes("<script>"));
});

// ─── routing / capability ─────────────────────────────────────────────────
test("registry and CapabilityStatement agree", () => {
  const ops = [["Observation", "$screen"], ["Observation", "$assess-nutrition"], ["Condition", "$diagnose"], ["CarePlan", "$intervene"], ["Goal", "$evaluate"], ["Bundle", "$ncp-document"]];
  for (const [t, a] of ops) assert.equal(typeof ncpOperationFor(t, a), "function", `${t}/${a}`);
  assert.equal(ncpOperationFor("Observation", "$evaluate-growth"), null); // handled by the Phase 1 route
  const cap = buildCapabilityStatement("https://x.test");
  const declared = cap.rest[0].resource.flatMap((r) => (r.operation ?? []).map((o) => `${r.type}/$${o.name}`));
  for (const [t, a] of ops) assert.ok(declared.includes(`${t}/${a}`), `${t}/${a} missing from CapabilityStatement`);
});

// ─── Supabase-backed diagnostic terminology ───────────────────────────────
const TERMS = {
  "NI-5.2": { code: "NI-5.2", term: "Evident protein-energy malnutrition", domain: "intake", class_name: "Nutrient Intake", specify_required: false, use_with_caution: false, edition: "2006" },
  "NI-5.1": { code: "NI-5.1", term: "Increased nutrient needs", domain: "intake", class_name: "Nutrient Intake", specify_required: true, use_with_caution: false, specify_options: null, edition: "2006" },
  "NI-55.1": { code: "NI-55.1", term: "Inadequate mineral intake", domain: "intake", class_name: "Mineral", specify_required: true, use_with_caution: false, specify_options: ["Calcium", "Iron", "Potassium", "Zinc", "Other"], edition: "2006" },
  "NB-1.2": { code: "NB-1.2", term: "Harmful beliefs/attitudes about food or nutrition-related topics", domain: "behavioral-environmental", class_name: "Knowledge and Beliefs", specify_required: false, use_with_caution: true, edition: "2006" },
};
const tctx = { ...ctx, terms: TERMS };
const pesParts = [{ name: "etiology", valueString: "inadequate intake" }, { name: "signsSymptoms", valueString: "BMI 16.2" }];
const dxBody = (extra) => P([{ name: "subject", valueString: "Patient/1" }, part("diagnosis", [...pesParts, ...extra])]);

test("diagnosisCodesRequested only returns NI/NC/NB codes without a custom system", () => {
  const b = P([
    part("diagnosis", [{ name: "problemCode", valueString: "ni-5.2" }]),
    part("diagnosis", [{ name: "problemCode", valueString: "NC-3.1" }]),
    part("diagnosis", [{ name: "problemCode", valueString: "NI-2.1" }, { name: "problemSystem", valueString: "urn:own" }]),
    part("diagnosis", [{ name: "problemCode", valueString: "malnutrition" }]),
    part("diagnosis", [{ name: "problemCode", valueString: "NI-5.2" }]),
  ]);
  assert.deepEqual(diagnosisCodesRequested(b).sort(), ["NC-3.1", "NI-5.2"]);
});

test("diagnose: an NI code resolves problem text, domain and coding from the terminology", () => {
  const r = evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-5.2" }]), tctx);
  assert.equal(r.ok, true);
  const c = r.body.entry[0].resource;
  assert.equal(c.code.text, "Evident protein-energy malnutrition");
  assert.deepEqual(c.code.coding[0], { system: "https://x.test/fhir/CodeSystem/ncp-diagnosis", version: "2006", code: "NI-5.2", display: "Evident protein-energy malnutrition" });
  assert.equal(c.category[2].coding[0].code, "intake");
  assert.match(c.note[0].text, /^Evident protein-energy malnutrition related to inadequate intake as evidenced by BMI 16.2\.$/);
});

test("diagnose: unknown code, domain conflict, and unavailable terminology are explicit errors", () => {
  assert.match(evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-9.9" }]), tctx).outcome.issue[0].diagnostics, /not in the NCP diagnostic terminology/);
  assert.match(evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-5.2" }, { name: "domain", valueCode: "clinical" }]), tctx).outcome.issue[0].diagnostics, /conflicts/);
  const down = evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-5.2" }]), { ...ctx, termsError: "relation does not exist" });
  assert.equal(down.status, 503);
  assert.match(down.outcome.issue[0].diagnostics, /sql\/017/);
});

test("diagnose: (specify) terms need problemSpecify and show the sheet's options", () => {
  const miss = evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-55.1" }]), tctx);
  assert.equal(miss.ok, false);
  assert.match(miss.outcome.issue[0].diagnostics, /problemSpecify.*Calcium, Iron/);
  const ok = evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-55.1" }, { name: "problemSpecify", valueString: "Iron" }]), tctx);
  assert.equal(ok.body.entry[0].resource.code.text, "Inadequate mineral intake (Iron)");
  assert.ok(ok.body.entry[0].resource.extension.some((x) => x.url.endsWith("pes-specify") && x.valueString === "Iron"));
});

test("diagnose: use-with-caution terms add a note; an explicit problem text is kept", () => {
  const r = evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NB-1.2" }, { name: "problem", valueString: "Harmful beliefs about breastfeeding" }]), tctx);
  const c = r.body.entry[0].resource;
  assert.equal(c.code.text, "Harmful beliefs about breastfeeding");
  assert.equal(c.note.length, 2);
  assert.match(c.note[1].text, /use with caution/);
});

test("CodeSystem: concepts, count and properties built from rows", () => {
  const cs = buildNcpCodeSystem("https://x.test", Object.values(TERMS));
  assert.equal(cs.resourceType, "CodeSystem");
  assert.equal(cs.url, "https://x.test/fhir/CodeSystem/ncp-diagnosis");
  assert.equal(cs.count, 4);
  const c = cs.concept.find((x) => x.code === "NB-1.2");
  assert.equal(c.property.find((p) => p.code === "use-with-caution").valueBoolean, true);
});

// ─── Every canonical URL the facade emits must resolve ────────────────────
const BASE = ctx.base;

function emittedSamples() {
  const out = [];
  const keep = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); out.push(r.body); return r.body; };
  const sub = { name: "subject", valueString: "Patient/42" };

  // Screening at low / medium / high risk
  for (const [bmi, loss, acute] of [[25, 0, false], [19, 0, false], [17, 12, true]]) {
    keep(evaluateScreen(P([sub, { name: "bmi", valueDecimal: bmi }, { name: "weightLossPercent3to6Months", valueDecimal: loss }, { name: "acuteDiseaseNoIntake", valueBoolean: acute }]), ctx));
  }
  // NRS-2002: final screening (at risk / not at risk) and initial-screening-negative
  keep(evaluateScreen(nrs({ bmi: 17.5, impaired: true, loss: 0, intake: 40, sev: 2, age: 75 }), ctx));
  keep(evaluateScreen(nrs({ bmi: 19, impaired: false, loss: 0, intake: 90, sev: 0, age: 50 }), ctx));
  keep(evaluateScreen(nrs({ bmi: 24, loss: 0, intake: 100, sev: 1, age: 50 }), ctx));
  // MNA: screening-only normal, then full assessment at every risk category
  keep(evaluateScreen(mna({ subject: "Patient/42", ageYears: 80 }, MNA_SCREEN_14), ctx));
  keep(evaluateScreen(mna(MNA_ASSESS_MAX), ctx));
  keep(evaluateScreen(mna({ ...MNA_ASSESS_MAX, selfViewNutritionScore: 0, fluidCupsPerDay: 4 }), ctx));
  keep(evaluateScreen(mna(), ctx));
  // Assessment: everything on, then intake-only (no factor), then several loss intervals and BMI classes
  keep(evaluateAssessNutrition(P([
    ...adult, sub,
    { name: "usualWeight", valueQuantity: q(70, "kg") }, { name: "usualWeightPeriodDays", valueInteger: 91 },
    { name: "energyFactor", valueDecimal: 1.3 }, { name: "proteinGPerKg", valueDecimal: 1.2 },
    { name: "energyIntakeKcalPerDay", valueDecimal: 975 }, { name: "proteinIntakeGPerDay", valueDecimal: 36 },
    { name: "screeningPositive", valueBoolean: true }, { name: "inflammation", valueCode: "chronic-disease" },
    part("indicator", [{ name: "domain", valueCode: "FH" }, { name: "display", valueString: "Meals per day" }, { name: "value", valueString: "1" }]),
  ]), ctx));
  keep(evaluateAssessNutrition(P([...adult, { name: "energyIntakeKcalPerDay", valueDecimal: 900 }, { name: "proteinIntakeGPerDay", valueDecimal: 30 }]), ctx));
  for (const days of [7, 30, 91, 182, 45]) {
    for (const usual of [60.5, 63, 70]) {
      keep(evaluateAssessNutrition(P([...adult, { name: "usualWeight", valueQuantity: q(usual, "kg") }, { name: "usualWeightPeriodDays", valueInteger: days }]), ctx));
    }
  }
  for (const [kg, cm] of [[40, 175], [45, 175], [50, 175], [70, 175], [85, 175], [100, 175], [115, 175], [140, 175]]) {
    keep(evaluateAssessNutrition(P([{ name: "sex", valueCode: "male" }, { name: "ageYears", valueInteger: 40 }, { name: "weight", valueQuantity: q(kg, "kg") }, { name: "height", valueQuantity: q(cm, "cm") }]), ctx));
  }
  keep(evaluateAssessNutrition(P([...adult, { name: "screeningPositive", valueBoolean: true }, { name: "muscleMass", valueCode: "severe" }, { name: "inflammation", valueCode: "acute-disease-or-injury" }]), ctx));
  keep(evaluateAssessNutrition(P([...adult, { name: "screeningPositive", valueBoolean: true }, { name: "muscleMass", valueCode: "mild-moderate" }, { name: "inflammation", valueCode: "chronic-disease" }]), ctx));

  // Diagnose (resolved term, with specify + caution), intervene, evaluate, document
  keep(evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NI-55.1" }, { name: "problemSpecify", valueString: "Iron" }, { name: "severity", valueCode: "severe" }]), tctx));
  keep(evaluateDiagnose(dxBody([{ name: "problemCode", valueString: "NB-1.2" }]), tctx));
  keep(evaluateDiagnose(dxBody([{ name: "domain", valueCode: "clinical" }, { name: "problem", valueString: "Underweight" }, { name: "problemCode", valueString: "underweight" }]), tctx));
  const iv = keep(evaluateIntervene(plan(), ctx));
  const me = keep(evaluateGoals(goalP("increase", { baseline: 60, target: 65, current: 62 }), ctx));
  keep(evaluateNcpDocument(P([{ name: "subject", valueString: "Patient/42" }, { name: "author", valueString: "X" }, { name: "resource", resource: iv }, { name: "resource", resource: me }]), ctx));

  // Phase 1 growth Observations, every status either reference can emit
  for (const status of ["small", "appropriate", "large"]) {
    out.push(buildFentonObservation(BASE, { sex: "male", gestAgeWeeks: 32, day: 3, metric: "weight", value: 1500, unit: "g" }, { z: 0.1, percentile: 50, status }));
  }
  for (const status of ["severe thinness", "thinness", "normal", "overweight", "obesity"]) {
    out.push(buildBmiForAgeObservation(BASE, { ageMonths: 120 }, { z: 0.1, percentile: 50, status }));
  }
  return out;
}

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === "object") {
    visit(node);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

test("every emitted CodeSystem code and extension URL has a definition", () => {
  const samples = emittedSamples();
  const csPrefix = `${BASE}/fhir/CodeSystem/`;
  const sdPrefix = `${BASE}/fhir/StructureDefinition/`;
  const missing = new Set();
  let checkedCodes = 0;
  let checkedExt = 0;
  for (const sample of samples) {
    walk(sample, (o) => {
      if (typeof o.system === "string" && o.system.startsWith(csPrefix) && typeof o.code === "string") {
        const name = o.system.slice(csPrefix.length);
        if (name === "ncp-diagnosis") return; // Supabase-backed, covered above
        checkedCodes++;
        const def = codeSystemResource(BASE, name);
        if (!def) missing.add(`CodeSystem ${name}`);
        else if (!def.concept.some((c) => c.code === o.code)) missing.add(`code "${o.code}" in ${name}`);
      }
      if (typeof o.url === "string" && o.url.startsWith(sdPrefix)) {
        checkedExt++;
        if (!structureDefinitionResource(BASE, o.url.slice(sdPrefix.length))) missing.add(`StructureDefinition ${o.url.slice(sdPrefix.length)}`);
      }
    });
  }
  assert.deepEqual([...missing], []);
  assert.ok(checkedCodes > 100 && checkedExt > 10, `sanity: ${checkedCodes} codes, ${checkedExt} extensions checked`);
});

test("CapabilityStatement operation links and OperationDefinitions match one to one", () => {
  const cap = buildCapabilityStatement(BASE);
  const linked = cap.rest[0].resource.flatMap((r) => (r.operation ?? []).map((o) => o.definition));
  const ids = linked.map((u) => u.slice(`${BASE}/fhir/OperationDefinition/`.length));
  for (const id of ids) assert.ok(operationDefinitionResource(BASE, id), `missing OperationDefinition ${id}`);
  assert.deepEqual([...ids].sort(), [...OPERATION_DEFINITION_IDS].sort());
  const types = cap.rest[0].resource.map((r) => r.type);
  for (const t of ["CodeSystem", "OperationDefinition", "StructureDefinition"]) assert.ok(types.includes(t));
});

test("OperationDefinitions describe the parameters each operation reads", () => {
  const names = (id) => operationDefinitionResource(BASE, id).parameter.filter((p) => p.use === "in").map((p) => p.name);
  for (const n of ["tool", "acuteDiseaseNoIntake", "bmi", "effectiveDateTime", "height", "subject", "usualWeight", "weight", "weightLossPercent3to6Months",
    "ageYears", "birthDate", "weightLossPercent", "weightLossPeriodMonths", "intakePercentOfRequirement", "impairedGeneralCondition", "diseaseSeverityScore", "severelyIll", "reducedIntakeLastWeek",
    ...[...MNA_SCREEN_ITEM_NAMES, ...MNA_ASSESS_ITEM_NAMES]]) {
    assert.ok(names("Observation-screen").includes(n), `Observation-screen is missing parameter ${n}`);
  }
  for (const n of ["subject", "diagnosis"]) assert.ok(names("Condition-diagnose").includes(n));
  for (const n of ["subject", "author", "resource"]) assert.ok(names("Bundle-ncp-document").includes(n));
  const diag = operationDefinitionResource(BASE, "Condition-diagnose").parameter.find((p) => p.name === "diagnosis");
  assert.deepEqual(diag.part.map((x) => x.name), ["problemCode", "problemSystem", "problemDisplay", "problemSpecify", "domain", "problem", "etiology", "signsSymptoms", "severity", "verificationStatus", "evidence", "recordedDate"]);
  for (const id of OPERATION_DEFINITION_IDS) {
    const od = operationDefinitionResource(BASE, id);
    assert.equal(od.url, `${BASE}/fhir/OperationDefinition/${id}`);
    assert.equal(od.parameter.at(-1).use, "out");
    for (const prm of od.parameter) assert.ok(prm.min === 0 || prm.min === 1);
  }
});

test("static conformance resources are well formed", () => {
  for (const n of STATIC_CODE_SYSTEM_NAMES) {
    const cs = codeSystemResource(BASE, n);
    assert.equal(cs.url, `${BASE}/fhir/CodeSystem/${n}`);
    assert.equal(new Set(cs.concept.map((c) => c.code)).size, cs.concept.length, `${n} has duplicate codes`);
    if (cs.content === "complete") assert.equal(cs.count, cs.concept.length);
  }
  for (const n of STRUCTURE_DEFINITION_NAMES) {
    const sd = structureDefinitionResource(BASE, n);
    assert.equal(sd.differential.element.find((e) => e.path === "Extension.url").fixedUri, sd.url);
  }
  assert.equal(staticConformanceResource("CodeSystem", "nope", BASE), null);
  assert.equal(staticConformanceResource("Patient", "x", BASE), null);
});
