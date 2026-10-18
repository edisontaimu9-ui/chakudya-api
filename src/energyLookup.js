// Database lookups for the energy engine, kept apart so the engine stays pure.
// enrichBmiPercentile(): for children 3-18 y with weight and height but no bmi_for_age_percentile, look the percentile
// up in the existing WHO tables (who_bmi_for_age_under_5 for 36-60 months, bmi_for_age for 61-228 months) and put it
// on a copy of the request body, with where it came from. Never throws and never blocks the calculation.

import { normalizeSexMF } from "./energyEngine.js";
import { percentileFromLms, percentileFromSdCutoffs } from "./bmiPercentile.js";
import { activityLogToPalEntries, computeActivityEnergy } from "./activityEnergy.js";

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

/**
 * activity_log [{ activity, type?, minutes|hours }]: look each activity up in the activity_energy_expenditure table
 * (Krause Appendix 10) and add it to the request's `activities` as PAL entries. Unlike the BMI lookup this is something the
 * caller asked for, so a problem is returned as { error, status } instead of being skipped.
 * Returns { body, activityLog } (activityLog null when the body has no activity_log) or { error, status }.
 */
export async function enrichActivityLog(body, db) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !present(body.activity_log)) return { body, activityLog: null };
  if (!Array.isArray(body.activity_log) || !body.activity_log.length) return { error: "activity_log must be a non-empty array of { activity, type?, minutes | hours }", status: 400 };
  if (present(body.activities) && !Array.isArray(body.activities)) return { error: "activities must be an array", status: 400 };
  let rows;
  try {
    const r = await db.select("activity_energy_expenditure", { limit: 500, order: "activity.asc,type.asc" });
    if (!r.ok) return { error: "Activity table could not be read (has sql/033 been run and seeded?)", status: 502 };
    rows = Array.isArray(r.body) ? r.body : [];
  } catch (_) {
    return { error: "Activity table could not be read", status: 502 };
  }
  if (!rows.length) return { error: "Activity table is empty. Seed it with POST /activity-energy/bulk (admin)", status: 503 };
  const out = activityLogToPalEntries({ weight_kg: body.weight_kg, activity_log: body.activity_log }, rows);
  if (out.error) return { error: out.error, status: 400 };
  const existing = Array.isArray(body.activities) ? body.activities : [];
  return { body: { ...body, activities: [...existing, ...out.entries] }, activityLog: out.log };
}

/**
 * activity_log [{ activity, type?, minutes|hours }] for the sports routes: the same Appendix 10 lookup, returned as kcal
 * (computeActivityEnergy) instead of PAL entries. Returns { activityLog } (null when the body has no activity_log) or { error, status }.
 */
export async function lookupActivityLogEnergy(body, db) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !present(body.activity_log)) return { activityLog: null };
  if (!Array.isArray(body.activity_log) || !body.activity_log.length) return { error: "activity_log must be a non-empty array of { activity, type?, minutes | hours }", status: 400 };
  let rows;
  try {
    const r = await db.select("activity_energy_expenditure", { limit: 500, order: "activity.asc,type.asc" });
    if (!r.ok) return { error: "Activity table could not be read (has sql/033 been run and seeded?)", status: 502 };
    rows = Array.isArray(r.body) ? r.body : [];
  } catch (_) {
    return { error: "Activity table could not be read", status: 502 };
  }
  if (!rows.length) return { error: "Activity table is empty. Seed it with POST /activity-energy/bulk (admin)", status: 503 };
  const out = computeActivityEnergy({ weight_kg: body.weight_kg, activities: body.activity_log }, rows);
  if (!out.ok) return { error: String(out.error).replace(/^activities\[/, "activity_log[").replace(/^activities must/, "activity_log must"), status: 400 };
  return { activityLog: out.data };
}
