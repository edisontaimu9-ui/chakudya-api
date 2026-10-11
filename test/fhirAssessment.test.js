import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateNutritionAssessment,
  evaluateQuestionnaireResponseValidate,
  assessmentOperationFor,
  parseFhirTime,
  questionnaireResource,
  questionnaireSearchBundle,
  QUESTIONNAIRE_IDS,
  ITEMS,
} from "../src/fhirAssessment.js";
import { evaluateScreen } from "../src/fhirNcp.js";
import { buildCapabilityStatement } from "../src/fhir.js";
import {
  codeSystemResource, operationDefinitionResource, structureDefinitionResource, OPERATION_DEFINITION_IDS,
} from "../src/fhirTerminology.js";

const BASE = "https://x.test";
let n = 0;
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };

const q = (value, unit) => ({ value, unit, system: "http://unitsofmeasure.org", code: unit });
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const obs = (code, value, extra = []) => part("observation", [{ name: "code", valueCode: code }, ...(value === undefined ? [] : [{ name: "value", ...value }]), ...extra]);
const Qv = (v, u) => ({ valueQuantity: q(v, u) });

const PATIENT = {
  resourceType: "Patient", id: "p-1",
  identifier: [{ system: "urn:mrn:qech", value: "QECH-0001" }],
  name: [{ family: "Banda", given: ["Chikondi"] }],
  gender: "female", birthDate: "1990-05-04",
  telecom: [{ system: "phone", value: "0999000000" }], address: [{ text: "Zomba" }],
};
const ENCOUNTER = { resourceType: "Encounter", status: "in-progress", class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP" }, period: { start: "2026-10-11T07:30:00+02:00" } };
const withPE = (...rest) => P([{ name: "patient", resource: PATIENT }, { name: "encounter", resource: ENCOUNTER }, ...rest]);
const withRefs = (...rest) => P([{ name: "subject", valueString: "Patient/123" }, { name: "encounter", valueString: "Encounter/456" }, ...rest]);

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };
const bad = (r) => { assert.equal(r.ok, false); assert.equal(r.status, 400); return r.outcome.issue.map((i) => i.diagnostics); };
const hasMsg = (msgs, re) => assert.ok(msgs.some((m) => re.test(m)), `no message matches ${re}: ${JSON.stringify(msgs)}`);
const resources = (bundle, type) => bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === type);
const obsBy = (bundle, code) => resources(bundle, "Observation").find((o) => o.code.coding.some((c) => c.code === code));
const notes = (bundle) => resources(bundle, "OperationOutcome")[0]?.issue ?? [];

// ─── Timestamps ───────────────────────────────────────────────────────────
test("parseFhirTime: accepts FHIR dates and dateTimes, rejects the rest", () => {
  assert.equal(parseFhirTime("2026").precision, "year");
  assert.equal(parseFhirTime("2026-10").precision, "month");
  assert.equal(parseFhirTime("2026-10-11").precision, "day");
  assert.equal(parseFhirTime("2026-10-11T08:00:00Z").precision, "instant");
  assert.equal(parseFhirTime("2026-10-11T10:00:00+02:00").ms, parseFhirTime("2026-10-11T08:00:00Z").ms);
  assert.ok(parseFhirTime("2024-02-29"));
  for (const s of ["2026-13-01", "2026-02-30", "2025-02-29", "2026-10-11T08:00:00", "2026-10-11T25:00:00Z", "2026-10-11T08:00:00+15:00", "11/10/2026", "", null, 20261011]) {
    assert.equal(parseFhirTime(s), null, String(s));
  }
});

// ─── Patient and Encounter: linking ───────────────────────────────────────
test("assessment: a Patient and Encounter resource are carried and every resource points at them", () => {
  const b = ok(evaluateNutritionAssessment(withPE(
    { name: "author", valueString: "Practitioner/dietitian-1" },
    obs("weight", Qv(60, "kg")), obs("hemoglobin", Qv(11, "g/dL")),
  ), ctx));
  assert.equal(b.type, "collection");
  const patient = b.entry.find((e) => e.resource.resourceType === "Patient");
  const encounter = b.entry.find((e) => e.resource.resourceType === "Encounter");
  assert.match(patient.fullUrl, /^urn:uuid:/);
  assert.equal(encounter.resource.subject.reference, patient.fullUrl);
  assert.equal(patient.resource.id, "p-1");
  for (const o of resources(b, "Observation")) {
    assert.equal(o.subject.reference, patient.fullUrl);
    assert.equal(o.encounter.reference, encounter.fullUrl);
    assert.deepEqual(o.performer, [{ reference: "Practitioner/dietitian-1" }]);
    assert.equal(o.status, "final");
  }
});

test("assessment: telecom and address are not carried (data minimisation) and the response says so", () => {
  const b = ok(evaluateNutritionAssessment(withPE(obs("weight", Qv(60, "kg"))), ctx));
  const p = resources(b, "Patient")[0];
  assert.equal(p.telecom, undefined);
  assert.equal(p.address, undefined);
  assert.deepEqual(p.name, [{ family: "Banda", given: ["Chikondi"] }]);
  assert.equal(p.gender, "female");
  hasMsg(notes(b).map((i) => i.diagnostics), /telecom, address/);
});

test("assessment: references to an existing patient and encounter emit no Patient or Encounter entry", () => {
  const b = ok(evaluateNutritionAssessment(withRefs(obs("weight", Qv(60, "kg"))), ctx));
  assert.equal(resources(b, "Patient").length, 0);
  assert.equal(resources(b, "Encounter").length, 0);
  const o = obsBy(b, "29463-7");
  assert.equal(o.subject.reference, "Patient/123");
  assert.equal(o.encounter.reference, "Encounter/456");
});

test("assessment: patient and encounter are required, and one patient form only", () => {
  hasMsg(bad(evaluateNutritionAssessment(P([{ name: "encounter", valueString: "Encounter/1" }]), ctx)), /patient is required/);
  hasMsg(bad(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }]), ctx)), /'encounter' is required/);
  hasMsg(bad(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }, { name: "patient", resource: PATIENT }, { name: "encounter", valueString: "Encounter/1" }]), ctx)), /either 'patient'/);
  hasMsg(bad(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Person/1" }, { name: "encounter", valueString: "Encounter/1" }]), ctx)), /Patient reference/);
  hasMsg(bad(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }, { name: "encounter", valueString: "Visit/1" }]), ctx)), /Encounter reference/);
  assert.equal(evaluateNutritionAssessment({ resourceType: "Bundle" }, ctx).ok, false);
});

test("assessment: Patient validation", () => {
  const run = (patient) => bad(evaluateNutritionAssessment(P([{ name: "patient", resource: patient }, { name: "encounter", resource: ENCOUNTER }]), ctx));
  hasMsg(run({ resourceType: "Patient", gender: "female" }), /at least one identifier/);
  hasMsg(run({ ...PATIENT, gender: "F" }), /gender must be one of/);
  hasMsg(run({ ...PATIENT, birthDate: "2027-01-01" }), /in the future/);
  hasMsg(run({ ...PATIENT, birthDate: "04/05/1990" }), /FHIR date/);
  hasMsg(run({ ...PATIENT, identifier: [{ system: "x" }] }), /non-empty 'value'/);
  hasMsg(run({ ...PATIENT, id: "bad id!" }), /Patient\.id/);
  hasMsg(run({ resourceType: "Practitioner" }), /must be a Patient/);
  const b = ok(evaluateNutritionAssessment(P([{ name: "patient", resource: { ...PATIENT, birthDate: "1990" } }, { name: "encounter", resource: ENCOUNTER }, obs("weight", Qv(60, "kg"))]), ctx));
  hasMsg(notes(b).map((i) => i.diagnostics), /year or month precision/);
});

test("assessment: Encounter validation", () => {
  const run = (enc) => bad(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }, { name: "encounter", resource: enc }]), ctx));
  hasMsg(run({ ...ENCOUNTER, status: undefined }), /Encounter\.status is required/);
  hasMsg(run({ ...ENCOUNTER, status: "cancelled" }), /cannot be recorded/);
  hasMsg(run({ ...ENCOUNTER, status: "entered-in-error" }), /cannot be recorded/);
  hasMsg(run({ ...ENCOUNTER, class: undefined }), /Encounter\.class is required/);
  hasMsg(run({ ...ENCOUNTER, class: { code: "XYZ" } }), /not in v3-ActCode/);
  hasMsg(run({ ...ENCOUNTER, period: { start: "2026-10-11T07:30:00" } }), /timezone/);
  hasMsg(run({ ...ENCOUNTER, period: { start: "2026-10-11T07:30:00Z", end: "2026-10-10T07:30:00Z" } }), /before period\.start/);
  hasMsg(run({ ...ENCOUNTER, subject: { reference: "Patient/999" } }), /not the assessment patient/);
  hasMsg(run({ resourceType: "Patient" }), /must be an Encounter/);
  // matching subject is fine; a finished encounter with no end draws a warning
  const b = ok(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }, { name: "encounter", resource: { ...ENCOUNTER, status: "finished", subject: { reference: "Patient/1" } } }, obs("weight", Qv(60, "kg"))]), ctx));
  hasMsg(notes(b).map((i) => i.diagnostics), /finished but period\.end is missing/);
});

// ─── Observations: units, ranges, conversion ──────────────────────────────
test("anthropometry is normalised to kg and cm, and BMI is computed with the WHO adult class", () => {
  const b = ok(evaluateNutritionAssessment(withPE(obs("weight", Qv(132, "lb")), obs("height", Qv(1.65, "m"))), ctx));
  const w = obsBy(b, "29463-7"), h = obsBy(b, "8302-2"), bmi = obsBy(b, "39156-5");
  assert.deepEqual([w.valueQuantity.value, w.valueQuantity.code], [59.874, "kg"]);
  assert.match(w.note[0].text, /Reported as 132 lb; converted to 59.874 kg/);
  assert.deepEqual([h.valueQuantity.value, h.valueQuantity.code], [165, "cm"]);
  assert.equal(bmi.valueQuantity.value, 22);
  assert.equal(bmi.component[0].valueCodeableConcept.coding[0].code, "normal");
  assert.equal(bmi.interpretation[0].coding[0].code, "N");
  assert.equal(bmi.derivedFrom.length, 2);
  const urls = b.entry.map((e) => e.fullUrl);
  for (const d of bmi.derivedFrom) assert.ok(urls.includes(d.reference), "derivedFrom resolves in the Bundle");
});

test("BMI class: obese adult, child gets none, unknown age gets none, each explained", () => {
  const params = (extra) => P([{ name: "subject", valueString: "Patient/1" }, { name: "encounter", valueString: "Encounter/1" }, obs("weight", Qv(100, "kg")), obs("height", Qv(170, "cm")), ...extra]);
  let b = ok(evaluateNutritionAssessment(params([{ name: "ageYears", valueInteger: 40 }]), ctx));
  assert.equal(obsBy(b, "39156-5").component[0].valueCodeableConcept.coding[0].code, "obesity-class-1");
  b = ok(evaluateNutritionAssessment(params([{ name: "ageYears", valueInteger: 12 }]), ctx));
  assert.equal(obsBy(b, "39156-5").component, undefined);
  hasMsg(notes(b).map((i) => i.diagnostics), /under 18.*evaluate-growth/);
  b = ok(evaluateNutritionAssessment(params([]), ctx));
  assert.equal(obsBy(b, "39156-5").component, undefined);
  hasMsg(notes(b).map((i) => i.diagnostics), /age is unknown/);
  // age comes from a full birth date at the encounter date
  b = ok(evaluateNutritionAssessment(withPE(obs("weight", Qv(100, "kg")), obs("height", Qv(170, "cm"))), ctx));
  assert.ok(obsBy(b, "39156-5").component);
});

test("BMI: not computed (with a warning) for a missing or repeated input", () => {
  let b = ok(evaluateNutritionAssessment(withRefs(obs("weight", Qv(60, "kg"))), ctx));
  assert.equal(obsBy(b, "39156-5"), undefined);
  hasMsg(notes(b).map((i) => i.diagnostics), /body height is missing/);
  b = ok(evaluateNutritionAssessment(withRefs(obs("weight", Qv(60, "kg")), obs("weight", Qv(61, "kg"), [{ name: "effectiveDateTime", valueDateTime: "2026-10-10" }]), obs("height", Qv(170, "cm"))), ctx));
  assert.equal(obsBy(b, "39156-5"), undefined);
  hasMsg(notes(b).map((i) => i.diagnostics), /exactly one weight and one height/);
});

test("units are never guessed, and implausible values are rejected with the unit in the message", () => {
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", { valueQuantity: { value: 70 } })), ctx)), /recognised unit \(kg, g, lb\)/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", { valueDecimal: 70 })), ctx)), /Quantity with a numeric value and a unit/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", Qv(70, "stone"))), ctx)), /recognised unit/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", Qv(70, "cm"))), ctx)), /not valid for weight/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", Qv(700, "kg"))), ctx)), /outside the plausible range \(0.2-500 kg\)/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", Qv(70, "g"))), ctx)), /outside the plausible range/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("height", Qv(1650, "cm"))), ctx)), /outside the plausible range/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(91, "g/dL"))), ctx)), /outside the plausible range \(1-30 g\/dL\)/);
  // the same haemoglobin in g/L is fine (converted only for the check) and keeps its unit
  const b = ok(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(91, "g/L"))), ctx));
  assert.deepEqual([obsBy(b, "718-7").valueQuantity.value, obsBy(b, "718-7").valueQuantity.code], [91, "g/L"]);
  // a Quantity in a non-UCUM system is not recognised
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", { valueQuantity: { value: 70, unit: "kg", system: "http://example.org/u", code: "kg" } })), ctx)), /recognised unit/);
});

test("temperature in Fahrenheit is checked in Celsius and kept as reported", () => {
  const b = ok(evaluateNutritionAssessment(withRefs(obs("temperature", Qv(101.3, "[degF]"))), ctx));
  assert.equal(obsBy(b, "8310-5").valueQuantity.code, "[degF]");
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("temperature", Qv(370, "Cel"))), ctx)), /outside the plausible range/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("temperature", Qv(5, "[degF]"))), ctx)), /outside the plausible range/);
});

test("unknown code, wrong domain, repeated parts and a missing value are all reported together", () => {
  const msgs = bad(evaluateNutritionAssessment(withRefs(
    obs("weihgt", Qv(70, "kg")),
    obs("weight", Qv(70, "kg"), [{ name: "domain", valueCode: "biochemical" }]),
    obs("hemoglobin", undefined),
    obs("height", Qv(170, "cm"), [{ name: "domain", valueCode: "bogus" }]),
    part("observation", [{ name: "value", valueQuantity: q(1, "kg") }]),
  ), ctx));
  hasMsg(msgs, /Unknown measurement "weihgt"/);
  hasMsg(msgs, /belongs to the "anthropometry" area/);
  hasMsg(msgs, /hemoglobin needs a value, or a dataAbsentReason/);
  hasMsg(msgs, /domain must be one of/);
  hasMsg(msgs, /observation\.code is required/);
});

test("the same measurement at the same time twice is a duplicate; at different times it is fine", () => {
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(11, "g/dL")), obs("hemoglobin", Qv(11.2, "g/dL"))), ctx)), /more than once/);
  ok(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(11, "g/dL")), obs("hemoglobin", Qv(11.2, "g/dL"), [{ name: "effectiveDateTime", valueDateTime: "2026-10-01" }])), ctx));
});

// ─── Biochemical: reference ranges and interpretation ─────────────────────
test("biochemical: interpretation is computed only from the lab's own range, in the same unit", () => {
  const range = (lo, hi, u = "g/dL") => [{ name: "referenceLow", valueQuantity: q(lo, u) }, { name: "referenceHigh", valueQuantity: q(hi, u) }];
  const code = (v, ...r) => obsBy(ok(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(v, "g/dL"), r.flat())), ctx)), "718-7").interpretation?.[0].coding[0].code;
  assert.equal(code(9, range(12, 15.5)), "L");
  assert.equal(code(13, range(12, 15.5)), "N");
  assert.equal(code(17, range(12, 15.5)), "H");
  assert.equal(code(9), undefined, "no range, no flag");
  const withRange = obsBy(ok(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(9, "g/dL"), range(12, 15.5))), ctx)), "718-7");
  assert.deepEqual(withRange.referenceRange[0].low.value, 12);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(9, "g/dL"), range(120, 155, "g/L"))), ctx)), /same unit as the value/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(9, "g/dL"), range(15, 12))), ctx)), /above referenceHigh/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("weight", Qv(60, "kg"), range(50, 70, "kg"))), ctx)), /apply only to biochemical/);
});

test("biochemical: a stated interpretation is validated, and a contradiction with the range is a warning", () => {
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(9, "g/dL"), [{ name: "interpretation", valueCode: "LOW" }])), ctx)), /interpretation must be one of/);
  const b = ok(evaluateNutritionAssessment(withRefs(obs("hemoglobin", Qv(13, "g/dL"), [
    { name: "interpretation", valueCode: "H" }, { name: "referenceLow", valueQuantity: q(12, "g/dL") }, { name: "referenceHigh", valueQuantity: q(15.5, "g/dL") },
  ])), ctx));
  assert.equal(obsBy(b, "718-7").interpretation[0].coding[0].code, "H", "kept as supplied");
  hasMsg(notes(b).map((i) => i.diagnostics), /disagrees with the value/);
});

// ─── Missing data ─────────────────────────────────────────────────────────
test("missing data: an explicit reason is recorded; a value plus a reason, or neither, is an error", () => {
  const b = ok(evaluateNutritionAssessment(withRefs(obs("albumin", undefined, [{ name: "dataAbsentReason", valueCode: "not-performed" }])), ctx));
  const a = obsBy(b, "1751-7");
  assert.equal(a.valueQuantity, undefined);
  assert.equal(a.dataAbsentReason.coding[0].code, "not-performed");
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("albumin", Qv(3.5, "g/dL"), [{ name: "dataAbsentReason", valueCode: "unknown" }])), ctx)), /not both/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("albumin", undefined, [{ name: "dataAbsentReason", valueCode: "later" }])), ctx)), /dataAbsentReason must be one of/);
});

test("missing data: areas with nothing supplied are named, and an empty request warns", () => {
  const b = ok(evaluateNutritionAssessment(withRefs(obs("weight", Qv(60, "kg"))), ctx));
  const msgs = notes(b).map((i) => i.diagnostics);
  for (const area of ["biochemical", "clinical", "dietary", "nfpe"]) hasMsg(msgs, new RegExp(`No ${area} data`));
  assert.ok(!msgs.some((m) => /No anthropometry data/.test(m)));
  const empty = ok(evaluateNutritionAssessment(withRefs(), ctx));
  hasMsg(notes(empty).map((i) => i.diagnostics), /No observations or questionnaire responses/);
});

// ─── Timestamps on observations ───────────────────────────────────────────
test("timestamps: invalid, future and pre-birth times are errors; a time of day needs a timezone", () => {
  const at = (v) => evaluateNutritionAssessment(withPE(obs("weight", Qv(60, "kg"), [{ name: "effectiveDateTime", valueDateTime: v }])), ctx);
  hasMsg(bad(at("2026-10-11T07:00:00")), /not a valid FHIR date or dateTime/);
  hasMsg(bad(at("2026-02-30")), /not a valid FHIR date/);
  hasMsg(bad(at("2027-01-01T00:00:00Z")), /in the future/);
  hasMsg(bad(at("1980-01-01")), /before the patient's birth date/);
  ok(at("2026-10-10"));
  ok(at("2026-10-11T09:00:00+02:00"));
  hasMsg(bad(evaluateNutritionAssessment(withPE({ name: "effectiveDateTime", valueDateTime: "yesterday" }), ctx)), /not a valid FHIR date/);
});

test("timestamps: results from before the encounter are allowed but flagged once", () => {
  const b = ok(evaluateNutritionAssessment(withPE(
    obs("hemoglobin", Qv(11, "g/dL"), [{ name: "effectiveDateTime", valueDateTime: "2026-10-01" }]),
    obs("weight", Qv(60, "kg"), [{ name: "effectiveDateTime", valueDateTime: "2026-10-11" }]),
  ), ctx));
  const w = notes(b).filter((i) => /outside the encounter period/.test(i.diagnostics));
  assert.equal(w.length, 1);
  assert.match(w[0].diagnostics, /1 observation\(s\).*hemoglobin/);
  assert.equal(obsBy(b, "718-7").effectiveDateTime, "2026-10-01");
});

test("timestamps: the default time is the encounter start, else now", () => {
  assert.equal(obsBy(ok(evaluateNutritionAssessment(withPE(obs("weight", Qv(60, "kg"))), ctx)), "29463-7").effectiveDateTime, "2026-10-11T07:30:00+02:00");
  assert.equal(obsBy(ok(evaluateNutritionAssessment(withRefs(obs("weight", Qv(60, "kg"))), ctx)), "29463-7").effectiveDateTime, ctx.now);
});

// ─── Clinical, dietary, NFPE, custom ──────────────────────────────────────
test("clinical, dietary and NFPE findings: codes, categories and NCP domains", () => {
  const b = ok(evaluateNutritionAssessment(withPE(
    obs("systolic-bp", Qv(118, "mmHg")), obs("heart-rate", Qv(72, "bpm")), obs("diarrhoea", { valueBoolean: true }),
    obs("energy-intake-kcal", Qv(1450, "kcal/day")), obs("meals-per-day", { valueInteger: 2 }), obs("appetite", { valueCode: "poor" }), obs("dietary-notes", { valueString: "Mostly nsima and beans" }),
    obs("temple-muscle", { valueCode: "moderate" }), obs("oedema", { valueInteger: 2 }), obs("pallor", { valueBoolean: false }),
  ), ctx));
  const dom = (o) => o.category.flatMap((c) => c.coding).find((c) => c.system.endsWith("/ncp-assessment-domain")).code;
  assert.equal(dom(obsBy(b, "8480-6")), "PD");
  assert.equal(obsBy(b, "8480-6").valueQuantity.code, "mm[Hg]");
  assert.equal(obsBy(b, "8480-6").category[0].coding[0].code, "vital-signs");
  assert.equal(obsBy(b, "8867-4").valueQuantity.code, "/min");
  assert.equal(dom(obsBy(b, "energy-intake-kcal")), "FH");
  assert.equal(obsBy(b, "energy-intake-kcal").valueQuantity.code, "kcal/d");
  assert.equal(obsBy(b, "meals-per-day").valueInteger, 2);
  assert.equal(obsBy(b, "appetite").valueCodeableConcept.coding[0].code, "poor");
  assert.equal(obsBy(b, "dietary-notes").valueString, "Mostly nsima and beans");
  assert.equal(dom(obsBy(b, "temple-muscle")), "PD");
  assert.equal(obsBy(b, "temple-muscle").valueCodeableConcept.coding[0].system, `${BASE}/fhir/CodeSystem/nfpe-severity`);
  assert.equal(obsBy(b, "oedema").valueInteger, 2);
  assert.equal(obsBy(b, "pallor").valueBoolean, false);
  assert.equal(obsBy(b, "diarrhoea").valueBoolean, true);
});

test("NFPE and dietary values are validated", () => {
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("temple-muscle", { valueCode: "bad" })), ctx)), /must be one of: normal, mild, moderate, severe/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("oedema", { valueInteger: 4 })), ctx)), /whole number from 0 to 3/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("pallor", { valueString: "yes" })), ctx)), /true \(present\) or false/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("meals-per-day", { valueDecimal: 2.5 })), ctx)), /whole number/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("energy-intake-kcal", Qv(1500, "kcal"))), ctx)), /recognised unit/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("energy-intake-kcal", Qv(90000, "kcal/d"))), ctx)), /outside the plausible range/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(obs("appetite", { valueCode: "ravenous" })), ctx)), /must be one of: good, fair, poor, none/);
});

test("a custom code needs system, display and domain, and its Quantity needs a unit", () => {
  const custom = (extra) => part("observation", [{ name: "code", valueCode: "44-9" }, ...extra]);
  const b = ok(evaluateNutritionAssessment(withRefs(custom([
    { name: "system", valueString: "http://snomed.info/sct" }, { name: "display", valueString: "Edema of foot" }, { name: "domain", valueCode: "clinical" }, { name: "value", valueBoolean: true },
  ])), ctx));
  const o = resources(b, "Observation")[0];
  assert.deepEqual(o.code.coding[0], { system: "http://snomed.info/sct", code: "44-9", display: "Edema of foot" });
  assert.equal(o.valueBoolean, true);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(custom([{ name: "system", valueString: "http://x" }, { name: "domain", valueCode: "clinical" }, { name: "value", valueBoolean: true }])), ctx)), /display is required/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(custom([{ name: "system", valueString: "http://x" }, { name: "display", valueString: "X" }, { name: "value", valueBoolean: true }])), ctx)), /domain is required for a custom code/);
  hasMsg(bad(evaluateNutritionAssessment(withRefs(custom([{ name: "system", valueString: "http://x" }, { name: "display", valueString: "X" }, { name: "domain", valueCode: "biochemical" }, { name: "value", valueQuantity: { value: 4 } }])), ctx)), /needs a unit/);
});

test("at most 100 observation parts", () => {
  const many = Array.from({ length: 101 }, () => obs("weight", Qv(60, "kg")));
  hasMsg(bad(evaluateNutritionAssessment(withRefs(...many), ctx)), /At most 100/);
});

// ─── Questionnaires ───────────────────────────────────────────────────────
const QR = (id, items, extra = {}) => ({ resourceType: "QuestionnaireResponse", questionnaire: `${BASE}/fhir/Questionnaire/${id}`, status: "completed", item: items, ...extra });
const ans = (linkId, a) => ({ linkId, answer: [a] });
const SCREEN_ITEMS = (o = {}) => [
  ans("weight", { valueQuantity: q(o.kg ?? 50, "kg") }), ans("height", { valueQuantity: q(o.cm ?? 170, "cm") }),
  ans("weightLossPercent3to6Months", { valueDecimal: o.loss ?? 12 }), ans("acuteDiseaseNoIntake", { valueBoolean: o.acute ?? false }),
];
const withQR = (qr, ...rest) => withPE(part("questionnaireResponse", []) && { name: "questionnaireResponse", resource: qr }, ...rest);

test("built-in forms are served and well formed", () => {
  assert.deepEqual(QUESTIONNAIRE_IDS, ["nutrition-screening", "nfpe", "diet-history"]);
  const bundle = questionnaireSearchBundle(BASE);
  assert.equal(bundle.total, 3);
  for (const id of QUESTIONNAIRE_IDS) {
    const f = questionnaireResource(BASE, id);
    assert.equal(f.url, `${BASE}/fhir/Questionnaire/${id}`);
    assert.equal(f.status, "active");
    const walk = (items) => items.forEach((it) => {
      assert.ok(it.linkId && it.type);
      if (it.type === "group") return walk(it.item);
      if (it.type === "quantity") assert.ok(it.extension.length >= 1, `${it.linkId} lists its units`);
      if (it.type === "choice") assert.ok(it.answerOption.length >= 2);
      if (ITEMS[it.linkId]) assert.ok(it.code?.[0]?.code, `${it.linkId} carries its observation code`);
    });
    walk(f.item);
  }
  assert.equal(questionnaireResource(BASE, "nope"), null);
});

test("screening form: answers become Observations and MUST is computed exactly as $screen computes it", () => {
  const b = ok(evaluateNutritionAssessment(withQR(QR("nutrition-screening", SCREEN_ITEMS({ kg: 50, cm: 170, loss: 12, acute: false }))), ctx));
  const must = obsBy(b, "must");
  const direct = evaluateScreen(P([
    { name: "weight", valueQuantity: q(50, "kg") }, { name: "height", valueQuantity: q(170, "cm") },
    { name: "weightLossPercent3to6Months", valueDecimal: 12 }, { name: "acuteDiseaseNoIntake", valueBoolean: false },
  ]), ctx).body.entry[0].resource;
  assert.equal(must.valueInteger, direct.valueInteger);
  assert.equal(must.valueInteger, 4, "BMI 17.3 scores 2, loss over 10% scores 2");
  const qrEntry = b.entry.find((e) => e.resource.resourceType === "QuestionnaireResponse");
  assert.ok(must.derivedFrom.some((d) => d.reference === qrEntry.fullUrl));
  assert.equal(must.subject.reference, b.entry.find((e) => e.resource.resourceType === "Patient").fullUrl);
  assert.equal(must.encounter.reference, b.entry.find((e) => e.resource.resourceType === "Encounter").fullUrl);
  assert.ok(obsBy(b, "29463-7").derivedFrom.some((d) => d.reference === qrEntry.fullUrl), "extracted weight points at the response");
  assert.equal(qrEntry.resource.subject.reference, must.subject.reference);
  assert.equal(qrEntry.resource.authored, "2026-10-11T07:30:00+02:00");
  assert.ok(obsBy(b, "39156-5"), "BMI from the form's weight and height");
});

test("screening form: no MUST for a child, an incomplete in-progress form is preliminary, a completed one must be complete", () => {
  let b = ok(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }, { name: "encounter", valueString: "Encounter/1" }, { name: "ageYears", valueInteger: 10 }, { name: "questionnaireResponse", resource: QR("nutrition-screening", SCREEN_ITEMS()) }]), ctx));
  assert.equal(obsBy(b, "must"), undefined);
  hasMsg(notes(b).map((i) => i.diagnostics), /for adults/);

  b = ok(evaluateNutritionAssessment(withQR(QR("nutrition-screening", [ans("weight", { valueQuantity: q(50, "kg") })], { status: "in-progress" })), ctx));
  assert.equal(obsBy(b, "29463-7").status, "preliminary");
  assert.equal(obsBy(b, "must"), undefined);
  hasMsg(notes(b).map((i) => i.diagnostics), /Required items not answered: height/);
  hasMsg(notes(b).map((i) => i.diagnostics), /MUST score not computed: missing height/);

  hasMsg(bad(evaluateNutritionAssessment(withQR(QR("nutrition-screening", [ans("weight", { valueQuantity: q(50, "kg") })])), ctx)), /Required items not answered: height.*status is completed/);

  b = ok(evaluateNutritionAssessment(withQR(QR("nutrition-screening", SCREEN_ITEMS(), { status: "in-progress" })), ctx));
  assert.equal(obsBy(b, "must").status, "preliminary");
});

test("NFPE form: nested groups are walked and findings become PD Observations", () => {
  const items = [
    { linkId: "muscle", item: [ans("temple-muscle", { valueCoding: { system: `${BASE}/fhir/CodeSystem/nfpe-severity`, code: "mild" } }), ans("calf-muscle", { valueCoding: { code: "severe" } })] },
    { linkId: "fluid", item: [ans("oedema", { valueInteger: 1 }), ans("ascites", { valueBoolean: false })] },
    { linkId: "micronutrient-signs", item: [ans("pallor", { valueBoolean: true })] },
  ];
  const b = ok(evaluateNutritionAssessment(withQR(QR("nfpe", items)), ctx));
  assert.equal(obsBy(b, "temple-muscle").valueCodeableConcept.coding[0].code, "mild");
  assert.equal(obsBy(b, "calf-muscle").valueCodeableConcept.coding[0].code, "severe");
  assert.equal(obsBy(b, "oedema").valueInteger, 1);
  assert.equal(obsBy(b, "pallor").valueBoolean, true);
  assert.equal(resources(b, "Observation").length, 5);
  const qrE = b.entry.find((e) => e.resource.resourceType === "QuestionnaireResponse");
  assert.deepEqual(qrE.resource.item, items, "the answers are carried exactly as given");
});

test("diet-history form: quantities, integers and choices are validated like direct observations", () => {
  const items = [ans("energy-intake-kcal", { valueQuantity: q(1800, "kcal/d") }), ans("meals-per-day", { valueInteger: 3 }), ans("appetite", { valueCoding: { code: "fair" } })];
  const b = ok(evaluateNutritionAssessment(withQR(QR("diet-history", items)), ctx));
  assert.equal(obsBy(b, "energy-intake-kcal").valueQuantity.value, 1800);
  assert.equal(obsBy(b, "appetite").valueCodeableConcept.coding[0].code, "fair");
  hasMsg(bad(evaluateNutritionAssessment(withQR(QR("diet-history", [ans("energy-intake-kcal", { valueQuantity: q(1800, "kcal") })])), ctx)), /recognised unit/);
  hasMsg(bad(evaluateNutritionAssessment(withQR(QR("diet-history", [ans("meals-per-day", { valueInteger: 40 })])), ctx)), /number from 0 to 20/);
  hasMsg(bad(evaluateNutritionAssessment(withQR(QR("diet-history", [ans("appetite", { valueCoding: { code: "huge" } })])), ctx)), /must be one of: good, fair, poor, none/);
});

test("QuestionnaireResponse structure: unknown linkId, wrong type, repeats, nesting, duplicates", () => {
  const run = (items, id = "diet-history") => bad(evaluateNutritionAssessment(withQR(QR(id, items)), ctx));
  hasMsg(run([ans("nonsense", { valueString: "x" })]), /not defined in Questionnaire diet-history/);
  hasMsg(run([ans("meals-per-day", { valueString: "3" })]), /integer item; got valueString/);
  hasMsg(run([{ linkId: "meals-per-day", answer: [{ valueInteger: 2 }, { valueInteger: 3 }] }]), /repeating answers are not supported/);
  hasMsg(run([{ linkId: "meals-per-day", answer: [{ valueInteger: 2, valueString: "2" }] }]), /exactly one value\[x\]/);
  hasMsg(run([{ linkId: "meals-per-day", answer: [{ valueInteger: 2 }], item: [] }]), /nested under an answer/);
  hasMsg(run([ans("meals-per-day", { valueInteger: 2 }), ans("meals-per-day", { valueInteger: 3 })]), /appears twice/);
  hasMsg(run([{ answer: [{ valueInteger: 2 }] }]), /needs a linkId/);
  hasMsg(run([{ linkId: "muscle", answer: [{ valueBoolean: true }] }], "nfpe"), /group and cannot have answers/);
  hasMsg(run([ans("temple-muscle", { valueCoding: { code: "mild" } })], "nfpe"), /not defined.*at this level/, "a leaf outside its group is not at this level");
  hasMsg(run([ans("weightLossPercent3to6Months", { valueDecimal: 140 }), ans("weight", { valueQuantity: q(60, "kg") }), ans("height", { valueQuantity: q(170, "cm") }), ans("acuteDiseaseNoIntake", { valueBoolean: false })], "nutrition-screening"), /must be a number from 0 to 100/);
});

test("QuestionnaireResponse metadata: status, authored, subject and encounter must agree", () => {
  const items = [ans("meals-per-day", { valueInteger: 2 })];
  const run = (extra) => bad(evaluateNutritionAssessment(withQR(QR("diet-history", items, extra)), ctx));
  hasMsg(run({ status: "entered-in-error" }), /entered-in-error/);
  hasMsg(run({ status: "done" }), /status is required/);
  hasMsg(run({ authored: "2026-10-11" }), /full dateTime with timezone/);
  hasMsg(run({ authored: "2027-01-01T00:00:00Z" }), /in the future/);
  hasMsg(run({ subject: { reference: "Patient/999" } }), /not the assessment patient/);
  hasMsg(run({ encounter: { reference: "Encounter/999" } }), /not the assessment encounter/);
  hasMsg(run({ questionnaire: undefined }), /questionnaire.*required/);
  // the same patient by logical id, or an in-progress response with no answers, is fine
  ok(evaluateNutritionAssessment(withQR(QR("diet-history", items, { subject: { reference: "Patient/p-1" } })), ctx));
  const warn = ok(evaluateNutritionAssessment(withQR(QR("diet-history", [], { status: "in-progress" })), ctx));
  assert.equal(resources(warn, "QuestionnaireResponse").length, 1);
});

test("a form that is not built in is checked structurally, carried, and not extracted", () => {
  const b = ok(evaluateNutritionAssessment(withQR({ resourceType: "QuestionnaireResponse", questionnaire: "http://example.org/Questionnaire/local-form", status: "completed", item: [ans("q1", { valueString: "hello" })] }), ctx));
  assert.equal(resources(b, "QuestionnaireResponse").length, 1);
  assert.equal(resources(b, "Observation").length, 0);
  hasMsg(notes(b).map((i) => i.diagnostics), /not one of this API's forms/);
  hasMsg(bad(evaluateNutritionAssessment(withQR({ resourceType: "QuestionnaireResponse", questionnaire: "http://example.org/Q/x", status: "completed", item: [{ linkId: "q1", answer: [{}] }] }), ctx)), /exactly one value\[x\]/);
});

test("an answer extracted from a form clashes with the same measurement given directly", () => {
  hasMsg(bad(evaluateNutritionAssessment(withQR(QR("diet-history", [ans("meals-per-day", { valueInteger: 2 })]), obs("meals-per-day", { valueInteger: 3 }, [{ name: "effectiveDateTime", valueDateTime: "2026-10-11T07:30:00+02:00" }])), ctx)), /more than once/);
});

test("$validate: reports every issue, builds nothing, returns 200", () => {
  const validate = (qr) => evaluateQuestionnaireResponseValidate(P([{ name: "resource", resource: qr }]), ctx);
  let r = validate(QR("nutrition-screening", SCREEN_ITEMS()));
  assert.equal(r.status, 200);
  assert.equal(r.body.resourceType, "OperationOutcome");
  assert.deepEqual(r.body.issue.map((i) => i.severity), ["information"]);
  r = validate(QR("nutrition-screening", [ans("weight", { valueQuantity: q(5000, "kg") }), ans("nonsense", { valueString: "x" })]));
  assert.equal(r.ok, true);
  const errs = r.body.issue.filter((i) => i.severity === "error").map((i) => i.diagnostics);
  hasMsg(errs, /outside the plausible range/);
  hasMsg(errs, /not defined in Questionnaire/);
  hasMsg(errs, /Required items not answered/);
  assert.equal(evaluateQuestionnaireResponseValidate(P([]), ctx).ok, false);
  assert.equal(evaluateQuestionnaireResponseValidate({ resourceType: "Bundle" }, ctx).ok, false);
});

test("operations are registered under the routes index.js dispatches", () => {
  assert.equal(assessmentOperationFor("Bundle", "$nutrition-assessment"), evaluateNutritionAssessment);
  assert.equal(assessmentOperationFor("QuestionnaireResponse", "$validate"), evaluateQuestionnaireResponseValidate);
  assert.equal(assessmentOperationFor("Observation", "$screen"), null);
});

// ─── Conformance: every URL and code emitted resolves ─────────────────────
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((x) => walk(x, visit));
  if (node && typeof node === "object") { visit(node); Object.values(node).forEach((x) => walk(x, visit)); }
}

test("every CodeSystem code and extension the assessment emits has a definition", () => {
  const samples = [
    ok(evaluateNutritionAssessment(withPE(
      obs("muac", Qv(24, "cm")), obs("waist", Qv(80, "cm")),
      obs("hemoglobin", Qv(11, "g/dL")), obs("systolic-bp", Qv(120, "mmHg")), obs("diarrhoea", { valueBoolean: true }),
      obs("appetite", { valueCode: "good" }), obs("temple-muscle", { valueCode: "mild" }), obs("oedema", { valueInteger: 1 }), obs("goitre", { valueBoolean: false }),
      { name: "questionnaireResponse", resource: QR("nutrition-screening", SCREEN_ITEMS()) },
    ), ctx)),
    ok(evaluateNutritionAssessment(P([{ name: "subject", valueString: "Patient/1" }, { name: "encounter", valueString: "Encounter/1" }, { name: "ageYears", valueInteger: 10 }, obs("weight", Qv(30, "kg")), obs("height", Qv(135, "cm"))]), ctx)),
    ...QUESTIONNAIRE_IDS.map((id) => questionnaireResource(BASE, id)),
  ];
  const csPrefix = `${BASE}/fhir/CodeSystem/`, sdPrefix = `${BASE}/fhir/StructureDefinition/`;
  const missing = new Set();
  let codes = 0;
  for (const s of samples) {
    walk(s, (o) => {
      const sys = o.system ?? o.valueCoding?.system;
      const code = o.code ?? o.valueCoding?.code;
      if (typeof sys === "string" && sys.startsWith(csPrefix) && typeof code === "string") {
        codes++;
        const def = codeSystemResource(BASE, sys.slice(csPrefix.length));
        if (!def) missing.add(`CodeSystem ${sys.slice(csPrefix.length)}`);
        else if (!def.concept.some((c) => c.code === code)) missing.add(`${code} in ${sys.slice(csPrefix.length)}`);
      }
      if (typeof o.url === "string" && o.url.startsWith(sdPrefix) && !structureDefinitionResource(BASE, o.url.slice(sdPrefix.length))) missing.add(o.url);
    });
  }
  assert.deepEqual([...missing], []);
  assert.ok(codes > 30, `sanity: ${codes} codes checked`);
});

test("assessment-item holds every registry item that has no LOINC code, and nothing that has one", () => {
  const cs = codeSystemResource(BASE, "assessment-item");
  const expected = Object.entries(ITEMS).filter(([, d]) => !d.loinc).map(([k]) => k).sort();
  assert.deepEqual(cs.concept.map((c) => c.code).sort(), expected);
  assert.equal(cs.count, expected.length);
  for (const [k, d] of Object.entries(ITEMS)) {
    if (d.loinc) assert.match(d.loinc, /^\d{1,5}-\d$/, k);
    assert.ok(d.display && d.area && d.cat && d.kind, k);
    if (d.kind === "quantity") assert.ok(d.min < d.max && Object.keys(d.units).length >= 1, k);
  }
});

test("CapabilityStatement and OperationDefinitions describe the new operations", () => {
  const cap = buildCapabilityStatement(BASE);
  const types = cap.rest[0].resource.map((r) => r.type);
  for (const t of ["Questionnaire", "QuestionnaireResponse", "Bundle"]) assert.ok(types.includes(t));
  const links = cap.rest[0].resource.flatMap((r) => (r.operation ?? []).map((o) => o.definition));
  for (const id of ["Bundle-nutrition-assessment", "QuestionnaireResponse-validate"]) {
    assert.ok(links.includes(`${BASE}/fhir/OperationDefinition/${id}`), id);
    assert.ok(OPERATION_DEFINITION_IDS.includes(id), id);
  }
  const names = (id) => operationDefinitionResource(BASE, id).parameter.filter((p) => p.use === "in").map((p) => p.name);
  for (const p of ["patient", "subject", "encounter", "effectiveDateTime", "author", "ageYears", "observation", "questionnaireResponse"]) assert.ok(names("Bundle-nutrition-assessment").includes(p), p);
  const obsPart = operationDefinitionResource(BASE, "Bundle-nutrition-assessment").parameter.find((p) => p.name === "observation");
  assert.deepEqual(obsPart.part.map((x) => x.name), ["code", "value", "domain", "effectiveDateTime", "referenceLow", "referenceHigh", "interpretation", "dataAbsentReason", "note", "system", "display"]);
  assert.equal(operationDefinitionResource(BASE, "QuestionnaireResponse-validate").parameter.at(-1).type, "OperationOutcome");
  assert.equal(operationDefinitionResource(BASE, "Bundle-nutrition-assessment").parameter.at(-1).type, "Bundle");
});
