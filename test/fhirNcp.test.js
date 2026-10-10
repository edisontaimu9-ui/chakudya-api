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
} from "../src/fhirNcp.js";
import { buildCapabilityStatement } from "../src/fhir.js";

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
  const declared = cap.rest[0].resource.flatMap((r) => r.operation.map((o) => `${r.type}/$${o.name}`));
  for (const [t, a] of ops) assert.ok(declared.includes(`${t}/${a}`), `${t}/${a} missing from CapabilityStatement`);
});
