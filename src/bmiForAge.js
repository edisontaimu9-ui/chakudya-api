// BMI-for-age classification for children and adolescents 5-19 years.
// Reference: WHO 2007 z-score tables, as printed in Malawi Ministry of Health,
// "Eat Well to Live Well" (2021), Annex 2. Data lives in the `bmi_for_age`
// table (sql/012_add_bmi_for_age.sql, seed: scripts/bmi_for_age_seed.json).
//
// Cut-offs (strict inequalities, compared against the UNROUNDED BMI):
//   severe thinness < -3SD | thinness < -2SD | normal -2SD..+1SD |
//   overweight > +1SD | obesity > +2SD
// The printed guide says "Severe thinness: <-1 SD", which looks like a typo;
// WHO uses -3SD, which is used here.
//
// Screening aid only, not a diagnosis.

export const BMI_FOR_AGE_MIN_MONTHS = 61;  // 5y 1m
export const BMI_FOR_AGE_MAX_MONTHS = 228; // 19y 0m

export function normalizeSex(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["girls", "girl", "female", "f"].includes(s)) return "girls";
  if (["boys", "boy", "male", "m"].includes(s)) return "boys";
  return null;
}

/**
 * Parse ?sex=&age_months=&bmi= (or &weight_kg=&height_cm= instead of bmi).
 * Returns { sex, ageMonths, bmi } or { error }.
 */
export function parseBmiForAgeQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole number: years x 12 + months, e.g. 7y 11m = 95)" };
  }
  if (ageMonths < BMI_FOR_AGE_MIN_MONTHS || ageMonths > BMI_FOR_AGE_MAX_MONTHS) {
    return {
      error: `'age_months' must be ${BMI_FOR_AGE_MIN_MONTHS} (5y 1m) to ${BMI_FOR_AGE_MAX_MONTHS} (19y 0m). Under-5s need the WHO child growth standards; adults use adult BMI cut-offs.`,
    };
  }

  let bmi = null;
  const bmiRaw = searchParams.get("bmi");
  if (bmiRaw !== null && bmiRaw !== "") {
    bmi = Number(bmiRaw);
  } else {
    const w = Number(searchParams.get("weight_kg"));
    const h = Number(searchParams.get("height_cm"));
    if (!(w > 0) || !(h > 0)) {
      return { error: "Provide 'bmi', or both 'weight_kg' and 'height_cm'" };
    }
    const m = h / 100;
    bmi = w / (m * m); // unrounded on purpose: rounding first can flip a borderline result
  }
  if (!Number.isFinite(bmi) || bmi <= 0 || bmi > 100) return { error: "BMI value is not plausible" };
  return { sex, ageMonths, bmi };
}

/** row: a bmi_for_age table row. Returns { status, bmi, cutoffs }. */
export function classifyBmiForAge(row, bmi) {
  const c = {
    "-3SD": Number(row.sd_neg3), "-2SD": Number(row.sd_neg2), "-1SD": Number(row.sd_neg1),
    median: Number(row.median), "+1SD": Number(row.sd_pos1), "+2SD": Number(row.sd_pos2), "+3SD": Number(row.sd_pos3),
  };
  let status;
  if (bmi < c["-3SD"]) status = "severe thinness";
  else if (bmi < c["-2SD"]) status = "thinness";
  else if (bmi <= c["+1SD"]) status = "normal";
  else if (bmi <= c["+2SD"]) status = "overweight";
  else status = "obesity";
  return { status, bmi: Math.round(bmi * 10) / 10, cutoffs: c };
}
