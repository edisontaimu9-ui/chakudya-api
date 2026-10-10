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
  assert.match(JSON.stringify(evaluateScreen(P([{ name: "tool", valueCode: "nope" }]), ctx).outcome), /pg-sga/);
});

// ─── $screen — SGA ────────────────────────────────────────────────────────
const SGA_PARAM_NAMES = ["weightLossPercent6Months", "weightChange2Weeks", "weightChange2WeeksGrade", "dietaryIntake", "dietaryIntakeGrade", "nauseaDailyOver2Weeks", "vomitingDailyOver2Weeks", "diarrhoeaDailyOver2Weeks", "anorexiaDailyOver2Weeks", "functionalCapacity", "functionalChange2Weeks", "overallRating", "underEyesFat", "temple"];
const SGA_BASE = {
  weightLossPercent6Months: 2, weightChange2Weeks: "no-change-normal-weight", dietaryIntake: "no-change-adequate",
  nauseaDailyOver2Weeks: false, vomitingDailyOver2Weeks: false, diarrhoeaDailyOver2Weeks: false, anorexiaDailyOver2Weeks: false,
  functionalCapacity: "no-dysfunction", functionalChange2Weeks: "no-change", overallRating: "A",
};
const sgaParam = ([name, v]) =>
  typeof v === "boolean" ? { name, valueBoolean: v } : typeof v === "number" ? { name, valueDecimal: v } : { name, valueCode: v };
const sga = (over = {}) =>
  P([{ name: "tool", valueCode: "sga" }, ...Object.entries({ ...SGA_BASE, ...over }).filter(([, v]) => v !== undefined).map(sgaParam)]);
const sgaObs = (b) => { const r = evaluateScreen(b, ctx); assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body.entry[0].resource; };
const sgaGrade = (o, code) => nrsComp(o, code).valueCodeableConcept.coding[0].code;
const sgaFail = (b, status = 400) => { const r = evaluateScreen(b, ctx); assert.equal(r.ok, false); assert.equal(r.status, status); return JSON.stringify(r.outcome); };

test("SGA: the overall rating is the assessor's input and is carried, never computed", () => {
  for (const [rating, interp] of [["A", "N"], ["B", "A"], ["C", "AA"]]) {
    // identical, all-A history; only the stated rating changes the result
    const o = sgaObs(sga({ overallRating: rating.toLowerCase() }));
    assert.equal(o.valueCodeableConcept.coding[0].code, rating);
    assert.equal(o.interpretation[0].coding[0].code, interp);
    assert.equal(o.code.coding[0].code, "sga");
  }
  assert.match(sgaObs(sga({ overallRating: "C" })).note[0].text, /no rule for combining/);
  assert.match(sgaFail(sga({ overallRating: undefined })), /overallRating/);
  assert.match(sgaFail(sga({ overallRating: "D" })), /A, B or C/);
});

test("SGA: % weight loss over 6 months is derived and graded (0-<5 A, 5-10 B, >10 C)", () => {
  const g = (pct) => sgaGrade(sgaObs(sga({ weightLossPercent6Months: pct })), "sga-weight-change-6-months-grade");
  assert.deepEqual([-3, 0, 4.9, 5, 10, 10.1, 25].map(g), ["A", "A", "A", "B", "B", "C", "C"]);
  const o = sgaObs(P([{ name: "tool", valueCode: "sga" }, ...Object.entries({ ...SGA_BASE, weightLossPercent6Months: undefined }).filter(([, v]) => v !== undefined).map(sgaParam),
    { name: "usualWeight", valueQuantity: q(80, "kg") }, { name: "weight", valueQuantity: q(70, "kg") }]));
  assert.equal(nrsComp(o, "sga-weight-loss-percent-6-months").valueQuantity.value, 12.5);
  assert.equal(sgaGrade(o, "sga-weight-change-6-months-grade"), "C");
  assert.match(sgaFail(sga({ weightLossPercent6Months: undefined })), /usualWeight/);
});

test("SGA: history descriptors map to the printed columns; two-column descriptors need the assessor's pick", () => {
  const w = (code, grade) => sgaGrade(sgaObs(sga({ weightChange2Weeks: code, weightChange2WeeksGrade: grade })), "sga-weight-change-2-weeks-grade");
  assert.deepEqual(["no-change-normal-weight", "increase-within-5-percent"].map((c) => w(c)), ["A", "A"]);
  assert.deepEqual(["no-change-below-usual-weight", "increase-within-5-10-percent"].map((c) => w(c)), ["B", "B"]);
  assert.equal(w("decrease"), "C");
  assert.equal(w("increase-1-level-above", "A"), "A");
  assert.equal(w("increase-1-level-above", "B"), "B");
  assert.match(sgaFail(sga({ weightChange2Weeks: "increase-1-level-above" })), /columns A and B/);
  assert.match(sgaFail(sga({ weightChange2Weeks: "increase-1-level-above", weightChange2WeeksGrade: "C" })), /columns A and B/);
  assert.match(sgaFail(sga({ weightChange2Weeks: "decrease", weightChange2WeeksGrade: "A" })), /only in column C/);

  const d = (code, grade) => sgaGrade(sgaObs(sga({ dietaryIntake: code, dietaryIntakeGrade: grade })), "sga-dietary-intake-grade");
  const expected = { "no-change-adequate": "A", "borderline-increasing": "A", "no-change-inadequate": "B", "suboptimal-diet": "B", "full-liquid": "B", "borderline-decreasing": "B",
    "poor-increasing": "B", "hypocaloric-liquid": "C", starvation: "C", "poor-decreasing": "C" };
  for (const [code, grade] of Object.entries(expected)) assert.equal(d(code), grade, code);
  assert.equal(d("poor-no-change", "B"), "B");
  assert.equal(d("poor-no-change", "C"), "C");
  assert.match(sgaFail(sga({ dietaryIntake: "poor-no-change" })), /columns B and C/);

  const f = (code) => sgaGrade(sgaObs(sga({ functionalCapacity: code })), "sga-functional-capacity-grade");
  assert.deepEqual(["no-dysfunction", "difficulty-with-activities", "bed-chair-ridden"].map(f), ["A", "B", "C"]);
  const fc = (code) => sgaGrade(sgaObs(sga({ functionalChange2Weeks: code })), "sga-functional-change-2-weeks-grade");
  assert.deepEqual(["improved", "no-change", "regressed"].map(fc), ["A", "B", "C"]);
  assert.match(sgaFail(sga({ dietaryIntake: "feasting" })), /must be one of/);
});

test("SGA: GI symptoms graded none = A, one to three = B, all four = C", () => {
  const gi = (...flags) => sgaGrade(sgaObs(sga({ nauseaDailyOver2Weeks: flags[0], vomitingDailyOver2Weeks: flags[1], diarrhoeaDailyOver2Weeks: flags[2], anorexiaDailyOver2Weeks: flags[3] })), "sga-gi-symptoms-grade");
  assert.equal(gi(false, false, false, false), "A");
  assert.equal(gi(true, false, false, false), "B");
  assert.equal(gi(true, true, true, false), "B");
  assert.equal(gi(true, true, true, true), "C");
  assert.match(sgaFail(sga({ nauseaDailyOver2Weeks: undefined })), /nauseaDailyOver2Weeks/);
  assert.match(sgaFail(sga({ vomitingDailyOver2Weeks: "yes" })), /boolean/);
});

test("SGA: physical examination is optional, graded per site, and checked against the form's columns", () => {
  const none = sgaObs(sga());
  assert.equal(none.component.filter((c) => c.code.coding[0].code === "sga-physical-exam-finding").length, 0);
  assert.match(none.note[0].text, /0 of 13 sites graded/);

  const o = sgaObs(sga({ tricepsFat: "C", temple: "B", clavicle: "A", oedema: "C", calf: "A" }));
  const exam = o.component.filter((c) => c.code.coding[0].code === "sga-physical-exam-finding");
  assert.equal(exam.length, 5);
  const byLabel = Object.fromEntries(exam.map((c) => [c.code.text, c.valueCodeableConcept.coding[0].code]));
  assert.equal(byLabel["Subcutaneous fat: triceps"], "C");
  assert.equal(byLabel["Muscle wasting: temple"], "B");
  assert.equal(byLabel["Oedema (related to malnutrition)"], "C");
  assert.match(o.note[0].text, /5 of 13 sites graded \(2 A, 1 B, 2 C\)/);

  // sites whose form row has only columns A and C reject B
  for (const site of ["underEyesFat", "tricepsFat", "bicepsFat", "calf", "knee", "interosseousMuscle"]) assert.match(sgaFail(sga({ [site]: "B" })), /no column B descriptor/);
  for (const site of ["temple", "clavicle", "shoulder", "scapulaRibs", "quadriceps", "oedema", "ascites"]) assert.equal(sgaObs(sga({ [site]: "B" })).component.length, 7 + 1);
  assert.match(sgaFail(sga({ temple: "D" })), /A, B or C/);
});

test("SGA: adults only; no hidden age rule", () => {
  assert.equal(evaluateScreen(sga({ ageYears: 12 }), ctx).status, 422);
  assert.equal(sgaObs(sga({ ageYears: 40 })).valueCodeableConcept.coding[0].code, "A");
  assert.match(sgaFail(P([{ name: "tool", valueCode: "sga" }])), /weightChange2Weeks/);
  assert.match(JSON.stringify(evaluateScreen(P([{ name: "tool", valueCode: "nope" }]), ctx).outcome), /pg-sga/);
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
  // SGA: every rating, every descriptor column, and a full examination
  for (const rating of ["A", "B", "C"]) keep(evaluateScreen(sga({ overallRating: rating, subject: "Patient/42", tricepsFat: "C", temple: "B", oedema: "A" }), ctx));
  keep(evaluateScreen(sga({ weightChange2Weeks: "increase-1-level-above", weightChange2WeeksGrade: "B", dietaryIntake: "poor-no-change", dietaryIntakeGrade: "C", functionalCapacity: "bed-chair-ridden", functionalChange2Weeks: "regressed", nauseaDailyOver2Weeks: true, vomitingDailyOver2Weeks: true, diarrhoeaDailyOver2Weeks: true, anorexiaDailyOver2Weeks: true, weightLossPercent6Months: 12, underEyesFat: "C", bicepsFat: "A", clavicle: "C", shoulder: "B", scapulaRibs: "A", quadriceps: "C", calf: "C", knee: "A", interosseousMuscle: "C", ascites: "B", overallRating: "C" }), ctx));
  // Assessment: everything on, then intake-only (no factor), then several loss intervals and BMI classes
  // NACS: every status, edema route and the pre-pregnancy categories
  for (const mm of [100, 120, 130]) keep(evaluateScreen(nacs({ ageMonths: 24, muacMm: mm, subject: "Patient/42" }), ctx));
  for (const mm of [180, 200, 230]) keep(evaluateScreen(nacs({ ageYears: 30, muacMm: mm }), ctx));
  for (const bmi of [15, 16.5, 18, 22, 27, 32]) keep(evaluateScreen(nacs({ ageYears: 40, bmi }), ctx));
  for (const zs of [-3.5, -2.5, 0, 1.5, 2.5]) keep(evaluateScreen(nacs({ ageYears: 10, bmiForAgeZScore: zs }), ctx));
  for (const pre of [17, 22, 27, 32]) keep(evaluateScreen(nacs({ ageYears: 28, pregnantOrPostpartum: true, muacMm: 240, prePregnancyBmi: pre }), ctx));
  keep(evaluateScreen(nacs({ edemaGrade: 3, edemaBothFeetOrLegs: true }), ctx));
  for (const [ap, comp] of [[true, false], [false, false]]) keep(evaluateScreen(nacs({ edemaGrade: 1, edemaBothFeetOrLegs: true, hasAppetite: ap, hasMedicalComplications: comp }), ctx));
  keep(evaluateScreen(nacs({ ageMonths: 30, muacMm: 130, edemaGrade: 2, edemaBothFeetOrLegs: false }), ctx));
  // PG-SGA: every triage band, the optional global category, ratings and symptoms
  for (const deficit of ["none", "mild", "moderate", "severe"]) keep(evaluateScreen(pg({ physicalExamDeficit: deficit, subject: "Patient/42" }), ctx));
  keep(evaluateScreen(pg({ physicalExamDeficit: "severe", pgsgaSymptom: ["no-appetite", "mouth-sores", "constipation"], pgsgaGlobalCategory: "C", muscleStatusRating: 3, fatStoresRating: 2, fluidStatusRating: 0, weightLossPercent1Month: undefined, weightLossPercent6Months: 12, cancer: true, feverTemperatureC: 39, feverDurationHours: 80, corticosteroidPrednisoneEquivalentMgPerDay: 40 }), ctx));
  for (const g of ["A", "B", "C"]) keep(evaluateScreen(pg({ pgsgaGlobalCategory: g }), ctx));
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
    ...[...MNA_SCREEN_ITEM_NAMES, ...MNA_ASSESS_ITEM_NAMES], ...SGA_PARAM_NAMES, ...PGSGA_PARAM_NAMES, ...NACS_PARAM_NAMES]) {
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

// ─── $screen — PG-SGA ─────────────────────────────────────────────────────
const PGSGA_PARAM_NAMES = ["weightOneMonthAgo", "weightSixMonthsAgo", "weightLossPercent1Month", "pgsgaWeightChange2Weeks", "pgsgaIntakeVsUsual", "pgsgaCurrentIntake", "pgsgaSymptom", "pgsgaActivity", "cancer", "feverTemperatureC", "feverDurationHours", "corticosteroidPrednisoneEquivalentMgPerDay", "physicalExamDeficit", "muscleStatusRating", "pgsgaGlobalCategory"];
const PG_BASE = {
  ageYears: 50, weightLossPercent1Month: 0, pgsgaWeightChange2Weeks: "not-changed", pgsgaIntakeVsUsual: "unchanged",
  pgsgaSymptom: ["no-problems-eating"], pgsgaActivity: "normal", physicalExamDeficit: "none",
};
const pgParam = ([name, v]) =>
  Array.isArray(v) ? v.map((x) => ({ name, valueCode: x }))
    : v && typeof v === "object" ? [{ name, valueQuantity: v }]
      : typeof v === "boolean" ? [{ name, valueBoolean: v }]
        : typeof v === "number" ? [{ name, [Number.isInteger(v) && /Rating$|^ageYears$/.test(name) ? "valueInteger" : "valueDecimal"]: v }]
          : [{ name, valueCode: v }];
const pg = (over = {}) =>
  P([{ name: "tool", valueCode: "pg-sga" }, ...Object.entries({ ...PG_BASE, ...over }).filter(([, v]) => v !== undefined).flatMap(pgParam)]);
const pgObs = (over) => { const r = evaluateScreen(pg(over), ctx); assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body.entry[0].resource; };
const pgInt = (o, code, text) => o.component.find((c) => c.code.coding[0].code === code && (text === undefined || c.code.text === text)).valueInteger;
const pgFail = (over, status = 400) => { const r = evaluateScreen(pg(over), ctx); assert.equal(r.ok, false); assert.equal(r.status, status); return JSON.stringify(r.outcome); };

test("PG-SGA: worked example adds A + B + C + D and triages", () => {
  const o = pgObs({
    ageYears: 70, weight: { value: 60, unit: "kg" }, weightOneMonthAgo: { value: 65, unit: "kg" }, weightLossPercent1Month: undefined,
    pgsgaWeightChange2Weeks: "decreased", pgsgaIntakeVsUsual: "less-than-usual", pgsgaCurrentIntake: "little-solid-food",
    pgsgaSymptom: ["nausea", "vomiting", "fatigue"], pgsgaActivity: "in-bed-or-chair-less-than-half-day",
    cancer: true, feverTemperatureC: 38.5, feverDurationHours: 80, corticosteroidPrednisoneEquivalentMgPerDay: 15, physicalExamDeficit: "moderate",
  });
  assert.equal(o.code.coding[0].code, "pg-sga");
  assert.equal(pgInt(o, "pgsga-box1-weight-score"), 4); // 7.7% in 1 month = 3, +1 for loss in 2 weeks
  assert.equal(pgInt(o, "pgsga-box2-food-intake-score"), 2);
  assert.equal(pgInt(o, "pgsga-box3-symptoms-score"), 5);
  assert.equal(pgInt(o, "pgsga-box4-activity-score"), 2);
  assert.equal(pgInt(o, "pgsga-short-form-score"), 13);
  assert.equal(pgInt(o, "pgsga-disease-score"), 2); // cancer + age over 65
  assert.equal(pgInt(o, "pgsga-metabolic-score"), 5); // fever 3 (duration) + steroids 2
  assert.equal(pgInt(o, "pgsga-physical-exam-score"), 2);
  assert.equal(o.valueInteger, 22);
  assert.equal(o.interpretation[0].coding[0].code, "AA");
  assert.equal(nrsComp(o, "pgsga-triage-category").valueCodeableConcept.coding[0].code, "critical-need");
  assert.equal(nrsComp(o, "pgsga-weight-loss-percent").valueQuantity.value, 7.7);
  assert.match(o.note[0].text, /conditions not sent are taken as absent|cancer, age greater than 65/);
});

test("PG-SGA: Worksheet 1 bands for 1 month and 6 months", () => {
  const one = (pct) => pgInt(pgObs({ weightLossPercent1Month: pct }), "pgsga-box1-weight-score");
  for (const [pct, pts] of [[-3, 0], [0, 0], [1.9, 0], [2, 1], [2.9, 1], [3, 2], [4.9, 2], [5, 3], [9.9, 3], [10, 4], [30, 4]]) assert.equal(one(pct), pts, `1 month ${pct}%`);
  const six = (pct) => pgInt(pgObs({ weightLossPercent1Month: undefined, weightLossPercent6Months: pct }), "pgsga-box1-weight-score");
  for (const [pct, pts] of [[0, 0], [1.9, 0], [2, 1], [5.9, 1], [6, 2], [9.9, 2], [10, 3], [19.9, 3], [20, 4]]) assert.equal(six(pct), pts, `6 months ${pct}%`);
  // 1-month data win when both are sent
  const both = pgObs({ weightLossPercent1Month: 0, weightLossPercent6Months: 25 });
  assert.equal(pgInt(both, "pgsga-box1-weight-score"), 0);
  assert.match(both.note[0].text, /6-month was not scored/);
  assert.match(pgObs({ weightLossPercent1Month: undefined, weightLossPercent6Months: 12 }).note[0].text, /6-month table was used/);
  assert.match(pgFail({ weightLossPercent1Month: undefined }), /weightLossPercent1Month/);
  assert.match(pgFail({ weightLossPercent1Month: undefined, weightOneMonthAgo: { value: 60, unit: "kg" } }), /current 'weight'/);
  assert.match(pgFail({ weightLossPercent1Month: undefined, weight: { value: 60, unit: "lb" }, weightOneMonthAgo: { value: 60, unit: "kg" } }), /weight/);
});

test("PG-SGA: past-2-weeks loss adds a point; Box 2 takes the higher answer; Box 3 adds", () => {
  assert.equal(pgInt(pgObs({ pgsgaWeightChange2Weeks: "decreased" }), "pgsga-box1-weight-score"), 1);
  assert.equal(pgInt(pgObs({ pgsgaWeightChange2Weeks: "increased" }), "pgsga-box1-weight-score"), 0);
  const b2 = (a, b) => pgInt(pgObs({ pgsgaIntakeVsUsual: a, pgsgaCurrentIntake: b }), "pgsga-box2-food-intake-score");
  assert.equal(b2("unchanged", undefined), 0);
  assert.equal(b2("less-than-usual", undefined), 1);
  assert.equal(b2("less-than-usual", "very-little-of-anything"), 4);
  assert.equal(b2("less-than-usual", "only-tube-feeding-or-parenteral"), 1);
  assert.equal(b2("unchanged", "only-liquids"), 3);
  const sym = (s) => pgInt(pgObs({ pgsgaSymptom: s }), "pgsga-box3-symptoms-score");
  assert.equal(sym(["no-problems-eating"]), 0);
  assert.equal(sym(["no-appetite", "mouth-sores", "problems-swallowing", "pain", "other"]), 3 + 2 + 2 + 3 + 1);
  assert.equal(sym(["nausea", "nausea"]), 1); // repeated symptom counted once
  const o = pgObs({ pgsgaSymptom: ["nausea", "pain"] });
  assert.equal(o.component.filter((c) => c.code.coding[0].code === "pgsga-nutrition-impact-symptom").length, 2);
  assert.match(pgFail({ pgsgaSymptom: ["no-problems-eating", "nausea"] }), /cannot be combined/);
  assert.match(pgFail({ pgsgaSymptom: ["nope"] }), /pgsgaSymptom/);
  assert.match(pgFail({ pgsgaSymptom: undefined }), /pgsgaSymptom/);
});

test("PG-SGA: Box 4 option scores", () => {
  for (const [v, pts] of [["normal", 0], ["fairly-normal-activities", 1], ["in-bed-or-chair-less-than-half-day", 2], ["little-activity-most-of-day-in-bed-or-chair", 3], ["bed-ridden", 3]]) {
    assert.equal(pgInt(pgObs({ pgsgaActivity: v }), "pgsga-box4-activity-score"), pts, v);
  }
  assert.match(pgFail({ pgsgaActivity: "sleeping" }), /pgsgaActivity/);
});

test("PG-SGA: Worksheet 2 (age over 65 is strictly greater than 65) and Worksheet 3 bands", () => {
  const dis = (over) => pgInt(pgObs(over), "pgsga-disease-score");
  assert.equal(dis({ ageYears: 65 }), 0);
  assert.equal(dis({ ageYears: 66 }), 1);
  assert.equal(dis({ cancer: true, aids: true, pulmonaryOrCardiacCachexia: true, chronicRenalInsufficiency: true, decubitusOpenWoundOrFistula: true, trauma: true, ageYears: 80 }), 7);
  assert.equal(dis({ cancer: false, trauma: true }), 1);
  assert.match(pgFail({ cancer: "yes" }), /boolean/);
  const met = (over) => pgInt(pgObs(over), "pgsga-metabolic-score");
  assert.equal(met({}), 0);
  assert.equal(met({ feverTemperatureC: 37.2 }), 0); // not above 37.2: no fever, no duration needed
  assert.equal(met({ feverTemperatureC: 37.3, feverDurationHours: 10 }), 1);
  assert.equal(met({ feverTemperatureC: 38.3, feverDurationHours: 10 }), 2);
  assert.equal(met({ feverTemperatureC: 38.8, feverDurationHours: 10 }), 3);
  assert.equal(met({ feverTemperatureC: 37.5, feverDurationHours: 72 }), 2);
  assert.equal(met({ feverTemperatureC: 37.5, feverDurationHours: 73 }), 3);
  for (const [mg, pts] of [[0, 0], [9.9, 1], [10, 2], [29.9, 2], [30, 3]]) assert.equal(met({ corticosteroidPrednisoneEquivalentMgPerDay: mg }), pts, `${mg} mg`);
  assert.equal(met({ feverTemperatureC: 38.8, feverDurationHours: 10, corticosteroidPrednisoneEquivalentMgPerDay: 10 }), 5); // the form's own worked example
  assert.match(pgFail({ feverTemperatureC: 38 }), /feverDurationHours/);
  assert.match(pgFail({ feverDurationHours: 10 }), /feverTemperatureC/);
});

test("PG-SGA: physical exam score is the clinician's rating and ratings are recorded only", () => {
  for (const [v, pts] of [["none", 0], ["mild", 1], ["moderate", 2], ["severe", 3]]) assert.equal(pgInt(pgObs({ physicalExamDeficit: v }), "pgsga-physical-exam-score"), pts);
  assert.match(pgFail({ physicalExamDeficit: undefined }), /physicalExamDeficit/);
  assert.match(pgFail({ physicalExamDeficit: "profound" }), /physicalExamDeficit/);
  const o = pgObs({ muscleStatusRating: 3, fatStoresRating: 1, physicalExamDeficit: "mild" });
  assert.equal(pgInt(o, "pgsga-body-composition-rating", "Global muscle status rating"), 3);
  assert.equal(o.valueInteger, 1); // ratings do not change the score
  assert.match(pgFail({ muscleStatusRating: 4 }), /0-3/);
});

test("PG-SGA: triage bands follow the total score", () => {
  const t = (over) => { const o = pgObs(over); return [o.valueInteger, nrsComp(o, "pgsga-triage-category").valueCodeableConcept.coding[0].code, o.interpretation[0].coding[0].code]; };
  assert.deepEqual(t({}), [0, "no-intervention", "N"]);
  assert.deepEqual(t({ physicalExamDeficit: "mild" }), [1, "no-intervention", "N"]);
  assert.deepEqual(t({ physicalExamDeficit: "moderate" }), [2, "education-and-symptom-management", "A"]);
  assert.deepEqual(t({ physicalExamDeficit: "severe" }), [3, "education-and-symptom-management", "A"]);
  assert.deepEqual(t({ physicalExamDeficit: "severe", pgsgaSymptom: ["constipation"] }), [4, "dietitian-intervention", "A"]);
  assert.deepEqual(t({ physicalExamDeficit: "severe", pgsgaSymptom: ["no-appetite", "mouth-sores"] }), [8, "dietitian-intervention", "A"]);
  assert.deepEqual(t({ physicalExamDeficit: "severe", pgsgaSymptom: ["no-appetite", "mouth-sores", "constipation"] }), [9, "critical-need", "AA"]);
});

test("PG-SGA: global category is optional, carried as entered and never computed", () => {
  assert.equal(pgObs({}).component.some((c) => c.code.coding[0].code === "pgsga-global-category"), false);
  const o = pgObs({ pgsgaGlobalCategory: "b" });
  assert.equal(nrsComp(o, "pgsga-global-category").valueCodeableConcept.coding[0].code, "B");
  assert.match(o.note[0].text, /Stage B/);
  assert.match(pgFail({ pgsgaGlobalCategory: "D" }), /A, B or C/);
});

test("PG-SGA: adults only, age is required", () => {
  assert.match(pgFail({ ageYears: 12 }, 422), /adults/);
  assert.match(pgFail({ ageYears: undefined }), /ageYears or birthDate/);
  const o = pgObs({ ageYears: undefined, birthDate: "1950-01-01", effectiveDateTime: "2026-06-01" });
  assert.equal(pgInt(o, "pgsga-disease-score"), 1);
  assert.match(o.note[0].text, /Screening\/assessment aid only/);
});

// ─── $screen — NACS classification ────────────────────────────────────────
const NACS_PARAM_NAMES = ["ageMonths", "pregnantOrPostpartum", "muacMm", "bmiForAgeZScore", "prePregnancyBmi", "edemaGrade", "edemaBothFeetOrLegs", "hasAppetite", "hasMedicalComplications"];
const nacsParam = ([name, v]) =>
  v && typeof v === "object" ? { name, valueQuantity: v }
    : typeof v === "boolean" ? { name, valueBoolean: v }
      : typeof v === "number" ? { name, [Number.isInteger(v) && /^(ageMonths|ageYears|edemaGrade)$/.test(name) ? "valueInteger" : "valueDecimal"]: v }
        : { name, valueString: v };
const nacs = (o = {}) => P([{ name: "tool", valueCode: "nacs" }, ...Object.entries(o).filter(([, v]) => v !== undefined).map(nacsParam)]);
const nacsRun = (o) => evaluateScreen(nacs(o), ctx);
const nacsOk = (o) => { const r = nacsRun(o); assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body.entry[0].resource; };
const nacsValue = (ob) => ob.valueCodeableConcept?.coding[0].code;
const nacsFail = (o, status = 400) => { const r = nacsRun(o); assert.equal(r.ok, false, JSON.stringify(r.body)); assert.equal(r.status, status); return JSON.stringify(r.outcome); };

test("NACS: MUAC cutoffs for children 6-59 months, 5-9 and 10-14 years", () => {
  const grid = [
    [{ ageMonths: 6 }, [[114, "sam"], [115, "mam"], [124, "mam"], [125, "normal"]]],
    [{ ageMonths: 59 }, [[114.9, "sam"], [124.9, "mam"], [125, "normal"]]],
    [{ ageMonths: 60 }, [[134, "sam"], [135, "mam"], [144, "mam"], [145, "normal"]]],
    [{ ageYears: 9 }, [[134, "sam"], [144, "mam"], [145, "normal"]]],
    [{ ageMonths: 120 }, [[159, "sam"], [160, "mam"], [184, "mam"], [185, "normal"]]],
    [{ ageYears: 14 }, [[159, "sam"], [184, "mam"], [185, "normal"]]],
  ];
  for (const [age, cases] of grid) for (const [mm, want] of cases) assert.equal(nacsValue(nacsOk({ ...age, muacMm: mm })), want, `${JSON.stringify(age)} ${mm} mm`);
  const o = nacsOk({ ageMonths: 24, muacMm: 118 });
  assert.equal(nrsComp(o, "nacs-muac").valueQuantity.value, 118);
  assert.equal(nrsComp(o, "nacs-muac-status").valueCodeableConcept.coding[0].code, "mam");
  assert.match(o.note[0].text, /children 6-59 months/);
  assert.equal(o.code.coding[0].code, "nacs");
});

test("NACS: adult MUAC, with the pregnant/postpartum column", () => {
  for (const [mm, want] of [[184, "sam"], [185, "moderate-malnutrition"], [219, "moderate-malnutrition"], [220, "normal"]]) {
    assert.equal(nacsValue(nacsOk({ ageYears: 30, muacMm: mm })), want, `adult ${mm}`);
  }
  for (const [mm, want] of [[189, "sam"], [190, "moderate-malnutrition"], [229, "moderate-malnutrition"], [230, "normal"]]) {
    assert.equal(nacsValue(nacsOk({ ageYears: 30, pregnantOrPostpartum: true, muacMm: mm })), want, `pregnant ${mm}`);
  }
  // 188 mm differs between the two columns
  assert.equal(nacsValue(nacsOk({ ageYears: 30, muacMm: 188 })), "moderate-malnutrition");
  assert.equal(nacsValue(nacsOk({ ageYears: 30, pregnantOrPostpartum: true, muacMm: 188 })), "sam");
});

test("NACS: MUAC is refused where the guide gives no cutoffs", () => {
  assert.match(nacsFail({ ageMonths: 5, muacMm: 130 }, 422), /under 6 months/);
  assert.match(nacsFail({ ageYears: 16, muacMm: 200 }, 422), /15 to 17/);
  assert.match(nacsFail({ ageYears: 16, pregnantOrPostpartum: true, muacMm: 200 }, 422), /under 18/);
  assert.match(nacsFail({ muacMm: 130 }), /ageMonths/);
  assert.match(nacsFail({ ageYears: 3, muacMm: 130 }), /ageMonths/); // under 5 needs months
  assert.match(nacsFail({ ageYears: 30, muacMm: 20 }), /50 to 500/);
});

test("NACS: age from birthDate counts completed months", () => {
  const at = (birthDate) => nacsValue(nacsOk({ birthDate, effectiveDateTime: "2026-10-10", muacMm: 120 }));
  assert.equal(at("2026-04-10"), "mam"); // exactly 6 months: 6-59 table, 120 mm
  assert.equal(at("2021-10-11"), "mam"); // 4 years 11 months: 6-59 table
  assert.equal(at("2021-10-10"), "sam"); // exactly 5 years: 5-9 table, 120 < 135
  assert.match(nacsFail({ birthDate: "2026-06-11", effectiveDateTime: "2026-10-10", muacMm: 120 }, 422), /under 6 months/); // 3 months 29 days
});

test("NACS: adult BMI bands, banded on the 1-decimal value", () => {
  const b = (bmi) => nacsValue(nacsOk({ ageYears: 40, bmi }));
  for (const [v, want] of [[15.9, "severe-malnutrition"], [16, "moderate-malnutrition"], [16.9, "moderate-malnutrition"], [17, "mild-malnutrition"], [18.4, "mild-malnutrition"],
    [18.5, "normal"], [24.9, "normal"], [25, "overweight"], [29.9, "overweight"], [30, "obesity"], [18.45, "normal"], [15.95, "moderate-malnutrition"]]) assert.equal(b(v), want, `BMI ${v}`);
  const o = nacsOk({ ageYears: 40, weight: { value: 50, unit: "kg" }, height: { value: 160, unit: "cm" } });
  assert.equal(nrsComp(o, "nacs-bmi").valueQuantity.value, 19.5);
  assert.equal(nacsValue(o), "normal");
  assert.match(nacsFail({ ageYears: 40, weight: { value: 50, unit: "kg" }, height: { value: 160, unit: "in" } }), /weight/);
});

test("NACS: BMI-for-age bands for 5-17 years; BMI alone under 18 is refused", () => {
  const z = (v) => nacsValue(nacsOk({ ageYears: 10, bmiForAgeZScore: v }));
  for (const [v, want] of [[-3.1, "severe-malnutrition"], [-3, "moderate-malnutrition"], [-2.01, "moderate-malnutrition"], [-2, "normal"], [1, "normal"], [1.01, "overweight"], [2, "overweight"], [2.01, "obesity"]]) assert.equal(z(v), want, `z ${v}`);
  assert.match(nacsFail({ ageYears: 10, bmi: 14 }), /bmiForAgeZScore/);
  assert.match(nacsFail({ ageMonths: 48, bmiForAgeZScore: -1 }, 422), /5 to 17/);
  assert.match(nacsFail({ ageYears: 30, bmiForAgeZScore: -1 }, 422), /adults/);
  assert.match(nacsFail({ ageYears: 10, bmiForAgeZScore: 12 }), /-10 and 10/);
});

test("NACS: BMI is refused for pregnant/postpartum women; pre-pregnancy BMI has its own table", () => {
  assert.match(nacsFail({ ageYears: 28, pregnantOrPostpartum: true, bmi: 22 }, 422), /use MUAC/);
  const pre = (v) => nrsComp(nacsOk({ ageYears: 28, pregnantOrPostpartum: true, muacMm: 240, prePregnancyBmi: v }), "nacs-pre-pregnancy-bmi-category").valueCodeableConcept.coding[0].code;
  for (const [v, want] of [[18.4, "underweight"], [18.5, "normal-weight"], [24.9, "normal-weight"], [25, "overweight"], [29.9, "overweight"], [30, "obese"]]) assert.equal(pre(v), want, `pre-pregnancy ${v}`);
  const o = nacsOk({ ageYears: 28, pregnantOrPostpartum: true, muacMm: 240, prePregnancyBmi: 17 });
  assert.equal(nacsValue(o), "normal"); // the pre-pregnancy category is not a status indicator
});

test("NACS: several indicators are reported separately with no combined value", () => {
  const o = nacsOk({ ageYears: 40, bmi: 17.5, muacMm: 190 });
  assert.equal(nacsValue(o), undefined);
  assert.equal(nrsComp(o, "nacs-bmi-status").valueCodeableConcept.coding[0].code, "mild-malnutrition");
  assert.equal(nrsComp(o, "nacs-muac-status").valueCodeableConcept.coding[0].code, "moderate-malnutrition");
  assert.match(o.note[0].text, /no rule for combining/);
  assert.equal(nacsValue(nacsOk({ ageYears: 40, bmi: 17.5 })), "mild-malnutrition");
});

test("NACS: bilateral pitting edema is SAM on its own and sets the management route", () => {
  const e = (extra) => nacsOk({ edemaGrade: 3, edemaBothFeetOrLegs: true, ...extra });
  const o3 = e({ muacMm: 200, ageMonths: 30 }); // normal MUAC is ignored
  assert.equal(nacsValue(o3), "sam");
  assert.equal(nrsComp(o3, "nacs-edema-disposition").valueCodeableConcept.coding[0].code, "inpatient-sam-management");
  assert.equal(o3.component.some((c) => c.code.coding[0].code === "nacs-muac"), false);
  assert.match(o3.note[0].text, /regardless of anthropometric/);
  const d = (grade, hasAppetite, hasMedicalComplications) => nrsComp(nacsOk({ edemaGrade: grade, edemaBothFeetOrLegs: true, hasAppetite, hasMedicalComplications }), "nacs-edema-disposition").valueCodeableConcept.coding[0].code;
  assert.equal(d(1, true, false), "outpatient-sam-treatment");
  assert.equal(d(2, true, false), "outpatient-sam-treatment");
  assert.equal(d(2, false, false), "not-stated-by-guide");
  assert.equal(d(1, true, true), "not-stated-by-guide");
  assert.match(nacsFail({ edemaGrade: 1, edemaBothFeetOrLegs: true }), /hasAppetite/);
  assert.match(nacsFail({ edemaGrade: 2 }), /edemaBothFeetOrLegs/);
  assert.match(nacsFail({ edemaGrade: 4, edemaBothFeetOrLegs: true }), /0-3/);
});

test("NACS: edema in one foot is not counted, edema with MUAC carries the guide's caution, input is required", () => {
  const o = nacsOk({ ageMonths: 30, muacMm: 130, edemaGrade: 2, edemaBothFeetOrLegs: false });
  assert.equal(nacsValue(o), "normal");
  assert.match(o.note[0].text, /not in both feet or legs/);
  assert.match(o.note[0].text, /MUAC should not be used/);
  assert.equal(nacsValue(nacsOk({ ageMonths: 30, muacMm: 130, edemaGrade: 0 })), "normal");
  assert.match(nacsFail({}), /something to classify/);
  assert.match(nacsFail({ edemaGrade: 0 }), /something to classify/);
  assert.match(nacsFail({ ageYears: 30, pregnantOrPostpartum: "yes", muacMm: 200 }), /boolean/);
});
