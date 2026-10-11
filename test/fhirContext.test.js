import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCareContext, contextOperationFor } from "../src/fhirContext.js";
import { evaluateAdimeDocument, evaluateValidateDocument, checkAdimeDocument } from "../src/fhirDocument.js";
import { evaluateNutritionAssessment } from "../src/fhirAssessment.js";
import { evaluateDiagnoseStructured } from "../src/fhirDiagnosis.js";
import { evaluateInterveneStructured } from "../src/fhirIntervention.js";
import { evaluateMonitor } from "../src/fhirMonitoring.js";
import { buildCapabilityStatement } from "../src/fhir.js";
import { codeSystemResource, operationDefinitionResource } from "../src/fhirTerminology.js";

const BASE = "https://x.test";
let n = 0;
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const S = (name, v) => ({ name, valueString: v });
const R = (b) => ({ name: "resource", resource: b });
const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const Q = (name, v, u) => ({ name, valueQuantity: q(v, u) });
const obs = (code, v, u) => part("observation", [S("code", code), Q("value", v, u)]);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };
const msgs = (r, status = 400) => { assert.equal(r.ok, false); assert.equal(r.status, status); return r.outcome.issue.map((i) => i.diagnostics); };
const of = (b, t) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === t);

const teamParams = (extra = []) => P([
  S("subject", "Patient/1"), S("encounter", "Encounter/1"),
  part("organization", [S("id", "hosp"), S("name", "Zomba Central Hospital"), S("type", "prov"), S("identifier", "ZCH-001"), S("city", "Zomba"), S("country", "Malawi")]),
  part("organization", [S("id", "nutr"), S("name", "Nutrition Department"), S("type", "dept"), S("partOf", "hosp")]),
  part("practitioner", [S("id", "rd"), S("name", "Grace Banda"), S("identifier", "DT-4471"), part("qualification", [S("code", "Registered Dietitian"), S("issuer", "Dietetics Council")])]),
  part("practitioner", [S("id", "dr"), S("name", "James Phiri")]),
  part("practitioner", [S("id", "nu"), S("name", "Mary Chirwa")]),
  part("role", [S("id", "rd1"), S("practitioner", "rd"), S("organization", "nutr"), S("role", "dietitian"), S("specialty", "Clinical nutrition")]),
  part("role", [S("id", "dr1"), S("practitioner", "dr"), S("organization", "hosp"), S("role", "physician")]),
  part("careTeam", [
    S("name", "Weight restoration team"), S("managingOrganization", "hosp"), S("reason", "Undernutrition"),
    part("member", [S("role", "rd1")]),
    part("member", [S("role", "dr1")]),
    part("member", [S("practitioner", "nu"), S("memberRole", "nurse"), S("onBehalfOf", "hosp")]),
  ]),
  ...extra,
]);

test("organizations, practitioners, roles and a care team come back as linked resources", () => {
  const b = ok(evaluateCareContext(teamParams(), ctx));
  assert.equal(b.type, "collection");
  assert.equal(of(b, "Organization").length, 2);
  assert.equal(of(b, "Practitioner").length, 3);
  assert.equal(of(b, "PractitionerRole").length, 2);
  const urls = new Set(b.entry.map((e) => e.fullUrl));
  const team = of(b, "CareTeam")[0];
  assert.equal(team.subject.reference, "Patient/1");
  assert.equal(team.encounter.reference, "Encounter/1");
  assert.equal(team.participant.length, 3);
  for (const m of team.participant) assert.ok(urls.has(m.member.reference));
  assert.deepEqual(team.participant.map((m) => m.role[0].coding[0].code), ["dietitian", "physician", "nurse"]);
  const dept = of(b, "Organization").find((o) => o.name === "Nutrition Department");
  assert.ok(urls.has(dept.partOf.reference));
  assert.equal(dept.type[0].coding[0].code, "dept");
  const rd = of(b, "Practitioner")[0];
  assert.deepEqual(rd.name[0], { family: "Banda", given: ["Grace"], text: "Grace Banda" });
  assert.equal(rd.identifier[0].value, "DT-4471");
  assert.equal(rd.qualification[0].issuer.display, "Dietetics Council");
  assert.equal(of(b, "PractitionerRole")[0].specialty[0].text, "Clinical nutrition");
});

test("a role outside the list is kept as text; a reference to your own resource can replace a local id", () => {
  const b = ok(evaluateCareContext(P([
    part("practitioner", [S("id", "x"), S("name", "Ali Mwale")]),
    part("role", [S("practitioner", "x"), S("organization", "Organization/77"), S("role", "Lactation consultant")]),
  ]), ctx));
  const r = of(b, "PractitionerRole")[0];
  assert.equal(r.code[0].text, "Lactation consultant");
  assert.equal(r.code[0].coding, undefined);
  assert.equal(r.organization.reference, "Organization/77");
});

test("every problem is reported at once", () => {
  const m = msgs(evaluateCareContext(P([
    part("organization", [S("id", "a"), S("partOf", "a")]),
    part("organization", [S("id", "a"), S("name", "Dup")]),
    part("practitioner", [S("id", "p")]),
    part("role", [S("practitioner", "ghost"), S("role", "dietitian"), S("periodStart", "2026-02-01"), S("periodEnd", "2026-01-01")]),
    part("careTeam", [S("status", "retired"), part("member", [S("role", "r9"), S("practitioner", "p")])]),
  ]), ctx));
  for (const re of [/used twice/, /itself/, /name .* identifier is required/, /ghost/, /before periodStart/, /'subject' .* required with a careTeam/, /status must be one of/, /exactly one of/]) {
    assert.ok(m.some((x) => re.test(x)), `${re}: ${JSON.stringify(m)}`);
  }
  assert.match(msgs(evaluateCareContext(P([]), ctx))[0], /Nothing to build/);
  assert.match(msgs(evaluateCareContext({ resourceType: "Bundle" }, ctx))[0], /Parameters/);
});

test("a single-discipline team is noted, not rejected", () => {
  const b = ok(evaluateCareContext(P([
    S("subject", "Patient/1"),
    part("practitioner", [S("id", "a"), S("name", "A One")]), part("practitioner", [S("id", "b"), S("name", "B Two")]),
    part("careTeam", [part("member", [S("practitioner", "a"), S("memberRole", "dietitian")]), part("member", [S("practitioner", "b"), S("memberRole", "dietitian")])]),
  ]), ctx));
  assert.match(of(b, "OperationOutcome")[0].issue[0].diagnostics, /fewer than two disciplines/);
});

// ── into the ADIME document ───────────────────────────────────────────────
function flow() {
  const assessment = ok(evaluateNutritionAssessment(P([
    S("subject", "Patient/1"), S("encounter", "Encounter/1"), S("effectiveDateTime", "2026-09-01T08:00:00Z"), { name: "ageYears", valueInteger: 30 },
    obs("weight", 48, "kg"), obs("height", 160, "cm"),
  ]), ctx));
  const diagnosis = ok(evaluateDiagnoseStructured(P([
    S("subject", "Patient/1"), S("author", "Grace Banda"),
    part("diagnosis", [S("problem", "Inadequate energy intake"), S("domain", "intake"), S("etiology", "poor appetite"), S("signsSymptoms", "intake 55% of requirement")]),
  ]), ctx));
  const plan = ok(evaluateInterveneStructured(P([
    R(diagnosis), S("author", "Grace Banda"), S("title", "Weight restoration"),
    part("goal", [S("description", "Reach 52 kg"), S("measure", "Body weight"), S("measureCode", "weight"), S("direction", "increase"), Q("baseline", 48, "kg"), Q("target", 52, "kg"), S("dueDate", "2026-12-20")]),
  ]), ctx));
  const followUp = ok(evaluateMonitor(P([R(plan), { name: "baseline", resource: assessment }, S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10T09:00:00Z"), obs("weight", 49, "kg")]), ctx));
  return [assessment, diagnosis, plan, followUp];
}
const docOf = (extra = [], team = ok(evaluateCareContext(teamParams(), ctx))) =>
  ok(evaluateAdimeDocument(P([S("subject", "Patient/1"), S("author", "Grace Banda"), ...extra, ...flow().map(R), R(team)]), ctx));

test("the author is resolved to the dietitian's role and the facility becomes the custodian", () => {
  const doc = docOf();
  const comp = doc.entry[0].resource;
  const role = doc.entry.find((e) => e.fullUrl === comp.author[0].reference);
  assert.equal(role.resource.resourceType, "PractitionerRole");
  assert.equal(role.resource.code[0].coding[0].code, "dietitian");
  assert.equal(comp.author[0].display, "Grace Banda");
  // the dietitian works in the department; the custodian is the hospital that contains it
  const custodian = doc.entry.find((e) => e.fullUrl === comp.custodian.reference).resource;
  assert.equal(custodian.name, "Zomba Central Hospital");
});

test("the care team is linked from the care plan; context is supporting, never section content", () => {
  const doc = docOf();
  const team = doc.entry.find((e) => e.resource.resourceType === "CareTeam");
  for (const e of doc.entry.filter((x) => x.resource.resourceType === "CarePlan")) assert.equal(e.resource.careTeam[0].reference, team.fullUrl);
  const comp = doc.entry[0].resource;
  const inSections = new Set(comp.section.flatMap((s) => (s.entry ?? []).map((x) => x.reference)));
  for (const e of doc.entry) if (["Practitioner", "PractitionerRole", "Organization", "CareTeam"].includes(e.resource.resourceType)) assert.ok(!inSections.has(e.fullUrl));
  assert.deepEqual(checkAdimeDocument(doc).errors, []);
  assert.deepEqual(checkAdimeDocument(doc).warnings.filter((w) => /author|custodian|CareTeam|Practitioner|Organization/.test(w)), []);
});

test("without context the document still builds, with warnings about the author and facility", () => {
  const doc = ok(evaluateAdimeDocument(P([S("subject", "Patient/1"), S("author", "Grace Banda"), ...flow().map(R)]), ctx));
  const out = ok(evaluateValidateDocument(P([R(doc)]), ctx));
  const w = out.issue.filter((i) => i.severity === "warning").map((i) => i.diagnostics).join("|");
  assert.match(w, /author is a name only/);
  assert.match(w, /custodian/);
});

test("an explicit custodian parameter wins; a context-only mistake is caught by the validator", () => {
  const doc = docOf([S("custodian", "Organization/ZCH")]);
  assert.equal(doc.entry[0].resource.custodian.reference, "Organization/ZCH");
  const bad = structuredClone(docOf());
  bad.entry.find((e) => e.resource.resourceType === "CareTeam").resource.subject = { reference: "Patient/99" };
  bad.entry.find((e) => e.resource.resourceType === "Organization").resource = { resourceType: "Organization" };
  const errs = checkAdimeDocument(bad).errors.join("|");
  assert.match(errs, /Patient\/99/);
  assert.match(errs, /neither a name nor an identifier/);
});

test("a broken link inside the care team stops the document", () => {
  const team = ok(evaluateCareContext(teamParams(), ctx));
  team.entry.find((e) => e.resource.resourceType === "CareTeam").resource.participant[0].member = { reference: "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff" };
  const m = msgs(evaluateAdimeDocument(P([S("subject", "Patient/1"), S("author", "Grace Banda"), ...flow().map(R), R(team)]), ctx), 422);
  assert.ok(m.some((x) => /ffffffff/.test(x)));
});

test("registered, declared and defined", () => {
  assert.equal(typeof contextOperationFor("Bundle", "$care-context"), "function");
  const cap = buildCapabilityStatement(BASE);
  const declared = cap.rest[0].resource.flatMap((r) => (r.operation ?? []).map((o) => `${r.type}/$${o.name}`));
  assert.ok(declared.includes("Bundle/$care-context"));
  assert.ok(operationDefinitionResource(BASE, "Bundle-care-context"));
  const roles = codeSystemResource(BASE, "ncp-care-role");
  for (const code of ["dietitian", "physician", "nurse"]) assert.ok(roles.concept.some((c) => c.code === code));
  // every code system code the operation emits is defined
  const b = ok(evaluateCareContext(teamParams(), ctx));
  const missing = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.system === "string" && o.system.startsWith(`${BASE}/fhir/CodeSystem/`) && o.code) {
      const def = codeSystemResource(BASE, o.system.slice(`${BASE}/fhir/CodeSystem/`.length));
      if (!def?.concept.some((c) => c.code === o.code)) missing.push(`${o.system}#${o.code}`);
    }
    Object.values(o).forEach(walk);
  };
  walk(b);
  assert.deepEqual(missing, []);
});
