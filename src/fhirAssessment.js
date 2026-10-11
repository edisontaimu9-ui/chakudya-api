// FHIR R4 facade — Nutrition assessment foundation (NCP Step 1).
//
//   POST /fhir/Bundle/$nutrition-assessment       Patient + Encounter +
//        Observations (anthropometry, biochemical, clinical, dietary, NFPE) +
//        QuestionnaireResponses -> one structured, linked assessment Bundle
//   POST /fhir/QuestionnaireResponse/$validate    check a QuestionnaireResponse
//        against a built-in Questionnaire, without building anything
//   GET  /fhir/Questionnaire[/{id}]               the built-in forms
//
// Same contract as the rest of the facade (src/fhir.js, src/fhirNcp.js):
// STATELESS and pure. Nothing is stored or logged; the caller's EHR persists
// the returned resources. Patient and Encounter are validated and shaped, not
// registered — the EHR owns patient identity.
//
// How things are linked. Every resource this operation creates gets a
// urn:uuid fullUrl, and Observations / QuestionnaireResponses point at the
// Patient and Encounter by that urn:uuid (the usual transaction-Bundle
// pattern; the EHR rewrites them on POST). If the patient or encounter is
// already registered, pass a reference string instead of a resource
// ("Patient/123", "Encounter/456"): no Patient/Encounter entry is emitted
// and everything points at that reference.
//
// What is and isn't "clinical judgement" here. Chakudya validates the
// plausibility of what was typed and shapes it into FHIR. It computes only
// deterministic things: unit conversion, BMI, WHO adult BMI class, an
// interpretation flag when the caller supplies the lab's own reference range,
// and the MUST score when the screening form is submitted. It never guesses a
// unit, never invents a reference range, and never grades an NFPE finding.
// The plausibility limits below are data-entry sanity limits (is this value
// possible for a person?), not clinical reference ranges.

import {
  readParams, requireParameters, stepCategory, whoAdultBmiClass, ASSESSMENT_DOMAINS,
  evaluateScreen, SCREENING_NOTE,
} from "./fhirNcp.js";

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
const V3_INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
const DAR_SYSTEM = "http://terminology.hl7.org/CodeSystem/data-absent-reason";
const ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const Q_UNIT_OPTION = "http://hl7.org/fhir/StructureDefinition/questionnaire-unitOption";
const Q_MIN = "http://hl7.org/fhir/StructureDefinition/minValue";
const Q_MAX = "http://hl7.org/fhir/StructureDefinition/maxValue";

const cs = (base, name) => `${base}/fhir/CodeSystem/${name}`;
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// ─── Issues (several problems reported at once) ────────────────────────────

function makeIssues() {
  const list = [];
  const add = (severity, code, diagnostics, expression) =>
    list.push({ severity, code, diagnostics, ...(expression ? { expression: [expression] } : {}) });
  return {
    list,
    error: (code, d, e) => add("error", code, d, e),
    warn: (code, d, e) => add("warning", code, d, e),
    info: (d, e) => add("information", "informational", d, e),
    get hasError() { return list.some((i) => i.severity === "error"); },
  };
}
const outcomeOf = (list) => ({ resourceType: "OperationOutcome", issue: list });

// ─── Timestamps ────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const FHIR_TIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

/** FHIR date / dateTime -> { ms, precision, year, month, day } or null.
 * A time-of-day needs a timezone (FHIR rule); calendar fields are checked. */
export function parseFhirTime(s) {
  if (typeof s !== "string") return null;
  const m = FHIR_TIME.exec(s);
  if (!m) return null;
  const year = +m[1];
  const month = m[2] ? +m[2] : 1;
  const day = m[3] ? +m[3] : 1;
  if (year < 1800 || month < 1 || month > 12) return null;
  const dim = month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > dim) return null;
  let precision = m[2] ? (m[3] ? (m[4] !== undefined ? "instant" : "day") : "month") : "year";
  let ms = Date.UTC(year, month - 1, day);
  if (m[4] !== undefined) {
    const hh = +m[4], mi = +m[5], ss = +m[6];
    if (hh > 23 || mi > 59 || ss > 59) return null;
    let offset = 0;
    if (m[7] !== "Z") {
      const th = +m[7].slice(1, 3), tm = +m[7].slice(4, 6);
      if (th > 14 || tm > 59) return null;
      offset = (m[7][0] === "-" ? -1 : 1) * (th * 60 + tm) * 60000;
    }
    ms = Date.UTC(year, month - 1, day, hh, mi, ss) - offset;
  }
  return { ms, precision, year, month, day };
}

const isFutureTime = (t, nowMs) =>
  t.ms > nowMs + (t.precision === "instant" ? 5 * 60000 : 24 * 3600000);

function ageYearsAt(birth, atMs) {
  const a = new Date(atMs);
  let years = a.getUTCFullYear() - birth.year;
  const m = a.getUTCMonth() + 1 - birth.month;
  if (m < 0 || (m === 0 && a.getUTCDate() < birth.day)) years -= 1;
  return years;
}

// ─── Units ─────────────────────────────────────────────────────────────────

// Lower-cased spelling -> UCUM code. Anything not listed is "not recognised":
// units are never guessed.
const UNIT_SYNONYMS = {
  kg: "kg", g: "g", lb: "[lb_av]", lbs: "[lb_av]", "[lb_av]": "[lb_av]",
  cm: "cm", m: "m", mm: "mm", in: "[in_i]", "[in_i]": "[in_i]",
  "g/dl": "g/dL", "g/l": "g/L", "mg/dl": "mg/dL", "mg/l": "mg/L", "mmol/l": "mmol/L",
  "umol/l": "umol/L", "µmol/l": "umol/L", "ng/ml": "ng/mL", "ug/l": "ug/L", "µg/l": "ug/L",
  "pg/ml": "pg/mL", "pmol/l": "pmol/L", "nmol/l": "nmol/L", "meq/l": "meq/L", "u/l": "U/L",
  "%": "%", mmhg: "mm[Hg]", "mm[hg]": "mm[Hg]", "/min": "/min", bpm: "/min", "beats/min": "/min",
  cel: "Cel", "°c": "Cel", "[degf]": "[degF]", "°f": "[degF]",
  "kcal/d": "kcal/d", "kcal/day": "kcal/d", "g/d": "g/d", "g/day": "g/d",
  "ml/d": "mL/d", "ml/day": "mL/d", "l/d": "L/d", "l/day": "L/d",
};
const UNIT_DISPLAY = { "[lb_av]": "lb", "[in_i]": "in", "mm[Hg]": "mmHg", Cel: "°C", "[degF]": "°F" };
const unitLabel = (code) => UNIT_DISPLAY[code] ?? code;

/** UCUM code of a Quantity's unit, or null when absent / not recognised. */
function unitOf(q) {
  if (!isObj(q)) return null;
  if (q.system && q.system !== UCUM) return null;
  const raw = q.code || q.unit;
  return typeof raw === "string" ? UNIT_SYNONYMS[raw.trim().toLowerCase()] ?? null : null;
}

// ─── Measurement registry ──────────────────────────────────────────────────
//
// One entry per measurement the operation understands. `units` maps each
// accepted unit to its factor into the FIRST (canonical) unit. `min`/`max`
// are plausibility limits in the canonical unit. `normalise: true` means the
// emitted Observation is converted to the canonical unit (anthropometry, so
// BMI and the other operations see kg / cm); everything else keeps the unit
// the lab or clinician reported. Items without a LOINC code live in the
// `assessment-item` CodeSystem served by this API.

const AREAS = {
  anthropometry: { domain: "AD", cat: "exam" },
  biochemical: { domain: "BD", cat: "laboratory" },
  clinical: { domain: "PD", cat: "exam" },
  dietary: { domain: "FH", cat: "survey" },
  nfpe: { domain: "PD", cat: "exam" },
};
export const ASSESSMENT_AREAS = Object.keys(AREAS);

const LEN_CM = { cm: 1, m: 100, "[in_i]": 2.54 };
const GDL = { "g/dL": 1, "g/L": 0.1 };
const MGDL = (mmolFactor) => ({ "mg/dL": 1, "mmol/L": mmolFactor });

export const NFPE_SEVERITY = [
  { code: "normal", display: "Normal", definition: "No loss or deficit found at this site." },
  { code: "mild", display: "Mild", definition: "Mild loss or deficit, as judged by the examiner." },
  { code: "moderate", display: "Moderate", definition: "Moderate loss or deficit, as judged by the examiner." },
  { code: "severe", display: "Severe", definition: "Severe loss or deficit, as judged by the examiner." },
];
export const APPETITE_LEVELS = [
  { code: "good", display: "Good" },
  { code: "fair", display: "Fair" },
  { code: "poor", display: "Poor" },
  { code: "none", display: "No appetite" },
];

const severity = (display) => ({ area: "nfpe", cat: "exam", display, kind: "coded", codeSystem: "nfpe-severity", options: NFPE_SEVERITY });
const sign = (display) => ({ area: "nfpe", cat: "exam", display, kind: "boolean" });
const symptom = (display) => ({ area: "clinical", cat: "exam", display, kind: "boolean" });
const intake = (display, unit, max) => ({ area: "dietary", cat: "survey", display, kind: "quantity", units: { [unit]: 1 }, min: 0, max });

export const ITEMS = {
  // Anthropometry (NCP domain AD)
  weight: { area: "anthropometry", cat: "vital-signs", loinc: "29463-7", display: "Body weight", kind: "quantity", units: { kg: 1, g: 0.001, "[lb_av]": 0.45359237 }, min: 0.2, max: 500, normalise: true },
  height: { area: "anthropometry", cat: "vital-signs", loinc: "8302-2", display: "Body height", kind: "quantity", units: LEN_CM, min: 20, max: 272, normalise: true },
  length: { area: "anthropometry", cat: "vital-signs", loinc: "8306-3", display: "Body height --lying", kind: "quantity", units: LEN_CM, min: 20, max: 130, normalise: true },
  hc: { area: "anthropometry", cat: "vital-signs", loinc: "9843-4", display: "Head Occipital-frontal circumference", kind: "quantity", units: { cm: 1, mm: 0.1, "[in_i]": 2.54 }, min: 15, max: 80, normalise: true },
  muac: { area: "anthropometry", cat: "exam", loinc: "56072-2", display: "Mid upper arm circumference", kind: "quantity", units: { cm: 1, mm: 0.1 }, min: 2, max: 70, normalise: true },
  "weight-change-percent": { area: "anthropometry", cat: "exam", display: "Weight change from usual weight (% ; positive = loss)", kind: "quantity", units: { "%": 1 }, min: -100, max: 100 },
  waist: { area: "anthropometry", cat: "vital-signs", loinc: "8280-0", display: "Waist Circumference at umbilicus by Tape measure", kind: "quantity", units: LEN_CM, min: 20, max: 300, normalise: true },

  // Biochemical data (BD). Values keep the reported unit; factors are only for the plausibility check.
  hemoglobin: { area: "biochemical", cat: "laboratory", loinc: "718-7", display: "Hemoglobin [Mass/volume] in Blood", kind: "quantity", units: GDL, min: 1, max: 30 },
  hematocrit: { area: "biochemical", cat: "laboratory", loinc: "4544-3", display: "Hematocrit [Volume Fraction] of Blood by Automated count", kind: "quantity", units: { "%": 1 }, min: 5, max: 80 },
  albumin: { area: "biochemical", cat: "laboratory", loinc: "1751-7", display: "Albumin [Mass/volume] in Serum or Plasma", kind: "quantity", units: GDL, min: 0.5, max: 8 },
  "total-protein": { area: "biochemical", cat: "laboratory", loinc: "2885-2", display: "Protein [Mass/volume] in Serum or Plasma", kind: "quantity", units: GDL, min: 1, max: 15 },
  glucose: { area: "biochemical", cat: "laboratory", loinc: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma", kind: "quantity", units: MGDL(18.016), min: 5, max: 2000 },
  "glucose-fasting": { area: "biochemical", cat: "laboratory", loinc: "1558-6", display: "Fasting glucose [Mass/volume] in Serum or Plasma", kind: "quantity", units: MGDL(18.016), min: 5, max: 2000 },
  hba1c: { area: "biochemical", cat: "laboratory", loinc: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood", kind: "quantity", units: { "%": 1 }, min: 2, max: 25 },
  creatinine: { area: "biochemical", cat: "laboratory", loinc: "2160-0", display: "Creatinine [Mass/volume] in Serum or Plasma", kind: "quantity", units: { "mg/dL": 1, "umol/L": 0.011312 }, min: 0.05, max: 30 },
  sodium: { area: "biochemical", cat: "laboratory", loinc: "2951-2", display: "Sodium [Moles/volume] in Serum or Plasma", kind: "quantity", units: { "mmol/L": 1, "meq/L": 1 }, min: 80, max: 200 },
  potassium: { area: "biochemical", cat: "laboratory", loinc: "2823-3", display: "Potassium [Moles/volume] in Serum or Plasma", kind: "quantity", units: { "mmol/L": 1, "meq/L": 1 }, min: 1, max: 12 },
  ferritin: { area: "biochemical", cat: "laboratory", loinc: "2276-4", display: "Ferritin [Mass/volume] in Serum or Plasma", kind: "quantity", units: { "ng/mL": 1, "ug/L": 1 }, min: 0, max: 100000 },
  crp: { area: "biochemical", cat: "laboratory", loinc: "1988-5", display: "C reactive protein [Mass/volume] in Serum or Plasma", kind: "quantity", units: { "mg/L": 1, "mg/dL": 10 }, min: 0, max: 1000 },
  "cholesterol-total": { area: "biochemical", cat: "laboratory", loinc: "2093-3", display: "Cholesterol [Mass/volume] in Serum or Plasma", kind: "quantity", units: MGDL(38.67), min: 10, max: 1500 },
  ldl: { area: "biochemical", cat: "laboratory", loinc: "13457-7", display: "Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation", kind: "quantity", units: MGDL(38.67), min: 1, max: 1000 },
  hdl: { area: "biochemical", cat: "laboratory", loinc: "2085-9", display: "Cholesterol in HDL [Mass/volume] in Serum or Plasma", kind: "quantity", units: MGDL(38.67), min: 1, max: 300 },
  triglycerides: { area: "biochemical", cat: "laboratory", loinc: "2571-8", display: "Triglyceride [Mass/volume] in Serum or Plasma", kind: "quantity", units: MGDL(88.57), min: 5, max: 10000 },
  "vitamin-b12": { area: "biochemical", cat: "laboratory", loinc: "2132-9", display: "Cobalamin (Vitamin B12) [Mass/volume] in Serum or Plasma", kind: "quantity", units: { "pg/mL": 1, "pmol/L": 1.355 }, min: 10, max: 10000 },
  folate: { area: "biochemical", cat: "laboratory", loinc: "2284-8", display: "Folate [Mass/volume] in Serum", kind: "quantity", units: { "ng/mL": 1, "nmol/L": 0.4413 }, min: 0.1, max: 1000 },

  // Clinical findings: vital signs and nutrition-impact symptoms (NCP domain PD)
  "systolic-bp": { area: "clinical", cat: "vital-signs", loinc: "8480-6", display: "Systolic blood pressure", kind: "quantity", units: { "mm[Hg]": 1 }, min: 30, max: 300 },
  "diastolic-bp": { area: "clinical", cat: "vital-signs", loinc: "8462-4", display: "Diastolic blood pressure", kind: "quantity", units: { "mm[Hg]": 1 }, min: 10, max: 200 },
  "heart-rate": { area: "clinical", cat: "vital-signs", loinc: "8867-4", display: "Heart rate", kind: "quantity", units: { "/min": 1 }, min: 10, max: 300 },
  "respiratory-rate": { area: "clinical", cat: "vital-signs", loinc: "9279-1", display: "Respiratory rate", kind: "quantity", units: { "/min": 1 }, min: 2, max: 100 },
  temperature: { area: "clinical", cat: "vital-signs", loinc: "8310-5", display: "Body temperature", kind: "quantity", units: { Cel: 1, "[degF]": 1 }, convert: (v, u) => (u === "[degF]" ? ((v - 32) * 5) / 9 : v), min: 25, max: 45 },
  spo2: { area: "clinical", cat: "vital-signs", loinc: "59408-5", display: "Oxygen saturation in Arterial blood by Pulse oximetry", kind: "quantity", units: { "%": 1 }, min: 30, max: 100 },
  nausea: symptom("Nausea"),
  vomiting: symptom("Vomiting"),
  diarrhoea: symptom("Diarrhoea"),
  constipation: symptom("Constipation"),
  dysphagia: symptom("Difficulty swallowing"),

  // Dietary intake (food/nutrition-related history, FH): a summary of one recall or usual day
  "energy-intake-kcal": intake("Energy intake", "kcal/d", 20000),
  "protein-intake-g": intake("Protein intake", "g/d", 1000),
  "fat-intake-g": intake("Fat intake", "g/d", 1000),
  "carbohydrate-intake-g": intake("Carbohydrate intake", "g/d", 3000),
  "fluid-intake": { area: "dietary", cat: "survey", display: "Fluid intake", kind: "quantity", units: { "mL/d": 1, "L/d": 1000 }, min: 0, max: 20000 },
  "intake-percent-of-requirement": { area: "dietary", cat: "survey", display: "Intake as % of estimated requirement", kind: "quantity", units: { "%": 1 }, min: 0, max: 500 },
  "meals-per-day": { area: "dietary", cat: "survey", display: "Meals per day", kind: "integer", min: 0, max: 20 },
  "food-group-count": { area: "dietary", cat: "survey", display: "Number of food groups consumed", kind: "integer", min: 0, max: 20 },
  appetite: { area: "dietary", cat: "survey", display: "Appetite", kind: "coded", codeSystem: "appetite-level", options: APPETITE_LEVELS },
  "dietary-notes": { area: "dietary", cat: "survey", display: "Dietary history notes", kind: "string" },

  // Nutrition-focused physical examination (NFPE, domain PD)
  "temple-muscle": severity("Temple (temporalis) muscle"),
  "clavicle-muscle": severity("Clavicle (pectoralis / deltoid) muscle"),
  "shoulder-muscle": severity("Shoulder (deltoid) muscle"),
  "scapula-muscle": severity("Scapula (trapezius / supraspinatus / infraspinatus) muscle"),
  "interosseous-muscle": severity("Interosseous muscle (back of hand)"),
  "thigh-muscle": severity("Thigh (quadriceps) muscle"),
  "calf-muscle": severity("Calf (gastrocnemius) muscle"),
  "orbital-fat": severity("Orbital fat pads"),
  "triceps-fat": severity("Triceps / upper arm fat"),
  "rib-fat": severity("Ribs / thoracic fat"),
  oedema: { area: "nfpe", cat: "exam", display: "Pitting oedema grade (0-3)", kind: "integer", min: 0, max: 3 },
  ascites: sign("Ascites"),
  pallor: sign("Pallor"),
  "angular-stomatitis": sign("Angular stomatitis"),
  glossitis: sign("Glossitis"),
  "bitot-spots": sign("Bitot's spots"),
  "hair-changes": sign("Hair changes"),
  "skin-changes": sign("Skin changes"),
  goitre: sign("Goitre"),
};

const AREA_TITLES = {
  anthropometry: "Anthropometry", biochemical: "Biochemical", clinical: "Clinical finding",
  dietary: "Dietary intake", nfpe: "Nutrition-focused physical finding",
};

/** Registry items that have no LOINC code: the `assessment-item` CodeSystem. */
export const ASSESSMENT_ITEM_CONCEPTS = Object.entries(ITEMS)
  .filter(([, d]) => !d.loinc)
  .map(([code, d]) => ({ code, display: d.display, definition: `${AREA_TITLES[d.area]} item.` }));

const DAR_CODES = ["unknown", "asked-unknown", "not-asked", "asked-declined", "not-performed", "not-applicable"];
const INTERPRETATION_CODES = ["N", "L", "H", "LL", "HH", "A", "AA"];
const MAX_OBSERVATIONS = 100;
const MAX_QUESTIONNAIRE_RESPONSES = 10;

const itemKeysText = () => Object.keys(ITEMS).join(", ");
const acceptedUnits = (def) => Object.keys(def.units).map(unitLabel).join(", ");

const codeOf = (raw) => {
  if (typeof raw === "string") return raw.trim();
  if (isObj(raw)) return typeof raw.code === "string" ? raw.code.trim() : typeof raw.coding?.[0]?.code === "string" ? raw.coding[0].code.trim() : undefined;
  return undefined;
};

// ─── References ────────────────────────────────────────────────────────────

const REF = {
  Patient: /^(https?:\/\/\S+\/)?Patient\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/,
  Encounter: /^(https?:\/\/\S+\/)?Encounter\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/,
};
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

function authorRef(value) {
  const s = str(value);
  if (!s) return null;
  return /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(s) || s.startsWith("urn:uuid:") ? { reference: s } : { display: s.slice(0, 200) };
}

function newUuid(ctx) {
  return `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;
}

// ─── Patient ───────────────────────────────────────────────────────────────

const PATIENT_DROPPED = ["telecom", "address", "contact", "photo", "maritalStatus", "communication", "generalPractitioner",
  "managingOrganization", "link", "deceasedBoolean", "deceasedDateTime", "multipleBirthBoolean", "multipleBirthInteger", "extension", "modifierExtension"];
const GENDERS = ["male", "female", "other", "unknown"];

/** Validates a Patient and returns the minimal copy that is carried (data
 * minimisation: identity and the two facts assessment needs, sex and age). */
function validatePatient(res, env) {
  const I = env.issues;
  const path = "Parameters.parameter[patient]";
  if (res.resourceType !== "Patient") {
    I.error("invalid", `'patient' must be a Patient resource (got resourceType "${res.resourceType}").`, path);
    return null;
  }
  const out = { resourceType: "Patient" };
  if (res.id !== undefined) {
    if (typeof res.id === "string" && FHIR_ID.test(res.id)) out.id = res.id;
    else I.error("invalid", "Patient.id must be 1-64 characters from A-Z a-z 0-9 - .", `${path}.id`);
  }
  const identifiers = [];
  for (const [i, idn] of (Array.isArray(res.identifier) ? res.identifier : []).entries()) {
    if (!isObj(idn) || !str(idn.value)) {
      I.error("required", `Patient.identifier[${i}] needs a non-empty 'value'.`, `${path}.identifier[${i}]`);
      continue;
    }
    identifiers.push({
      ...(str(idn.system) ? { system: str(idn.system) } : {}),
      value: str(idn.value),
      ...(["usual", "official", "temp", "secondary", "old"].includes(idn.use) ? { use: idn.use } : {}),
      ...(isObj(idn.type) ? { type: idn.type } : {}),
    });
  }
  if (identifiers.length) out.identifier = identifiers;
  if (res.active !== undefined) {
    if (typeof res.active === "boolean") out.active = res.active;
    else I.error("invalid", "Patient.active must be a boolean.", `${path}.active`);
  }
  const names = [];
  for (const [i, n] of (Array.isArray(res.name) ? res.name : []).entries()) {
    if (!isObj(n)) { I.error("invalid", `Patient.name[${i}] must be a HumanName object.`, `${path}.name[${i}]`); continue; }
    const given = (Array.isArray(n.given) ? n.given : []).filter((g) => str(g)).map((g) => str(g));
    const nm = { ...(str(n.text) ? { text: str(n.text) } : {}), ...(str(n.family) ? { family: str(n.family) } : {}), ...(given.length ? { given } : {}) };
    if (Object.keys(nm).length) names.push(nm);
    else I.error("required", `Patient.name[${i}] needs text, family or given.`, `${path}.name[${i}]`);
  }
  if (names.length) out.name = names;
  if (!identifiers.length && !names.length) {
    I.error("required", "Patient needs at least one identifier (with a value) or a name, so the EHR can match the patient.", path);
  }
  if (res.gender !== undefined) {
    if (GENDERS.includes(res.gender)) { out.gender = res.gender; env.sex = res.gender; }
    else I.error("code-invalid", `Patient.gender must be one of ${GENDERS.join(", ")} (administrative gender).`, `${path}.gender`);
  }
  if (res.birthDate !== undefined) {
    const t = parseFhirTime(res.birthDate);
    if (!t || t.precision === "instant") I.error("invalid", "Patient.birthDate must be a FHIR date: YYYY, YYYY-MM or YYYY-MM-DD.", `${path}.birthDate`);
    else if (isFutureTime(t, env.nowMs)) I.error("value", `Patient.birthDate ${res.birthDate} is in the future.`, `${path}.birthDate`);
    else {
      out.birthDate = res.birthDate;
      env.birth = t;
      if (t.precision !== "day") I.warn("business-rule", "Patient.birthDate has year or month precision only, so age cannot be calculated; pass 'ageYears' if age-based classification is needed.", `${path}.birthDate`);
    }
  }
  const dropped = PATIENT_DROPPED.filter((k) => res[k] !== undefined);
  if (dropped.length) I.info(`Patient elements not carried (data minimisation, not needed for assessment): ${dropped.join(", ")}.`, path);
  return out;
}

// ─── Encounter ─────────────────────────────────────────────────────────────

const ENCOUNTER_STATUS = ["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled", "entered-in-error", "unknown"];
const ENCOUNTER_CLASS = ["AMB", "IMP", "EMER", "HH", "VR", "FLD", "OBSENC", "ACUTE", "NONAC", "PRENC", "SS"];
const ENCOUNTER_KEEP = ["identifier", "type", "serviceType", "priority", "reasonCode", "participant", "location", "serviceProvider"];

function validateEncounter(res, env) {
  const I = env.issues;
  const path = "Parameters.parameter[encounter]";
  if (res.resourceType !== "Encounter") {
    I.error("invalid", `'encounter' must be an Encounter resource or a reference string (got resourceType "${res.resourceType}").`, path);
    return null;
  }
  const out = { resourceType: "Encounter" };
  if (res.id !== undefined) {
    if (typeof res.id === "string" && FHIR_ID.test(res.id)) out.id = res.id;
    else I.error("invalid", "Encounter.id must be 1-64 characters from A-Z a-z 0-9 - .", `${path}.id`);
  }
  if (!ENCOUNTER_STATUS.includes(res.status)) {
    I.error("required", `Encounter.status is required: ${ENCOUNTER_STATUS.join(" | ")}.`, `${path}.status`);
  } else if (res.status === "cancelled" || res.status === "entered-in-error") {
    I.error("business-rule", `Encounter.status "${res.status}": an assessment cannot be recorded against it.`, `${path}.status`);
  } else out.status = res.status;

  const cls = res.class;
  if (!isObj(cls) || !str(cls.code)) {
    I.error("required", `Encounter.class is required: a Coding such as {system: "${ACT_CODE}", code: "AMB"}.`, `${path}.class`);
  } else {
    if ((!cls.system || cls.system === ACT_CODE) && !ENCOUNTER_CLASS.includes(cls.code)) {
      I.error("code-invalid", `Encounter.class code "${cls.code}" is not in v3-ActCode for encounters (${ENCOUNTER_CLASS.join(", ")}).`, `${path}.class`);
    } else if (cls.system && cls.system !== ACT_CODE) {
      I.warn("business-rule", `Encounter.class uses system ${cls.system}; not checked.`, `${path}.class`);
    }
    out.class = { system: cls.system ?? ACT_CODE, code: cls.code, ...(str(cls.display) ? { display: cls.display } : {}) };
  }

  if (res.period !== undefined) {
    const period = {};
    let start = null, end = null;
    for (const f of ["start", "end"]) {
      if (res.period?.[f] === undefined) continue;
      const t = parseFhirTime(res.period[f]);
      if (!t) I.error("invalid", `Encounter.period.${f} "${res.period[f]}" is not a valid FHIR dateTime (a time of day needs a timezone, e.g. 2026-10-10T08:30:00+02:00).`, `${path}.period.${f}`);
      else if (isFutureTime(t, env.nowMs) && f === "start" && res.status !== "planned") I.error("value", "Encounter.period.start is in the future for a non-planned encounter.", `${path}.period.start`);
      else { period[f] = res.period[f]; if (f === "start") start = t; else end = t; }
    }
    if (start && end && end.ms < start.ms) I.error("value", "Encounter.period.end is before period.start.", `${path}.period`);
    if (Object.keys(period).length) out.period = period;
    env.encStart = start;
    env.encEnd = end;
  }
  if (res.status === "finished" && !out.period?.end) {
    I.warn("business-rule", "Encounter.status is finished but period.end is missing.", `${path}.period`);
  }
  for (const k of ENCOUNTER_KEEP) if (res[k] !== undefined) out[k] = res[k];
  const dropped = Object.keys(res).filter((k) => !["resourceType", "id", "status", "class", "period", "subject", ...ENCOUNTER_KEEP].includes(k));
  if (dropped.length) I.info(`Encounter elements not carried: ${dropped.join(", ")}.`, path);

  if (res.subject?.reference !== undefined && env.patientRef && !refMatches(res.subject.reference, env, "patient")) {
    I.error("business-rule", `Encounter.subject "${res.subject.reference}" is not the assessment patient.`, `${path}.subject`);
  }
  return out;
}

/** Does a reference found inside a supplied resource point at this patient / encounter? */
function refMatches(ref, env, which) {
  const mine = which === "patient" ? env.patientRef : env.encounterRef;
  if (ref === mine) return true;
  const id = which === "patient" ? env.patientId : env.encounterId;
  return Boolean(id) && ref === `${which === "patient" ? "Patient" : "Encounter"}/${id}`;
}

// ─── Reading one value into an Observation ─────────────────────────────────

/** Validates `raw` for a registry item. Returns { value, canon?, unit? } or null (issue reported). */
function readValue(env, key, def, raw, path) {
  const I = env.issues;
  switch (def.kind) {
    case "quantity": {
      if (!isObj(raw) || !isNum(raw.value)) {
        I.error("required", `${key} needs a Quantity with a numeric value and a unit (${acceptedUnits(def)}); units are never guessed.`, path);
        return null;
      }
      const unit = unitOf(raw);
      if (unit === null) {
        I.error("value", `${key} needs a recognised unit (${acceptedUnits(def)}); got "${raw.code ?? raw.unit ?? ""}".`, path);
        return null;
      }
      if (!(unit in def.units)) {
        I.error("value", `unit ${unitLabel(unit)} is not valid for ${key} (accepted: ${acceptedUnits(def)}).`, path);
        return null;
      }
      const canon = def.convert ? def.convert(raw.value, unit) : raw.value * def.units[unit];
      const canonUnit = Object.keys(def.units)[0];
      if (canon < def.min || canon > def.max) {
        I.error("value", `${key} ${raw.value} ${unitLabel(unit)} is outside the plausible range (${def.min}-${def.max} ${unitLabel(canonUnit)}); check the unit and the data entry.`, path);
        return null;
      }
      if (def.normalise) {
        const v = round(canon, 3);
        const note = unit !== canonUnit ? `Reported as ${raw.value} ${unitLabel(unit)}; converted to ${v} ${unitLabel(canonUnit)}.` : undefined;
        return { value: { valueQuantity: { value: v, unit: unitLabel(canonUnit), system: UCUM, code: canonUnit } }, canon: v, unit: canonUnit, note };
      }
      return { value: { valueQuantity: { value: raw.value, unit: unitLabel(unit), system: UCUM, code: unit } }, canon, unit };
    }
    case "integer": {
      if (!Number.isInteger(raw) || raw < def.min || raw > def.max) {
        I.error("value", `${key} must be a whole number from ${def.min} to ${def.max}.`, path);
        return null;
      }
      return { value: { valueInteger: raw }, canon: raw };
    }
    case "boolean": {
      if (typeof raw !== "boolean") { I.error("value", `${key} must be true (present) or false (absent).`, path); return null; }
      return { value: { valueBoolean: raw } };
    }
    case "coded": {
      const code = codeOf(raw);
      const opt = def.options.find((o) => o.code === code);
      if (!opt) { I.error("code-invalid", `${key} must be one of: ${def.options.map((o) => o.code).join(", ")}.`, path); return null; }
      return { value: { valueCodeableConcept: { coding: [{ system: cs(env.base, def.codeSystem), code: opt.code, display: opt.display }] } } };
    }
    case "string": {
      const s = str(raw);
      if (!s || s.length > 1000) { I.error("value", `${key} must be text of 1-1000 characters.`, path); return null; }
      return { value: { valueString: s } };
    }
  }
  return null;
}

/** Same for a caller-defined coding (system + code + display, no registry entry). */
function readCustomValue(env, label, raw, path) {
  const I = env.issues;
  if (isObj(raw) && isNum(raw.value)) {
    const code = raw.code || raw.unit;
    if (typeof code !== "string" || !/^\S{1,40}$/.test(code.trim())) {
      I.error("required", `${label} needs a unit on its Quantity (a UCUM code); units are never guessed.`, path);
      return null;
    }
    if (raw.system && raw.system !== UCUM) { I.error("value", `${label}: only UCUM units are accepted.`, path); return null; }
    return { value: { valueQuantity: { value: raw.value, unit: raw.unit ?? code, system: UCUM, code: code.trim() } } };
  }
  if (typeof raw === "boolean") return { value: { valueBoolean: raw } };
  if (Number.isInteger(raw)) return { value: { valueInteger: raw } };
  if (str(raw) && str(raw).length <= 1000) return { value: { valueString: str(raw) } };
  I.error("value", `${label} needs a value: a Quantity with unit, an integer, true/false, or text.`, path);
  return null;
}

// ─── Building one Observation ──────────────────────────────────────────────

/**
 * spec: { path, key | custom:{system,code,display,area}, area?, raw, refLow?, refHigh?,
 *         interpretation?, dataAbsentReason?, note?, effective?, derivedFrom?, status? }
 * Returns { fullUrl, resource, key, canon, ms, effective } or null when invalid.
 */
function buildObservation(env, spec) {
  const I = env.issues;
  const before = I.list.filter((i) => i.severity === "error").length;
  const fail = () => null;
  let def = null, area, coding, label, codeKey;

  if (spec.custom) {
    const c = spec.custom;
    area = c.area;
    label = c.display;
    codeKey = `${c.system}|${c.code}`;
    coding = { system: c.system, code: c.code, display: c.display };
  } else {
    def = ITEMS[spec.key];
    if (!def) {
      I.error("code-invalid", `Unknown measurement "${spec.key}". Registered codes: ${itemKeysText()}. For anything else pass system + code + display.`, spec.path);
      return fail();
    }
    if (spec.area && spec.area !== def.area) {
      I.error("business-rule", `${spec.key} belongs to the "${def.area}" area, not "${spec.area}".`, spec.path);
      return fail();
    }
    area = def.area;
    label = spec.key;
    codeKey = spec.key;
    coding = def.loinc
      ? { system: LOINC, code: def.loinc, display: def.display }
      : { system: cs(env.base, "assessment-item"), code: spec.key, display: def.display };
  }

  // Timestamp: valid, not in the future, not before the patient was born.
  const effective = spec.effective ?? env.defaultEffective.str;
  const t = parseFhirTime(effective);
  if (!t) {
    I.error("invalid", `effectiveDateTime "${effective}" is not a valid FHIR date or dateTime (a time of day needs a timezone, e.g. 2026-10-10T08:30:00+02:00).`, spec.path);
  } else {
    if (isFutureTime(t, env.nowMs)) I.error("value", `effectiveDateTime ${effective} is in the future.`, spec.path);
    if (env.birth && t.ms < env.birth.ms) I.error("value", `effectiveDateTime ${effective} is before the patient's birth date.`, spec.path);
  }

  // Value, or an explicit reason it is missing.
  const dar = spec.dataAbsentReason;
  let vr = null;
  if (dar !== undefined) {
    if (!DAR_CODES.includes(dar)) I.error("code-invalid", `dataAbsentReason must be one of ${DAR_CODES.join(", ")}.`, spec.path);
    if (spec.raw !== undefined) I.error("business-rule", `${label}: give a value or a dataAbsentReason, not both.`, spec.path);
  } else if (spec.raw === undefined) {
    I.error("required", `${label} needs a value, or a dataAbsentReason (${DAR_CODES.join(", ")}) if it was not obtained.`, spec.path);
  } else {
    vr = def ? readValue(env, spec.key, def, spec.raw, spec.path) : readCustomValue(env, label, spec.raw, spec.path);
  }

  // Reference range (the lab's own) and interpretation flag.
  let referenceRange, interpretation;
  const hasRange = spec.refLow !== undefined || spec.refHigh !== undefined;
  if (hasRange) {
    if (!def || def.kind !== "quantity" || def.normalise) {
      I.error("business-rule", `${label}: referenceLow/referenceHigh apply only to biochemical, clinical and dietary quantities (growth is classified by $evaluate-growth).`, spec.path);
    } else if (vr) {
      const unit = vr.unit;
      const bound = (q, name) => {
        if (q === undefined) return undefined;
        if (!isObj(q) || !isNum(q.value) || unitOf(q) !== unit) {
          I.error("value", `${name} must be a Quantity in the same unit as the value (${unitLabel(unit)}); units are never converted for ranges.`, spec.path);
          return null;
        }
        return q.value;
      };
      const low = bound(spec.refLow, "referenceLow");
      const high = bound(spec.refHigh, "referenceHigh");
      if (low !== null && high !== null) {
        if (low !== undefined && high !== undefined && low > high) I.error("value", "referenceLow is above referenceHigh.", spec.path);
        else {
          const q = (v) => ({ value: v, unit: unitLabel(unit), system: UCUM, code: unit });
          referenceRange = [{ ...(low !== undefined ? { low: q(low) } : {}), ...(high !== undefined ? { high: q(high) } : {}) }];
          const v = vr.value.valueQuantity.value;
          const computed = low !== undefined && v < low ? "L" : high !== undefined && v > high ? "H" : "N";
          if (spec.interpretation === undefined) interpretation = computed;
          else if (["L", "LL"].includes(spec.interpretation) && computed !== "L" || ["H", "HH"].includes(spec.interpretation) && computed !== "H" || spec.interpretation === "N" && computed !== "N") {
            I.warn("business-rule", `${label}: interpretation ${spec.interpretation} disagrees with the value against the supplied reference range (${computed}); kept as supplied.`, spec.path);
          }
        }
      }
    }
  }
  if (spec.interpretation !== undefined) {
    if (!INTERPRETATION_CODES.includes(spec.interpretation)) I.error("code-invalid", `interpretation must be one of ${INTERPRETATION_CODES.join(", ")}.`, spec.path);
    else interpretation = spec.interpretation;
  }

  // The same measurement at the same instant twice is ambiguous.
  if (t) {
    const dk = `${codeKey}|${t.ms}`;
    if (env.seen.has(dk)) I.error("duplicate", `${label} appears more than once for ${effective}.`, spec.path);
    env.seen.add(dk);
  }

  if (I.list.filter((i) => i.severity === "error").length > before) return fail();

  if (t && env.encStart) {
    const DAY = 86400000;
    const lo = t.precision === "instant" ? env.encStart.ms : Math.floor(env.encStart.ms / DAY) * DAY;
    const hi = env.encEnd ? env.encEnd.ms + (env.encEnd.precision === "instant" ? 0 : DAY) : env.nowMs + DAY;
    if (t.ms < lo || t.ms > hi) env.outsideEncounter.push(label);
  }

  const dom = AREAS[area].domain;
  const cat = def?.cat ?? AREAS[area].cat;
  const notes = [spec.note && { text: spec.note }, vr?.note && { text: vr.note }].filter(Boolean);
  const resource = {
    resourceType: "Observation",
    status: spec.status ?? "final",
    category: [
      { coding: [{ system: OBS_CATEGORY, code: cat }] },
      ...stepCategory(env.base, "assessment", [{ system: cs(env.base, "ncp-assessment-domain"), code: dom, display: ASSESSMENT_DOMAINS[dom] }]),
    ],
    code: { coding: [coding], text: def?.display ?? label },
    ...(env.patientRef ? { subject: { reference: env.patientRef } } : {}),
    ...(env.encounterRef ? { encounter: { reference: env.encounterRef } } : {}),
    effectiveDateTime: effective,
    ...(env.performer ? { performer: [env.performer] } : {}),
    ...(vr ? vr.value : {}),
    ...(dar !== undefined ? { dataAbsentReason: { coding: [{ system: DAR_SYSTEM, code: dar }] } } : {}),
    ...(interpretation ? { interpretation: [{ coding: [{ system: V3_INTERPRETATION, code: interpretation }] }] } : {}),
    ...(referenceRange ? { referenceRange } : {}),
    ...(spec.derivedFrom ? { derivedFrom: [{ reference: spec.derivedFrom }] } : {}),
    ...(notes.length ? { note: notes } : {}),
  };
  env.coverage.add(area);
  return { fullUrl: newUuid(env.ctx), resource, key: spec.key ?? codeKey, canon: vr?.canon, ms: t?.ms, effective };
}

// ─── Questionnaires (built-in forms) ───────────────────────────────────────
//
// Each form is a tree of items. A leaf whose linkId is a registry key
// (ITEMS) is extracted into an Observation. A leaf that is not a registry key
// is form-specific (used by the screening form for MUST).

const FORMS = {
  "nutrition-screening": {
    title: "Adult nutrition screening (MUST inputs)",
    description: "The inputs of the Malnutrition Universal Screening Tool for adults. Submitting it to $nutrition-assessment records weight and height as Observations and computes the MUST score (the same calculation as POST /fhir/Observation/$screen).",
    items: [
      { key: "weight", required: true },
      { key: "height", required: true },
      { linkId: "weightLossPercent3to6Months", text: "Unplanned weight loss in the past 3-6 months (%; 0 if none)", type: "decimal", min: 0, max: 100, required: true },
      { linkId: "acuteDiseaseNoIntake", text: "Acutely ill and there has been, or is likely to be, no nutritional intake for more than 5 days", type: "boolean", required: true },
    ],
  },
  nfpe: {
    title: "Nutrition-focused physical examination (NFPE)",
    description: "Examination findings by site. Muscle and fat sites use normal / mild / moderate / severe as judged by the examiner; signs are present or absent. Chakudya records what the examiner enters and never grades a finding.",
    items: [
      { group: "muscle", text: "Muscle", items: ["temple-muscle", "clavicle-muscle", "shoulder-muscle", "scapula-muscle", "interosseous-muscle", "thigh-muscle", "calf-muscle"] },
      { group: "fat", text: "Fat", items: ["orbital-fat", "triceps-fat", "rib-fat"] },
      { group: "fluid", text: "Fluid", items: ["oedema", "ascites"] },
      { group: "micronutrient-signs", text: "Signs that may relate to micronutrient status", items: ["pallor", "angular-stomatitis", "glossitis", "bitot-spots", "hair-changes", "skin-changes", "goitre"] },
    ],
  },
  "diet-history": {
    title: "Dietary intake summary",
    description: "A summary of one 24-hour recall or a usual day: energy and nutrient intake, meals, appetite and food-group count. Quantities are per day.",
    items: ["energy-intake-kcal", "protein-intake-g", "fat-intake-g", "carbohydrate-intake-g", "fluid-intake", "meals-per-day", "food-group-count", "appetite", "dietary-notes"],
  },
};
export const QUESTIONNAIRE_IDS = Object.keys(FORMS);

/** Expands a form spec into FHIR Questionnaire items (also the lookup tree used for validation). */
function formItems(base, nodes) {
  return nodes.map((n) => {
    if (typeof n === "string") n = { key: n };
    if (n.group) return { linkId: n.group, text: n.text, type: "group", item: formItems(base, n.items) };
    if (n.key) {
      const d = ITEMS[n.key];
      const item = {
        linkId: n.key,
        code: [d.loinc ? { system: LOINC, code: d.loinc, display: d.display } : { system: cs(base, "assessment-item"), code: n.key, display: d.display }],
        text: d.display,
        required: Boolean(n.required),
      };
      if (d.kind === "quantity") {
        item.type = "quantity";
        item.extension = Object.keys(d.units).map((u) => ({ url: Q_UNIT_OPTION, valueCoding: { system: UCUM, code: u, display: unitLabel(u) } }));
      } else if (d.kind === "integer") {
        item.type = n.key === "oedema" ? "choice" : "integer";
        if (item.type === "choice") item.answerOption = [0, 1, 2, 3].map((v) => ({ valueInteger: v }));
        else item.extension = [{ url: Q_MIN, valueInteger: d.min }, { url: Q_MAX, valueInteger: d.max }];
      } else if (d.kind === "coded") {
        item.type = "choice";
        item.answerOption = d.options.map((o) => ({ valueCoding: { system: cs(base, d.codeSystem), code: o.code, display: o.display } }));
      } else item.type = d.kind; // boolean | string
      return item;
    }
    return {
      linkId: n.linkId, text: n.text, type: n.type, required: Boolean(n.required),
      ...(n.type === "decimal" ? { extension: [{ url: Q_MIN, valueDecimal: n.min }, { url: Q_MAX, valueDecimal: n.max }] } : {}),
    };
  });
}

export function questionnaireResource(base, id) {
  const f = FORMS[id];
  if (!f) return null;
  return {
    resourceType: "Questionnaire",
    id,
    url: `${base}/fhir/Questionnaire/${id}`,
    version: "1",
    name: id.replace(/(^|-)([a-z0-9])/g, (_, __, ch) => ch.toUpperCase()),
    title: f.title,
    status: "active",
    date: "2026-10-11",
    publisher: "Chakudya Nutrition Registry",
    description: f.description,
    subjectType: ["Patient"],
    item: formItems(base, f.items),
  };
}

export function questionnaireSearchBundle(base) {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: QUESTIONNAIRE_IDS.length,
    entry: QUESTIONNAIRE_IDS.map((id) => ({ fullUrl: `${base}/fhir/Questionnaire/${id}`, resource: questionnaireResource(base, id) })),
  };
}

const builtinIdFor = (canonical, base) => {
  const url = String(canonical).split("|")[0];
  return QUESTIONNAIRE_IDS.find((id) => url === `${base}/fhir/Questionnaire/${id}` || url === `Questionnaire/${id}`) ?? null;
};

const QR_STATUS = ["in-progress", "completed", "amended", "entered-in-error", "stopped"];
const ANSWER_KEY = { boolean: "valueBoolean", decimal: "valueDecimal", integer: "valueInteger", string: "valueString", quantity: "valueQuantity" };

/** Raw value (as readValue expects) from a QuestionnaireResponse answer. */
const answerRaw = (a) => (a.valueCoding !== undefined ? a.valueCoding : a[Object.keys(a).find((k) => k.startsWith("value"))]);

/**
 * Validates one QuestionnaireResponse and, for a built-in form, extracts its
 * Observations. Returns { resource, fullUrl, measures, answers, def } (resource null on failure).
 */
function processQuestionnaireResponse(env, qr, idx, ownUrl) {
  const I = env.issues;
  const path = `Parameters.parameter[questionnaireResponse:${idx}]`;
  const errorsBefore = I.list.filter((i) => i.severity === "error").length;
  if (!isObj(qr) || qr.resourceType !== "QuestionnaireResponse") {
    I.error("invalid", "questionnaireResponse must be a QuestionnaireResponse resource.", path);
    return null;
  }
  if (!QR_STATUS.includes(qr.status)) I.error("required", `QuestionnaireResponse.status is required: ${QR_STATUS.join(" | ")}.`, `${path}.status`);
  else if (qr.status === "entered-in-error") I.error("business-rule", "QuestionnaireResponse.status is entered-in-error; it cannot be used for an assessment.", `${path}.status`);
  if (!str(qr.questionnaire)) I.error("required", "QuestionnaireResponse.questionnaire (the form's canonical URL) is required.", `${path}.questionnaire`);

  let authored = env.defaultEffective.str;
  if (qr.authored !== undefined) {
    const t = typeof qr.authored === "string" ? parseFhirTime(qr.authored) : null;
    if (!t || t.precision !== "instant") I.error("invalid", `QuestionnaireResponse.authored "${qr.authored}" must be a full dateTime with timezone.`, `${path}.authored`);
    else if (isFutureTime(t, env.nowMs)) I.error("value", "QuestionnaireResponse.authored is in the future.", `${path}.authored`);
    else if (env.birth && t.ms < env.birth.ms) I.error("value", "QuestionnaireResponse.authored is before the patient's birth date.", `${path}.authored`);
    else authored = qr.authored;
  }
  if (qr.subject?.reference !== undefined && env.patientRef && !refMatches(qr.subject.reference, env, "patient")) {
    I.error("business-rule", `QuestionnaireResponse.subject "${qr.subject.reference}" is not the assessment patient.`, `${path}.subject`);
  }
  if (qr.encounter?.reference !== undefined && env.encounterRef && !refMatches(qr.encounter.reference, env, "encounter")) {
    I.error("business-rule", `QuestionnaireResponse.encounter "${qr.encounter.reference}" is not the assessment encounter.`, `${path}.encounter`);
  }

  const id = str(qr.questionnaire) ? builtinIdFor(qr.questionnaire, env.base) : null;
  const def = id ? questionnaireResource(env.base, id) : null;
  if (str(qr.questionnaire) && !def) {
    I.warn("business-rule", `Questionnaire ${qr.questionnaire} is not one of this API's forms (${QUESTIONNAIRE_IDS.join(", ")}); answers are checked structurally only and no observations are extracted.`, `${path}.questionnaire`);
  }

  const final = qr.status === "completed" || qr.status === "amended";
  const state = { answers: new Map(), measures: [], answeredCount: 0 };
  const status = final ? "final" : "preliminary";

  const walk = (qrItems, defItems, p) => {
    if (!Array.isArray(qrItems)) { I.error("invalid", "item must be an array.", p); return; }
    const seen = new Set();
    for (const [i, qi] of qrItems.entries()) {
      const ip = `${p}.item[${i}]`;
      if (!isObj(qi) || typeof qi.linkId !== "string" || !qi.linkId) { I.error("required", "Every item needs a linkId.", ip); continue; }
      if (seen.has(qi.linkId)) { I.error("duplicate", `linkId "${qi.linkId}" appears twice at this level (repeating items are not supported).`, ip); continue; }
      seen.add(qi.linkId);
      const d = defItems?.find((x) => x.linkId === qi.linkId);
      if (defItems && !d) { I.error("invalid", `linkId "${qi.linkId}" is not defined in Questionnaire ${id} at this level.`, ip); continue; }
      if (d?.type === "group") {
        if (qi.answer !== undefined) I.error("invalid", `"${qi.linkId}" is a group and cannot have answers.`, ip);
        if (qi.item !== undefined) walk(qi.item, d.item, ip);
        continue;
      }
      if (qi.item !== undefined) { I.error("not-supported", `Items nested under an answer ("${qi.linkId}") are not supported.`, ip); continue; }
      const answers = qi.answer ?? [];
      if (!Array.isArray(answers)) { I.error("invalid", "answer must be an array.", ip); continue; }
      if (answers.length === 0) continue;
      if (answers.length > 1) { I.error("not-supported", `"${qi.linkId}" has ${answers.length} answers; repeating answers are not supported.`, ip); continue; }
      const a = answers[0];
      const valueKeys = isObj(a) ? Object.keys(a).filter((k) => k.startsWith("value")) : [];
      if (valueKeys.length !== 1) { I.error("invalid", `"${qi.linkId}": each answer needs exactly one value[x].`, `${ip}.answer[0]`); continue; }
      const vk = valueKeys[0];
      if (d) {
        const ok = d.type === "choice" ? vk === "valueCoding" || vk === "valueInteger" : vk === ANSWER_KEY[d.type];
        if (!ok) { I.error("value", `"${qi.linkId}" is a ${d.type} item; got ${vk}.`, `${ip}.answer[0]`); continue; }
        if (d.type === "decimal" || d.type === "integer") {
          const v = a[vk];
          const lo = d.extension?.find((e) => e.url === Q_MIN), hi = d.extension?.find((e) => e.url === Q_MAX);
          const lov = lo?.valueDecimal ?? lo?.valueInteger, hiv = hi?.valueDecimal ?? hi?.valueInteger;
          if (!isNum(v) || (lov !== undefined && v < lov) || (hiv !== undefined && v > hiv)) {
            I.error("value", `"${qi.linkId}" must be a number from ${lov} to ${hiv}.`, `${ip}.answer[0]`);
            continue;
          }
        }
        if (d.type === "string" && (!str(a[vk]) || a[vk].length > 1000)) { I.error("value", `"${qi.linkId}" must be text of 1-1000 characters.`, `${ip}.answer[0]`); continue; }
      }
      state.answeredCount++;
      state.answers.set(qi.linkId, { raw: answerRaw(a), path: `${ip}.answer[0]` });
      if (d && ITEMS[qi.linkId]) {
        const m = buildObservation(env, { path: `${ip}.answer[0]`, key: qi.linkId, raw: answerRaw(a), effective: authored, derivedFrom: ownUrl, status });
        if (m) state.measures.push(m);
      }
    }
  };
  if (qr.item !== undefined) walk(qr.item, def?.item, path);

  if (def) {
    const missing = [];
    const need = (items) => { for (const it of items) { if (it.type === "group") need(it.item); else if (it.required && !state.answers.has(it.linkId)) missing.push(it.linkId); } };
    need(def.item);
    if (missing.length) {
      (final ? I.error : I.warn).call(I, "required", `Required items not answered: ${missing.join(", ")}${final ? " (status is completed)" : ""}.`, path);
    }
    if (final && state.answeredCount === 0) I.warn("business-rule", "QuestionnaireResponse is completed but has no answers.", path);
  }

  const failed = I.list.filter((i) => i.severity === "error").length > errorsBefore;
  const resource = failed ? null : {
    resourceType: "QuestionnaireResponse",
    questionnaire: qr.questionnaire,
    status: qr.status,
    ...(env.patientRef ? { subject: { reference: env.patientRef } } : {}),
    ...(env.encounterRef ? { encounter: { reference: env.encounterRef } } : {}),
    authored,
    ...(qr.author ? { author: qr.author } : env.performer ? { author: env.performer } : {}),
    ...(qr.item ? { item: qr.item } : {}),
  };
  return { resource, def, id, measures: state.measures, answers: state.answers, status, authored, failed };
}

/** MUST from a submitted nutrition-screening form; null (with an issue) when it cannot be computed. */
function mustFromForm(env, qrResult, qrUrl) {
  const I = env.issues;
  const { answers, measures } = qrResult;
  const w = measures.find((m) => m.key === "weight"), h = measures.find((m) => m.key === "height");
  const loss = answers.get("weightLossPercent3to6Months")?.raw;
  const acute = answers.get("acuteDiseaseNoIntake")?.raw;
  const missing = [!w && "weight", !h && "height", loss === undefined && "weightLossPercent3to6Months", acute === undefined && "acuteDiseaseNoIntake"].filter(Boolean);
  if (missing.length) {
    I.warn("business-rule", `MUST score not computed: missing ${missing.join(", ")}.`, "QuestionnaireResponse");
    return null;
  }
  if (isNum(env.ageYears) && env.ageYears < 18) {
    I.warn("business-rule", "MUST score not computed: the screening form is for adults (18+).", "QuestionnaireResponse");
    return null;
  }
  const q = (v, u) => ({ value: v, unit: u, system: UCUM, code: u });
  const params = {
    resourceType: "Parameters",
    parameter: [
      { name: "tool", valueCode: "must" },
      { name: "weight", valueQuantity: q(w.canon, "kg") },
      { name: "height", valueQuantity: q(h.canon, "cm") },
      { name: "weightLossPercent3to6Months", valueDecimal: loss },
      { name: "acuteDiseaseNoIntake", valueBoolean: acute },
      { name: "effectiveDateTime", valueDateTime: qrResult.authored },
      ...(env.patientRef ? [{ name: "subject", valueString: env.patientRef }] : []),
    ],
  };
  const r = evaluateScreen(params, { base: env.base, now: env.ctx.now, uuid: env.ctx.uuid });
  if (!r.ok) {
    I.warn("business-rule", `MUST score not computed: ${r.outcome?.issue?.[0]?.diagnostics ?? "screening failed"}.`, "QuestionnaireResponse");
    return null;
  }
  const obs = r.body.entry[0].resource;
  obs.status = qrResult.status;
  if (env.encounterRef) obs.encounter = { reference: env.encounterRef };
  if (env.performer) obs.performer = [env.performer];
  obs.derivedFrom = [{ reference: qrUrl }, ...[w, h].map((m) => ({ reference: m.fullUrl }))];
  return { fullUrl: newUuid(env.ctx), resource: obs };
}

// ─── Environment shared by the operations ──────────────────────────────────

function makeEnv(ctx) {
  const nowMs = Date.parse(ctx.now);
  return {
    ctx, base: ctx.base, now: ctx.now, nowMs,
    issues: makeIssues(),
    patientRef: null, patientId: null, encounterRef: null, encounterId: null,
    birth: null, sex: null, ageYears: null,
    encStart: null, encEnd: null,
    performer: null,
    defaultEffective: { str: ctx.now },
    seen: new Set(), coverage: new Set(), outsideEncounter: [],
  };
}

// ─── Reading an `observation` part ─────────────────────────────────────────

/** One `observation` part -> a spec for buildObservation, or null (issue reported). */
function specFromObservationPart(o, path, I) {
  if (!o || typeof o.get !== "function") { I.error("invalid", "observation must be a part with nested parts (code, value, ...).", path); return null; }
  const code = str(o.get("code"));
  if (!code) { I.error("required", "observation.code is required.", path); return null; }
  if (o.all("value").length > 1) { I.error("invalid", "observation has more than one 'value'.", path); return null; }
  const common = {
    path, raw: o.get("value"), refLow: o.get("referenceLow"), refHigh: o.get("referenceHigh"),
    interpretation: str(o.get("interpretation")), dataAbsentReason: str(o.get("dataAbsentReason")),
    note: str(o.get("note")), effective: str(o.get("effectiveDateTime")), area: str(o.get("domain")),
  };
  if (common.area && !AREAS[common.area]) { I.error("code-invalid", `observation.domain must be one of ${ASSESSMENT_AREAS.join(", ")}.`, path); return null; }
  if (str(o.get("system"))) {
    const display = str(o.get("display"));
    if (!display) { I.error("required", "observation.display is required with a custom system + code.", path); return null; }
    if (!common.area) { I.error("required", `observation.domain is required for a custom code (${ASSESSMENT_AREAS.join(", ")}).`, path); return null; }
    return { ...common, custom: { system: str(o.get("system")), code, display, area: common.area } };
  }
  return { ...common, key: code };
}

/**
 * Builds validated Observations from `observation` part readers for another
 * operation (used by $diagnose for the evidence behind a diagnosis).
 * link: { patientRef, encounterRef?, performer?, effective? }.
 * Returns { ok, entries: [{fullUrl, resource}], issues } (issues = OperationOutcome issue list).
 */
export function buildObservationsFromParts(ctx, link, readers) {
  const env = makeEnv(ctx);
  env.patientRef = link.patientRef ?? null;
  env.encounterRef = link.encounterRef ?? null;
  env.performer = link.performer ?? null;
  if (link.effective) env.defaultEffective = { str: link.effective };
  const entries = [];
  const specs = readers.map((r, i) => specFromObservationPart(r.reader, r.path ?? `observation[${i}]`, env.issues));
  specs.forEach((spec, i) => {
    if (!spec) return;
    if (readers[i].derivedFrom) spec.derivedFrom = readers[i].derivedFrom;
    const m = buildObservation(env, spec);
    if (m) entries.push({ fullUrl: m.fullUrl, resource: m.resource });
  });
  return { ok: !env.issues.hasError, entries, issues: env.issues.list };
}

// ─── POST /fhir/Bundle/$nutrition-assessment ───────────────────────────────

const fail400 = (issues) => ({ ok: false, status: 400, outcome: outcomeOf(issues.list) });

export function evaluateNutritionAssessment(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const env = makeEnv(ctx);
  const I = env.issues;
  const entries = [];

  // 1. Patient — a resource to validate and carry, or a reference to an existing one.
  const patientParam = p.get("patient");
  const subjectParam = str(p.get("subject")) ?? (typeof patientParam === "string" ? str(patientParam) : undefined);
  if (patientParam !== undefined && typeof patientParam !== "string" && subjectParam) {
    I.error("business-rule", "Give either 'patient' (a Patient resource) or 'subject' (a reference), not both.", "Parameters");
  }
  let patientEntry = null;
  if (isObj(patientParam)) {
    const resource = validatePatient(patientParam, env);
    if (resource) {
      patientEntry = { fullUrl: newUuid(ctx), resource };
      env.patientRef = patientEntry.fullUrl;
      env.patientId = resource.id ?? null;
    }
  } else if (subjectParam) {
    if (!REF.Patient.test(subjectParam)) I.error("invalid", `'subject' must be a Patient reference such as "Patient/123" (got "${subjectParam.slice(0, 80)}").`, "Parameters.parameter[subject]");
    else { env.patientRef = subjectParam; env.patientId = /Patient\/([^/]+)$/.exec(subjectParam)?.[1] ?? null; }
  } else {
    I.error("required", "A patient is required: 'patient' (a Patient resource) or 'subject' (e.g. \"Patient/123\").", "Parameters");
  }

  // 2. Encounter — resource or reference. Required: an assessment belongs to an encounter.
  const encParam = p.get("encounter");
  let encounterEntry = null;
  if (isObj(encParam)) {
    const resource = validateEncounter(encParam, env);
    if (resource) {
      env.encounterRef = newUuid(ctx);
      env.encounterId = resource.id ?? null;
      encounterEntry = { fullUrl: env.encounterRef, resource };
    }
  } else if (typeof encParam === "string" && str(encParam)) {
    if (!REF.Encounter.test(str(encParam))) I.error("invalid", `'encounter' must be an Encounter reference such as "Encounter/456" (got "${str(encParam).slice(0, 80)}").`, "Parameters.parameter[encounter]");
    else { env.encounterRef = str(encParam); env.encounterId = /Encounter\/([^/]+)$/.exec(str(encParam))?.[1] ?? null; }
  } else {
    I.error("required", "'encounter' is required: an Encounter resource, or a reference such as \"Encounter/456\".", "Parameters.parameter[encounter]");
  }
  if (encounterEntry && env.patientRef) encounterEntry.resource.subject = { reference: env.patientRef };

  // 3. Default time, author, age.
  const effParam = p.get("effectiveDateTime");
  if (effParam !== undefined) {
    const t = typeof effParam === "string" ? parseFhirTime(effParam) : null;
    if (!t) I.error("invalid", `effectiveDateTime "${effParam}" is not a valid FHIR date or dateTime.`, "Parameters.parameter[effectiveDateTime]");
    else env.defaultEffective = { str: effParam };
  } else if (encounterEntry?.resource.period?.start) {
    env.defaultEffective = { str: encounterEntry.resource.period.start };
  }
  if (p.get("author") !== undefined) env.performer = authorRef(p.get("author")) ?? null;
  const ageParam = p.get("ageYears");
  if (ageParam !== undefined) {
    if (!Number.isInteger(ageParam) || ageParam < 0 || ageParam > 130) I.error("value", "ageYears must be a whole number from 0 to 130.", "Parameters.parameter[ageYears]");
    else env.ageYears = ageParam;
  } else if (env.birth?.precision === "day") {
    const at = parseFhirTime(env.defaultEffective.str);
    if (at) env.ageYears = ageYearsAt(env.birth, at.ms);
  }

  // 4. Observations supplied directly.
  const obsParts = p.all("observation");
  if (obsParts.length > MAX_OBSERVATIONS) I.error("too-long", `At most ${MAX_OBSERVATIONS} observation parts per request.`, "Parameters");
  const measures = [];
  if (obsParts.length <= MAX_OBSERVATIONS) {
    for (const [i, o] of obsParts.entries()) {
      const spec = specFromObservationPart(o, `Parameters.parameter[observation:${i}]`, I);
      if (!spec) continue;
      const m = buildObservation(env, spec);
      if (m) measures.push(m);
    }
  }

  // 5. QuestionnaireResponses.
  const qrParts = p.all("questionnaireResponse");
  if (qrParts.length > MAX_QUESTIONNAIRE_RESPONSES) I.error("too-long", `At most ${MAX_QUESTIONNAIRE_RESPONSES} questionnaireResponse parts per request.`, "Parameters");
  const qrEntries = [], derived = [];
  if (qrParts.length <= MAX_QUESTIONNAIRE_RESPONSES) {
    for (const [i, qr] of qrParts.entries()) {
      const ownUrl = newUuid(ctx);
      const r = processQuestionnaireResponse(env, qr, i, ownUrl);
      if (!r || !r.resource) continue;
      qrEntries.push({ fullUrl: ownUrl, resource: r.resource });
      measures.push(...r.measures);
      if (r.id === "nutrition-screening") {
        const must = mustFromForm(env, r, ownUrl);
        if (must) derived.push(must);
      }
    }
  }
  if (I.hasError) return fail400(I);

  // 6. BMI and its WHO adult class, from one weight and one height.
  const weights = measures.filter((m) => m.key === "weight" && m.canon !== undefined);
  const heights = measures.filter((m) => m.key === "height" && m.canon !== undefined);
  let bmiEntry = null;
  if (weights.length === 1 && heights.length === 1) {
    const [w] = weights, [h] = heights;
    const bmi = w.canon / (h.canon / 100) ** 2;
    if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) {
      I.error("value", `Computed BMI ${round(bmi, 1)} is not plausible; check weight and height.`, "Parameters");
      return fail400(I);
    }
    const later = w.ms >= h.ms ? w : h;
    if (Math.abs(w.ms - h.ms) > 30 * 86400000) I.warn("business-rule", "BMI was computed from a weight and a height measured more than 30 days apart.", "Parameters");
    const adult = isNum(env.ageYears) && env.ageYears >= 18;
    const cls = adult ? whoAdultBmiClass(bmi) : null;
    if (!isNum(env.ageYears)) I.info("BMI recorded without a WHO adult class: age is unknown (pass 'ageYears' or a full Patient.birthDate).", "Parameters");
    else if (!adult) I.info("BMI recorded without a WHO adult class: the patient is under 18; classify growth with POST /fhir/Observation/$evaluate-growth.", "Parameters");
    const dom = AREAS.anthropometry.domain;
    bmiEntry = {
      fullUrl: newUuid(ctx),
      resource: {
        resourceType: "Observation",
        status: "final",
        category: [
          { coding: [{ system: OBS_CATEGORY, code: "vital-signs" }] },
          ...stepCategory(env.base, "assessment", [{ system: cs(env.base, "ncp-assessment-domain"), code: dom, display: ASSESSMENT_DOMAINS[dom] }]),
        ],
        code: { coding: [{ system: LOINC, code: "39156-5", display: "Body mass index (BMI)" }] },
        subject: { reference: env.patientRef },
        encounter: { reference: env.encounterRef },
        effectiveDateTime: later.effective,
        ...(env.performer ? { performer: [env.performer] } : {}),
        valueQuantity: { value: round(bmi, 1), unit: "kg/m2", system: UCUM, code: "kg/m2" },
        ...(cls ? {
          interpretation: [{ coding: [{ system: V3_INTERPRETATION, code: cls.interp }] }],
          component: [{ code: { coding: [{ system: cs(env.base, "growth-metric"), code: "status", display: "WHO adult BMI class" }] }, valueCodeableConcept: { coding: [{ system: cs(env.base, "who-adult-bmi-class"), code: cls.code }] } }],
        } : {}),
        derivedFrom: [{ reference: w.fullUrl }, { reference: h.fullUrl }],
        note: [{ text: `Calculated from body weight and body height.${cls ? " WHO adult BMI classification (>= 18 years). " + SCREENING_NOTE : ""}` }],
      },
    };
  } else if (weights.length + heights.length === 1) {
    I.warn("incomplete", `BMI not computed: ${weights.length ? "body height" : "body weight"} is missing.`, "Parameters");
  } else if (weights.length > 1 || heights.length > 1) {
    I.warn("business-rule", "BMI not computed: it needs exactly one weight and one height in this request.", "Parameters");
  }

  // 7. Completeness and timestamp notes.
  for (const area of ASSESSMENT_AREAS) {
    if (!env.coverage.has(area)) I.info(`No ${area} data supplied.`, "Parameters");
  }
  if (env.outsideEncounter.length) {
    I.warn("business-rule", `${env.outsideEncounter.length} observation(s) have effective times outside the encounter period (${[...new Set(env.outsideEncounter)].join(", ")}). Results obtained earlier are fine; check the timestamps.`, "Parameters");
  }
  if (measures.length === 0 && derived.length === 0 && qrEntries.length === 0) {
    I.warn("incomplete", "No observations or questionnaire responses were supplied: the Bundle holds only the patient and encounter.", "Parameters");
  }

  // 8. Assemble.
  if (patientEntry) entries.push(patientEntry);
  if (encounterEntry) entries.push(encounterEntry);
  entries.push(...qrEntries);
  entries.push(...measures.map((m) => ({ fullUrl: m.fullUrl, resource: m.resource })));
  if (bmiEntry) entries.push(bmiEntry);
  entries.push(...derived);
  const notes = I.list.filter((i) => i.severity !== "error");
  if (notes.length) entries.push({ fullUrl: newUuid(ctx), resource: outcomeOf(notes) });

  return { ok: true, status: 200, body: { resourceType: "Bundle", type: "collection", timestamp: ctx.now, entry: entries } };
}

// ─── POST /fhir/QuestionnaireResponse/$validate ────────────────────────────

export function evaluateQuestionnaireResponseValidate(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const qr = p.get("resource");
  if (!isObj(qr)) {
    return { ok: false, status: 400, outcome: outcomeOf([{ severity: "error", code: "required", diagnostics: "Parameter 'resource' (a QuestionnaireResponse) is required." }]) };
  }
  const env = makeEnv(ctx);
  processQuestionnaireResponse(env, qr, 0, "urn:uuid:validate");
  const issues = env.issues.list;
  if (!issues.length) issues.push({ severity: "information", code: "informational", diagnostics: "No issues found." });
  else if (!env.issues.hasError) issues.unshift({ severity: "information", code: "informational", diagnostics: "No errors found." });
  return { ok: true, status: 200, body: outcomeOf(issues) };
}

// ─── Registry used by index.js ─────────────────────────────────────────────

export const ASSESSMENT_OPERATIONS = {
  "Bundle/$nutrition-assessment": evaluateNutritionAssessment,
  "QuestionnaireResponse/$validate": evaluateQuestionnaireResponseValidate,
};

export function assessmentOperationFor(param, action) {
  return ASSESSMENT_OPERATIONS[`${param}/${action}`] ?? null;
}
