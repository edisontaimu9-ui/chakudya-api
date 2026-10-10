// Weight-for-length/height classification (wasting / overweight), 0-60 months.
// Reference: WHO Child Growth Standards 2006, weight-for-length (birth to 2 years,
// lying, 45.0-110.0 cm) and weight-for-height (2 to 5 years, standing,
// 65.0-120.0 cm), expanded z-score tables in 0.1 cm steps. Data lives in the
// `who_weight_for_length_height` table (sql/025_add_who_weight_for_length_height.sql,
// seeds: scripts/weight_for_length_height_seed_1..5.json).
//
// The table is picked by AGE (lying under 24 months, standing from 24). If the
// child was measured the other way, the length/height is converted by 0.7 cm
// (WHO convention) and reported, as in lengthHeightForAge.js. The length/height
// is rounded to the nearest 0.1 cm to find the table row.
//
// Bands (strict inequalities, unrounded weight):
//   < -3SD severe wasting | < -2SD moderate wasting | -2SD..+1SD normal |
//   > +1SD possible risk of overweight | > +2SD overweight | > +3SD obesity
// z = ((x/M)^L - 1) / (L*S); beyond +/-3 SD WHO's linear extension is used. Like
// WHO, z < -5 or z > +5 is flagged as biologically implausible.
//
// Screening aid only, not a diagnosis. Nutritional oedema, MUAC and clinical
// signs decide severity in practice.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";
import { normalCdf } from "./weightVelocity.js";
import { defaultMeasured, LYING_STANDING_DIFF_CM } from "./lengthHeightForAge.js";

export const WFLH_MIN_MONTHS = 0;
export const WFLH_MAX_MONTHS = 60;
export const WFL_RANGE_CM = { min: 45, max: 110 };  // lying table
export const WFH_RANGE_CM = { min: 65, max: 120 };  // standing table

export { normalizeSex };

/**
 * Parse ?sex=&age_months=&(weight_kg|weight_g)&(length_cm|height_cm|length_mm|height_mm)&measured=.
 * Returns { sex, ageMonths, weightKg, lengthHeightCm, measured } or { error }.
 */
export function parseWflhQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < WFLH_MIN_MONTHS || ageMonths > WFLH_MAX_MONTHS) {
    return { error: `'age_months' must be ${WFLH_MIN_MONTHS} to ${WFLH_MAX_MONTHS} (WHO weight-for-length/height covers birth to 5 years; for older children use /bmi-for-age/classify)` };
  }

  let weightKg = null;
  const kgRaw = searchParams.get("weight_kg");
  const gRaw = searchParams.get("weight_g");
  if (kgRaw !== null && kgRaw !== "") weightKg = Number(kgRaw);
  else if (gRaw !== null && gRaw !== "") weightKg = Number(gRaw) / 1000;
  else return { error: "Provide 'weight_kg' (kilograms) or 'weight_g' (grams)" };
  if (!Number.isFinite(weightKg) || weightKg < 0.5 || weightKg > 40) {
    return { error: "Weight is not plausible (expected roughly 1 to 30 kg at these ages; check you did not pass grams as weight_kg)" };
  }

  let lengthHeightCm = null;
  for (const [name, div] of [["length_cm", 1], ["height_cm", 1], ["length_mm", 10], ["height_mm", 10]]) {
    const raw = searchParams.get(name);
    if (raw !== null && raw !== "") { lengthHeightCm = Number(raw) / div; break; }
  }
  if (lengthHeightCm === null) return { error: "Provide 'length_cm' or 'height_cm' (centimetres; or the _mm versions)" };
  if (!Number.isFinite(lengthHeightCm) || lengthHeightCm < 30 || lengthHeightCm > 160) {
    return { error: "Length/height is not plausible (check you did not pass millimetres as cm)" };
  }

  const measuredRaw = (searchParams.get("measured") || "").trim().toLowerCase();
  let measured = defaultMeasured(ageMonths);
  if (measuredRaw) {
    if (!["lying", "standing"].includes(measuredRaw)) return { error: "'measured' must be lying or standing" };
    measured = measuredRaw;
  }
  return {
    sex, ageMonths, measured,
    weightKg: Math.round(weightKg * 10000) / 10000,
    lengthHeightCm: Math.round(lengthHeightCm * 1000) / 1000,
  };
}

/**
 * Decide which reference table applies and the length/height to look up.
 * Returns { table: "lying"|"standing", lookupCm (rounded to 0.1), range, adjustment|null }.
 */
export function resolveLookup(ageMonths, measured, lengthHeightCm) {
  const table = defaultMeasured(ageMonths);
  let cm = lengthHeightCm;
  let adjustment = null;
  if (measured !== table) {
    const delta = table === "standing" ? -LYING_STANDING_DIFF_CM : LYING_STANDING_DIFF_CM;
    cm = lengthHeightCm + delta;
    adjustment = {
      measured,
      reference_table: table,
      adjustment_cm: delta,
      note: `Measured ${measured} but the WHO ${table} table applies at this age, so ${delta > 0 ? "+" : ""}${delta} cm was applied (WHO convention).`,
    };
  }
  const lookupCm = Math.round(cm * 10) / 10;
  return { table, lookupCm, range: table === "lying" ? WFL_RANGE_CM : WFH_RANGE_CM, adjustment };
}

/** Exact LMS z-score with WHO's linear extension beyond +/-3 SD. null if not computable. */
export function wflhZ(row, x) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s);
  if (!(x > 0) || !(M > 0) || !(S > 0)) return null;
  let z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  if (!Number.isFinite(z)) return null;
  const n3 = Number(row.sd_neg3), n2 = Number(row.sd_neg2), p2 = Number(row.sd_pos2), p3 = Number(row.sd_pos3);
  if (z > 3) z = 3 + (x - p3) / (p3 - p2);
  else if (z < -3) z = -3 + (x - n3) / (n2 - n3);
  return Number.isFinite(z) ? z : null;
}

/** row: a who_weight_for_length_height row. */
export function classifyWflh(row, weightKg) {
  const { cutoffs } = classifyHcVelocity(row, weightKg);
  const c = cutoffs;
  let status;
  if (weightKg < c["-3SD"]) status = "severe wasting";
  else if (weightKg < c["-2SD"]) status = "moderate wasting";
  else if (weightKg <= c["+1SD"]) status = "normal";
  else if (weightKg <= c["+2SD"]) status = "possible risk of overweight";
  else if (weightKg <= c["+3SD"]) status = "overweight";
  else status = "obesity";
  const z = wflhZ(row, weightKg);
  return {
    status,
    reference: row.measured === "lying" ? "weight-for-length (lying down)" : "weight-for-height (standing)",
    weight_kg: Math.round(weightKg * 1000) / 1000,
    z_score: z === null ? null : Math.round(z * 100) / 100 + 0,
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    implausible: z === null ? null : (z < -5 || z > 5),
    cutoffs,
  };
}
