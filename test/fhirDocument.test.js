import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAdimeDocument, evaluateValidateDocument, checkAdimeDocument, documentOperationFor } from "../src/fhirDocument.js";
import { evaluateNutritionAssessment } from "../src/fhirAssessment.js";
import { evaluateDiagnoseStructured } from "../src/fhirDiagnosis.js";
import { evaluateInterveneStructured } from "../src/fhirIntervention.js";
import { evaluateMonitor } from "../src/fhirMonitoring.js";
import { buildCapabilityStatement } from "../src/fhir.js";
import { operationDefinitionResource } from "../src/fhirTerminology.js";

const BASE = "https://x.test";
let n = 0;
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const S = (name, v) => ({ name, valueString: v });
const Q = (name, v, u) => ({ name, valueQuantity: q(v, u) });
const R = (b) => ({ name: "resource", resource: b });
const obs = (code, v, u) => part("observation", [S("code", code), Q("value", v, u)]);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };
const msgs = (r, status) => { assert.equal(r.ok, false); assert.equal(r.status, status); return r.outcome.issue.map((i) => i.diagnostics); };

// Steps 1 to 4 with the real operations.
function flow() {
  const assessment = ok(evaluateNutritionAssessment(P([
    S("subject", "Patient/1"), S("encounter", "Encounter/1"), S("effectiveDateTime", "2026-09-01T08:00:00Z"), { name: "ageYears", valueInteger: 30 },
    obs("weight", 48, "kg"), obs("height", 160, "cm"), obs("energy-intake-kcal", 1100, "kcal/d"),
  ]), ctx));
  const diagnosis = ok(evaluateDiagnoseStructured(P([
    S("subject", "Patient/1"), S("author", "Practitioner/d1"),
    part("diagnosis", [S("problem", "Inadequate energy intake"), S("domain", "intake"), S("etiology", "poor appetite"), S("signsSymptoms", "intake 55% of requirement")]),
  ]), ctx));
  const plan = ok(evaluateInterveneStructured(P([
    R(diagnosis), S("author", "Practitioner/d1"), S("title", "Weight restoration"),
    part("goal", [S("description", "Reach 52 kg"), S("measure", "Body weight"), S("measureCode", "weight"), S("direction", "increase"), Q("baseline", 48, "kg"), Q("target", 52, "kg"), S("dueDate", "2026-12-20")]),
  ]), ctx));
  const followUp = ok(evaluateMonitor(P([
    R(plan), { name: "baseline", resource: assessment }, S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10T09:00:00Z"),
    S("author", "Practitioner/d1"), obs("weight", 49, "kg"),
  ]), ctx));
  return { assessment, diagnosis, plan, followUp };
}
const docParams = (b, extra = []) => P([S("subject", "Patient/1"), S("author", "Practitioner/d1"), ...extra, ...[b.assessment, b.diagnosis, b.plan, b.followUp].map(R)]);

test("the Step 1-4 Bundles make one valid ADIME document with all four sections", () => {
  const doc = ok(evaluateAdimeDocument(docParams(flow()), ctx));
  assert.equal(doc.type, "document");
  assert.equal(doc.entry[0].resource.resourceType, "Composition");
  const comp = doc.entry[0].resource;
  assert.deepEqual(comp.section.map((s) => s.code.coding[0].code), ["nutrition-assessment", "nutrition-diagnosis", "nutrition-intervention", "nutrition-monitoring"]);
  for (const s of comp.section) assert.ok(s.entry?.length > 0, s.title);
  assert.equal(comp.subject.reference.startsWith("urn:uuid:") || comp.subject.reference === "Patient/1", true);
  assert.equal(comp.status, "final");
  assert.equal(doc.identifier.value, comp.identifier.value);
  assert.ok(comp.text.div.startsWith('<div xmlns="http://www.w3.org/1999/xhtml"'));
  const check = checkAdimeDocument(doc);
  assert.deepEqual(check.errors, []);
});

test("the document links the diagnosis, care plan, goals and follow-up result", () => {
  const doc = ok(evaluateAdimeDocument(docParams(flow()), ctx));
  const by = (t) => doc.entry.filter((e) => e.resource.resourceType === t);
  const cond = by("Condition")[0];
  const plan = by("CarePlan").find((e) => e.resource.status !== "draft") ?? by("CarePlan")[0];
  assert.ok(plan.resource.addresses.some((a) => a.reference === cond.fullUrl));
  const urls = new Set(doc.entry.map((e) => e.fullUrl));
  assert.equal(urls.size, doc.entry.length, "no entry appears twice (the evaluated Goal replaces the plan's Goal)");
  for (const g of plan.resource.goal) assert.ok(urls.has(g.reference));
  const goal = by("Goal").find((e) => e.resource.achievementStatus);
  assert.ok(goal, "an evaluated Goal is present");
  assert.ok(urls.has(goal.resource.outcomeReference[0].reference));
});

test("status and title are applied; a bad status is a 400", () => {
  const doc = ok(evaluateAdimeDocument(docParams(flow(), [S("status", "preliminary"), S("title", "Visit 2 ADIME")]), ctx));
  assert.equal(doc.entry[0].resource.status, "preliminary");
  assert.equal(doc.entry[0].resource.title, "Visit 2 ADIME");
  assert.match(msgs(evaluateAdimeDocument(docParams(flow(), [S("status", "draft")]), ctx), 400)[0], /status/);
});

test("a document with only some steps is valid with emptyReason sections and warnings", () => {
  const f = flow();
  const doc = ok(evaluateAdimeDocument(P([S("author", "Practitioner/d1"), R(f.diagnosis), S("subject", "Patient/1")]), ctx));
  const comp = doc.entry[0].resource;
  assert.equal(comp.section.find((s) => s.code.coding[0].code === "nutrition-monitoring").emptyReason.coding[0].code, "notstarted");
  const outcome = ok(evaluateValidateDocument(P([R(doc)]), ctx));
  assert.ok(outcome.issue.some((i) => i.severity === "warning" && /no intervention is/.test(i.diagnostics)));
  assert.ok(!outcome.issue.some((i) => i.severity === "error"));
});

test("a broken internal reference stops the document (422) and names the reference", () => {
  const f = flow();
  const broken = structuredClone(f.plan);
  const cp = broken.entry.find((e) => e.resource.resourceType === "CarePlan").resource;
  cp.goal = [{ reference: "urn:uuid:does-not-exist-0000-0000-000000000000" }];
  const m = msgs(evaluateAdimeDocument(docParams({ ...f, plan: broken }), ctx), 422);
  assert.ok(m.some((x) => /does-not-exist/.test(x)), JSON.stringify(m));
});

test("a missing baseline is a warning, not an error (supporting detail)", () => {
  const f = flow();
  const doc = ok(evaluateAdimeDocument(P([S("author", "Practitioner/d1"), S("subject", "Patient/1"), R(f.diagnosis), R(f.plan), R(f.followUp)]), ctx));
  const outcome = ok(evaluateValidateDocument(P([R(doc)]), ctx));
  assert.ok(!outcome.issue.some((i) => i.severity === "error"), JSON.stringify(outcome.issue));
});

test("$validate-document finds structural problems in someone else's Bundle", () => {
  const doc = ok(evaluateAdimeDocument(docParams(flow()), ctx));
  const bad = structuredClone(doc);
  bad.type = "collection";
  bad.entry[0].resource.section[0].entry.push({ reference: "urn:uuid:nope" });
  delete bad.entry[0].resource.subject;
  bad.entry[0].resource.section.pop(); // drop monitoring
  const outcome = ok(evaluateValidateDocument(P([R(bad)]), ctx));
  const errs = outcome.issue.filter((i) => i.severity === "error").map((i) => i.diagnostics);
  for (const re of [/type must be "document"/, /subject/, /not an entry of the Bundle/, /nutrition-monitoring" is missing/]) {
    assert.ok(errs.some((x) => re.test(x)), `${re}: ${JSON.stringify(errs)}`);
  }
  assert.equal(checkAdimeDocument({ resourceType: "Patient" }).errors.length, 1);
  assert.equal(checkAdimeDocument({ resourceType: "Bundle", type: "document", entry: [{ resource: { resourceType: "Patient" } }] }).errors.some((e) => /first entry/.test(e)), true);
  assert.equal(evaluateValidateDocument(P([]), ctx).ok, false);
});

test("a resource in the wrong section and a second patient are errors", () => {
  const doc = ok(evaluateAdimeDocument(docParams(flow()), ctx));
  const wrong = structuredClone(doc);
  const comp = wrong.entry[0].resource;
  const dx = comp.section.find((s) => s.code.coding[0].code === "nutrition-diagnosis");
  const iv = comp.section.find((s) => s.code.coding[0].code === "nutrition-intervention");
  iv.entry.push(dx.entry[0]);
  const other = structuredClone(doc);
  other.entry.find((e) => e.resource.resourceType === "Condition").resource.subject = { reference: "Patient/99" };
  const e1 = checkAdimeDocument(wrong).errors.join("|");
  const e2 = checkAdimeDocument(other).errors.join("|");
  assert.match(e1, /belongs in "nutrition-diagnosis"/);
  assert.match(e2, /Patient\/99/);
});

test("the operations are registered, declared and defined", () => {
  assert.equal(typeof documentOperationFor("Bundle", "$ncp-document"), "function");
  assert.equal(typeof documentOperationFor("Bundle", "$validate-document"), "function");
  const cap = buildCapabilityStatement(BASE);
  const declared = cap.rest[0].resource.flatMap((r) => (r.operation ?? []).map((o) => `${r.type}/$${o.name}`));
  for (const o of ["Bundle/$ncp-document", "Bundle/$validate-document"]) assert.ok(declared.includes(o), o);
  assert.ok(operationDefinitionResource(BASE, "Bundle-validate-document"));
  assert.ok(operationDefinitionResource(BASE, "Bundle-ncp-document").parameter.some((p) => p.name === "status"));
});
