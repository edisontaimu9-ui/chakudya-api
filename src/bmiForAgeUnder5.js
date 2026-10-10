// BMI-for-age classification for children under 5 years (0-60 months).
// Reference: WHO Child Growth Standards 2006, BMI-for-age (kg/m2), monthly
// z-score tables, birth to 2 years (length, lying) and 2 to 5 years (height,
// standing). Data lives in the `who_bmi_for_age_under_5` table
// (sql/026_add_who_bmi_for_age_under_5.sql, seed: scripts/bmi_for_age_under5_seed.json).
// For 5-19 years use bmiForAge.js (/bmi-for-age).
//
// BMI = weight (kg) / length-or-height (m) squared. As in WHO Anthro, a child
// measured the other way for their age (lying at 24+ months, standing under 24)
// has the length/height converted by 0.7 cm BEFORE the BMI is computed.
// Age picks the table: lying under 24 months, standing from 24 months. A BMI
// passed directly is used as is (no position adjustment is possible).
//
// Bands (strict inequalities, unrounded BMI), same wording as weight-for-length/height:
//   < -3SD severe wasting | < -2SD moderate wasting | -2SD..+1SD normal |
//   > +1SD possible risk of overweight | > +2SD overweight | > +3SD obesity
// z = ((x/M)^L - 1) / (L*S); beyond +/-3 SD WHO's linear extension is used. Like
// WHO, z < -5 or z > +5 is flagged as implausible.
//
// Screening aid only, not a diagnosis.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";
import { normalCdf } from "./weightVelocity.js";
import { defaultMeasured, LYING_STANDING_DIFF_CM } from "./lengthHeightForAge.js";

export const BMI5_MIN_MONTHS = 0;
export const BMI5_MAX_MONTHS = 60;

export { normalizeSex };

/**
 * Parse ?sex=&age_months=&(bmi | weight_kg|weight_g & length_cm|height_cm|_mm)&measured=.
 * Returns { sex, ageMonths, measured, bmi } or { sex, ageMonths, measured, weightKg, lengthHeightCm } or { error }.
 */
export function parseBmiUnder5Query(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < BMI5_MIN_MONTHS || ageMonths > BMI5_MAX_MONTHS) {
    return { error: `'age_months' must be ${BMI5_MIN_MONTHS} to ${BMI5_MAX_MONTHS} (this is the under-5 WHO standard; for 5 to 19 years use /bmi-for-age/classify)` };
  }

  const measuredRaw = (searchParams.get("measured") || "").trim().toLowerCase();
  let measured = defaultMeasured(ageMonths);
  if (measuredRaw) {
    if (!["lying", "standing"].includes(measuredRaw)) return { error: "'measured' must be lying or standing" };
    measured = measuredRaw;
  }

  const bmiRaw = searchParams.get("bmi");
  if (bmiRaw !== null && bmiRaw !== "") {
    const bmi = Number(bmiRaw);
    if (!Number.isFinite(bmi) || bmi < 5 || bmi > 40) return { error: "BMI is not plausible (expected roughly 9 to 25 kg/m2 for under-5s)" };
    return { sex, ageMonths, measured, bmi };
  }

  let weightKg = null;
  const kgRaw = searchParams.get("weight_kg");
  const gRaw = searchParams.get("weight_g");
  if (kgRaw !== null && kgRaw !== "") weightKg = Number(kgRaw);
  else if (gRaw !== null && gRaw !== "") weightKg = Number(gRaw) / 1000;
  else return { error: "Provide 'bmi', or 'weight_kg' (or 'weight_g') together with 'length_cm' or 'height_cm'" };
  if (!Number.isFinite(weightKg) || weightKg < 0.5 || weightKg > 40) {
    return { error: "Weight is not plausible (check you did not pass grams as weight_kg)" };
  }
  let lengthHeightCm = null;
  for (const [name, div] of [["length_cm", 1], ["height_cm", 1], ["length_mm", 10], ["height_mm", 10]]) {
    const raw = searchParams.get(name);
    if (raw !== null && raw !== "") { lengthHeightCm = Number(raw) / div; break; }
  }
  if (lengthHeightCm === null) return { error: "Provide 'length_cm' or 'height_cm' with the weight (or pass 'bmi' directly)" };
  if (!Number.isFinite(lengthHeightCm) || lengthHeightCm < 30 || lengthHeightCm > 160) {
    return { error: "Length/height is not plausible (check you did not pass millimetres as cm)" };
  }
  return { sex, ageMonths, measured, weightKg: Math.round(weightKg * 10000) / 10000, lengthHeightCm: Math.round(lengthHeightCm * 1000) / 1000 };
}

/** Which table applies by age, and the BMI (computed from weight + adjusted length/height, or as given). */
export function resolveBmi(parsed) {
  const table = defaultMeasured(parsed.ageMonths);
  if (parsed.bmi !== undefined) {
    return { table, bmi: parsed.bmi, computed: false, adjustment: null, usedLengthHeightCm: null };
  }
  let cm = parsed.lengthHeightCm;
  let adjustment = null;
  if (parsed.measured !== table) {
    const delta = table === "standing" ? -LYING_STANDING_DIFF_CM : LYING_STANDING_DIFF_CM;
    cm = parsed.lengthHeightCm + delta;
    adjustment = {
      measured: parsed.measured,
      reference_table: table,
      adjustment_cm: delta,
      note: `Measured ${parsed.measured} but the WHO ${table} table applies at this age, so ${delta > 0 ? "+" : ""}${delta} cm was applied before computing BMI (WHO convention).`,
    };
  }
  const m = cm / 100;
  return { table, bmi: parsed.weightKg / (m * m), computed: true, adjustment, usedLengthHeightCm: Math.round(cm * 1000) / 1000 };
}

/** Exact LMS z-score with WHO's linear extension beyond +/-3 SD. null if not computable. */
export function bmiZ(row, x) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s);
  if (!(x > 0) || !(M > 0) || !(S > 0)) return null;
  let z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  if (!Number.isFinite(z)) return null;
  const n3 = Number(row.sd_neg3), n2 = Number(row.sd_neg2), p2 = Number(row.sd_pos2), p3 = Number(row.sd_pos3);
  if (z > 3) z = 3 + (x - p3) / (p3 - p2);
  else if (z < -3) z = -3 + (x - n3) / (n2 - n3);
  return Number.isFinite(z) ? z : null;
}

/** row: a who_bmi_for_age_under_5 row; bmi unrounded. */
export function classifyBmiUnder5(row, bmi) {
  const { cutoffs } = classifyHcVelocity(row, bmi);
  const c = cutoffs;
  let status;
  if (bmi < c["-3SD"]) status = "severe wasting";
  else if (bmi < c["-2SD"]) status = "moderate wasting";
  else if (bmi <= c["+1SD"]) status = "normal";
  else if (bmi <= c["+2SD"]) status = "possible risk of overweight";
  else if (bmi <= c["+3SD"]) status = "overweight";
  else status = "obesity";
  const z = bmiZ(row, bmi);
  return {
    status,
    reference: row.measured === "lying" ? "BMI-for-age (length, lying down)" : "BMI-for-age (height, standing)",
    bmi: Math.round(bmi * 100) / 100,
    z_score: z === null ? null : Math.round(z * 100) / 100 + 0,
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    implausible: z === null ? null : (z < -5 || z > 5),
    cutoffs,
  };
}
