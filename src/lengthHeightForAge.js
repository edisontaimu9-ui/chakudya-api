// Length/height-for-age classification (stunting), birth to 19 years (0-228 months).
// Reference: WHO Child Growth Standards 2006, length/height-for-age (cm), monthly
// z-score tables (0-60 months), and the WHO 2007 growth reference, height-for-age
// 5-19 years (61-228 months, standing). Data lives in the `who_length_height_for_age` table
// (sql/022_add_who_length_height_for_age.sql + sql/023 to widen to 19 years; seeds: scripts/length_height_for_age_seed.json and scripts/height_for_age_5_19_seed.json).
//
// Length (lying down) is used under 24 months, height (standing) from 24 months.
// Month 24 exists in both tables. A lying measurement is about 0.7 cm longer than
// a standing one, so if a child was measured the "other" way for their age, the
// value is converted by 0.7 cm (WHO convention) and the response says so.
//
// Bands (strict inequalities, unrounded value):
//   < -3SD severely stunted | < -2SD stunted | -2SD..+2SD normal |
//   > +2SD tall | > +3SD very tall (tallness is rarely a problem)
// L is 1 in these tables, so z = (x - M) / (M * S) exactly, with no extension
// beyond +/-3 SD. Like WHO, |z| > 6 is flagged as biologically implausible
// (usually a measuring or recording error).
//
// Screening aid only, not a diagnosis.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";
import { normalCdf } from "./weightVelocity.js";

export const LHFA_MIN_MONTHS = 0;
export const LHFA_MAX_MONTHS = 228;
export const LYING_STANDING_DIFF_CM = 0.7;

export { normalizeSex };

/** Default measuring position for an age: lying under 24 months, standing from 24. */
export function defaultMeasured(ageMonths) {
  return ageMonths < 24 ? "lying" : "standing";
}

/**
 * Parse ?sex=&age_months=&(length_cm | height_cm | length_mm | height_mm)&measured=lying|standing.
 * Returns { sex, ageMonths, valueCm, measured } or { error }.
 */
export function parseLhfaQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < LHFA_MIN_MONTHS || ageMonths > LHFA_MAX_MONTHS) {
    return { error: `'age_months' must be ${LHFA_MIN_MONTHS} to ${LHFA_MAX_MONTHS} (birth to 19 years: WHO standards to 60 months, WHO 2007 reference from 61 to 228)` };
  }

  let valueCm = null;
  for (const [name, div] of [["length_cm", 1], ["height_cm", 1], ["length_mm", 10], ["height_mm", 10]]) {
    const raw = searchParams.get(name);
    if (raw !== null && raw !== "") { valueCm = Number(raw) / div; break; }
  }
  if (valueCm === null) return { error: "Provide 'length_cm' or 'height_cm' (centimetres; or the _mm versions)" };
  if (!Number.isFinite(valueCm) || valueCm < 20 || valueCm > 230) {
    return { error: "Length/height is not plausible (expected roughly 40 to 200 cm; check you did not pass millimetres as cm)" };
  }

  const measuredRaw = (searchParams.get("measured") || "").trim().toLowerCase();
  let measured = defaultMeasured(ageMonths);
  if (measuredRaw) {
    if (!["lying", "standing"].includes(measuredRaw)) return { error: "'measured' must be lying or standing" };
    measured = measuredRaw;
  }
  return { sex, ageMonths, valueCm: Math.round(valueCm * 1000) / 1000, measured };
}

/**
 * rows: the who_length_height_for_age rows for one sex and month (one or two:
 * month 24 has both). Picks the row matching how the child was measured when it
 * exists, otherwise the other row with a 0.7 cm conversion.
 * Returns { row, valueCm, adjustment } or null if rows is empty.
 */
export function pickRowAndValue(rows, measured, valueCm) {
  if (!rows || rows.length === 0) return null;
  const exact = rows.find((r) => r.measured === measured);
  if (exact) return { row: exact, valueCm, adjustment: null };
  const row = rows[0];
  // lying value -> standing table: subtract 0.7; standing value -> lying table: add 0.7
  const delta = measured === "lying" ? -LYING_STANDING_DIFF_CM : LYING_STANDING_DIFF_CM;
  return {
    row,
    valueCm: Math.round((valueCm + delta) * 1000) / 1000,
    adjustment: {
      measured,
      reference_table: row.measured,
      adjustment_cm: delta,
      note: `Measured ${measured} but the WHO ${row.measured} table applies at this age, so ${delta > 0 ? "+" : ""}${delta} cm was applied (WHO convention).`,
    },
  };
}

/** Exact z-score (L = 1 in these tables, but the general LMS form is kept). */
export function lhfaZ(row, x) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s);
  if (!(x > 0) || !(M > 0) || !(S > 0)) return null;
  const z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  return Number.isFinite(z) ? z : null;
}

/** row: a who_length_height_for_age row; x: the (already position-adjusted) value in cm. */
export function classifyLhfa(row, x) {
  const { cutoffs } = classifyHcVelocity(row, x);
  const c = cutoffs;
  let status;
  if (x < c["-3SD"]) status = "severely stunted";
  else if (x < c["-2SD"]) status = "stunted";
  else if (x <= c["+2SD"]) status = "normal";
  else if (x <= c["+3SD"]) status = "tall";
  else status = "very tall";
  const z = lhfaZ(row, x);
  return {
    status,
    reference: row.measured === "lying" ? "length (lying down)" : "height (standing)",
    value_cm: Math.round(x * 100) / 100,
    z_score: z === null ? null : Math.round(z * 100) / 100 + 0,
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    implausible: z === null ? null : Math.abs(z) > 6,
    cutoffs,
  };
}
