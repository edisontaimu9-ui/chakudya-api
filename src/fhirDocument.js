// FHIR R4 facade: the complete ADIME clinical note (NCP step 5, documentation).
//
//   POST /fhir/Bundle/$ncp-document      build the ADIME document Bundle
//   POST /fhir/Bundle/$validate-document check a document Bundle (ours or anyone's)
//
// Builds on the existing $ncp-document assembly (src/fhirNcp.js): the same
// Composition with Assessment, Diagnosis, Intervention and Monitoring/
// Evaluation sections (plus Screening when present). This module adds what a
// document that is exchanged with an EHR needs:
//
//   * identity: Bundle.identifier and Composition.identifier (a new urn:uuid),
//     Composition.status (`final` by default; `preliminary` or `amended`
//     on request) and a Composition narrative;
//   * validation, run on every document before it is returned:
//       - structure: type "document", Composition first, required Composition
//         fields, the four ADIME sections each with entries or an emptyReason,
//         narrative on every section that has entries, unique fullUrls;
//       - references: every urn:uuid or Type/id reference that points inside
//         the Bundle must resolve to an entry (a broken link in a clinical
//         field is an error; in an extension or Provenance it is a warning);
//       - consistency: one patient throughout; each resource sits in the
//         section its NCP step says; diagnoses, care plan, goals and follow-up
//         results are linked to each other (warnings, never invented);
//       - every entry is reachable from the Composition (orphans are warned);
//   * errors stop the document (422 with every problem listed); warnings are
//     reported by $validate-document, where an OperationOutcome is returned.
//
// STATELESS and pure, like the rest of the facade. Chakudya assembles and
// checks what the dietitian's earlier operations produced; it does not write
// clinical content and it does not sign the note.

import { readParams, requireParameters, evaluateNcpDocument } from "./fhirNcp.js";

const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const newUuid = (ctx) => `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;

const STATUSES = new Set(["preliminary", "final", "amended"]);
const URI_SYSTEM = "urn:ietf:rfc:3986";
const REQUIRED_SECTIONS = ["nutrition-assessment", "nutrition-diagnosis", "nutrition-intervention", "nutrition-monitoring"];
const SECTION_FOR = {
  Condition: "nutrition-diagnosis",
  NutritionOrder: "nutrition-intervention",
  ServiceRequest: "nutrition-intervention",
  CarePlan: "nutrition-intervention",
  Task: "nutrition-intervention",
};

const fail = (issues, status = 400) => ({
  ok: false,
  status,
  outcome: { resourceType: "OperationOutcome", issue: issues.map((diagnostics) => ({ severity: "error", code: "invalid", diagnostics })) },
});

// ─── Validation ────────────────────────────────────────────────────────────

const isDate = (s) => typeof s === "string" && /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/.test(s) && !isNaN(Date.parse(s));
const sectionCode = (s) => (s?.code?.coding ?? []).find((c) => c.system?.endsWith("/CodeSystem/ncp-step"))?.code;
const keyOf = (e) => e.fullUrl ?? (e.resource?.id ? `${e.resource.resourceType}/${e.resource.id}` : undefined);

/** Every { reference } in a resource with the path it was found at. */
function referencesIn(node, path = "", out = []) {
  if (Array.isArray(node)) node.forEach((n, i) => referencesIn(n, `${path}[${i}]`, out));
  else if (isObj(node)) {
    if (typeof node.reference === "string") out.push({ ref: node.reference, path: `${path}.reference` });
    for (const [k, v] of Object.entries(node)) if (k !== "reference" && k !== "text") referencesIn(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/**
 * Checks a document Bundle. Returns { errors, warnings, entries } where each
 * message is a string. Pure; never throws on odd input.
 */
export function checkAdimeDocument(bundle) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!isObj(bundle) || bundle.resourceType !== "Bundle") {
    return { errors: ["The document must be a FHIR Bundle."], warnings, entries: 0 };
  }
  if (bundle.type !== "document") err(`Bundle.type must be "document", not "${bundle.type}".`);
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  if (entries.length === 0) return { errors: [...errors, "The Bundle has no entries."], warnings, entries: 0 };
  if (!bundle.identifier?.value) warn("Bundle.identifier is missing; a document Bundle should carry a persistent identifier.");
  if (!isDate(bundle.timestamp)) warn("Bundle.timestamp is missing or not a valid dateTime.");

  // Entries: resource present, fullUrl present and unique.
  const byKey = new Map();
  entries.forEach((e, i) => {
    if (!isObj(e?.resource) || typeof e.resource.resourceType !== "string") { err(`entry[${i}] has no resource.`); return; }
    const k = keyOf(e);
    if (!e.fullUrl) warn(`entry[${i}] (${e.resource.resourceType}) has no fullUrl; other resources cannot link to it.`);
    if (k) {
      if (byKey.has(k)) err(`Duplicate entry "${k}".`);
      byKey.set(k, e);
      if (e.resource.id) byKey.set(`${e.resource.resourceType}/${e.resource.id}`, e);
    }
  });

  // Composition: first entry, required fields.
  const first = entries[0];
  const comp = first?.resource;
  if (comp?.resourceType !== "Composition") {
    err("The first entry must be the Composition.");
    return { errors, warnings, entries: entries.length };
  }
  if (entries.slice(1).some((e) => e?.resource?.resourceType === "Composition")) err("A document has exactly one Composition.");
  if (!STATUSES.has(comp.status)) err(`Composition.status must be one of ${[...STATUSES].join(", ")}.`);
  if (!comp.type?.coding?.length) err("Composition.type is required.");
  if (!str(comp.title)) err("Composition.title is required.");
  if (!isDate(comp.date)) err("Composition.date is required and must be a valid dateTime.");
  if (!comp.subject?.reference) err("Composition.subject (the patient) is required.");
  if (!Array.isArray(comp.author) || comp.author.length === 0 || !comp.author.every((a) => a?.reference || a?.display)) err("Composition.author is required.");
  if (!comp.identifier?.value) warn("Composition.identifier is missing.");
  const subjectRef = comp.subject?.reference;

  // Sections: the four ADIME sections.
  const sections = Array.isArray(comp.section) ? comp.section : [];
  if (sections.length === 0) err("Composition.section is empty.");
  const present = new Map();
  for (const s of sections) {
    const code = sectionCode(s);
    if (!code) { err(`Section "${s?.title ?? "?"}" has no ncp-step code.`); continue; }
    if (present.has(code)) err(`Section "${code}" appears more than once.`);
    present.set(code, s);
    const refs = Array.isArray(s.entry) ? s.entry : [];
    if (refs.length === 0 && !s.emptyReason) err(`Section "${s.title ?? code}" has neither entries nor an emptyReason.`);
    if (refs.length > 0 && s.emptyReason) err(`Section "${s.title ?? code}" has entries and an emptyReason.`);
    if (refs.length > 0 && !s.text?.div) err(`Section "${s.title ?? code}" has entries but no narrative (section.text).`);
    if (s.text && !/^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/.test(s.text.div ?? "")) err(`Section "${s.title ?? code}" narrative is not an XHTML div.`);
  }
  for (const code of REQUIRED_SECTIONS) if (!present.has(code)) err(`The ADIME section "${code}" is missing.`);

  // Section entries resolve and sit in the right section.
  const inSection = new Map(); // entry key -> section code
  for (const [code, s] of present) {
    for (const r of s.entry ?? []) {
      const target = byKey.get(r?.reference);
      if (!target) { err(`Section "${code}" refers to "${r?.reference}", which is not an entry of the Bundle.`); continue; }
      inSection.set(keyOf(target), code);
      const t = target.resource;
      const expected = SECTION_FOR[t.resourceType]
        ?? (t.resourceType === "Goal" ? (t.achievementStatus ? "nutrition-monitoring" : "nutrition-intervention") : null);
      if (expected && code !== expected) err(`${t.resourceType} "${r.reference}" is in section "${code}" but belongs in "${expected}".`);
      if (["Patient", "Encounter", "Composition"].includes(t.resourceType)) err(`${t.resourceType} "${r.reference}" is context, not section content.`);
    }
  }

  // References: everything pointing inside the Bundle must resolve.
  const resolves = (ref) => byKey.has(ref) || byKey.has(ref.replace(/^https?:\/\/[^/]+\/(?:fhir\/)?/, ""));
  const internal = (ref) => ref.startsWith("urn:uuid:") || byKey.has(ref);
  for (const e of entries) {
    const r = e?.resource;
    if (!isObj(r)) continue;
    for (const { ref, path } of referencesIn(r)) {
      if (!ref.startsWith("urn:uuid:")) continue; // relative/absolute references are the EHR's own
      if (resolves(ref)) continue;
      const soft = /extension|entity/.test(path);
      (soft ? warn : err)(`${r.resourceType} ${path} refers to ${ref}, which is not in the document${soft ? " (supporting detail; include the Bundle that holds it)" : ""}.`);
    }
  }

  // One patient throughout.
  for (const e of entries.slice(1)) {
    const r = e?.resource;
    if (!isObj(r) || ["Patient", "Encounter", "QuestionnaireResponse", "Provenance"].includes(r.resourceType)) continue;
    const s = r.subject?.reference ?? r.patient?.reference ?? r.for?.reference;
    if (s && subjectRef && s !== subjectRef) err(`${r.resourceType} ${keyOf(e)} is for "${s}", not the document subject "${subjectRef}".`);
  }
  const patientEntry = entries.find((e) => e?.resource?.resourceType === "Patient");
  if (patientEntry && subjectRef && keyOf(patientEntry) !== subjectRef && `Patient/${patientEntry.resource.id}` !== subjectRef) {
    err(`The Patient entry is not the Composition subject "${subjectRef}".`);
  }
  if (comp.encounter?.reference && !resolves(comp.encounter.reference) && comp.encounter.reference.startsWith("urn:uuid:")) {
    err(`Composition.encounter refers to ${comp.encounter.reference}, which is not in the document.`);
  }

  // ADIME links: diagnosis <- plan -> goals -> follow-up. Warnings only.
  const all = entries.map((e) => ({ key: keyOf(e), r: e.resource })).filter((x) => isObj(x.r));
  const plans = all.filter((x) => x.r.resourceType === "CarePlan");
  const conditions = all.filter((x) => x.r.resourceType === "Condition");
  const goals = all.filter((x) => x.r.resourceType === "Goal");
  const planGoalRefs = new Set(plans.flatMap((p) => (p.r.goal ?? []).map((g) => g.reference)));
  const planAddresses = new Set(plans.flatMap((p) => (p.r.addresses ?? []).map((g) => g.reference)));
  if (plans.length > 0 && conditions.length === 0) warn("The document has a care plan but no nutrition diagnosis (PES statement).");
  if (conditions.length > 0 && plans.length === 0 && !present.get("nutrition-intervention")?.entry?.length) warn("A diagnosis is documented but no intervention is.");
  for (const c of conditions) if (plans.length > 0 && !planAddresses.has(c.key)) warn(`Diagnosis ${c.key} is not addressed by any care plan in the document.`);
  for (const g of goals) {
    const evaluated = Boolean(g.r.achievementStatus);
    if (plans.length > 0 && !planGoalRefs.has(g.key) && !evaluated) warn(`Goal ${g.key} is not listed in any care plan's goals.`);
    if (!g.r.target?.length && !evaluated) warn(`Goal ${g.key} has no target.`);
  }
  const monitoring = present.get("nutrition-monitoring");
  if (monitoring?.entry?.length && goals.length === 0) warn("Monitoring results are present but the document has no goals to evaluate them against.");
  if (monitoring?.entry?.length && plans.length === 0) warn("Monitoring results are present but the document has no care plan.");
  const assessment = present.get("nutrition-assessment");
  if (!assessment?.entry?.length) warn("No assessment findings are in the document.");

  // Reachability: every entry hangs off the Composition.
  const reached = new Set([keyOf(first)]);
  const queue = [first.resource];
  while (queue.length) {
    const r = queue.pop();
    for (const { ref } of referencesIn(r)) {
      const t = byKey.get(ref);
      if (t && !reached.has(keyOf(t))) { reached.add(keyOf(t)); queue.push(t.resource); }
    }
    if (r.resourceType === "Composition") continue;
  }
  // Provenance points at what it covers, not the other way round: a Provenance
  // is reachable when one of its targets is.
  for (const e of entries) {
    if (e?.resource?.resourceType !== "Provenance") continue;
    if ((e.resource.target ?? []).some((t) => reached.has(t.reference))) { reached.add(keyOf(e)); queue.push(e.resource); }
  }
  // Context entries (Patient, Encounter, QuestionnaireResponse) are carried whole.
  for (const e of entries.slice(1)) {
    const k = keyOf(e);
    if (k && !reached.has(k) && !["Patient", "Encounter", "QuestionnaireResponse", "Provenance"].includes(e.resource?.resourceType)) {
      warn(`${e.resource.resourceType} ${k} is in the Bundle but nothing in the Composition links to it.`);
    }
  }

  return { errors, warnings, entries: entries.length };
}

const outcomeOf = (result) => ({
  resourceType: "OperationOutcome",
  issue: [
    ...result.errors.map((diagnostics) => ({ severity: "error", code: "invalid", diagnostics })),
    ...result.warnings.map((diagnostics) => ({ severity: "warning", code: "informational", diagnostics })),
    ...(result.errors.length === 0
      ? [{ severity: "information", code: "informational", diagnostics: `Document structure and references are valid (${result.entries} entries${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ""}).` }]
      : []),
  ],
});

// ─── Bundle/$ncp-document (complete ADIME note) ────────────────────────────

const xhtmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function evaluateAdimeDocument(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);

  const status = str(p.get("status")) ?? "final";
  if (!STATUSES.has(status)) return fail([`Parameter 'status' must be one of ${[...STATUSES].join(", ")}.`]);

  // Assembly (sections, subject/encounter defaults, patient consistency) is
  // the existing operation; this layer adds identity and validation.
  const base = evaluateNcpDocument(body, ctx);
  if (!base.ok) return base;
  const bundle = base.body;
  const comp = bundle.entry[0].resource;

  const docId = newUuid(ctx);
  bundle.identifier = { system: URI_SYSTEM, value: docId };
  comp.identifier = { system: URI_SYSTEM, value: docId };
  comp.status = status;

  const lines = bundle.entry.slice(1).length;
  const subject = comp.subject.display ?? comp.subject.reference;
  const authorText = comp.author.map((a) => a.display ?? a.reference).join(", ");
  comp.text = {
    status: "generated",
    div:
      `<div xmlns="http://www.w3.org/1999/xhtml"><p><b>${xhtmlEsc(comp.title)}</b></p>` +
      `<p>Patient: ${xhtmlEsc(subject)}. Author: ${xhtmlEsc(authorText)}. Date: ${xhtmlEsc(comp.date)}. Status: ${status}.</p>` +
      `<p>Sections: ${comp.section.map((s) => xhtmlEsc(s.title)).join("; ")}. ${lines} supporting entries.</p></div>`,
  };

  const result = checkAdimeDocument(bundle);
  if (result.errors.length) return fail(result.errors, 422);
  return { ok: true, status: 200, body: bundle };
}

// ─── Bundle/$validate-document ─────────────────────────────────────────────

export function evaluateValidateDocument(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const docs = p.all("resource").filter((r) => isObj(r));
  if (docs.length !== 1) return fail(["Supply exactly one 'resource' parameter: the document Bundle to check."]);
  return { ok: true, status: 200, body: outcomeOf(checkAdimeDocument(docs[0])) };
}

export const DOCUMENT_OPERATIONS = {
  "Bundle/$ncp-document": evaluateAdimeDocument,
  "Bundle/$validate-document": evaluateValidateDocument,
};
export const documentOperationFor = (param, action) => DOCUMENT_OPERATIONS[`${param}/${action}`] ?? null;
