import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScopes, scopesForRole, scopeAllows, classifyFhirRoute, decideAccess, operationOutcomeFor, legacyErrorMessage,
  buildAuditEvent, truncateIp, auditRow, auditSearchBundle, PROFILE_NAMES, profileResource, checkProfiles, conceptMapResource,
  CONCEPT_MAP_NAMES, evaluateTranslate, evaluateValidate, checkR4, r4Outcome, R4_TYPE_NAMES,
} from "../src/fhirGovernance.js";
import { evaluateNutritionAssessment, ITEMS } from "../src/fhirAssessment.js";
import { evaluateDiagnoseStructured } from "../src/fhirDiagnosis.js";
import { evaluateInterveneStructured } from "../src/fhirIntervention.js";
import { evaluateMonitor } from "../src/fhirMonitoring.js";
import { evaluateCareContext } from "../src/fhirContext.js";
import { evaluateAdimeDocument, evaluateValidateDocument } from "../src/fhirDocument.js";
import { buildCapabilityStatement } from "../src/fhir.js";
import { operationDefinitionResource } from "../src/fhirTerminology.js";
import worker from "../src/index.js";

const BASE = "https://x.test";
let n = 0;
const ctx = { base: BASE, now: "2026-10-11T08:00:00.000Z", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
const P = (parameter) => ({ resourceType: "Parameters", parameter });
const part = (name, parts) => ({ name, part: parts });
const S = (name, v) => ({ name, valueString: v });
const R = (b) => ({ name: "resource", resource: b });
const Q = (name, v, u) => ({ name, valueQuantity: { value: v, unit: u, system: "http://unitsofmeasure.org", code: u } });
const obs = (code, v, u) => part("observation", [S("code", code), Q("value", v, u)]);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.outcome)); return r.body; };

function flow() {
  const assessment = ok(evaluateNutritionAssessment(P([S("subject", "Patient/1"), S("encounter", "Encounter/1"), S("effectiveDateTime", "2026-09-01T08:00:00Z"), { name: "ageYears", valueInteger: 30 }, obs("weight", 48, "kg"), obs("height", 160, "cm")]), ctx));
  const diagnosis = ok(evaluateDiagnoseStructured(P([S("subject", "Patient/1"), S("author", "Grace Banda"), part("diagnosis", [S("problem", "Inadequate energy intake"), S("domain", "intake"), S("etiology", "poor appetite"), S("signsSymptoms", "intake 55% of requirement")])]), ctx));
  const plan = ok(evaluateInterveneStructured(P([R(diagnosis), S("author", "Grace Banda"), S("title", "Weight restoration"), part("goal", [S("description", "Reach 52 kg"), S("measure", "Body weight"), S("measureCode", "weight"), S("direction", "increase"), Q("baseline", 48, "kg"), Q("target", 52, "kg"), S("dueDate", "2026-12-20")])]), ctx));
  const followUp = ok(evaluateMonitor(P([R(plan), { name: "baseline", resource: assessment }, S("encounter", "Encounter/2"), S("effectiveDateTime", "2026-10-10T09:00:00Z"), obs("weight", 49, "kg")]), ctx));
  const context = ok(evaluateCareContext(P([
    S("subject", "Patient/1"),
    part("organization", [S("id", "h"), S("name", "Zomba Central Hospital")]),
    part("practitioner", [S("id", "r"), S("name", "Grace Banda"), part("qualification", [S("code", "Registered Dietitian")])]),
    part("practitioner", [S("id", "d"), S("name", "James Phiri")]),
    part("role", [S("id", "r1"), S("practitioner", "r"), S("organization", "h"), S("role", "dietitian")]),
    part("role", [S("id", "d1"), S("practitioner", "d"), S("organization", "h"), S("role", "physician")]),
    part("careTeam", [part("member", [S("role", "r1")]), part("member", [S("role", "d1")])]),
  ]), ctx));
  return { assessment, diagnosis, plan, followUp, context };
}
const docOf = (extra = []) => { const f = flow(); return ok(evaluateAdimeDocument(P([S("subject", "Patient/1"), S("author", "Grace Banda"), ...extra, ...Object.values(f).map(R)]), ctx)); };

// ─── scopes and access decisions ──────────────────────────────────────────

test("scopes parse strictly and derive from the role", () => {
  assert.deepEqual(parseScopes("system/Condition.write system/*.read"), [{ type: "Condition", level: "write" }, { type: "*", level: "read" }]);
  for (const bad of ["Condition.write", "system/condition.write", "system/Condition.delete", "user/Condition.read", "system/*.read; drop"]) assert.equal(parseScopes(bad), null, bad);
  assert.deepEqual(parseScopes(null), []);
  assert.deepEqual(scopesForRole("admin"), [{ type: "*", level: "*" }]);
  assert.deepEqual(scopesForRole("reviewer"), [{ type: "*", level: "read" }]);
  assert.deepEqual(scopesForRole("weird"), []);
  assert.equal(scopeAllows([{ type: "*", level: "*" }], "Condition", "write"), true);
  assert.equal(scopeAllows([{ type: "*", level: "*" }], "AuditEvent", "read"), false, "a wildcard never covers AuditEvent");
  assert.equal(scopeAllows([{ type: "Condition", level: "read" }], "Condition", "write"), false);
});

test("routes are classified: conformance public, validation read, clinical operations write", () => {
  assert.equal(classifyFhirRoute("GET", "metadata").kind, "public");
  assert.equal(classifyFhirRoute("GET", "StructureDefinition", "x").kind, "public");
  assert.equal(classifyFhirRoute("GET", "ConceptMap", "x").kind, "public");
  assert.equal(classifyFhirRoute("POST", "ConceptMap", "$translate").kind, "public");
  assert.equal(classifyFhirRoute("GET", "AuditEvent").kind, "audit");
  assert.equal(classifyFhirRoute("POST", "Bundle", "$validate-document").kind, "read");
  assert.equal(classifyFhirRoute("POST", "$validate").kind, "read");
  assert.deepEqual(classifyFhirRoute("POST", "Condition", "$diagnose"), { kind: "write", type: "Condition" });
});

test("access: open mode keeps operations public; enforce needs a credential and the scope", () => {
  const d = (o) => decideAccess({ method: "POST", param: "Condition", action: "$diagnose", ...o });
  assert.equal(d({ mode: "open", identity: null }).allow, true);
  assert.equal(d({ mode: undefined, identity: null }).allow, true);
  const none = d({ mode: "enforce", identity: null });
  assert.deepEqual([none.allow, none.status, none.code], [false, 401, "login"]);
  assert.equal(d({ mode: "enforce", identity: { valid: false } }).status, 401);
  assert.equal(d({ mode: "enforce", identity: { valid: true, isRoot: true } }).allow, true);
  assert.equal(d({ mode: "enforce", identity: { valid: true, role: "admin", fhirScopes: [] } }).allow, true);
  const reviewer = d({ mode: "enforce", identity: { valid: true, role: "reviewer", fhirScopes: [] } });
  assert.deepEqual([reviewer.allow, reviewer.status, reviewer.code], [false, 403, "forbidden"]);
  const scoped = { valid: true, role: "reviewer", fhirScopes: parseScopes("system/Condition.write") };
  assert.equal(d({ mode: "enforce", identity: scoped }).allow, true);
  assert.equal(decideAccess({ mode: "enforce", method: "POST", param: "CarePlan", action: "$intervene", identity: scoped }).allow, false);
  const rev = { valid: true, role: "reviewer", fhirScopes: [] };
  assert.equal(decideAccess({ mode: "enforce", method: "POST", param: "Bundle", action: "$validate-document", identity: rev }).allow, true);
  for (const [m, p, a] of [["GET", "metadata"], ["GET", "CodeSystem", "x"], ["POST", "ConceptMap", "$translate"], ["GET", "Questionnaire"]]) {
    assert.equal(decideAccess({ mode: "enforce", method: m, param: p, action: a, identity: null }).allow, true, `${m} ${p}`);
  }
});

test("AuditEvent reads need admin or an explicit AuditEvent scope, in every mode", () => {
  const g = (identity, mode) => decideAccess({ mode, method: "GET", param: "AuditEvent", identity });
  assert.equal(g(null, "open").status, 401);
  assert.equal(g({ valid: true, role: "reviewer", fhirScopes: [] }, "open").status, 403);
  assert.equal(g({ valid: true, role: "reviewer", fhirScopes: parseScopes("system/*.read") }, "open").status, 403);
  assert.equal(g({ valid: true, role: "reviewer", fhirScopes: parseScopes("system/AuditEvent.read") }, "open").allow, true);
  assert.equal(g({ valid: true, role: "admin", fhirScopes: [] }, "open").allow, true);
  assert.equal(g({ valid: true, isRoot: true }, "enforce").allow, true);
});

// ─── errors ───────────────────────────────────────────────────────────────

test("errors become OperationOutcomes with the right issue code", () => {
  for (const [s, c] of [[400, "invalid"], [401, "login"], [403, "forbidden"], [404, "not-found"], [405, "not-supported"], [422, "processing"], [429, "throttled"], [500, "exception"]]) {
    const o = operationOutcomeFor(s, "msg");
    assert.equal(o.issue[0].code, c, String(s));
    assert.equal(checkR4(o).errors.length, 0);
  }
  assert.equal(legacyErrorMessage({ status: "error", message: "boom" }), "boom");
  assert.equal(legacyErrorMessage({ resourceType: "OperationOutcome" }), null);
  assert.equal(legacyErrorMessage({ status: "success" }), null);
});

// ─── AuditEvent ───────────────────────────────────────────────────────────

test("an AuditEvent describes the request and is R4-valid; no body, no full IP, patient only when given", () => {
  const ev = buildAuditEvent({ base: BASE, requestId: "11111111-2222-4333-8444-555555555555", now: ctx.now, method: "POST", path: "/fhir/Condition/$diagnose", status: 200, actor: { label: "ehr-integration" }, ip: "203.0.113.77" });
  assert.equal(ev.action, "E");
  assert.equal(ev.outcome, "0");
  assert.equal(ev.agent[0].name, "ehr-integration");
  assert.equal(ev.agent[0].requestor, true);
  assert.equal(ev.agent[0].network.address, "203.0.113.0");
  assert.equal(ev.entity.length, 1);
  assert.equal(JSON.stringify(ev).includes("203.0.113.77"), false);
  assert.deepEqual(checkR4(ev, { base: BASE }).errors, []);
  const withP = buildAuditEvent({ base: BASE, requestId: "r1", now: ctx.now, method: "POST", path: "/fhir/Condition/$diagnose", status: 422, actor: null, ip: "2001:db8:abcd:12::1", patient: "Patient/123", denied: "x" });
  assert.equal(withP.outcome, "4");
  assert.equal(withP.agent[0].name, "anonymous");
  assert.equal(withP.entity[1].what.reference, "Patient/123");
  assert.equal(withP.agent[0].network.address, "2001:db8:abcd::");
  assert.equal(buildAuditEvent({ base: BASE, requestId: "r2", now: ctx.now, method: "GET", path: "/fhir/AuditEvent", status: 503, actor: null }).outcome, "8");
  assert.equal(buildAuditEvent({ base: BASE, requestId: "r3", now: ctx.now, method: "POST", path: "/fhir/Condition/$diagnose", status: 200, actor: null, patient: "not a ref" }).entity.length, 1);
  assert.equal(truncateIp("garbage"), undefined);
  const row = auditRow(ev);
  assert.equal(row.id, ev.id);
  assert.equal(row.operation, "POST /fhir/Condition/$diagnose");
  assert.equal(auditSearchBundle(BASE, [{ event: ev }]).entry[0].resource.id, ev.id);
  assert.deepEqual(checkR4(auditSearchBundle(BASE, [{ event: ev }])).errors, []);
});

// ─── profiles ─────────────────────────────────────────────────────────────

test("profiles are published StructureDefinitions and enforced from the same table", () => {
  assert.deepEqual(PROFILE_NAMES.sort(), ["adime-composition", "adime-document-bundle", "ncp-audit-event", "ncp-care-team", "ncp-document-provenance"]);
  for (const name of PROFILE_NAMES) {
    const sdef = profileResource(BASE, name);
    assert.equal(sdef.derivation, "constraint");
    assert.equal(sdef.fhirVersion, "4.0.1");
    assert.equal(sdef.baseDefinition, `http://hl7.org/fhir/StructureDefinition/${sdef.type}`);
    assert.ok(sdef.differential.element.length >= 3);
    for (const el of sdef.differential.element) assert.ok(el.path.startsWith(sdef.type), el.path);
  }
  assert.equal(profileResource(BASE, "nope"), null);
  const doc = docOf();
  assert.deepEqual(checkProfiles(BASE, doc), []);
  const broken = structuredClone(doc);
  delete broken.identifier;
  broken.entry[0].resource.section = broken.entry[0].resource.section.slice(0, 2);
  const msgs = checkProfiles(BASE, broken).concat(checkProfiles(BASE, broken.entry[0].resource)).map((i) => i.message).join("|");
  assert.match(msgs, /Bundle\.identifier needs at least 1/);
  assert.match(msgs, /Composition\.section needs at least 4/);
  assert.match(checkProfiles(BASE, { resourceType: "Patient", meta: { profile: [`${BASE}/fhir/StructureDefinition/ncp-care-team`] } })[0].message, /for CareTeam/);
});

// ─── terminology mappings ─────────────────────────────────────────────────

test("ConceptMaps are served and $translate returns only real mappings", () => {
  for (const name of CONCEPT_MAP_NAMES) {
    const cm = conceptMapResource(BASE, name);
    assert.equal(cm.resourceType, "ConceptMap");
    assert.ok(cm.group[0].element.length > 0);
    assert.deepEqual(checkR4(cm).errors, []);
  }
  const lo = conceptMapResource(BASE, "assessment-item-to-loinc").group[0].element;
  for (const [k, d] of Object.entries(ITEMS)) {
    const el = lo.find((e) => e.code === k);
    assert.ok(el, k);
    if (d.loinc) assert.equal(el.target[0].code, d.loinc, k);
    else assert.equal(el.target[0].equivalence, "unmatched", k);
  }
  const tr = (params) => ok(evaluateTranslate(P(params), ctx));
  const val = (b, name) => b.parameter.find((p) => p.name === name);
  const w = tr([S("system", `${BASE}/fhir/CodeSystem/assessment-item`), S("code", "weight")]);
  assert.equal(val(w, "result").valueBoolean, true);
  assert.equal(val(w, "match").part.find((x) => x.name === "concept").valueCoding.code, "29463-7");
  const doc = tr([S("system", `${BASE}/fhir/CodeSystem/ncp-care-role`), S("code", "physician"), S("targetSystem", "http://terminology.hl7.org/CodeSystem/practitioner-role")]);
  assert.equal(val(doc, "match").part.find((x) => x.name === "concept").valueCoding.code, "doctor");
  const rd = tr([S("system", `${BASE}/fhir/CodeSystem/ncp-care-role`), S("code", "dietitian")]);
  assert.equal(val(rd, "result").valueBoolean, false);
  assert.equal(rd.parameter.some((p) => p.name === "match"), false);
  assert.equal(val(tr([S("system", "http://other"), S("code", "x")]), "result").valueBoolean, false);
  const bad = evaluateTranslate(P([S("system", "a"), S("code", "b"), S("url", "no-such-map")]), ctx);
  assert.equal(bad.status, 404);
  assert.equal(evaluateTranslate(P([S("code", "b")]), ctx).status, 400);
});

// ─── R4 checker ───────────────────────────────────────────────────────────

test("every Step 1-6 output and the document pass the R4 structural check", () => {
  const f = flow();
  for (const [k, v] of Object.entries(f)) assert.deepEqual(checkR4(v, { base: BASE }).errors, [], k);
  const doc = docOf();
  const r = checkR4(doc, { base: BASE });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(R4_TYPE_NAMES.includes("Composition"));
});

test("the R4 checker catches the mistakes it claims to", () => {
  const e = (res) => checkR4(res).errors.map((i) => i.message).join("|");
  assert.match(e({ resourceType: "Observation", status: "done", code: { text: "x" } }), /status "done" is not one of/);
  assert.match(e({ resourceType: "Observation", code: { text: "x" } }), /Observation\.status is required/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, category: { text: "x" } }), /category must be an array/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, note: [] }), /empty arrays/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, issued: "2026-01-01" }), /not a valid instant/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, effectiveDateTime: "2026-01-01T10:00Z" }), /not a valid dateTime/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, valueString: "a", valueInteger: 1 }), /more than one value\[x\]/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, valueQuantity: { unit: "kg" } }), /Quantity\.value must be a number/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, subject: { reference: "not a ref" } }), /not a valid reference/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, extension: [{ url: "u", valueString: "a", valueCode: "b" }] }), /more than one value\[x\]/);
  assert.match(e({ resourceType: "Observation", status: "final", code: { text: "x" }, extension: [{ valueString: "a" }] }), /extension without a url/);
  assert.match(e({ resourceType: "Observation", status: "final", code: null }), /null/);
  assert.match(e({ resourceType: "Observation", id: "bad id!", status: "final", code: { text: "x" } }), /id "bad id!"/);
  assert.match(e({ resourceType: "Goal", lifecycleStatus: "active", description: { text: "x" }, subject: { reference: "Patient/1" }, target: [{ detailQuantity: { value: 1 } }] }), /target\.measure/);
  assert.match(e({ resourceType: "CarePlan", status: "active", intent: "plan", subject: { reference: "Patient/1" }, activity: [{ reference: { reference: "Task/1" }, detail: { status: "x" } }] }), /cpl-3/);
  assert.match(e({ resourceType: "Provenance", target: [{ reference: "Patient/1" }], recorded: "2026-10-11T08:00:00Z", agent: [{ type: {} }] }), /agent\.who/);
  assert.match(e({ resourceType: "Bundle", type: "document", entry: [{ fullUrl: "urn:uuid:a", resource: { resourceType: "Patient" } }] }), /identifier|timestamp|Composition/);
  assert.match(e({ resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:a", resource: { resourceType: "Patient" } }, { fullUrl: "urn:uuid:a", resource: { resourceType: "Patient" } }] }), /appears twice/);
  assert.match(e({ resourceType: "Composition", status: "final", type: { text: "t" }, date: "2026-10-11T08:00:00Z", author: [{ display: "a" }], title: "t", section: [{ title: "empty" }] }), /cmp-1/);
  assert.match(e({ resourceType: "Composition", status: "final", type: { text: "t" }, date: "2026-10-11T08:00:00Z", author: [{ display: "a" }], title: "t", text: { status: "generated", div: "<p>x</p>" } }), /XHTML/);
  assert.match(e({ resourceType: "Organization" }), /org-1/);
  assert.match(e({ resourceType: "Patient", period: 1 }), /^$|period/ ) ;
  assert.match(e({ foo: 1 }), /no resourceType/);
  const w = checkR4({ resourceType: "Observation", status: "final", code: { text: "x" }, bogus: 1 }).warnings.map((i) => i.message).join("|");
  assert.match(w, /"bogus" is not an element of Observation/);
  assert.match(checkR4({ resourceType: "Basic" }).warnings[0].message, /not checked/);
});

test("$validate and $validate-document return OperationOutcomes; the document check adds R4 findings", () => {
  const good = ok(evaluateValidate(P([R(docOf())]), ctx));
  assert.deepEqual(good.issue.map((i) => i.severity), ["information"]);
  assert.equal(evaluateValidate(P([]), ctx).ok, false);
  const doc = docOf();
  doc.entry[1].resource.note = []; // an empty array is invalid FHIR JSON
  const out = ok(evaluateValidateDocument(P([R(doc)]), ctx));
  assert.ok(out.issue.some((i) => i.severity === "error" && /R4: empty arrays/.test(i.diagnostics)));
});

// ─── the document carries governance ──────────────────────────────────────

test("the ADIME document declares profiles, a confidentiality label and a provenance", () => {
  const doc = docOf();
  const comp = doc.entry[0].resource;
  assert.deepEqual(doc.meta.profile, [`${BASE}/fhir/StructureDefinition/adime-document-bundle`]);
  assert.deepEqual(comp.meta.profile, [`${BASE}/fhir/StructureDefinition/adime-composition`]);
  assert.equal(comp.confidentiality, "N");
  assert.equal(doc.meta.security[0].code, "N");
  const prov = doc.entry.filter((e) => e.resource.resourceType === "Provenance").map((e) => e.resource).find((p) => p.meta?.profile);
  assert.equal(prov.target[0].reference, doc.entry[0].fullUrl);
  assert.deepEqual(prov.agent.map((a) => a.type.coding[0].code), ["author", "assembler", "custodian"]);
  assert.equal(prov.agent[0].who.reference, comp.author[0].reference);
  assert.ok(prov.entity.length >= 1, "derived from the earlier step provenance");
  assert.equal(docOf([S("confidentiality", "R")]).entry[0].resource.confidentiality, "R");
  const bad = evaluateAdimeDocument(P([S("subject", "Patient/1"), S("author", "x"), S("confidentiality", "X"), R(flow().diagnosis)]), ctx);
  assert.equal(bad.status, 400);
});

test("empty ADIME sections carry text (R4 cmp-1)", () => {
  const f = flow();
  const doc = ok(evaluateAdimeDocument(P([S("subject", "Patient/1"), S("author", "x"), R(f.diagnosis)]), ctx));
  const empty = doc.entry[0].resource.section.find((s) => s.emptyReason);
  assert.ok(empty.text.div.includes("Nothing recorded"));
  assert.deepEqual(checkR4(doc, { base: BASE }).errors, []);
});

test("conformance: CapabilityStatement declares security, profiles, AuditEvent and the new operations", () => {
  const cap = buildCapabilityStatement(BASE, { authMode: "enforce" });
  const rest = cap.rest[0];
  assert.equal(rest.security.service[0].coding[0].code, "OAuth");
  assert.equal(rest.security.extension[0].extension[0].valueUri, `${BASE}/oauth/token`);
  assert.match(rest.security.description, /REQUIRED/);
  assert.match(buildCapabilityStatement(BASE).rest[0].security.description, /OPEN mode/);
  assert.ok(rest.operation.some((o) => o.name === "validate"));
  const types = rest.resource.map((r) => r.type);
  for (const t of ["AuditEvent", "ConceptMap", "Composition", "Provenance", "CareTeam"]) assert.ok(types.includes(t), t);
  assert.deepEqual(rest.resource.find((r) => r.type === "Bundle").supportedProfile, [`${BASE}/fhir/StructureDefinition/adime-document-bundle`]);
  for (const id of ["ConceptMap-translate", "validate"]) assert.ok(operationDefinitionResource(BASE, id), id);
  assert.equal(operationDefinitionResource(BASE, "validate").system, true);
  assert.equal(operationDefinitionResource(BASE, "validate").resource, undefined);
  assert.deepEqual(checkR4(cap).warnings.filter((w) => /CapabilityStatement/.test(w.message)).length, 1); // not a checked type: reported, not failed
});

// ─── the Worker, end to end ───────────────────────────────────────────────

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function harness(envExtra = {}) {
  const calls = [];
  const logs = [];
  const keyRows = new Map([
    [await sha256Hex("key-reviewer"), { id: 1, label: "reviewer-app", role: "reviewer", fhir_scopes: null }],
    [await sha256Hex("key-scoped"), { id: 2, label: "dx-only", role: "reviewer", fhir_scopes: "system/Condition.write" }],
    [await sha256Hex("key-auditor"), { id: 3, label: "auditor", role: "reviewer", fhir_scopes: "system/AuditEvent.read" }],
  ]);
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, method: init.method ?? "GET", body: init.body, headers: init.headers });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname.endsWith("/api_keys")) { const h = (u.searchParams.get("key_hash") ?? "").replace("eq.", ""); const row = keyRows.get(h); return json(row ? [row] : []); }
    if (u.pathname.endsWith("/fhir_audit_events") && (init.method ?? "GET") === "POST") return json([JSON.parse(init.body)], 201);
    if (u.pathname.endsWith("/fhir_audit_events")) return json([{ id: "a1", event: { resourceType: "AuditEvent", id: "a1", type: { code: "rest" }, recorded: "2026-10-11T08:00:00Z", agent: [{ requestor: true }], source: { observer: { display: "x" } } } }]);
    return json([]);
  };
  console.log = (x) => logs.push(String(x));
  const env = { ADMIN_API_KEY: "root-key", SUPABASE_URL: "https://sb.test", SUPABASE_KEY: "k", ...envExtra };
  const waits = [];
  const wctx = { waitUntil: (p) => waits.push(p) };
  const call = async (path, { method = "GET", token, body } = {}) => {
    const r = await worker.fetch(new Request(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), "CF-Connecting-IP": "198.51.100.23" }, body: body ? JSON.stringify(body) : undefined }), env, wctx);
    await Promise.all(waits.splice(0));
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, headers: r.headers, json, text };
  };
  const done = () => { globalThis.fetch = realFetch; console.log = realLog; };
  const audits = () => logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.type === "fhir_audit_event");
  return { call, done, calls, audits, logs };
}

const DX = (secret = "Grace Banda") => P([S("subject", "Patient/777"), S("author", secret), part("diagnosis", [S("problem", "Inadequate energy intake"), S("domain", "intake"), S("etiology", "poor appetite"), S("signsSymptoms", "intake 55% of requirement")])]);

test("Worker (enforce): no token 401 as OperationOutcome; scopes decide; conformance stays open", async () => {
  const h = await harness({ FHIR_AUTH_MODE: "enforce" });
  try {
    const meta = await h.call("/fhir/metadata");
    assert.equal(meta.status, 200);
    assert.match(meta.headers.get("Content-Type"), /application\/fhir\+json/);
    assert.equal(meta.json.rest[0].security.service[0].coding[0].code, "OAuth");
    assert.equal((await h.call("/fhir/StructureDefinition/adime-composition")).json.type, "Composition");
    assert.equal((await h.call("/fhir/ConceptMap/assessment-item-to-loinc")).json.resourceType, "ConceptMap");
    assert.equal((await h.call("/fhir/StructureDefinition/nope")).status, 404);

    const noTok = await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX() });
    assert.equal(noTok.status, 401);
    assert.equal(noTok.json.resourceType, "OperationOutcome");
    assert.equal(noTok.json.issue[0].code, "login");
    assert.match(noTok.headers.get("WWW-Authenticate"), /^Bearer/);
    assert.match(noTok.headers.get("Content-Type"), /fhir\+json/);
    assert.equal((await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX(), token: "wrong" })).status, 401);

    const rev = await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX(), token: "key-reviewer" });
    assert.equal(rev.status, 403);
    assert.equal(rev.json.issue[0].code, "forbidden");
    const scoped = await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX(), token: "key-scoped" });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.headers.get("Cache-Control"), "no-store");
    assert.equal(scoped.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(scoped.json.resourceType, "Bundle");
    assert.equal((await h.call("/fhir/CarePlan/$intervene", { method: "POST", body: P([]), token: "key-scoped" })).status, 403);
    assert.equal((await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX(), token: "root-key" })).status, 200);

    const ro = await h.call("/fhir/$validate", { method: "POST", token: "key-reviewer", body: P([R({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "x" }] })]) });
    assert.equal(ro.status, 200);
    const tr = await h.call("/fhir/ConceptMap/$translate", { method: "POST", body: P([S("system", `${BASE}/fhir/CodeSystem/assessment-item`), S("code", "weight")]) });
    assert.equal(tr.json.parameter[0].valueBoolean, true);
  } finally { h.done(); }
});

test("Worker (open mode, the default): operations stay public as before", async () => {
  const h = await harness();
  try {
    const r = await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX() });
    assert.equal(r.status, 200);
    const meta = await h.call("/fhir/metadata");
    assert.match(meta.json.rest[0].security.description, /OPEN mode/);
  } finally { h.done(); }
});

test("Worker: every failure under /fhir is an OperationOutcome", async () => {
  const h = await harness();
  try {
    const nf = await h.call("/fhir/nothing");
    assert.equal(nf.status, 404);
    assert.equal(nf.json.resourceType, "OperationOutcome");
    assert.equal(nf.json.issue[0].code, "not-found");
    const m = await h.call("/fhir/metadata", { method: "POST", body: {} });
    assert.equal(m.json.resourceType, "OperationOutcome");
    assert.ok([401, 405].includes(m.status), String(m.status));
    assert.match(m.headers.get("Content-Type"), /fhir\+json/);
    const bad = await h.call("/fhir/Condition/$diagnose", { method: "POST", body: { resourceType: "Bundle" } });
    assert.equal(bad.json.resourceType, "OperationOutcome");
    for (const r of [nf, m, bad]) assert.deepEqual(checkR4(r.json).errors, []);
  } finally { h.done(); }
});

test("Worker: audit log lines carry who/what/outcome and never the body, the patient or the full IP", async () => {
  const h = await harness({ FHIR_AUTH_MODE: "enforce" });
  try {
    await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX("SECRET-AUTHOR-NAME"), token: "key-scoped" });
    await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX(), token: "key-reviewer" });
    await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX() });
    await h.call("/fhir/metadata");
    const a = h.audits();
    assert.equal(a.length, 3, "conformance reads are not audited; the three operation attempts are");
    assert.deepEqual(a.map((x) => x.audit_event.outcome), ["0", "4", "4"]);
    assert.deepEqual(a.map((x) => x.audit_event.agent[0].name), ["dx-only", "reviewer-app", "anonymous"]);
    assert.match(a[1].audit_event.outcomeDesc, /lacks the system\/Condition\.write scope/);
    assert.match(a[2].audit_event.outcomeDesc, /requires authentication/);
    const all = JSON.stringify(a);
    for (const leak of ["SECRET-AUTHOR-NAME", "Patient/777", "Inadequate energy", "198.51.100.23", "key-scoped", "root-key"]) assert.equal(all.includes(leak), false, leak);
    assert.equal(a[0].audit_event.agent[0].network.address, "198.51.100.0");
    for (const x of a) assert.deepEqual(checkR4(x.audit_event, { base: BASE }).errors, []);
    assert.equal(a[0].audit_event.id.length, 36);
  } finally { h.done(); }
});

test("Worker: the patient reference is recorded only when the operator opts in", async () => {
  const off = await harness();
  try { await off.call("/fhir/Condition/$diagnose", { method: "POST", body: DX() }); assert.equal(JSON.stringify(off.audits()).includes("Patient/777"), false); } finally { off.done(); }
  const on = await harness({ FHIR_AUDIT_INCLUDE_PATIENT: "true" });
  try { await on.call("/fhir/Condition/$diagnose", { method: "POST", body: DX() }); assert.equal(on.audits()[0].audit_event.entity[1].what.reference, "Patient/777"); } finally { on.done(); }
  const quiet = await harness({ FHIR_AUDIT_LOG: "off" });
  try { await quiet.call("/fhir/Condition/$diagnose", { method: "POST", body: DX() }); assert.equal(quiet.audits().length, 0); } finally { quiet.done(); }
});

test("Worker: with FHIR_AUDIT_STORE the event is stored; reading it needs admin or the AuditEvent scope", async () => {
  const h = await harness({ FHIR_AUTH_MODE: "enforce", FHIR_AUDIT_STORE: "true" });
  try {
    await h.call("/fhir/Condition/$diagnose", { method: "POST", body: DX("STORED-SECRET-NAME"), token: "key-scoped" });
    const ins = h.calls.find((c) => c.url.pathname.endsWith("/fhir_audit_events") && c.method === "POST");
    assert.ok(ins, "an audit row was inserted");
    const row = JSON.parse(ins.body);
    assert.equal(row.agent, "dx-only");
    assert.equal(row.outcome, "0");
    assert.equal(row.operation, "POST /fhir/Condition/$diagnose");
    assert.equal(row.event.resourceType, "AuditEvent");
    assert.equal(ins.body.includes("STORED-SECRET-NAME"), false);

    assert.equal((await h.call("/fhir/AuditEvent")).status, 401);
    assert.equal((await h.call("/fhir/AuditEvent", { token: "key-reviewer" })).status, 403);
    assert.equal((await h.call("/fhir/AuditEvent", { token: "key-scoped" })).status, 403);
    const root = await h.call("/fhir/AuditEvent?date=ge2026-10-01&date=le2026-10-31&outcome=0&agent-name=dx-only&_count=5", { token: "root-key" });
    assert.equal(root.status, 200);
    assert.equal(root.json.type, "searchset");
    assert.equal(root.json.entry[0].resource.resourceType, "AuditEvent");
    const q = h.calls.filter((c) => c.url.pathname.endsWith("/fhir_audit_events") && c.method === "GET").pop().url.searchParams;
    assert.equal(q.get("and"), "(recorded.gte.2026-10-01,recorded.lte.2026-10-31)");
    assert.equal(q.get("outcome"), "eq.0");
    assert.equal(q.get("agent"), "eq.dx-only");
    const last = h.calls.filter((c) => c.url.pathname.endsWith("/fhir_audit_events") && c.method === "GET").pop();
    assert.equal(last.headers.Range, "0-4");
    assert.equal((await h.call("/fhir/AuditEvent", { token: "key-auditor" })).status, 200);
    assert.equal((await h.call("/fhir/AuditEvent?date=yesterday", { token: "root-key" })).status, 400);
    assert.equal((await h.call("/fhir/AuditEvent?outcome=9", { token: "root-key" })).status, 400);
    assert.equal((await h.call("/fhir/AuditEvent", { method: "POST", token: "root-key", body: {} })).status, 405);
    assert.equal((await h.call("/fhir/AuditEvent/a1", { token: "root-key" })).json.resourceType, "AuditEvent");
    assert.equal((await h.call("/fhir/AuditEvent/bad%20id", { token: "root-key" })).status, 400);
  } finally { h.done(); }
});

test("Worker: AuditEvent storage off gives a clear 501 (and still needs a credential)", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("/fhir/AuditEvent")).status, 401);
    const r = await h.call("/fhir/AuditEvent", { token: "root-key" });
    assert.equal(r.status, 501);
    assert.equal(r.json.issue[0].code, "not-supported");
  } finally { h.done(); }
});
