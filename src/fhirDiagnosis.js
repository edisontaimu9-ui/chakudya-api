// FHIR R4 facade — Nutrition diagnosis (NCP step 2), structured.
//
//   POST /fhir/Condition/$diagnose
//
// Builds on the base operation in src/fhirNcp.js (NI/NC/NB terminology,
// domain, severity, PES validation) and adds what a structured record needs:
//
//   * the PES statement stored as COMPONENTS, not just text: a `pes-statement`
//     extension holds the problem (coded), each etiology and each sign/symptom
//     as its own CodeableConcept, and the human-readable statement;
//   * evidence as Observations: a sign/symptom can carry an inline measurement
//     (validated by the same registry as $nutrition-assessment: units, ranges,
//     timestamps) or point at an existing Observation; Condition.evidence links
//     each sign to its Observation;
//   * extra coding (e.g. ICD-10 or SNOMED CT alongside the NCP term) on the
//     problem, the etiologies and the signs;
//   * Condition.encounter / recorder / asserter, and a Provenance resource
//     (who authored the diagnosis, from which sources) when an author is given.
//
// STATELESS and pure, like the rest of the facade. Chakudya shapes and
// validates what the dietitian supplies; it never chooses the diagnosis. It
// cannot check that an ICD-10 or SNOMED code you add exists: the code is
// carried as given.
//
// Backward compatible: every input the base operation accepted still works,
// and the legacy `pes-etiology` / `pes-signs-symptoms` extensions and the
// statement in Condition.note are unchanged.

import { readParams, requireParameters, evaluateDiagnose } from "./fhirNcp.js";
import { buildObservationsFromParts, parseFhirTime } from "./fhirAssessment.js";

const PROV_PARTICIPANT = "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
const V3_DATA_OPERATION = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const PROV_ENTITY_ROLE = "http://terminology.hl7.org/CodeSystem/provenance-entity-role";

const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

const REF_ENCOUNTER = /^(https?:\/\/\S+\/)?Encounter\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const REF_OBSERVATION = /^(https?:\/\/\S+\/)?Observation\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const REF_ANY = /^(https?:\/\/\S+\/)?[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const SYSTEM_URI = /^(https?:\/\/|urn:)\S{1,200}$/;

const bad = (issues, status = 400) => ({
  ok: false, status,
  outcome: { resourceType: "OperationOutcome", issue: issues.map((diagnostics) => ({ severity: "error", code: "invalid", diagnostics })) },
});

const partyRef = (value) => {
  const s = str(value);
  if (!s) return null;
  return REF_ANY.test(s) ? { reference: s } : { display: s.slice(0, 200) };
};

const newUuid = (ctx) => `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;

/** A coding from `system` + `code` (+ `display`) parts; null when none given, error text when half given. */
function codingFrom(reader, label) {
  const system = str(reader.get("system")), code = str(reader.get("code")), display = str(reader.get("display"));
  if (!system && !code) return { coding: null };
  if (!system || !code) return { error: `${label}: a coding needs both 'system' and 'code'.` };
  if (!SYSTEM_URI.test(system)) return { error: `${label}: system "${system.slice(0, 80)}" must be a URI (http(s):// or urn:).` };
  if (code.length > 64) return { error: `${label}: code is longer than 64 characters.` };
  return { coding: { system, code, ...(display ? { display } : {}) } };
}

/** Short human text for an Observation built from an evidence measurement. */
function describeObservation(o) {
  const name = o.code?.text ?? o.code?.coding?.[0]?.display ?? o.code?.coding?.[0]?.code ?? "Observation";
  if (o.valueQuantity) return `${name}: ${o.valueQuantity.value} ${o.valueQuantity.unit ?? o.valueQuantity.code ?? ""}`.trim();
  if (o.valueInteger !== undefined) return `${name}: ${o.valueInteger}`;
  if (o.valueBoolean !== undefined) return `${name}: ${o.valueBoolean ? "present" : "absent"}`;
  if (o.valueCodeableConcept) return `${name}: ${o.valueCodeableConcept.coding?.[0]?.display ?? o.valueCodeableConcept.coding?.[0]?.code}`;
  if (o.valueString) return `${name}: ${o.valueString}`;
  return name;
}

const OWN_PARTS = ["etiologyItem", "signItem", "additionalCoding"];

export function evaluateDiagnoseStructured(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;
  const nowMs = Date.parse(ctx.now);

  const subject = str(p.get("subject"));
  const rawParams = Array.isArray(body.parameter) ? body.parameter : [];
  const rawDiagnoses = rawParams.filter((x) => x?.name === "diagnosis");
  // Anything the base operation would reject for these reasons keeps its own message.
  if (!subject || rawDiagnoses.length === 0 || rawDiagnoses.length > 20 || rawDiagnoses.some((x) => !Array.isArray(x.part))) {
    return evaluateDiagnose(body, ctx);
  }

  // Operation-level inputs.
  const errors = [];
  const encounterStr = str(p.get("encounter"));
  if (encounterStr && !REF_ENCOUNTER.test(encounterStr)) errors.push(`'encounter' must be an Encounter reference such as "Encounter/456" (got "${encounterStr.slice(0, 80)}").`);
  const author = p.get("author") !== undefined ? partyRef(p.get("author")) : null;
  const sources = p.all("source").map(str).filter(Boolean);
  if (sources.length && !author) errors.push("'source' needs an 'author': provenance records who recorded the diagnosis from which sources.");
  const asserter = p.get("asserter") !== undefined ? partyRef(p.get("asserter")) : null;
  const evidenceEffective = str(p.get("effectiveDateTime"));
  if (evidenceEffective && !parseFhirTime(evidenceEffective)) errors.push(`effectiveDateTime "${evidenceEffective}" is not a valid FHIR date or dateTime.`);

  // Per diagnosis: read the structured parts, build inline evidence, rewrite for the base operation.
  const rewritten = { ...body, parameter: [] };
  const plans = [];
  let diagIndex = -1;
  for (const raw of rawParams) {
    if (raw?.name !== "diagnosis") { rewritten.parameter.push(raw); continue; }
    diagIndex++;
    const label = `diagnosis[${diagIndex}]`;
    const d = readParams({ parameter: raw.part });
    const plan = { etiology: [], signs: [], extraCoding: [], obsEntries: [], evidenceRefs: [], plainSigns: 0, plainEtiology: 0 };

    const rd = str(d.get("recordedDate"));
    if (rd !== undefined) {
      const t = parseFhirTime(rd);
      if (!t) errors.push(`${label}.recordedDate "${rd}" is not a valid FHIR date or dateTime (a time of day needs a timezone).`);
      else if (t.ms > nowMs + (t.precision === "instant" ? 5 * 60000 : 86400000)) errors.push(`${label}.recordedDate ${rd} is in the future.`);
    }

    for (const t of d.all("etiology")) if (str(t)) plan.etiology.push({ text: str(t) });
    for (const t of d.all("signsSymptoms")) if (str(t)) plan.signs.push({ text: str(t) });
    for (const t of d.all("evidence")) if (str(t)) plan.evidenceRefs.push(str(t));
    plan.plainEtiology = plan.etiology.length;
    plan.plainSigns = plan.signs.length;

    for (const [j, it] of d.all("etiologyItem").entries()) {
      const l = `${label}.etiologyItem[${j}]`;
      if (typeof it?.get !== "function") { errors.push(`${l} must be a part with nested parts (text, ...).`); continue; }
      const text = str(it.get("text"));
      if (!text) { errors.push(`${l}.text is required.`); continue; }
      const c = codingFrom(it, l);
      if (c.error) { errors.push(c.error); continue; }
      plan.etiology.push({ text, ...(c.coding ? { coding: c.coding } : {}) });
    }

    const obsReaders = [];
    for (const [j, it] of d.all("signItem").entries()) {
      const l = `${label}.signItem[${j}]`;
      if (typeof it?.get !== "function") { errors.push(`${l} must be a part with nested parts (text, observation, evidence, ...).`); continue; }
      const c = codingFrom(it, l);
      if (c.error) { errors.push(c.error); continue; }
      const obs = it.all("observation");
      const refs = it.all("evidence").map(str).filter(Boolean);
      if (obs.length > 1) { errors.push(`${l} has more than one 'observation'; add another signItem for each measurement.`); continue; }
      const badRef = refs.find((r) => !REF_OBSERVATION.test(r));
      if (badRef) { errors.push(`${l}.evidence "${badRef.slice(0, 80)}" must be an Observation reference ("Observation/123" or a urn:uuid).`); continue; }
      const text = str(it.get("text"));
      if (!text && obs.length === 0) { errors.push(`${l} needs 'text' or an inline 'observation' (text is required when pointing at an existing Observation).`); continue; }
      plan.signs.push({ text, ...(c.coding ? { coding: c.coding } : {}), refs, obsIndex: obs.length ? obsReaders.length : -1 });
      if (obs.length) obsReaders.push({ reader: obs[0], path: `${l}.observation` });
    }

    if (obsReaders.length) {
      const built = buildObservationsFromParts(ctx, { patientRef: subject, encounterRef: encounterStr, performer: author, effective: evidenceEffective }, obsReaders);
      if (!built.ok) errors.push(...built.issues.filter((i) => i.severity === "error").map((i) => `${i.expression?.[0] ? i.expression[0] + ": " : ""}${i.diagnostics}`));
      else {
        plan.obsEntries = built.entries;
        for (const s of plan.signs) {
          if (s.obsIndex >= 0) {
            const en = built.entries[s.obsIndex];
            s.refs = [en.fullUrl, ...s.refs];
            s.text = s.text ?? describeObservation(en.resource);
          }
        }
      }
    }

    for (const [j, it] of d.all("additionalCoding").entries()) {
      const l = `${label}.additionalCoding[${j}]`;
      if (typeof it?.get !== "function") { errors.push(`${l} must be a part with nested parts (system, code, display).`); continue; }
      const c = codingFrom(it, l);
      if (c.error) errors.push(c.error);
      else if (!c.coding) errors.push(`${l} needs 'system' and 'code'.`);
      else plan.extraCoding.push(c.coding);
    }

    plans.push(plan);
    // What the base operation sees: the plain parts plus one string per structured item.
    rewritten.parameter.push({
      ...raw,
      part: [
        ...raw.part.filter((x) => !OWN_PARTS.includes(x?.name)),
        ...plan.etiology.slice(plan.plainEtiology).map((x) => ({ name: "etiology", valueString: x.text })),
        ...plan.signs.slice(plan.plainSigns).filter((x) => x.text).map((x) => ({ name: "signsSymptoms", valueString: x.text })),
      ],
    });
  }
  if (errors.length) return bad(errors);

  const r = evaluateDiagnose(rewritten, ctx);
  if (!r.ok) return r;

  // Enrich each Condition and add its evidence Observations and Provenance.
  const conditionEntries = r.body.entry;
  const extra = [];
  conditionEntries.forEach((entry, i) => {
    const cond = entry.resource;
    const plan = plans[i];
    const statement = cond.note?.[0]?.text ?? "";

    if (encounterStr) cond.encounter = { reference: encounterStr };
    if (author) cond.recorder = author;
    if (asserter) cond.asserter = asserter;
    if (plan.extraCoding.length) cond.code = { ...cond.code, coding: [...(cond.code.coding ?? []), ...plan.extraCoding] };

    // evidence: sign k of the base output is plan.signs[k] (plain signs first, then items, in order)
    plan.signs.forEach((s, k) => {
      const ev = cond.evidence?.[k];
      if (!ev) return;
      if (s.coding) ev.code = [{ ...ev.code[0], coding: [s.coding] }];
      if (s.refs?.length) ev.detail = s.refs.map((reference) => ({ reference }));
    });

    const concept = (x) => ({ text: x.text, ...(x.coding ? { coding: [x.coding] } : {}) });
    cond.extension = [
      ...(cond.extension ?? []),
      {
        url: `${base}/fhir/StructureDefinition/pes-statement`,
        extension: [
          { url: "statement", valueString: statement },
          { url: "problem", valueCodeableConcept: cond.code },
          ...plan.etiology.map((x) => ({ url: "etiology", valueCodeableConcept: concept(x) })),
          ...plan.signs.map((x) => ({
            url: "signSymptom",
            extension: [
              { url: "description", valueCodeableConcept: concept(x) },
              ...(x.refs ?? []).map((reference) => ({ url: "evidence", valueReference: { reference } })),
            ],
          })),
        ],
      },
    ];

    extra.push(...plan.obsEntries);

    if (author) {
      const referenced = [...plan.evidenceRefs, ...plan.signs.flatMap((s) => (s.refs ?? []).filter((x) => !plan.obsEntries.some((o) => o.fullUrl === x)))];
      extra.push({
        fullUrl: newUuid(ctx),
        resource: {
          resourceType: "Provenance",
          target: [{ reference: entry.fullUrl }, ...plan.obsEntries.map((o) => ({ reference: o.fullUrl }))],
          recorded: ctx.now,
          activity: { coding: [{ system: V3_DATA_OPERATION, code: "CREATE", display: "create" }] },
          agent: [{ type: { coding: [{ system: PROV_PARTICIPANT, code: "author", display: "Author" }] }, who: author }],
        },
      });
      // FHIR JSON has no empty arrays: entity is only present when there is a source.
      const entity = [
        ...[...new Set(referenced)].map((reference) => ({ role: "source", what: { reference } })),
        ...sources.map((display) => ({ role: "source", what: { display } })),
      ];
      if (entity.length) extra[extra.length - 1].resource.entity = entity;
    }
  });

  return { ok: true, status: 200, body: { ...r.body, entry: [...conditionEntries, ...extra] } };
}

export const DIAGNOSIS_OPERATIONS = { "Condition/$diagnose": evaluateDiagnoseStructured };
export const diagnosisOperationFor = (param, action) => DIAGNOSIS_OPERATIONS[`${param}/${action}`] ?? null;

// Re-exported so the roles used in Provenance are in one place for tests.
export const PROVENANCE_SYSTEMS = { PROV_PARTICIPANT, V3_DATA_OPERATION, PROV_ENTITY_ROLE };
