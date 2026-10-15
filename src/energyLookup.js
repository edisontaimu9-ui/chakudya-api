// Database lookups for the energy engine, kept apart so the engine stays pure.
// enrichBmiPercentile(): for children 3-18 y with weight and height but no bmi_for_age_percentile, look the percentile
// up in the existing WHO tables (who_bmi_for_age_under_5 for 36-60 months, bmi_for_age for 61-228 months) and put it
// on a copy of the request body, with where it came from. Never throws and never blocks the calculation.

import { normalizeSexMF } from "./energyEngine.js";
import { percentileFromLms, percentileFromSdCutoffs } from "./bmiPercentile.js";

const present = (v) => v !== undefined && v !== null && v !== "";

export async function enrichBmiPercentile(body, db) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (present(body.bmi_for_age_percentile)) return body;
  const sex = normalizeSexMF(body.sex);
  if (!sex) return body;

  let ageMonths = null;
  if (present(body.age_months)) ageMonths = Number(body.age_months);
  else if (present(body.age_years)) ageMonths = Math.floor(Number(body.age_years) * 12);
  const weightKg = Number(body.weight_kg);
  let heightM = NaN;
  if (present(body.height_cm)) heightM = Number(body.height_cm) / 100;
  else if (present(body.height_m)) heightM = Number(body.height_m);
  if (!Number.isFinite(ageMonths) || ageMonths < 36 || ageMonths > 227) return body; // not a 3-18 y child
  if (!Number.isFinite(weightKg) || weightKg <= 0 || !Number.isFinite(heightM) || heightM < 0.3 || heightM > 2.6) return body;

  const bmi = weightKg / (heightM * heightM);
  const tableSex = sex === "male" ? "boys" : "girls";
  const fail = (reason) => ({ ...body, bmi_percentile_lookup_error: reason });
  try {
    if (ageMonths <= 60) {
      const r = await db.select("who_bmi_for_age_under_5", { filters: { sex: `eq.${tableSex}`, age_months: `eq.${ageMonths}`, measured: "eq.standing" }, limit: 1 });
      const row = r.ok && Array.isArray(r.body) ? r.body[0] : null;
      if (!row) return fail("WHO under-5 BMI-for-age table has no row for this age (has sql/026 been run and seeded?)");
      const p = percentileFromLms(row, bmi);
      if (!p) return fail("could not compute a z-score from the WHO under-5 row");
      return { ...body, bmi_for_age_percentile: p.percentile, bmi_percentile_source: `WHO BMI-for-age 0-60 months, ${tableSex}, ${ageMonths} months, standing; BMI ${Math.round(bmi * 10) / 10}, z ${p.z}, ${p.method}` };
    }
    const r = await db.select("bmi_for_age", { filters: { sex: `eq.${tableSex}`, age_months: `eq.${ageMonths}` }, limit: 1 });
    const row = r.ok && Array.isArray(r.body) ? r.body[0] : null;
    if (!row) return fail("WHO 5-19 y BMI-for-age table has no row for this age (has sql/012 been run and seeded?)");
    const p = percentileFromSdCutoffs(row, bmi);
    if (!p) return fail("could not compute a z-score from the WHO 5-19 y row");
    return { ...body, bmi_for_age_percentile: p.percentile, bmi_percentile_source: `WHO BMI-for-age 5-19 years, ${tableSex}, ${ageMonths} months; BMI ${Math.round(bmi * 10) / 10}, z ${p.z}, ${p.method}` };
  } catch (_) {
    return fail("BMI-for-age lookup failed");
  }
}
