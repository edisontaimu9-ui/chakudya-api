// FHIR R4 façade for growth/anthropometry — Phase 1 groundwork for future
// EHR/HIE integration (OpenHIM registration comes later; nothing here talks
// to OpenHIM or any external HIE yet). This is a stateless TRANSLATION
// LAYER, not a FHIR server with storage: every /fhir/* route reshapes a
// call to chakudya-api's existing classify endpoints into/out of FHIR JSON.
// No patient data is stored here — Chakudya has never been a record-store
// EHR, and this doesn't change that; a real EHR is expected to persist the
// returned Observation itself.
//
// Scope, honestly: only the two growth references chakudya-api itself has
// (as of 2026-09-25) are wired up — Fenton preterm (22-50 weeks gestation,
// sql/013_add_fenton_preterm.sql) and WHO 2007 BMI-for-age (5y1m-19y0m,
// sql/012_add_bmi_for_age.sql). WHO child growth standards for postnatal
// 0-59 months are NOT available through this facade, because chakudya-api
// has no such endpoint yet — $evaluate-growth returns a FHIR OperationOutcome
// for that age gap rather than silently guessing or misrouting.
//
// Every Observation this produces carries the same screening-aid language
// as the underlying classify endpoints — a FHIR shape doesn't change that
// this is decision support, not a diagnosis.

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const V3_INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";

const LOINC_CODES = {
  weight: { code: "29463-7", display: "Body weight" },
  length: { code: "8302-2", display: "Body height" },
  hc: { code: "9843-4", display: "Head circumference" },
  bmi: { code: "39156-5", display: "Body mass index (BMI)" },
};

function codeSystemUrl(base, name) {
  return `${base}/fhir/CodeSystem/${name}`;
}

// ─── OperationOutcome / Parameters helpers ─────────────────────────────────

export function operationOutcome(severity, diagnostics, code = "invalid") {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  };
}

function fhirError(diagnostics) {
  return { error: diagnostics, outcome: operationOutcome("error", diagnostics) };
}

/** Reads a FHIR Parameters resource's flat parameters into a plain object:
 * { name: value }, using whichever value[x]/part field is present. Only
 * supports the shapes $evaluate-growth actually uses — not a general FHIR
 * Parameters parser. */
function flattenParameters(params) {
  const out = {};
  for (const p of params?.parameter ?? []) {
    if (!p?.name) continue;
    if (Array.isArray(p.part)) {
      out[p.name] = out[p.name] || [];
      const entry = {};
      for (const sub of p.part) {
        if (!sub?.name) continue;
        entry[sub.name] = readValue(sub);
      }
      out[p.name].push(entry);
      continue;
    }
    out[p.name] = readValue(p);
  }
  return out;
}

function readValue(p) {
  if (p.valueQuantity) return p.valueQuantity;
  if (p.valueCode !== undefined) return p.valueCode;
  if (p.valueString !== undefined) return p.valueString;
  if (p.valueDecimal !== undefined) return p.valueDecimal;
  if (p.valueInteger !== undefined) return p.valueInteger;
  if (p.valueDate !== undefined) return p.valueDate;
  if (p.valueDateTime !== undefined) return p.valueDateTime;
  return undefined;
}

// ─── Unit conversion (FHIR Quantity -> chakudya-api's native units) ───────

function toGrams(q) {
  if (!q || typeof q.value !== "number") return null;
  const unit = (q.code || q.unit || "").toLowerCase();
  if (unit === "g") return q.value;
  if (unit === "kg") return q.value * 1000;
  return null; // unrecognized unit — caller treats as invalid rather than guessing
}
function toKg(q) {
  const g = toGrams(q);
  return g === null ? null : g / 1000;
}
function toCm(q) {
  if (!q || typeof q.value !== "number") return null;
  const unit = (q.code || q.unit || "").toLowerCase();
  if (unit === "cm") return q.value;
  if (unit === "m") return q.value * 100;
  return null;
}

// ─── $evaluate-growth: parse input ─────────────────────────────────────────

/**
 * Parses a FHIR Parameters body for the $evaluate-growth operation.
 * Expected parameters: sex (code), one of {gestationalAgeWeeks(+gestationalAgeDays)}
 * or {birthDate}, optional referenceYear/effectiveDateTime, and one or more
 * `measurement` parts each with type (weight|length|hc|bmi) + value (Quantity).
 * Returns a normalized plan or { error, outcome }.
 */
export function parseEvaluateGrowth(body, now = new Date()) {
  if (!body || body.resourceType !== "Parameters") {
    return fhirError("Body must be a FHIR Parameters resource (resourceType: \"Parameters\").");
  }
  const p = flattenParameters(body);

  const sex = typeof p.sex === "string" ? p.sex.toLowerCase() : null;
  if (!["male", "female"].includes(sex)) {
    return fhirError("Parameter 'sex' is required: male or female (FHIR administrative-gender codes).");
  }

  const measurements = Array.isArray(p.measurement) ? p.measurement : [];
  if (measurements.length === 0) {
    return fhirError("At least one 'measurement' part ({type, value}) is required.");
  }
  for (const m of measurements) {
    if (!["weight", "length", "hc", "bmi"].includes(m.type)) {
      return fhirError(`measurement.type must be weight, length, hc, or bmi (got "${m.type}").`);
    }
  }

  const effectiveDateTime = typeof p.effectiveDateTime === "string" ? p.effectiveDateTime : now.toISOString();

  const hasGestAge = typeof p.gestationalAgeWeeks === "number";
  const hasBirthDate = typeof p.birthDate === "string";
  if (!hasGestAge && !hasBirthDate) {
    return fhirError(
      "Provide either 'gestationalAgeWeeks' (+ optional 'gestationalAgeDays') for a preterm/gestational-age " +
        "evaluation, or 'birthDate' for a postnatal-age evaluation."
    );
  }

  return {
    sex,
    measurements,
    effectiveDateTime,
    gestationalAgeWeeks: hasGestAge ? p.gestationalAgeWeeks : null,
    gestationalAgeDays: typeof p.gestationalAgeDays === "number" ? p.gestationalAgeDays : 0,
    referenceYear: typeof p.referenceYear === "number" ? p.referenceYear : undefined,
    birthDate: hasBirthDate ? p.birthDate : null,
  };
}

function postnatalAgeMonths(birthDate, effectiveDateTime) {
  const birth = new Date(birthDate);
  const at = new Date(effectiveDateTime);
  if (isNaN(birth) || isNaN(at)) return null;
  const months = (at.getFullYear() - birth.getFullYear()) * 12 + (at.getMonth() - birth.getMonth());
  return at.getDate() < birth.getDate() ? months - 1 : months;
}

/**
 * Decides which chakudya-api backend covers this request, given what
 * parseEvaluateGrowth() returned. Returns { route: "fenton" } or
 * { route: "bmi-for-age" } or { error, outcome } — never guesses when the
 * age falls in the WHO-0-59-month gap this facade doesn't cover yet.
 */
export function decideGrowthRoute(parsed) {
  if (parsed.gestationalAgeWeeks !== null) {
    if (parsed.gestationalAgeWeeks < 22 || parsed.gestationalAgeWeeks > 50) {
      return fhirError(`gestationalAgeWeeks must be 22-50 (got ${parsed.gestationalAgeWeeks}).`);
    }
    return { route: "fenton" };
  }

  const ageMonths = postnatalAgeMonths(parsed.birthDate, parsed.effectiveDateTime);
  if (ageMonths === null) {
    return fhirError(`Could not parse birthDate "${parsed.birthDate}" / effectiveDateTime "${parsed.effectiveDateTime}".`);
  }
  if (ageMonths >= 61 && ageMonths <= 228) {
    return { route: "bmi-for-age", ageMonths };
  }
  if (ageMonths < 61) {
    return fhirError(
      `Postnatal age ${ageMonths} months falls in the WHO 0-59-month child growth standards range, which ` +
        "chakudya-api does not yet expose an endpoint for. Not supported by this facade."
    );
  }
  return fhirError(`Postnatal age ${ageMonths} months is outside every reference this facade covers (5y1m-19y0m, or use gestationalAgeWeeks for a preterm infant).`);
}

// ─── Building the FHIR Observation response ────────────────────────────────

function metricComponent(base, code, display, quantity) {
  return {
    code: { coding: [{ system: codeSystemUrl(base, "growth-metric"), code, display }] },
    ...quantity,
  };
}

function interpretationFor(status) {
  // Best-effort mapping onto the standard v3 codes; Chakudya's own status
  // (in the status component below) is the fidelity-preserving value —
  // this is just for FHIR clients that only look at .interpretation.
  const map = {
    small: "L", appropriate: "N", large: "H",
    "severe thinness": "LL", thinness: "L", normal: "N", overweight: "H", obesity: "HH",
  };
  const code = map[status] ?? "N";
  return [{ coding: [{ system: V3_INTERPRETATION, code }] }];
}

/** One Fenton classify result -> one FHIR Observation. */
export function buildFentonObservation(base, { sex, gestAgeWeeks, day, metric, value, unit }, classifyResult) {
  const loinc = LOINC_CODES[metric];
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, ...loinc }] },
    effectiveDateTime: undefined, // set by caller if desired
    valueQuantity: { value, unit, system: UCUM, code: unit },
    component: [
      metricComponent(base, "z-score", "Z-score", { valueQuantity: { value: classifyResult.z } }),
      metricComponent(base, "percentile", "Percentile", { valueQuantity: { value: classifyResult.percentile, unit: "%" } }),
      metricComponent(base, "status", "Growth status", {
        valueCodeableConcept: { coding: [{ system: codeSystemUrl(base, "growth-status"), code: classifyResult.status }] },
      }),
    ],
    interpretation: interpretationFor(classifyResult.status),
    note: [{ text: classifyResult.note }],
    extension: [
      {
        url: `${base}/fhir/StructureDefinition/growth-reference-used`,
        valueString: `fenton-preterm-${classifyResult.reference_year ?? "2025"}`,
      },
      { url: `${base}/fhir/StructureDefinition/gestational-age`, valueString: `${gestAgeWeeks}w${day}d` },
    ],
  };
}

/** One BMI-for-age classify result -> one FHIR Observation. */
export function buildBmiForAgeObservation(base, { ageMonths }, classifyResult) {
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, ...LOINC_CODES.bmi }] },
    valueQuantity: { value: classifyResult.bmi, unit: "kg/m2", system: UCUM, code: "kg/m2" },
    component: [
      metricComponent(base, "status", "Growth status", {
        valueCodeableConcept: { coding: [{ system: codeSystemUrl(base, "growth-status"), code: classifyResult.status }] },
      }),
    ],
    interpretation: interpretationFor(classifyResult.status),
    note: [{ text: classifyResult.note }],
    extension: [
      { url: `${base}/fhir/StructureDefinition/growth-reference-used`, valueString: "who-2007-bmi-for-age" },
      { url: `${base}/fhir/StructureDefinition/postnatal-age-months`, valueString: String(ageMonths) },
    ],
  };
}

export function bundleObservations(observations) {
  if (observations.length === 1) return observations[0];
  return {
    resourceType: "Bundle",
    type: "collection",
    total: observations.length,
    entry: observations.map((resource) => ({ resource })),
  };
}

// ─── CapabilityStatement (GET /fhir/metadata) ──────────────────────────────

export function buildCapabilityStatement(base) {
  return {
    resourceType: "CapabilityStatement",
    status: "draft",
    date: "2026-09-25",
    kind: "instance",
    software: { name: "Chakudya Nutrition Registry (CNR) FHIR facade", version: "phase-1" },
    implementation: { description: "Growth/anthropometry FHIR facade over chakudya-api's classify endpoints. Groundwork only — not yet registered with any OpenHIM/HIE instance.", url: `${base}/fhir` },
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [
      {
        mode: "server",
        resource: [
          {
            type: "Observation",
            interaction: [],
            operation: [
              {
                name: "evaluate-growth",
                definition: `${base}/fhir/OperationDefinition/Observation-evaluate-growth`,
                documentation:
                  "POST a FHIR Parameters resource (sex + gestationalAgeWeeks|birthDate + one or more " +
                  "measurement parts) and get back a growth-classification Observation (or a Bundle of " +
                  "them). Covers Fenton preterm (22-50 weeks gestation) and WHO 2007 BMI-for-age " +
                  "(5y1m-19y0m) only — see chakudya-api README, Fenton Preterm / BMI-for-Age sections.",
              },
            ],
          },
        ],
      },
    ],
  };
}

export const LOINC_CODE_MAP = LOINC_CODES;
export { toGrams, toKg, toCm };
