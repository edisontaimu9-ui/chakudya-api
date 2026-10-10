// Head circumference VELOCITY (6-month increment) classification, birth to 24 months.
// Reference: WHO Child Growth Standards, simplified field tables "6-month head
// circumference increments (cm)", z-scores -3 SD to +3 SD. Data lives in the
// `who_hc_velocity` table (sql/018_add_who_hc_velocity.sql, seed:
// scripts/who_hc_velocity_seed.json).
//
// The tables cover exact 6-month windows only (0-6, 1-7, ... 18-24 months), so
// the caller supplies the start age of the window. Bands use strict
// inequalities against the table cut-offs:
//   < -3SD very low | < -2SD low | -2SD..+2SD within expected range |
//   > +2SD high | > +3SD very high
// This is NOT head-circumference-for-age: it says how fast the head grew over
// the window, not how big it is. Screening aid only, not a diagnosis.

export const HC_VELOCITY_MIN_START = 0;
export const HC_VELOCITY_MAX_START = 18;
export const HC_VELOCITY_WINDOW_MONTHS = 6;

export function normalizeSex(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["girls", "girl", "female", "f"].includes(s)) return "girls";
  if (["boys", "boy", "male", "m"].includes(s)) return "boys";
  return null;
}

const round2 = (x) => Math.round(x * 100) / 100; // kills float noise: 45.3 - 41.2 = 4.100000000000001

/**
 * Parse ?sex=&start_age_months=&(increment_cm | hc_start_cm & hc_end_cm).
 * Optional &end_age_months= must equal start + 6 if given.
 * Returns { sex, startMonths, increment } or { error }.
 */
export function parseHcVelocityQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };

  const startRaw = searchParams.get("start_age_months");
  const startMonths = Number(startRaw);
  if (startRaw === null || startRaw === "" || !Number.isInteger(startMonths)) {
    return { error: "'start_age_months' is required (whole months at the FIRST measurement, e.g. a 3-month to 9-month window = 3)" };
  }
  if (startMonths < HC_VELOCITY_MIN_START || startMonths > HC_VELOCITY_MAX_START) {
    return {
      error: `'start_age_months' must be ${HC_VELOCITY_MIN_START} to ${HC_VELOCITY_MAX_START} (the WHO tables cover 6-month windows from 0-6 months up to 18-24 months)`,
    };
  }

  const endRaw = searchParams.get("end_age_months");
  if (endRaw !== null && endRaw !== "") {
    if (Number(endRaw) !== startMonths + HC_VELOCITY_WINDOW_MONTHS) {
      return {
        error: `'end_age_months' must be exactly ${HC_VELOCITY_WINDOW_MONTHS} months after 'start_age_months' (the WHO tables are 6-month increments only)`,
      };
    }
  }

  let increment;
  const incRaw = searchParams.get("increment_cm");
  if (incRaw !== null && incRaw !== "") {
    increment = Number(incRaw);
  } else {
    const a = searchParams.get("hc_start_cm");
    const b = searchParams.get("hc_end_cm");
    if (a === null || a === "" || b === null || b === "" || !(Number(a) > 0) || !(Number(b) > 0)) {
      return { error: "Provide 'increment_cm', or both 'hc_start_cm' and 'hc_end_cm' (head circumference at the start and end of the 6-month window)" };
    }
    increment = Number(b) - Number(a);
  }
  if (!Number.isFinite(increment) || increment < -5 || increment > 20) {
    return { error: "Head circumference increment is not plausible (expected roughly 0 to 13 cm over 6 months)" };
  }
  return { sex, startMonths, increment: round2(increment) };
}

/** Piecewise-linear z between the printed SD points; null outside -3..+3. */
export function approxZ(cut, x) {
  const pts = [
    [-3, cut["-3SD"]], [-2, cut["-2SD"]], [-1, cut["-1SD"]], [0, cut.median],
    [1, cut["+1SD"]], [2, cut["+2SD"]], [3, cut["+3SD"]],
  ];
  if (x < pts[0][1] || x > pts[6][1]) return null;
  for (let i = 0; i < 6; i++) {
    const [z0, v0] = pts[i];
    const [z1, v1] = pts[i + 1];
    if (x >= v0 && x <= v1) {
      if (v1 === v0) return z0; // tied cut-offs (e.g. 0.0 / 0.0 at the low tail): no spread to interpolate
      return Math.round((z0 + ((x - v0) / (v1 - v0)) * (z1 - z0)) * 100) / 100;
    }
  }
  return null;
}

/** row: a who_hc_velocity table row. Returns { status, increment_cm, z_approx, cutoffs }. */
export function classifyHcVelocity(row, increment) {
  const c = {
    "-3SD": Number(row.sd_neg3), "-2SD": Number(row.sd_neg2), "-1SD": Number(row.sd_neg1),
    median: Number(row.median), "+1SD": Number(row.sd_pos1), "+2SD": Number(row.sd_pos2), "+3SD": Number(row.sd_pos3),
  };
  let status;
  if (increment < c["-3SD"]) status = "very low increment";
  else if (increment < c["-2SD"]) status = "low increment";
  else if (increment <= c["+2SD"]) status = "within expected range";
  else if (increment <= c["+3SD"]) status = "high increment";
  else status = "very high increment";
  return { status, increment_cm: increment, z_approx: approxZ(c, increment), cutoffs: c };
}
