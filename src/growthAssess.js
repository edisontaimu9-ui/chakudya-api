// Combined growth assessment (/growth/assess): one call, every applicable WHO
// indicator for the measurements supplied. It only orchestrates the existing
// single-indicator modules, so every number matches what the individual
// endpoints return:
//   length/height-for-age (0-228 months)   lengthHeightForAge.js
//   weight-for-age        (0-120)          weightForAge.js
//   weight-for-length/height (0-60)        weightForLengthHeight.js
//   BMI-for-age           (0-60 | 61-228)  bmiForAgeUnder5.js | bmiForAge.js
//   head circumference-for-age (0-60)      hcForAge.js
//   MUAC-for-age z-score  (3-60)           muacForAge.js
//   MUAC fixed cut-offs   (6+)             muacFixed.js
//
// An indicator whose measurement is missing, or whose age range does not apply,
// is listed under `not_assessed` with the reason. A bad value in one measurement
// (say MUAC typed in mm) only errors that indicator. Screening aid only.

import { normalizeSex } from "./hcVelocity.js";
import { parseLhfaQuery, pickRowAndValue, classifyLhfa } from "./lengthHeightForAge.js";
import { parseWeightForAgeQuery, classifyWeightForAge } from "./weightForAge.js";
import { parseWflhQuery, resolveLookup, classifyWflh } from "./weightForLengthHeight.js";
import { parseBmiUnder5Query, resolveBmi, classifyBmiUnder5 } from "./bmiForAgeUnder5.js";
import { parseBmiForAgeQuery, classifyBmiForAge } from "./bmiForAge.js";
import { parseHcForAgeQuery, classifyHcForAge } from "./hcForAge.js";
import { parseMuacForAgeQuery, classifyMuacForAge } from "./muacForAge.js";
import { parseMuacFixedQuery, classifyMuacFixed } from "./muacFixed.js";
import { LYING_STANDING_DIFF_CM } from "./lengthHeightForAge.js";

export const ASSESS_MAX_MONTHS = 228;

const WEIGHT_PARAMS = ["weight_kg", "weight_g"];
const LENGTH_PARAMS = ["length_cm", "height_cm", "length_mm", "height_mm"];
const HC_PARAMS = ["hc_cm", "hc_mm"];
const MUAC_PARAMS = ["muac_cm", "muac_mm"];
const ALL_MEASUREMENT_PARAMS = [...WEIGHT_PARAMS, ...LENGTH_PARAMS, ...HC_PARAMS, ...MUAC_PARAMS];

const has = (sp, names) => names.some((n) => sp.get(n) !== null && sp.get(n) !== "");

/** Parse the shared inputs. Returns { sex, ageMonths, searchParams } or { error }. */
export function parseAssessQuery(searchParams) {
  const sex = normalizeSex(searchParams.get("sex"));
  if (!sex) return { error: "'sex' is required: girls or boys" };
  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months, e.g. 1 year 6 months = 18)" };
  }
  if (ageMonths < 0 || ageMonths > ASSESS_MAX_MONTHS) {
    return { error: `'age_months' must be 0 to ${ASSESS_MAX_MONTHS} (birth to 19 years)` };
  }
  if (!has(searchParams, ALL_MEASUREMENT_PARAMS)) {
    return { error: "Provide at least one measurement: weight_kg/weight_g, length_cm/height_cm (or _mm), hc_cm/hc_mm, muac_cm/muac_mm" };
  }
  const scheme = (searchParams.get("muac_scheme") || "who_hiv_2008").trim().toLowerCase();
  if (!["who_hiv_2008", "cmam"].includes(scheme)) return { error: "'muac_scheme' must be who_hiv_2008 or cmam" };
  return { sex, ageMonths, searchParams, muacScheme: scheme };
}

/** Build the query string one single-indicator parser expects. */
function sub(base, names) {
  const p = new URLSearchParams();
  p.set("sex", base.sex);
  p.set("age_months", String(base.ageMonths));
  for (const n of names) {
    const v = base.searchParams.get(n);
    if (v !== null && v !== "") p.set(n, v);
  }
  return p;
}

const NORMAL = new Set(["normal", "within expected range"]);
// Tallness and a high weight-for-age are not problems by themselves (WHO), so they only "watch".
const WATCH = new Set(["possible risk of overweight", "tall", "very tall", "high weight-for-age", "very high weight-for-age", "high", "very high"]);

/** "ok" | "watch" | "concern" | "severe" for a status string. */
export function severityOf(status) {
  if (NORMAL.has(status)) return "ok";
  if (status === "severe wasting" || status === "severe microcephaly" || status === "severe macrocephaly" ||
      status === "severely stunted" || status === "severely underweight" || status === "severe thinness" ||
      status === "very low" || status === "severe") return "severe";
  if (WATCH.has(status)) return "watch";
  return "concern";
}

/**
 * query: from parseAssessQuery. fetchRows(table, filters, limit) -> array of rows
 * (filters in PostgREST form: { sex: "eq.girls", ... }); may throw.
 */
export async function assessGrowth(query, fetchRows) {
  const { sex, ageMonths } = query;
  const base = { sex, ageMonths, searchParams: query.searchParams };
  const sp = query.searchParams;
  const hasWeight = has(sp, WEIGHT_PARAMS), hasLength = has(sp, LENGTH_PARAMS);
  const hasHc = has(sp, HC_PARAMS), hasMuac = has(sp, MUAC_PARAMS);

  const indicators = {};
  const notAssessed = [];
  const skip = (indicator, reason) => notAssessed.push({ indicator, reason });
  const jobs = [];
  const run = (name, fn) => jobs.push((async () => {
    try { indicators[name] = await fn(); } catch (e) { indicators[name] = { error: e?.message || "Lookup failed" }; }
  })());
  const one = async (table, filters, limit = 1) => {
    const rows = await fetchRows(table, filters, limit);
    return Array.isArray(rows) ? rows : [];
  };
  const missingRef = (what) => ({ error: `${what} reference row not found (is the table seeded?)` });

  // 1. length/height-for-age
  if (!hasLength) skip("length_height_for_age", "needs length_cm or height_cm");
  else run("length_height_for_age", async () => {
    const parsed = parseLhfaQuery(sub(base, [...LENGTH_PARAMS, "measured"]));
    if (parsed.error) return { error: parsed.error };
    const rows = await one("who_length_height_for_age", { sex: `eq.${sex}`, age_months: `eq.${ageMonths}` }, 2);
    const picked = pickRowAndValue(rows, parsed.measured, parsed.valueCm);
    if (!picked) return missingRef("Length/height-for-age");
    return { ...(picked.adjustment ? { position_adjustment: picked.adjustment } : {}), ...classifyLhfa(picked.row, picked.valueCm) };
  });

  // 2. weight-for-age
  if (!hasWeight) skip("weight_for_age", "needs weight_kg");
  else if (ageMonths > 120) skip("weight_for_age", "WHO publishes weight-for-age only to 10 years (120 months); see bmi_for_age");
  else run("weight_for_age", async () => {
    const parsed = parseWeightForAgeQuery(sub(base, WEIGHT_PARAMS));
    if (parsed.error) return { error: parsed.error };
    const rows = await one("who_weight_for_age", { sex: `eq.${sex}`, age_months: `eq.${ageMonths}` });
    if (!rows[0]) return missingRef("Weight-for-age");
    return classifyWeightForAge(rows[0], parsed.weightKg);
  });

  // 3. weight-for-length/height
  if (!(hasWeight && hasLength)) skip("weight_for_length_height", "needs weight_kg and length_cm or height_cm");
  else if (ageMonths > 60) skip("weight_for_length_height", "WHO weight-for-length/height covers birth to 5 years; see bmi_for_age");
  else run("weight_for_length_height", async () => {
    const parsed = parseWflhQuery(sub(base, [...WEIGHT_PARAMS, ...LENGTH_PARAMS, "measured"]));
    if (parsed.error) return { error: parsed.error };
    const lookup = resolveLookup(ageMonths, parsed.measured, parsed.lengthHeightCm);
    if (lookup.lookupCm < lookup.range.min || lookup.lookupCm > lookup.range.max) {
      return { error: `Length/height ${lookup.lookupCm} cm is outside the WHO table (${lookup.range.min} to ${lookup.range.max} cm) for this age` };
    }
    const rows = await one("who_weight_for_length_height", {
      sex: `eq.${sex}`, measured: `eq.${lookup.table}`, length_height_cm: `eq.${lookup.lookupCm.toFixed(1)}`,
    });
    if (!rows[0]) return missingRef("Weight-for-length/height");
    return { ...(lookup.adjustment ? { position_adjustment: lookup.adjustment } : {}), ...classifyWflh(rows[0], parsed.weightKg) };
  });

  // 4. BMI-for-age (under 5 | 5-19)
  if (!(hasWeight && hasLength)) skip("bmi_for_age", "needs weight_kg and length_cm or height_cm");
  else if (ageMonths <= 60) run("bmi_for_age", async () => {
    const parsed = parseBmiUnder5Query(sub(base, [...WEIGHT_PARAMS, ...LENGTH_PARAMS, "measured"]));
    if (parsed.error) return { error: parsed.error };
    const resolved = resolveBmi(parsed);
    if (!Number.isFinite(resolved.bmi) || resolved.bmi < 5 || resolved.bmi > 40) return { error: "Computed BMI is not plausible (check the units)" };
    const rows = await one("who_bmi_for_age_under_5", { sex: `eq.${sex}`, age_months: `eq.${ageMonths}`, measured: `eq.${resolved.table}` });
    if (!rows[0]) return missingRef("BMI-for-age (under 5)");
    return { ...(resolved.adjustment ? { position_adjustment: resolved.adjustment } : {}), ...classifyBmiUnder5(rows[0], resolved.bmi) };
  });
  else run("bmi_for_age", async () => {
    const w = sp.get("weight_kg") ? Number(sp.get("weight_kg")) : Number(sp.get("weight_g")) / 1000;
    let h = null;
    for (const [n, d] of [["height_cm", 1], ["length_cm", 1], ["height_mm", 10], ["length_mm", 10]]) {
      if (sp.get(n) !== null && sp.get(n) !== "") { h = Number(sp.get(n)) / d; break; }
    }
    // WHO 2007 reference is height (standing); a lying measurement is converted.
    const adjusted = (sp.get("measured") || "").toLowerCase() === "lying";
    const heightCm = adjusted ? h - LYING_STANDING_DIFF_CM : h;
    const p = new URLSearchParams({ sex, age_months: String(ageMonths), weight_kg: String(w), height_cm: String(heightCm) });
    const parsed = parseBmiForAgeQuery(p);
    if (parsed.error) return { error: parsed.error };
    const rows = await one("bmi_for_age", { sex: `eq.${sex}`, age_months: `eq.${ageMonths}` });
    if (!rows[0]) return missingRef("BMI-for-age (5-19)");
    return {
      ...(adjusted ? { position_adjustment: { measured: "lying", reference_table: "standing", adjustment_cm: -LYING_STANDING_DIFF_CM, note: "Measured lying but the WHO 2007 reference is standing height, so -0.7 cm was applied before computing BMI." } } : {}),
      reference: "BMI-for-age 5-19 years (WHO 2007, Malawi MoH Eat Well to Live Well Annex 2)",
      ...classifyBmiForAge(rows[0], parsed.bmi),
    };
  });

  // 5. head circumference-for-age
  if (!hasHc) skip("hc_for_age", "needs hc_cm");
  else if (ageMonths > 60) skip("hc_for_age", "WHO head circumference-for-age covers birth to 5 years");
  else run("hc_for_age", async () => {
    const parsed = parseHcForAgeQuery(sub(base, HC_PARAMS));
    if (parsed.error) return { error: parsed.error };
    const rows = await one("who_hc_for_age", { sex: `eq.${sex}`, age_months: `eq.${ageMonths}` });
    if (!rows[0]) return missingRef("Head circumference-for-age");
    return classifyHcForAge(rows[0], parsed.hcCm);
  });

  // 6. MUAC-for-age (z-score) and 7. MUAC fixed cut-offs
  if (!hasMuac) { skip("muac_for_age", "needs muac_cm"); skip("muac_fixed", "needs muac_cm"); }
  else {
    if (ageMonths < 3 || ageMonths > 60) skip("muac_for_age", "WHO arm circumference-for-age covers 3 to 60 months");
    else run("muac_for_age", async () => {
      const parsed = parseMuacForAgeQuery(sub(base, MUAC_PARAMS));
      if (parsed.error) return { error: parsed.error };
      const rows = await one("who_muac_for_age", { sex: `eq.${sex}`, age_months: `eq.${ageMonths}` });
      if (!rows[0]) return missingRef("MUAC-for-age");
      return classifyMuacForAge(rows[0], parsed.muacCm);
    });
    if (ageMonths < 6) skip("muac_fixed", "fixed MUAC cut-offs start at 6 months");
    else if (query.muacScheme === "cmam" && ageMonths > 59) skip("muac_fixed", "muac_scheme=cmam covers 6 to 59 months");
    else run("muac_fixed", async () => {
      const p = sub(base, MUAC_PARAMS);
      p.set("scheme", query.muacScheme);
      const parsed = parseMuacFixedQuery(p);
      if (parsed.error) return { error: parsed.error };
      return classifyMuacFixed(parsed.ageMonths, parsed.muacCm, parsed.scheme);
    });
  }

  await Promise.all(jobs);

  // Order the response the same way regardless of which lookup finished first.
  const order = ["length_height_for_age", "weight_for_age", "weight_for_length_height", "bmi_for_age", "hc_for_age", "muac_for_age", "muac_fixed"];
  const ordered = {};
  for (const k of order) if (indicators[k]) ordered[k] = indicators[k];

  // Attention list: everything outside the normal range, most serious first.
  const rank = { severe: 0, concern: 1, watch: 2 };
  const attention = Object.entries(ordered)
    .filter(([, r]) => !r.error && r.status)
    .map(([indicator, r]) => ({ indicator, status: r.status, severity: severityOf(r.status), ...(r.z_score !== undefined ? { z_score: r.z_score } : {}) }))
    .filter((a) => a.severity !== "ok")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);

  // Acute malnutrition signals (6-59 months for MUAC, 0-59 for weight-for-length/height).
  let acute = null;
  const reasons = [];
  let level = "none";
  const bump = (l) => { if (l === "severe" || (l === "moderate" && level === "none")) level = l; };
  const wflh = ordered.weight_for_length_height;
  if (wflh && !wflh.error && wflh.z_score !== null && wflh.z_score !== undefined) {
    if (wflh.status === "severe wasting") { reasons.push(`weight-for-length/height z ${wflh.z_score} (below -3)`); bump("severe"); }
    else if (wflh.status === "moderate wasting") { reasons.push(`weight-for-length/height z ${wflh.z_score} (-3 to -2)`); bump("moderate"); }
  }
  let muacUsed = false;
  if (hasMuac && ageMonths >= 6 && ageMonths <= 59) {
    const p = sub(base, MUAC_PARAMS); p.set("scheme", "cmam");
    const m = parseMuacFixedQuery(p);
    if (!m.error) {
      muacUsed = true;
      const c = classifyMuacFixed(ageMonths, m.muacCm, "cmam");
      if (c.status === "severe") { reasons.push(`MUAC ${c.muac_cm} cm (below 11.5 cm)`); bump("severe"); }
      else if (c.status === "moderate") { reasons.push(`MUAC ${c.muac_cm} cm (11.5 to below 12.5 cm)`); bump("moderate"); }
    }
  }
  if (wflh && !wflh.error || muacUsed) {
    acute = {
      level,
      reasons,
      oedema_assessed: false,
      note: "Signals only, using weight-for-length/height z-score (WHO) and MUAC 115/125 mm (WHO/UNICEF community cut-offs). Severe acute malnutrition is also diagnosed by bilateral pitting oedema, which this endpoint cannot assess; check for it, and follow your national CMAM guideline.",
    };
  }

  return { indicators: ordered, not_assessed: notAssessed, attention, acute_malnutrition_signals: acute };
}
