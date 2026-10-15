// BMI-for-age percentile for the energy engine's child equations (IOM child equations split at the 85th percentile).
//   Ages 61-228 months: bmi_for_age stores only the -3..+3 SD cut-offs (no L/M/S), so z is interpolated linearly between
//     the cut-offs and extended past +/-3 SD the way WHO does. The 85th percentile (z = 1.036) falls between +1 SD and
//     +2 SD, where this is accurate to a few hundredths of a BMI unit. Result is labelled as interpolated.
//   Ages 36-60 months: who_bmi_for_age_under_5 has L/M/S, so z (and the percentile) is exact.
// Pure functions here; the database reads are in energyLookup.js.

import { bmiZ } from "./bmiForAgeUnder5.js";
import { normalCdf } from "./weightVelocity.js";

const pct = (z) => Math.round(normalCdf(z) * 1000) / 10;

/** row: bmi_for_age row (sd_neg3 ... sd_pos3). Returns { z, percentile, method } or null. */
export function percentileFromSdCutoffs(row, bmi) {
  const pts = [[-3, row.sd_neg3], [-2, row.sd_neg2], [-1, row.sd_neg1], [0, row.median], [1, row.sd_pos1], [2, row.sd_pos2], [3, row.sd_pos3]]
    .map(([z, v]) => [z, Number(v)]);
  if (pts.some(([, v]) => !Number.isFinite(v)) || !Number.isFinite(bmi) || bmi <= 0) return null;
  for (let i = 1; i < pts.length; i++) if (!(pts[i][1] > pts[i - 1][1])) return null;
  let z;
  if (bmi <= pts[0][1]) z = -3 + (bmi - pts[0][1]) / (pts[1][1] - pts[0][1]);
  else if (bmi >= pts[6][1]) z = 3 + (bmi - pts[6][1]) / (pts[6][1] - pts[5][1]);
  else {
    let i = 1;
    while (bmi > pts[i][1]) i++;
    const [z0, v0] = pts[i - 1]; const [z1, v1] = pts[i];
    z = z0 + ((bmi - v0) / (v1 - v0)) * (z1 - z0);
  }
  return { z: Math.round(z * 100) / 100 + 0, percentile: pct(z), method: "interpolated between the WHO -3 to +3 SD BMI cut-offs" };
}

/** row: who_bmi_for_age_under_5 row. Exact LMS z. */
export function percentileFromLms(row, bmi) {
  const z = bmiZ(row, bmi);
  if (z === null) return null;
  return { z: Math.round(z * 100) / 100 + 0, percentile: pct(z), method: "exact from the WHO L, M, S values" };
}
