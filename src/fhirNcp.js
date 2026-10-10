// FHIR R4 facade — Nutrition Care Process (NCP), Phase 2.
//
// Phase 1 (src/fhir.js) covered one slice of NCP Step 1 (anthropometric
// growth classification). This module covers the whole process as the
// Academy of Nutrition and Dietetics defines it:
//
//   Screening  -> POST /fhir/Observation/$screen            (MUST, adults)
//   Assess     -> POST /fhir/Observation/$assess-nutrition  (A: BMI, weight
//                 change, energy/protein needs + intake, GLIM, and generic
//                 FH/AD/BD/PD/CH indicators)
//   Diagnose   -> POST /fhir/Condition/$diagnose            (D: PES statement)
//   Intervene  -> POST /fhir/CarePlan/$intervene            (I: NutritionOrder,
//                 education/counseling/coordination ServiceRequests, Goals,
//                 CarePlan)
//   Monitor    -> POST /fhir/Goal/$evaluate                 (M&E: goal
//                 achievement vs. baseline/target)
//   Document   -> POST /fhir/Bundle/$ncp-document           (ADIME Composition
//                 document Bundle assembled from the above)
//
// Same contract as Phase 1: STATELESS. Nothing is stored; the caller's EHR
// persists the returned resources. Every function here is pure (no I/O) so it
// is unit-testable with `node --test`.
//
// What is and isn't "clinical judgement" here: Chakudya computes deterministic
// things (BMI, % weight change, MUST score, Mifflin-St Jeor BEE, GLIM criteria
// logic, goal progress). It does NOT choose a nutrition diagnosis, an
// intervention or a goal for the clinician — the PES statement, orders and
// goals are the dietitian's inputs, which this module validates and shapes
// into FHIR. The eNCPT diagnosis terminology is proprietary, so it is never
// bundled: a caller may pass its own code (system + code) through, otherwise
// the problem is carried as text.

import { operationOutcome, toKg, toCm } from "./fhir.js";

export const SCREENING_NOTE =
  "Screening/assessment aid only, not a diagnosis. A registered dietitian or clinician confirms findings.";

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const SNOMED = "http://snomed.info/sct";
const ICD10 = "http://hl7.org/fhir/sid/icd-10";
const OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
const CONDITION_CATEGORY = "http://terminology.hl7.org/CodeSystem/condition-category";
const CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
const CONDITION_VER = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const GOAL_ACHIEVEMENT = "http://terminology.hl7.org/CodeSystem/goal-achievement";
const LIST_EMPTY_REASON = "http://terminology.hl7.org/CodeSystem/list-empty-reason";
const V3_INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";

const cs = (base, name) => `${base}/fhir/CodeSystem/${name}`;

// ─── Result / error helpers ────────────────────────────────────────────────

const bad = (message, status = 400) => ({ ok: false, status, outcome: operationOutcome("error", message) });
const unprocessable = (message) => bad(message, 422);
const okRes = (body) => ({ ok: true, status: 200, body });

// ─── Parameters reading (repeatable params, nested parts, resources) ───────

function readAny(p) {
  if (p.valueQuantity !== undefined) return p.valueQuantity;
  if (p.valueCode !== undefined) return p.valueCode;
  if (p.valueString !== undefined) return p.valueString;
  if (p.valueDecimal !== undefined) return p.valueDecimal;
  if (p.valueInteger !== undefined) return p.valueInteger;
  if (p.valueBoolean !== undefined) return p.valueBoolean;
  if (p.valueDate !== undefined) return p.valueDate;
  if (p.valueDateTime !== undefined) return p.valueDateTime;
  if (p.valueCodeableConcept !== undefined) return p.valueCodeableConcept;
  if (p.valueCoding !== undefined) return p.valueCoding;
  if (p.valueReference !== undefined) return p.valueReference.reference ?? p.valueReference;
  if (p.resource !== undefined) return p.resource;
  return undefined;
}

/** Reads a Parameters body into { get(name), all(name) }; `part` params
 * become nested readers of the same shape (any depth). */
function readParams(params) {
  const lists = {};
  for (const p of params?.parameter ?? []) {
    if (!p || typeof p.name !== "string") continue;
    const v = Array.isArray(p.part) ? readParams({ parameter: p.part }) : readAny(p);
    if (v === undefined) continue;
    (lists[p.name] ||= []).push(v);
  }
  return { get: (n) => lists[n]?.[0], all: (n) => lists[n] ?? [] };
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);

function requireParameters(body) {
  if (!body || body.resourceType !== "Parameters") {
    return bad('Body must be a FHIR Parameters resource (resourceType: "Parameters").');
  }
  return null;
}

/** Quantity -> normalised { value, unit, system, code } or null. */
function quantity(q) {
  if (!q || !isNum(q.value)) return null;
  const unit = q.unit ?? q.code;
  const out = { value: q.value };
  if (unit) out.unit = unit;
  if (q.code || q.unit) {
    out.system = q.system ?? UCUM;
    out.code = q.code ?? q.unit;
  }
  return out;
}
const unitKey = (q) => (q?.code || q?.unit || "").toLowerCase();

function subjectRef(value) {
  const s = str(value);
  if (!s || s.length > 200) return null;
  return { reference: s };
}

function authorRef(value) {
  const s = str(value);
  if (!s) return null;
  return /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(s) || s.startsWith("urn:uuid:") ? { reference: s } : { display: s };
}

// ─── Bundle / entry helpers ────────────────────────────────────────────────

function newUuid(ctx) {
  return `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;
}

function collection(entries) {
  return { resourceType: "Bundle", type: "collection", entry: entries };
}

function entryOf(ctx, resource) {
  return { fullUrl: newUuid(ctx), resource };
}

// ─── Age ───────────────────────────────────────────────────────────────────

function ageYearsFrom(p, now) {
  const explicit = p.get("ageYears");
  if (isNum(explicit)) return explicit;
  const birth = str(p.get("birthDate"));
  if (!birth) return null;
  const at = new Date(str(p.get("effectiveDateTime")) ?? now);
  const b = new Date(birth);
  if (isNaN(b) || isNaN(at)) return null;
  let years = at.getFullYear() - b.getFullYear();
  const m = at.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < b.getDate())) years -= 1;
  return years;
}

// ─── Tagging: which NCP step an Observation belongs to ─────────────────────

const STEP = {
  screening: "nutrition-screening",
  assessment: "nutrition-assessment",
  diagnosis: "nutrition-diagnosis",
  intervention: "nutrition-intervention",
  monitoring: "nutrition-monitoring",
};

function stepCategory(base, step, extraCodings = []) {
  return [
    { coding: [{ system: cs(base, "ncp-step"), code: STEP[step] }] },
    ...extraCodings.map((c) => ({ coding: [c] })),
  ];
}

const bodyText = (concept) => concept?.text ?? concept?.coding?.[0]?.display ?? concept?.coding?.[0]?.code ?? "";

// ─── Shared adult anthropometry ────────────────────────────────────────────

function whoAdultBmiClass(bmi) {
  if (bmi < 16) return { code: "severe-thinness", interp: "LL" };
  if (bmi < 17) return { code: "moderate-thinness", interp: "LL" };
  if (bmi < 18.5) return { code: "mild-thinness", interp: "L" };
  if (bmi < 25) return { code: "normal", interp: "N" };
  if (bmi < 30) return { code: "overweight", interp: "H" };
  if (bmi < 35) return { code: "obesity-class-1", interp: "H" };
  if (bmi < 40) return { code: "obesity-class-2", interp: "HH" };
  return { code: "obesity-class-3", interp: "HH" };
}

// Standard % weight-loss significance intervals (Blackburn 1977, as used in
// the AND/ASPEN malnutrition consensus). Only evaluated when the supplied
// period matches one of the defined intervals — never extrapolated.
const WEIGHT_LOSS_INTERVALS = [
  { label: "1 week", days: 7, tol: 3, significant: 1, severe: 2 },
  { label: "1 month", days: 30, tol: 10, significant: 5, severe: 5 },
  { label: "3 months", days: 91, tol: 20, significant: 7.5, severe: 7.5 },
  { label: "6 months", days: 182, tol: 30, significant: 10, severe: 10 },
];

function weightLossSignificance(lossPct, periodDays) {
  if (!isNum(periodDays) || lossPct <= 0) return null;
  const iv = WEIGHT_LOSS_INTERVALS.find((i) => Math.abs(periodDays - i.days) <= i.tol);
  if (!iv) return { interval: null, level: "no-standard-threshold" };
  if (lossPct > iv.severe) return { interval: iv.label, level: "severe" };
  if (lossPct >= iv.significant) return { interval: iv.label, level: "significant" };
  return { interval: iv.label, level: "not-significant" };
}

// ─── $screen — MUST (Malnutrition Universal Screening Tool, adults) ────────

export function evaluateScreen(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;

  let bmi = isNum(p.get("bmi")) ? p.get("bmi") : null;
  const kg = p.get("weight") ? toKg(p.get("weight")) : null;
  const cm = p.get("height") ? toCm(p.get("height")) : null;
  if (bmi === null) {
    if (kg === null || cm === null) {
      return bad("Provide 'bmi' (decimal), or both 'weight' (kg/g) and 'height' (cm/m) Quantities.");
    }
    bmi = kg / (cm / 100) ** 2;
  }
  if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) return bad("Computed/provided BMI is not plausible.");

  let lossPct = isNum(p.get("weightLossPercent3to6Months")) ? p.get("weightLossPercent3to6Months") : null;
  if (lossPct === null && p.get("usualWeight")) {
    const usual = toKg(p.get("usualWeight"));
    if (usual === null || kg === null) return bad("'usualWeight' needs a recognised unit (kg/g) and a current 'weight'.");
    lossPct = ((usual - kg) / usual) * 100;
  }
  if (lossPct === null) {
    return bad("Provide 'weightLossPercent3to6Months' (decimal, unplanned loss; 0 if none) or 'usualWeight' + 'weight'.");
  }
  const acute = p.get("acuteDiseaseNoIntake");
  if (typeof acute !== "boolean") {
    return bad("'acuteDiseaseNoIntake' (boolean) is required: acutely ill AND no nutritional intake, or likely none, for more than 5 days.");
  }

  const bmiScore = bmi > 20 ? 0 : bmi >= 18.5 ? 1 : 2;
  const lossScore = lossPct < 5 ? 0 : lossPct <= 10 ? 1 : 2;
  const acuteScore = acute ? 2 : 0;
  const total = bmiScore + lossScore + acuteScore;
  const risk = total === 0 ? "low" : total === 1 ? "medium" : "high";
  const management =
    risk === "low"
      ? "Routine clinical care; repeat screening per local policy."
      : risk === "medium"
        ? "Observe: document dietary intake for 3 days; escalate if inadequate."
        : "Treat: refer to a dietitian / nutrition support team.";

  const obs = {
    resourceType: "Observation",
    status: "final",
    category: [
      ...stepCategory(base, "screening"),
      { coding: [{ system: OBS_CATEGORY, code: "survey" }] },
    ],
    code: { coding: [{ system: cs(base, "screening-tool"), code: "must", display: "MUST score (adult)" }], text: "MUST nutrition screening score" },
    effectiveDateTime: str(p.get("effectiveDateTime")) ?? ctx.now,
    valueInteger: total,
    interpretation: [{ coding: [{ system: V3_INTERPRETATION, code: risk === "low" ? "N" : risk === "medium" ? "A" : "AA" }] }],
    component: [
      { code: { text: "BMI score" }, valueInteger: bmiScore },
      { code: { text: "Unplanned weight loss score" }, valueInteger: lossScore },
      { code: { text: "Acute disease effect score" }, valueInteger: acuteScore },
      { code: { coding: [{ system: cs(base, "ncp-indicator"), code: "must-risk-category" }] }, valueCodeableConcept: { coding: [{ system: cs(base, "must-risk"), code: risk }] } },
      { code: { coding: [{ system: LOINC, code: "39156-5", display: "Body mass index (BMI)" }] }, valueQuantity: { value: round(bmi, 1), unit: "kg/m2", system: UCUM, code: "kg/m2" } },
    ],
    note: [{ text: `${management} ${SCREENING_NOTE}` }],
  };
  const subj = p.get("subject") ? subjectRef(p.get("subject")) : null;
  if (subj) obs.subject = subj;

  return okRes(collection([entryOf(ctx, obs)]));
}

function round(x, dp) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// ─── $assess-nutrition ─────────────────────────────────────────────────────

const ASSESSMENT_DOMAINS = {
  FH: "Food/nutrition-related history",
  AD: "Anthropometric measurements",
  BD: "Biochemical data, medical tests and procedures",
  PD: "Nutrition-focused physical findings",
  CH: "Client history",
};

function indicatorObservation(ctx, part, defaultTime, subject) {
  const domain = str(part.get("domain"))?.toUpperCase();
  if (!ASSESSMENT_DOMAINS[domain]) {
    return bad(`indicator.domain must be one of ${Object.keys(ASSESSMENT_DOMAINS).join(", ")} (got "${part.get("domain")}").`);
  }
  const display = str(part.get("display"));
  const code = str(part.get("code"));
  if (!display && !code) return bad("Each 'indicator' needs a 'display' and/or 'code'.");

  const value = part.get("value");
  let valueFields;
  if (value === undefined) return bad(`indicator "${display ?? code}" needs a 'value' (Quantity, string, boolean, decimal, integer or code).`);
  if (typeof value === "object" && value !== null && isNum(value.value)) valueFields = { valueQuantity: quantity(value) };
  else if (typeof value === "string") valueFields = { valueString: value };
  else if (typeof value === "boolean") valueFields = { valueBoolean: value };
  else if (isNum(value)) valueFields = { valueQuantity: { value } };
  else return bad(`indicator "${display ?? code}" has an unsupported 'value' type.`);

  const domainCoding = { system: cs(ctx.base, "ncp-assessment-domain"), code: domain, display: ASSESSMENT_DOMAINS[domain] };
  const extra = domain === "BD" ? [domainCoding, { system: OBS_CATEGORY, code: "laboratory" }] : [domainCoding];
  const obs = {
    resourceType: "Observation",
    status: "final",
    category: stepCategory(ctx.base, "assessment", extra),
    code: { text: display ?? code },
    effectiveDateTime: str(part.get("effectiveDateTime")) ?? defaultTime,
    ...valueFields,
  };
  if (code) {
    obs.code.coding = [{ system: str(part.get("system")) ?? cs(ctx.base, "ncp-indicator"), code, ...(display ? { display } : {}) }];
  }
  if (subject) obs.subject = subject;
  return { ok: true, obs };
}

// GLIM (Cederholm et al., 2019). Phenotypic >= 1 AND etiologic >= 1, after a
// positive screen. Severity from the worst phenotypic criterion.
function evaluateGlim({ bmi, age, bmiSet, lossPct, lossPeriodDays, muscle, inflammation, intakePct, intakeDays, malabsorption }) {
  const notAssessed = [];
  const phenotypic = [];
  const grades = [];

  // Weight loss
  if (isNum(lossPct) && isNum(lossPeriodDays)) {
    const within = lossPeriodDays <= 183;
    if (within ? lossPct > 5 : lossPct > 10) {
      phenotypic.push("weight-loss");
      const severe = within ? lossPct > 10 : lossPct > 20;
      grades.push(severe ? 2 : 1);
    }
  } else notAssessed.push("weight-loss");

  // Low BMI
  if (isNum(bmi) && isNum(age)) {
    const older = age >= 70;
    const t = bmiSet === "asian"
      ? { mod: older ? 20 : 18.5, sev: older ? 17.8 : 17 }
      : { mod: older ? 22 : 20, sev: older ? 20 : 18.5 };
    if (bmi < t.mod) {
      phenotypic.push("low-bmi");
      grades.push(bmi < t.sev ? 2 : 1);
    }
  } else notAssessed.push("low-bmi");

  // Muscle mass
  if (muscle === "mild-moderate" || muscle === "severe") {
    phenotypic.push("reduced-muscle-mass");
    grades.push(muscle === "severe" ? 2 : 1);
  } else if (muscle !== "none") notAssessed.push("reduced-muscle-mass");

  const etiologic = [];
  // Reduced intake: <=50% of requirement > 1 week, or any reduction > 2 weeks.
  if (isNum(intakePct) && isNum(intakeDays)) {
    if ((intakePct <= 50 && intakeDays > 7) || (intakePct < 100 && intakeDays > 14)) etiologic.push("reduced-intake");
  } else notAssessed.push("reduced-intake");
  if (malabsorption === true) etiologic.push("reduced-assimilation");
  if (inflammation === "acute-disease-or-injury" || inflammation === "chronic-disease") etiologic.push("inflammation");
  else if (inflammation !== "none") notAssessed.push("inflammation");

  const diagnosed = phenotypic.length >= 1 && etiologic.length >= 1;
  const severity = diagnosed ? (Math.max(...grades) === 2 ? "severe" : "moderate") : null;
  return { diagnosed, severity, phenotypic, etiologic, notAssessed };
}

export function evaluateAssessNutrition(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;
  const effective = str(p.get("effectiveDateTime")) ?? ctx.now;
  const subject = p.get("subject") ? subjectRef(p.get("subject")) : null;
  const tag = (o) => (subject ? { ...o, subject } : o);

  const age = ageYearsFrom(p, ctx.now);
  const sex = str(p.get("sex"))?.toLowerCase();

  const kg = p.get("weight") ? toKg(p.get("weight")) : null;
  const cm = p.get("height") ? toCm(p.get("height")) : null;
  if (p.get("weight") && kg === null) return bad("'weight' needs a recognised unit (kg or g).");
  if (p.get("height") && cm === null) return bad("'height' needs a recognised unit (cm or m).");
  if (isNum(age) && age < 18) {
    return unprocessable("This operation is for adults (18+). For children/adolescents use POST /fhir/Observation/$evaluate-growth.");
  }

  const entries = [];
  const add = (o) => {
    const ent = entryOf(ctx, tag(o));
    entries.push(ent);
    return ent;
  };
  const cat = () => stepCategory(base, "assessment", [{ system: cs(base, "ncp-assessment-domain"), code: "AD", display: ASSESSMENT_DOMAINS.AD }]);
  const catFH = () => stepCategory(base, "assessment", [{ system: cs(base, "ncp-assessment-domain"), code: "FH", display: ASSESSMENT_DOMAINS.FH }]);

  // Anthropometry: weight, height, BMI
  let bmi = null;
  if (kg !== null) {
    add({ resourceType: "Observation", status: "final", category: cat(), code: { coding: [{ system: LOINC, code: "29463-7", display: "Body weight" }] }, effectiveDateTime: effective, valueQuantity: { value: kg, unit: "kg", system: UCUM, code: "kg" } });
  }
  if (cm !== null) {
    add({ resourceType: "Observation", status: "final", category: cat(), code: { coding: [{ system: LOINC, code: "8302-2", display: "Body height" }] }, effectiveDateTime: effective, valueQuantity: { value: cm, unit: "cm", system: UCUM, code: "cm" } });
  }
  if (kg !== null && cm !== null) {
    bmi = kg / (cm / 100) ** 2;
    if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) return bad("Computed BMI is not plausible.");
    const cls = whoAdultBmiClass(bmi);
    add({
      resourceType: "Observation", status: "final", category: cat(),
      code: { coding: [{ system: LOINC, code: "39156-5", display: "Body mass index (BMI)" }] },
      effectiveDateTime: effective,
      valueQuantity: { value: round(bmi, 1), unit: "kg/m2", system: UCUM, code: "kg/m2" },
      interpretation: [{ coding: [{ system: V3_INTERPRETATION, code: cls.interp }] }],
      component: [{ code: { coding: [{ system: cs(base, "growth-metric"), code: "status", display: "WHO adult BMI class" }] }, valueCodeableConcept: { coding: [{ system: cs(base, "who-adult-bmi-class"), code: cls.code }] } }],
      note: [{ text: "WHO adult BMI classification (>= 18 years). " + SCREENING_NOTE }],
    });
  }

  // Weight change
  let lossPct = null;
  const lossPeriodDays = isNum(p.get("usualWeightPeriodDays")) ? p.get("usualWeightPeriodDays") : null;
  if (p.get("usualWeight")) {
    const usual = toKg(p.get("usualWeight"));
    if (usual === null) return bad("'usualWeight' needs a recognised unit (kg or g).");
    if (kg === null) return bad("'usualWeight' requires a current 'weight'.");
    lossPct = ((usual - kg) / usual) * 100;
    const sig = weightLossSignificance(lossPct, lossPeriodDays);
    const comps = [
      { code: { coding: [{ system: cs(base, "ncp-indicator"), code: "usual-weight" }] }, valueQuantity: { value: usual, unit: "kg", system: UCUM, code: "kg" } },
    ];
    if (sig) {
      comps.push({ code: { text: "Significance (Blackburn standard interval)" }, valueCodeableConcept: { coding: [{ system: cs(base, "weight-loss-significance"), code: sig.level }], text: sig.interval ?? undefined } });
    }
    add({
      resourceType: "Observation", status: "final", category: cat(),
      code: { coding: [{ system: cs(base, "ncp-indicator"), code: "weight-change-percent", display: "Weight change (positive = loss)" }] },
      effectiveDateTime: effective,
      valueQuantity: { value: round(lossPct, 1), unit: "%", system: UCUM, code: "%" },
      component: comps,
      ...(lossPeriodDays !== null ? { extension: [{ url: `${base}/fhir/StructureDefinition/period-days`, valueInteger: lossPeriodDays }] } : {}),
      note: [{ text: "Positive value = weight LOSS from usual weight. " + (sig ? "" : "Significance not graded (no usual-weight period, or no loss. ") + SCREENING_NOTE }],
    });
  }

  // Energy & protein requirements (Mifflin-St Jeor) and intake adequacy
  let energyReq = null;
  let proteinReq = null;
  const reqKg = p.get("requirementWeight") ? toKg(p.get("requirementWeight")) : kg;
  if (p.get("requirementWeight") && reqKg === null) return bad("'requirementWeight' needs a recognised unit (kg or g).");
  const energyFactor = p.get("energyFactor");
  const proteinPerKg = p.get("proteinGPerKg");
  if (energyFactor !== undefined && !(isNum(energyFactor) && energyFactor > 0 && energyFactor <= 3)) return bad("'energyFactor' must be a number in (0, 3].");
  if (proteinPerKg !== undefined && !(isNum(proteinPerKg) && proteinPerKg > 0 && proteinPerKg <= 4)) return bad("'proteinGPerKg' must be a number in (0, 4] g/kg/day.");

  if (reqKg !== null && cm !== null && isNum(age) && (sex === "male" || sex === "female")) {
    const bee = 10 * reqKg + 6.25 * cm - 5 * age + (sex === "male" ? 5 : -161);
    energyReq = energyFactor !== undefined ? bee * energyFactor : null;
    const comps = [{ code: { text: "Basal energy expenditure (Mifflin-St Jeor)" }, valueQuantity: { value: Math.round(bee), unit: "kcal/d", system: UCUM, code: "kcal/d" } }];
    if (energyReq !== null) comps.push({ code: { text: "Estimated energy requirement (BEE x factor)" }, valueQuantity: { value: Math.round(energyReq), unit: "kcal/d", system: UCUM, code: "kcal/d" } });
    if (energyFactor !== undefined) comps.push({ code: { text: "Energy factor (activity/stress), clinician-supplied" }, valueQuantity: { value: energyFactor } });
    add({
      resourceType: "Observation", status: "final", category: cat(),
      code: { coding: [{ system: cs(base, "ncp-indicator"), code: "energy-requirement", display: "Energy requirement" }] },
      effectiveDateTime: effective,
      valueQuantity: { value: Math.round(energyReq ?? bee), unit: "kcal/d", system: UCUM, code: "kcal/d" },
      component: comps,
      note: [{ text: energyReq === null ? "Value is BEE only (no 'energyFactor' supplied)." : "BEE x clinician-supplied factor." }],
    });
  } else if (energyFactor !== undefined) {
    return bad("Energy requirement needs weight (or requirementWeight), height, age (ageYears or birthDate) and sex (male|female).");
  }
  if (proteinPerKg !== undefined) {
    if (reqKg === null) return bad("'proteinGPerKg' needs a weight (or requirementWeight) to compute protein requirement.");
    proteinReq = proteinPerKg * reqKg;
    add({
      resourceType: "Observation", status: "final", category: cat(),
      code: { coding: [{ system: cs(base, "ncp-indicator"), code: "protein-requirement", display: "Protein requirement" }] },
      effectiveDateTime: effective,
      valueQuantity: { value: round(proteinReq, 1), unit: "g/d", system: UCUM, code: "g/d" },
      component: [{ code: { text: "Protein target, clinician-supplied" }, valueQuantity: { value: proteinPerKg, unit: "g/kg/d", system: UCUM, code: "g/kg/d" } }],
    });
  }

  let intakePct = isNum(p.get("intakePercentOfRequirement")) ? p.get("intakePercentOfRequirement") : null;
  const energyIntake = p.get("energyIntakeKcalPerDay");
  const proteinIntake = p.get("proteinIntakeGPerDay");
  if (isNum(energyIntake)) {
    if (energyReq !== null) {
      const pct = (energyIntake / energyReq) * 100;
      if (intakePct === null) intakePct = pct;
      add({
        resourceType: "Observation", status: "final", category: catFH(),
        code: { coding: [{ system: cs(base, "ncp-indicator"), code: "energy-intake-adequacy", display: "Energy intake vs requirement" }] },
        effectiveDateTime: effective,
        valueQuantity: { value: round(pct, 0), unit: "%", system: UCUM, code: "%" },
        component: [{ code: { text: "Energy intake" }, valueQuantity: { value: energyIntake, unit: "kcal/d", system: UCUM, code: "kcal/d" } }],
      });
    } else {
      add({
        resourceType: "Observation", status: "final", category: catFH(),
        code: { coding: [{ system: cs(base, "ncp-indicator"), code: "energy-intake", display: "Energy intake" }] },
        effectiveDateTime: effective,
        valueQuantity: { value: energyIntake, unit: "kcal/d", system: UCUM, code: "kcal/d" },
        note: [{ text: "Adequacy not computed: supply 'energyFactor' with weight/height/age/sex to derive a requirement." }],
      });
    }
  }
  if (isNum(proteinIntake)) {
    add({
      resourceType: "Observation", status: "final", category: catFH(),
      code: { coding: [{ system: cs(base, "ncp-indicator"), code: proteinReq !== null ? "protein-intake-adequacy" : "protein-intake", display: proteinReq !== null ? "Protein intake vs requirement" : "Protein intake" }] },
      effectiveDateTime: effective,
      valueQuantity: proteinReq !== null
        ? { value: round((proteinIntake / proteinReq) * 100, 0), unit: "%", system: UCUM, code: "%" }
        : { value: proteinIntake, unit: "g/d", system: UCUM, code: "g/d" },
      ...(proteinReq !== null ? { component: [{ code: { text: "Protein intake" }, valueQuantity: { value: proteinIntake, unit: "g/d", system: UCUM, code: "g/d" } }] } : {}),
    });
  }

  // GLIM
  const screeningPositive = p.get("screeningPositive");
  if (screeningPositive !== false) {
    const muscle = str(p.get("muscleMass"));
    const inflam = str(p.get("inflammation"));
    if (muscle !== undefined && !["none", "mild-moderate", "severe"].includes(muscle)) return bad("'muscleMass' must be none, mild-moderate or severe.");
    if (inflam !== undefined && !["none", "acute-disease-or-injury", "chronic-disease"].includes(inflam)) return bad("'inflammation' must be none, acute-disease-or-injury or chronic-disease.");
    const bmiSet = str(p.get("glimBmiCutoffSet")) ?? "default";
    if (!["default", "asian"].includes(bmiSet)) return bad("'glimBmiCutoffSet' must be default or asian.");
    const anyGlimInput = [muscle, inflam, p.get("malabsorption"), intakePct, p.get("intakeReductionDays")].some((x) => x !== undefined && x !== null);
    if (anyGlimInput || screeningPositive === true) {
      const g = evaluateGlim({
        bmi, age, bmiSet, lossPct, lossPeriodDays, muscle, inflammation: inflam,
        intakePct, intakeDays: p.get("intakeReductionDays"), malabsorption: p.get("malabsorption"),
      });
      const coding = (code) => ({ coding: [{ system: cs(base, "glim"), code }] });
      const comps = [
        { code: { coding: [{ system: cs(base, "glim"), code: "phenotypic-criteria-met" }] }, valueString: g.phenotypic.join(", ") || "none" },
        { code: { coding: [{ system: cs(base, "glim"), code: "etiologic-criteria-met" }] }, valueString: g.etiologic.join(", ") || "none" },
        { code: { coding: [{ system: cs(base, "glim"), code: "malnutrition-criteria-met" }] }, valueBoolean: g.diagnosed },
      ];
      if (g.severity) comps.push({ code: { coding: [{ system: cs(base, "glim"), code: "severity" }] }, valueCodeableConcept: coding(g.severity) });
      const noteBits = [];
      if (screeningPositive === undefined) noteBits.push("GLIM applies only after a positive validated screen; 'screeningPositive' was not supplied.");
      if (g.notAssessed.length) noteBits.push(`Not assessed (input missing): ${g.notAssessed.join(", ")}.`);
      noteBits.push("GLIM criteria evaluation (Cederholm 2019). Confirm with clinical assessment.");
      add({
        resourceType: "Observation", status: "final", category: cat(),
        code: { coding: [{ system: cs(base, "ncp-indicator"), code: "glim-malnutrition", display: "GLIM malnutrition criteria" }], text: "GLIM malnutrition assessment" },
        effectiveDateTime: effective,
        valueBoolean: g.diagnosed,
        component: comps,
        note: [{ text: noteBits.join(" ") }],
      });
    }
  }

  // Generic FH/AD/BD/PD/CH indicators
  for (const part of p.all("indicator")) {
    const r = indicatorObservation(ctx, part, effective, subject);
    if (!r.ok) return r;
    entries.push(entryOf(ctx, r.obs));
  }

  if (entries.length === 0) {
    return bad("Nothing to assess: supply anthropometry (weight/height), usualWeight, requirements/intake inputs, GLIM inputs, or 'indicator' parts.");
  }
  return okRes(collection(entries));
}

// ─── $diagnose — PES statement -> Condition ────────────────────────────────

const PES_DOMAINS = {
  intake: "Nutrition intake",
  clinical: "Nutrition clinical",
  "behavioral-environmental": "Nutrition behavioral/environmental",
};
const SEVERITY = {
  mild: { code: "255604002", display: "Mild" },
  moderate: { code: "6736007", display: "Moderate" },
  severe: { code: "24484000", display: "Severe" },
};
// Common problems a caller may name via 'problemCode' shortcut -> public
// (non-eNCPT) codings. The eNCPT diagnosis terms are proprietary and are not
// bundled; callers may instead pass their own (system, code).
const PROBLEM_SHORTCUTS = {
  "malnutrition": [{ system: SNOMED, code: "44054006", display: "Malnutrition" }],
  "malnutrition-moderate": [{ system: ICD10, code: "E44.0", display: "Moderate protein-energy malnutrition" }],
  "malnutrition-severe": [{ system: ICD10, code: "E43", display: "Unspecified severe protein-energy malnutrition" }],
  "underweight": [{ system: SNOMED, code: "248342006", display: "Underweight" }],
  "overweight": [{ system: SNOMED, code: "238131007", display: "Overweight" }],
  "obesity": [{ system: SNOMED, code: "414916001", display: "Obesity" }],
};

export function evaluateDiagnose(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;

  const subject = subjectRef(p.get("subject"));
  if (!subject) return bad("Parameter 'subject' is required (e.g. valueString \"Patient/123\").");
  const diagnoses = p.all("diagnosis");
  if (diagnoses.length === 0) return bad("At least one 'diagnosis' part is required.");
  if (diagnoses.length > 20) return bad("At most 20 diagnoses per request.");

  const entries = [];
  for (const [i, d] of diagnoses.entries()) {
    const label = `diagnosis[${i}]`;
    const domain = str(d.get("domain"));
    if (!PES_DOMAINS[domain]) return bad(`${label}.domain must be intake, clinical or behavioral-environmental.`);
    const problem = str(d.get("problem"));
    if (!problem) return bad(`${label}.problem (the nutrition diagnosis label) is required.`);
    const etiology = d.all("etiology").map(str).filter(Boolean);
    const signs = d.all("signsSymptoms").map(str).filter(Boolean);
    if (etiology.length === 0) return bad(`${label}: a PES statement needs at least one 'etiology' (the "related to" part).`);
    if (signs.length === 0) return bad(`${label}: a PES statement needs at least one 'signsSymptoms' (the "as evidenced by" part).`);
    const severity = str(d.get("severity"));
    if (severity !== undefined && !SEVERITY[severity]) return bad(`${label}.severity must be mild, moderate or severe.`);
    const status = str(d.get("verificationStatus")) ?? "provisional";
    if (!["provisional", "confirmed"].includes(status)) return bad(`${label}.verificationStatus must be provisional or confirmed.`);

    const coding = [];
    const sys = str(d.get("problemSystem"));
    const code = str(d.get("problemCode"));
    if (sys && code) coding.push({ system: sys, code, display: str(d.get("problemDisplay")) ?? problem });
    else if (code && PROBLEM_SHORTCUTS[code]) coding.push(...PROBLEM_SHORTCUTS[code]);
    else if (code && !sys) return bad(`${label}.problemCode "${code}" needs a 'problemSystem', or use one of: ${Object.keys(PROBLEM_SHORTCUTS).join(", ")}.`);

    const pes = `${problem} related to ${etiology.join("; ")} as evidenced by ${signs.join("; ")}.`;
    const evidenceRefs = d.all("evidence").map(str).filter(Boolean);

    const cond = {
      resourceType: "Condition",
      clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "active" }] },
      verificationStatus: { coding: [{ system: CONDITION_VER, code: status }] },
      category: [
        { coding: [{ system: CONDITION_CATEGORY, code: "problem-list-item" }] },
        { coding: [{ system: cs(base, "ncp-step"), code: STEP.diagnosis }] },
        { coding: [{ system: cs(base, "ncp-diagnosis-domain"), code: domain, display: PES_DOMAINS[domain] }] },
      ],
      code: { ...(coding.length ? { coding } : {}), text: problem },
      subject,
      recordedDate: str(d.get("recordedDate")) ?? ctx.now,
      evidence: [
        ...signs.map((s) => ({ code: [{ text: s }] })),
        ...(evidenceRefs.length ? [{ detail: evidenceRefs.map((reference) => ({ reference })) }] : []),
      ],
      note: [{ text: pes }],
      extension: [
        { url: `${base}/fhir/StructureDefinition/pes-etiology`, valueString: etiology.join("; ") },
        { url: `${base}/fhir/StructureDefinition/pes-signs-symptoms`, valueString: signs.join("; ") },
      ],
    };
    if (severity) cond.severity = { coding: [{ system: SNOMED, ...SEVERITY[severity] }] };
    entries.push(entryOf(ctx, cond));
  }
  return okRes(collection(entries));
}

// ─── $intervene — NutritionOrder + ServiceRequests + Goals + CarePlan ──────

const STATUSES = ["draft", "active"];
const INTENTS = ["proposal", "plan", "order"];

function goalFromPart(ctx, g, i, subject, lifecycle, addressesRefs) {
  const label = `goal[${i}]`;
  const description = str(g.get("description"));
  if (!description) return bad(`${label}.description is required.`);
  const goal = {
    resourceType: "Goal",
    lifecycleStatus: lifecycle,
    category: [{ coding: [{ system: cs(ctx.base, "ncp-step"), code: STEP.intervention }] }],
    description: { text: description },
    subject,
    startDate: (str(g.get("startDate")) ?? ctx.now).slice(0, 10),
  };
  const priority = str(g.get("priority"));
  if (priority !== undefined) {
    if (!["high", "medium", "low"].includes(priority)) return bad(`${label}.priority must be high, medium or low.`);
    goal.priority = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/goal-priority", code: `${priority}-priority` }] };
  }
  const target = g.get("target") ? quantity(g.get("target")) : null;
  const baseline = g.get("baseline") ? quantity(g.get("baseline")) : null;
  const direction = str(g.get("direction"));
  if (direction !== undefined && !["increase", "decrease", "maintain"].includes(direction)) return bad(`${label}.direction must be increase, decrease or maintain.`);
  if (g.get("target") && !target) return bad(`${label}.target must be a Quantity with a numeric value.`);
  if (g.get("baseline") && !baseline) return bad(`${label}.baseline must be a Quantity with a numeric value.`);
  const measure = str(g.get("measure"));
  const due = str(g.get("dueDate"));
  if (target || measure || due) {
    const t = {};
    if (measure) {
      t.measure = { text: measure };
      const mc = str(g.get("measureCode"));
      if (mc) t.measure.coding = [{ system: str(g.get("measureSystem")) ?? cs(ctx.base, "ncp-indicator"), code: mc, display: measure }];
    }
    if (target) t.detailQuantity = target;
    if (due) t.dueDate = due;
    goal.target = [t];
  }
  const ext = [];
  if (direction) ext.push({ url: `${ctx.base}/fhir/StructureDefinition/goal-direction`, valueCode: direction });
  if (baseline) ext.push({ url: `${ctx.base}/fhir/StructureDefinition/goal-baseline`, valueQuantity: baseline });
  if (ext.length) goal.extension = ext;
  if (addressesRefs.length) goal.addresses = addressesRefs.map((reference) => ({ reference }));
  return { ok: true, goal };
}

function serviceRequest(ctx, domainCode, domainDisplay, codeText, subject, status, intent, note, extraCategory) {
  const sr = {
    resourceType: "ServiceRequest",
    status,
    intent,
    category: [
      { coding: [{ system: cs(ctx.base, "ncp-step"), code: STEP.intervention }] },
      { coding: [{ system: cs(ctx.base, "ncp-intervention-domain"), code: domainCode, display: domainDisplay }] },
      ...(extraCategory ? [extraCategory] : []),
    ],
    code: { text: codeText },
    subject,
    authoredOn: ctx.now,
  };
  if (note) sr.note = [{ text: note }];
  return sr;
}

export function evaluateIntervene(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;

  const subject = subjectRef(p.get("subject"));
  if (!subject) return bad("Parameter 'subject' is required (e.g. valueString \"Patient/123\").");
  const status = str(p.get("status")) ?? "draft";
  const intent = str(p.get("intent")) ?? "proposal";
  if (!STATUSES.includes(status)) return bad("'status' must be draft or active.");
  if (!INTENTS.includes(intent)) return bad("'intent' must be proposal, plan or order.");
  const addresses = p.all("addresses").map(str).filter(Boolean);
  const lifecycle = status === "draft" ? "proposed" : "active";

  const goalEntries = [];
  for (const [i, g] of p.all("goal").entries()) {
    const r = goalFromPart(ctx, g, i, subject, lifecycle, addresses);
    if (!r.ok) return r;
    goalEntries.push(entryOf(ctx, r.goal));
  }

  const activityEntries = [];
  for (const [i, o] of p.all("nutritionOrder").entries()) {
    const label = `nutritionOrder[${i}]`;
    const kind = str(o.get("kind"));
    const order = {
      resourceType: "NutritionOrder",
      status,
      intent: intent === "order" ? "order" : intent,
      patient: subject,
      dateTime: ctx.now,
      ...(addresses.length ? { extension: addresses.map((reference) => ({ url: `${base}/fhir/StructureDefinition/addresses-condition`, valueReference: { reference } })) } : {}),
    };
    if (kind === "oral-diet") {
      const oral = {};
      const type = str(o.get("type"));
      if (type) oral.type = [{ text: type }];
      const nutrients = [];
      for (const n of o.all("nutrient")) {
        const name = str(n.get("name"));
        const amount = n.get("amount") ? quantity(n.get("amount")) : null;
        if (!name || !amount) return bad(`${label}.nutrient needs 'name' and a numeric 'amount' Quantity.`);
        nutrients.push({ modifier: { text: name }, amount });
      }
      if (nutrients.length) oral.nutrient = nutrients;
      const textures = o.all("texture").map(str).filter(Boolean);
      if (textures.length) oral.texture = textures.map((t) => ({ modifier: { text: t } }));
      const fluids = o.all("fluidConsistency").map(str).filter(Boolean);
      if (fluids.length) oral.fluidConsistencyType = fluids.map((t) => ({ text: t }));
      const instr = str(o.get("instruction"));
      if (instr) oral.instruction = instr;
      if (Object.keys(oral).length === 0) return bad(`${label}: oral-diet needs at least one of type, nutrient, texture, fluidConsistency or instruction.`);
      order.oralDiet = oral;
    } else if (kind === "supplement") {
      const type = str(o.get("type"));
      const productName = str(o.get("productName"));
      if (!type && !productName) return bad(`${label}: supplement needs 'type' and/or 'productName'.`);
      const sup = {};
      if (type) sup.type = { text: type };
      if (productName) sup.productName = productName;
      if (o.get("quantity")) {
        const q = quantity(o.get("quantity"));
        if (!q) return bad(`${label}.quantity must be a Quantity with a numeric value.`);
        sup.quantity = q;
      }
      const instr = str(o.get("instruction"));
      if (instr) sup.instruction = instr;
      order.supplement = [sup];
    } else if (kind === "enteral-formula") {
      const formulaType = str(o.get("baseFormulaType"));
      const productName = str(o.get("productName"));
      if (!formulaType && !productName) return bad(`${label}: enteral-formula needs 'baseFormulaType' and/or 'productName'.`);
      const ef = {};
      if (formulaType) ef.baseFormulaType = { text: formulaType };
      if (productName) ef.baseFormulaProductName = productName;
      const route = str(o.get("route"));
      if (route) ef.routeofAdministration = { text: route };
      if (o.get("rate")) {
        const rate = quantity(o.get("rate"));
        if (!rate) return bad(`${label}.rate must be a Quantity with a numeric value.`);
        ef.administration = [{ rateQuantity: rate }];
      }
      if (o.get("maxVolume")) {
        const mv = quantity(o.get("maxVolume"));
        if (!mv) return bad(`${label}.maxVolume must be a Quantity with a numeric value.`);
        ef.maxVolumeToDeliver = mv;
      }
      const instr = str(o.get("instruction"));
      if (instr) ef.administrationInstruction = instr;
      order.enteralFormula = ef;
    } else {
      return bad(`${label}.kind must be oral-diet, supplement or enteral-formula.`);
    }
    activityEntries.push(entryOf(ctx, order));
  }

  const srSpecs = [
    ["education", "education", "Nutrition education", (x) => str(x.get("topic")), (x) => [str(x.get("audience")) && `Audience: ${str(x.get("audience"))}`, str(x.get("method")) && `Method: ${str(x.get("method"))}`, str(x.get("note"))], "topic"],
    ["counseling", "counseling", "Nutrition counseling", (x) => str(x.get("topic")), (x) => [str(x.get("approach")) && `Approach: ${str(x.get("approach"))}`, str(x.get("note"))], "topic"],
    ["coordination", "coordination", "Coordination of nutrition care", (x) => str(x.get("reason")), (x) => [str(x.get("with")) && `With: ${str(x.get("with"))}`, str(x.get("note"))], "reason"],
  ];
  for (const [param, domainCode, domainDisplay, textOf, notesOf, requiredName] of srSpecs) {
    for (const [i, x] of p.all(param).entries()) {
      const text = textOf(x);
      if (!text) return bad(`${param}[${i}].${requiredName} is required.`);
      const note = notesOf(x).filter(Boolean).join(" | ") || undefined;
      activityEntries.push(entryOf(ctx, serviceRequest(ctx, domainCode, domainDisplay, text, subject, status, intent === "order" ? "order" : intent, note)));
    }
  }

  if (activityEntries.length === 0 && goalEntries.length === 0) {
    return bad("Nothing to plan: supply at least one 'goal', 'nutritionOrder', 'education', 'counseling' or 'coordination' part.");
  }

  const carePlan = {
    resourceType: "CarePlan",
    status,
    intent: intent === "order" ? "order" : intent,
    category: [{ coding: [{ system: cs(base, "ncp-step"), code: STEP.intervention }] }],
    title: str(p.get("title")) ?? "Nutrition care plan",
    subject,
    created: ctx.now,
    period: { start: str(p.get("effectiveDateTime")) ?? ctx.now },
    ...(addresses.length ? { addresses: addresses.map((reference) => ({ reference })) } : {}),
    ...(goalEntries.length ? { goal: goalEntries.map((g) => ({ reference: g.fullUrl })) } : {}),
    ...(activityEntries.length ? { activity: activityEntries.map((a) => ({ reference: { reference: a.fullUrl } })) } : {}),
    note: [{ text: "Intervention content is clinician-supplied; Chakudya only validates and shapes it into FHIR. " + SCREENING_NOTE }],
  };
  const carePlanEntry = entryOf(ctx, carePlan);
  return okRes(collection([carePlanEntry, ...goalEntries, ...activityEntries]));
}

// ─── Goal/$evaluate — Monitoring & Evaluation ──────────────────────────────

function achievement(code) {
  return { coding: [{ system: GOAL_ACHIEVEMENT, code }] };
}

function evaluateOneGoal(g, label) {
  const description = str(g.get("description"));
  if (!description) return bad(`${label}.description is required.`);
  const direction = str(g.get("direction"));
  if (!["increase", "decrease", "maintain"].includes(direction)) return bad(`${label}.direction must be increase, decrease or maintain.`);
  const current = quantity(g.get("current"));
  if (!current) return bad(`${label}.current (Quantity, the measured value now) is required.`);
  const target = g.get("target") ? quantity(g.get("target")) : null;
  const baseline = g.get("baseline") ? quantity(g.get("baseline")) : null;
  const lower = g.get("lowerBound") ? quantity(g.get("lowerBound")) : null;
  const upper = g.get("upperBound") ? quantity(g.get("upperBound")) : null;

  for (const [name, q] of [["target", target], ["baseline", baseline], ["lowerBound", lower], ["upperBound", upper]]) {
    if (g.get(name) && !q) return bad(`${label}.${name} must be a Quantity with a numeric value.`);
    if (q && unitKey(q) !== unitKey(current)) {
      return bad(`${label}: unit mismatch — ${name} is "${unitKey(q) || "(none)"}" but current is "${unitKey(current) || "(none)"}". Convert to one unit; no silent conversion.`);
    }
  }
  const eps = isNum(g.get("noChangeTolerance")) ? g.get("noChangeTolerance") : 0.02;
  const cur = current.value;

  let status;
  let progress = null;
  let reason;

  if (direction === "maintain") {
    const lo = lower?.value ?? null;
    const hi = upper?.value ?? null;
    if (lo === null && hi === null) return bad(`${label}: 'maintain' goals need 'lowerBound' and/or 'upperBound'.`);
    const within = (lo === null || cur >= lo) && (hi === null || cur <= hi);
    status = within ? "sustaining" : "not-achieved";
    reason = within ? "Current value is within the maintenance range." : "Current value is outside the maintenance range.";
  } else {
    if (!target) return bad(`${label}.target is required for ${direction} goals.`);
    const reached = direction === "decrease" ? cur <= target.value : cur >= target.value;
    if (reached) {
      status = "achieved";
      progress = 1;
      reason = "Target reached.";
    } else if (!baseline) {
      status = "in-progress";
      reason = "No baseline supplied, so the direction of change cannot be assessed.";
    } else {
      const gap = direction === "decrease" ? baseline.value - target.value : target.value - baseline.value;
      if (gap <= 0) return bad(`${label}: baseline is already at/past the target in the ${direction} direction.`);
      const moved = direction === "decrease" ? baseline.value - cur : cur - baseline.value;
      progress = moved / gap;
      status = progress > eps ? "improving" : progress < -eps ? "worsening" : "no-change";
      reason = `Progress ${Math.round(progress * 100)}% of the way from baseline to target.`;
    }
  }
  return { ok: true, description, direction, current, target, baseline, status, progress, reason, measure: str(g.get("measure")), measureCode: str(g.get("measureCode")), measureSystem: str(g.get("measureSystem")) };
}

export function evaluateGoals(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;

  const subject = subjectRef(p.get("subject"));
  if (!subject) return bad("Parameter 'subject' is required (e.g. valueString \"Patient/123\").");
  const goals = p.all("goal");
  if (goals.length === 0) return bad("At least one 'goal' part is required.");
  if (goals.length > 50) return bad("At most 50 goals per request.");
  const effective = str(p.get("effectiveDateTime")) ?? ctx.now;

  const entries = [];
  for (const [i, g] of goals.entries()) {
    const r = evaluateOneGoal(g, `goal[${i}]`);
    if (!r.ok) return r;

    const obsEntry = entryOf(ctx, {
      resourceType: "Observation",
      status: "final",
      category: stepCategory(base, "monitoring"),
      code: r.measureCode
        ? { coding: [{ system: r.measureSystem ?? cs(base, "ncp-indicator"), code: r.measureCode, ...(r.measure ? { display: r.measure } : {}) }], text: r.measure ?? r.measureCode }
        : { text: r.measure ?? r.description },
      subject,
      effectiveDateTime: effective,
      valueQuantity: r.current,
    });

    const goal = {
      resourceType: "Goal",
      lifecycleStatus: "active",
      achievementStatus: achievement(r.status),
      category: [{ coding: [{ system: cs(base, "ncp-step"), code: STEP.monitoring }] }],
      description: { text: r.description },
      subject,
      statusDate: effective.slice(0, 10),
      outcomeReference: [{ reference: obsEntry.fullUrl }],
      note: [{ text: r.reason }],
      extension: [
        { url: `${base}/fhir/StructureDefinition/goal-direction`, valueCode: r.direction },
        ...(r.baseline ? [{ url: `${base}/fhir/StructureDefinition/goal-baseline`, valueQuantity: r.baseline }] : []),
        ...(r.progress !== null ? [{ url: `${base}/fhir/StructureDefinition/goal-progress-fraction`, valueDecimal: round(r.progress, 3) }] : []),
      ],
    };
    if (r.target) goal.target = [{ ...(r.measure ? { measure: { text: r.measure } } : {}), detailQuantity: r.target }];
    entries.push(entryOf(ctx, goal), obsEntry);
  }
  return okRes(collection(entries));
}

// ─── Bundle/$ncp-document — ADIME Composition ──────────────────────────────

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

function summarize(r) {
  switch (r.resourceType) {
    case "Observation": {
      const v = r.valueQuantity ? `${r.valueQuantity.value}${r.valueQuantity.unit ? " " + r.valueQuantity.unit : ""}` : r.valueInteger ?? r.valueString ?? r.valueBoolean ?? "";
      return `${bodyText(r.code) || "Observation"}${v !== "" ? ": " + v : ""}`;
    }
    case "Condition": return r.note?.[0]?.text ?? bodyText(r.code);
    case "Goal": return `Goal: ${r.description?.text ?? ""}${r.achievementStatus ? " (" + r.achievementStatus.coding?.[0]?.code + ")" : ""}`;
    case "NutritionOrder": return `Nutrition order (${r.oralDiet ? "oral diet" : r.supplement ? "supplement" : r.enteralFormula ? "enteral formula" : "order"})${r.oralDiet?.type?.[0]?.text ? ": " + r.oralDiet.type[0].text : ""}`;
    case "ServiceRequest": return `${bodyText(r.category?.[1]) || "Service"}: ${bodyText(r.code)}`;
    case "CarePlan": return `Care plan: ${r.title ?? ""}`;
    default: return r.resourceType;
  }
}

function narrative(resources) {
  const lis = resources.map((r) => `<li>${esc(summarize(r))}</li>`).join("");
  return { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><ul>${lis}</ul></div>` };
}

const DOC_RESOURCE_TYPES = new Set(["Observation", "Condition", "Goal", "NutritionOrder", "ServiceRequest", "CarePlan"]);

function stepOf(r) {
  switch (r.resourceType) {
    case "Condition": return "diagnosis";
    case "NutritionOrder": case "ServiceRequest": case "CarePlan": return "intervention";
    case "Goal": return r.achievementStatus ? "monitoring" : "intervention";
    case "Observation": {
      const codes = (r.category ?? []).flatMap((c) => c.coding ?? []).filter((c) => c.system?.endsWith("/CodeSystem/ncp-step")).map((c) => c.code);
      if (codes.includes(STEP.screening)) return "screening";
      if (codes.includes(STEP.monitoring)) return "monitoring";
      return "assessment"; // untagged Observations default to Assessment (documented)
    }
    default: return null;
  }
}

const SECTIONS = [
  { step: "screening", title: "Nutrition screening", optional: true },
  { step: "assessment", title: "Nutrition assessment" },
  { step: "diagnosis", title: "Nutrition diagnosis (PES)" },
  { step: "intervention", title: "Nutrition intervention" },
  { step: "monitoring", title: "Nutrition monitoring and evaluation" },
];

export function evaluateNcpDocument(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;

  const subject = subjectRef(p.get("subject"));
  if (!subject) return bad("Parameter 'subject' is required (e.g. valueString \"Patient/123\").");
  const author = authorRef(p.get("author"));
  if (!author) return bad("Parameter 'author' is required: a reference (\"Practitioner/123\") or the dietitian's name.");

  // Collect resources from `resource` params; a Bundle contributes its entries
  // (keeping their fullUrl so urn:uuid cross-references from earlier
  // operations stay valid).
  const collected = [];
  for (const r of p.all("resource")) {
    if (r && r.resourceType === "Bundle") {
      for (const en of r.entry ?? []) if (en?.resource) collected.push({ fullUrl: en.fullUrl, resource: en.resource });
    } else if (r && typeof r === "object" && r.resourceType) {
      collected.push({ fullUrl: undefined, resource: r });
    }
  }
  if (collected.length === 0) return bad("Supply one or more 'resource' parameters (resources or Bundles returned by the other NCP operations).");
  if (collected.length > 300) return bad("At most 300 resources per document.");

  const grouped = Object.fromEntries(SECTIONS.map((s) => [s.step, []]));
  for (const c of collected) {
    const t = c.resource.resourceType;
    if (!DOC_RESOURCE_TYPES.has(t)) return bad(`Resource type "${t}" is not supported in an NCP document (use Observation, Condition, Goal, NutritionOrder, ServiceRequest or CarePlan).`);
    const subj = c.resource.subject?.reference ?? c.resource.patient?.reference;
    if (subj && subj !== subject.reference) {
      return bad(`${t} has subject "${subj}" but the document subject is "${subject.reference}". One NCP document covers one patient.`);
    }
    const copy = { ...c.resource };
    if (t === "NutritionOrder") copy.patient = copy.patient ?? subject;
    else copy.subject = copy.subject ?? subject;
    grouped[stepOf(copy)].push({ fullUrl: c.fullUrl ?? newUuid(ctx), resource: copy });
  }

  const sections = [];
  for (const s of SECTIONS) {
    const items = grouped[s.step];
    if (items.length === 0) {
      if (s.optional) continue;
      sections.push({
        title: s.title,
        code: { coding: [{ system: cs(base, "ncp-step"), code: STEP[s.step] }] },
        emptyReason: { coding: [{ system: LIST_EMPTY_REASON, code: "notstarted" }] },
      });
      continue;
    }
    sections.push({
      title: s.title,
      code: { coding: [{ system: cs(base, "ncp-step"), code: STEP[s.step] }] },
      text: narrative(items.map((i) => i.resource)),
      entry: items.map((i) => ({ reference: i.fullUrl })),
    });
  }

  const composition = {
    resourceType: "Composition",
    status: "final",
    type: { coding: [{ system: cs(base, "ncp-document-type"), code: "adime-note", display: "Nutrition Care Process (ADIME) note" }] },
    subject,
    date: str(p.get("date")) ?? ctx.now,
    author: [author],
    title: str(p.get("title")) ?? "Nutrition Care Process note (ADIME)",
    ...(str(p.get("encounter")) ? { encounter: { reference: str(p.get("encounter")) } } : {}),
    section: sections,
  };

  const compEntry = entryOf(ctx, composition);
  const body2 = {
    resourceType: "Bundle",
    type: "document",
    timestamp: ctx.now,
    entry: [compEntry, ...SECTIONS.flatMap((s) => grouped[s.step])],
  };
  return okRes(body2);
}

// ─── Registry used by index.js ─────────────────────────────────────────────

export const NCP_OPERATIONS = {
  "Observation/$screen": evaluateScreen,
  "Observation/$assess-nutrition": evaluateAssessNutrition,
  "Condition/$diagnose": evaluateDiagnose,
  "CarePlan/$intervene": evaluateIntervene,
  "Goal/$evaluate": evaluateGoals,
  "Bundle/$ncp-document": evaluateNcpDocument,
};

export function ncpOperationFor(param, action) {
  return NCP_OPERATIONS[`${param}/${action}`] ?? null;
}
