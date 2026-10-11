import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInterveneStructured, interventionOperationFor } from "../src/fhirIntervention.js";
import { evaluateIntervene, evaluateNcpDocument, evaluateGoals } from "../src/fhirNcp.js";
import { evaluateDiagnoseStructured } from "../src/fhirDiagnosis.js";
import { codeSystemResource, structureDefinitionResource, operationDefinitionResource } from "../src/fhirTerminology.js";

const BASE = "https://x.test";
let n = 0;
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };

const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const S = (name, v) => ({ name, valueString: v });
const Q = (name, v, u) => ({ name, valueQuantity: q(v, u) });
const subject = S("subject", "Patient/1");

const plan = (items, top = []) => P([subject, ...top, ...items]);
const goal = (parts) => part("goal", parts);
const order = (parts) => part("nutritionOrder", parts);
const GOAL = [S("description", "Reach 52 kg"), S("measure", "Body weight"), S("direction", "increase"), Q("baseline", 48, "kg"), Q("target", 52, "kg"), S("dueDate", "2026-12-20")];

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };
const msgs = (r) => { assert.equal(r.ok, false); assert.equal(r.status, 400); return r.outcome.issue.map((i) => i.diagnostics); };
const hasMsg = (m, re) => assert.ok(m.some((x) => re.test(x)), `no message matches ${re}: ${JSON.stringify(m)}`);
const of = (b, type) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === type);
const entryOf = (b, type, i = 0) => b.entry.filter((e) => e.resource.resourceType === type)[i];
const noteTexts = (b) => of(b, "OperationOutcome").flatMap((o) => o.issue.map((i) => i.diagnostics));

// A real diagnosis Bundle to hang the plan on.
const diagnosis = () => ok(evaluateDiagnoseStructured(P([
  subject, S("author", "Practitioner/d1"),
  part("diagnosis", [S("problem", "Inadequate energy intake"), S("domain", "intake"), S("etiology", "poor appetite"), S("signsSymptoms", "intake 55% of requirement")]),
]), ctx));
const CONDITION = (b) => b.entry.find((e) => e.resource.resourceType === "Condition");

// ─── Back-compat ──────────────────────────────────────────────────────────
test("a plain plan still produces the base resources; the new layer only adds notes", () => {
  const body = plan([goal([S("description", "Eat three meals a day")]), part("education", [S("topic", "Balanced diet")])]);
  const old = ok(evaluateIntervene(body, ctx));
  const cur = ok(evaluateInterveneStructured(body, ctx));
  assert.deepEqual(cur.entry.map((e) => e.resource.resourceType).slice(0, old.entry.length), old.entry.map((e) => e.resource.resourceType));
  assert.equal(of(cur, "Task").length, 0, "no owner, no due date: no Task");
  assert.equal(of(cur, "Provenance").length, 0);
  hasMsg(noteTexts(cur), /not linked to a nutrition diagnosis/);
  hasMsg(noteTexts(cur), /goal\[0\] has no dueDate/);
  assert.match(of(cur, "CarePlan")[0].note.at(-1).text, /not linked to a nutrition diagnosis/);
});

test("errors the base operation raises keep their messages", () => {
  hasMsg(msgs(evaluateInterveneStructured(P([part("goal", [S("description", "x")])]), ctx)), /'subject' is required/);
  hasMsg(msgs(evaluateInterveneStructured(P([subject]), ctx)), /Nothing to plan/);
  hasMsg(msgs(evaluateInterveneStructured(plan([goal([S("description", "x")])], [S("status", "done")]), ctx)), /'status' must be draft or active/);
  hasMsg(msgs(evaluateInterveneStructured({ resourceType: "Bundle" }, ctx)), /Parameters/);
});

// ─── Link to the diagnosis ────────────────────────────────────────────────
test("the plan addresses the diagnosis Condition: CarePlan, Goal, orders, requests and tasks all point at it", () => {
  const d = diagnosis();
  const cond = CONDITION(d);
  const b = ok(evaluateInterveneStructured(P([
    { name: "resource", resource: d },
    goal(GOAL),
    order([S("kind", "oral-diet"), S("type", "High-energy diet")]),
    part("education", [S("topic", "Energy-dense foods"), S("assignedTo", "Practitioner/d1"), S("dueDate", "2026-10-15")]),
  ]), ctx));
  const cp = of(b, "CarePlan")[0];
  assert.equal(cp.subject.reference, "Patient/1", "subject defaults to the diagnosis patient");
  assert.deepEqual(cp.addresses, [{ reference: cond.fullUrl }]);
  assert.deepEqual(of(b, "Goal")[0].addresses, [{ reference: cond.fullUrl }]);
  assert.equal(of(b, "NutritionOrder")[0].extension[0].valueReference.reference, cond.fullUrl);
  assert.deepEqual(of(b, "ServiceRequest")[0].reasonReference, [{ reference: cond.fullUrl }]);
  assert.deepEqual(of(b, "Task")[0].reasonReference, [{ reference: cond.fullUrl }]);
  assert.ok(!noteTexts(b).some((t) => /not linked/.test(t)));
});

test("explicit addresses must be Condition references that resolve in the supplied diagnosis", () => {
  const d = diagnosis();
  const cond = CONDITION(d).fullUrl;
  ok(evaluateInterveneStructured(P([{ name: "resource", resource: d }, S("addresses", cond), goal(GOAL)]), ctx));
  hasMsg(msgs(evaluateInterveneStructured(P([{ name: "resource", resource: d }, S("addresses", "Condition/other"), goal(GOAL)]), ctx)), /does not resolve in the supplied diagnosis/);
  hasMsg(msgs(evaluateInterveneStructured(plan([goal(GOAL)], [S("addresses", "Observation/1")]), ctx)), /must be a Condition reference/);
  // without a Bundle the reference is just carried
  assert.deepEqual(of(ok(evaluateInterveneStructured(plan([goal(GOAL)], [S("addresses", "Condition/9")]), ctx)), "CarePlan")[0].addresses, [{ reference: "Condition/9" }]);
});

test("a diagnosis for another patient, or one entered in error, is refused; a resolved one is flagged", () => {
  const d = diagnosis();
  hasMsg(msgs(evaluateInterveneStructured(P([{ name: "resource", resource: d }, S("subject", "Patient/2"), goal(GOAL)]), ctx)), /not the patient of the supplied diagnosis/);
  const wrong = structuredClone(d); CONDITION(wrong).resource.verificationStatus.coding[0].code = "entered-in-error";
  hasMsg(msgs(evaluateInterveneStructured(P([{ name: "resource", resource: wrong }, goal(GOAL)]), ctx)), /is entered-in-error; a plan cannot address it/);
  const done = structuredClone(d); CONDITION(done).resource.clinicalStatus.coding[0].code = "resolved";
  hasMsg(noteTexts(ok(evaluateInterveneStructured(P([{ name: "resource", resource: done }, goal(GOAL)]), ctx))), /is resolved; check that the plan still needs/);
  const mixed = { resourceType: "Bundle", type: "collection", entry: [...d.entry.filter((e) => e.resource.resourceType === "Condition"), { fullUrl: "urn:uuid:99999999-9999-4999-8999-999999999999", resource: { ...CONDITION(d).resource, subject: { reference: "Patient/2" } } }] };
  hasMsg(msgs(evaluateInterveneStructured(P([{ name: "resource", resource: mixed }, goal(GOAL)]), ctx)), /different patients/);
});

// ─── Goals ────────────────────────────────────────────────────────────────
test("a measurable goal with a target date is recorded and evaluable", () => {
  const b = ok(evaluateInterveneStructured(plan([goal([...GOAL, S("startDate", "2026-10-11"), S("priority", "high")])]), ctx));
  const g = of(b, "Goal")[0];
  assert.equal(g.target[0].dueDate, "2026-12-20");
  assert.deepEqual(g.target[0].detailQuantity, { value: 52, unit: "kg", system: "http://unitsofmeasure.org", code: "kg" });
  assert.equal(g.startDate, "2026-10-11");
  assert.ok(!noteTexts(b).some((t) => /goal\[0\]/.test(t)), "a complete goal draws no warning");
  // and Goal/$evaluate can run on exactly these numbers
  const ev = evaluateGoals(P([subject, part("goal", [S("description", "Reach 52 kg"), S("direction", "increase"), Q("baseline", 48, "kg"), Q("target", 52, "kg"), Q("current", 50, "kg")])]), ctx);
  assert.equal(ev.ok, true);
});

test("goal dates and measures are validated, and every problem is reported together", () => {
  const run = (parts) => msgs(evaluateInterveneStructured(plan([goal([S("description", "g"), ...parts])]), ctx));
  hasMsg(run([S("dueDate", "2026-02-30")]), /dueDate .* full date/);
  hasMsg(run([S("dueDate", "2026-12")]), /dueDate .* full date/);
  hasMsg(run([S("dueDate", "2026-10-01")]), /dueDate 2026-10-01 is in the past/);
  hasMsg(run([S("startDate", "2026-11-01"), S("dueDate", "2026-10-20")]), /before its startDate/);
  hasMsg(run([S("startDate", "soon")]), /startDate .* not a valid/);
  hasMsg(run([{ name: "target", valueQuantity: { value: 52 } }, S("measure", "weight")]), /target needs a unit/);
  hasMsg(run([Q("baseline", 48, "kg"), Q("target", 52, "lb"), S("direction", "increase")]), /baseline unit "kg" differs from target unit "lb"/);
  hasMsg(run([Q("baseline", 48, "kg"), Q("target", 45, "kg"), S("direction", "increase")]), /not above baseline/);
  hasMsg(run([Q("baseline", 48, "kg"), Q("target", 50, "kg"), S("direction", "decrease")]), /not below baseline/);
  const all = run([S("dueDate", "2026-10-01"), Q("target", 50, "kg"), { name: "baseline", valueQuantity: { value: 48 } }, S("direction", "increase")]);
  assert.ok(all.length >= 2, "several errors at once");
  // warnings, not errors
  const w = noteTexts(ok(evaluateInterveneStructured(plan([goal([S("description", "g"), Q("target", 50, "kg")]), goal([S("description", "h"), S("measure", "weight")])]), ctx)));
  hasMsg(w, /goal\[0\] has a target but no 'measure'/);
  hasMsg(w, /goal\[0\] has a target but no 'direction'/);
  hasMsg(w, /goal\[1\] names a measure but has no numeric 'target'/);
  hasMsg(w, /goal\[0\] has no dueDate/);
});

// ─── Orders ───────────────────────────────────────────────────────────────
test("diet, supplement and enteral orders: units are checked, rates and volumes normalised", () => {
  const b = ok(evaluateInterveneStructured(plan([
    order([S("kind", "oral-diet"), S("type", "High-protein diet"), part("nutrient", [S("name", "Protein"), Q("amount", 75, "g/d")]), S("texture", "soft"),
      { name: "timesPerDay", valueInteger: 3 }, S("startDate", "2026-10-12"), S("endDate", "2026-11-12"), S("foodPreference", "no spicy food"), S("excludeFood", "groundnuts"), S("allergyIntolerance", "AllergyIntolerance/a1")]),
    order([S("kind", "supplement"), S("productName", "ONS 1.5 kcal/mL"), Q("quantity", 200, "mL"), { name: "timesPerDay", valueInteger: 2 }]),
    order([S("kind", "enteral-formula"), S("baseFormulaType", "Standard polymeric"), S("route", "nasogastric"), Q("rate", 60, "ml/hr"), Q("maxVolume", 1.2, "L"), { name: "timesPerDay", valueInteger: 1 }]),
  ], [S("author", "Practitioner/d1"), S("encounter", "Encounter/e1")]), ctx));
  const [diet, ons, ent] = of(b, "NutritionOrder");
  assert.deepEqual(diet.oralDiet.nutrient[0].amount.unit, "g/d");
  assert.deepEqual(diet.oralDiet.schedule, [{ repeat: { frequency: 3, period: 1, periodUnit: "d", boundsPeriod: { start: "2026-10-12", end: "2026-11-12" } } }]);
  assert.deepEqual(diet.foodPreferenceModifier, [{ text: "no spicy food" }]);
  assert.deepEqual(diet.excludeFoodModifier, [{ text: "groundnuts" }]);
  assert.deepEqual(diet.allergyIntolerance, [{ reference: "AllergyIntolerance/a1" }]);
  assert.deepEqual(diet.orderer, { reference: "Practitioner/d1" });
  assert.deepEqual(diet.encounter, { reference: "Encounter/e1" });
  assert.equal(ons.supplement[0].quantity.value, 200);
  assert.deepEqual(ons.supplement[0].schedule, [{ repeat: { frequency: 2, period: 1, periodUnit: "d" } }]);
  const adm = ent.enteralFormula.administration[0];
  assert.deepEqual(adm.rateQuantity, { value: 60, unit: "mL/h", system: "http://unitsofmeasure.org", code: "mL/h" });
  assert.deepEqual(adm.schedule, { repeat: { frequency: 1, period: 1, periodUnit: "d" } });
  assert.deepEqual(ent.enteralFormula.maxVolumeToDeliver, { value: 1200, unit: "mL", system: "http://unitsofmeasure.org", code: "mL" });
});

test("order validation: unknown or missing units, implausible values, bad schedule, bad references", () => {
  const run = (parts) => msgs(evaluateInterveneStructured(plan([order(parts)]), ctx));
  hasMsg(run([S("kind", "oral-diet"), part("nutrient", [S("name", "Protein"), Q("amount", 75, "handfuls")])]), /amount needs a recognised unit/);
  hasMsg(run([S("kind", "oral-diet"), part("nutrient", [S("name", "Protein"), { name: "amount", valueQuantity: { value: 75 } }])]), /amount needs a recognised unit/);
  hasMsg(run([S("kind", "supplement"), S("productName", "ONS"), { name: "quantity", valueQuantity: { value: 200 } }]), /quantity needs a unit/);
  hasMsg(run([S("kind", "supplement"), S("productName", "ONS"), Q("quantity", 0, "mL")]), /above 0/);
  hasMsg(run([S("kind", "enteral-formula"), S("baseFormulaType", "x"), Q("rate", 60, "mL/min")]), /rate must be in mL\/h/);
  hasMsg(run([S("kind", "enteral-formula"), S("baseFormulaType", "x"), Q("rate", 5000, "mL/h")]), /outside the plausible range/);
  hasMsg(run([S("kind", "enteral-formula"), S("baseFormulaType", "x"), Q("maxVolume", 800, "g")]), /maxVolume must be in mL or L/);
  hasMsg(run([S("kind", "enteral-formula"), S("baseFormulaType", "x"), Q("maxVolume", 50, "L")]), /outside the plausible range/);
  hasMsg(run([S("kind", "oral-diet"), S("type", "x"), { name: "timesPerDay", valueInteger: 30 }]), /timesPerDay must be a whole number from 1 to 24/);
  hasMsg(run([S("kind", "oral-diet"), S("type", "x"), S("startDate", "2026-11-12"), S("endDate", "2026-10-12")]), /endDate is before startDate/);
  hasMsg(run([S("kind", "oral-diet"), S("type", "x"), S("startDate", "next week")]), /startDate .* full date/);
  hasMsg(run([S("kind", "oral-diet"), S("type", "x"), S("allergyIntolerance", "peanut")]), /must be an AllergyIntolerance reference/);
  hasMsg(run([S("kind", "oral-diet")]), /oral-diet needs at least one of/); // base message preserved
  // a name-only author is not an orderer reference
  const b = ok(evaluateInterveneStructured(plan([order([S("kind", "oral-diet"), S("type", "x")])], [S("author", "Dietitian A")]), ctx));
  assert.equal(of(b, "NutritionOrder")[0].orderer, undefined);
  assert.deepEqual(of(b, "CarePlan")[0].author, { display: "Dietitian A" });
});

// ─── Education, counseling, follow-up, referral, tasks ────────────────────
test("an activity with an owner or due date becomes a Task that points at the plan and the request", () => {
  const b = ok(evaluateInterveneStructured(plan([
    part("education", [S("topic", "Complementary feeding"), S("audience", "Caregiver"), S("assignedTo", "Practitioner/d1"), S("dueDate", "2026-10-15"), S("priority", "urgent")]),
    part("counseling", [S("topic", "Meal planning"), S("dueDate", "2026-10-18T10:00:00+02:00")]),
    part("coordination", [S("reason", "Align with ART clinic"), S("with", "ART clinic")]),
  ], [S("author", "Practitioner/d1"), S("encounter", "Encounter/e1")]), ctx));
  const [sEdu, sCou, sCoo] = of(b, "ServiceRequest");
  const tasks = of(b, "Task");
  assert.equal(tasks.length, 2, "coordination has no owner or date, so no Task");
  assert.deepEqual([sEdu.priority, sEdu.occurrenceDateTime, sEdu.performer, sEdu.requester, sEdu.encounter], ["urgent", "2026-10-15", [{ reference: "Practitioner/d1" }], { reference: "Practitioner/d1" }, { reference: "Encounter/e1" }]);
  assert.equal(sCou.occurrenceDateTime, "2026-10-18T10:00:00+02:00");
  assert.equal(sCoo.occurrenceDateTime, undefined);
  const cpUrl = entryOf(b, "CarePlan").fullUrl;
  const srUrls = b.entry.filter((e) => e.resource.resourceType === "ServiceRequest").map((e) => e.fullUrl);
  const [t1, t2] = tasks;
  assert.deepEqual([t1.basedOn[0].reference, t1.focus.reference], [cpUrl, srUrls[0]]);
  assert.equal(t2.focus.reference, srUrls[1]);
  assert.equal(t1.status, "draft");
  assert.equal(t1.intent, "proposal");
  assert.equal(t1.for.reference, "Patient/1");
  assert.equal(sEdu.subject.reference, "Patient/1");
  assert.equal(t1.owner.reference, "Practitioner/d1");
  assert.equal(t1.restriction.period.end, "2026-10-15");
  assert.equal(t1.priority, "urgent");
  assert.equal(t1.code.coding[0].code, "education");
  assert.equal(t1.description, "Complementary feeding");
  assert.equal(t2.owner, undefined);
});

test("an active plan creates requested tasks and active goals", () => {
  const b = ok(evaluateInterveneStructured(plan([goal(GOAL), part("education", [S("topic", "x"), S("assignedTo", "Dietitian A")])], [S("status", "active"), S("intent", "plan")]), ctx));
  const t = of(b, "Task")[0];
  assert.deepEqual([t.status, t.intent], ["requested", "plan"]);
  assert.equal(of(b, "Goal")[0].lifecycleStatus, "active");
  assert.deepEqual(t.owner, { display: "Dietitian A" });
});

test("follow-up: a dated review, always tracked by a Task", () => {
  const b = ok(evaluateInterveneStructured(plan([
    part("followUp", [S("reason", "Review weight and intake"), S("dueDate", "2026-10-25"), S("method", "in-person"), S("monitor", "weight"), S("monitor", "energy intake"), S("assignedTo", "Practitioner/d1"), S("priority", "routine")]),
  ]), ctx));
  const sr = of(b, "ServiceRequest")[0];
  assert.equal(sr.code.text, "Nutrition follow-up: Review weight and intake");
  assert.equal(sr.category[1].coding[0].code, "follow-up");
  assert.equal(sr.occurrenceDateTime, "2026-10-25");
  assert.equal(sr.note[0].text, "Method: in-person | Monitor: weight; energy intake");
  assert.deepEqual(sr.reasonCode, [{ text: "Review weight and intake" }]);
  const t = of(b, "Task")[0];
  assert.equal(t.focus.reference, entryOf(b, "ServiceRequest").fullUrl);
  assert.equal(t.restriction.period.end, "2026-10-25");
  assert.equal(t.owner.reference, "Practitioner/d1");
  const cp = of(b, "CarePlan")[0];
  assert.deepEqual(cp.activity, [{ reference: { reference: entryOf(b, "ServiceRequest").fullUrl } }], "a plan with only a follow-up is valid");
  hasMsg(msgs(evaluateInterveneStructured(plan([part("followUp", [S("reason", "x")])]), ctx)), /followUp\[0\]\.dueDate is required/);
  hasMsg(msgs(evaluateInterveneStructured(plan([part("followUp", [S("dueDate", "2026-10-25")])]), ctx)), /followUp\[0\]\.reason/);
  hasMsg(msgs(evaluateInterveneStructured(plan([part("followUp", [S("reason", "x"), S("dueDate", "2026-10-01")])]), ctx)), /in the past/);
});

test("referral: a ServiceRequest to another professional or service, with a Task owned by the receiver", () => {
  const d = diagnosis();
  const b = ok(evaluateInterveneStructured(P([
    { name: "resource", resource: d },
    part("referral", [S("to", "HIV clinic"), S("reason", "Nutrition in advanced HIV; ART review"), S("performer", "Organization/art-clinic"), S("priority", "urgent"), S("dueDate", "2026-10-14")]),
    part("referral", [S("to", "Physiotherapy"), S("reason", "Muscle wasting"), S("performer", "Dr Phiri")]),
  ]), ctx));
  const [r1, r2] = of(b, "ServiceRequest");
  assert.equal(r1.code.text, "Referral to HIV clinic");
  assert.deepEqual(r1.category.map((c) => c.coding[0].code), ["nutrition-intervention", "referral", "3457005"]);
  assert.deepEqual([r1.priority, r1.occurrenceDateTime, r1.performer], ["urgent", "2026-10-14", [{ reference: "Organization/art-clinic" }]]);
  assert.deepEqual(r1.reasonCode, [{ text: "Nutrition in advanced HIV; ART review" }]);
  assert.deepEqual(r1.reasonReference, [{ reference: CONDITION(d).fullUrl }]);
  assert.deepEqual(r2.performer, [{ display: "Dr Phiri" }]);
  const [t1, t2] = of(b, "Task");
  assert.equal(t1.owner.reference, "Organization/art-clinic");
  assert.deepEqual(t2.owner, { display: "Dr Phiri" });
  assert.equal(of(b, "CarePlan")[0].activity.length, 2);
  hasMsg(msgs(evaluateInterveneStructured(plan([part("referral", [S("reason", "x")])]), ctx)), /referral\[0\]\.to/);
  hasMsg(msgs(evaluateInterveneStructured(plan([part("referral", [S("to", "x")])]), ctx)), /referral\[0\]\.reason/);
  hasMsg(msgs(evaluateInterveneStructured(plan([part("referral", [S("to", "x"), S("reason", "y"), S("priority", "whenever")])]), ctx)), /priority must be one of/);
});

test("activity inputs are validated", () => {
  const run = (parts) => msgs(evaluateInterveneStructured(plan([part("education", [S("topic", "x"), ...parts])]), ctx));
  hasMsg(run([S("dueDate", "tomorrow")]), /education\[0\]\.dueDate .* must be a FHIR date/);
  hasMsg(run([S("dueDate", "2026-10-01")]), /in the past/);
  hasMsg(run([S("dueDate", "2026-10-15T10:00:00")]), /must be a FHIR date .* with timezone/);
  hasMsg(run([S("priority", "later")]), /priority must be one of routine, urgent, asap, stat/);
});

// ─── Plan-level ───────────────────────────────────────────────────────────
test("plan-level inputs: encounter, author, period end, and Provenance for everything created", () => {
  const d = diagnosis();
  const b = ok(evaluateInterveneStructured(P([
    { name: "resource", resource: d },
    S("author", "Practitioner/d1"), S("encounter", "Encounter/e1"), S("endDate", "2026-12-31"), S("source", "dietitian assessment"),
    goal(GOAL), order([S("kind", "oral-diet"), S("type", "High-energy diet")]),
    part("education", [S("topic", "x"), S("dueDate", "2026-10-15")]),
    part("referral", [S("to", "Physio"), S("reason", "y")]),
  ]), ctx));
  const cp = of(b, "CarePlan")[0];
  assert.deepEqual([cp.encounter, cp.author, cp.period.end], [{ reference: "Encounter/e1" }, { reference: "Practitioner/d1" }, "2026-12-31"]);
  assert.deepEqual(of(b, "Goal")[0].expressedBy, { reference: "Practitioner/d1" });
  const pv = of(b, "Provenance");
  assert.equal(pv.length, 1);
  const created = b.entry.filter((e) => ["CarePlan", "Goal", "NutritionOrder", "ServiceRequest", "Task"].includes(e.resource.resourceType)).map((e) => e.fullUrl);
  assert.deepEqual(pv[0].target.map((t) => t.reference).sort(), created.sort());
  assert.deepEqual(pv[0].agent[0].who, { reference: "Practitioner/d1" });
  assert.deepEqual(pv[0].entity.map((e) => [e.role, e.what]), [["derivation", { reference: CONDITION(d).fullUrl }], ["source", { display: "dietitian assessment" }]]);
  const urls = new Set(b.entry.map((e) => e.fullUrl));
  for (const a of cp.activity) assert.ok(urls.has(a.reference.reference));
  for (const g of cp.goal) assert.ok(urls.has(g.reference));
  hasMsg(msgs(evaluateInterveneStructured(plan([goal(GOAL)], [S("source", "interview")]), ctx)), /'source' needs an 'author'/);
  hasMsg(msgs(evaluateInterveneStructured(plan([goal(GOAL)], [S("encounter", "Visit/1")]), ctx)), /Encounter reference/);
  hasMsg(msgs(evaluateInterveneStructured(plan([goal(GOAL)], [S("endDate", "2026-10-01")]), ctx)), /endDate is in the past/);
  hasMsg(msgs(evaluateInterveneStructured(plan([goal(GOAL)], [S("effectiveDateTime", "2026-11-01"), S("endDate", "2026-10-20")]), ctx)), /endDate is before the plan's start/);
  assert.equal(of(ok(evaluateInterveneStructured(plan([goal(GOAL)]), ctx)), "Provenance").length, 0);
});

// ─── Chains and conformance ───────────────────────────────────────────────
test("diagnosis and intervention Bundles go into one ADIME note", () => {
  const d = diagnosis();
  const b = ok(evaluateInterveneStructured(P([
    { name: "resource", resource: d }, S("author", "Practitioner/d1"),
    goal(GOAL), order([S("kind", "oral-diet"), S("type", "High-energy diet")]),
    part("education", [S("topic", "x"), S("assignedTo", "Practitioner/d1")]),
    part("followUp", [S("reason", "review"), S("dueDate", "2026-10-25")]),
  ]), ctx));
  const doc = ok(evaluateNcpDocument(P([subject, S("author", "Practitioner/d1"), { name: "resource", resource: d }, { name: "resource", resource: b }]), ctx));
  const comp = doc.entry[0].resource;
  const section = (code) => comp.section.find((s) => s.code.coding[0].code === code);
  assert.equal(section("nutrition-diagnosis").entry.length, 1);
  const types = section("nutrition-intervention").entry.map((e) => doc.entry.find((x) => x.fullUrl === e.reference).resource.resourceType);
  assert.deepEqual([...new Set(types)].sort(), ["CarePlan", "Goal", "NutritionOrder", "ServiceRequest", "Task"]);
  assert.equal(types.filter((t) => t === "Task").length, 2);
});

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((x) => walk(x, visit));
  if (node && typeof node === "object") { visit(node); Object.values(node).forEach((x) => walk(x, visit)); }
}

test("every code system code and extension the intervention emits has a definition", () => {
  const d = diagnosis();
  const b = ok(evaluateInterveneStructured(P([
    { name: "resource", resource: d }, S("author", "Practitioner/d1"),
    goal([...GOAL]), order([S("kind", "oral-diet"), S("type", "x")]),
    part("education", [S("topic", "x"), S("assignedTo", "a")]), part("counseling", [S("topic", "y"), S("assignedTo", "a")]), part("coordination", [S("reason", "z"), S("assignedTo", "a")]),
    part("followUp", [S("reason", "r"), S("dueDate", "2026-10-25")]), part("referral", [S("to", "t"), S("reason", "r")]),
  ]), ctx));
  const csPrefix = `${BASE}/fhir/CodeSystem/`, sdPrefix = `${BASE}/fhir/StructureDefinition/`;
  const missing = new Set();
  let codes = 0, exts = 0;
  walk(b, (o) => {
    if (typeof o.system === "string" && o.system.startsWith(csPrefix) && typeof o.code === "string") {
      if (o.system.endsWith("/ncp-diagnosis")) return;
      codes++;
      const def = codeSystemResource(BASE, o.system.slice(csPrefix.length));
      if (!def) missing.add(o.system);
      else if (!def.concept.some((c) => c.code === o.code)) missing.add(`${o.code} in ${o.system}`);
    }
    if (typeof o.url === "string" && o.url.startsWith(sdPrefix)) {
      exts++;
      if (!structureDefinitionResource(BASE, o.url.slice(sdPrefix.length))) missing.add(o.url);
    }
  });
  assert.deepEqual([...missing], []);
  assert.ok(codes >= 10 && exts >= 3, `${codes} codes, ${exts} extensions`);
  const dom = codeSystemResource(BASE, "ncp-intervention-domain").concept.map((c) => c.code);
  for (const c of ["education", "counseling", "coordination", "follow-up", "referral"]) assert.ok(dom.includes(c), c);
});

test("OperationDefinition lists the new inputs; the structured operation is registered", () => {
  const od = operationDefinitionResource(BASE, "CarePlan-intervene");
  const names = od.parameter.filter((p) => p.use === "in").map((p) => p.name);
  for (const x of ["subject", "resource", "addresses", "encounter", "author", "source", "endDate", "goal", "nutritionOrder", "education", "counseling", "coordination", "followUp", "referral"]) assert.ok(names.includes(x), x);
  const order = od.parameter.find((p) => p.name === "nutritionOrder").part.map((p) => p.name);
  for (const x of ["timesPerDay", "startDate", "endDate", "foodPreference", "excludeFood", "allergyIntolerance"]) assert.ok(order.includes(x), x);
  for (const g of ["education", "counseling", "coordination"]) {
    const parts = od.parameter.find((p) => p.name === g).part.map((p) => p.name);
    for (const x of ["assignedTo", "dueDate", "priority"]) assert.ok(parts.includes(x), `${g}.${x}`);
  }
  assert.equal(interventionOperationFor("CarePlan", "$intervene"), evaluateInterveneStructured);
  assert.equal(interventionOperationFor("Condition", "$diagnose"), null);
});
