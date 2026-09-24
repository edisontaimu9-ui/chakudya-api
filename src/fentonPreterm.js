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

// Exact earliest tabulated age per (reference_year, metric), in days since 22
// completed weeks gestation — verified against the seeded data (not a guess).
// An age below this for a given year+metric has no reference row, so the DB
// lookup will correctly 404; this just gives a clearer client-side message
// before making that round trip. NOTE: a prior version of this file had a
// wrong metric-only guess here (length: 60 days) that incorrectly rejected
// valid length queries between 23.5-30.6 weeks — fixed by keying on
// (year, metric) against the real data instead of approximating.
const METRIC_MIN_DAYS_BY_YEAR = {
  2013: { weight: 4.0, length: 10.5, hc: 10.5 },
  2025: { weight: 3.5, length: 10.5, hc: 3.5 },
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

/** Validates one {gestAgeWeeks, day} pair against the overall 22-50 week
 * range and, if referenceYear is known, the metric's real earliest row.
 * Returns { timeDays } or { error }. */
function validateAge(gestAgeWeeks, day, metric, referenceYear) {
  if (!Number.isFinite(gestAgeWeeks)) {
    return { error: "'gest_age_weeks' is required: gestational/postmenstrual age in completed weeks (22-50)" };
  }
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return { error: "'day' must be a whole number 0-6 (day of the gestational week)" };
  }
  const timeDays = ageInDays(gestAgeWeeks, day);
  if (timeDays < FENTON_MIN_DAYS || timeDays > FENTON_MAX_DAYS) {
    return { error: `Age must be within 22.0-50.0 weeks gestation (got ${gestAgeWeeks}w${day}d)` };
  }
  const floor = METRIC_MIN_DAYS_BY_YEAR[referenceYear]?.[metric];
  if (floor !== undefined && timeDays < floor) {
    const floorWeeks = Math.round((22 + floor / 7) * 10) / 10;
    return { error: `'${metric}' reference data (${referenceYear}) starts at ${floorWeeks} weeks; try an older age` };
  }
  return { timeDays };
}

function validateReferenceYear(yearRaw) {
  const referenceYear = yearRaw === undefined || yearRaw === null || yearRaw === "" ? 2025 : Number(yearRaw);
  if (!FENTON_YEARS.includes(referenceYear)) {
    return { error: "'reference_year' must be 2013 or 2025 (default 2025)" };
  }
  return { referenceYear };
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

  const yr = validateReferenceYear(searchParams.get("reference_year"));
  if (yr.error) return yr;
  const { referenceYear } = yr;

  const gestAgeWeeks = Number(searchParams.get("gest_age_weeks"));
  const dayRaw = searchParams.get("day");
  const day = dayRaw === null || dayRaw === "" ? 0 : Number(dayRaw);
  const age = validateAge(gestAgeWeeks, day, metric, referenceYear);
  if (age.error) return age;
  const { timeDays } = age;

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

/** row + value + metric -> { z, percentile, status } in one call. */
export function classifyRow(row, value, metric) {
  const { z, percentile } = computeFentonZ(row, value, metric);
  return { z, percentile, status: statusFromZ(z) };
}

export const SCREENING_NOTE =
  "Screening aid only, not a diagnosis. SGA/LGA labels are only valid AT BIRTH per Fenton's own guidance; " +
  "'status' is a generic +/-2SD read usable at any age for interval growth monitoring. Weight includes the " +
  "WHO SD23 correction for extreme values; length/HC do not (matches Fenton's own calculator).";

/**
 * Parse a POST /fenton-preterm/profile body:
 * { sex, reference_year?, gest_age_weeks, day?, weight?, length?, hc? }
 * At least one of weight/length/hc required. Returns
 * { sex, referenceYear, gestAgeWeeks, day, timeDaysByMetric, values } or { error }.
 * timeDaysByMetric differs per metric only in its floor validation — the
 * time_days value itself is the same age for every metric in one profile.
 */
export function parseProfileBody(body) {
  if (!body || typeof body !== "object") return { error: "JSON body required." };

  const sex = normalizeSex(body.sex);
  if (!sex) return { error: "'sex' is required: boys or girls" };

  const yr = validateReferenceYear(body.reference_year);
  if (yr.error) return yr;
  const { referenceYear } = yr;

  const gestAgeWeeks = Number(body.gest_age_weeks);
  const day = body.day === undefined || body.day === null ? 0 : Number(body.day);

  const values = {};
  for (const m of FENTON_METRICS) {
    const v = body[m];
    if (v !== undefined && v !== null && v !== "") {
      const num = Number(v);
      if (!Number.isFinite(num) || num <= 0) return { error: `'${m}' must be a positive number` };
      values[m] = num;
    }
  }
  const metrics = Object.keys(values);
  if (metrics.length === 0) return { error: "Provide at least one of: weight, length, hc." };

  // Age is validated once per metric present (floors differ by metric/year).
  const timeDaysByMetric = {};
  for (const m of metrics) {
    const age = validateAge(gestAgeWeeks, day, m, referenceYear);
    if (age.error) return { error: `${m}: ${age.error}` };
    timeDaysByMetric[m] = age.timeDays;
  }

  return { sex, referenceYear, gestAgeWeeks, day, values, timeDaysByMetric };
}

const MAX_SERIES_POINTS = 50;

/**
 * Parse a POST /fenton-preterm/growth or /velocity body:
 * { sex, metric, reference_year?, measurements: [{gest_age_weeks, day?, value}, ...] }
 * Returns { sex, metric, referenceYear, measurements: [{gestAgeWeeks, day, timeDays, value}, ...] }
 * sorted chronologically, or { error }.
 */
export function parseSeriesBody(body) {
  if (!body || typeof body !== "object") return { error: "JSON body required." };

  const sex = normalizeSex(body.sex);
  if (!sex) return { error: "'sex' is required: boys or girls" };

  const metric = normalizeMetric(body.metric);
  if (!metric) return { error: "'metric' is required: weight, length, or hc" };

  const yr = validateReferenceYear(body.reference_year);
  if (yr.error) return yr;
  const { referenceYear } = yr;

  if (!Array.isArray(body.measurements) || body.measurements.length < 1) {
    return { error: "'measurements' is required: an array of {gest_age_weeks, day, value}" };
  }
  if (body.measurements.length > MAX_SERIES_POINTS) {
    return { error: `'measurements' is limited to ${MAX_SERIES_POINTS} points per request` };
  }

  const parsed = [];
  for (const [i, m] of body.measurements.entries()) {
    const gestAgeWeeks = Number(m?.gest_age_weeks);
    const day = m?.day === undefined || m?.day === null ? 0 : Number(m.day);
    const value = Number(m?.value);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `measurements[${i}].value must be a positive number` };
    }
    const age = validateAge(gestAgeWeeks, day, metric, referenceYear);
    if (age.error) return { error: `measurements[${i}]: ${age.error}` };
    parsed.push({ gestAgeWeeks, day, timeDays: age.timeDays, value });
  }
  parsed.sort((a, b) => a.timeDays - b.timeDays);

  return { sex, metric, referenceYear, measurements: parsed };
}

/**
 * A simple, descriptive (not diagnostic) trend read over a classified
 * series: first/last/min/max z, and which consecutive gaps show a
 * z-score drop of >=0.67 (roughly the width of one major percentile band —
 * a commonly cited descriptive threshold, not a clinical recommendation).
 */
export function summarizeTrend(classifiedPoints) {
  const zs = classifiedPoints.map((p) => p.z);
  const first = zs[0], last = zs[zs.length - 1];
  const notableDrops = [];
  for (let i = 1; i < classifiedPoints.length; i++) {
    const delta = classifiedPoints[i].z - classifiedPoints[i - 1].z;
    if (delta <= -0.67) {
      notableDrops.push({
        from_gest_age_weeks: classifiedPoints[i - 1].gest_age_weeks,
        to_gest_age_weeks: classifiedPoints[i].gest_age_weeks,
        z_change: Math.round(delta * 100) / 100,
      });
    }
  }
  return {
    first_z: first,
    last_z: last,
    z_change_overall: Math.round((last - first) * 100) / 100,
    min_z: Math.min(...zs),
    max_z: Math.max(...zs),
    notable_drops: notableDrops,
    note:
      "Descriptive only — a z-score drop of >=0.67 between consecutive points is flagged as a notable " +
      "percentile-band crossing (roughly one major centile line), not a clinical threshold or diagnosis. " +
      "Use clinical judgement / local guidance for growth-faltering assessment.",
  };
}

/**
 * Growth velocity between two measurements of the SAME metric.
 * m1/m2: { timeDays, value }, m1 chronologically first. Weight uses the
 * average-weight method (delta-weight / average-weight-kg / days), the
 * long-standing NICU convention (e.g. Ehrenkranz-style); length/hc use
 * simple cm/week. Returns { velocity, unit, days, method } or { error }.
 */
export function computeVelocity(metric, m1, m2) {
  const days = m2.timeDays - m1.timeDays;
  if (days <= 0) {
    return { error: "Measurements must be in chronological order with different ages." };
  }
  if (metric === "weight") {
    const avgKg = (m1.value + m2.value) / 2 / 1000;
    const velocity = (m2.value - m1.value) / avgKg / days;
    return {
      velocity: Math.round(velocity * 10) / 10,
      unit: "g/kg/day",
      days,
      method: "average-weight method: (delta weight) / (average weight in kg) / days",
    };
  }
  const velocity = ((m2.value - m1.value) / days) * 7;
  return { velocity: Math.round(velocity * 100) / 100, unit: "cm/week", days, method: "simple: (delta value / days) * 7" };
}

/**
 * Static metadata for GET /fenton-preterm/references — years, sexes,
 * metrics, exact valid age ranges (verified against the seeded data, see
 * METRIC_MIN_DAYS_BY_YEAR above), citations, and the license summary.
 * Deliberately contains NO L/M/S values or anything the curve could be
 * reconstructed from.
 */
export const FENTON_REFERENCES_META = {
  reference_years: [
    {
      year: 2013,
      citation: "Fenton TR, Kim JH. A systematic review and meta-analysis to revise the Fenton growth chart for preterm infants. BMC Pediatrics. 2013;13:59.",
      doi: "10.1186/1471-2431-13-59",
    },
    {
      year: 2025,
      citation: "Fenton TR, Elmrayed S, Alshaikh BN, et al. Fenton preterm growth chart, 3rd generation. Paediatric and Perinatal Epidemiology. 2025.",
      doi: "10.1111/ppe.70035",
      pmid: 40534585,
    },
  ],
  default_reference_year: 2025,
  sexes: ["boys", "girls"],
  metrics: [
    { metric: "weight", unit: "grams" },
    { metric: "length", unit: "cm" },
    { metric: "hc", unit: "cm", label: "head circumference" },
  ],
  overall_age_range_weeks: { min: 22.0, max: 50.0 },
  metric_age_ranges_weeks: {
    2013: { weight: { min: 22.6, max: 50.0 }, length: { min: 23.5, max: 50.0 }, hc: { min: 23.5, max: 50.0 } },
    2025: { weight: { min: 22.5, max: 50.0 }, length: { min: 23.5, max: 50.0 }, hc: { min: 22.5, max: 50.0 } },
  },
  license: {
    type: "CC BY-NC-ND 4.0",
    url: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
    scope: "Non-commercial use within this application only.",
    conditions: [
      "Underlying LMS reference data is never exposed to end users.",
      "Not shared with other hospitals or organizations.",
    ],
    source: "Dr. Tanis Fenton, Cumming School of Medicine, University of Calgary (data shared by email, 2026-09-23).",
  },
  endpoints: [
    "GET /fenton-preterm/classify — single measurement",
    "POST /fenton-preterm/profile — weight+length+HC at one timepoint",
    "POST /fenton-preterm/growth — a series of same-metric measurements over time",
    "POST /fenton-preterm/velocity — growth velocity between measurements",
    "GET /fenton-preterm/chart — rendered SVG chart image",
  ],
};

