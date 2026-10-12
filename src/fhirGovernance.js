// FHIR R4 facade: interoperability and governance (NCP step 7).
//
// Pure functions (no DB, no Request/Response) so they run under `node --test`
// exactly as they run in the Worker. index.js glues them to the request.
//
//   1. Access control    scopes (system/<Type>.<read|write|*>), which route
//                        needs which scope, and the allow/deny decision.
//   2. Errors            any failure under /fhir becomes an OperationOutcome
//                        with the right issue.code.
//   3. Audit             AuditEvent resources describing a request (who, what,
//                        when, outcome). NEVER the request body, never a query
//                        string, never a patient id unless the operator opts in.
//   4. Profiles          StructureDefinitions (constraint profiles on R4 base)
//                        for what this facade claims in meta.profile, built
//                        from the same table the checker enforces.
//   5. Terminology maps  ConceptMaps and ConceptMap/$translate.
//   6. R4 checking       a structural R4 checker for the resource types the
//                        facade emits, and POST /fhir/$validate.
//
// HONEST SCOPE. The checker is NOT the HL7 FHIR Validator. It checks the
// element names, required elements, cardinality, required value-set bindings,
// primitive formats, references, extensions and the main invariants of the
// types listed in R4_TYPES. It does not load StructureDefinitions, check
// terminology bindings beyond the required ones, or validate against an
// implementation guide. Run the HL7 validator in your pipeline for that.

import { readParams, requireParameters } from "./fhirNcp.js";
import { LOINC_CODE_MAP } from "./fhir.js";
import { ITEMS } from "./fhirAssessment.js";

const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const sd = (base, name) => `${base}/fhir/StructureDefinition/${name}`;

export const FHIR_JSON = "application/fhir+json; charset=utf-8";

// ═══ 1. ACCESS CONTROL ═════════════════════════════════════════════════════

/** Parses "system/Condition.write system/*.read" -> [{ type, level }]; null if anything is malformed. */
export function parseScopes(value) {
  if (value == null) return [];
  const parts = (Array.isArray(value) ? value : String(value).split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^system\/(\*|[A-Z][A-Za-z]+)\.(read|write|\*)$/.exec(p);
    if (!m) return null;
    out.push({ type: m[1], level: m[2] });
  }
  return out;
}

/** What a credential may do when it carries no explicit fhir_scopes: derived from its role. */
export function scopesForRole(role, isRoot = false) {
  if (isRoot || role === "admin") return [{ type: "*", level: "*" }];
  if (role === "reviewer") return [{ type: "*", level: "read" }];
  // Developer-portal consumer keys: every clinical operation, never AuditEvent (a wildcard type excludes it).
  if (role === "consumer") return [{ type: "*", level: "*" }];
  return [];
}

/** Does the scope list allow `level` on `type`? A wildcard type never covers AuditEvent. */
export function scopeAllows(scopes, type, level) {
  return scopes.some((s) => {
    const typeOk = s.type === type || (s.type === "*" && type !== "AuditEvent");
    const levelOk = s.level === "*" || s.level === level;
    return typeOk && levelOk;
  });
}

// Operations that compute or check without producing a new clinical resource.
const READ_OPERATIONS = new Set(["QuestionnaireResponse/$validate", "Bundle/$validate-document", "$validate/undefined", "ConceptMap/$translate"]);
const CONFORMANCE_TYPES = new Set(["CodeSystem", "OperationDefinition", "StructureDefinition", "ConceptMap", "Questionnaire"]);

/**
 * Classifies a /fhir request. kind:
 *   public  conformance and terminology reads, always open (SMART needs /metadata open)
 *   audit   GET AuditEvent: always needs a credential
 *   read    an operation that only checks or translates
 *   write   an operation that produces clinical content
 */
export function classifyFhirRoute(method, param, action) {
  if (method === "GET" && param === "metadata") return { kind: "public", type: "CapabilityStatement" };
  if (method === "GET" && CONFORMANCE_TYPES.has(param)) return { kind: "public", type: param };
  if (param === "AuditEvent") return method === "GET" ? { kind: "audit", type: "AuditEvent" } : { kind: "other", type: "AuditEvent" }; // read-only: other methods reach the router and get a 405
  if (method === "POST" && param === "ConceptMap" && action === "$translate") return { kind: "public", type: "ConceptMap" };
  if (method === "POST") {
    const type = param?.startsWith("$") ? "Resource" : param;
    return { kind: READ_OPERATIONS.has(`${param}/${action}`) ? "read" : "write", type };
  }
  return { kind: "other", type: param };
}

/**
 * Allow/deny decision. identity = null (anonymous) or
 *   { valid, label, isRoot, role, fhirScopes }.
 * mode "enforce": clinical operations need a credential with the scope.
 * mode anything else ("open", the default): clinical operations are public as before.
 * AuditEvent reads need a credential in every mode.
 */
export function decideAccess({ mode, method, param, action, identity }) {
  const route = classifyFhirRoute(method, param, action);
  const allow = { allow: true, route };
  if (route.kind === "public" || route.kind === "other") return allow;

  const authed = Boolean(identity?.valid);
  const deny = (status, code, message) => ({ allow: false, status, code, message, route });

  if (route.kind === "audit") {
    if (!authed) return deny(401, "login", "A credential is required to read AuditEvents.");
    const explicit = (identity.fhirScopes ?? []).some((s) => s.type === "AuditEvent" && (s.level === "read" || s.level === "*"));
    if (identity.isRoot || identity.role === "admin" || explicit) return allow;
    return deny(403, "forbidden", "Reading AuditEvents needs the admin role or an explicit system/AuditEvent.read scope.");
  }

  if (mode !== "enforce") return allow;
  if (!authed) return deny(401, "login", "This FHIR facade requires authentication (Authorization: Bearer <token>).");
  const scopes = identity.fhirScopes?.length ? identity.fhirScopes : scopesForRole(identity.role, identity.isRoot);
  const level = route.kind === "write" ? "write" : "read";
  if (scopeAllows(scopes, route.type, level)) return allow;
  return deny(403, "forbidden", `The credential lacks the system/${route.type}.${level} scope needed for ${method} /fhir/${param}${action ? "/" + action : ""}.`);
}

// ═══ 2. ERRORS AS OperationOutcome ═════════════════════════════════════════

const ISSUE_CODE = { 400: "invalid", 401: "login", 403: "forbidden", 404: "not-found", 405: "not-supported", 409: "conflict", 413: "too-costly", 415: "not-supported", 422: "processing", 429: "throttled" };

export const operationOutcomeFor = (status, message, code) => ({
  resourceType: "OperationOutcome",
  issue: [{ severity: status === 500 ? "fatal" : "error", code: code ?? ISSUE_CODE[status] ?? (status >= 500 ? "exception" : "invalid"), diagnostics: String(message ?? `HTTP ${status}`).slice(0, 2000) }],
});

/** The message of a non-FHIR error body ({ status: "error", message }), else null. */
export function legacyErrorMessage(body) {
  return isObj(body) && !body.resourceType && (body.status === "error" || typeof body.message === "string") ? (body.message ?? body.error ?? "Error") : null;
}

// ═══ 3. AuditEvent ═════════════════════════════════════════════════════════

const AUDIT_TYPE = "http://terminology.hl7.org/CodeSystem/audit-event-type";
const RESTFUL = "http://hl7.org/fhir/restful-interaction";
const SOURCE_TYPE = "http://terminology.hl7.org/CodeSystem/security-source-type";
const ENTITY_TYPE = "http://terminology.hl7.org/CodeSystem/audit-entity-type";
const OBJECT_ROLE = "http://terminology.hl7.org/CodeSystem/object-role";
const PARTICIPATION = "http://terminology.hl7.org/CodeSystem/extra-security-role-type";

/** IPv4 -> a.b.c.0 ; IPv6 -> first 3 groups + "::". Never the full address. */
export function truncateIp(ip) {
  if (typeof ip !== "string") return undefined;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0";
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::";
  return undefined;
}

const outcomeCode = (status) => (status >= 500 ? "8" : status >= 400 ? "4" : "0");

/**
 * One AuditEvent for one /fhir request. `patient` is only used when the caller
 * (the operator, by env flag) opted in; it is a reference such as "Patient/123".
 */
export function buildAuditEvent({ base, requestId, now, method, path, status, actor, ip, patient, denied }) {
  const isOp = /\/\$[A-Za-z-]+$/.test(path);
  const action = isOp ? "E" : method === "GET" ? "R" : method === "POST" ? "C" : method === "DELETE" ? "D" : "U";
  const sub = isOp ? "operation" : method === "GET" ? (/\/fhir\/[A-Za-z]+\/[^/]+$/.test(path) ? "read" : "search-type") : method.toLowerCase();
  const addr = truncateIp(ip);
  const event = {
    resourceType: "AuditEvent",
    id: requestId,
    meta: { profile: [sd(base, "ncp-audit-event")] },
    type: { system: AUDIT_TYPE, code: "rest", display: "RESTful Operation" },
    subtype: [{ system: RESTFUL, code: sub, display: sub }],
    action,
    recorded: now,
    outcome: outcomeCode(status),
    outcomeDesc: denied ? `HTTP ${status}: ${denied}` : `HTTP ${status}`,
    agent: [
      {
        type: { coding: [{ system: PARTICIPATION, code: actor ? "dataauthenticator" : "humanuser", display: actor ? "data authenticator" : "human user" }] },
        ...(actor ? { who: { identifier: { value: String(actor.label ?? actor.oauthClientId ?? "unknown").slice(0, 120) } }, name: String(actor.label ?? "unknown").slice(0, 120) } : { name: "anonymous" }),
        requestor: true,
        ...(addr ? { network: { address: addr, type: "2" } } : {}),
      },
    ],
    source: {
      site: base,
      observer: { display: "Chakudya Nutrition Registry (CNR) FHIR facade" },
      type: [{ system: SOURCE_TYPE, code: "4", display: "Application Server" }],
    },
    entity: [
      { type: { system: ENTITY_TYPE, code: "2", display: "System Object" }, role: { system: OBJECT_ROLE, code: "13", display: "Security Resource" }, name: `${method} ${path}`.slice(0, 200) },
    ],
  };
  if (patient && /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(patient)) {
    event.entity.push({ what: { reference: patient }, type: { system: ENTITY_TYPE, code: "1", display: "Person" }, role: { system: OBJECT_ROLE, code: "1", display: "Patient" } });
  }
  return event;
}

/** subject of a Parameters body as a reference string, or undefined. Used only when the operator opts in. */
export function auditSubject(body) {
  try {
    const s = str(readParams(body).get("subject"));
    return s && /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(s) ? s : undefined;
  } catch { return undefined; }
}

/** The row stored for an AuditEvent (columns for filtering + the resource itself). */
export const auditRow = (event, extra = {}) => ({
  id: event.id,
  recorded: event.recorded,
  outcome: event.outcome,
  action: event.action,
  agent: event.agent[0].name ?? null,
  operation: event.entity[0].name,
  event,
  ...extra,
});

export function auditSearchBundle(base, rows, { count } = {}) {
  return {
    resourceType: "Bundle",
    type: "searchset",
    timestamp: new Date().toISOString(),
    ...(count != null ? { total: count } : {}),
    entry: rows.map((r) => ({ fullUrl: `${base}/fhir/AuditEvent/${r.event?.id ?? r.id}`, resource: r.event, search: { mode: "match" } })),
  };
}

// ═══ 4. PROFILES ═══════════════════════════════════════════════════════════

// One table drives both the published StructureDefinition and the checker.
// constraint: { path, min?, max?, mustSupport?, short?, fixed? }.
export const PROFILES = {
  "adime-document-bundle": {
    type: "Bundle",
    title: "Chakudya ADIME document Bundle",
    description: "A document Bundle holding one ADIME Composition and the resources it cites (assessment, diagnosis, intervention, monitoring and evaluation).",
    constraints: [
      { path: "Bundle.identifier", min: 1, short: "Persistent document identifier (urn:uuid)" },
      { path: "Bundle.type", min: 1, fixed: { valueCode: "document" } },
      { path: "Bundle.timestamp", min: 1 },
      { path: "Bundle.entry", min: 1 },
      { path: "Bundle.entry.fullUrl", min: 1, short: "Every entry is addressable so references resolve inside the document" },
    ],
  },
  "adime-composition": {
    type: "Composition",
    title: "Chakudya ADIME Composition",
    description: "The nutrition care process note: Assessment, Diagnosis, Intervention, Monitoring and evaluation sections, with the author, the facility that holds it and a status.",
    constraints: [
      { path: "Composition.identifier", min: 1 },
      { path: "Composition.subject", min: 1 },
      { path: "Composition.author", min: 1 },
      { path: "Composition.custodian", mustSupport: true, short: "Facility holding the note (from $care-context)" },
      { path: "Composition.encounter", mustSupport: true },
      { path: "Composition.section", min: 4, short: "The four ADIME sections (screening is optional): assessment, diagnosis, intervention, monitoring" },
      { path: "Composition.section.code", min: 1, short: "ncp-step code of the section" },
    ],
  },
  "ncp-document-provenance": {
    type: "Provenance",
    title: "Chakudya ADIME document provenance",
    description: "Who assembled and authored an ADIME document, when, and from which earlier records.",
    constraints: [
      { path: "Provenance.target", min: 1 },
      { path: "Provenance.recorded", min: 1 },
      { path: "Provenance.agent", min: 1 },
      { path: "Provenance.agent.who", min: 1 },
    ],
  },
  "ncp-care-team": {
    type: "CareTeam",
    title: "Chakudya nutrition care team",
    description: "The multidisciplinary team around one patient.",
    constraints: [
      { path: "CareTeam.subject", min: 1 },
      { path: "CareTeam.participant", min: 1 },
      { path: "CareTeam.participant.member", min: 1 },
      { path: "CareTeam.participant.role", mustSupport: true },
    ],
  },
  "ncp-audit-event": {
    type: "AuditEvent",
    title: "Chakudya FHIR request audit event",
    description: "One audited request to the facade. Contains no request body, no query string and no patient identifier unless the operator opted in.",
    constraints: [
      { path: "AuditEvent.recorded", min: 1 },
      { path: "AuditEvent.agent", min: 1 },
      { path: "AuditEvent.agent.requestor", min: 1 },
      { path: "AuditEvent.source.observer", min: 1 },
      { path: "AuditEvent.outcome", min: 1 },
    ],
  },
};
export const PROFILE_NAMES = Object.keys(PROFILES);

export function profileResource(base, name) {
  const p = PROFILES[name];
  if (!p) return null;
  return {
    resourceType: "StructureDefinition",
    id: name,
    url: sd(base, name),
    version: "1",
    name: name.replace(/(^|-)([a-z0-9])/g, (_, __, ch) => ch.toUpperCase()),
    title: p.title,
    status: "active",
    date: "2026-10-11",
    publisher: "Chakudya Nutrition Registry",
    description: p.description + " Constraint profile on the FHIR R4 base resource; not an implementation guide.",
    fhirVersion: "4.0.1",
    kind: "resource",
    abstract: false,
    type: p.type,
    baseDefinition: `http://hl7.org/fhir/StructureDefinition/${p.type}`,
    derivation: "constraint",
    differential: {
      element: p.constraints.map((c) => ({
        id: c.path,
        path: c.path,
        ...(c.short ? { short: c.short } : {}),
        ...(c.min != null ? { min: c.min } : {}),
        ...(c.max != null ? { max: c.max } : {}),
        ...(c.mustSupport ? { mustSupport: true } : {}),
        ...(c.fixed ? Object.fromEntries(Object.entries(c.fixed).map(([k, v]) => [`fixed${k.slice(5)}`, v])) : {}),
      })),
    },
  };
}

/** Values at a dotted path below `node` (arrays flattened). */
function valuesAt(node, parts) {
  if (parts.length === 0) return Array.isArray(node) ? node : [node];
  const [head, ...rest] = parts;
  const children = Array.isArray(node) ? node : [node];
  return children.flatMap((c) => (isObj(c) && c[head] !== undefined ? valuesAt(c[head], rest) : []));
}
const countOf = (par, leaf) => (isObj(par) && par[leaf] !== undefined ? (Array.isArray(par[leaf]) ? par[leaf].length : 1) : 0);

/** Min-cardinality findings for every profile the resource claims in meta.profile. */
export function checkProfiles(base, resource) {
  const issues = [];
  for (const url of resource?.meta?.profile ?? []) {
    const name = PROFILE_NAMES.find((n) => sd(base, n) === url);
    if (!name) continue;
    const p = PROFILES[name];
    if (p.type !== resource.resourceType) { issues.push({ severity: "error", path: resource.resourceType, message: `claims profile ${name}, which is for ${p.type}.` }); continue; }
    for (const c of p.constraints) {
      const parts = c.path.split(".").slice(1);
      const leaf = parts[parts.length - 1];
      const parents = parts.length > 1 ? valuesAt(resource, parts.slice(0, -1)) : [resource];
      if (c.min) {
        for (const par of parents) {
          const n = countOf(par, leaf);
          if (n < c.min) { issues.push({ severity: "error", path: c.path, message: `profile ${name}: ${c.path} needs at least ${c.min}, found ${n}.` }); break; }
        }
      }
      if (c.fixed?.valueCode !== undefined && parts.length === 1 && resource[leaf] !== undefined && resource[leaf] !== c.fixed.valueCode) {
        issues.push({ severity: "error", path: c.path, message: `profile ${name}: ${c.path} must be "${c.fixed.valueCode}".` });
      }
    }
  }
  return issues;
}

// ═══ 5. TERMINOLOGY MAPPINGS (ConceptMap, $translate) ══════════════════════

const LOINC_SYS = "http://loinc.org";
const EQUIV = "equivalent";

function mapItem(base) {
  const elements = Object.entries(ITEMS)
    .filter(([, d]) => d.loinc)
    .map(([key, d]) => ({ code: key, display: d.display, target: [{ code: d.loinc, display: d.display, equivalence: EQUIV }] }));
  for (const [key, d] of Object.entries(ITEMS)) if (!d.loinc) elements.push({ code: key, display: d.display, target: [{ equivalence: "unmatched", comment: "No LOINC code is claimed for this item." }] });
  return {
    source: `${base}/fhir/CodeSystem/assessment-item`,
    target: LOINC_SYS,
    description: "Registered assessment items (anthropometry, laboratory, clinical, dietary) to LOINC. Items without a LOINC code are listed as unmatched rather than guessed.",
    title: "Chakudya assessment items to LOINC",
    elements,
  };
}

function mapGrowthLoinc(base) {
  return {
    source: `${base}/fhir/CodeSystem/growth-metric`,
    target: LOINC_SYS,
    description: "Fenton preterm growth metrics to LOINC, as used on the Observation.code of the growth operations.",
    title: "Chakudya growth metrics to LOINC",
    elements: Object.entries(LOINC_CODE_MAP).map(([k, v]) => ({ code: k, display: v.display, target: [{ code: v.code, display: v.display, equivalence: EQUIV }] })),
  };
}

function mapRole(base) {
  const PR = "http://terminology.hl7.org/CodeSystem/practitioner-role";
  const eq = (code, display, tcode, tdisplay) => ({ code, display, target: [{ code: tcode, display: tdisplay, equivalence: EQUIV }] });
  const none = (code, display) => ({ code, display, target: [{ equivalence: "unmatched", comment: "HL7 practitioner-role has no equivalent code; kept as the Chakudya code." }] });
  return {
    source: `${base}/fhir/CodeSystem/ncp-care-role`,
    target: PR,
    description: "Care team roles to the small HL7 practitioner-role code system. Only true equivalents are mapped.",
    title: "Chakudya care roles to HL7 practitioner-role",
    elements: [
      eq("physician", "Physician", "doctor", "Doctor"),
      eq("nurse", "Nurse", "nurse", "Nurse"),
      eq("pharmacist", "Pharmacist", "pharmacist", "Pharmacist"),
      none("dietitian", "Dietitian"), none("nutritionist", "Nutritionist"), none("nutrition-assistant", "Nutrition assistant"),
      none("clinical-officer", "Clinical officer"), none("speech-language-therapist", "Speech and language therapist"),
      none("physiotherapist", "Physiotherapist"), none("occupational-therapist", "Occupational therapist"),
      none("psychologist", "Psychologist"), none("social-worker", "Social worker"), none("diabetes-educator", "Diabetes educator"),
      none("community-health-worker", "Community health worker"), none("other", "Other team role"),
    ],
  };
}

function mapInterpretation(base) {
  const V3 = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
  const rel = (code, tcode, tdisplay) => ({ code, target: [{ code: tcode, display: tdisplay, equivalence: "relatedto", comment: "Best-effort; the Chakudya status in the Observation component is the fidelity-preserving value." }] });
  return {
    source: `${base}/fhir/CodeSystem/growth-status`,
    target: V3,
    description: "Growth status to the v3 ObservationInterpretation code that the growth Observations carry in Observation.interpretation. The mapping is related-to, not equivalent.",
    title: "Chakudya growth status to v3 ObservationInterpretation",
    elements: [
      rel("small", "L", "Low"), rel("appropriate", "N", "Normal"), rel("large", "H", "High"),
      rel("normal", "N", "Normal"), rel("severe thinness", "LL", "Critical low"), rel("thinness", "L", "Low"),
      rel("overweight", "H", "High"), rel("obesity", "HH", "Critical high"),
    ],
  };
}

const MAPS = {
  "assessment-item-to-loinc": mapItem,
  "growth-metric-to-loinc": mapGrowthLoinc,
  "ncp-care-role-to-practitioner-role": mapRole,
  "growth-status-to-interpretation": mapInterpretation,
};
export const CONCEPT_MAP_NAMES = Object.keys(MAPS);

export function conceptMapResource(base, name) {
  const f = MAPS[name];
  if (!f) return null;
  const m = f(base);
  return {
    resourceType: "ConceptMap",
    id: name,
    url: `${base}/fhir/ConceptMap/${name}`,
    version: "1",
    name: name.replace(/(^|-)([a-z0-9])/g, (_, __, ch) => ch.toUpperCase()),
    title: m.title,
    status: "active",
    date: "2026-10-11",
    publisher: "Chakudya Nutrition Registry",
    description: m.description,
    sourceUri: m.source,
    targetUri: m.target,
    group: [{ source: m.source, target: m.target, element: m.elements }],
  };
}

export function evaluateTranslate(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const code = str(p.get("code"));
  const system = str(p.get("system"));
  const targetSystem = str(p.get("targetSystem") ?? p.get("targetsystem"));
  const mapName = str(p.get("url"))?.split("/").pop() ?? str(p.get("map"));
  if (!code || !system) return fail(["'code' and 'system' are required."]);
  const candidates = (mapName ? [mapName] : CONCEPT_MAP_NAMES).map((n) => conceptMapResource(ctx.base, n)).filter(Boolean);
  if (mapName && candidates.length === 0) return fail([`Unknown ConceptMap "${mapName}". Known: ${CONCEPT_MAP_NAMES.join(", ")}.`], 404);
  const matches = [];
  for (const cm of candidates) {
    const g = cm.group[0];
    if (g.source !== system) continue;
    if (targetSystem && g.target !== targetSystem) continue;
    const el = g.element.find((x) => x.code === code);
    for (const t of el?.target ?? []) {
      if (t.equivalence === "unmatched") continue;
      matches.push({ name: "match", part: [
        { name: "equivalence", valueCode: t.equivalence },
        { name: "concept", valueCoding: { system: g.target, code: t.code, ...(t.display ? { display: t.display } : {}) } },
        { name: "source", valueUri: cm.url },
      ] });
    }
  }
  return {
    ok: true, status: 200,
    body: { resourceType: "Parameters", parameter: [
      { name: "result", valueBoolean: matches.length > 0 },
      { name: "message", valueString: matches.length ? `${matches.length} mapping(s) found.` : "No mapping found; nothing was guessed." },
      ...matches,
    ] },
  };
}

const fail = (issues, status = 400) => ({
  ok: false, status,
  outcome: { resourceType: "OperationOutcome", issue: issues.map((diagnostics) => ({ severity: "error", code: status === 404 ? "not-found" : "invalid", diagnostics })) },
});

// ═══ 6. R4 STRUCTURAL CHECKER ══════════════════════════════════════════════

const COMMON = ["id", "meta", "implicitRules", "language", "text", "contained", "extension", "modifierExtension"];
const VS = {
  bundleType: ["document", "message", "transaction", "transaction-response", "batch", "batch-response", "history", "searchset", "collection"],
  compStatus: ["preliminary", "final", "amended", "entered-in-error"],
  obsStatus: ["registered", "preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error", "unknown"],
  goalStatus: ["proposed", "planned", "accepted", "active", "on-hold", "completed", "cancelled", "entered-in-error", "rejected"],
  planStatus: ["draft", "active", "on-hold", "revoked", "completed", "entered-in-error", "unknown"],
  carePlanIntent: ["proposal", "plan", "order", "option"],
  requestIntent: ["proposal", "plan", "directive", "order", "original-order", "reflex-order", "filler-order", "instance-order", "option"],
  taskIntent: ["unknown", "proposal", "plan", "order", "original-order", "reflex-order", "filler-order", "instance-order", "option"],
  taskStatus: ["draft", "requested", "received", "accepted", "rejected", "ready", "cancelled", "in-progress", "on-hold", "failed", "completed", "entered-in-error"],
  qrStatus: ["in-progress", "completed", "amended", "entered-in-error", "stopped"],
  teamStatus: ["proposed", "active", "suspended", "inactive", "entered-in-error"],
  encStatus: ["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled", "entered-in-error", "unknown"],
  confidentiality: ["U", "L", "M", "N", "R", "V"],
};

// elements: allowed top-level names (x[] = choice). required/arrays/codes as stated.
const R4_TYPES = {
  Bundle: { elements: ["identifier", "type", "timestamp", "total", "link", "entry", "signature"], required: ["type"], arrays: ["link", "entry"], codes: { type: VS.bundleType } },
  Composition: { elements: ["identifier", "status", "type", "category", "subject", "encounter", "date", "author", "title", "confidentiality", "attester", "custodian", "relatesTo", "event", "section"], required: ["status", "type", "date", "author", "title"], arrays: ["category", "author", "attester", "relatesTo", "event", "section"], codes: { status: VS.compStatus, confidentiality: VS.confidentiality } },
  Observation: { elements: ["identifier", "basedOn", "partOf", "status", "category", "code", "subject", "focus", "encounter", "effective[x]", "issued", "performer", "value[x]", "dataAbsentReason", "interpretation", "note", "bodySite", "method", "specimen", "device", "referenceRange", "hasMember", "derivedFrom", "component"], required: ["status", "code"], arrays: ["identifier", "basedOn", "partOf", "category", "focus", "performer", "interpretation", "note", "referenceRange", "hasMember", "derivedFrom", "component"], codes: { status: VS.obsStatus } },
  Condition: { elements: ["identifier", "clinicalStatus", "verificationStatus", "category", "severity", "code", "bodySite", "subject", "encounter", "onset[x]", "abatement[x]", "recordedDate", "recorder", "asserter", "stage", "evidence", "note"], required: ["subject"], arrays: ["identifier", "category", "bodySite", "stage", "evidence", "note"], codes: {} },
  Goal: { elements: ["identifier", "lifecycleStatus", "achievementStatus", "category", "priority", "description", "subject", "start[x]", "target", "statusDate", "statusReason", "expressedBy", "addresses", "note", "outcomeCode", "outcomeReference"], required: ["lifecycleStatus", "description", "subject"], arrays: ["identifier", "category", "target", "addresses", "note", "outcomeCode", "outcomeReference"], codes: { lifecycleStatus: VS.goalStatus } },
  CarePlan: { elements: ["identifier", "instantiatesCanonical", "instantiatesUri", "basedOn", "replaces", "partOf", "status", "intent", "category", "title", "description", "subject", "encounter", "period", "created", "author", "contributor", "careTeam", "addresses", "supportingInfo", "goal", "activity", "note"], required: ["status", "intent", "subject"], arrays: ["identifier", "instantiatesCanonical", "instantiatesUri", "basedOn", "replaces", "partOf", "category", "contributor", "careTeam", "addresses", "supportingInfo", "goal", "activity", "note"], codes: { status: VS.planStatus, intent: VS.carePlanIntent } },
  NutritionOrder: { elements: ["identifier", "instantiatesCanonical", "instantiatesUri", "instantiates", "status", "intent", "patient", "encounter", "dateTime", "orderer", "allergyIntolerance", "foodPreferenceModifier", "excludeFoodModifier", "oralDiet", "supplement", "enteralFormula", "note"], required: ["status", "intent", "patient", "dateTime"], arrays: ["identifier", "instantiatesCanonical", "instantiatesUri", "instantiates", "allergyIntolerance", "foodPreferenceModifier", "excludeFoodModifier", "supplement", "note"], codes: { status: VS.planStatus, intent: VS.requestIntent } },
  ServiceRequest: { elements: ["identifier", "instantiatesCanonical", "instantiatesUri", "basedOn", "replaces", "requisition", "status", "intent", "category", "priority", "doNotPerform", "code", "orderDetail", "quantity[x]", "subject", "encounter", "occurrence[x]", "asNeeded[x]", "authoredOn", "requester", "performerType", "performer", "locationCode", "locationReference", "reasonCode", "reasonReference", "insurance", "supportingInfo", "specimen", "bodySite", "note", "patientInstruction", "relevantHistory"], required: ["status", "intent", "subject"], arrays: ["identifier", "basedOn", "replaces", "category", "orderDetail", "performer", "locationCode", "locationReference", "reasonCode", "reasonReference", "insurance", "supportingInfo", "specimen", "bodySite", "note", "relevantHistory"], codes: { status: VS.planStatus, intent: VS.requestIntent } },
  Task: { elements: ["identifier", "instantiatesCanonical", "instantiatesUri", "basedOn", "groupIdentifier", "partOf", "status", "statusReason", "businessStatus", "intent", "priority", "code", "description", "focus", "for", "encounter", "executionPeriod", "authoredOn", "lastModified", "requester", "performerType", "owner", "location", "reasonCode", "reasonReference", "insurance", "note", "relevantHistory", "restriction", "input", "output"], required: ["status", "intent"], arrays: ["identifier", "basedOn", "partOf", "performerType", "insurance", "note", "relevantHistory", "input", "output", "reasonReference"], codes: { status: VS.taskStatus, intent: VS.taskIntent } },
  QuestionnaireResponse: { elements: ["identifier", "basedOn", "partOf", "questionnaire", "status", "subject", "encounter", "authored", "author", "source", "item"], required: ["status"], arrays: ["basedOn", "partOf", "item"], codes: { status: VS.qrStatus } },
  Provenance: { elements: ["target", "occurred[x]", "recorded", "policy", "location", "reason", "activity", "agent", "entity", "signature"], required: ["target", "recorded", "agent"], arrays: ["target", "policy", "reason", "agent", "entity", "signature"], codes: {} },
  Patient: { elements: ["identifier", "active", "name", "telecom", "gender", "birthDate", "deceased[x]", "address", "maritalStatus", "multipleBirth[x]", "photo", "contact", "communication", "generalPractitioner", "managingOrganization", "link"], required: [], arrays: ["identifier", "name", "telecom", "address", "photo", "contact", "communication", "generalPractitioner", "link"], codes: {} },
  Encounter: { elements: ["identifier", "status", "statusHistory", "class", "classHistory", "type", "serviceType", "priority", "subject", "episodeOfCare", "basedOn", "participant", "appointment", "period", "length", "reasonCode", "reasonReference", "diagnosis", "account", "hospitalization", "location", "serviceProvider", "partOf"], required: ["status", "class"], arrays: ["identifier", "statusHistory", "classHistory", "type", "episodeOfCare", "basedOn", "participant", "appointment", "reasonCode", "reasonReference", "diagnosis", "account", "location"], codes: { status: VS.encStatus } },
  Practitioner: { elements: ["identifier", "active", "name", "telecom", "address", "gender", "birthDate", "photo", "qualification", "communication"], required: [], arrays: ["identifier", "name", "telecom", "address", "photo", "qualification", "communication"], codes: {} },
  PractitionerRole: { elements: ["identifier", "active", "period", "practitioner", "organization", "code", "specialty", "location", "healthcareService", "telecom", "availableTime", "notAvailable", "availabilityExceptions", "endpoint"], required: [], arrays: ["identifier", "code", "specialty", "location", "healthcareService", "telecom", "availableTime", "notAvailable", "endpoint"], codes: {} },
  Organization: { elements: ["identifier", "active", "type", "name", "alias", "telecom", "address", "partOf", "contact", "endpoint"], required: [], arrays: ["identifier", "type", "alias", "telecom", "address", "contact", "endpoint"], codes: {} },
  CareTeam: { elements: ["identifier", "status", "category", "name", "subject", "encounter", "period", "participant", "reasonCode", "reasonReference", "managingOrganization", "telecom", "note"], required: [], arrays: ["identifier", "category", "participant", "reasonCode", "reasonReference", "managingOrganization", "telecom", "note"], codes: { status: VS.teamStatus } },
  AuditEvent: { elements: ["type", "subtype", "action", "period", "recorded", "outcome", "outcomeDesc", "purposeOfEvent", "agent", "source", "entity"], required: ["type", "recorded", "agent", "source"], arrays: ["subtype", "purposeOfEvent", "agent", "entity"], codes: { action: ["C", "R", "U", "D", "E"], outcome: ["0", "4", "8", "12"] } },
  OperationOutcome: { elements: ["issue"], required: ["issue"], arrays: ["issue"], codes: {} },
};
export const R4_TYPE_NAMES = Object.keys(R4_TYPES);

const RE = {
  id: /^[A-Za-z0-9\-.]{1,64}$/,
  instant: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  dateTime: /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?)?)?$/,
  date: /^\d{4}(-\d{2}(-\d{2})?)?$/,
  code: /^[^\s]+(\s[^\s]+)*$/,
  ref: /^(#[A-Za-z0-9\-.]{1,64}|urn:uuid:[0-9a-fA-F-]{36}|urn:oid:[0-9.]+|(https?:\/\/\S+\/)?[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[A-Za-z0-9\-.]{1,64})?|https?:\/\/\S+)$/,
};
const INSTANT_KEYS = new Set(["timestamp", "recorded", "issued", "lastUpdated"]);
const DATETIME_KEYS = new Set(["date", "authoredOn", "authored", "recordedDate", "created", "dateTime", "start", "end", "lastModified", "effectiveDateTime", "onsetDateTime", "abatementDateTime", "occurredDateTime"]);
const DATE_KEYS = new Set(["birthDate", "dueDate", "statusDate", "startDate", "effectiveDate"]);
const URI_KEYS = new Set(["url", "system", "fullUrl", "implicitRules", "questionnaire"]);

const elementAllowed = (type, name) => type.elements.some((e) => (e.endsWith("[x]") ? new RegExp(`^${e.slice(0, -3)}[A-Z]\\w*$`).test(name) : e === name));

function checkNode(node, path, key, issues) {
  const err = (message, p = path) => issues.push({ severity: "error", path: p, message });
  if (node === null) return err("null is not allowed in FHIR JSON.");
  if (Array.isArray(node)) {
    if (node.length === 0) return err("empty arrays are not allowed in FHIR JSON.");
    node.forEach((n, i) => checkNode(n, `${path}[${i}]`, key, issues));
    return;
  }
  if (typeof node === "string") {
    if (node === "") return err("empty strings are not allowed.");
    if (INSTANT_KEYS.has(key) && !RE.instant.test(node)) err(`"${node}" is not a valid instant (needs seconds and a timezone).`);
    else if ((DATETIME_KEYS.has(key) || /DateTime$/.test(key)) && !RE.dateTime.test(node)) err(`"${node}" is not a valid dateTime (a time needs seconds and a timezone).`);
    else if (DATE_KEYS.has(key) && !RE.date.test(node)) err(`"${node}" is not a valid date.`);
    else if (URI_KEYS.has(key) && /\s/.test(node)) err(`"${node}" is not a valid uri (contains whitespace).`);
    else if ((key === "code" || key === "valueCode") && !RE.code.test(node)) err(`"${node}" is not a valid code (leading/trailing/double whitespace).`);
    return;
  }
  if (typeof node === "number") { if (!Number.isFinite(node)) err("number is not finite."); return; }
  if (typeof node === "boolean") return;
  if (!isObj(node)) return err("unsupported JSON value.");
  if (Object.keys(node).length === 0) return err("empty objects are not allowed in FHIR JSON.");

  if (typeof node.reference === "string" && !RE.ref.test(node.reference)) err(`"${node.reference}" is not a valid reference.`, `${path}.reference`);
  if (key === "extension" || key === "modifierExtension") {
    if (typeof node.url !== "string") err("extension without a url.");
    const values = Object.keys(node).filter((k) => /^value[A-Z]/.test(k));
    if (values.length > 1) err(`extension has more than one value[x]: ${values.join(", ")}.`);
    if (values.length === 1 && node.extension) err("extension has both a value[x] and nested extensions.");
    if (values.length === 0 && !node.extension) err("extension has neither a value[x] nor nested extensions.");
  }
  if (key === "text" && node.div !== undefined) {
    if (!["generated", "extensions", "additional", "empty"].includes(node.status)) err("Narrative.status is missing or invalid.", `${path}.status`);
    if (typeof node.div !== "string" || !node.div.startsWith('<div xmlns="http://www.w3.org/1999/xhtml"')) err("Narrative.div must be an XHTML <div xmlns=\"http://www.w3.org/1999/xhtml\">.", `${path}.div`);
  }
  if (/Quantity$/.test(key) && key !== "quantity" && typeof node.value !== "number") err("Quantity.value must be a number.", `${path}.value`);
  if (key === "coding") {
    if (node.system !== undefined && typeof node.system !== "string") err("Coding.system must be a uri.", `${path}.system`);
    if (node.code !== undefined && typeof node.code !== "string") err("Coding.code must be a string.", `${path}.code`);
  }
  if ((key === "period" || key === "executionPeriod") && node.start && node.end && RE.dateTime.test(node.start) && RE.dateTime.test(node.end) && Date.parse(node.end) < Date.parse(node.start)) {
    err("Period.end is before Period.start.");
  }
  for (const [k, v] of Object.entries(node)) checkNode(v, path ? `${path}.${k}` : k, k, issues);
}

/** Per-type rules and invariants. */
function checkTypeRules(r, issues) {
  const t = r.resourceType;
  const err = (message, path = t) => issues.push({ severity: "error", path, message });
  const warn = (message, path = t) => issues.push({ severity: "warning", path, message });
  const spec = R4_TYPES[t];

  for (const k of Object.keys(r)) {
    if (k === "resourceType") continue;
    if (!COMMON.includes(k) && !elementAllowed(spec, k)) warn(`"${k}" is not an element of ${t} in R4.`, `${t}.${k}`);
  }
  for (const k of spec.required) if (r[k] === undefined) err(`${t}.${k} is required (min 1).`, `${t}.${k}`);
  for (const k of spec.arrays) if (r[k] !== undefined && !Array.isArray(r[k])) err(`${t}.${k} must be an array.`, `${t}.${k}`);
  for (const [k, allowed] of Object.entries(spec.codes)) {
    if (r[k] !== undefined && !allowed.includes(r[k])) err(`${t}.${k} "${r[k]}" is not one of: ${allowed.join(", ")}.`, `${t}.${k}`);
  }
  if (r.id !== undefined && !RE.id.test(String(r.id))) err(`id "${r.id}" does not match [A-Za-z0-9\\-.]{1,64}.`, `${t}.id`);
  for (const [k] of Object.entries(r)) {
    const m = /^(value|effective|onset|abatement|start|occurrence|asNeeded|quantity|deceased|multipleBirth|occurred)[A-Z]/.exec(k);
    if (m) { const same = Object.keys(r).filter((x) => x.startsWith(m[1]) && /^[A-Z]/.test(x.slice(m[1].length))); if (same.length > 1) err(`${t} has more than one ${m[1]}[x]: ${same.join(", ")}.`, `${t}.${m[1]}[x]`); }
  }

  switch (t) {
    case "Bundle": {
      const entries = Array.isArray(r.entry) ? r.entry : [];
      const seen = new Set();
      entries.forEach((e, i) => {
        if (!isObj(e?.resource) && !e?.request && !e?.response) err("entry needs a resource, request or response.", `Bundle.entry[${i}]`);
        if (e?.fullUrl) { if (seen.has(e.fullUrl)) err(`fullUrl "${e.fullUrl}" appears twice (bdl-7).`, `Bundle.entry[${i}].fullUrl`); seen.add(e.fullUrl); }
        else if (["document", "collection", "searchset"].includes(r.type)) warn("entry has no fullUrl.", `Bundle.entry[${i}]`);
      });
      if (r.type === "document") {
        if (!r.identifier) err("a document Bundle needs an identifier (bdl-9).", "Bundle.identifier");
        if (!r.timestamp) err("a document Bundle needs a timestamp (bdl-10).", "Bundle.timestamp");
        if (entries[0]?.resource?.resourceType !== "Composition") err("the first entry of a document Bundle must be a Composition (bdl-11).", "Bundle.entry[0]");
      }
      break;
    }
    case "Composition": {
      (Array.isArray(r.section) ? r.section : []).forEach((s, i) => {
        const p = `Composition.section[${i}]`;
        if (isObj(s)) {
          if (!s.text && !(s.entry?.length) && !(s.section?.length)) err("a section needs text, entries or sub-sections (cmp-1).", p);
          if (s.emptyReason && s.entry?.length) err("a section with entries must not have an emptyReason (cmp-2).", p);
          if (s.mode !== undefined && !["working", "snapshot", "changes"].includes(s.mode)) err(`section.mode "${s.mode}" is invalid.`, `${p}.mode`);
        }
      });
      break;
    }
    case "Observation": {
      if (r.dataAbsentReason && Object.keys(r).some((k) => /^value[A-Z]/.test(k))) err("dataAbsentReason must not be present with a value (obs-6).", "Observation.dataAbsentReason");
      (r.component ?? []).forEach((c, i) => { if (isObj(c) && !c.code) err("component.code is required.", `Observation.component[${i}].code`); });
      break;
    }
    case "Goal": {
      (r.target ?? []).forEach((g, i) => { if (isObj(g) && Object.keys(g).some((k) => /^detail[A-Z]/.test(k)) && !g.measure) err("target.measure is required when a detail[x] is present (gol-1).", `Goal.target[${i}].measure`); });
      if (r.description && !r.description.text && !r.description.coding?.length) warn("description should have text or a coding.", "Goal.description");
      break;
    }
    case "CarePlan": {
      (r.activity ?? []).forEach((a, i) => { if (isObj(a) && a.reference && a.detail) err("activity has both reference and detail (cpl-3).", `CarePlan.activity[${i}]`); });
      break;
    }
    case "Condition": {
      (r.evidence ?? []).forEach((e, i) => { if (isObj(e) && !e.code && !e.detail) err("evidence needs code or detail (con-?).", `Condition.evidence[${i}]`); });
      break;
    }
    case "Provenance": {
      (r.agent ?? []).forEach((a, i) => { if (isObj(a) && !a.who) err("agent.who is required.", `Provenance.agent[${i}].who`); });
      (r.entity ?? []).forEach((e, i) => {
        if (!isObj(e)) return;
        if (!["derivation", "revision", "quotation", "source", "removal"].includes(e.role)) err(`entity.role "${e.role}" is invalid.`, `Provenance.entity[${i}].role`);
        if (!e.what) err("entity.what is required.", `Provenance.entity[${i}].what`);
      });
      break;
    }
    case "AuditEvent": {
      (r.agent ?? []).forEach((a, i) => { if (isObj(a) && typeof a.requestor !== "boolean") err("agent.requestor (boolean) is required.", `AuditEvent.agent[${i}].requestor`); });
      if (r.source && !r.source.observer) err("source.observer is required.", "AuditEvent.source.observer");
      break;
    }
    case "CareTeam": {
      (r.participant ?? []).forEach((p, i) => { if (isObj(p) && !p.member) warn("participant has no member.", `CareTeam.participant[${i}]`); });
      break;
    }
    case "Organization": {
      if (!r.identifier?.length && !r.name && !r.telecom?.length && !r.address?.length) err("an Organization needs an identifier, name, telecom or address (org-1).", "Organization");
      break;
    }
    case "OperationOutcome": {
      (r.issue ?? []).forEach((i, n) => {
        if (!isObj(i)) return;
        if (!["fatal", "error", "warning", "information"].includes(i.severity)) err(`issue.severity "${i.severity}" is invalid.`, `OperationOutcome.issue[${n}].severity`);
        if (!i.code) err("issue.code is required.", `OperationOutcome.issue[${n}].code`);
      });
      break;
    }
    default:
  }
}

/** Checks one resource (and, for a Bundle, every entry resource). Returns { errors, warnings } of { path, message }. */
export function checkR4(resource, { base } = {}) {
  const issues = [];
  const walk = (r, prefix) => {
    if (!isObj(r) || typeof r.resourceType !== "string") { issues.push({ severity: "error", path: prefix, message: "not a FHIR resource (no resourceType)." }); return; }
    if (!R4_TYPES[r.resourceType]) { issues.push({ severity: "warning", path: prefix, message: `${r.resourceType} is not checked by this facade's checker.` }); return; }
    const local = [];
    checkTypeRules(r, local);
    for (const [k, v] of Object.entries(r)) {
      if (k === "resourceType") continue;
      // A Bundle's entry resources are checked once, by walk() below, not twice.
      if (r.resourceType === "Bundle" && k === "entry" && Array.isArray(v) && v.length) {
        checkNode(v.map((e) => { const { resource: _r, ...rest } = e ?? {}; return Object.keys(rest).length ? rest : { fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000000" }; }), k, k, local);
      } else checkNode(v, k, k, local);
    }
    if (base) local.push(...checkProfiles(base, r));
    for (const i of local) issues.push({ ...i, path: prefix ? `${prefix}.${i.path}` : i.path });
    if (r.resourceType === "Bundle") (r.entry ?? []).forEach((e, i) => { if (isObj(e?.resource)) walk(e.resource, `${prefix ? prefix + "." : ""}Bundle.entry[${i}].resource`); });
  };
  walk(resource, "");
  return { errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

export const r4Outcome = (result) => ({
  resourceType: "OperationOutcome",
  issue: [
    ...result.errors.map((i) => ({ severity: "error", code: "structure", diagnostics: i.message, expression: [i.path] })),
    ...result.warnings.map((i) => ({ severity: "warning", code: "informational", diagnostics: i.message, expression: [i.path] })),
    ...(result.errors.length === 0 ? [{ severity: "information", code: "informational", diagnostics: `No R4 structural errors found${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ""}. This is a structural check, not the HL7 FHIR Validator.` }] : []),
  ],
});

/** POST /fhir/$validate: one `resource` parameter; returns an OperationOutcome (200). */
export function evaluateValidate(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const docs = readParams(body).all("resource").filter(isObj);
  if (docs.length !== 1) return fail(["Supply exactly one 'resource' parameter: the resource to check."]);
  return { ok: true, status: 200, body: r4Outcome(checkR4(docs[0], { base: ctx.base })) };
}

export const GOVERNANCE_OPERATIONS = {
  "$validate/undefined": evaluateValidate,
  "ConceptMap/$translate": evaluateTranslate,
};
export const governanceOperationFor = (param, action) => GOVERNANCE_OPERATIONS[`${param}/${action}`] ?? null;
