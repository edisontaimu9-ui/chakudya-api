import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMonitor, monitoringOperationFor } from "../src/fhirMonitoring.js";
import { evaluateNutritionAssessment } from "../src/fhirAssessment.js";
import { evaluateDiagnoseStructured } from "../src/fhirDiagnosis.js";
import { evaluateInterveneStructured } from "../src/fhirIntervention.js";
import { evaluateNcpDocument } from "../src/fhirNcp.js";
import { codeSystemResource, structureDefinitionResource, operationDefinitionResource } from "../src/fhirTerminology.js";

const BASE = "https://x.test";
let n = 0;
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };

const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const S = (name, v) => ({ name, valueString: v });
const Q = (name, v, u) => ({ name, valueQuantity: q(v, u) });
const obs = (code, v, u, extra = []) => part("observation", [S("code", code), Q("value", v, u), ...extra]);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };
const msgs = (r, status = 400) => { assert.equal(r.ok, false); assert.equal(r.status, status); return r.outcome.issue.map((i) => i.diagnostics); };
const hasMsg = (m, re) => assert.ok(m.some((x) => re.test(x)), `no message matches ${re}: ${JSON.stringify(m)}`);
const of = (b, type) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === type);
const notes = (b) => of(b, "OperationOutcome").flatMap((o) => o.issue.map((i) => i.diagnostics));
const ext = (r, name) => r.extension?.find((x) => x.url === `${BASE}/fhir/StructureDefinition/${name}`);
const stepCodes = (r) => (r.category ?? []).flatMap((c) => c.coding ?? []).filter((c) => c.system.endsWith("/ncp-step")).map((c) => c.code);

// Step 1 to 3 with the real operations, so the plan has the shape $intervene really produces.
const baseline = () => ok(evaluateNutritionAssessment(P([
  S("subject", "Patient/1"), S("encounter", "Encounter/1"), S("effectiveDateTime", "2026-09-01T08:00:00Z"), { name: "ageYears", valueInteger: 30 },
  obs("weight", 48, "kg"), obs("height", 160, "cm"), obs("energy-intake-kcal", 1100, "kcal/d"),
]), ctx));
const plan = () => {
  const d = ok(evaluateDiagnoseStructured(P([
    S("subject", "Patient/1"), S("author", "Practitioner/d1"),
    part("diagnosis", [S("problem", "Inadequate energy intake"), S("domain", "intake"), S("etiology", "poor appetite"), S("signsSymptoms", "intake 55% of requirement")]),
  ]), ctx));
  return ok(evaluateInterveneStructured(P([
    { name: "resource", resource: d }, S("author", "Practitioner/d1"), S("title", "Weight restoration"),
    part("goal", [S("description", "Reach 52 kg"), S("measure", "Body weight"), S("measureCode", "weight"), S("direction", "increase"), Q("baseline", 48, "kg"), Q("target", 52, "kg"), S("dueDate", "2026-12-20")]),
    part("goal", [S("description", "Eat 1800 kcal a day"), S("measure", "Energy intake"), S("measureCode", "energy-intake-kcal"), S("direction", "increase"), Q("target", 1800, "kcal/d"), S("dueDate", "2026-11-20")]),
  ]), ctx));
};
const goalUrl = (b, text) => b.entry.find((e) => e.resource.resourceType === "Goal" && e.resource.description.text === text).fullUrl;
const goalOf = (b, text) => of(b, "Goal").find((g) => g.description.text === text);
const R = (b) => ({ name: "resource", resource: b });
const follow = (items, top = []) => P([R(PLAN), { name: "baseline", resource: BASE_B }, S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10T09:00:00Z"), ...top, ...items]);
let PLAN, BASE_B;
const fresh = () => { PLAN = plan(); BASE_B = baseline(); };

test("a follow-up is linked to patient, encounter and plan, and compared with baseline", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 47.5, "kg"), obs("energy-intake-kcal", 1500, "kcal/d")], [S("author", "Practitioner/d1")]), ctx));
  const planRef = PLAN.entry.find((e) => e.resource.resourceType === "CarePlan").fullUrl;
  const observations = of(b, "Observation");
  assert.equal(observations.length, 2);
  for (const o of observations) {
    assert.equal(o.subject.reference, "Patient/1");
    assert.equal(o.encounter.reference, "Encounter/2");
    assert.equal(o.basedOn[0].reference, planRef);
    assert.deepEqual(stepCodes(o), ["nutrition-monitoring"]);
    assert.equal(o.performer[0].reference, "Practitioner/d1");
  }
  const w = observations.find((o) => o.code.text === "Body weight");
  assert.equal(ext(w, "change-from-baseline").valueQuantity.value, -0.5);
  assert.equal(ext(w, "percent-change-from-baseline").valueDecimal, -1);
  assert.equal(ext(w, "baseline-observation").valueReference.reference, BASE_B.entry.find((e) => e.resource.code?.text === "Body weight").fullUrl);
  const e = observations.find((o) => o.code.text === "Energy intake");
  assert.equal(ext(e, "change-from-baseline").valueQuantity.value, 400);
});

test("goals get status, an outcome link, progress and the patient's response; the plan is not edited", () => {
  fresh();
  const before = structuredClone(PLAN);
  const wUrl = goalUrl(PLAN, "Reach 52 kg");
  const b = ok(evaluateMonitor(follow([obs("weight", 47.5, "kg"), obs("energy-intake-kcal", 1500, "kcal/d")], [
    S("author", "Practitioner/d1"), part("goal", [S("reference", wUrl), S("response", "Morning nausea limits breakfast")]),
  ]), ctx));
  assert.deepEqual(PLAN, before, "inputs are never mutated");
  const w = goalOf(b, "Reach 52 kg"), e = goalOf(b, "Eat 1800 kcal a day");
  assert.equal(w.achievementStatus.coding[0].code, "worsening");
  assert.equal(e.achievementStatus.coding[0].code, "improving");
  assert.equal(b.entry.find((x) => x.resource === w).fullUrl, wUrl, "the Goal keeps its identity so the caller can update it");
  assert.equal(w.statusDate, "2026-10-10");
  assert.match(w.note.at(-1).text, /Patient response: Morning nausea/);
  assert.equal(ext(w, "goal-progress-fraction").valueDecimal, -0.125);
  const outcome = of(b, "Observation").find((o) => o.code.text === "Body weight");
  assert.equal(b.entry.find((x) => x.resource === outcome).fullUrl, w.outcomeReference[0].reference);
  assert.equal(e.lifecycleStatus, "active");
  assert.match(notes(b).join(" "), /Evaluated 2 goal\(s\): 1 worsening, 1 improving/);
});

test("an unmet goal creates a plan-review Task and a draft successor plan; the original stays as it was", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 47.5, "kg"), obs("energy-intake-kcal", 1500, "kcal/d")], [S("author", "Practitioner/d1"), S("reviewDueDate", "2026-10-20")]), ctx));
  const tasks = of(b, "Task");
  assert.equal(tasks.length, 1, "only the worsening goal needs review");
  assert.equal(tasks[0].focus.reference, goalUrl(PLAN, "Reach 52 kg"));
  assert.equal(tasks[0].code.coding[0].code, "plan-review");
  assert.equal(tasks[0].restriction.period.end, "2026-10-20");
  const planRef = PLAN.entry.find((e) => e.resource.resourceType === "CarePlan").fullUrl;
  assert.equal(tasks[0].basedOn[0].reference, planRef);
  const [next] = of(b, "CarePlan");
  assert.equal(next.status, "draft");
  assert.equal(next.intent, "proposal");
  assert.equal(next.replaces[0].reference, planRef);
  assert.equal(next.id, undefined);
  assert.equal(next.title, "Weight restoration (revision)");
  assert.ok(next.supportingInfo.length >= 2, "the follow-up evidence is attached");
  assert.match(next.note.at(-1).text, /Reach 52 kg/);
  assert.deepEqual(next.goal, PLAN.entry.find((e) => e.resource.resourceType === "CarePlan").resource.goal);
});

test("when every goal is improving there is no Task and no revision", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 50, "kg"), obs("energy-intake-kcal", 1500, "kcal/d")]), ctx));
  assert.equal(of(b, "Task").length, 0);
  assert.equal(of(b, "CarePlan").length, 0);
  assert.equal(of(b, "Provenance").length, 0, "no author, no provenance");
});

test("an achieved goal is completed; all achieved suggests closing the plan without changing it", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 52.5, "kg"), obs("energy-intake-kcal", 1850, "kcal/d")]), ctx));
  for (const g of of(b, "Goal")) { assert.equal(g.achievementStatus.coding[0].code, "achieved"); assert.equal(g.lifecycleStatus, "completed"); }
  hasMsg(notes(b), /consider closing the plan/);
  assert.equal(of(b, "CarePlan").length, 0);
});

test("a goal past its due date and not achieved needs review even when improving", () => {
  fresh();
  const p = structuredClone(PLAN);
  const g = p.entry.find((e) => e.resource.description?.text === "Eat 1800 kcal a day").resource;
  g.target[0].dueDate = "2026-10-05";
  const b = ok(evaluateMonitor(P([R(p), { name: "baseline", resource: BASE_B }, S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10T09:00:00Z"), obs("energy-intake-kcal", 1500, "kcal/d")]), ctx));
  assert.equal(goalOf(b, "Eat 1800 kcal a day").achievementStatus.coding[0].code, "improving");
  assert.equal(of(b, "Task").length, 1);
  assert.match(of(b, "Task")[0].description, /due date 2026-10-05 has passed/);
  assert.equal(of(b, "CarePlan").length, 1);
});

test("an explicit 'current' evaluates a goal and records an outcome Observation; an inline goal works without a plan", () => {
  fresh();
  const b = ok(evaluateMonitor(P([
    S("subject", "Patient/1"), S("encounter", "Encounter/2"), S("author", "Practitioner/d1"),
    part("goal", [S("description", "Haemoglobin above 12"), S("measure", "Haemoglobin"), S("measureCode", "718-7"), S("direction", "increase"), Q("baseline", 9.5, "g/dL"), Q("target", 12, "g/dL"), Q("current", 11, "g/dL"), S("response", "Taking iron daily")]),
  ]), ctx));
  const g = of(b, "Goal")[0];
  assert.equal(g.achievementStatus.coding[0].code, "improving");
  const o = of(b, "Observation")[0];
  assert.equal(o.valueQuantity.value, 11);
  assert.equal(o.encounter.reference, "Encounter/2");
  assert.deepEqual(stepCodes(o), ["nutrition-monitoring"]);
  assert.equal(g.outcomeReference[0].reference, b.entry.find((e) => e.resource === o).fullUrl);
  assert.equal(of(b, "CarePlan").length, 0);
  assert.equal(of(b, "Task").length, 0);
  assert.equal(of(b, "Provenance").length, 1);
});

test("units are never converted: a mismatch is reported and nothing is compared or evaluated", () => {
  fresh();
  const p = structuredClone(PLAN);
  const g = p.entry.find((e) => e.resource.description?.text === "Reach 52 kg").resource;
  g.target[0].detailQuantity = q(114.6, "[lb_av]");
  const b = ok(evaluateMonitor(P([R(p), { name: "baseline", resource: BASE_B }, S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10T09:00:00Z"), obs("weight", 50, "kg")]), ctx));
  hasMsg(notes(b), /Goal .* was not evaluated: .*unit mismatch/);
  assert.equal(of(b, "Goal").length, 0);
  assert.equal(ext(of(b, "Observation")[0], "change-from-baseline") !== undefined, true, "kg vs kg baseline still compares");
});

test("a goal with no matching follow-up value is reported, not guessed", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 50, "kg")]), ctx));
  hasMsg(notes(b), /no follow-up value for "Energy intake"/);
  assert.equal(of(b, "Goal").length, 1);
});

test("earlier visits give change from the previous value", () => {
  fresh();
  const first = ok(evaluateMonitor(follow([obs("weight", 49, "kg")]), ctx));
  const second = ok(evaluateMonitor(P([R(PLAN), { name: "baseline", resource: BASE_B }, { name: "previous", resource: first }, S("encounter", "Encounter/3"), S("effectiveDateTime", "2026-10-11T07:00:00Z"), obs("weight", 50, "kg")]), ctx));
  const w = of(second, "Observation")[0];
  assert.equal(ext(w, "change-from-baseline").valueQuantity.value, 2);
  assert.equal(ext(w, "change-from-previous").valueQuantity.value, 1);
  assert.equal(ext(w, "previous-observation").valueReference.reference, first.entry.find((e) => e.resource.resourceType === "Observation").fullUrl);
});

test("a repeated questionnaire is recorded and linked to the plan", () => {
  fresh();
  const qr = {
    resourceType: "QuestionnaireResponse", status: "completed", questionnaire: `${BASE}/fhir/Questionnaire/diet-history`,
    item: [{ linkId: "energy-intake-kcal", answer: [{ valueQuantity: q(1600, "kcal/d") }] }],
  };
  const b = ok(evaluateMonitor(follow([{ name: "questionnaireResponse", resource: qr }]), ctx));
  const r = of(b, "QuestionnaireResponse")[0];
  assert.equal(r.basedOn[0].reference, PLAN.entry.find((e) => e.resource.resourceType === "CarePlan").fullUrl);
  assert.equal(of(b, "Observation")[0].valueQuantity.value, 1600);
  assert.deepEqual(stepCodes(of(b, "Observation")[0]), ["nutrition-monitoring"]);
});

test("Provenance covers everything recorded and names the plan and baseline", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 47.5, "kg")], [S("author", "Practitioner/d1"), S("source", "clinic visit")]), ctx));
  const [pv] = of(b, "Provenance");
  const urls = new Set(b.entry.filter((e) => e.resource.resourceType !== "Provenance" && e.resource.resourceType !== "OperationOutcome").map((e) => e.fullUrl));
  assert.deepEqual(new Set(pv.target.map((t) => t.reference)), urls);
  assert.ok(pv.entity.some((x) => x.role === "derivation" && x.what.reference === PLAN.entry.find((e) => e.resource.resourceType === "CarePlan").fullUrl));
  assert.ok(pv.entity.some((x) => x.role === "source" && x.what.display === "clinic visit"));
  assert.ok(pv.entity.some((x) => x.role === "source" && x.what.reference));
});

test("problems are reported clearly", () => {
  fresh();
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), obs("weight", 50, "kg")]), ctx)), /'encounter' is required/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("encounter", "visit-2"), obs("weight", 50, "kg")]), ctx)), /Encounter reference/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("subject", "Patient/9"), S("encounter", "Encounter/2"), obs("weight", 50, "kg")]), ctx)), /not the patient of the supplied plan/);
  hasMsg(msgs(evaluateMonitor(P([S("encounter", "Encounter/2"), obs("weight", 50, "kg")]), ctx)), /'subject' is required/);
  hasMsg(msgs(evaluateMonitor(P([S("subject", "Patient/1"), S("encounter", "Encounter/2")]), ctx)), /Nothing to monitor/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("encounter", "Encounter/2"), part("goal", [S("reference", "urn:uuid:nope"), S("response", "x")])]), ctx)), /does not resolve to a Goal/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), R(PLAN), S("encounter", "Encounter/2"), obs("weight", 50, "kg")]), ctx)), /one CarePlan/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("encounter", "Encounter/2"), S("source", "x"), obs("weight", 50, "kg")]), ctx)), /'source' needs an 'author'/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("encounter", "Encounter/2"), S("reviewDueDate", "2026-01-01"), obs("weight", 50, "kg")]), ctx)), /reviewDueDate .* in the past/);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10"), obs("weight", 50, "stone")]), ctx)), /weight/i);
  hasMsg(msgs(evaluateMonitor(P([R(PLAN), S("encounter", "Encounter/2"), S("effectiveDateTime", "2099-01-01"), obs("weight", 50, "kg")]), ctx)), /future/);
  hasMsg(msgs(evaluateMonitor({ resourceType: "Bundle" }, ctx)), /Parameters/);
});

test("the monitoring Bundle goes straight into $ncp-document", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 47.5, "kg")], [S("author", "Practitioner/d1")]), ctx));
  const doc = ok(evaluateNcpDocument(P([S("subject", "Patient/1"), S("author", "Practitioner/d1"), R(b)]), ctx));
  const comp = doc.entry[0].resource;
  const monitoring = comp.section.find((s) => s.title === "Nutrition monitoring and evaluation");
  assert.ok(monitoring.entry.length >= 2, "follow-up Observation and evaluated Goal land in the monitoring section");
});

test("every code system code and extension the operation emits has a definition", () => {
  fresh();
  const b = ok(evaluateMonitor(follow([obs("weight", 47.5, "kg")], [S("author", "Practitioner/d1")]), ctx));
  const prev = ok(evaluateMonitor(follow([obs("weight", 49, "kg")]), ctx));
  const b2 = ok(evaluateMonitor(P([R(PLAN), { name: "baseline", resource: BASE_B }, { name: "previous", resource: prev }, S("encounter", "Encounter/3"), S("effectiveDateTime", "2026-10-11T07:00:00Z"), obs("weight", 47.5, "kg")]), ctx));
  const csPrefix = `${BASE}/fhir/CodeSystem/`, sdPrefix = `${BASE}/fhir/StructureDefinition/`;
  const missing = new Set();
  let codes = 0, exts = 0;
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.system === "string" && o.system.startsWith(csPrefix) && typeof o.code === "string" && !o.system.endsWith("/ncp-diagnosis") && !o.system.endsWith("/ncp-indicator") && !o.system.endsWith("/assessment-item")) {
      codes++;
      const def = codeSystemResource(BASE, o.system.slice(csPrefix.length));
      if (!def) missing.add(o.system); else if (!def.concept.some((c) => c.code === o.code)) missing.add(`${o.code} in ${o.system}`);
    }
    if (typeof o.url === "string" && o.url.startsWith(sdPrefix)) { exts++; if (!structureDefinitionResource(BASE, o.url.slice(sdPrefix.length))) missing.add(o.url); }
    Object.values(o).forEach(walk);
  };
  walk(b); walk(b2);
  assert.deepEqual([...missing], []);
  assert.ok(codes >= 5 && exts >= 6, `${codes} codes, ${exts} extensions`);
});

test("OperationDefinition lists the inputs; the operation is registered", () => {
  const od = operationDefinitionResource(BASE, "CarePlan-monitor");
  const names = od.parameter.filter((p) => p.use === "in").map((p) => p.name);
  for (const x of ["subject", "encounter", "resource", "baseline", "previous", "effectiveDateTime", "author", "source", "reviewDueDate", "observation", "questionnaireResponse", "goal"]) assert.ok(names.includes(x), x);
  assert.equal(od.parameter.find((p) => p.name === "encounter").min, 1);
  assert.equal(monitoringOperationFor("CarePlan", "$monitor"), evaluateMonitor);
  assert.equal(monitoringOperationFor("Goal", "$evaluate"), null);
});
