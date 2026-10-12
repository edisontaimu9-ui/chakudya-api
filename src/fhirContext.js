// FHIR R4 facade: professional and institutional context (NCP step 6).
//
//   POST /fhir/Bundle/$care-context
//
// Shapes the people and the place behind a nutrition note into linked FHIR
// resources, so the ADIME document says who did the work and where:
//
//   * Organization       the facility (and its departments, via `partOf`);
//   * Practitioner       the clinician: name, registration number, qualifications;
//   * PractitionerRole   that clinician's role (dietitian, nurse, ...), specialty
//                        and period at one organization;
//   * CareTeam           the multidisciplinary team around the patient, each
//                        member a PractitionerRole (or a Practitioner with a role).
//
// Parts refer to each other by a short local `id` you choose ("hosp", "dr1",
// "rd1"); the Bundle comes back with urn:uuid fullUrls and real references.
// A reference to a resource your own system already holds ("Practitioner/123")
// can be used instead of a local id anywhere a link is expected.
//
// Pass the Bundle to $ncp-document as a `resource`: the author is resolved to
// the PractitionerRole, the facility becomes Composition.custodian and the
// CareTeam is linked from the CarePlan (see src/fhirDocument.js).
//
// STATELESS and pure, like the rest of the facade. Chakudya shapes what the
// caller supplies. It does not look anyone up, verify a registration or
// licence number, or decide who belongs on a team. Nothing is stored.

import { readParams, requireParameters } from "./fhirNcp.js";

const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const cs = (base, name) => `${base}/fhir/CodeSystem/${name}`;
const newUuid = (ctx) => `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;

const LOCAL_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const REF = /^(https?:\/\/\S+\/)?[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;
const ORG_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/organization-type";
const ORG_TYPES = {
  prov: "Healthcare Provider", dept: "Hospital Department", team: "Organizational team", govt: "Government",
  ins: "Insurance Company", pay: "Payer", edu: "Educational Institute", reli: "Religious Institution",
  crs: "Clinical Research Sponsor", cg: "Community Group", bus: "Non-Healthcare Business or Corporation", other: "Other",
};
const TEAM_STATUS = new Set(["proposed", "active", "suspended", "inactive", "entered-in-error"]);

export const CARE_ROLES = {
  dietitian: "Dietitian",
  nutritionist: "Nutritionist",
  "nutrition-assistant": "Nutrition assistant",
  physician: "Physician",
  "clinical-officer": "Clinical officer",
  nurse: "Nurse",
  pharmacist: "Pharmacist",
  "speech-language-therapist": "Speech and language therapist",
  physiotherapist: "Physiotherapist",
  "occupational-therapist": "Occupational therapist",
  psychologist: "Psychologist",
  "social-worker": "Social worker",
  "diabetes-educator": "Diabetes educator",
  "community-health-worker": "Community health worker",
  other: "Other team role",
};

const fail = (issues, status = 400) => ({
  ok: false,
  status,
  outcome: { resourceType: "OperationOutcome", issue: issues.map((diagnostics) => ({ severity: "error", code: "invalid", diagnostics })) },
});

const validDate = (s) => typeof s === "string" && DATE.test(s) && !isNaN(Date.parse(s));

export function evaluateCareContext(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;
  const errors = [];
  const bad = (m) => errors.push(m);
  const notes = [];

  const orgParts = p.all("organization");
  const prParts = p.all("practitioner");
  const roleParts = p.all("role");
  const teamParts = p.all("careTeam");
  if (orgParts.length + prParts.length + roleParts.length + teamParts.length === 0) {
    return fail(["Nothing to build. Supply at least one 'organization', 'practitioner', 'role' or 'careTeam' part."]);
  }
  if (orgParts.length > 20) bad("At most 20 organization parts.");
  if (prParts.length > 50) bad("At most 50 practitioner parts.");
  if (roleParts.length > 100) bad("At most 100 role parts.");
  if (teamParts.length > 5) bad("At most 5 careTeam parts.");

  const subject = str(p.get("subject"));
  const encounter = str(p.get("encounter"));
  if (subject && !REF.test(subject)) bad("'subject' must be a reference such as \"Patient/123\".");
  if (encounter && !REF.test(encounter)) bad("'encounter' must be a reference such as \"Encounter/456\".");
  if (teamParts.length && !subject) bad("'subject' (the patient, e.g. \"Patient/123\") is required with a careTeam.");

  // ── local ids ────────────────────────────────────────────────────────────
  const local = { organization: new Map(), practitioner: new Map(), role: new Map() };
  const register = (kind, parts) => {
    parts.forEach((pt, i) => {
      const id = str(pt.get("id"));
      const fullUrl = newUuid(ctx);
      if (id) {
        if (!LOCAL_ID.test(id)) bad(`${kind}[${i}]: id "${id}" must be 1-40 letters, digits, "_", "." or "-".`);
        else if (local[kind].has(id)) bad(`${kind}: id "${id}" is used twice.`);
        else local[kind].set(id, fullUrl);
      } // ids are optional; an unnamed resource simply cannot be referred to
      pt.__url = fullUrl;
      pt.__label = `${kind}${id ? ` "${id}"` : `[${i}]`}`;
    });
  };
  register("organization", orgParts);
  register("practitioner", prParts);
  register("role", roleParts);

  /** A local id (of `kind`) or an external reference -> { reference } | null (error recorded). */
  const link = (kind, value, where) => {
    const v = str(value);
    if (!v) return null;
    if (local[kind].has(v)) return { reference: local[kind].get(v) };
    if (REF.test(v)) return { reference: v };
    bad(`${where}: "${v}" is neither a ${kind} id in this request nor a reference such as "${kind === "role" ? "PractitionerRole" : kind === "practitioner" ? "Practitioner" : "Organization"}/123".`);
    return null;
  };

  const identifier = (pt, where) => {
    const value = str(pt.get("identifier"));
    const system = str(pt.get("identifierSystem"));
    if (system && !value) bad(`${where}: identifierSystem needs an identifier.`);
    return value ? [{ ...(system ? { system } : {}), value }] : undefined;
  };
  const telecom = (pt, where) => {
    const out = [];
    const phone = str(pt.get("phone"));
    const email = str(pt.get("email"));
    if (phone) out.push({ system: "phone", value: phone.slice(0, 40) });
    if (email) { if (EMAIL.test(email)) out.push({ system: "email", value: email }); else bad(`${where}: email "${email}" is not a valid address.`); }
    return out.length ? out : undefined;
  };
  const period = (pt, where) => {
    const start = str(pt.get("periodStart"));
    const end = str(pt.get("periodEnd"));
    for (const [k, v] of [["periodStart", start], ["periodEnd", end]]) if (v && !validDate(v)) bad(`${where}: ${k} "${v}" is not a valid FHIR date or dateTime.`);
    if (start && end && validDate(start) && validDate(end) && Date.parse(end) < Date.parse(start)) bad(`${where}: periodEnd is before periodStart.`);
    return start || end ? { ...(start ? { start } : {}), ...(end ? { end } : {}) } : undefined;
  };
  const roleCoding = (value, where) => {
    const v = str(value);
    if (!v) return null;
    const key = v.toLowerCase();
    if (CARE_ROLES[key]) return { coding: [{ system: cs(base, "ncp-care-role"), code: key, display: CARE_ROLES[key] }], text: CARE_ROLES[key] };
    return { text: v.slice(0, 100) }; // not in the list: kept as text, never guessed into a code
  };

  const entries = [];

  // ── Organizations ────────────────────────────────────────────────────────
  orgParts.forEach((pt) => {
    const where = pt.__label;
    const name = str(pt.get("name"));
    const ident = identifier(pt, where);
    if (!name && !ident) bad(`${where}: a name or an identifier is required.`);
    const type = str(pt.get("type"));
    const org = { resourceType: "Organization", active: true };
    if (ident) org.identifier = ident;
    if (type) {
      const k = type.toLowerCase();
      org.type = [ORG_TYPES[k] ? { coding: [{ system: ORG_TYPE_SYSTEM, code: k, display: ORG_TYPES[k] }], text: ORG_TYPES[k] } : { text: type.slice(0, 100) }];
    }
    if (name) org.name = name.slice(0, 200);
    const t = telecom(pt, where);
    if (t) org.telecom = t;
    const addr = { text: str(pt.get("address")), city: str(pt.get("city")), district: str(pt.get("district")), country: str(pt.get("country")) };
    if (Object.values(addr).some(Boolean)) org.address = [Object.fromEntries(Object.entries(addr).filter(([, v]) => v))];
    const partOf = str(pt.get("partOf"));
    if (partOf) {
      if (pt.get("id") && partOf === pt.get("id")) bad(`${where}: an organization cannot be part of itself.`);
      const l = link("organization", partOf, `${where} partOf`);
      if (l) org.partOf = l;
    }
    entries.push({ fullUrl: pt.__url, resource: org, pt });
  });
  // partOf cycles (a -> b -> a)
  const orgByUrl = new Map(entries.filter((x) => x.resource.resourceType === "Organization").map((x) => [x.fullUrl, x.resource]));
  for (const [url, org] of orgByUrl) {
    const seen = new Set([url]);
    for (let cur = org.partOf?.reference; cur && orgByUrl.has(cur); cur = orgByUrl.get(cur).partOf?.reference) {
      if (seen.has(cur)) { bad("Organizations are part of each other in a loop (partOf)."); break; }
      seen.add(cur);
    }
  }

  // ── Practitioners ────────────────────────────────────────────────────────
  prParts.forEach((pt) => {
    const where = pt.__label;
    const name = str(pt.get("name"));
    const family = str(pt.get("family"));
    const given = pt.all("given").map(str).filter(Boolean);
    const ident = identifier(pt, where);
    if (!name && !family && !ident) bad(`${where}: a name (or family name) or an identifier is required.`);
    const r = { resourceType: "Practitioner", active: true };
    if (ident) r.identifier = ident;
    if (name || family) {
      const tokens = (name ?? "").split(/\s+/).filter(Boolean);
      const n = family
        ? { family, ...(given.length ? { given } : {}), text: name ?? [...given, family].join(" ") }
        : tokens.length >= 2 ? { family: tokens[tokens.length - 1], given: tokens.slice(0, -1), text: name } : { text: name };
      r.name = [n];
    }
    const t = telecom(pt, where);
    if (t) r.telecom = t;
    const quals = pt.all("qualification").map((q, i) => {
      const w = `${where} qualification[${i}]`;
      const code = str(q.get("code"));
      if (!code) { bad(`${w}: 'code' is required (e.g. "Registered Dietitian").`); return null; }
      const qi = identifier(q, w);
      const issuerRaw = str(q.get("issuer"));
      const issuer = issuerRaw ? (local.organization.has(issuerRaw) || REF.test(issuerRaw) ? link("organization", issuerRaw, `${w} issuer`) : { display: issuerRaw.slice(0, 200) }) : null;
      const qp = period(q, w);
      return { ...(qi ? { identifier: qi } : {}), code: { text: code.slice(0, 100) }, ...(qp ? { period: qp } : {}), ...(issuer ? { issuer } : {}) };
    }).filter(Boolean);
    if (quals.length) r.qualification = quals;
    entries.push({ fullUrl: pt.__url, resource: r, pt });
  });

  // ── PractitionerRoles ────────────────────────────────────────────────────
  const roleInfo = new Map(); // fullUrl -> { code, practitioner }
  roleParts.forEach((pt) => {
    const where = pt.__label;
    const pr = link("practitioner", pt.get("practitioner"), `${where} practitioner`);
    if (!pr && !str(pt.get("practitioner"))) bad(`${where}: 'practitioner' is required (a practitioner id or "Practitioner/123").`);
    const org = link("organization", pt.get("organization"), `${where} organization`);
    if (!org && !str(pt.get("organization"))) notes.push(`${where}: no organization, so the facility cannot be shown for this role.`);
    const code = roleCoding(pt.get("role"), where);
    if (!str(pt.get("role"))) bad(`${where}: 'role' is required (e.g. "dietitian").`);
    const r = { resourceType: "PractitionerRole", active: true };
    const ident = identifier(pt, where);
    if (ident) r.identifier = ident;
    const per = period(pt, where);
    if (per) r.period = per;
    if (pr) r.practitioner = pr;
    if (org) r.organization = org;
    if (code) r.code = [code];
    const specialty = str(pt.get("specialty"));
    if (specialty) r.specialty = [{ text: specialty.slice(0, 100) }];
    const loc = str(pt.get("location"));
    if (loc) r.location = [{ display: loc.slice(0, 200) }];
    const t = telecom(pt, where);
    if (t) r.telecom = t;
    roleInfo.set(pt.__url, { code, practitioner: pr });
    entries.push({ fullUrl: pt.__url, resource: r, pt });
  });

  // ── CareTeams ────────────────────────────────────────────────────────────
  const disciplines = [];
  teamParts.forEach((pt, ti) => {
    const where = `careTeam[${ti}]`;
    const status = str(pt.get("status")) ?? "active";
    if (!TEAM_STATUS.has(status)) bad(`${where}: status must be one of ${[...TEAM_STATUS].join(", ")}.`);
    const team = { resourceType: "CareTeam", meta: { profile: [`${base}/fhir/StructureDefinition/ncp-care-team`] }, status, category: [{ text: "Nutrition care team" }] };
    const name = str(pt.get("name"));
    if (name) team.name = name.slice(0, 200);
    if (subject) team.subject = { reference: subject };
    if (encounter) team.encounter = { reference: encounter };
    const per = period(pt, where);
    if (per) team.period = per;
    const reason = str(pt.get("reason"));
    if (reason) team.reasonCode = [{ text: reason.slice(0, 200) }];
    const mo = link("organization", pt.get("managingOrganization"), `${where} managingOrganization`);
    if (mo) team.managingOrganization = [mo];
    const members = pt.all("member");
    if (members.length === 0) bad(`${where}: at least one 'member' is required.`);
    if (members.length > 50) bad(`${where}: at most 50 members.`);
    const seen = new Set();
    team.participant = members.map((m, mi) => {
      const w = `${where} member[${mi}]`;
      const roleRaw = str(m.get("role"));
      const prRaw = str(m.get("practitioner"));
      if ((roleRaw ? 1 : 0) + (prRaw ? 1 : 0) !== 1) { bad(`${w}: give exactly one of 'role' (a PractitionerRole) or 'practitioner'.`); return null; }
      const member = roleRaw ? link("role", roleRaw, `${w} role`) : link("practitioner", prRaw, `${w} practitioner`);
      if (!member) return null;
      if (seen.has(member.reference)) bad(`${w}: the same member is listed twice.`);
      seen.add(member.reference);
      let roleCode = null;
      if (roleRaw) roleCode = roleInfo.get(member.reference)?.code ?? null;
      else if (str(m.get("memberRole"))) roleCode = roleCoding(m.get("memberRole"), w);
      else notes.push(`${w}: a practitioner without 'memberRole' has no role in the team.`);
      disciplines.push(roleCode?.coding?.[0]?.code ?? roleCode?.text ?? "unknown");
      const onBehalf = link("organization", m.get("onBehalfOf"), `${w} onBehalfOf`);
      const mp = period(m, w);
      return { ...(roleCode ? { role: [roleCode] } : {}), member, ...(onBehalf ? { onBehalfOf: onBehalf } : {}), ...(mp ? { period: mp } : {}) };
    }).filter(Boolean);
    entries.push({ fullUrl: newUuid(ctx), resource: team, pt });
  });
  if (teamParts.length && new Set(disciplines.filter((d) => d !== "unknown")).size < 2) {
    notes.push("The care team lists members of fewer than two disciplines; a multidisciplinary team normally has at least two.");
  }

  if (errors.length) return fail(errors);

  const out = entries.map(({ fullUrl, resource }) => ({ fullUrl, resource }));
  if (notes.length) {
    out.push({ fullUrl: newUuid(ctx), resource: { resourceType: "OperationOutcome", issue: notes.map((diagnostics) => ({ severity: "information", code: "informational", diagnostics })) } });
  }
  return { ok: true, status: 200, body: { resourceType: "Bundle", type: "collection", timestamp: ctx.now, entry: out } };
}

export const CONTEXT_OPERATIONS = { "Bundle/$care-context": evaluateCareContext };
export const contextOperationFor = (param, action) => CONTEXT_OPERATIONS[`${param}/${action}`] ?? null;
