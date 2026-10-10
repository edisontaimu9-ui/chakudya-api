// Length VELOCITY (6-month increment) classification, birth to 24 months.
// Reference: WHO Child Growth Standards, simplified field tables "6-month
// length increments (cm)", z-scores -3 SD to +3 SD. Data lives in the
// `who_length_velocity` table (sql/019_add_who_length_velocity.sql, seed:
// scripts/who_length_velocity_seed.json).
//
// Same window logic and strict-inequality bands as src/hcVelocity.js (the
// classifier and z interpolation are shared):
//   < -3SD very low | < -2SD low | -2SD..+2SD within expected range |
//   > +2SD high | > +3SD very high
// This is NOT length-for-age: it says how fast the child grew over the
// window, not how long they are. Screening aid only, not a diagnosis.

import { normalizeSex, classifyHcVelocity } from "./hcVelocity.js";

export const LENGTH_VELOCITY_MIN_START = 0;
export const LENGTH_VELOCITY_MAX_START = 18;
export const LENGTH_VELOCITY_WINDOW_MONTHS = 6;

export { normalizeSex };

const round2 = (x) => Math.round(x * 100) / 100; // kills float noise: 70.6 - 55.1 = 15.499999999999993

/**
 * Parse ?sex=&start_age_months=&(increment_cm | length_start_cm & length_end_cm).
 * Optional &end_age_months= must equal start + 6 if given.
 * Returns { sex, startMonths, increment } or { error }.
 */
export function parseLengthVelocityQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const startRaw = searchParams.get("start_age_months");
  const startMonths = Number(startRaw);
  if (startRaw === null || startRaw === "" || !Number.isInteger(startMonths)) {
    return { error: "'start_age_months' is required (whole months at the FIRST measurement, e.g. a 3-month to 9-month window = 3)" };
  }
  if (startMonths < LENGTH_VELOCITY_MIN_START || startMonths > LENGTH_VELOCITY_MAX_START) {
    return {
      error: `'start_age_months' must be ${LENGTH_VELOCITY_MIN_START} to ${LENGTH_VELOCITY_MAX_START} (the WHO tables cover 6-month windows from 0-6 months up to 18-24 months)`,
    };
  }

  const endRaw = searchParams.get("end_age_months");
  if (endRaw !== null && endRaw !== "") {
    if (Number(endRaw) !== startMonths + LENGTH_VELOCITY_WINDOW_MONTHS) {
      return {
        error: `'end_age_months' must be exactly ${LENGTH_VELOCITY_WINDOW_MONTHS} months after 'start_age_months' (the WHO tables are 6-month increments only)`,
      };
    }
  }

  let increment;
  const incRaw = searchParams.get("increment_cm");
  if (incRaw !== null && incRaw !== "") {
    increment = Number(incRaw);
  } else {
    const a = searchParams.get("length_start_cm");
    const b = searchParams.get("length_end_cm");
    if (a === null || a === "" || b === null || b === "" || !(Number(a) > 0) || !(Number(b) > 0)) {
      return { error: "Provide 'increment_cm', or both 'length_start_cm' and 'length_end_cm' (length at the start and end of the 6-month window)" };
    }
    increment = Number(b) - Number(a);
  }
  if (!Number.isFinite(increment) || increment < -5 || increment > 30) {
    return { error: "Length increment is not plausible (expected roughly 3 to 22 cm over 6 months)" };
  }
  return { sex, startMonths, increment: round2(increment) };
}

/** row: a who_length_velocity table row. Same shape and bands as HC velocity. */
export const classifyLengthVelocity = classifyHcVelocity;
