// Nutrition Research & Surveillance Engine.
//
//   POST /surveillance/records     (any API key)  send anonymised screening records (one, or {records:[...]} up to 100)
//   GET  /surveillance/reference   (any API key)  districts, population groups, indicators, accepted fields, method notes
//   GET  /surveillance/summary     (admin key)    how much data, where from, national prevalence per indicator
//   GET  /surveillance/hotspots    (admin key)    districts with significantly higher burden than the national figure
//   GET  /surveillance/trends      (admin key)    monthly series, trend test, change vs the same month last year
//   GET  /surveillance/alerts      (admin key)    early warning: districts where the recent months are higher than the baseline
//   GET  /surveillance/insights    (admin key)    the above combined into prioritised, actionable findings
//
// Privacy by design: only coarse, non-identifying fields are accepted (an unknown field is rejected, so a name or phone
// number can never be stored by accident). Raw measurements are classified and then discarded; only the outcome is kept.
// Reads return aggregates only, and any cell with fewer than SURVEILLANCE_MIN_CELL records (default 10) is suppressed.
//
// IMPORTANT: this is programme (screening) data, not a random survey. Figures describe the people who were screened.
// Use them to prioritise and to ask better questions, and confirm with a representative survey (SMART, DHS, MICS)
// before large resource decisions. Every analysis response carries that caveat.
//
// Needs sql/037_add_surveillance.sql and SURVEILLANCE_STORE=true (for ingestion). Reads work without the flag.

import { parseAssessQuery, assessGrowth } from "./growthAssess.js";
import { normalizeSex } from "./hcVelocity.js";

/* ───────────────────────── reference data ───────────────────────── */

export const REGIONS = {
  Northern: ["Chitipa", "Karonga", "Likoma", "Mzimba", "Nkhata Bay", "Rumphi"],
  Central: ["Dedza", "Dowa", "Kasungu", "Lilongwe", "Mchinji", "Nkhotakota", "Ntcheu", "Ntchisi", "Salima"],
  Southern: ["Balaka", "Blantyre", "Chikwawa", "Chiradzulu", "Machinga", "Mangochi", "Mulanje", "Mwanza", "Neno", "Nsanje", "Phalombe", "Thyolo", "Zomba"],
};
export const DISTRICTS = Object.entries(REGIONS).flatMap(([region, list]) => list.map((district) => ({ district, region })));
const DISTRICT_INDEX = new Map(DISTRICTS.map((d) => [d.district.toLowerCase(), d]));
// The four city councils sit inside a district; records from them roll up to that district.
const CITY_TO_DISTRICT = { "mzuzu": "Mzimba", "lilongwe": "Lilongwe", "blantyre": "Blantyre", "zomba": "Zomba" };

export function normalizeDistrict(raw) {
  let s = String(raw ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  const isCity = /\bcity$/.test(s);
  s = s.replace(/\s+(district|city|council|dho)$/, "").trim();
  if (isCity && CITY_TO_DISTRICT[s]) return DISTRICT_INDEX.get(CITY_TO_DISTRICT[s].toLowerCase());
  if (s === "nkhatabay") s = "nkhata bay";
  if (s === "mzuzu") return DISTRICT_INDEX.get("mzimba");
  return DISTRICT_INDEX.get(s) || null;
}

export const GROUPS = ["under5", "school_age", "adolescent", "adult", "pregnant_lactating"];
export const GROUP_INFO = {
  under5: { label: "Children under 5 years", age: "age_months 0-59", bands: ["0-5m", "6-23m", "24-59m"] },
  school_age: { label: "School-age children 5-9 years", age: "age_months 60-119", bands: ["5-9y"] },
  adolescent: { label: "Adolescents 10-19 years", age: "age_months 120-227", bands: ["10-19y"] },
  adult: { label: "Adults 19 years and older", age: "age_years 19-120", bands: ["19-49y", "50-64y", "65+y"] },
  pregnant_lactating: { label: "Pregnant and breastfeeding women", age: "age_years 10-54", bands: ["10-19y", "20-34y", "35+y"] },
};
export const SETTINGS = ["facility", "community", "school", "outreach", "survey", "other"];

const YES_NO = ["no", "yes"];
const risk = (label, groups) => ({ label, groups, statuses: YES_NO, case: ["yes"], severe: [], kind: "risk" });

// statuses: every value a record may carry. case: counts toward the burden. severe: the worst subset.
export const INDICATORS = {
  stunting: { label: "Stunting (length/height-for-age below -2 SD, WHO)", groups: ["under5", "school_age", "adolescent"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition", who: "stunting", computed: true },
  wasting: { label: "Wasting (weight-for-length/height below -2 SD, WHO)", groups: ["under5"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition", who: "wasting", computed: true },
  underweight: { label: "Underweight (weight-for-age below -2 SD, WHO)", groups: ["under5", "school_age"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition", computed: true },
  muac_gam: { label: "Low MUAC, 6-59 months (CMAM cut-offs: below 115 mm severe, below 125 mm moderate)", groups: ["under5"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition", computed: true },
  acute_malnutrition: { label: "Acute malnutrition (worst of wasting, low MUAC and bilateral oedema)", groups: ["under5"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition", derived: true },
  overweight: { label: "Overweight (weight-for-height above +2 SD under 5; BMI-for-age above +1 SD from 5 years, WHO)", groups: ["under5", "school_age", "adolescent"], statuses: ["normal", "overweight", "obese"], case: ["overweight", "obese"], severe: ["obese"], kind: "overweight", who: "overweight", computed: true },
  thinness: { label: "Thinness (BMI-for-age below -2 SD, WHO 5-19 years)", groups: ["school_age", "adolescent"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition", computed: true },
  adult_underweight: { label: "Adult underweight (BMI below 18.5, WHO)", groups: ["adult"], statuses: ["normal", "mild", "moderate", "severe"], case: ["mild", "moderate", "severe"], severe: ["severe"], kind: "undernutrition", computed: true },
  adult_overweight: { label: "Adult overweight and obesity (BMI 25 and above, WHO)", groups: ["adult"], statuses: ["normal", "overweight", "obese"], case: ["overweight", "obese"], severe: ["obese"], kind: "overweight", computed: true },
  maternal_muac_low: { label: "Low MUAC in pregnant or breastfeeding women (cut-off set by the submitting programme's national guideline)", groups: ["pregnant_lactating"], statuses: ["normal", "moderate", "severe"], case: ["moderate", "severe"], severe: ["severe"], kind: "undernutrition" },
  anaemia_suspected: risk("Anaemia suspected or confirmed (clinical sign or haemoglobin test, as defined by the submitting programme)", GROUPS),
  low_dietary_diversity: risk("Low dietary diversity (below the programme's minimum diversity score)", GROUPS),
  food_insecure_household: risk("Food-insecure household (programme's screening question or scale)", GROUPS),
  recent_diarrhoea: risk("Diarrhoea in the last 2 weeks", ["under5"]),
  bilateral_oedema: risk("Bilateral pitting oedema (clinical sign of severe acute malnutrition)", ["under5"]),
  not_exclusively_breastfed: risk("Not exclusively breastfed (infants under 6 months)", ["under5"]),
};
export const INDICATOR_NAMES = Object.keys(INDICATORS);

// WHO/UNICEF joint-estimates prevalence thresholds for public health significance (children under 5, %).
const WHO_CUTS = {
  stunting: [[2.5, "very low"], [10, "low"], [20, "medium"], [30, "high"], [Infinity, "very high"]],
  wasting: [[2.5, "very low"], [5, "low"], [10, "medium"], [15, "high"], [Infinity, "very high"]],
  overweight: [[2.5, "very low"], [5, "low"], [10, "medium"], [15, "high"], [Infinity, "very high"]],
};
export function whoBand(indicator, group, prevalencePct) {
  const key = INDICATORS[indicator]?.who;
  if (!key || group !== "under5" || prevalencePct == null) return null;
  return WHO_CUTS[key].find(([upper]) => prevalencePct < upper)[1];
}

export const DATA_CAVEAT =
  "Programme screening data, not a random survey: figures describe the people who were screened and are not district-wide prevalence. " +
  "Use them to prioritise areas and questions, and confirm with a representative survey (SMART, DHS, MICS) before large resource decisions. " +
  "WHO prevalence bands are written for population surveys, so here they are indicative only.";

const ACCEPTED_FIELDS = ["submission_id", "consent_confirmed", "observed_on", "district", "population_group", "sex", "age_months", "age_years", "setting", "source", "measurements", "outcomes"];
const MEASUREMENT_FIELDS = ["weight_kg", "length_cm", "height_cm", "muac_cm", "measured"];
export const BATCH_MAX = 100;
const MAX_MONTHS_BACK = 36;
const DEFAULT_MIN_CELL = 10;
const MIN_ALLOWED_CELL = 5;

export function minCell(env) {
  const n = parseInt(env?.SURVEILLANCE_MIN_CELL ?? "", 10);
  return Number.isFinite(n) ? Math.max(MIN_ALLOWED_CELL, n) : DEFAULT_MIN_CELL;
}

/* ───────────────────────── dates ───────────────────────── */

const pad = (n) => String(n).padStart(2, "0");
export const monthStart = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
export function addMonths(monthStr, k) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return monthStart(d);
}
export const monthDiff = (a, b) => {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
export function monthsBetween(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Parses YYYY-MM or YYYY-MM-DD to the first of that month, or null. */
export function parseMonth(raw) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  if (m[3] !== undefined) {
    const d = new Date(Date.UTC(y, mo - 1, +m[3]));
    if (d.getUTCMonth() !== mo - 1) return null;
  }
  return `${y}-${pad(mo)}-01`;
}

/** Reads ?from=&to=&months=. Default: the last 12 months ending this month. */
export function resolveWindow(sp, now = new Date(), defaultMonths = 12) {
  const thisMonth = monthStart(now);
  let to = thisMonth;
  if (sp.get("to")) {
    to = parseMonth(sp.get("to"));
    if (!to) return { error: "'to' must be a month like 2026-09 (or a date)" };
  }
  let from;
  if (sp.get("from")) {
    from = parseMonth(sp.get("from"));
    if (!from) return { error: "'from' must be a month like 2026-01 (or a date)" };
  } else {
    const n = sp.get("months") === null ? defaultMonths : parseInt(sp.get("months"), 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHS_BACK) return { error: `'months' must be a whole number from 1 to ${MAX_MONTHS_BACK}` };
    from = addMonths(to, -(n - 1));
  }
  if (from > to) return { error: "'from' must not be after 'to'" };
  if (monthDiff(from, to) + 1 > MAX_MONTHS_BACK) return { error: `The window can cover at most ${MAX_MONTHS_BACK} months` };
  return { from, to };
}

/* ───────────────────────── statistics ───────────────────────── */

export const round1 = (x) => Math.round(x * 10) / 10;
export const round2 = (x) => Math.round(x * 100) / 100;
export const round4 = (x) => Math.round(x * 10000) / 10000;

function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** 95% Wilson score interval for k of n, as proportions. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

function logGamma(x) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** One-sided p-value that k of n is higher than chance at rate p0: exact binomial upper tail P(X >= k). */
export function binomialUpperTail(k, n, p0) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p0 <= 0) return 0;
  if (p0 >= 1) return 1;
  const mean = n * p0;
  if (k <= mean) {
    // Not above expectation, so never significant; a normal approximation is plenty here.
    const sd = Math.sqrt(n * p0 * (1 - p0));
    return 1 - normalCdf((k - 0.5 - mean) / sd);
  }
  const lp = Math.log(p0), lq = Math.log(1 - p0);
  let term = Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * lp + (n - k) * lq);
  let sum = term;
  const ratio = p0 / (1 - p0);
  for (let i = k; i < n; i++) {
    term *= ((n - i) / (i + 1)) * ratio;
    sum += term;
    if (term < 1e-17 * sum) break;
  }
  return Math.min(1, sum);
}

/** One-sided z-test that recent (k1/n1) is higher than baseline (k2/n2). Returns { z, p }. */
export function twoProportionZ(k1, n1, k2, n2) {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (k1 / n1 - k2 / n2) / se;
  return { z, p: 1 - normalCdf(z) };
}

/** Benjamini-Hochberg adjusted p-values (q-values), same order as the input. */
export function benjaminiHochberg(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(m);
  let prev = 1;
  for (let r = m - 1; r >= 0; r--) {
    prev = Math.min(prev, (order[r][0] * m) / (r + 1));
    q[order[r][1]] = Math.min(1, prev);
  }
  return q;
}

/** Cochran-Armitage test for a trend in proportions across ordered points. points: [{ x, k, n }]. */
export function trendTest(points) {
  const N = points.reduce((a, p) => a + p.n, 0);
  const R = points.reduce((a, p) => a + p.k, 0);
  if (points.length < 2 || !N || R === 0 || R === N) return { z: 0, p: 1 };
  const pbar = R / N;
  const sx = points.reduce((a, p) => a + p.n * p.x, 0);
  const sxx = points.reduce((a, p) => a + p.n * p.x * p.x, 0);
  const T = points.reduce((a, p) => a + p.x * (p.k - p.n * pbar), 0);
  const v = pbar * (1 - pbar) * (sxx - (sx * sx) / N);
  if (v <= 0) return { z: 0, p: 1 };
  const z = T / Math.sqrt(v);
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Weighted least-squares slope of prevalence (percentage points) per step. points: [{ x, pct, n }]. */
export function weightedSlope(points) {
  const W = points.reduce((a, p) => a + p.n, 0);
  if (points.length < 2 || !W) return 0;
  const mx = points.reduce((a, p) => a + p.n * p.x, 0) / W;
  const my = points.reduce((a, p) => a + p.n * p.pct, 0) / W;
  const sxy = points.reduce((a, p) => a + p.n * (p.x - mx) * (p.pct - my), 0);
  const sxx = points.reduce((a, p) => a + p.n * (p.x - mx) ** 2, 0);
  return sxx ? sxy / sxx : 0;
}

/* ───────────────────────── input validation ───────────────────────── */

const SUBMISSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SOURCE_LABEL = /^[a-z0-9_-]{1,40}$/;

export function ageBandFor(group, ageMonths, ageYears) {
  switch (group) {
    case "under5": return ageMonths < 6 ? "0-5m" : ageMonths < 24 ? "6-23m" : "24-59m";
    case "school_age": return "5-9y";
    case "adolescent": return "10-19y";
    case "adult": return ageYears < 50 ? "19-49y" : ageYears < 65 ? "50-64y" : "65+y";
    case "pregnant_lactating": return ageYears < 20 ? "10-19y" : ageYears < 35 ? "20-34y" : "35+y";
    default: return null;
  }
}

function groupFromAge(ageMonths, ageYears) {
  if (ageMonths !== null) {
    if (ageMonths < 60) return "under5";
    if (ageMonths < 120) return "school_age";
    if (ageMonths < 228) return "adolescent";
    return "adult";
  }
  return ageYears >= 19 ? "adult" : null;
}

const wholeNumber = (v) => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^\d+$/.test(v.trim()));

/**
 * Checks one submitted record. Pure. Returns { ok: true, rec, work } or { ok: false, error }.
 * rec is the row without indicators; work carries what is still needed to classify (measurements, outcomes).
 */
export function validateRecord(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Each record must be a JSON object" };
  const unknown = Object.keys(raw).filter((k) => !ACCEPTED_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, error: `Unknown field(s): ${unknown.slice(0, 5).join(", ")}. Only anonymous fields are accepted (${ACCEPTED_FIELDS.join(", ")}); never send names, phone numbers, addresses or ids.` };
  }
  if (!SUBMISSION_ID.test(String(raw.submission_id ?? ""))) {
    return { ok: false, error: "'submission_id' is required: a random token of 8-64 letters, digits, - or _ made by your app (not an id from a patient record)" };
  }
  if (raw.consent_confirmed !== true) {
    return { ok: false, error: "'consent_confirmed' must be true: your programme confirms it has the consent or legal and ethical basis to share this anonymised record for surveillance" };
  }

  const place = normalizeDistrict(raw.district);
  if (!place) return { ok: false, error: "'district' is required and must be one of Malawi's 28 districts (a city council name rolls up to its district); see GET /surveillance/reference" };

  // observed_on: only the month is kept.
  let observedMonth;
  if (raw.observed_on === undefined || raw.observed_on === null || raw.observed_on === "") observedMonth = monthStart(now);
  else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.observed_on)) || !parseMonth(raw.observed_on)) return { ok: false, error: "'observed_on' must be a date like 2026-10-14 (only the month is stored)" };
    observedMonth = parseMonth(raw.observed_on);
    const thisMonth = monthStart(now);
    if (observedMonth > thisMonth) return { ok: false, error: "'observed_on' cannot be in the future" };
    if (monthDiff(observedMonth, thisMonth) > MAX_MONTHS_BACK) return { ok: false, error: `'observed_on' cannot be more than ${MAX_MONTHS_BACK} months ago` };
  }

  // sex
  let sexStored = "unknown";
  let sexGrowth = null;
  if (raw.sex !== undefined && raw.sex !== null && raw.sex !== "") {
    sexGrowth = normalizeSex(raw.sex);
    if (!sexGrowth) return { ok: false, error: "'sex' must be female or male (girls/boys also accepted); leave it out if unknown" };
    sexStored = sexGrowth === "girls" ? "female" : "male";
  }

  // age
  const hasM = raw.age_months !== undefined && raw.age_months !== null && raw.age_months !== "";
  const hasY = raw.age_years !== undefined && raw.age_years !== null && raw.age_years !== "";
  if (hasM && !wholeNumber(raw.age_months)) return { ok: false, error: "'age_months' must be a whole number of completed months" };
  if (hasY && !wholeNumber(raw.age_years)) return { ok: false, error: "'age_years' must be a whole number of completed years" };
  let ageMonths = hasM ? Number(raw.age_months) : null;
  let ageYears = hasY ? Number(raw.age_years) : null;
  if (ageMonths === null && ageYears === null) return { ok: false, error: "Give 'age_months' (children) or 'age_years' (adults and women)" };
  if (ageMonths !== null && ageMonths > 1560) return { ok: false, error: "'age_months' is not plausible" };
  if (ageYears !== null && ageYears > 120) return { ok: false, error: "'age_years' must be 0 to 120" };
  if (ageMonths === null) ageMonths = ageYears * 12;
  if (ageYears === null) ageYears = Math.floor(ageMonths / 12);

  // population group
  let group = raw.population_group;
  if (group !== undefined && group !== null && group !== "") {
    if (!GROUPS.includes(group)) return { ok: false, error: `'population_group' must be one of: ${GROUPS.join(", ")}` };
  } else {
    group = groupFromAge(hasM ? ageMonths : null, hasY ? ageYears : null);
    if (!group) return { ok: false, error: "Could not work out the population group from the age; send 'population_group'" };
  }
  if (group === "under5" && ageMonths > 59) return { ok: false, error: "under5 means 'age_months' 0 to 59" };
  if (group === "school_age" && (ageMonths < 60 || ageMonths > 119)) return { ok: false, error: "school_age means 'age_months' 60 to 119" };
  if (group === "adolescent" && (ageMonths < 120 || ageMonths > 227)) return { ok: false, error: "adolescent means 'age_months' 120 to 227" };
  if (group === "adult" && ageYears < 19) return { ok: false, error: "adult means 'age_years' 19 or more" };
  if (group === "pregnant_lactating" && (ageYears < 10 || ageYears > 54)) return { ok: false, error: "pregnant_lactating means 'age_years' 10 to 54" };

  // setting and source
  let setting = null;
  if (raw.setting !== undefined && raw.setting !== null && raw.setting !== "") {
    if (!SETTINGS.includes(raw.setting)) return { ok: false, error: `'setting' must be one of: ${SETTINGS.join(", ")}` };
    setting = raw.setting;
  }
  let source = null;
  if (raw.source !== undefined && raw.source !== null && raw.source !== "") {
    if (!SOURCE_LABEL.test(String(raw.source))) return { ok: false, error: "'source' is an app label of up to 40 lowercase letters, digits, - or _ (for example oasis)" };
    source = String(raw.source);
  }

  // measurements and outcomes (shape only; classification happens later)
  let measurements = null;
  if (raw.measurements !== undefined && raw.measurements !== null) {
    const m = raw.measurements;
    if (typeof m !== "object" || Array.isArray(m)) return { ok: false, error: "'measurements' must be an object" };
    const bad = Object.keys(m).filter((k) => !MEASUREMENT_FIELDS.includes(k));
    if (bad.length) return { ok: false, error: `Unknown measurement(s): ${bad.slice(0, 5).join(", ")}. Accepted: ${MEASUREMENT_FIELDS.join(", ")}` };
    measurements = m;
  }
  let outcomes = {};
  if (raw.outcomes !== undefined && raw.outcomes !== null) {
    if (typeof raw.outcomes !== "object" || Array.isArray(raw.outcomes)) return { ok: false, error: "'outcomes' must be an object like {\"stunting\":\"severe\",\"anaemia_suspected\":true}" };
    for (const [name, value] of Object.entries(raw.outcomes)) {
      const def = INDICATORS[name];
      if (!def) return { ok: false, error: `Unknown indicator '${String(name).slice(0, 40)}'; see GET /surveillance/reference` };
      if (!def.groups.includes(group)) return { ok: false, error: `Indicator '${name}' does not apply to ${group}` };
      let v = value;
      if (def.kind === "risk") v = value === true ? "yes" : value === false ? "no" : value;
      if (!def.statuses.includes(v)) return { ok: false, error: `Indicator '${name}' must be one of: ${def.statuses.join(", ")}` };
      outcomes[name] = v;
    }
  }
  if (!measurements && !Object.keys(outcomes).length) return { ok: false, error: "Send 'measurements' to be classified and/or 'outcomes' you have already classified" };

  return {
    ok: true,
    rec: {
      submission_id: raw.submission_id,
      observed_month: observedMonth,
      district: place.district,
      region: place.region,
      population_group: group,
      sex: sexStored,
      age_band: ageBandFor(group, ageMonths, ageYears),
      setting,
      source,
    },
    work: { measurements, outcomes, group, ageMonths, ageYears, sexGrowth, hadAgeMonths: hasM },
  };
}

/* ───────────────────────── classification ───────────────────────── */

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

const stuntedStatus = (s) => (s === "severely stunted" ? "severe" : s === "stunted" ? "moderate" : "normal");
const underweightStatus = (s) => (s === "severely underweight" ? "severe" : s === "underweight" ? "moderate" : "normal");
const wastingStatus = (s) => (s === "severe wasting" ? "severe" : s === "moderate wasting" ? "moderate" : "normal");
const thinnessStatus = (s) => (s === "severe thinness" || s === "severe wasting" ? "severe" : s === "thinness" || s === "moderate wasting" ? "moderate" : "normal");
const overweightStatus = (s) => (s === "obesity" ? "obese" : s === "overweight" ? "overweight" : "normal");

const SEVERITY = { normal: 0, mild: 1, moderate: 2, severe: 3 };
const worst = (...vals) => vals.filter(Boolean).sort((a, b) => SEVERITY[b] - SEVERITY[a])[0] || null;

export function adultIndicatorsFromBmi(bmi) {
  const under = bmi < 16 ? "severe" : bmi < 17 ? "moderate" : bmi < 18.5 ? "mild" : "normal";
  const over = bmi >= 30 ? "obese" : bmi >= 25 ? "overweight" : "normal";
  return { adult_underweight: under, adult_overweight: over };
}

/**
 * Turns measurements into indicator statuses using the WHO tables (same maths as /growth/assess), then merges in
 * any pre-classified outcomes (the server's own classification wins where both exist). Raw values are not kept.
 * fetchRows(table, filters, limit) is the same helper /growth/assess uses.
 * Returns { ok: true, indicators, warnings } or { ok: false, error }.
 */
export async function buildIndicators(work, fetchRows) {
  const { measurements, group, ageMonths } = work;
  const computed = {};
  const warnings = [];

  if (measurements) {
    const w = num(measurements.weight_kg), h = num(measurements.height_cm ?? measurements.length_cm), muac = num(measurements.muac_cm);
    for (const [k, v] of [["weight_kg", w], ["height_cm", h], ["muac_cm", muac]]) {
      if (v !== null && (!Number.isFinite(v) || v <= 0)) return { ok: false, error: `'measurements.${k}' must be a positive number` };
    }
    if (measurements.measured !== undefined && !["lying", "standing"].includes(measurements.measured)) return { ok: false, error: "'measurements.measured' must be lying or standing" };

    if (group === "adult") {
      if (w === null || h === null) return { ok: false, error: "Adults need measurements.weight_kg and measurements.height_cm for BMI" };
      const bmi = w / (h / 100) ** 2;
      if (!Number.isFinite(bmi) || bmi < 10 || bmi > 80) return { ok: false, error: "Computed BMI is not plausible (check the units)" };
      Object.assign(computed, adultIndicatorsFromBmi(bmi));
    } else if (group === "pregnant_lactating") {
      return { ok: false, error: "For pregnant or breastfeeding women send the programme's classification in 'outcomes' (maternal_muac_low); measurements are not classified for this group" };
    } else {
      if (!work.hadAgeMonths) return { ok: false, error: "'age_months' is required to classify children's measurements" };
      if (!work.sexGrowth) return { ok: false, error: "'sex' is required to classify children's measurements" };
      const sp = new URLSearchParams({ sex: work.sexGrowth, age_months: String(ageMonths) });
      if (w !== null) sp.set("weight_kg", String(w));
      if (h !== null) sp.set("height_cm", String(h));
      if (muac !== null && group === "under5") sp.set("muac_cm", String(muac));
      if (measurements.measured) sp.set("measured", measurements.measured);
      const parsed = parseAssessQuery(sp);
      if (parsed.error) return { ok: false, error: parsed.error };
      let result;
      try {
        result = await assessGrowth(parsed, fetchRows);
      } catch (e) {
        return { ok: false, error: `Could not classify the measurements: ${e?.message || "lookup failed"}` };
      }
      const ind = result.indicators || {};
      const use = (key, fn) => {
        const r = ind[key];
        if (!r) return null;
        if (r.error) { warnings.push(`${key}: ${r.error}`); return null; }
        return r.status ? fn(r.status) : null;
      };
      const g = INDICATORS;
      if (g.stunting.groups.includes(group)) { const v = use("length_height_for_age", stuntedStatus); if (v) computed.stunting = v; }
      if (g.underweight.groups.includes(group)) { const v = use("weight_for_age", underweightStatus); if (v) computed.underweight = v; }
      if (group === "under5") {
        const wv = use("weight_for_length_height", wastingStatus); if (wv) computed.wasting = wv;
        const ov = use("weight_for_length_height", overweightStatus); if (ov) computed.overweight = ov;
        const mv = use("muac_fixed", (s) => (s === "severe" ? "severe" : s === "moderate" ? "moderate" : "normal"));
        if (mv) computed.muac_gam = mv;
      } else {
        const tv = use("bmi_for_age", thinnessStatus); if (tv) computed.thinness = tv;
        const ov = use("bmi_for_age", overweightStatus); if (ov) computed.overweight = ov;
      }
    }
  }

  const indicators = { ...work.outcomes, ...computed };

  // Acute malnutrition (under 5): the worst of wasting, low MUAC and bilateral oedema.
  if (group === "under5") {
    const oedema = indicators.bilateral_oedema === "yes" ? "severe" : null;
    const acute = worst(indicators.wasting, indicators.muac_gam, oedema);
    if (acute) indicators.acute_malnutrition = acute;
  }

  if (!Object.keys(indicators).length) {
    return { ok: false, error: `No indicator could be classified${warnings.length ? ` (${warnings.join("; ")})` : ""}` };
  }
  return { ok: true, indicators, warnings };
}

/* ───────────────────────── ingestion ───────────────────────── */

/**
 * Validates, classifies and stores a batch. Returns a summary; individual bad records are reported by index
 * (never echoing their contents) and do not stop the others.
 */
export async function ingestRecords(rawRecords, { db, fetchRows, now = new Date() }) {
  const rows = [];
  const rejected = [];
  const warnings = [];
  const seen = new Set();
  let batchDuplicates = 0;
  for (let i = 0; i < rawRecords.length; i++) {
    const v = validateRecord(rawRecords[i], now);
    if (!v.ok) { rejected.push({ index: i, error: v.error }); continue; }
    if (seen.has(v.rec.submission_id)) { batchDuplicates++; continue; }
    seen.add(v.rec.submission_id);
    const built = await buildIndicators(v.work, fetchRows);
    if (!built.ok) { rejected.push({ index: i, error: built.error }); continue; }
    if (built.warnings.length) warnings.push({ index: i, warnings: built.warnings });
    rows.push({ ...v.rec, indicators: built.indicators });
  }
  let inserted = 0;
  if (rows.length) {
    const res = await db.rpc("surveillance_ingest", { p_records: rows });
    if (!res.ok) {
      const missing = res.status === 404 || /surveillance_ingest|PGRST202/.test(JSON.stringify(res.body || ""));
      return { ok: false, status: missing ? 503 : 502, error: missing ? "Surveillance storage is not set up. Run sql/037_add_surveillance.sql in Supabase." : "Could not store the records" };
    }
    inserted = Number(res.body) || 0;
  }
  return {
    ok: true,
    received: rawRecords.length,
    stored: inserted,
    already_received: rows.length - inserted + batchDuplicates,
    rejected,
    ...(warnings.length ? { classification_warnings: warnings } : {}),
  };
}

/* ───────────────────────── data access ───────────────────────── */

export function makeStore(db) {
  return {
    async counts({ from, to, group = null, indicator = null, district = null, byDistrict = false, byMonth = false }) {
      const res = await db.rpc("surveillance_counts", {
        p_from: from, p_to: to, p_group: group, p_indicator: indicator, p_district: district, p_by_district: byDistrict, p_by_month: byMonth,
      });
      if (!res.ok || !Array.isArray(res.body)) return { ok: false, status: res.status, body: res.body };
      return { ok: true, rows: res.body };
    },
    async volume({ from, to, group = null }) {
      const res = await db.rpc("surveillance_volume", { p_from: from, p_to: to, p_group: group });
      if (!res.ok || !Array.isArray(res.body)) return { ok: false, status: res.status, body: res.body };
      return { ok: true, rows: res.body };
    },
  };
}

/* ───────────────────────── analysis ───────────────────────── */

function tally(counts, def) {
  let n = 0, cases = 0, severe = 0;
  for (const [status, c] of Object.entries(counts || {})) {
    const k = Number(c) || 0;
    n += k;
    if (def.case.includes(status)) cases += k;
    if (def.severe.includes(status)) severe += k;
  }
  return { n, cases, severe, hasSevere: def.severe.length > 0 };
}

function figures(t) {
  const ci = wilson(t.cases, t.n);
  return {
    n: t.n, cases: t.cases,
    prevalence_pct: t.n ? round1((t.cases / t.n) * 100) : null,
    ci95_pct: ci ? [round1(ci.low * 100), round1(ci.high * 100)] : null,
    ...(t.hasSevere ? { severe_cases: t.severe } : {}),
  };
}

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, info: 3 };

export const HOTSPOT_Q = 0.1;
export const DEFAULT_MIN_N = 30;

/**
 * Compares each district with the national figure for one (group, indicator).
 * rows: counts rows for that group+indicator, by district. Returns the analysis object.
 */
export function analyseHotspots(rows, group, indicator, { minN = DEFAULT_MIN_N, cell = DEFAULT_MIN_CELL } = {}) {
  const def = INDICATORS[indicator];
  const national = { n: 0, cases: 0, severe: 0, hasSevere: def.severe.length > 0 };
  const per = [];
  for (const r of rows) {
    if (r.population_group !== group || r.indicator !== indicator || !r.district) continue;
    const t = tally(r.counts, def);
    national.n += t.n; national.cases += t.cases; national.severe += t.severe;
    per.push({ district: r.district, region: r.region, ...t });
  }
  const p0 = national.n ? national.cases / national.n : 0;
  const testable = per.filter((d) => d.n >= Math.max(minN, cell));
  const pvals = testable.map((d) => (p0 > 0 ? binomialUpperTail(d.cases, d.n, p0) : 1));
  const lows = testable.map((d) => (p0 < 1 ? binomialUpperTail(d.n - d.cases, d.n, 1 - p0) : 1)); // low side: P(non-cases high)
  const q = benjaminiHochberg(pvals);
  const qLow = benjaminiHochberg(lows);
  const qByDistrict = new Map(testable.map((d, i) => [d.district, { p: pvals[i], q: q[i], qLow: qLow[i] }]));

  const districts = per.map((d) => {
    if (d.n < cell) return { district: d.district, region: d.region, classification: "suppressed", note: `fewer than ${cell} records, hidden to protect privacy` };
    const f = figures(d);
    const base = { district: d.district, region: d.region, ...f };
    const band = whoBand(indicator, group, f.prevalence_pct);
    if (band) base.who_band = band;
    if (d.n < minN) return { ...base, classification: "insufficient_data", note: `fewer than ${minN} records for a reliable comparison` };
    const st = qByDistrict.get(d.district);
    const ratio = p0 > 0 ? (d.cases / d.n) / p0 : null;
    if (ratio !== null) base.ratio_to_national = round2(ratio);
    base.p_value = round4(st.p);
    base.q_value = round4(st.q);
    const above = d.cases / d.n > p0;
    if (st.q <= HOTSPOT_Q && above) {
      const veryHigh = band === "very high";
      const high = band === "high" || (ratio !== null && ratio >= 1.5);
      return { ...base, classification: "hotspot", priority: veryHigh ? "critical" : high ? "high" : "medium" };
    }
    if (st.qLow <= HOTSPOT_Q && !above) return { ...base, classification: "below_national" };
    if (above && ratio !== null && ratio >= 1.2) return { ...base, classification: "watch" };
    return { ...base, classification: "typical" };
  });

  const order = { hotspot: 0, watch: 1, typical: 2, below_national: 3, insufficient_data: 4, suppressed: 5 };
  districts.sort((a, b) => (order[a.classification] - order[b.classification]) || ((b.prevalence_pct ?? -1) - (a.prevalence_pct ?? -1)));
  return {
    population_group: group,
    indicator,
    label: def.label,
    national: { ...figures(national), ...(whoBand(indicator, group, national.n ? round1(p0 * 100) : null) ? { who_band: whoBand(indicator, group, round1(p0 * 100)) } : {}) },
    districts_reporting: per.length,
    districts_compared: testable.length,
    hotspots: districts.filter((d) => d.classification === "hotspot"),
    districts,
  };
}

/** Monthly series for one (group, indicator) with a trend test. rows: counts by month (optionally one district). */
export function analyseTrend(rows, group, indicator, from, to, { cell = DEFAULT_MIN_CELL } = {}) {
  const def = INDICATORS[indicator];
  const byMonth = new Map();
  for (const r of rows) {
    if (r.population_group !== group || r.indicator !== indicator || !r.month) continue;
    byMonth.set(String(r.month).slice(0, 7) + "-01", tally(r.counts, def));
  }
  const months = monthsBetween(from, to);
  const series = months.map((m, i) => {
    const t = byMonth.get(m) || { n: 0, cases: 0, severe: 0 };
    if (t.n === 0) return { month: m.slice(0, 7), n: 0, _x: i, _t: null };
    if (t.n < cell) return { month: m.slice(0, 7), suppressed: true, _x: i, _t: null };
    return { month: m.slice(0, 7), ...figures(t), _x: i, _t: t };
  });
  const usable = series.filter((s) => s._t);
  const points = usable.map((s) => ({ x: s._x, k: s._t.cases, n: s._t.n, pct: (s._t.cases / s._t.n) * 100 }));
  const totalN = points.reduce((a, p) => a + p.n, 0);

  let trend;
  if (points.length < 4 || totalN < 100) {
    trend = { direction: "insufficient_data", note: "Needs at least 4 months with 10+ records each and 100+ records in total" };
  } else {
    const t = trendTest(points);
    const slope = weightedSlope(points);
    const direction = t.p < 0.05 && Math.abs(slope) >= 0.1 ? (slope > 0 ? "increasing" : "decreasing") : "stable";
    trend = { direction, slope_pp_per_month: round2(slope), z: round2(t.z), p_value: round4(t.p), months_used: points.length };
  }

  // Compare the latest usable month with the same month a year earlier.
  let yearOnYear = null;
  const last = usable[usable.length - 1];
  if (last) {
    const lastMonth = last.month + "-01";
    const prior = byMonth.get(addMonths(lastMonth, -12));
    if (prior && prior.n >= cell) {
      const a = last._t, b = prior;
      const pa = (a.cases / a.n) * 100, pb = (b.cases / b.n) * 100;
      const test = twoProportionZ(a.cases, a.n, b.cases, b.n);
      yearOnYear = { month: last.month, prevalence_pct: round1(pa), same_month_last_year_pct: round1(pb), change_pp: round1(pa - pb), significant_increase: test.p < 0.05, significant_decrease: 1 - test.p < 0.05 };
    }
  }
  const clean = series.map(({ _x, _t, ...rest }) => rest);
  return { population_group: group, indicator, label: def.label, window: { from: from.slice(0, 7), to: to.slice(0, 7) }, series: clean, trend, ...(yearOnYear ? { vs_same_month_last_year: yearOnYear } : {}) };
}

export const DEFAULT_RECENT = 3;
export const DEFAULT_BASELINE = 9;
export const DEFAULT_MIN_INCREASE_PP = 2;

/** Recent window vs baseline window per district. recentRows and baseRows are counts by district for one group. */
export function analyseAlerts(recentRows, baseRows, group, { minIncreasePp = DEFAULT_MIN_INCREASE_PP, cell = DEFAULT_MIN_CELL } = {}) {
  const key = (r) => `${r.indicator}|${r.district || ""}`;
  const base = new Map(baseRows.filter((r) => r.population_group === group).map((r) => [key(r), r]));
  const tests = [];
  for (const r of recentRows) {
    if (r.population_group !== group) continue;
    const def = INDICATORS[r.indicator];
    if (!def) continue;
    const b = base.get(key(r));
    if (!b) continue;
    const a = tally(r.counts, def), c = tally(b.counts, def);
    if (a.n < Math.max(20, cell) || c.n < 30 || a.cases < 5) continue;
    const t = twoProportionZ(a.cases, a.n, c.cases, c.n);
    tests.push({ indicator: r.indicator, district: r.district || null, region: r.region || null, recent: a, baseline: c, p: t.p, z: t.z });
  }
  const q = benjaminiHochberg(tests.map((t) => t.p));
  const alerts = [];
  tests.forEach((t, i) => {
    const pa = (t.recent.cases / t.recent.n) * 100, pb = (t.baseline.cases / t.baseline.n) * 100;
    const inc = pa - pb;
    if (q[i] <= HOTSPOT_Q && inc >= minIncreasePp) {
      alerts.push({
        population_group: group, indicator: t.indicator, label: INDICATORS[t.indicator].label, district: t.district, region: t.region,
        recent: figures(t.recent), baseline: figures(t.baseline),
        increase_pp: round1(inc), p_value: round4(t.p), q_value: round4(q[i]),
        priority: inc >= 5 ? "high" : "medium",
      });
    }
  });
  alerts.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (b.increase_pp - a.increase_pp));
  return { tested: tests.length, alerts };
}

/* ───────────────────────── insights ───────────────────────── */

const ACTIONS = {
  stunting: [
    "Review coverage of growth monitoring and promotion, and trace children who miss visits.",
    "Check infant and young child feeding counselling reach: exclusive breastfeeding to 6 months, then adequate complementary foods.",
    "Look at household food security, dietary diversity, water, sanitation and hygiene in the affected catchments.",
  ],
  wasting: [
    "Check that CMAM sites (OTP and supplementary feeding) cover the area and that RUTF and RUSF are in stock.",
    "Step up community MUAC screening and referral so cases are found early.",
    "Look for recent shocks: food prices, floods or dry spells, disease outbreaks.",
  ],
  acute_malnutrition: [
    "Check that CMAM sites (OTP and supplementary feeding) cover the area and that RUTF and RUSF are in stock.",
    "Step up community MUAC screening and referral so cases are found early.",
    "Look for recent shocks: food prices, floods or dry spells, disease outbreaks.",
  ],
  muac_gam: [
    "Step up community MUAC screening and referral, and check CMAM site coverage and supply.",
    "Confirm borderline and low MUAC readings with weight-for-height and an oedema check at the health facility.",
  ],
  underweight: [
    "Review growth monitoring coverage and follow-up of children whose weight is falling off the curve.",
    "Look at feeding practices and household food security alongside infection burden.",
  ],
  overweight: [
    "Reinforce counselling on healthy diets and physical activity, and review sugary-drink and snack availability in the catchment.",
    "Check that growth monitoring is also catching rapid weight gain, not only low weight.",
  ],
  thinness: [
    "Review school feeding, deworming and school-based screening in the affected areas.",
    "Refer thin adolescents for clinical assessment, and check household food security.",
  ],
  adult_underweight: [
    "Refer for clinical assessment (infection and chronic illness can be the cause) and link to food support where needed.",
    "Check household food security and seasonal access to food.",
  ],
  adult_overweight: [
    "Strengthen counselling on diet and activity and link to blood pressure and diabetes screening.",
  ],
  maternal_muac_low: [
    "Review antenatal and postnatal nutrition counselling and supplementary feeding for at-risk women.",
    "Check iron-folic acid supply and uptake, and household food security.",
  ],
  anaemia_suspected: [
    "Confirm with haemoglobin testing where possible, and check iron-folic acid supply and uptake.",
    "Review malaria control, deworming and the iron content of local diets.",
  ],
  low_dietary_diversity: [
    "Review food-based counselling and nutrition-sensitive agriculture (diverse crops, small livestock, home gardens).",
    "Check seasonal market access and prices for nutrient-rich foods.",
  ],
  food_insecure_household: [
    "Link affected households to social protection or food assistance, and plan for the lean season.",
    "Share the finding with the district food security and nutrition coordination group.",
  ],
  recent_diarrhoea: [
    "Review water, sanitation and hygiene conditions, and stocks of ORS and zinc.",
  ],
  bilateral_oedema: [
    "Treat as an emergency sign: confirm that children with oedema are referred for inpatient care for severe acute malnutrition.",
  ],
  not_exclusively_breastfed: [
    "Strengthen breastfeeding counselling at antenatal, postnatal and immunisation contacts.",
  ],
};

const RESEARCH = {
  hotspot: [
    "Compare with the latest representative survey (DHS, MICS, SMART or IPC) for this district: does it agree?",
    "Is the finding the same across settings (facility, community, school) and age bands, or driven by one source?",
  ],
  rising: [
    "Does the rise line up with the lean season (typically November to March), a price shock, a disease outbreak or a change in who is being screened?",
    "Did screening coverage or the reporting sites change in the recent months?",
  ],
  trend: [
    "Is the trend present in every region, or concentrated in a few districts?",
    "Check whether the case mix (age band, setting) changed over the same period.",
  ],
};

const confidenceFor = (n) => (n >= 200 ? "good" : n >= 60 ? "moderate" : "low");
const where = (district) => (district ? `${district} district` : "Malawi (all reporting districts)");

function hotspotInsight(group, h, d) {
  const ratio = d.ratio_to_national ? ` (${d.ratio_to_national}x the national figure)` : "";
  const band = d.who_band ? ` This is in the WHO "${d.who_band}" range for the indicator (indicative only).` : "";
  return {
    id: `hotspot:${group}:${h.indicator}:${d.district}`,
    type: "hotspot",
    priority: d.priority,
    population_group: group,
    indicator: h.indicator,
    district: d.district,
    region: d.region,
    title: `${d.district}: higher ${shortName(h.indicator)} among ${GROUP_INFO[group].label.toLowerCase()}`,
    detail: `${d.cases} of ${d.n} screened (${d.prevalence_pct}%) against ${h.national.prevalence_pct}% nationally${ratio}; statistically above the national figure (q ${d.q_value}).${band}`,
    evidence: { n: d.n, cases: d.cases, prevalence_pct: d.prevalence_pct, ci95_pct: d.ci95_pct, national_pct: h.national.prevalence_pct, ratio_to_national: d.ratio_to_national, q_value: d.q_value },
    confidence: confidenceFor(d.n),
    suggested_actions: ACTIONS[h.indicator] || [],
    research_questions: RESEARCH.hotspot,
  };
}

function alertInsight(a) {
  return {
    id: `rising:${a.population_group}:${a.indicator}:${a.district || "national"}`,
    type: "rising",
    priority: a.priority,
    population_group: a.population_group,
    indicator: a.indicator,
    district: a.district,
    region: a.region,
    title: `${where(a.district)}: ${shortName(a.indicator)} rising among ${GROUP_INFO[a.population_group].label.toLowerCase()}`,
    detail: `Recent months ${a.recent.prevalence_pct}% (${a.recent.cases} of ${a.recent.n}) against ${a.baseline.prevalence_pct}% in the baseline period: up ${a.increase_pp} percentage points (q ${a.q_value}).`,
    evidence: { recent: a.recent, baseline: a.baseline, increase_pp: a.increase_pp, q_value: a.q_value },
    confidence: confidenceFor(a.recent.n),
    suggested_actions: ACTIONS[a.indicator] || [],
    research_questions: RESEARCH.rising,
  };
}

function trendInsight(t) {
  const tr = t.trend;
  const dir = tr.direction === "increasing" ? "rising" : "falling";
  const n = t.series.reduce((a, s) => a + (s.n || 0), 0);
  return {
    id: `trend:${t.population_group}:${t.indicator}:national`,
    type: "trend",
    priority: tr.direction === "increasing" ? "medium" : "info",
    population_group: t.population_group,
    indicator: t.indicator,
    district: null,
    title: `${shortName(t.indicator)} is steadily ${dir} among ${GROUP_INFO[t.population_group].label.toLowerCase()}`,
    detail: `${tr.slope_pp_per_month > 0 ? "+" : ""}${tr.slope_pp_per_month} percentage points per month across ${tr.months_used} months (p ${tr.p_value}).${t.vs_same_month_last_year ? ` Latest month ${t.vs_same_month_last_year.prevalence_pct}% against ${t.vs_same_month_last_year.same_month_last_year_pct}% a year earlier.` : ""}`,
    evidence: { slope_pp_per_month: tr.slope_pp_per_month, p_value: tr.p_value, months_used: tr.months_used, ...(t.vs_same_month_last_year ? { vs_same_month_last_year: t.vs_same_month_last_year } : {}) },
    confidence: confidenceFor(n),
    suggested_actions: tr.direction === "increasing" ? ACTIONS[t.indicator] || [] : [],
    research_questions: RESEARCH.trend,
  };
}

const SHORT = {
  stunting: "stunting", wasting: "wasting", underweight: "underweight", muac_gam: "low MUAC", acute_malnutrition: "acute malnutrition",
  overweight: "overweight", thinness: "thinness", adult_underweight: "underweight", adult_overweight: "overweight and obesity",
  maternal_muac_low: "low MUAC", anaemia_suspected: "suspected anaemia", low_dietary_diversity: "low dietary diversity",
  food_insecure_household: "household food insecurity", recent_diarrhoea: "recent diarrhoea", bilateral_oedema: "oedema",
  not_exclusively_breastfed: "non-exclusive breastfeeding",
};
const shortName = (indicator) => SHORT[indicator] || indicator;

/** Coverage and data-quality picture from the volume rows. */
export function dataQuality(volumeRows, from, to, { cell = DEFAULT_MIN_CELL } = {}) {
  const monthsInWindow = monthDiff(from, to) + 1;
  const byDistrict = new Map();
  const byGroup = {};
  const bySetting = {};
  let total = 0;
  for (const r of volumeRows) {
    const n = Number(r.n) || 0;
    total += n;
    byGroup[r.population_group] = (byGroup[r.population_group] || 0) + n;
    bySetting[r.setting] = (bySetting[r.setting] || 0) + n;
    const d = byDistrict.get(r.district) || { n: 0, months: 0 };
    d.n += n;
    d.months = Math.max(d.months, Number(r.months_reporting) || 0);
    byDistrict.set(r.district, d);
  }
  const reporting = DISTRICTS.filter((d) => (byDistrict.get(d.district)?.n || 0) >= cell);
  const without = DISTRICTS.filter((d) => (byDistrict.get(d.district)?.n || 0) < cell).map((d) => d.district);
  const sparse = [...byDistrict.entries()].filter(([, v]) => v.n >= cell && v.months < Math.ceil(monthsInWindow / 2)).map(([k]) => k);
  const facilityShare = total ? (bySetting.facility || 0) / total : null;
  const notes = [];
  if (without.length) notes.push(`${without.length} of 28 districts have fewer than ${cell} records in this window and are not analysed.`);
  if (sparse.length) notes.push(`${sparse.length} district(s) reported in fewer than half of the months, so trends there are weak.`);
  if (facilityShare !== null && facilityShare >= 0.9) notes.push("Over 90% of records come from health facilities, so findings reflect people who attend facilities and may miss community burden.");
  if (total === 0) notes.push("No records in this window.");
  return {
    records: total,
    by_population_group: byGroup,
    by_setting: bySetting,
    districts_reporting: reporting.length,
    districts_total: DISTRICTS.length,
    districts_without_enough_data: without,
    districts_reporting_in_under_half_of_months: sparse,
    months_in_window: monthsInWindow,
    notes,
  };
}

function gapInsights(quality, minCellValue) {
  const out = [];
  if (quality.districts_without_enough_data.length && quality.records > 0) {
    out.push({
      id: "coverage:districts",
      type: "data_gap",
      priority: quality.districts_without_enough_data.length >= 10 ? "medium" : "info",
      title: `${quality.districts_without_enough_data.length} district(s) have too little data to analyse`,
      detail: `${quality.districts_without_enough_data.join(", ")} have fewer than ${minCellValue} records in this window. A district with no data is not a district with no problem.`,
      evidence: { districts: quality.districts_without_enough_data },
      suggested_actions: ["Encourage or enable screening data submission from these districts, starting with sites that already screen.", "Where submissions exist but are small, check that the app is sending records and that district names are valid."],
      research_questions: [],
    });
  }
  const facility = quality.notes.find((n) => n.startsWith("Over 90%"));
  if (facility) {
    out.push({ id: "coverage:setting", type: "data_gap", priority: "info", title: "Data come almost entirely from health facilities", detail: facility, evidence: { by_setting: quality.by_setting }, suggested_actions: ["Add community, outreach or school screening to the data flow to reduce facility bias."], research_questions: [] });
  }
  return out;
}

/** Combines the analyses for the requested groups into one prioritised list. */
export async function buildInsights(store, { groups, from, to, minN, cell, recentMonths = DEFAULT_RECENT, baselineMonths = DEFAULT_BASELINE, minIncreasePp = DEFAULT_MIN_INCREASE_PP, maxInsights = 25 }) {
  const insights = [];
  const flagged = new Map(); // `${group}|${indicator}` -> true
  const sections = [];
  const recentFrom = addMonths(to, -(recentMonths - 1));
  const recentTo = to;
  const baseTo = addMonths(recentFrom, -1);
  const baseFrom = addMonths(baseTo, -(baselineMonths - 1));

  const vol = await store.volume({ from, to });
  if (!vol.ok) return { ok: false, status: vol.status, body: vol.body };
  const quality = dataQuality(vol.rows, from, to, { cell });

  await Promise.all(groups.map(async (group) => {
    const [win, recent, base] = await Promise.all([
      store.counts({ from, to, group, byDistrict: true }),
      store.counts({ from: recentFrom, to: recentTo, group, byDistrict: true }),
      store.counts({ from: baseFrom, to: baseTo, group, byDistrict: true }),
    ]);
    if (!win.ok) throw Object.assign(new Error("counts failed"), { res: win });
    const indicators = INDICATOR_NAMES.filter((i) => INDICATORS[i].groups.includes(group));
    const hot = indicators.map((i) => analyseHotspots(win.rows, group, i, { minN, cell })).filter((h) => h.national.n > 0);
    for (const h of hot) {
      for (const d of h.hotspots) { insights.push(hotspotInsight(group, h, d)); flagged.set(`${group}|${h.indicator}`, true); }
    }
    if (recent.ok && base.ok) {
      const al = analyseAlerts(recent.rows, base.rows, group, { minIncreasePp, cell });
      for (const a of al.alerts) { insights.push(alertInsight(a)); flagged.set(`${group}|${a.indicator}`, true); }
      sections.push({ population_group: group, alert_tests: al.tested });
    }
  }));

  // National trends for indicators that were flagged (bounded so the request stays small).
  const toTrend = [...flagged.keys()].slice(0, 6);
  await Promise.all(toTrend.map(async (k) => {
    const [group, indicator] = k.split("|");
    const t = await store.counts({ from, to, group, indicator, byMonth: true });
    if (!t.ok) return;
    const a = analyseTrend(t.rows, group, indicator, from, to, { cell });
    if (a.trend.direction === "increasing" || a.trend.direction === "decreasing") insights.push(trendInsight(a));
  }));

  insights.push(...gapInsights(quality, cell));
  insights.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || ((b.evidence?.ratio_to_national || b.evidence?.increase_pp || 0) - (a.evidence?.ratio_to_national || a.evidence?.increase_pp || 0)));
  const counts = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const i of insights) counts[i.priority]++;
  return {
    ok: true,
    data: {
      window: { from: from.slice(0, 7), to: to.slice(0, 7) },
      comparison_windows: { recent: `${recentFrom.slice(0, 7)} to ${recentTo.slice(0, 7)}`, baseline: `${baseFrom.slice(0, 7)} to ${baseTo.slice(0, 7)}` },
      population_groups: groups,
      summary: { insights: insights.length, ...counts, shown: Math.min(insights.length, maxInsights) },
      insights: insights.slice(0, maxInsights),
      data_quality: quality,
      method: METHOD_NOTES,
      data_caveat: DATA_CAVEAT,
    },
  };
}

export const METHOD_NOTES = [
  "Prevalence is cases / screened with a 95% Wilson interval. Cases are children below -2 SD (WHO), adults with BMI outside the normal range, or a yes answer for risk indicators.",
  "Hotspot: a district is flagged when its rate is above the national rate by an exact binomial test, after Benjamini-Hochberg correction across districts (q <= 0.10). Priority rises with the ratio to the national rate and the WHO band.",
  "Early warning: the recent months are compared with the baseline months in the same district (one-sided two-proportion test, q <= 0.10) and must rise by at least the minimum number of percentage points.",
  "Trend: Cochran-Armitage test across monthly proportions, with a weighted slope in percentage points per month. A change is reported only with 4+ usable months.",
  "Privacy: districts or months with fewer than the minimum cell size are hidden. Districts are compared with a national figure that includes them.",
];

/* ───────────────────────── reference ───────────────────────── */

export function referenceData(env) {
  return {
    purpose: "Anonymised nutrition screening records in, hotspots, trends, early warnings and insights out.",
    privacy: {
      accepted_fields: ACCEPTED_FIELDS,
      measurement_fields: MEASUREMENT_FIELDS,
      never_stored: ["names", "phone numbers", "addresses", "facility names", "patient or device ids", "exact dates", "exact ages", "raw measurements"],
      stored: "calendar month, district and region, population group, sex, age band, setting, app label, and classified outcomes",
      minimum_cell_size: minCell(env),
      reads: "aggregates only; the three analysis calls need an admin key",
    },
    send: {
      endpoint: "POST /surveillance/records",
      limits: `one record, or {"records":[...]} up to ${BATCH_MAX}`,
      example: {
        submission_id: "k3j9x2m8q1w7",
        consent_confirmed: true,
        observed_on: "2026-10-14",
        district: "Zomba",
        sex: "female",
        age_months: 18,
        setting: "community",
        source: "oasis",
        measurements: { weight_kg: 8.1, length_cm: 76.5, muac_cm: 11.9 },
        outcomes: { recent_diarrhoea: true, low_dietary_diversity: true },
      },
      notes: [
        "Raw measurements are classified with the WHO tables (the same maths as /growth/assess) and then discarded.",
        "Send 'outcomes' for anything you classify yourself. If both are sent, the server's classification wins for the same indicator.",
        "Risk indicators accept true/false or yes/no. A false is as useful as a true: it is the denominator.",
        "Re-sending the same submission_id is safe; it is counted once.",
      ],
    },
    regions: REGIONS,
    districts: DISTRICTS,
    city_councils: "Mzuzu City, Lilongwe City, Blantyre City and Zomba City roll up to Mzimba, Lilongwe, Blantyre and Zomba.",
    population_groups: GROUP_INFO,
    settings: SETTINGS,
    indicators: Object.fromEntries(INDICATOR_NAMES.map((k) => [k, {
      label: INDICATORS[k].label, population_groups: INDICATORS[k].groups, statuses: INDICATORS[k].statuses,
      counts_as_case: INDICATORS[k].case, severe: INDICATORS[k].severe, kind: INDICATORS[k].kind,
      classified_by_server_from_measurements: Boolean(INDICATORS[k].computed), derived: Boolean(INDICATORS[k].derived),
    }])),
    who_prevalence_bands_pct: {
      note: "WHO/UNICEF thresholds for public health significance, children under 5 only. Indicative here because the data are not a random survey.",
      stunting: "very low below 2.5, low 2.5 to below 10, medium 10 to below 20, high 20 to below 30, very high 30 and above",
      wasting: "very low below 2.5, low 2.5 to below 5, medium 5 to below 10, high 10 to below 15, very high 15 and above",
      overweight: "very low below 2.5, low 2.5 to below 5, medium 5 to below 10, high 10 to below 15, very high 15 and above",
    },
    method: METHOD_NOTES,
    data_caveat: DATA_CAVEAT,
  };
}

/* ───────────────────────── HTTP handler ───────────────────────── */

const GET_ROUTES = ["summary", "hotspots", "trends", "alerts", "insights"];

function unavailable(success, note) {
  return success({ available: false, note }, { message: "Surveillance data not available" });
}

function storageMissing(res) {
  return res.status === 404 || /surveillance_|PGRST202|does not exist/.test(JSON.stringify(res.body || ""));
}

function groupsFor(sp, indicator) {
  const g = sp.get("population_group");
  if (g) return GROUPS.includes(g) ? { groups: [g] } : { error: `'population_group' must be one of: ${GROUPS.join(", ")}` };
  if (indicator) return { groups: INDICATORS[indicator].groups };
  return { groups: GROUPS };
}

function parseIndicator(sp, { required = false } = {}) {
  const raw = sp.get("indicator");
  if (!raw) return required ? { error: `'indicator' is required: one of ${INDICATOR_NAMES.join(", ")}` } : { indicator: null };
  if (!INDICATORS[raw]) return { error: `Unknown indicator '${raw.slice(0, 40)}'. One of: ${INDICATOR_NAMES.join(", ")}` };
  return { indicator: raw };
}

/**
 * Routes /surveillance/*. helpers: { success, err, notFound, parseBody }.
 * fetchRows is the same table reader /growth/assess uses (needed to classify children's measurements).
 */
export async function handleSurveillance(request, url, db, env, param, helpers, fetchRows, now = new Date()) {
  const { success, err, notFound, parseBody, json } = helpers;
  const method = request.method;
  const cell = minCell(env);

  if (param === "reference") {
    if (method !== "GET") return err("Method not allowed", 405);
    return success(referenceData(env), { message: "Surveillance engine reference" });
  }

  if (param === "records") {
    if (method !== "POST") return err("Method not allowed. Send records with POST /surveillance/records", 405);
    if (env?.SURVEILLANCE_STORE !== "true") return err("Surveillance storage is switched off (set SURVEILLANCE_STORE=true after running sql/037_add_surveillance.sql)", 503);
    if (!db) return err("Database not configured", 503);
    const body = await parseBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return err("Invalid JSON body");
    let list;
    if (Array.isArray(body.records)) {
      if (Object.keys(body).some((k) => k !== "records")) return err("When sending 'records', send nothing else at the top level");
      list = body.records;
      if (!list.length) return err("'records' is empty");
      if (list.length > BATCH_MAX) return err(`Send at most ${BATCH_MAX} records per request`);
    } else {
      list = [body];
    }
    const out = await ingestRecords(list, { db, fetchRows, now });
    if (!out.ok) return err(out.error, out.status);
    const { ok, ...data } = out;
    const status = data.stored === 0 && data.rejected.length === list.length ? 422 : 200;
    if (status === 422) return json({ status: "error", message: "No record was accepted", data }, 422);
    return success(data, { message: `Stored ${data.stored} record(s)` });
  }

  if (!GET_ROUTES.includes(param)) return notFound("Surveillance route (use /surveillance/records, reference, summary, hotspots, trends, alerts or insights)");
  if (method !== "GET") return err("Method not allowed", 405);
  if (!db) return err("Database not configured", 503);
  const store = makeStore(db);
  const sp = url.searchParams;
  const win = resolveWindow(sp, now);
  if (win.error) return err(win.error);
  const { from, to } = win;
  const windowOut = { from: from.slice(0, 7), to: to.slice(0, 7) };
  const note = "Surveillance data is not readable. Run sql/037_add_surveillance.sql in Supabase.";

  const minN = (() => { const n = parseInt(sp.get("min_n") || "", 10); return Number.isFinite(n) ? Math.max(cell, Math.min(n, 1000)) : DEFAULT_MIN_N; })();

  try {
    if (param === "summary") {
      const [vol, cnt] = await Promise.all([store.volume({ from, to }), store.counts({ from, to })]);
      if (!vol.ok || !cnt.ok) return storageMissing(vol.ok ? cnt : vol) ? unavailable(success, note) : err("Could not read surveillance data", 502);
      const quality = dataQuality(vol.rows, from, to, { cell });
      const national = cnt.rows.map((r) => {
        const def = INDICATORS[r.indicator];
        if (!def) return null;
        const t = tally(r.counts, def);
        if (t.n < cell) return null;
        const f = figures(t);
        const band = whoBand(r.indicator, r.population_group, f.prevalence_pct);
        return { population_group: r.population_group, indicator: r.indicator, label: def.label, ...f, ...(band ? { who_band: band } : {}) };
      }).filter(Boolean).sort((a, b) => a.population_group.localeCompare(b.population_group) || a.indicator.localeCompare(b.indicator));
      const byRegion = {};
      for (const r of vol.rows) byRegion[r.region] = (byRegion[r.region] || 0) + (Number(r.n) || 0);
      return success({ available: true, window: windowOut, data_quality: quality, records_by_region: byRegion, national, data_caveat: DATA_CAVEAT }, { message: "Surveillance summary" });
    }

    if (param === "hotspots") {
      const ind = parseIndicator(sp);
      if (ind.error) return err(ind.error);
      const g = groupsFor(sp, ind.indicator);
      if (g.error) return err(g.error);
      const results = [];
      for (const group of g.groups) {
        const res = await store.counts({ from, to, group, indicator: ind.indicator, byDistrict: true });
        if (!res.ok) return storageMissing(res) ? unavailable(success, note) : err("Could not read surveillance data", 502);
        const names = ind.indicator ? [ind.indicator] : INDICATOR_NAMES.filter((i) => INDICATORS[i].groups.includes(group));
        for (const name of names) {
          if (!INDICATORS[name].groups.includes(group)) continue;
          const a = analyseHotspots(res.rows, group, name, { minN, cell });
          if (!a.national.n) continue;
          results.push(ind.indicator ? a : { ...a, districts: undefined, districts_listed: "pass ?indicator= to list every district" });
        }
      }
      return success({ available: true, window: windowOut, minimum_records_to_compare: minN, results, data_caveat: DATA_CAVEAT }, { message: "Hotspot analysis" });
    }

    if (param === "trends") {
      const ind = parseIndicator(sp, { required: true });
      if (ind.error) return err(ind.error);
      const g = groupsFor(sp, ind.indicator);
      if (g.error) return err(g.error);
      let district = null;
      if (sp.get("district")) {
        const place = normalizeDistrict(sp.get("district"));
        if (!place) return err("'district' must be one of Malawi's 28 districts; see GET /surveillance/reference");
        district = place.district;
      }
      const results = [];
      for (const group of g.groups) {
        const res = await store.counts({ from, to, group, indicator: ind.indicator, district, byMonth: true });
        if (!res.ok) return storageMissing(res) ? unavailable(success, note) : err("Could not read surveillance data", 502);
        const a = analyseTrend(res.rows, group, ind.indicator, from, to, { cell });
        results.push({ ...a, district: district || "all districts" });
      }
      return success({ available: true, results, data_caveat: DATA_CAVEAT }, { message: "Trend analysis" });
    }

    if (param === "alerts") {
      const g = groupsFor(sp, null);
      if (g.error) return err(g.error);
      const r = parseInt(sp.get("recent_months") || "", 10);
      const b = parseInt(sp.get("baseline_months") || "", 10);
      const recentMonths = Number.isFinite(r) ? Math.min(Math.max(r, 1), 6) : DEFAULT_RECENT;
      const baselineMonths = Number.isFinite(b) ? Math.min(Math.max(b, 3), 24) : DEFAULT_BASELINE;
      const inc = Number(sp.get("min_increase_pp"));
      const minIncreasePp = sp.get("min_increase_pp") !== null && Number.isFinite(inc) ? Math.min(Math.max(inc, 0.5), 50) : DEFAULT_MIN_INCREASE_PP;
      const recentFrom = addMonths(to, -(recentMonths - 1));
      const baseTo = addMonths(recentFrom, -1);
      const baseFrom = addMonths(baseTo, -(baselineMonths - 1));
      const alerts = [];
      let tested = 0;
      for (const group of g.groups) {
        const [rc, bc] = await Promise.all([
          store.counts({ from: recentFrom, to, group, byDistrict: true }),
          store.counts({ from: baseFrom, to: baseTo, group, byDistrict: true }),
        ]);
        if (!rc.ok || !bc.ok) return storageMissing(rc.ok ? bc : rc) ? unavailable(success, note) : err("Could not read surveillance data", 502);
        const a = analyseAlerts(rc.rows, bc.rows, group, { minIncreasePp, cell });
        tested += a.tested;
        alerts.push(...a.alerts);
      }
      alerts.sort((x, y) => (PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority]) || (y.increase_pp - x.increase_pp));
      return success({
        available: true,
        recent: `${recentFrom.slice(0, 7)} to ${to.slice(0, 7)}`,
        baseline: `${baseFrom.slice(0, 7)} to ${baseTo.slice(0, 7)}`,
        min_increase_pp: minIncreasePp, comparisons_tested: tested, alerts, data_caveat: DATA_CAVEAT,
        note: "The current month may be incomplete; proportions are compared, not counts.",
      }, { message: "Early-warning alerts" });
    }

    // insights
    const g = groupsFor(sp, null);
    if (g.error) return err(g.error);
    const built = await buildInsights(store, { groups: g.groups, from, to, minN, cell });
    if (!built.ok) return storageMissing(built) ? unavailable(success, note) : err("Could not read surveillance data", 502);
    return success({ available: true, ...built.data }, { message: "Surveillance insights" });
  } catch (e) {
    if (e?.res) return storageMissing(e.res) ? unavailable(success, note) : err("Could not read surveillance data", 502);
    throw e;
  }
}
