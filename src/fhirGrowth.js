// FHIR mapping for the WHO growth indicators (birth to 19 years): turns the
// result of assessGrowth() (src/growthAssess.js) into FHIR R4 Observations,
// one per indicator. Pure functions, no I/O, no storage; the facade route in
// index.js supplies the reference-table lookups.
//
// Covered here: length/height-for-age, weight-for-age, weight-for-length/height,
// BMI-for-age (under 5 and 5-19), head circumference-for-age, MUAC-for-age and
// the fixed MUAC cut-offs, plus the acute-malnutrition signals summary.

import { toKg, toCm, LOINC_CODE_MAP } from "./fhir.js";

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const V3_INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";

const MUAC_LOINC = { code: "56072-2", display: "Circumference.mid upper arm - Left" };

// indicator key (as returned by assessGrowth) -> how it is shown in FHIR.
export const INDICATORS = {
  length_height_for_age: { code: "length-height-for-age", display: "Length/height-for-age", loinc: LOINC_CODE_MAP.length, unit: "cm", valueKey: "value_cm", reference: "who-2006-2007-length-height-for-age" },
  weight_for_age: { code: "weight-for-age", display: "Weight-for-age", loinc: LOINC_CODE_MAP.weight, unit: "kg", valueKey: "weight_kg", reference: "who-2006-2007-weight-for-age" },
  weight_for_length_height: { code: "weight-for-length-height", display: "Weight-for-length/height", loinc: LOINC_CODE_MAP.weight, unit: "kg", valueKey: "weight_kg", reference: "who-2006-weight-for-length-height" },
  bmi_for_age: { code: "bmi-for-age", display: "BMI-for-age", loinc: LOINC_CODE_MAP.bmi, unit: "kg/m2", valueKey: "bmi", reference: "who-bmi-for-age" },
  hc_for_age: { code: "hc-for-age", display: "Head circumference-for-age", loinc: LOINC_CODE_MAP.hc, unit: "cm", valueKey: "hc_cm", reference: "who-2006-hc-for-age" },
  muac_for_age: { code: "muac-for-age", display: "MUAC-for-age", loinc: MUAC_LOINC, unit: "cm", valueKey: "muac_cm", reference: "who-2006-muac-for-age" },
  muac_fixed: { code: "muac-fixed-cutoffs", display: "MUAC fixed cut-offs", loinc: MUAC_LOINC, unit: "cm", valueKey: "muac_cm", reference: "fixed-muac-cutoffs" },
};
export const INDICATOR_CODES = Object.values(INDICATORS).map((i) => i.code).concat("acute-malnutrition-signals");

const V3 = {
  normal: "N", "within expected range": "N", appropriate: "N",
  "severely stunted": "LL", "severely underweight": "LL", "severe wasting": "LL", "severe thinness": "LL",
  "severe microcephaly": "LL", "very low": "LL", severe: "LL",
  stunted: "L", underweight: "L", "moderate wasting": "L", thinness: "L", microcephaly: "L", low: "L", moderate: "L",
  tall: "H", "high weight-for-age": "H", "possible risk of overweight": "H", overweight: "H", macrocephaly: "H", high: "H",
  "very tall": "HH", "very high weight-for-age": "HH", obesity: "HH", "severe macrocephaly": "HH", "very high": "HH",
};
const interpretation = (status) => [{ coding: [{ system: V3_INTERPRETATION, code: V3[status] ?? "N" }] }];
const cs = (base, name) => `${base}/fhir/CodeSystem/${name}`;
const comp = (base, code, display, value) => ({ code: { coding: [{ system: cs(base, "growth-metric"), code, display }] }, ...value });

/** FHIR measurement parts -> the query string assessGrowth() reads. */
export function measurementsToAssessQuery({ sex, ageMonths, measurements, measured, muacScheme }) {
  const q = new URLSearchParams({ sex: sex === "male" ? "boys" : "girls", age_months: String(ageMonths) });
  const seen = new Set();
  for (const m of measurements) {
    if (seen.has(m.type)) return { error: `measurement.type "${m.type}" was given more than once.` };
    seen.add(m.type);
    if (m.type === "weight") {
      const kg = toKg(m.value);
      if (kg === null) return { error: "weight needs a unit: kg or g." };
      q.set("weight_kg", String(kg));
    } else if (m.type === "length" || m.type === "height") {
      const cm = toCm(m.value);
      if (cm === null) return { error: `${m.type} needs a unit: cm or m.` };
      q.set("length_cm", String(cm));
    } else if (m.type === "hc") {
      const cm = toCm(m.value);
      if (cm === null) return { error: "hc needs a unit: cm or m." };
      q.set("hc_cm", String(cm));
    } else if (m.type === "muac") {
      const unit = (m.value?.code || m.value?.unit || "").toLowerCase();
      if (typeof m.value?.value !== "number" || !["cm", "mm"].includes(unit)) return { error: "muac needs a unit: cm or mm." };
      q.set(unit === "mm" ? "muac_mm" : "muac_cm", String(m.value.value));
    }
    // "bmi" is derived from weight + length; a bmi-only request is handled by the legacy BMI route.
  }
  if (measured) q.set("measured", measured);
  if (muacScheme) q.set("muac_scheme", muacScheme);
  return { query: q };
}

/** One assessGrowth() indicator result -> one FHIR Observation. */
export function buildIndicatorObservation(base, key, r, ageMonths) {
  const ind = INDICATORS[key];
  const value = r[ind.valueKey];
  const ref = key === "bmi_for_age" ? (ageMonths <= 60 ? "who-2006-bmi-for-age-under-5" : "who-2007-bmi-for-age") : ind.reference;
  const components = [
    comp(base, "indicator", "Growth indicator", { valueCodeableConcept: { coding: [{ system: cs(base, "growth-indicator"), code: ind.code, display: ind.display }] } }),
  ];
  if (typeof r.z_score === "number") components.push(comp(base, "z-score", "Z-score", { valueQuantity: { value: r.z_score } }));
  if (typeof r.percentile === "number") components.push(comp(base, "percentile", "Percentile", { valueQuantity: { value: r.percentile, unit: "%" } }));
  components.push(comp(base, "status", "Growth status", { valueCodeableConcept: { coding: [{ system: cs(base, "growth-status"), code: r.status }] } }));
  const obs = {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, ...ind.loinc }] },
    ...(typeof value === "number" ? { valueQuantity: { value, unit: ind.unit, system: UCUM, code: ind.unit } } : {}),
    component: components,
    interpretation: interpretation(r.status),
    extension: [
      { url: `${base}/fhir/StructureDefinition/growth-reference-used`, valueString: ref },
      { url: `${base}/fhir/StructureDefinition/postnatal-age-months`, valueString: String(ageMonths) },
    ],
  };
  if (r.implausible) obs.note = [{ text: "Value is biologically implausible for this age and sex; check the measurement and units." }];
  if (r.position_adjustment) {
    obs.note = [...(obs.note || []), { text: r.position_adjustment.note || "Length/height was adjusted for lying vs standing measurement." }];
  }
  if (key === "muac_fixed") obs.component.push(comp(base, "scheme", "Fixed MUAC scheme", { valueString: r.scheme }));
  return obs;
}

/** assessGrowth() result -> Bundle of Observations (one per indicator, plus acute signals). */
export function buildWhoGrowthBundle(base, ageMonths, result, effectiveDateTime) {
  const entries = [];
  const errors = [];
  for (const [key, r] of Object.entries(result.indicators || {})) {
    if (!INDICATORS[key]) continue;
    if (r.error) { errors.push(`${INDICATORS[key].code}: ${r.error}`); continue; }
    const o = buildIndicatorObservation(base, key, r, ageMonths);
    o.effectiveDateTime = effectiveDateTime;
    entries.push(o);
  }
  const a = result.acute_malnutrition_signals;
  if (a) {
    entries.push({
      resourceType: "Observation",
      status: "final",
      effectiveDateTime,
      code: { coding: [{ system: cs(base, "growth-indicator"), code: "acute-malnutrition-signals", display: "Acute malnutrition signals" }] },
      component: [
        comp(base, "status", "Growth status", { valueCodeableConcept: { coding: [{ system: cs(base, "acute-malnutrition-level"), code: a.level }] } }),
        ...(a.reasons || []).map((t) => comp(base, "reason", "Reason", { valueString: t })),
        comp(base, "oedema-assessed", "Oedema assessed", { valueBoolean: false }),
      ],
      note: [{ text: a.note }],
      extension: [{ url: `${base}/fhir/StructureDefinition/postnatal-age-months`, valueString: String(ageMonths) }],
    });
  }
  const notAssessed = Object.entries(result.not_assessed || {}).map(([k, why]) => `${k}: ${why}`);
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    total: entries.length,
    entry: entries.map((resource) => ({ resource })),
  };
  const outcomes = [...errors.map((e) => ["error", e]), ...(Array.isArray(result.not_assessed) ? result.not_assessed.map((n) => ["information", typeof n === "string" ? n : `${n.indicator}: ${n.reason}`]) : notAssessed.map((n) => ["information", n]))];
  if (outcomes.length) {
    bundle.entry.push({
      resource: { resourceType: "OperationOutcome", issue: outcomes.map(([severity, diagnostics]) => ({ severity, code: severity === "error" ? "invalid" : "informational", diagnostics })) },
    });
  }
  return bundle;
}
