// Head circumference-for-age classification, birth to 5 years (0-60 months).
// Reference: WHO Child Growth Standards 2006, head circumference-for-age (cm),
// monthly z-score tables. Data lives in the `who_hc_for_age` table
// (sql/027_add_who_hc_for_age.sql, seed: scripts/hc_for_age_seed.json).
// The 6-month INCREMENT is a different thing: see hcVelocity.js (/hc-velocity).
//
// Bands (strict inequalities, unrounded measurement):
//   < -3SD severe microcephaly | < -2SD microcephaly | -2SD..+2SD normal |
//   > +2SD macrocephaly | > +3SD severe macrocephaly
// L is 1 in these tables, so z = (x - M) / (M * S) exactly; head circumference
// is not weight-based, so WHO applies no extension beyond +/-3 SD. Like WHO,
// |z| > 5 is flagged as biologically implausible.
//
// A single value outside the range is a reason to examine the child and track
// the trend (and parental head sizes), not a diagnosis. Screening aid only.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";
import { normalCdf } from "./weightVelocity.js";

export const HCFA_MIN_MONTHS = 0;
export const HCFA_MAX_MONTHS = 60;

export { normalizeSex };

/** Parse ?sex=&age_months=&(hc_cm | hc_mm). Returns { sex, ageMonths, hcCm } or { error }. */
export function parseHcForAgeQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < HCFA_MIN_MONTHS || ageMonths > HCFA_MAX_MONTHS) {
    return { error: `'age_months' must be ${HCFA_MIN_MONTHS} to ${HCFA_MAX_MONTHS} (the WHO head circumference standards cover birth to 5 years)` };
  }

  let hcCm = null;
  const cmRaw = searchParams.get("hc_cm");
  const mmRaw = searchParams.get("hc_mm");
  if (cmRaw !== null && cmRaw !== "") hcCm = Number(cmRaw);
  else if (mmRaw !== null && mmRaw !== "") hcCm = Number(mmRaw) / 10;
  else return { error: "Provide 'hc_cm' (centimetres) or 'hc_mm' (millimetres)" };
  if (!Number.isFinite(hcCm) || hcCm < 20 || hcCm > 65) {
    return { error: "Head circumference is not plausible (expected roughly 30 to 56 cm; check you did not pass millimetres as hc_cm)" };
  }
  return { sex, ageMonths, hcCm: Math.round(hcCm * 1000) / 1000 };
}

/** Exact z-score (L = 1 in these tables; the general LMS form is kept). */
export function hcZ(row, x) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s);
  if (!(x > 0) || !(M > 0) || !(S > 0)) return null;
  const z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  return Number.isFinite(z) ? z : null;
}

/** row: a who_hc_for_age row. Returns { status, hc_cm, z_score, percentile, implausible, cutoffs }. */
export function classifyHcForAge(row, hcCm) {
  const { cutoffs } = classifyHcVelocity(row, hcCm);
  const c = cutoffs;
  let status;
  if (hcCm < c["-3SD"]) status = "severe microcephaly";
  else if (hcCm < c["-2SD"]) status = "microcephaly";
  else if (hcCm <= c["+2SD"]) status = "normal";
  else if (hcCm <= c["+3SD"]) status = "macrocephaly";
  else status = "severe macrocephaly";
  const z = hcZ(row, hcCm);
  return {
    status,
    hc_cm: Math.round(hcCm * 100) / 100,
    z_score: z === null ? null : Math.round(z * 100) / 100 + 0,
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    implausible: z === null ? null : Math.abs(z) > 5,
    cutoffs,
  };
}
