// Arm circumference-for-age (MUAC-for-age) classification, 3 to 60 months.
// Reference: WHO Child Growth Standards, arm circumference-for-age (cm),
// expanded z-score tables. Data lives in the `who_muac_for_age` table
// (sql/021_add_who_muac_for_age.sql, seed: scripts/muac_for_age_seed.json).
//
// Bands (strict inequalities, compared against the UNROUNDED measurement):
//   < -3SD very low | < -2SD low | -2SD..+2SD within expected range |
//   > +2SD high | > +3SD very high
// The row stores WHO's L, M, S, so the response carries an exact z-score and
// percentile. Beyond +/-3 SD the z-score follows WHO's convention (linear
// extension using the distance between the +/-2 SD and +/-3 SD cut-offs), which
// is how the WHO expanded tables define their +/-4 SD columns.
//
// Screening aid only, not a diagnosis. This is MUAC for AGE (z-score); it is not
// the fixed-cut-off MUAC tape used in community screening (115 / 125 mm).

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";
import { normalCdf } from "./weightVelocity.js";

export const MUAC_MIN_MONTHS = 3;
export const MUAC_MAX_MONTHS = 60;

export { normalizeSex };

/**
 * Parse ?sex=&age_months=&(muac_cm | muac_mm).
 * Returns { sex, ageMonths, muacCm } or { error }.
 */
export function parseMuacForAgeQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < MUAC_MIN_MONTHS || ageMonths > MUAC_MAX_MONTHS) {
    return { error: `'age_months' must be ${MUAC_MIN_MONTHS} to ${MUAC_MAX_MONTHS} (the WHO arm circumference-for-age standards cover 3 months to 5 years)` };
  }

  let muacCm;
  const cmRaw = searchParams.get("muac_cm");
  const mmRaw = searchParams.get("muac_mm");
  if (cmRaw !== null && cmRaw !== "") {
    muacCm = Number(cmRaw);
  } else if (mmRaw !== null && mmRaw !== "") {
    muacCm = Number(mmRaw) / 10;
  } else {
    return { error: "Provide 'muac_cm' (centimetres) or 'muac_mm' (millimetres)" };
  }
  if (!Number.isFinite(muacCm) || muacCm < 5 || muacCm > 30) {
    return { error: "MUAC is not plausible (expected roughly 8 to 25 cm; check you did not pass millimetres as muac_cm)" };
  }
  return { sex, ageMonths, muacCm: Math.round(muacCm * 1000) / 1000 };
}

/** Exact LMS z-score with WHO's linear extension beyond +/-3 SD. null if not computable. */
export function muacZ(row, x) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s);
  if (!(x > 0) || !(M > 0) || !(S > 0)) return null;
  let z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  if (!Number.isFinite(z)) return null;
  const n3 = Number(row.sd_neg3), n2 = Number(row.sd_neg2), p2 = Number(row.sd_pos2), p3 = Number(row.sd_pos3);
  if (z > 3) z = 3 + (x - p3) / (p3 - p2);
  else if (z < -3) z = -3 + (x - n3) / (n2 - n3);
  return Number.isFinite(z) ? z : null;
}

/** row: a who_muac_for_age row. Returns { status, muac_cm, z_score, percentile, cutoffs }. */
export function classifyMuacForAge(row, muacCm) {
  const { cutoffs } = classifyHcVelocity(row, muacCm);
  const c = cutoffs;
  let status;
  if (muacCm < c["-3SD"]) status = "very low";
  else if (muacCm < c["-2SD"]) status = "low";
  else if (muacCm <= c["+2SD"]) status = "within expected range";
  else if (muacCm <= c["+3SD"]) status = "high";
  else status = "very high";
  const z = muacZ(row, muacCm);
  return {
    status,
    muac_cm: muacCm,
    z_score: z === null ? null : Math.round(z * 100) / 100 + 0, // + 0 turns -0 into 0
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    cutoffs,
  };
}
