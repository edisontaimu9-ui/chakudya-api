// Weight-for-age classification (underweight), birth to 10 years (0-120 months).
// Reference: WHO Child Growth Standards 2006, weight-for-age (kg), monthly
// z-score tables (0-60 months), and the WHO 2007 growth reference, weight-for-age
// 5-10 years (61-120 months). Data lives in the `who_weight_for_age` table
// (sql/024_add_who_weight_for_age.sql, seed: scripts/weight_for_age_seed.json).
//
// Bands (strict inequalities, unrounded weight):
//   < -3SD severely underweight | < -2SD underweight | -2SD..+2SD normal |
//   > +2SD high weight-for-age | > +3SD very high weight-for-age
// Weight-for-age is NOT used to diagnose overweight or obesity: a high value
// means "check weight-for-length/height (under 5) or BMI-for-age (5+)".
//
// z = ((x/M)^L - 1) / (L*S) from the stored WHO L, M, S; beyond +/-3 SD WHO's
// linear extension is used (distance between the +/-2 SD and +/-3 SD cut-offs),
// as in the WHO expanded tables' +/-4 SD columns. Like WHO, z < -6 or z > +5 is
// flagged as biologically implausible (usually a measuring or recording error).
// WHO publishes weight-for-age only to 10 years; older children use BMI-for-age.
//
// Screening aid only, not a diagnosis.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";
import { normalCdf } from "./weightVelocity.js";

export const WFA_MIN_MONTHS = 0;
export const WFA_MAX_MONTHS = 120;

export { normalizeSex };

/**
 * Parse ?sex=&age_months=&(weight_kg | weight_g).
 * Returns { sex, ageMonths, weightKg } or { error }.
 */
export function parseWeightForAgeQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < WFA_MIN_MONTHS || ageMonths > WFA_MAX_MONTHS) {
    return { error: `'age_months' must be ${WFA_MIN_MONTHS} to ${WFA_MAX_MONTHS} (WHO publishes weight-for-age to 10 years; for older children use /bmi-for-age/classify)` };
  }

  let weightKg = null;
  const kgRaw = searchParams.get("weight_kg");
  const gRaw = searchParams.get("weight_g");
  if (kgRaw !== null && kgRaw !== "") weightKg = Number(kgRaw);
  else if (gRaw !== null && gRaw !== "") weightKg = Number(gRaw) / 1000;
  else return { error: "Provide 'weight_kg' (kilograms) or 'weight_g' (grams)" };
  if (!Number.isFinite(weightKg) || weightKg < 0.5 || weightKg > 100) {
    return { error: "Weight is not plausible (expected roughly 1 to 60 kg for these ages; check you did not pass grams as weight_kg)" };
  }
  return { sex, ageMonths, weightKg: Math.round(weightKg * 10000) / 10000 };
}

/** Exact LMS z-score with WHO's linear extension beyond +/-3 SD. null if not computable. */
export function wfaZ(row, x) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s);
  if (!(x > 0) || !(M > 0) || !(S > 0)) return null;
  let z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  if (!Number.isFinite(z)) return null;
  const n3 = Number(row.sd_neg3), n2 = Number(row.sd_neg2), p2 = Number(row.sd_pos2), p3 = Number(row.sd_pos3);
  if (z > 3) z = 3 + (x - p3) / (p3 - p2);
  else if (z < -3) z = -3 + (x - n3) / (n2 - n3);
  return Number.isFinite(z) ? z : null;
}

/** row: a who_weight_for_age row. Returns { status, weight_kg, z_score, percentile, implausible, cutoffs }. */
export function classifyWeightForAge(row, weightKg) {
  const { cutoffs } = classifyHcVelocity(row, weightKg);
  const c = cutoffs;
  let status;
  if (weightKg < c["-3SD"]) status = "severely underweight";
  else if (weightKg < c["-2SD"]) status = "underweight";
  else if (weightKg <= c["+2SD"]) status = "normal";
  else if (weightKg <= c["+3SD"]) status = "high weight-for-age";
  else status = "very high weight-for-age";
  const z = wfaZ(row, weightKg);
  return {
    status,
    weight_kg: Math.round(weightKg * 1000) / 1000,
    z_score: z === null ? null : Math.round(z * 100) / 100 + 0,
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    implausible: z === null ? null : (z < -6 || z > 5),
    cutoffs,
  };
}
