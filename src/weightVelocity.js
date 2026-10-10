// Weight VELOCITY (6-month increment) classification, birth to 24 months.
// Reference: WHO Child Growth Standards, simplified field tables "6-month
// weight increments (g)". Data lives in the `who_weight_velocity` table
// (sql/020_add_who_weight_velocity.sql, seed: scripts/who_weight_velocity_seed.json).
//
// Units: the table is in GRAMS; callers may pass kilograms (weight_start_kg /
// weight_end_kg) or an increment in grams (increment_g).
//
// Bands (strict, shared with hcVelocity.js):
//   < -3SD very low | < -2SD low | -2SD..+2SD within expected range |
//   > +2SD high | > +3SD very high
// Because the table's L, M, S and Delta parameters are stored, the response also
// carries an exact z-score and percentile: z = (((x + Delta) / M)^L - 1) / (L * S).
// Weight increments are noisy (feeds, illness, scale error): screening aid only,
// not a diagnosis. This is NOT weight-for-age.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";

export const WEIGHT_VELOCITY_MIN_START = 0;
export const WEIGHT_VELOCITY_MAX_START = 18;
export const WEIGHT_VELOCITY_WINDOW_MONTHS = 6;

export { normalizeSex };

/**
 * Parse ?sex=&start_age_months=&(increment_g | weight_start_kg & weight_end_kg).
 * Optional &end_age_months= must equal start + 6 if given.
 * Returns { sex, startMonths, incrementG } or { error }.
 */
export function parseWeightVelocityQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const startRaw = searchParams.get("start_age_months");
  const startMonths = Number(startRaw);
  if (startRaw === null || startRaw === "" || !Number.isInteger(startMonths)) {
    return { error: "'start_age_months' is required (whole months at the FIRST weighing, e.g. a 3-month to 9-month window = 3)" };
  }
  if (startMonths < WEIGHT_VELOCITY_MIN_START || startMonths > WEIGHT_VELOCITY_MAX_START) {
    return {
      error: `'start_age_months' must be ${WEIGHT_VELOCITY_MIN_START} to ${WEIGHT_VELOCITY_MAX_START} (the WHO tables cover 6-month windows from 0-6 months up to 18-24 months)`,
    };
  }

  const endRaw = searchParams.get("end_age_months");
  if (endRaw !== null && endRaw !== "") {
    if (Number(endRaw) !== startMonths + WEIGHT_VELOCITY_WINDOW_MONTHS) {
      return {
        error: `'end_age_months' must be exactly ${WEIGHT_VELOCITY_WINDOW_MONTHS} months after 'start_age_months' (the WHO tables are 6-month increments only)`,
      };
    }
  }

  let incrementG;
  const incRaw = searchParams.get("increment_g");
  if (incRaw !== null && incRaw !== "") {
    incrementG = Number(incRaw);
  } else {
    const a = searchParams.get("weight_start_kg");
    const b = searchParams.get("weight_end_kg");
    if (a === null || a === "" || b === null || b === "" || !(Number(a) > 0) || !(Number(b) > 0)) {
      return { error: "Provide 'increment_g', or both 'weight_start_kg' and 'weight_end_kg' (weight at the start and end of the 6-month window, in kg)" };
    }
    incrementG = (Number(b) - Number(a)) * 1000;
  }
  if (!Number.isFinite(incrementG) || incrementG < -2000 || incrementG > 12000) {
    return { error: "Weight increment is not plausible (expected roughly 0 to 7000 g over 6 months; check you passed kg for weights and grams for increment_g)" };
  }
  return { sex, startMonths, incrementG: Math.round(incrementG * 10) / 10 }; // 0.1 g kills float noise from kg subtraction
}

/** Exact LMS z-score (with WHO Delta shift); null when the shifted value is not positive. */
export function lmsZ(row, incrementG) {
  const L = Number(row.lms_l), M = Number(row.lms_m), S = Number(row.lms_s), D = Number(row.delta_g);
  const shifted = incrementG + D;
  if (!(shifted > 0) || !(M > 0) || !(S > 0)) return null;
  const z = L === 0 ? Math.log(shifted / M) / S : (Math.pow(shifted / M, L) - 1) / (L * S);
  return Number.isFinite(z) ? z : null;
}

// Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7).
export function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

/** row: a who_weight_velocity row. Returns { status, increment_g, z_score, percentile, cutoffs }. */
export function classifyWeightVelocity(row, incrementG) {
  const { status, cutoffs } = classifyHcVelocity(row, incrementG);
  const z = lmsZ(row, incrementG);
  return {
    status,
    increment_g: incrementG,
    z_score: z === null ? null : Math.round(z * 100) / 100,
    percentile: z === null ? null : Math.round(normalCdf(z) * 1000) / 10,
    cutoffs,
  };
}
