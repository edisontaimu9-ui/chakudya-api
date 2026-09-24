// Fenton preterm growth chart classification (weight, length, head
// circumference) by exact gestational/postmenstrual age, for both the 2013
// and 2025 references.
//
// LICENSE — see sql/013_add_fenton_preterm.sql. LMS parameters are shared by
// Dr. Tanis Fenton (Univ. of Calgary) under CC BY-NC-ND 4.0, non-commercial,
// this app only, with a hard condition that end users never see the raw
// data and it's never shared with other organizations. This module is the
// ONLY place those numbers are read, and it only ever returns a computed
// z-score/percentile/status — never L, M, S, or a raw table row. Do not add
// a route that echoes `row` or any L/M/S value back to the caller.
//
// Formulas below are ported line-for-line from Dr. Fenton's own "Calculator
// for exact age" spreadsheet (2013 and 2025 editions) so results match her
// tool exactly:
//   - time axis: days since 22 completed weeks gestation,
//     time_days = (gestational_age_weeks - 22) * 7 + day_of_week (0-6)
//   - z = ((value/M)^L - 1) / (L*S)   [standard LMS transform]
//   - WEIGHT ONLY gets the WHO-recommended SD23 correction: if the raw z
//     would fall beyond +/-3, it's replaced with a linear extension from the
//     SD2/SD3 cut-offs instead, per the WHO technical report. Length and HC
//     are NOT corrected this way in Dr. Fenton's own calculator, so neither
//     are they here.
//   - percentile = standard normal CDF of the (possibly corrected) z.
//
// Reference lookup is a step function (not interpolated): the LMS row with
// the largest time_days <= the requested age, same as the spreadsheet's
// Excel LOOKUP() behaviour.

export const FENTON_MIN_DAYS = 0;   // 22.0 weeks
export const FENTON_MAX_DAYS = 196; // 50.0 weeks
export const FENTON_YEARS = [2013, 2025];
export const FENTON_METRICS = ["weight", "length", "hc"];

const METRIC_UNIT = { weight: "grams", length: "cm", hc: "cm" };
const METRIC_MIN_DAYS = {
  // Length and HC references only start partway through the range in both
  // Dr. Fenton's spreadsheets; weight covers the full 0-196 day span.
  weight: 0,
  length: 60, // ~30.6 weeks in the 2025 sheet is the earliest populated row for length in most editions; the DB itself is the source of truth, this is just a fast client-side rejection
  hc: 0,
};

export function normalizeSex(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["girls", "girl", "female", "f"].includes(s)) return "girls";
  if (["boys", "boy", "male", "m"].includes(s)) return "boys";
  return null;
}

export function normalizeMetric(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["weight", "wt"].includes(s)) return "weight";
  if (["length", "lt", "len"].includes(s)) return "length";
  if (["hc", "head_circumference", "head circumference", "headcircumference"].includes(s)) return "hc";
  return null;
}

/** (gestAgeWeeks, day) -> time_days axis used by the reference tables. */
export function ageInDays(gestAgeWeeks, day) {
  return (gestAgeWeeks - 22) * 7 + day;
}

/**
 * Parse ?sex=&metric=&reference_year=&gest_age_weeks=&day=&value=
 * `value` is grams for weight, cm for length/hc, matching the sheet.
 * Returns { sex, metric, referenceYear, gestAgeWeeks, day, timeDays, value } or { error }.
 */
export function parseFentonQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: boys or girls" };

  const metric = normalizeMetric(searchParams.get("metric"));
  if (!metric) return { error: "'metric' is required: weight, length, or hc" };

  const yearRaw = searchParams.get("reference_year");
  const referenceYear = yearRaw ? Number(yearRaw) : 2025;
  if (!FENTON_YEARS.includes(referenceYear)) {
    return { error: "'reference_year' must be 2013 or 2025 (default 2025)" };
  }

  const gestAgeWeeks = Number(searchParams.get("gest_age_weeks"));
  if (!Number.isFinite(gestAgeWeeks)) {
    return { error: "'gest_age_weeks' is required: gestational/postmenstrual age in completed weeks (22-50)" };
  }
  const dayRaw = searchParams.get("day");
  const day = dayRaw === null || dayRaw === "" ? 0 : Number(dayRaw);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return { error: "'day' must be a whole number 0-6 (day of the gestational week)" };
  }

  const timeDays = ageInDays(gestAgeWeeks, day);
  if (timeDays < FENTON_MIN_DAYS || timeDays > FENTON_MAX_DAYS) {
    return { error: `Age must be within 22.0-50.0 weeks gestation (got ${gestAgeWeeks}w${day}d)` };
  }
  if (timeDays < (METRIC_MIN_DAYS[metric] ?? 0)) {
    return { error: `'${metric}' reference data does not start this early; try an older age or 'weight'` };
  }

  const valueRaw = searchParams.get("value");
  const value = Number(valueRaw);
  if (valueRaw === null || valueRaw === "" || !Number.isFinite(value) || value <= 0) {
    return { error: `'value' is required: the measured ${metric} in ${METRIC_UNIT[metric]}` };
  }

  return { sex, metric, referenceYear, gestAgeWeeks, day, timeDays, value };
}

// Abramowitz & Stegun 7.1.26 approximation, ~1.5e-7 max error — matches
// Excel's NORMSDIST() closely enough for clinical percentile reporting.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * row: a fenton_preterm_lms table row { l, m, s }. value: the measurement.
 * metric: only "weight" gets the SD23 correction, per Dr. Fenton's sheet.
 * Returns { z, percentile } — never echoes l/m/s back to the caller.
 */
export function computeFentonZ(row, value, metric) {
  const L = Number(row.l), M = Number(row.m), S = Number(row.s);
  const rawZ = L !== 0 ? (Math.pow(value / M, L) - 1) / (L * S) : Math.log(value / M) / S;

  let z = rawZ;
  if (metric === "weight") {
    if (rawZ > 3) {
      const sd3 = M * Math.pow(1 + L * S * 3, 1 / L);
      const sd23 = M * Math.pow(1 + L * S * 3, 1 / L) - M * Math.pow(1 + L * S * 2, 1 / L);
      z = 3 + (value - sd3) / sd23;
    } else if (rawZ < -3) {
      const sd3neg = M * Math.pow(1 + L * S * -3, 1 / L);
      const sd23neg = M * Math.pow(1 + L * S * -2, 1 / L) - M * Math.pow(1 + L * S * -3, 1 / L);
      z = -3 + (value - sd3neg) / sd23neg;
    }
  }

  return { z: Math.round(z * 100) / 100, percentile: Math.round(normalCDF(z) * 1000) / 10 };
}

/** z -> a plain-language status. Generic interval-growth reading, NOT a
 * birth-only SGA/LGA call — see the note returned alongside it. */
export function statusFromZ(z) {
  if (z < -2) return "small";
  if (z > 2) return "large";
  return "appropriate";
}
