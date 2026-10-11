// FHIR R4 facade — Nutrition Care Process (NCP), Phase 2.
//
// Phase 1 (src/fhir.js) covered one slice of NCP Step 1 (anthropometric
// growth classification). This module covers the whole process as the
// Academy of Nutrition and Dietetics defines it:
//
//   Screening  -> POST /fhir/Observation/$screen            (MUST, NRS-2002, MNA, SGA, PG-SGA, NACS classification)
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
// into FHIR. The nutrition diagnostic terminology (2006 edition, NI/NC/NB
// codes) lives in Supabase (table ncp_diagnosis_terms, sql/017) rather than
// in code: the Worker pre-fetches the codes a request names and passes them in
// as ctx.terms, which keeps these functions pure. A caller may still pass its
// own code (problemSystem + problemCode) through, or just free text.

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
export function readParams(params) {
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

export function requireParameters(body) {
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

export function stepCategory(base, step, extraCodings = []) {
  return [
    { coding: [{ system: cs(base, "ncp-step"), code: STEP[step] }] },
    ...extraCodings.map((c) => ({ coding: [c] })),
  ];
}

const bodyText = (concept) => concept?.text ?? concept?.coding?.[0]?.display ?? concept?.coding?.[0]?.code ?? "";

// ─── Shared adult anthropometry ────────────────────────────────────────────

export function whoAdultBmiClass(bmi) {
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

// ─── $screen — NRS-2002 (Nutritional Risk Screening, hospital adults) ──────
//
// Two-stage tool, implemented as printed in the supplied appendix:
//   Initial screening: 4 yes/no questions. All NO -> no final score, re-screen
//     weekly. Any YES -> final screening.
//   Final screening: nutritional-status score (0-3) + disease-severity score
//     (0-3) + 1 if age >= 70. Total >= 3 = nutritionally at risk.
// Disease severity and "impaired general condition" are clinical judgements,
// so they are inputs here, never guesses. The appendix's intake bands overlap
// (50-75 / 20-60 / 0-25 % of requirement): the highest applicable score is
// used and the overlap is stated in the note.

function nrsWeightLossScore(pct, months) {
  if (!(pct > 5) || !(months <= 3)) return 0;
  if (months <= 1 || pct > 15) return 3;
  if (months <= 2) return 2;
  return 1;
}

function nrsIntakeScore(pct) {
  const hits = [];
  if (pct >= 0 && pct <= 25) hits.push(3);
  if (pct >= 20 && pct <= 60) hits.push(2);
  if (pct >= 50 && pct <= 75) hits.push(1);
  return { score: hits.length ? Math.max(...hits) : 0, overlap: new Set(hits).size > 1 };
}

function evaluateNrs(p, ctx) {
  const base = ctx.base;
  const age = ageYearsFrom(p, ctx.now);
  if (!isNum(age)) return bad("NRS-2002 needs 'ageYears' or 'birthDate' (age 70 or over adds 1 point).");
  if (age < 18) return unprocessable("NRS-2002 here is for adults (18+).");

  let bmi = isNum(p.get("bmi")) ? p.get("bmi") : null;
  if (bmi === null) {
    const kg = p.get("weight") ? toKg(p.get("weight")) : null;
    const cm = p.get("height") ? toCm(p.get("height")) : null;
    if (kg === null || cm === null) return bad("Provide 'bmi' (decimal), or both 'weight' (kg/g) and 'height' (cm/m) Quantities.");
    bmi = kg / (cm / 100) ** 2;
  }
  if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) return bad("Computed/provided BMI is not plausible.");

  const lossPct = p.get("weightLossPercent");
  if (!isNum(lossPct) || lossPct < 0 || lossPct > 100) return bad("'weightLossPercent' (decimal 0-100, 0 if none) is required.");
  const lossMonths = p.get("weightLossPeriodMonths");
  if (lossPct > 0 && !(isNum(lossMonths) && lossMonths > 0)) return bad("'weightLossPeriodMonths' (decimal > 0) is required when weightLossPercent > 0.");
  const intake = p.get("intakePercentOfRequirement");
  if (!isNum(intake) || intake < 0 || intake > 150) return bad("'intakePercentOfRequirement' (0-150, intake over the preceding week as % of normal requirement) is required.");

  const impaired = p.get("impairedGeneralCondition");
  if (bmi <= 20.5 && typeof impaired !== "boolean") {
    return bad("'impairedGeneralCondition' (boolean) is required when BMI is 20.5 or below: the BMI criteria only count together with an impaired general condition.");
  }
  const sevScore = p.get("diseaseSeverityScore");
  if (sevScore !== undefined && !(Number.isInteger(sevScore) && sevScore >= 0 && sevScore <= 3)) {
    return bad("'diseaseSeverityScore' must be an integer 0-3 (0 absent, 1 mild, 2 moderate, 3 severe).");
  }

  // Initial screening
  const q = {
    "BMI < 20.5": bmi < 20.5,
    "weight loss within the last 3 months": lossPct > 0 && lossMonths <= 3,
    "reduced dietary intake in the last week": typeof p.get("reducedIntakeLastWeek") === "boolean" ? p.get("reducedIntakeLastWeek") : intake < 100,
    "severely ill (e.g. intensive therapy)": typeof p.get("severelyIll") === "boolean" ? p.get("severelyIll") : sevScore === 3,
  };
  const yes = Object.entries(q).filter(([, v]) => v).map(([k]) => k);
  const initialPositive = yes.length > 0;

  const obs = {
    resourceType: "Observation",
    status: "final",
    category: [...stepCategory(base, "screening"), { coding: [{ system: OBS_CATEGORY, code: "survey" }] }],
    code: { coding: [{ system: cs(base, "screening-tool"), code: "nrs-2002", display: "NRS-2002 (adult)" }], text: "NRS-2002 nutritional risk screening" },
    effectiveDateTime: str(p.get("effectiveDateTime")) ?? ctx.now,
  };
  const subj = p.get("subject") ? subjectRef(p.get("subject")) : null;
  if (subj) obs.subject = subj;
  const ind = (code, v) => ({ code: { coding: [{ system: cs(base, "ncp-indicator"), code }] }, ...v });
  const risk = (code) => ind("nrs-risk-category", { valueCodeableConcept: { coding: [{ system: cs(base, "nrs-risk"), code }] } });

  if (!initialPositive) {
    obs.component = [ind("nrs-initial-screening-positive", { valueBoolean: false }), risk("final-screening-not-required")];
    obs.interpretation = [{ coding: [{ system: V3_INTERPRETATION, code: "N" }] }];
    obs.note = [{ text: "Initial screening negative on all four questions: final screening is not performed. Re-screen at weekly intervals; consider a preventative nutritional care plan if a major operation is planned. " + SCREENING_NOTE }];
    return okRes(collection([entryOf(ctx, obs)]));
  }

  if (sevScore === undefined) {
    return bad(`Initial screening is positive (${yes.join("; ")}), so final screening is needed: 'diseaseSeverityScore' (integer 0-3) is required.`);
  }

  const wl = nrsWeightLossScore(lossPct, lossMonths);
  const bmiScore = bmi <= 20.5 && impaired ? (bmi < 18.5 ? 3 : 2) : 0;
  const intakeRes = nrsIntakeScore(intake);
  const status = Math.max(wl, bmiScore, intakeRes.score);
  const ageAdd = age >= 70 ? 1 : 0;
  const total = status + sevScore + ageAdd;
  const atRisk = total >= 3;

  obs.valueInteger = total;
  obs.interpretation = [{ coding: [{ system: V3_INTERPRETATION, code: atRisk ? "A" : "N" }] }];
  obs.component = [
    ind("nrs-initial-screening-positive", { valueBoolean: true }),
    ind("nrs-nutritional-status-score", { valueInteger: status }),
    ind("nrs-disease-severity-score", { valueInteger: sevScore }),
    ind("nrs-age-adjustment", { valueInteger: ageAdd }),
    risk(atRisk ? "at-risk" : "not-at-risk"),
    { code: { coding: [{ system: LOINC, code: "39156-5", display: "Body mass index (BMI)" }] }, valueQuantity: { value: round(bmi, 1), unit: "kg/m2", system: UCUM, code: "kg/m2" } },
  ];
  const drivers = [
    wl > 0 && `weight loss ${lossPct}% in ${lossMonths} month(s) = ${wl}`,
    bmiScore > 0 && `BMI ${round(bmi, 1)} with impaired general condition = ${bmiScore}`,
    intakeRes.score > 0 && `intake ${intake}% of requirement = ${intakeRes.score}${intakeRes.overlap ? " (the appendix's intake bands overlap here; the highest applicable score is used)" : ""}`,
  ].filter(Boolean);
  const mgmt = atRisk ? "Score 3 or more: nutritionally at risk — initiate a nutritional care plan." : "Score below 3: re-screen weekly; consider a preventative nutritional care plan if a major operation is planned.";
  obs.note = [{ text: `Initial screening YES: ${yes.join("; ")}. Nutritional status score ${status}${drivers.length ? " (" + drivers.join("; ") + ")" : ""}. ${mgmt} ${SCREENING_NOTE}` }];
  return okRes(collection([entryOf(ctx, obs)]));
}

// ─── $screen — MNA (Mini Nutritional Assessment, older adults) ─────────────
//
// Full MNA as printed on the supplied form (Nestlé Nutrition Institute,
// revision 2009). Screening items A-F (max 14); a screening score of 12-14 is
// normal and the form stops there, 11 or less continues to assessment items
// G-R (max 16). Total max 30: 24-30 normal, 17-23.5 at risk, < 17 malnourished.
// Items answered by an observation or a measurement (weight loss, BMI, fluid
// cups, protein markers, MAC, CC, meals) are scored here from the raw value;
// items that are a clinical or patient judgement are sent as the printed
// option score. The MNA-SF "calf circumference instead of BMI" substitution is
// not on this form and is not implemented.

const MNA_SCORE3 = [0, 1, 2];
const mnaBool = (key, name, rule, score) => ({ key, name, kind: "bool", rule: `must be a boolean (${rule})`, score });
const mnaChoice = (key, name, allowed, rule) => ({ key, name, kind: "choice", allowed, rule: `must be one of ${allowed.join(", ")} (${rule})`, score: (v) => v });
const mnaNum = (key, name, min, max, rule, score) => ({ key, name, kind: "num", min, max, rule: `must be a number between ${min} and ${max} (${rule})`, score });

const MNA_SCREENING_ITEMS = [
  mnaChoice("A", "foodIntakeDeclineScore", MNA_SCORE3, "food intake over the past 3 months: 0 severe decrease, 1 moderate decrease, 2 no decrease"),
  mnaChoice("C", "mobilityScore", MNA_SCORE3, "0 bed or chair bound, 1 gets out of bed/chair but does not go out, 2 goes out"),
  mnaBool("D", "psychologicalStressOrAcuteDisease", "psychological stress or acute disease in the past 3 months: true scores 0, false scores 2", (v) => (v ? 0 : 2)),
  mnaChoice("E", "neuropsychologicalScore", MNA_SCORE3, "0 severe dementia or depression, 1 mild dementia, 2 no psychological problems"),
];

const MNA_ASSESSMENT_ITEMS = [
  mnaBool("G", "livesIndependently", "not in a nursing home or hospital: true scores 1, false 0", (v) => (v ? 1 : 0)),
  mnaBool("H", "moreThan3PrescriptionDrugs", "more than 3 prescription drugs per day: true scores 0, false 1", (v) => (v ? 0 : 1)),
  mnaBool("I", "pressureSoresOrUlcers", "pressure sores or skin ulcers: true scores 0, false 1", (v) => (v ? 0 : 1)),
  mnaNum("J", "fullMealsPerDay", 0, 10, "full meals eaten daily: 1 or fewer scores 0, 2 scores 1, 3 or more scores 2", (v) => (v >= 3 ? 2 : v >= 2 ? 1 : 0)),
  mnaBool("K1", "dairyDaily", "at least one serving of dairy products per day", () => 0),
  mnaBool("K2", "legumesOrEggsTwiceWeekly", "two or more servings of legumes or eggs per week", () => 0),
  mnaBool("K3", "meatFishPoultryDaily", "meat, fish or poultry every day", () => 0),
  mnaBool("L", "fruitOrVegetablesTwoPlusServings", "two or more servings of fruit or vegetables per day: true scores 1, false 0", (v) => (v ? 1 : 0)),
  mnaNum("M", "fluidCupsPerDay", 0, 40, "cups of fluid per day: under 3 scores 0, 3 to 5 scores 0.5, over 5 scores 1", (v) => (v > 5 ? 1 : v >= 3 ? 0.5 : 0)),
  mnaChoice("N", "modeOfFeedingScore", MNA_SCORE3, "0 unable to eat without assistance, 1 self-fed with some difficulty, 2 self-fed without any problem"),
  mnaChoice("O", "selfViewNutritionScore", MNA_SCORE3, "0 views self as malnourished, 1 uncertain, 2 sees no nutritional problem"),
  mnaChoice("P", "selfViewHealthScore", [0, 0.5, 1, 2], "health compared with others of the same age: 0 not as good, 0.5 does not know, 1 as good, 2 better"),
  mnaNum("Q", "midArmCircumferenceCm", 5, 60, "MAC in cm: under 21 scores 0, 21 to 22 scores 0.5, over 22 scores 1", (v) => (v > 22 ? 1 : v >= 21 ? 0.5 : 0)),
  mnaNum("R", "calfCircumferenceCm", 10, 80, "CC in cm: under 31 scores 0, 31 or more scores 1", (v) => (v >= 31 ? 1 : 0)),
];

/** Reads and validates a list of item specs. Returns { err } on the first malformed value, else { vals, missing }. */
function mnaRead(p, specs) {
  const vals = {};
  const missing = [];
  for (const s of specs) {
    const v = p.get(s.name);
    if (v === undefined) { missing.push(s.name); continue; }
    const valid = s.kind === "bool" ? typeof v === "boolean" : s.kind === "choice" ? s.allowed.includes(v) : isNum(v) && v >= s.min && v <= s.max;
    if (!valid) return { err: bad(`'${s.name}' ${s.rule}.`) };
    vals[s.name] = v;
  }
  return { vals, missing };
}

const mnaScreeningCategory = (s) => (s >= 12 ? "normal" : s >= 8 ? "at-risk" : "malnourished");
const mnaTotalCategory = (t) => (t >= 24 ? "normal" : t >= 17 ? "at-risk" : "malnourished");

function evaluateMna(p, ctx) {
  const base = ctx.base;
  const age = ageYearsFrom(p, ctx.now);
  if (isNum(age) && age < 18) return unprocessable("MNA here is for adults (18+); it was developed for older adults.");

  // Screening: A, B (weight loss), C, D, E, F (BMI)
  const sc = mnaRead(p, MNA_SCREENING_ITEMS);
  if (sc.err) return sc.err;
  const missing = [...sc.missing];

  const lossUnknown = p.get("weightLossUnknown");
  if (lossUnknown !== undefined && typeof lossUnknown !== "boolean") return bad("'weightLossUnknown' must be a boolean (true when the patient does not know whether weight was lost: scores 1).");
  const lossKg = p.get("weightLossKg3Months");
  if (lossKg !== undefined && !(isNum(lossKg) && lossKg >= -100 && lossKg <= 100)) return bad("'weightLossKg3Months' must be a number in kg (weight lost over the last 3 months; 0 or negative if none).");
  if (lossUnknown !== true && lossKg === undefined) missing.push("weightLossKg3Months (or weightLossUnknown = true)");

  let bmi = isNum(p.get("bmi")) ? p.get("bmi") : null;
  if (bmi === null) {
    const kg = p.get("weight") ? toKg(p.get("weight")) : null;
    const cm = p.get("height") ? toCm(p.get("height")) : null;
    if (kg !== null && cm !== null) bmi = kg / (cm / 100) ** 2;
    else missing.push("bmi (or weight + height)");
  }
  if (missing.length) return bad(`MNA screening needs: ${missing.join(", ")}.`);
  if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) return bad("Computed/provided BMI is not plausible.");

  const bScore = lossUnknown === true ? 1 : lossKg > 3 ? 0 : lossKg >= 1 ? 2 : 3;
  const fScore = bmi < 19 ? 0 : bmi < 21 ? 1 : bmi < 23 ? 2 : 3;
  const itemScores = { A: MNA_SCREENING_ITEMS[0].score(sc.vals.foodIntakeDeclineScore), B: bScore };
  for (const s of MNA_SCREENING_ITEMS.slice(1)) itemScores[s.key] = s.score(sc.vals[s.name]);
  itemScores.F = fScore;
  const screeningScore = ["A", "B", "C", "D", "E", "F"].reduce((sum, k) => sum + itemScores[k], 0);
  const screenNotes = [];
  if (lossUnknown !== true && lossKg > 0 && lossKg < 1) screenNotes.push("the form has no band for a weight loss under 1 kg: scored as no weight loss (3)");
  if (isNum(age) && age < 65) screenNotes.push(`the MNA was developed for older adults and this patient is ${age}: interpret with care`);

  const obs = {
    resourceType: "Observation",
    status: "final",
    category: [...stepCategory(base, "screening"), { coding: [{ system: OBS_CATEGORY, code: "survey" }] }],
    code: { coding: [{ system: cs(base, "screening-tool"), code: "mna", display: "MNA (older adults)" }], text: "Mini Nutritional Assessment (MNA)" },
    effectiveDateTime: str(p.get("effectiveDateTime")) ?? ctx.now,
  };
  const subj = p.get("subject") ? subjectRef(p.get("subject")) : null;
  if (subj) obs.subject = subj;
  const ind = (code, v) => ({ code: { coding: [{ system: cs(base, "ncp-indicator"), code }] }, ...v });
  const score = (value) => ({ valueQuantity: { value, unit: "score", system: UCUM, code: "{score}" } });
  const category = (code) => ind("mna-risk-category", { valueCodeableConcept: { coding: [{ system: cs(base, "mna-risk"), code }] } });
  const bmiComponent = { code: { coding: [{ system: LOINC, code: "39156-5", display: "Body mass index (BMI)" }] }, valueQuantity: { value: round(bmi, 1), unit: "kg/m2", system: UCUM, code: "kg/m2" } };
  const interp = (cat) => [{ coding: [{ system: V3_INTERPRETATION, code: cat === "normal" ? "N" : cat === "at-risk" ? "A" : "AA" }] }];
  const itemList = (keys) => keys.map((k) => `${k} ${itemScores[k]}`).join(", ");
  const extra = screenNotes.length ? ` Note: ${screenNotes.join("; ")}.` : "";

  // Screening 12-14: the form stops here.
  if (screeningScore >= 12) {
    obs.interpretation = interp("normal");
    obs.component = [ind("mna-screening-score", { valueInteger: screeningScore }), category("normal"), bmiComponent];
    obs.note = [{ text: `MNA screening score ${screeningScore} of 14 (${itemList(["A", "B", "C", "D", "E", "F"])}): normal nutritional status (12-14). The form continues to the assessment only when the screening score is 11 or less.${extra} ${SCREENING_NOTE}` }];
    return okRes(collection([entryOf(ctx, obs)]));
  }

  // Screening 0-11: assessment G-R is required.
  const as = mnaRead(p, MNA_ASSESSMENT_ITEMS);
  if (as.err) return as.err;
  if (as.missing.length) return bad(`MNA screening score is ${screeningScore} (11 or less), so the assessment items are needed too: ${as.missing.join(", ")}.`);
  for (const s of MNA_ASSESSMENT_ITEMS) if (s.key[0] !== "K") itemScores[s.key] = s.score(as.vals[s.name]);
  const kYes = [as.vals.dairyDaily, as.vals.legumesOrEggsTwiceWeekly, as.vals.meatFishPoultryDaily].filter(Boolean).length;
  itemScores.K = kYes === 3 ? 1 : kYes === 2 ? 0.5 : 0;
  const assessmentScore = ["G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R"].reduce((sum, k) => sum + itemScores[k], 0);
  const total = screeningScore + assessmentScore;
  const cat = mnaTotalCategory(total);

  obs.interpretation = interp(cat);
  obs.valueQuantity = score(total).valueQuantity;
  obs.component = [
    ind("mna-screening-score", { valueInteger: screeningScore }),
    ind("mna-assessment-score", score(assessmentScore)),
    category(cat),
    bmiComponent,
  ];
  const label = { normal: "normal nutritional status (24-30)", "at-risk": "at risk of malnutrition (17-23.5)", malnourished: "malnourished (below 17)" }[cat];
  obs.note = [{ text: `MNA total ${total} of 30: ${label}. Screening ${screeningScore} of 14 (${itemList(["A", "B", "C", "D", "E", "F"])}; screening alone read ${mnaScreeningCategory(screeningScore).replace("-", " ")}), assessment ${assessmentScore} of 16 (${itemList(["G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R"])}).${extra} ${SCREENING_NOTE}` }];
  return okRes(collection([entryOf(ctx, obs)]));
}

// ─── $screen — SGA (Subjective Global Assessment, adults) ──────────────────
//
// As printed on the supplied NEMO / Queensland Health form (May 2009, adapted
// from Detsky 1994). The form lists descriptors under columns A, B and C and
// then an OVERALL SGA RATING of A, B or C. It gives NO rule for turning the
// items into the overall rating: that is the assessor's global judgement, so
// here it is a required clinician input and is never computed or suggested.
// What the API does: derives % weight loss from usual vs current weight and
// grades it, maps each history descriptor to its printed column(s), checks
// each physical-examination grade against the columns the form actually has
// for that site, and shapes everything into one Observation.
// Two descriptors sit in two columns on the form ("Increase (1 level above)":
// A and B; "Intake poor; no change": B and C): the clinician states which.
// The form's GI "None; intermittent / Some / All (daily > 2 week)" is read
// from the four symptoms: none daily > 2 weeks = A, one to three = B, all
// four = C. The A/B/C labels (well nourished ...) are Detsky's, not printed.

const SGA_GRADES = ["A", "B", "C"];
const SGA_DESCRIPTORS = {
  weightChange2Weeks: {
    label: "weight change past 2 weeks",
    codes: {
      "no-change-normal-weight": ["A"], "increase-within-5-percent": ["A"], "increase-1-level-above": ["A", "B"],
      "no-change-below-usual-weight": ["B"], "increase-within-5-10-percent": ["B"], decrease: ["C"],
    },
  },
  dietaryIntake: {
    label: "dietary intake",
    codes: {
      "no-change-adequate": ["A"], "no-change-inadequate": ["B"], "suboptimal-diet": ["B"], "full-liquid": ["B"],
      "hypocaloric-liquid": ["C"], starvation: ["C"], "borderline-increasing": ["A"], "borderline-decreasing": ["B"],
      "poor-no-change": ["B", "C"], "poor-increasing": ["B"], "poor-decreasing": ["C"],
    },
  },
  functionalCapacity: {
    label: "functional capacity",
    codes: { "no-dysfunction": ["A"], "difficulty-with-activities": ["B"], "bed-chair-ridden": ["C"] },
  },
  functionalChange2Weeks: {
    label: "functional capacity change past 2 weeks",
    codes: { improved: ["A"], "no-change": ["B"], regressed: ["C"] },
  },
};
const SGA_GI_PARAMS = ["nauseaDailyOver2Weeks", "vomitingDailyOver2Weeks", "diarrhoeaDailyOver2Weeks", "anorexiaDailyOver2Weeks"];
const SGA_EXAM = [
  { name: "underEyesFat", label: "Subcutaneous fat: under the eyes", grades: ["A", "C"] },
  { name: "tricepsFat", label: "Subcutaneous fat: triceps", grades: ["A", "C"] },
  { name: "bicepsFat", label: "Subcutaneous fat: biceps", grades: ["A", "C"] },
  { name: "temple", label: "Muscle wasting: temple", grades: SGA_GRADES },
  { name: "clavicle", label: "Muscle wasting: clavicle", grades: SGA_GRADES },
  { name: "shoulder", label: "Muscle wasting: shoulder", grades: SGA_GRADES },
  { name: "scapulaRibs", label: "Muscle wasting: scapula/ribs", grades: SGA_GRADES },
  { name: "quadriceps", label: "Muscle wasting: quadriceps", grades: SGA_GRADES },
  { name: "calf", label: "Muscle wasting: calf", grades: ["A", "C"] },
  { name: "knee", label: "Muscle wasting: knee", grades: ["A", "C"] },
  { name: "interosseousMuscle", label: "Muscle wasting: interosseous muscle between thumb and forefinger", grades: ["A", "C"] },
  { name: "oedema", label: "Oedema (related to malnutrition)", grades: SGA_GRADES },
  { name: "ascites", label: "Ascites (related to malnutrition)", grades: SGA_GRADES },
];

const sgaGradeOf = (v) => (typeof v === "string" ? v.trim().toUpperCase() : v);

/** Resolves a descriptor parameter to one printed grade. Returns { grade } or { err } or { missing }. */
function sgaDescriptor(p, name) {
  const spec = SGA_DESCRIPTORS[name];
  const code = str(p.get(name));
  if (code === undefined) return { missing: name };
  const grades = spec.codes[code];
  if (!grades) return { err: bad(`'${name}' (${spec.label}) must be one of: ${Object.keys(spec.codes).join(", ")}.`) };
  const chosen = sgaGradeOf(p.get(`${name}Grade`));
  if (grades.length === 1) {
    if (chosen !== undefined && chosen !== grades[0]) return { err: bad(`'${name}Grade' must be ${grades[0]} for '${code}' (the form lists it only in column ${grades[0]}).`) };
    return { grade: grades[0], code };
  }
  if (!grades.includes(chosen)) return { err: bad(`'${code}' sits in columns ${grades.join(" and ")} on the form: send '${name}Grade' as ${grades.join(" or ")}.`) };
  return { grade: chosen, code };
}

function evaluateSga(p, ctx) {
  const base = ctx.base;
  const age = ageYearsFrom(p, ctx.now);
  if (isNum(age) && age < 18) return unprocessable("SGA here is for adults (18+).");
  const missing = [];

  // Weight change over 6 months: 0-<5% loss = A, 5-10% = B, >10% = C
  let lossPct = isNum(p.get("weightLossPercent6Months")) ? p.get("weightLossPercent6Months") : null;
  if (lossPct !== null && (lossPct < -100 || lossPct > 100)) return bad("'weightLossPercent6Months' must be a percent between -100 and 100 (negative = weight gain).");
  if (lossPct === null) {
    const usual = p.get("usualWeight") ? toKg(p.get("usualWeight")) : null;
    const now = p.get("weight") ? toKg(p.get("weight")) : null;
    if (usual === null || now === null) missing.push("weightLossPercent6Months (or usualWeight + weight)");
    else if (!(usual > 0) || !(now > 0)) return bad("'usualWeight' and 'weight' must be positive.");
    else lossPct = ((usual - now) / usual) * 100;
  }

  const items = {};
  for (const name of Object.keys(SGA_DESCRIPTORS)) {
    const r = sgaDescriptor(p, name);
    if (r.err) return r.err;
    if (r.missing) missing.push(r.missing); else items[name] = r;
  }
  const gi = [];
  for (const name of SGA_GI_PARAMS) {
    const v = p.get(name);
    if (v === undefined) missing.push(name);
    else if (typeof v !== "boolean") return bad(`'${name}' must be a boolean (true when the symptom has been present daily for more than 2 weeks).`);
    else gi.push(v);
  }
  const overall = sgaGradeOf(p.get("overallRating"));
  if (overall === undefined) missing.push("overallRating (A, B or C: the assessor's global judgement)");
  else if (!SGA_GRADES.includes(overall)) return bad("'overallRating' must be A, B or C.");

  const exam = [];
  for (const site of SGA_EXAM) {
    const g = sgaGradeOf(p.get(site.name));
    if (g === undefined) continue;
    if (!site.grades.includes(g)) {
      return bad(`'${site.name}' (${site.label}) must be ${site.grades.length === 2 ? "A or C" : "A, B or C"}${site.grades.length === 2 ? ": the form has no column B descriptor for this site" : ""}.`);
    }
    exam.push({ site, grade: g });
  }
  if (missing.length) return bad(`SGA needs: ${missing.join(", ")}.`);

  const wlGrade = lossPct < 5 ? "A" : lossPct <= 10 ? "B" : "C";
  const giCount = gi.filter(Boolean).length;
  const giGrade = giCount === 0 ? "A" : giCount === gi.length ? "C" : "B";

  const obs = {
    resourceType: "Observation",
    status: "final",
    category: [...stepCategory(base, "screening"), { coding: [{ system: OBS_CATEGORY, code: "survey" }] }],
    code: { coding: [{ system: cs(base, "screening-tool"), code: "sga", display: "SGA (adult)" }], text: "Subjective Global Assessment (SGA)" },
    effectiveDateTime: str(p.get("effectiveDateTime")) ?? ctx.now,
    valueCodeableConcept: { coding: [{ system: cs(base, "sga-rating"), code: overall }] },
    interpretation: [{ coding: [{ system: V3_INTERPRETATION, code: overall === "A" ? "N" : overall === "B" ? "A" : "AA" }] }],
  };
  const subj = p.get("subject") ? subjectRef(p.get("subject")) : null;
  if (subj) obs.subject = subj;
  const ind = (code, v) => ({ code: { coding: [{ system: cs(base, "ncp-indicator"), code }] }, ...v });
  const grade = (code, g) => ind(code, { valueCodeableConcept: { coding: [{ system: cs(base, "sga-grade"), code: g }] } });
  obs.component = [
    ind("sga-weight-loss-percent-6-months", { valueQuantity: { value: round(lossPct, 1), unit: "%", system: UCUM, code: "%" } }),
    grade("sga-weight-change-6-months-grade", wlGrade),
    grade("sga-weight-change-2-weeks-grade", items.weightChange2Weeks.grade),
    grade("sga-dietary-intake-grade", items.dietaryIntake.grade),
    grade("sga-gi-symptoms-grade", giGrade),
    grade("sga-functional-capacity-grade", items.functionalCapacity.grade),
    grade("sga-functional-change-2-weeks-grade", items.functionalChange2Weeks.grade),
    ...exam.map((e) => ({
      code: { coding: [{ system: cs(base, "ncp-indicator"), code: "sga-physical-exam-finding" }], text: e.site.label },
      valueCodeableConcept: { coding: [{ system: cs(base, "sga-grade"), code: e.grade }] },
    })),
  ];
  const counts = SGA_GRADES.map((g) => `${exam.filter((e) => e.grade === g).length} ${g}`).join(", ");
  const label = { A: "A (well nourished)", B: "B (moderately malnourished or suspected malnutrition)", C: "C (severely malnourished)" }[overall];
  obs.note = [{
    text: `Overall SGA rating ${label}, as entered by the assessor: the form has no rule for combining the items, so none is computed. ` +
      `History grades: weight change 6 months ${wlGrade} (${round(lossPct, 1)}% loss), weight change 2 weeks ${items.weightChange2Weeks.grade}, dietary intake ${items.dietaryIntake.grade}, ` +
      `GI symptoms ${giGrade} (${giCount} of ${gi.length} daily for over 2 weeks), functional capacity ${items.functionalCapacity.grade}, functional change 2 weeks ${items.functionalChange2Weeks.grade}. ` +
      `Physical examination: ${exam.length} of ${SGA_EXAM.length} sites graded (${counts}). ${SCREENING_NOTE}`,
  }];
  return okRes(collection([entryOf(ctx, obs)]));
}

// ─── $screen — PG-SGA (Scored Patient-Generated Subjective Global Assessment) ──
//
// As printed on the supplied PG-SGA form (FD Ottery, v3.22.15, metric). Unlike
// the plain SGA this one is a scored tool: total = A (boxes 1-4) + B (disease,
// worksheet 2) + C (metabolic demand, worksheet 3) + D (physical exam,
// worksheet 4), then triaged 0-1 / 2-3 / 4-8 / 9 or more.
// What the form prints is implemented as printed: weight-loss points (1-month
// data, 6-month only when there is none, +1 for loss in the past 2 weeks),
// every item weight, fever intensity vs duration "whichever is greater", the
// steroid bands and the triage bands.
// What the supplied pages do NOT print, and what is assumed here (stated in the
// Observation note): how the two Box 2 answers combine (the higher is used),
// that Box 3 symptoms add (they are "check all that apply") and that the
// "other relevant diagnoses" line scores nothing (it has no tick box).
// Never computed: the physical-exam score D (the clinician's overall rating of
// total body deficit) and the Stage A/B/C global category (optional input).

const PGSGA_WEIGHT_2W = { decreased: 1, "not-changed": 0, increased: 0 };
const PGSGA_INTAKE_VS_USUAL = { unchanged: 0, "more-than-usual": 0, "less-than-usual": 1 };
const PGSGA_CURRENT_INTAKE = {
  "normal-food-less-than-normal-amount": 1, "little-solid-food": 2, "only-liquids": 3,
  "only-nutritional-supplements": 3, "very-little-of-anything": 4, "only-tube-feeding-or-parenteral": 0,
};
const PGSGA_SYMPTOMS = {
  "no-problems-eating": [0, "no problems eating"], "no-appetite": [3, "no appetite, just did not feel like eating"],
  nausea: [1, "nausea"], vomiting: [3, "vomiting"], constipation: [1, "constipation"], diarrhoea: [3, "diarrhoea"],
  "dry-mouth": [1, "dry mouth"], "mouth-sores": [2, "mouth sores"], "smells-bother-me": [1, "smells bother me"],
  "taste-changes": [1, "things taste funny or have no taste"], "feel-full-quickly": [1, "feel full quickly"],
  "problems-swallowing": [2, "problems swallowing"], fatigue: [1, "fatigue"], pain: [3, "pain"], other: [1, "other (for example depression, money or dental problems)"],
};
const PGSGA_ACTIVITY = {
  normal: 0, "fairly-normal-activities": 1, "in-bed-or-chair-less-than-half-day": 2,
  "little-activity-most-of-day-in-bed-or-chair": 3, "bed-ridden": 3,
};
const PGSGA_DISEASE = [
  ["cancer", "cancer"], ["aids", "AIDS"], ["pulmonaryOrCardiacCachexia", "pulmonary or cardiac cachexia"],
  ["chronicRenalInsufficiency", "chronic renal insufficiency"], ["decubitusOpenWoundOrFistula", "presence of decubitus, open wound or fistula"],
  ["trauma", "presence of trauma"],
];
const PGSGA_DEFICIT = { none: 0, mild: 1, moderate: 2, severe: 3 };
const PGSGA_RATINGS = [["muscleStatusRating", "Global muscle status rating"], ["fatStoresRating", "Global fat deficit rating"], ["fluidStatusRating", "Global fluid status rating"]];

/** Worksheet 1 points. months is 1 or 6; pct is positive for loss. */
function pgsgaWeightLossPoints(pct, months) {
  const bands = months === 1 ? [[10, 4], [5, 3], [3, 2], [2, 1]] : [[20, 4], [10, 3], [6, 2], [2, 1]];
  for (const [min, pts] of bands) if (pct >= min) return pts;
  return 0;
}

/** One period's % loss from a stated percent, else from an earlier weight + current weight. */
function pgsgaLoss(p, pctName, thenName, nowKg) {
  const direct = p.get(pctName);
  if (direct !== undefined) {
    if (!isNum(direct) || direct < -100 || direct > 100) return { err: bad(`'${pctName}' must be a percent between -100 and 100 (negative = weight gain).`) };
    return { pct: direct };
  }
  const q = p.get(thenName);
  if (q === undefined) return null;
  const then = toKg(q);
  if (then === null) return { err: bad(`'${thenName}' needs a recognised unit (kg or g).`) };
  if (!(then > 0)) return { err: bad(`'${thenName}' must be positive.`) };
  if (nowKg === null) return { err: bad(`'${thenName}' needs a current 'weight' in kg or g.`) };
  return { pct: ((then - nowKg) / then) * 100 };
}

function pgsgaTable(p, name, table, what) {
  const v = str(p.get(name));
  if (v === undefined) return { missing: name };
  if (!(v in table)) return { err: bad(`'${name}' (${what}) must be one of: ${Object.keys(table).join(", ")}.`) };
  return { code: v, points: table[v] };
}

function evaluatePgSga(p, ctx) {
  const base = ctx.base;
  const missing = [];
  const age = ageYearsFrom(p, ctx.now);
  if (!isNum(age)) missing.push("ageYears or birthDate");
  else if (age < 18) return unprocessable("PG-SGA here is for adults (18+).");

  // Box 1: weight (worksheet 1)
  let nowKg = null;
  if (p.get("weight") !== undefined) {
    nowKg = toKg(p.get("weight"));
    if (nowKg === null || !(nowKg > 0)) return bad("'weight' must be a positive Quantity in kg or g.");
  }
  const m1 = pgsgaLoss(p, "weightLossPercent1Month", "weightOneMonthAgo", nowKg);
  if (m1?.err) return m1.err;
  const m6 = pgsgaLoss(p, "weightLossPercent6Months", "weightSixMonthsAgo", nowKg);
  if (m6?.err) return m6.err;
  const period = m1 ? 1 : m6 ? 6 : null;
  const lossPct = m1 ? m1.pct : m6 ? m6.pct : null;
  if (period === null) missing.push("weightLossPercent1Month (or weightOneMonthAgo + weight), or the 6-month equivalent");
  const w2 = pgsgaTable(p, "pgsgaWeightChange2Weeks", PGSGA_WEIGHT_2W, "weight change over the past two weeks");
  if (w2.err) return w2.err;
  if (w2.missing) missing.push(w2.missing);

  // Box 2: food intake
  const vsUsual = pgsgaTable(p, "pgsgaIntakeVsUsual", PGSGA_INTAKE_VS_USUAL, "food intake over the past month compared with normal");
  if (vsUsual.err) return vsUsual.err;
  if (vsUsual.missing) missing.push(vsUsual.missing);
  let current = null;
  if (p.get("pgsgaCurrentIntake") !== undefined) {
    current = pgsgaTable(p, "pgsgaCurrentIntake", PGSGA_CURRENT_INTAKE, "what the patient is now taking");
    if (current.err) return current.err;
  }

  // Box 3: symptoms (repeatable, check all that apply)
  const picked = [...new Set(p.all("pgsgaSymptom").map(str).filter(Boolean))];
  for (const s of picked) if (!(s in PGSGA_SYMPTOMS)) return bad(`'pgsgaSymptom' must be one of: ${Object.keys(PGSGA_SYMPTOMS).join(", ")}.`);
  if (picked.length === 0) missing.push("pgsgaSymptom (repeatable; send no-problems-eating if none)");
  else if (picked.includes("no-problems-eating") && picked.length > 1) return bad("'pgsgaSymptom' no-problems-eating cannot be combined with other symptoms.");

  // Box 4: activities and function
  const act = pgsgaTable(p, "pgsgaActivity", PGSGA_ACTIVITY, "activity over the past month");
  if (act.err) return act.err;
  if (act.missing) missing.push(act.missing);

  // Worksheet 2: disease (age over 65 is derived)
  const disease = [];
  for (const [name, label] of PGSGA_DISEASE) {
    const v = p.get(name);
    if (v === undefined) continue;
    if (typeof v !== "boolean") return bad(`'${name}' must be a boolean (${label}).`);
    if (v) disease.push(label);
  }
  if (isNum(age) && age > 65) disease.push("age greater than 65");

  // Worksheet 3: metabolic demand (absent = none)
  const temp = p.get("feverTemperatureC");
  const hours = p.get("feverDurationHours");
  const dose = p.get("corticosteroidPrednisoneEquivalentMgPerDay");
  if (temp !== undefined && !(isNum(temp) && temp >= 30 && temp <= 45)) return bad("'feverTemperatureC' must be the highest temperature in degrees Celsius (30 to 45).");
  if (hours !== undefined && !(isNum(hours) && hours >= 0 && hours <= 1000)) return bad("'feverDurationHours' must be a number of hours (0 to 1000).");
  if (dose !== undefined && !(isNum(dose) && dose >= 0 && dose <= 1000)) return bad("'corticosteroidPrednisoneEquivalentMgPerDay' must be mg of prednisone equivalents per day (0 if none).");
  const feverOn = isNum(temp) && temp > 37.2;
  if (hours !== undefined && temp === undefined) return bad("'feverDurationHours' needs 'feverTemperatureC'.");
  if (feverOn && hours === undefined) return bad("'feverDurationHours' is required when 'feverTemperatureC' is above 37.2 (the form scores intensity or duration, whichever is greater).");
  const feverIntensity = !feverOn ? 0 : temp >= 38.8 ? 3 : temp >= 38.3 ? 2 : 1;
  const feverDuration = !feverOn ? 0 : hours > 72 ? 3 : hours === 72 ? 2 : 1;
  const feverScore = Math.max(feverIntensity, feverDuration);
  const steroidScore = !isNum(dose) || dose <= 0 ? 0 : dose >= 30 ? 3 : dose >= 10 ? 2 : 1;

  // Worksheet 4: physical exam overall deficit (the clinician's rating)
  const deficit = pgsgaTable(p, "physicalExamDeficit", PGSGA_DEFICIT, "overall rating of total body deficit");
  if (deficit.err) return deficit.err;
  if (deficit.missing) missing.push("physicalExamDeficit (none, mild, moderate or severe: the clinician's overall rating)");
  const ratings = [];
  for (const [name, label] of PGSGA_RATINGS) {
    const v = p.get(name);
    if (v === undefined) continue;
    if (!(Number.isInteger(v) && v >= 0 && v <= 3)) return bad(`'${name}' must be an integer 0-3 (0 no abnormality, 1 mild, 2 moderate, 3 severe).`);
    ratings.push({ label, v });
  }
  let globalCat;
  if (p.get("pgsgaGlobalCategory") !== undefined) {
    globalCat = sgaGradeOf(p.get("pgsgaGlobalCategory"));
    if (!SGA_GRADES.includes(globalCat)) return bad("'pgsgaGlobalCategory' must be A, B or C.");
  }
  if (missing.length) return bad(`PG-SGA needs: ${missing.join(", ")}.`);

  const wlPct = round(lossPct, 1);
  const wlPoints = pgsgaWeightLossPoints(wlPct, period);
  const box1 = wlPoints + w2.points;
  const box2 = Math.max(vsUsual.points, current ? current.points : 0);
  const symptoms = picked.map((s) => ({ code: s, points: PGSGA_SYMPTOMS[s][0], label: PGSGA_SYMPTOMS[s][1] }));
  const box3 = symptoms.reduce((a, s) => a + s.points, 0);
  const box4 = act.points;
  const A = box1 + box2 + box3 + box4;
  const B = disease.length;
  const C = feverScore + steroidScore;
  const D = deficit.points;
  const total = A + B + C + D;
  const triage = total <= 1 ? "no-intervention" : total <= 3 ? "education-and-symptom-management" : total <= 8 ? "dietitian-intervention" : "critical-need";
  const triageText = {
    "no-intervention": "no intervention required at this time; re-assess routinely during treatment",
    "education-and-symptom-management": "patient and family education by dietitian, nurse or other clinician, with pharmacologic intervention as indicated by the symptom survey (Box 3) and lab values as appropriate",
    "dietitian-intervention": "requires intervention by a dietitian, in conjunction with nurse or physician as indicated by symptoms (Box 3)",
    "critical-need": "indicates a critical need for improved symptom management and/or nutrient intervention options",
  }[triage];

  const obs = {
    resourceType: "Observation",
    status: "final",
    category: [...stepCategory(base, "screening"), { coding: [{ system: OBS_CATEGORY, code: "survey" }] }],
    code: { coding: [{ system: cs(base, "screening-tool"), code: "pg-sga", display: "PG-SGA (adult)" }], text: "Scored Patient-Generated Subjective Global Assessment (PG-SGA)" },
    effectiveDateTime: str(p.get("effectiveDateTime")) ?? ctx.now,
    valueInteger: total,
    interpretation: [{ coding: [{ system: V3_INTERPRETATION, code: total <= 1 ? "N" : total <= 8 ? "A" : "AA" }] }],
  };
  const subj = p.get("subject") ? subjectRef(p.get("subject")) : null;
  if (subj) obs.subject = subj;
  const ind = (code, v, text) => ({ code: { coding: [{ system: cs(base, "ncp-indicator"), code }], ...(text ? { text } : {}) }, ...v });
  const score = (code, n) => ind(code, { valueInteger: n });
  obs.component = [
    ind("pgsga-weight-loss-percent", { valueQuantity: { value: wlPct, unit: "%", system: UCUM, code: "%" } }, `Weight loss over ${period === 1 ? "1 month" : "6 months"} (positive = loss)`),
    score("pgsga-box1-weight-score", box1),
    score("pgsga-box2-food-intake-score", box2),
    score("pgsga-box3-symptoms-score", box3),
    score("pgsga-box4-activity-score", box4),
    score("pgsga-short-form-score", A),
    score("pgsga-disease-score", B),
    score("pgsga-metabolic-score", C),
    score("pgsga-physical-exam-score", D),
    ind("pgsga-triage-category", { valueCodeableConcept: { coding: [{ system: cs(base, "pgsga-triage"), code: triage }] } }),
    ...(globalCat ? [ind("pgsga-global-category", { valueCodeableConcept: { coding: [{ system: cs(base, "pgsga-category"), code: globalCat }] } })] : []),
    ...symptoms.filter((s) => s.code !== "no-problems-eating").map((s) => ind("pgsga-nutrition-impact-symptom", { valueInteger: s.points }, s.label)),
    ...ratings.map((r) => ind("pgsga-body-composition-rating", { valueInteger: r.v }, r.label)),
  ];
  const notes = [];
  if (m1 && m6) notes.push("both 1-month and 6-month weight data were sent: the form says to use 1-month data when available, so 6-month was not scored");
  if (period === 6) notes.push("no 1-month weight data, so the 6-month table was used");
  if (vsUsual.points !== (current ? current.points : 0) && current) notes.push("Box 2 takes the higher of the two answers (the supplied pages do not say how they combine)");
  notes.push("Box 3 symptoms are added (check all that apply)");
  if (feverOn) notes.push(`fever scored by the greater of intensity (${feverIntensity}) and duration (${feverDuration})`);
  const catText = globalCat ? ` Global PG-SGA category entered by the assessor: Stage ${globalCat} (not computed here).` : "";
  obs.note = [{
    text: `PG-SGA total ${total}: ${triageText}. ` +
      `A (boxes 1-4, the short form) ${A} = weight ${box1} (loss ${wlPct}% over ${period === 1 ? "1 month" : "6 months"} scores ${wlPoints}, past 2 weeks ${w2.code} scores ${w2.points}) + food intake ${box2} + symptoms ${box3} + activity ${box4}. ` +
      `B disease ${B} (${disease.length ? disease.join(", ") : "none flagged: conditions not sent are taken as absent"}). C metabolic demand ${C} (fever ${feverScore}, corticosteroids ${steroidScore}; not sent is taken as none). ` +
      `D physical exam ${D}, as rated by the clinician (${deficit.code} total body deficit).${catText} Notes: ${notes.join("; ")}. ${SCREENING_NOTE}`,
  }];
  return okRes(collection([entryOf(ctx, obs)]));
}

// ─── $screen — NACS classification (MUAC, BMI, BMI-for-age, bilateral pitting edema) ──
//
// As printed in the FANTA NACS User's Guide, Module 2 (May 2016, version 2),
// "Anthropometric assessment" and "Clinical assessment". Cutoffs are the
// guide's "recommended standards"; countries may use different ones.
// Implemented as printed: MUAC cutoffs for children 6-59 months, 5-9 and 10-14
// years and for adults (separate columns for pregnant/postpartum), the adult
// BMI bands, the BMI-for-age z-score bands (5-18 years), the pre-pregnancy
// BMI table, and bilateral pitting edema (severe malnutrition on its own,
// regardless of anthropometry; grade +++ inpatient, grades + and ++ outpatient
// only with appetite and no medical complications).
// Not in the guide, so not implemented: weight-for-height z-score cutoffs
// (the guide names the index but prints no cutoffs), MUAC cutoffs for 15-17
// year-olds or for pregnant women under 18, and any rule for combining
// several indicators into one status: each is reported on its own, and a
// top-level value is set only when exactly one indicator was classified.
// BMI is rounded to 1 decimal before banding, to match the 1-decimal cutoffs.

const NACS_STATUS = {
  sam: "severe acute malnutrition (SAM)", mam: "moderate acute malnutrition (MAM)", "severe-malnutrition": "severe malnutrition",
  "moderate-malnutrition": "moderate malnutrition", "mild-malnutrition": "mild malnutrition", normal: "normal nutritional status",
  overweight: "overweight", obesity: "obesity",
};
// [from months, to months (exclusive), label, SAM below mm, MAM below mm]
const NACS_CHILD_MUAC = [[6, 60, "6-59 months", 115, 125], [60, 120, "5-9 years", 135, 145], [120, 180, "10-14 years", 160, 185]];
const NACS_ADULT_MUAC = { standard: { label: "adults (not pregnant or postpartum)", sam: 185, mod: 220 }, pregnant: { label: "adults (pregnant or up to 6 months postpartum)", sam: 190, mod: 230 } };

function nacsAgeMonths(p, now) {
  const m = p.get("ageMonths");
  if (m !== undefined) return isNum(m) && Number.isInteger(m) && m >= 0 && m <= 1500 ? { months: m } : { err: bad("'ageMonths' must be a whole number of months (0 to 1500).") };
  const birth = str(p.get("birthDate"));
  if (birth) {
    const b = new Date(birth);
    const at = new Date(str(p.get("effectiveDateTime")) ?? now);
    if (isNaN(b) || isNaN(at)) return { err: bad("'birthDate' and 'effectiveDateTime' must be valid dates.") };
    let months = (at.getFullYear() - b.getFullYear()) * 12 + (at.getMonth() - b.getMonth());
    if (at.getDate() < b.getDate()) months -= 1;
    return months >= 0 ? { months } : { err: bad("'birthDate' is after the assessment date.") };
  }
  const y = p.get("ageYears");
  if (y !== undefined) {
    if (!isNum(y) || y < 0 || y > 120) return { err: bad("'ageYears' must be between 0 and 120.") };
    if (y < 5) return { err: bad("Under 5 years the classification depends on the month: send 'ageMonths' or 'birthDate'.") };
    return { months: Math.floor(y) * 12 };
  }
  return { months: null };
}

function nacsMuac(mm, ageMonths, pregnant) {
  if (ageMonths === null) return { err: bad("MUAC classification needs 'ageMonths', 'ageYears' (5 or over) or 'birthDate'.") };
  if (ageMonths < 6) return { err: unprocessable("The guide says MUAC is not currently recommended for infants under 6 months.") };
  if (ageMonths < 216) {
    if (pregnant) return { err: unprocessable("The guide prints pregnant/postpartum MUAC cutoffs for adults only; none for under 18.") };
    const row = NACS_CHILD_MUAC.find(([from, to]) => ageMonths >= from && ageMonths < to);
    if (!row) return { err: unprocessable("The guide prints MUAC cutoffs for children 6 months to 14 years; none for 15 to 17 years.") };
    const [, , label, sam, mam] = row;
    return { status: mm < sam ? "sam" : mm < mam ? "mam" : "normal", cutoffs: `children ${label}: SAM under ${sam} mm, MAM ${sam} to under ${mam} mm, normal ${mam} mm or more` };
  }
  const t = pregnant ? NACS_ADULT_MUAC.pregnant : NACS_ADULT_MUAC.standard;
  return { status: mm < t.sam ? "sam" : mm < t.mod ? "moderate-malnutrition" : "normal", cutoffs: `${t.label}: SAM under ${t.sam} mm, moderate malnutrition ${t.sam} to under ${t.mod} mm, normal ${t.mod} mm or more` };
}

const nacsAdultBmi = (b) => (b < 16 ? "severe-malnutrition" : b < 17 ? "moderate-malnutrition" : b < 18.5 ? "mild-malnutrition" : b < 25 ? "normal" : b < 30 ? "overweight" : "obesity");
const nacsBmiForAge = (z) => (z < -3 ? "severe-malnutrition" : z < -2 ? "moderate-malnutrition" : z <= 1 ? "normal" : z <= 2 ? "overweight" : "obesity");
const nacsPrePregnancyBmi = (b) => (b < 18.5 ? "underweight" : b < 25 ? "normal-weight" : b < 30 ? "overweight" : "obese");

function evaluateNacs(p, ctx) {
  const base = ctx.base;
  const ind = (code, v, text) => ({ code: { coding: [{ system: cs(base, "ncp-indicator"), code }], ...(text ? { text } : {}) }, ...v });
  const statusComp = (code, status) => ind(code, { valueCodeableConcept: { coding: [{ system: cs(base, "nacs-status"), code: status }] } });

  const edemaGrade = p.get("edemaGrade");
  if (edemaGrade !== undefined && !(Number.isInteger(edemaGrade) && edemaGrade >= 0 && edemaGrade <= 3)) return bad("'edemaGrade' must be an integer 0-3 (0 none, 1 grade +, 2 grade ++, 3 grade +++).");
  const pregnant = p.get("pregnantOrPostpartum");
  if (pregnant !== undefined && typeof pregnant !== "boolean") return bad("'pregnantOrPostpartum' must be a boolean (pregnant or up to 6 months postpartum).");
  const obs = {
    resourceType: "Observation",
    status: "final",
    category: [...stepCategory(base, "screening"), { coding: [{ system: OBS_CATEGORY, code: "survey" }] }],
    code: { coding: [{ system: cs(base, "screening-tool"), code: "nacs", display: "NACS classification" }], text: "NACS nutritional status classification (MUAC, BMI, BMI-for-age, bilateral pitting edema)" },
    effectiveDateTime: str(p.get("effectiveDateTime")) ?? ctx.now,
  };
  const subj = p.get("subject") ? subjectRef(p.get("subject")) : null;
  if (subj) obs.subject = subj;

  // Bilateral pitting edema: severe malnutrition on its own, whatever the anthropometry says
  let edemaNote = "";
  if (edemaGrade > 0) {
    const both = p.get("edemaBothFeetOrLegs");
    if (typeof both !== "boolean") return bad("'edemaBothFeetOrLegs' (boolean) is required when edemaGrade is above 0: the guide counts edema as a sign of severe malnutrition ONLY if it is in both feet or both legs.");
    if (both) {
      let disposition;
      if (edemaGrade === 3) disposition = "inpatient-sam-management";
      else {
        const appetite = p.get("hasAppetite");
        const complications = p.get("hasMedicalComplications");
        if (typeof appetite !== "boolean" || typeof complications !== "boolean") return bad("'hasAppetite' and 'hasMedicalComplications' (booleans) are required for edema grade 1 or 2: the guide's outpatient route is for grades + and ++ with appetite and no medical complications.");
        disposition = appetite && !complications ? "outpatient-sam-treatment" : "not-stated-by-guide";
      }
      obs.valueCodeableConcept = { coding: [{ system: cs(base, "nacs-status"), code: "sam" }] };
      obs.component = [
        ind("nacs-edema-grade", { valueInteger: edemaGrade }, ["", "+", "++", "+++"][edemaGrade]),
        ind("nacs-edema-disposition", { valueCodeableConcept: { coding: [{ system: cs(base, "nacs-disposition"), code: disposition }] } }),
      ];
      const dispText = {
        "inpatient-sam-management": "grade +++ is admitted for inpatient management of severe acute malnutrition, even with appetite and no medical complications",
        "outpatient-sam-treatment": `grade ${["", "+", "++"][edemaGrade]} with appetite and no medical complications is treated for severe acute malnutrition on an outpatient basis`,
        "not-stated-by-guide": `the guide states the outpatient route only for grades + and ++ with appetite and no medical complications; for this case it says nothing, so the clinician decides`,
      }[disposition];
      obs.note = [{ text: `Bilateral pitting edema grade ${["", "+", "++", "+++"][edemaGrade]}: severe acute malnutrition on its own, regardless of anthropometric results, so no anthropometric indicator was classified. In adults edema often has non-nutritional causes (for example heart, lymphatic or kidney disease), which the clinician rules out. Management per the guide: ${dispText}. ${SCREENING_NOTE}` }];
      return okRes(collection([entryOf(ctx, obs)]));
    }
    edemaNote = " Edema was reported but not in both feet or legs, so it was not counted as a sign of severe malnutrition.";
  }

  const age = nacsAgeMonths(p, ctx.now);
  if (age.err) return age.err;
  const results = [];
  const comps = [];
  const cutoffNotes = [];
  const notes = [];

  // MUAC
  const muac = p.get("muacMm");
  if (muac !== undefined) {
    if (!(isNum(muac) && muac >= 50 && muac <= 500)) return bad("'muacMm' must be the MUAC in millimetres (50 to 500).");
    const r = nacsMuac(muac, age.months, pregnant === true);
    if (r.err) return r.err;
    results.push({ kind: "MUAC", status: r.status });
    comps.push(ind("nacs-muac", { valueQuantity: { value: muac, unit: "mm", system: UCUM, code: "mm" } }), statusComp("nacs-muac-status", r.status));
    cutoffNotes.push(`MUAC ${muac} mm, ${r.cutoffs}`);
    if (edemaGrade > 0) notes.push("the guide says MUAC should not be used to assess nutritional status in people with edema: interpret with care");
  }

  // BMI (adults) / BMI-for-age (5-17 years)
  const hasBmiInput = p.get("bmi") !== undefined || (p.get("weight") !== undefined && p.get("height") !== undefined);
  if (hasBmiInput && pregnant === true) return unprocessable("The guide says BMI is not an accurate indicator of nutritional status in pregnant women: use MUAC (and 'prePregnancyBmi' for the pre-pregnancy category).");
  const z = p.get("bmiForAgeZScore");
  if (z !== undefined && !(isNum(z) && z >= -10 && z <= 10)) return bad("'bmiForAgeZScore' must be a z-score between -10 and 10.");
  if (z !== undefined) {
    if (age.months === null) return bad("BMI-for-age needs 'ageMonths', 'ageYears' (5 or over) or 'birthDate'.");
    if (age.months < 60 || age.months >= 216) return unprocessable("The guide uses BMI-for-age for children and adolescents 5 to 17 years; adults (18 and over) use BMI.");
    const status = nacsBmiForAge(z);
    results.push({ kind: "BMI-for-age", status });
    comps.push(ind("nacs-bmi-for-age-z-score", { valueQuantity: { value: round(z, 2), unit: "z-score", system: UCUM, code: "{z-score}" } }), statusComp("nacs-bmi-for-age-status", status));
    cutoffNotes.push(`BMI-for-age z-score ${round(z, 2)}: under -3 severe, -3 to under -2 moderate, -2 to +1 normal, over +1 to +2 overweight, over +2 obesity`);
  }
  if (hasBmiInput && z === undefined) {
    if (age.months === null) return bad("BMI classification needs 'ageMonths', 'ageYears' (5 or over) or 'birthDate'.");
    if (age.months < 216) return bad("Under 18 the guide uses the BMI-for-age z-score, which needs age- and sex-specific WHO reference tables: send 'bmiForAgeZScore' (Observation/$evaluate-growth computes it from 5 to 19 years).");
    let bmi = isNum(p.get("bmi")) ? p.get("bmi") : null;
    if (bmi === null) {
      const kg = toKg(p.get("weight"));
      const cm = toCm(p.get("height"));
      if (kg === null || cm === null) return bad("Provide 'bmi', or both 'weight' (kg/g) and 'height' (cm/m) Quantities.");
      bmi = kg / (cm / 100) ** 2;
    }
    if (!Number.isFinite(bmi) || bmi < 5 || bmi > 100) return bad("Computed/provided BMI is not plausible.");
    const b = round(bmi, 1);
    const status = nacsAdultBmi(b);
    results.push({ kind: "BMI", status });
    comps.push(ind("nacs-bmi", { valueQuantity: { value: b, unit: "kg/m2", system: UCUM, code: "kg/m2" } }), statusComp("nacs-bmi-status", status));
    cutoffNotes.push(`BMI ${b}: under 16 severe, 16 to under 17 moderate, 17 to under 18.5 mild, 18.5 to under 25 normal, 25 to under 30 overweight, 30 or more obesity`);
    if (edemaGrade > 0) notes.push("the guide says BMI is not accurate in adults with edema and MUAC should be used instead, but also says MUAC is not for people with edema: the clinician decides");
  }

  // Pre-pregnancy BMI category (recommended pre-pregnancy BMI table)
  const pre = p.get("prePregnancyBmi");
  if (pre !== undefined) {
    if (!(isNum(pre) && pre >= 5 && pre <= 100)) return bad("'prePregnancyBmi' must be a plausible BMI in kg/m2.");
    const cat = nacsPrePregnancyBmi(round(pre, 1));
    comps.push(ind("nacs-pre-pregnancy-bmi", { valueQuantity: { value: round(pre, 1), unit: "kg/m2", system: UCUM, code: "kg/m2" } }),
      ind("nacs-pre-pregnancy-bmi-category", { valueCodeableConcept: { coding: [{ system: cs(base, "nacs-prepregnancy-bmi"), code: cat }] } }));
    cutoffNotes.push(`pre-pregnancy BMI ${round(pre, 1)}: ${cat.replace("-", " ")} (under 18.5 underweight, 18.5-24.9 normal weight, 25.0-29.9 overweight, 30 or more obese)`);
  }

  if (comps.length === 0) return bad("NACS needs something to classify: 'muacMm', 'bmi' (or 'weight' + 'height'; 'bmiForAgeZScore' under 18), 'prePregnancyBmi', or 'edemaGrade' above 0 with 'edemaBothFeetOrLegs' true.");
  if (edemaGrade !== undefined) comps.push(ind("nacs-edema-grade", { valueInteger: edemaGrade }, ["none", "+", "++", "+++"][edemaGrade]));
  obs.component = comps;
  if (results.length === 1) obs.valueCodeableConcept = { coding: [{ system: cs(base, "nacs-status"), code: results[0].status }] };
  const summary = results.length === 0 ? "No nutritional status indicator was classified."
    : results.length === 1 ? `${results[0].kind}: ${NACS_STATUS[results[0].status]}.`
      : `${results.map((r) => `${r.kind}: ${NACS_STATUS[r.status]}`).join("; ")}. The guide gives no rule for combining indicators, so each is reported on its own and there is no single value.`;
  obs.note = [{ text: `${summary} Cutoffs used: ${cutoffNotes.join("; ")}.${notes.length ? ` Note: ${notes.join("; ")}.` : ""}${edemaNote} The cutoffs are the NACS guide's recommended standards; countries may use different ones. ${SCREENING_NOTE}` }];
  return okRes(collection([entryOf(ctx, obs)]));
}

// ─── $screen — MUST (Malnutrition Universal Screening Tool, adults) ────────

export function evaluateScreen(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;

  const tool = str(p.get("tool")) ?? "must";
  if (tool === "nrs-2002") return evaluateNrs(p, ctx);
  if (tool === "mna") return evaluateMna(p, ctx);
  if (tool === "sga") return evaluateSga(p, ctx);
  if (tool === "pg-sga") return evaluatePgSga(p, ctx);
  if (tool === "nacs") return evaluateNacs(p, ctx);
  if (tool !== "must") return bad("'tool' must be must (default), nrs-2002, mna, sga, pg-sga or nacs.");

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

export const ASSESSMENT_DOMAINS = {
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

const TERM_CODE_RE = /^N[ICB]-\d{1,2}\.\d{1,2}$/i;

/** Codes (NI-5.2 style, no problemSystem) a $diagnose body asks to resolve —
 * the Worker fetches exactly these from ncp_diagnosis_terms. */
export function diagnosisCodesRequested(body) {
  const out = new Set();
  for (const d of readParams(body).all("diagnosis")) {
    const code = str(d?.get?.("problemCode"));
    if (code && !str(d.get("problemSystem")) && TERM_CODE_RE.test(code)) out.add(code.toUpperCase());
  }
  return [...out].slice(0, 50);
}

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
    const sys = str(d.get("problemSystem"));
    const code = str(d.get("problemCode"));

    // Resolve an NI-/NC-/NB- code against the Supabase terminology (unless
    // the caller names its own code system).
    let term = null;
    if (code && !sys && TERM_CODE_RE.test(code)) {
      if (ctx.termsError) return bad(`Nutrition diagnosis terminology lookup failed (${ctx.termsError}). Has sql/017_add_ncp_diagnosis_terms.sql been run?`, 503);
      term = ctx.terms?.[code.toUpperCase()];
      if (!term) return bad(`${label}.problemCode "${code}" is not in the NCP diagnostic terminology (2006 edition). See GET /fhir/CodeSystem/ncp-diagnosis.`);
    }

    const domain = str(d.get("domain")) ?? term?.domain;
    if (!PES_DOMAINS[domain]) return bad(`${label}.domain must be intake, clinical or behavioral-environmental.`);
    if (term && domain !== term.domain) return bad(`${label}: domain "${domain}" conflicts with ${term.code}, which is a ${term.domain} term.`);

    const specify = str(d.get("problemSpecify"));
    if (term?.specify_required && !specify) {
      const hint = term.specify_options?.length ? ` (e.g. ${term.specify_options.join(", ")})` : "";
      return bad(`${label}: ${term.code} "${term.term}" is a "(specify)" term — add 'problemSpecify'${hint}.`);
    }
    const problem = str(d.get("problem")) ?? (term ? `${term.term}${specify ? ` (${specify})` : ""}` : undefined);
    if (!problem) return bad(`${label}.problem (the nutrition diagnosis label) is required unless 'problemCode' is an NI/NC/NB term.`);

    const etiology = d.all("etiology").map(str).filter(Boolean);
    const signs = d.all("signsSymptoms").map(str).filter(Boolean);
    if (etiology.length === 0) return bad(`${label}: a PES statement needs at least one 'etiology' (the "related to" part).`);
    if (signs.length === 0) return bad(`${label}: a PES statement needs at least one 'signsSymptoms' (the "as evidenced by" part).`);
    const severity = str(d.get("severity"));
    if (severity !== undefined && !SEVERITY[severity]) return bad(`${label}.severity must be mild, moderate or severe.`);
    const status = str(d.get("verificationStatus")) ?? "provisional";
    if (!["provisional", "confirmed"].includes(status)) return bad(`${label}.verificationStatus must be provisional or confirmed.`);

    const coding = [];
    if (term) coding.push({ system: cs(base, "ncp-diagnosis"), version: term.edition ?? "2006", code: term.code, display: term.term });
    else if (sys && code) coding.push({ system: sys, code, display: str(d.get("problemDisplay")) ?? problem });
    else if (code && PROBLEM_SHORTCUTS[code]) coding.push(...PROBLEM_SHORTCUTS[code]);
    else if (code) return bad(`${label}.problemCode "${code}" needs a 'problemSystem', or use an NI-/NC-/NB- code, or one of: ${Object.keys(PROBLEM_SHORTCUTS).join(", ")}.`);

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
      note: [
        { text: pes },
        ...(term?.use_with_caution ? [{ text: `Terminology flags "${term.term}" as use with caution.` }] : []),
      ],
      extension: [
        { url: `${base}/fhir/StructureDefinition/pes-etiology`, valueString: etiology.join("; ") },
        { url: `${base}/fhir/StructureDefinition/pes-signs-symptoms`, valueString: signs.join("; ") },
        ...(specify ? [{ url: `${base}/fhir/StructureDefinition/pes-specify`, valueString: specify }] : []),
      ],
    };
    if (severity) cond.severity = { coding: [{ system: SNOMED, ...SEVERITY[severity] }] };
    entries.push(entryOf(ctx, cond));
  }
  return okRes(collection(entries));
}

/** FHIR CodeSystem for the nutrition diagnostic terminology, from the
 * ncp_diagnosis_terms rows (GET /fhir/CodeSystem/ncp-diagnosis). */
export function buildNcpCodeSystem(base, rows) {
  const prop = (code, description, type) => ({ code, description, type });
  return {
    resourceType: "CodeSystem",
    id: "ncp-diagnosis",
    url: cs(base, "ncp-diagnosis"),
    version: "2006",
    name: "NcpDiagnosisTerminology",
    title: "Nutrition Care Process nutrition diagnostic terminology (2006 edition)",
    status: "active",
    date: "2026-10-10",
    publisher: "Chakudya Nutrition Registry",
    description:
      "Nutrition diagnostic terms (Intake NI, Clinical NC, Behavioral-Environmental NB), 2006 edition. " +
      "The terminology belongs to the Academy of Nutrition and Dietetics; it is served here as reference data for coding PES statements.",
    caseSensitive: true,
    content: "complete",
    count: rows.length,
    property: [
      prop("domain", "intake | clinical | behavioral-environmental", "code"),
      prop("class", "Terminology class name", "string"),
      prop("specify-required", "The term is marked (specify) in the terminology", "boolean"),
      prop("use-with-caution", "The term is marked (use with caution) in the terminology", "boolean"),
    ],
    concept: rows.map((r) => ({
      code: r.code,
      display: r.term,
      property: [
        { code: "domain", valueCode: r.domain },
        { code: "class", valueString: r.class_name },
        { code: "specify-required", valueBoolean: !!r.specify_required },
        { code: "use-with-caution", valueBoolean: !!r.use_with_caution },
      ],
    })),
  };
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
