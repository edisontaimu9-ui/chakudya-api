import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDiagnoseStructured, diagnosisOperationFor } from "../src/fhirDiagnosis.js";
import { evaluateDiagnose, evaluateNcpDocument } from "../src/fhirNcp.js";
import { evaluateNutritionAssessment } from "../src/fhirAssessment.js";
import { codeSystemResource, structureDefinitionResource, operationDefinitionResource } from "../src/fhirTerminology.js";

const BASE = "https://x.test";
let n = 0;
const TERMS = {
  "NI-5.2": { code: "NI-5.2", term: "Evident protein-energy malnutrition", domain: "intake", class_name: "Nutrient Intake", specify_required: false, use_with_caution: false, edition: "2006" },
  "NI-2.1": { code: "NI-2.1", term: "Inadequate energy intake", domain: "intake", class_name: "Energy Balance", specify_required: false, use_with_caution: false, edition: "2006" },
};
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, terms: TERMS };

const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const S = (name, v) => ({ name, valueString: v });
const subject = S("subject", "Patient/1");

const dx = (items, top = []) => P([subject, ...top, part("diagnosis", [S("problemCode", "NI-2.1"), ...items])]);
const sign = (parts) => part("signItem", parts);
const eti = (parts) => part("etiologyItem", parts);
const inline = (code, value, extra = []) => part("observation", [{ name: "code", valueCode: code }, { name: "value", valueQuantity: value }, ...extra]);

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };
const msgs = (r) => { assert.equal(r.ok, false); assert.equal(r.status, 400); return r.outcome.issue.map((i) => i.diagnostics); };
const hasMsg = (m, re) => assert.ok(m.some((x) => re.test(x)), `no message matches ${re}: ${JSON.stringify(m)}`);
const of = (b, type) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === type);
const ext = (r, name) => r.extension.find((x) => x.url.endsWith(`/${name}`));
const sub = (e, url) => e.extension.filter((x) => x.url === url);

const BASIC = [S("etiology", "inadequate intake"), S("signsSymptoms", "BMI 16.2")];

// ─── Backward compatibility ───────────────────────────────────────────────
test("plain PES input behaves as before: same Condition fields, legacy extensions and note", () => {
  const body = dx(BASIC);
  const old = ok(evaluateDiagnose(body, ctx)).entry[0].resource;
  const cur = ok(evaluateDiagnoseStructured(body, ctx));
  assert.equal(cur.entry.length, 1, "no extra resources without evidence or author");
  const c = cur.entry[0].resource;
  assert.deepEqual(c.code, old.code);
  assert.deepEqual(c.note, old.note);
  assert.deepEqual(c.evidence, old.evidence);
  assert.equal(ext(c, "pes-etiology").valueString, "inadequate intake");
  assert.equal(ext(c, "pes-signs-symptoms").valueString, "BMI 16.2");
  assert.ok(ext(c, "pes-statement"));
});

test("errors the base operation raises keep their messages", () => {
  hasMsg(msgs(evaluateDiagnoseStructured(P([{ name: "subject", valueString: "Patient/1" }, part("diagnosis", [S("problemCode", "NI-2.1"), S("signsSymptoms", "x")])]), ctx)), /needs at least one 'etiology'/);
  hasMsg(msgs(evaluateDiagnoseStructured(P([part("diagnosis", [...BASIC])]), ctx)), /'subject' is required/);
  hasMsg(msgs(evaluateDiagnoseStructured(P([subject]), ctx)), /At least one 'diagnosis'/);
  hasMsg(msgs(evaluateDiagnoseStructured({ resourceType: "Bundle" }, ctx)), /Parameters/);
});

// ─── PES stored as components ─────────────────────────────────────────────
test("the PES statement is stored as components, not only as text", () => {
  const c = ok(evaluateDiagnoseStructured(dx([
    eti([S("text", "inadequate energy intake due to poor appetite"), S("system", "http://snomed.info/sct"), S("code", "64379006"), S("display", "Decrease in appetite")]),
    eti([S("text", "food insecurity")]),
    sign([S("text", "BMI 16.2 kg/m2")]),
    sign([S("text", "reduced meal frequency"), S("system", "urn:own"), S("code", "meals-low")]),
  ]), ctx)).entry[0].resource;
  const pes = ext(c, "pes-statement");
  const get = (name) => pes.extension.filter((x) => x.url === name);
  assert.equal(get("statement")[0].valueString, c.note[0].text);
  assert.equal(get("statement")[0].valueString, "Inadequate energy intake related to inadequate energy intake due to poor appetite; food insecurity as evidenced by BMI 16.2 kg/m2; reduced meal frequency.");
  assert.equal(get("problem")[0].valueCodeableConcept.coding[0].code, "NI-2.1");
  assert.equal(get("etiology").length, 2);
  assert.deepEqual(get("etiology")[0].valueCodeableConcept.coding[0], { system: "http://snomed.info/sct", code: "64379006", display: "Decrease in appetite" });
  assert.equal(get("etiology")[1].valueCodeableConcept.coding, undefined);
  assert.equal(get("signSymptom").length, 2);
  assert.equal(get("signSymptom")[1].extension[0].valueCodeableConcept.coding[0].code, "meals-low");
  // the legacy joined extensions still list every component
  assert.equal(ext(c, "pes-etiology").valueString, "inadequate energy intake due to poor appetite; food insecurity");
  assert.equal(c.evidence.length, 2);
  assert.equal(c.evidence[1].code[0].coding[0].code, "meals-low");
});

test("plain and structured components mix; plain ones come first", () => {
  const c = ok(evaluateDiagnoseStructured(dx([S("etiology", "plain cause"), eti([S("text", "item cause")]), S("signsSymptoms", "plain sign"), sign([S("text", "item sign")])]), ctx)).entry[0].resource;
  const pes = ext(c, "pes-statement").extension;
  assert.deepEqual(pes.filter((x) => x.url === "etiology").map((x) => x.valueCodeableConcept.text), ["plain cause", "item cause"]);
  assert.deepEqual(pes.filter((x) => x.url === "signSymptom").map((x) => x.extension[0].valueCodeableConcept.text), ["plain sign", "item sign"]);
  assert.deepEqual(c.evidence.map((e) => e.code[0].text), ["plain sign", "item sign"]);
});

test("additionalCoding adds ICD-10 / SNOMED next to the NCP term", () => {
  const c = ok(evaluateDiagnoseStructured(dx([...BASIC, part("additionalCoding", [S("system", "http://hl7.org/fhir/sid/icd-10"), S("code", "E44.0"), S("display", "Moderate protein-energy malnutrition")])]), ctx)).entry[0].resource;
  assert.equal(c.code.coding.length, 2);
  assert.match(c.code.coding[0].system, /CodeSystem\/ncp-diagnosis$/);
  assert.equal(c.code.coding[1].code, "E44.0");
  assert.equal(ext(c, "pes-statement").extension.find((x) => x.url === "problem").valueCodeableConcept.coding.length, 2);
});

// ─── Observation evidence ─────────────────────────────────────────────────
test("inline evidence becomes a validated Observation linked from Condition.evidence", () => {
  const b = ok(evaluateDiagnoseStructured(dx([
    S("etiology", "inadequate intake"),
    sign([inline("weight-change-percent", q(12, "%"), [{ name: "effectiveDateTime", valueDateTime: "2026-10-10" }])]),
    sign([S("text", "ate half of meals"), inline("intake-percent-of-requirement", q(55, "%"))]),
  ], [S("encounter", "Encounter/456"), S("effectiveDateTime", "2026-10-11T09:00:00+02:00")]), ctx));
  const cond = of(b, "Condition")[0];
  const obs = of(b, "Observation");
  assert.equal(obs.length, 2);
  const [w, i] = obs;
  assert.equal(w.valueQuantity.value, 12);
  assert.equal(w.subject.reference, "Patient/1");
  assert.equal(w.encounter.reference, "Encounter/456");
  assert.equal(w.effectiveDateTime, "2026-10-10");
  assert.equal(i.effectiveDateTime, "2026-10-11T09:00:00+02:00");
  assert.equal(cond.encounter.reference, "Encounter/456");
  const urls = b.entry.map((e) => e.fullUrl);
  const [fw, fi] = b.entry.filter((e) => e.resource.resourceType === "Observation").map((e) => e.fullUrl);
  assert.deepEqual(cond.evidence[0].detail, [{ reference: fw }]);
  assert.deepEqual(cond.evidence[1].detail, [{ reference: fi }]);
  assert.match(cond.evidence[0].code[0].text, /^Weight change from usual weight.*: 12 %$/, "text derived from the observation");
  assert.equal(cond.evidence[1].code[0].text, "ate half of meals", "given text wins");
  for (const d of cond.evidence.flatMap((e) => e.detail ?? [])) assert.ok(urls.includes(d.reference), "evidence resolves in the Bundle");
  const sign0 = ext(cond, "pes-statement").extension.filter((x) => x.url === "signSymptom")[0];
  assert.equal(sign0.extension.find((x) => x.url === "evidence").valueReference.reference, fw);
  assert.match(cond.note[0].text, /as evidenced by Weight change/);
});

test("evidence can point at an existing Observation, and legacy 'evidence' refs still work", () => {
  const c = ok(evaluateDiagnoseStructured(dx([
    S("etiology", "x"), sign([S("text", "low intake"), S("evidence", "urn:uuid:11111111-1111-4111-8111-111111111111"), S("evidence", "Observation/77")]),
    S("evidence", "Observation/legacy"),
  ]), ctx)).entry[0].resource;
  assert.deepEqual(c.evidence[0].detail.map((d) => d.reference), ["urn:uuid:11111111-1111-4111-8111-111111111111", "Observation/77"]);
  assert.deepEqual(c.evidence.at(-1).detail, [{ reference: "Observation/legacy" }]);
});

test("evidence is checked: units, range, timestamps, references, one measurement per sign", () => {
  const run = (parts, top = []) => msgs(evaluateDiagnoseStructured(dx([S("etiology", "x"), ...parts], top), ctx));
  hasMsg(run([sign([part("observation", [{ name: "code", valueCode: "weight-change-percent" }, { name: "value", valueQuantity: { value: 12 } }])])]), /signItem\[0\]\.observation.*recognised unit/);
  hasMsg(run([sign([inline("weight-change-percent", q(250, "%"))])]), /outside the plausible range/);
  hasMsg(run([sign([inline("weight", q(60, "kg"), [{ name: "effectiveDateTime", valueDateTime: "2027-01-01" }])])]), /in the future/);
  hasMsg(run([sign([inline("weihgt", q(60, "kg"))])]), /Unknown measurement/);
  hasMsg(run([sign([inline("weight", q(60, "kg")), inline("weight", q(61, "kg"))])]), /more than one 'observation'/);
  hasMsg(run([sign([S("text", "x"), S("evidence", "somewhere")])]), /must be an Observation reference/);
  hasMsg(run([sign([S("evidence", "Observation/1")])]), /needs 'text' or an inline 'observation'/);
  hasMsg(run([sign([])]), /needs 'text' or an inline 'observation'/);
  hasMsg(run([sign([S("text", "x")])], [S("effectiveDateTime", "yesterday")]), /effectiveDateTime/);
});

// ─── Coding, timestamps, structure ────────────────────────────────────────
test("structured inputs are validated, and every error is reported together", () => {
  const m = msgs(evaluateDiagnoseStructured(dx([
    eti([]),
    eti([S("text", "x"), S("system", "http://snomed.info/sct")]),
    sign([S("text", "x"), S("system", "not a uri"), S("code", "1")]),
    part("additionalCoding", [S("code", "E44.0")]),
    S("recordedDate", "2026-02-30"),
  ], [S("encounter", "Visit/1")]), ctx));
  hasMsg(m, /etiologyItem\[0\]\.text is required/);
  hasMsg(m, /etiologyItem\[1\]: a coding needs both/);
  hasMsg(m, /signItem\[0\]: system .* must be a URI/);
  hasMsg(m, /additionalCoding\[0\]: a coding needs both/);
  hasMsg(m, /recordedDate .* not a valid FHIR date/);
  hasMsg(m, /Encounter reference/);
  hasMsg(msgs(evaluateDiagnoseStructured(dx([...BASIC, S("recordedDate", "2027-01-01")]), ctx)), /in the future/);
  hasMsg(msgs(evaluateDiagnoseStructured(dx([...BASIC, S("recordedDate", "2026-10-10T08:00:00")]), ctx)), /not a valid FHIR date/);
  assert.equal(ok(evaluateDiagnoseStructured(dx([...BASIC, S("recordedDate", "2026-10-10T08:00:00+02:00")]), ctx)).entry[0].resource.recordedDate, "2026-10-10T08:00:00+02:00");
});

// ─── Provenance ───────────────────────────────────────────────────────────
test("Provenance: who authored the diagnosis, from which sources, covering the Condition and its evidence", () => {
  const b = ok(evaluateDiagnoseStructured(dx([
    S("etiology", "x"),
    sign([inline("weight-change-percent", q(12, "%"))]),
    sign([S("text", "low intake"), S("evidence", "Observation/77")]),
  ], [S("author", "Practitioner/dietitian-1"), S("asserter", "Practitioner/dr-banda"), S("source", "patient interview"), S("source", "ward medical record")]), ctx));
  const cond = b.entry.find((e) => e.resource.resourceType === "Condition");
  const evObs = b.entry.find((e) => e.resource.resourceType === "Observation");
  const prov = of(b, "Provenance");
  assert.equal(prov.length, 1);
  const pv = prov[0];
  assert.deepEqual(pv.target.map((t) => t.reference), [cond.fullUrl, evObs.fullUrl]);
  assert.equal(pv.recorded, ctx.now);
  assert.equal(pv.activity.coding[0].code, "CREATE");
  assert.deepEqual(pv.agent[0].who, { reference: "Practitioner/dietitian-1" });
  assert.equal(pv.agent[0].type.coding[0].code, "author");
  assert.deepEqual(pv.entity.map((e) => e.what), [{ reference: "Observation/77" }, { display: "patient interview" }, { display: "ward medical record" }]);
  assert.ok(pv.entity.every((e) => e.role === "source"));
  assert.deepEqual(cond.resource.recorder, { reference: "Practitioner/dietitian-1" });
  assert.deepEqual(cond.resource.asserter, { reference: "Practitioner/dr-banda" });
  assert.deepEqual(evObs.resource.performer, [{ reference: "Practitioner/dietitian-1" }], "evidence observations carry the author as performer");
});

test("Provenance: one per diagnosis; a name author is kept as display; none without an author", () => {
  const two = P([subject, S("author", "Dietitian A"),
    part("diagnosis", [S("problemCode", "NI-2.1"), ...BASIC]),
    part("diagnosis", [S("problemCode", "NI-5.2"), S("etiology", "y"), S("signsSymptoms", "z")])]);
  const b = ok(evaluateDiagnoseStructured(two, ctx));
  const prov = of(b, "Provenance");
  assert.equal(prov.length, 2);
  assert.deepEqual(prov[0].agent[0].who, { display: "Dietitian A" });
  assert.notEqual(prov[0].target[0].reference, prov[1].target[0].reference);
  assert.equal(of(ok(evaluateDiagnoseStructured(dx(BASIC), ctx)), "Provenance").length, 0);
  hasMsg(msgs(evaluateDiagnoseStructured(dx(BASIC, [S("source", "interview")]), ctx)), /'source' needs an 'author'/);
});

// ─── Chains ───────────────────────────────────────────────────────────────
test("the diagnosis Bundle goes into the ADIME note: Condition in diagnosis, evidence in assessment, Provenance supporting", () => {
  const b = ok(evaluateDiagnoseStructured(dx([S("etiology", "x"), sign([inline("weight-change-percent", q(12, "%"))])], [S("author", "Practitioner/d1")]), ctx));
  const doc = ok(evaluateNcpDocument(P([subject, S("author", "Practitioner/d1"), { name: "resource", resource: b }]), ctx));
  const comp = doc.entry[0].resource;
  const section = (code) => comp.section.find((s) => s.code.coding[0].code === code);
  assert.equal(section("nutrition-diagnosis").entry.length, 1);
  assert.equal(section("nutrition-assessment").entry.length, 1);
  const types = doc.entry.map((e) => e.resource.resourceType);
  assert.ok(types.includes("Provenance"));
  const urls = new Set(doc.entry.map((e) => e.fullUrl));
  const cond = doc.entry.find((e) => e.resource.resourceType === "Condition").resource;
  for (const d of cond.evidence.flatMap((e) => e.detail ?? [])) assert.ok(urls.has(d.reference), "evidence still resolves in the document");
});

test("an assessment Bundle's observation can be cited as evidence by its urn:uuid", () => {
  const a = ok(evaluateNutritionAssessment(P([
    { name: "subject", valueString: "Patient/1" }, { name: "encounter", valueString: "Encounter/456" },
    part("observation", [{ name: "code", valueCode: "energy-intake-kcal" }, { name: "value", valueQuantity: q(900, "kcal/d") }]),
  ]), ctx));
  const intake = a.entry.find((e) => e.resource.resourceType === "Observation");
  const c = ok(evaluateDiagnoseStructured(dx([S("etiology", "x"), sign([S("text", "energy intake 900 kcal/d"), S("evidence", intake.fullUrl)])]), ctx)).entry[0].resource;
  assert.deepEqual(c.evidence[0].detail, [{ reference: intake.fullUrl }]);
});

// ─── Conformance ──────────────────────────────────────────────────────────
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((x) => walk(x, visit));
  if (node && typeof node === "object") { visit(node); Object.values(node).forEach((x) => walk(x, visit)); }
}

test("every code system and extension the diagnosis emits has a definition", () => {
  const b = ok(evaluateDiagnoseStructured(dx([
    S("etiology", "x"), S("severity", "moderate"),
    sign([inline("weight-change-percent", q(12, "%")), S("system", "urn:own"), S("code", "c1")]),
    sign([inline("intake-percent-of-requirement", q(55, "%"))]),
  ], [S("author", "Practitioner/d1")]), ctx));
  const csPrefix = `${BASE}/fhir/CodeSystem/`, sdPrefix = `${BASE}/fhir/StructureDefinition/`;
  const missing = new Set();
  let codes = 0, exts = 0;
  walk(b, (o) => {
    if (typeof o.system === "string" && o.system.startsWith(csPrefix) && typeof o.code === "string") {
      if (o.system.endsWith("/ncp-diagnosis")) return; // Supabase-backed, covered by the base tests
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
  assert.ok(codes >= 4 && exts >= 3, `${codes} codes, ${exts} extensions`);
  // the new evidence codes live in the assessment-item code system
  const items = codeSystemResource(BASE, "assessment-item").concept.map((c) => c.code);
  assert.ok(items.includes("weight-change-percent") && items.includes("intake-percent-of-requirement"));
});

test("pes-statement is a complex extension and the OperationDefinition lists the new inputs", () => {
  const sd = structureDefinitionResource(BASE, "pes-statement");
  assert.equal(sd.differential.element.find((e) => e.path === "Extension.url").fixedUri, `${BASE}/fhir/StructureDefinition/pes-statement`);
  assert.deepEqual(sd.differential.element.filter((e) => e.sliceName).map((e) => e.sliceName), ["statement", "problem", "etiology", "signSymptom"]);
  assert.equal(sd.differential.element.find((e) => e.path === "Extension.value[x]").max, "0");
  const od = operationDefinitionResource(BASE, "Condition-diagnose");
  const names = od.parameter.filter((p) => p.use === "in").map((p) => p.name);
  for (const x of ["subject", "encounter", "author", "asserter", "source", "effectiveDateTime", "diagnosis"]) assert.ok(names.includes(x), x);
  const d = od.parameter.find((p) => p.name === "diagnosis");
  for (const x of ["etiologyItem", "signItem", "additionalCoding"]) assert.ok(d.part.some((p) => p.name === x), x);
});

test("the structured operation is the one registered for Condition/$diagnose", () => {
  assert.equal(diagnosisOperationFor("Condition", "$diagnose"), evaluateDiagnoseStructured);
  assert.equal(diagnosisOperationFor("Observation", "$screen"), null);
});
