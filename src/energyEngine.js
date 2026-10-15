// Energy requirements engine (POST /energy/requirements, GET /energy/factors).
// Pure functions, no I/O. Every number comes from one source: Krause and Mahan's Food and the Nutrition Care Process,
// 16th ed., chapter 2 "Intake: Energy" (Ireton-Jones), which reproduces the IOM 2002/2005 DRI energy equations
// and the Mifflin-St Jeor equations. Nothing here is invented: where the chapter gives a range or an "expert opinion"
// level, the result says so.
//
// What it does
//   1. REE      Mifflin-St Jeor (adults), or a measured REE you supply (indirect calorimetry is preferred by the chapter).
//   2. Stress   REE x each stress factor. Registered factors: "fever" (Hardy and DuBois) and "custom" (clinician-set).
//   3. Activity TEE = stressed REE x (1 + activity fraction). Registered levels: minimal, moderate, strenuous (ranges from
//               the chapter, expert opinion). Or a PAL / activity log feeding the IOM equations.
//   4. IOM      EER / weight-maintenance TEE equations for every group in Box 2.1, with pregnancy and lactation add-ons.
//   5. Pick     One recommended figure, with the reason, next to every other estimate that applies.
//
// Extending it
//   registerActivityFactor({ id, label, min, max, source, evidence })   min/max are fractions of REE (0.1 = +10%)
//   registerStressFactor({ id, label, source, evidence, inputs, compute(params) -> { multiplier, detail } | { error } })
// Both are data plus one small function, so burns, trauma, sepsis, dialysis and so on can be added without touching
// the engine. TEF is already inside the activity multipliers and the IOM equations, so it is never added a second time.
//
// Combining rule (a design choice, not from the chapter): stress factors multiply REE, then activity multiplies the
// stressed REE. Every step is returned so a clinician can redo it by hand.

export const SOURCE = "Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 2 (IOM 2002/2005; Mifflin et al. 1990)";

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));

import { foodEnergyCatalog } from "./foodEnergy.js";

// ─── Reference tables (transcribed from the chapter) ────────────────────────────────

export const PAL_LEVELS = ["sedentary", "low_active", "active", "very_active"];

/** Table 2.3 */
export const PAL_CATEGORIES = [
  { id: "sedentary", label: "Sedentary", min: 1, max: 1.4, walking_miles_per_day: null },
  { id: "low_active", label: "Low active", min: 1.4, max: 1.6, walking_miles_per_day: "1.5, 2.2, 2.9 for PAL 1.5" },
  { id: "active", label: "Active", min: 1.6, max: 1.9, walking_miles_per_day: "3, 4.4, 5.8 for PAL 1.6; 5.3, 7.3, 9.9 for PAL 1.75" },
  { id: "very_active", label: "Very active", min: 1.9, max: 2.5, walking_miles_per_day: "7.5, 10.3, 14 for PAL 1.9; 12.3, 16.7, 22.5 for PAL 2.2; 17, 23, 31 for PAL 2.5" },
];

/** Table 2.4: [id, label, group, METs, deltaPAL per 10 min, deltaPAL per hour] */
const ACTIVITY_ROWS = [
  ["lying_quietly", "Lying quietly", "daily", 1, 0, 0],
  ["riding_in_car", "Riding in a car", "daily", 1, 0, 0],
  ["light_activity_sitting", "Light activity while sitting", "daily", 1.5, 0.005, 0.03],
  ["vacuuming", "Vacuuming", "daily", 3.5, 0.024, 0.14],
  ["household_tasks_moderate", "Doing household tasks (moderate effort)", "daily", 3.5, 0.024, 0.14],
  ["gardening_no_lifting", "Gardening (no lifting)", "daily", 4.4, 0.032, 0.19],
  ["mowing_lawn_power_mower", "Mowing lawn (power mower)", "daily", 4.5, 0.033, 0.2],
  ["walking_2mph", "Walking (2 mph)", "mild", 2.5, 0.014, 0.09],
  ["paddling_leisurely", "Paddling (leisurely)", "mild", 2.5, 0.014, 0.09],
  ["golfing_with_cart", "Golfing (with cart)", "mild", 2.5, 0.014, 0.09],
  ["dancing", "Dancing", "mild", 2.9, 0.018, 0.11],
  ["walking_3mph", "Walking (3 mph)", "moderate", 3.3, 0.022, 0.13],
  ["cycling_leisurely", "Cycling (leisurely)", "moderate", 3.5, 0.024, 0.14],
  ["walking_4mph", "Walking (4 mph)", "moderate", 4.5, 0.033, 0.2],
  ["chopping_wood", "Chopping wood", "vigorous", 4.9, 0.037, 0.22],
  ["tennis_doubles", "Playing tennis (doubles)", "vigorous", 5, 0.038, 0.23],
  ["ice_skating", "Ice skating", "vigorous", 5.5, 0.043, 0.26],
  ["cycling_moderate", "Cycling (moderate)", "vigorous", 5.7, 0.045, 0.27],
  ["skiing", "Skiing (downhill or water)", "vigorous", 6.8, 0.055, 0.33],
  ["swimming", "Swimming", "vigorous", 7, 0.057, 0.34],
  ["climbing_hills_5kg_load", "Climbing hills (5-kg load)", "vigorous", 7.4, 0.061, 0.37],
  ["walking_5mph", "Walking (5 mph)", "vigorous", 8, 0.067, 0.4],
  ["jogging_10_min_mile", "Jogging (10-min mile)", "vigorous", 10.2, 0.088, 0.53],
  ["skipping_rope", "Skipping rope", "vigorous", 12, 0.105, 0.63],
];
export const ACTIVITY_TABLE = ACTIVITY_ROWS.map(([id, label, group, mets, dpal10, dpalHour]) => ({ id, label, group, mets, delta_pal_per_10min: dpal10, delta_pal_per_hour: dpalHour }));
const ACTIVITY_BY_ID = new Map(ACTIVITY_TABLE.map((a) => [a.id, a]));

/** Table 2.2 (active PAL, reference height and weight). Adults: subtract 10 kcal/day (men) or 7 (women) per year above 19. */
export const DRI_REFERENCE_EER = [
  { group: "Infants 0-6 months", male: 570, female: 520, female_age: "3 months" },
  { group: "Infants 7-12 months", male: 743, female: 676, female_age: "9 months" },
  { group: "Children 1-2 years", male: 1046, female: 992, female_age: "24 months" },
  { group: "Children 3-8 years", male: 1742, female: 1642, female_age: "6 years" },
  { group: "Children 9-13 years", male: 2279, female: 2071, female_age: "11 years" },
  { group: "Adolescents 14-18 years", male: 3152, female: 2368, female_age: "16 years" },
  { group: "Adults over 18 years", male: 3067, female: 2403, female_age: "19 years", adjustment: "subtract 10 kcal/day (men) or 7 kcal/day (women) for each year above 19" },
  { group: "Pregnant 14-18 years, trimester 1/2/3", female: [2368, 2708, 2820] },
  { group: "Pregnant 19-50 years, trimester 1/2/3", female: [2403, 2743, 2855] },
  { group: "Lactating 14-18 years, first/second 6 months", female: [2698, 2768] },
  { group: "Lactating 19-50 years, first/second 6 months", female: [2733, 2803] },
];

/** Active-PAL EER for the reference person (Table 2.2). Adults only. */
export function driReferenceAdultEER(sex, ageYears) {
  const base = sex === "male" ? 3067 : 2403;
  const perYear = sex === "male" ? 10 : 7;
  return base - perYear * Math.max(0, ageYears - 19);
}

/** Box 2.1 and Mifflin-St Jeor. a + b*age + PA*(w*kg + h*m) + dep. */
export const IOM_EQUATIONS = [
  { id: "eer_boys_3_8", label: "EER, boys 3-8 y (BMI 5th-85th percentile)", kind: "EER", sex: "male", ageMin: 3, ageMax: 9, weight_status: "normal", a: 88.5, b: -61.9, w: 26.7, h: 903, dep: 20, pa: [1, 1.13, 1.26, 1.42] },
  { id: "eer_boys_9_18", label: "EER, boys 9-18 y (BMI 5th-85th percentile)", kind: "EER", sex: "male", ageMin: 9, ageMax: 19, weight_status: "normal", a: 88.5, b: -61.9, w: 26.7, h: 903, dep: 25, pa: [1, 1.13, 1.26, 1.42] },
  { id: "eer_girls_3_8", label: "EER, girls 3-8 y (BMI 5th-85th percentile)", kind: "EER", sex: "female", ageMin: 3, ageMax: 9, weight_status: "normal", a: 135.3, b: -30.8, w: 10, h: 934, dep: 20, pa: [1, 1.16, 1.31, 1.56] },
  { id: "eer_girls_9_18", label: "EER, girls 9-18 y (BMI 5th-85th percentile)", kind: "EER", sex: "female", ageMin: 9, ageMax: 19, weight_status: "normal", a: 135.3, b: -30.8, w: 10, h: 934, dep: 25, pa: [1, 1.16, 1.31, 1.56] },
  { id: "eer_men_19", label: "EER, men 19 y and older (BMI 18.5-25)", kind: "EER", sex: "male", ageMin: 19, ageMax: 200, bmiMin: 18.5, bmiMax: 25, a: 662, b: -9.53, w: 15.91, h: 539.6, dep: 0, pa: [1, 1.11, 1.25, 1.48] },
  { id: "eer_women_19", label: "EER, women 19 y and older (BMI 18.5-25)", kind: "EER", sex: "female", ageMin: 19, ageMax: 200, bmiMin: 18.5, bmiMax: 25, a: 354, b: -6.91, w: 9.36, h: 726, dep: 0, pa: [1, 1.12, 1.27, 1.45] },
  { id: "tee_boys_overweight_3_18", label: "Weight-maintenance TEE, overweight boys 3-18 y (BMI above 85th percentile)", kind: "TEE", sex: "male", ageMin: 3, ageMax: 19, weight_status: "overweight", a: 114, b: -50.9, w: 19.5, h: 1161.4, dep: 0, pa: [1, 1.12, 1.24, 1.45] },
  { id: "tee_girls_overweight_3_18", label: "Weight-maintenance TEE, overweight girls 3-18 y (BMI above 85th percentile)", kind: "TEE", sex: "female", ageMin: 3, ageMax: 19, weight_status: "overweight", a: 389, b: -41.2, w: 15, h: 701.6, dep: 0, pa: [1, 1.18, 1.35, 1.6] },
  { id: "tee_men_overweight_19", label: "TEE, overweight and obese men 19 y and older (BMI 25 or more)", kind: "TEE", sex: "male", ageMin: 19, ageMax: 200, bmiMin: 25, a: 1086, b: -10.1, w: 13.7, h: 416, dep: 0, pa: [1, 1.12, 1.29, 1.59] },
  { id: "tee_women_overweight_19", label: "TEE, overweight and obese women 19 y and older (BMI 25 or more)", kind: "TEE", sex: "female", ageMin: 19, ageMax: 200, bmiMin: 25, a: 448, b: -7.95, w: 11.4, h: 619, dep: 0, pa: [1, 1.16, 1.27, 1.44] },
  { id: "tee_men_all_19", label: "TEE, normal, overweight or obese men 19 y and older (BMI 18.5 or more)", kind: "TEE", sex: "male", ageMin: 19, ageMax: 200, bmiMin: 18.5, a: 864, b: -9.72, w: 14.2, h: 503, dep: 0, pa: [1, 1.12, 1.27, 1.54] },
  { id: "tee_women_all_19", label: "TEE, normal, overweight or obese women 19 y and older (BMI 18.5 or more)", kind: "TEE", sex: "female", ageMin: 19, ageMax: 200, bmiMin: 18.5, a: 387, b: -7.31, w: 10.9, h: 660.7, dep: 0, pa: [1, 1.14, 1.27, 1.45] },
];

/** Box 2.1, infants and young children 0-2 y: EER = (89 x kg - 100) + energy deposition. No PA coefficient. */
export const INFANT_DEPOSITION = [
  { fromMonths: 0, toMonths: 3, kcal: 175 },
  { fromMonths: 4, toMonths: 6, kcal: 56 },
  { fromMonths: 7, toMonths: 12, kcal: 22 },
  { fromMonths: 13, toMonths: 35, kcal: 20 },
];

/** Pregnancy add-ons to the pre-pregnancy EER (Box 2.1): trimester 2 = 160 + 180, trimester 3 = 272 + 180. */
export const PREGNANCY_ADD_KCAL = { 1: 0, 2: 160 + 180, 3: 272 + 180 };
/** Lactation add-ons: milk energy output minus weight loss. See the note on the adult first-6-months value in the output. */
export const LACTATION_ADD_KCAL = { first_6_months: 500 - 170, second_6_months: 400 };

/** Respiratory quotient reference values from the chapter. */
export const RQ_REFERENCE = [
  { rq: 1, fuel: "carbohydrate" }, { rq: 0.85, fuel: "mixed diet" }, { rq: 0.82, fuel: "protein" },
  { rq: 0.7, fuel: "fat" }, { rq: 0.65, fuel: "ketone production (0.65 or lower)" },
];

/** Table 2.1 summary. */
export const REE_MEASUREMENT_PROTOCOL = {
  preparation: ["Food: fast 7 h, or 4 h if the last intake was under 300 kcal", "Caffeine: none for 4 h", "Nicotine: none for 2.5 h", "Exercise: none for 4 h"],
  rule_of_4s: "No food, caffeine, nicotine or exercise for 4 h before the REE measurement",
  conditions: ["Rest 20-30 min before (healthy adult)", "Gas collection: ventilated hood or canopy, mouthpiece and nose clip, or facemask", "Room temperature 72-77 F", "Quiet and dim light", "Measure for 10 min or per the individual protocol (first 5 min discarded, last 5 min with CV under 10%)"],
};

// ─── Registries (extension points) ──────────────────────────────────────────────────

const activityRegistry = new Map();
const stressRegistry = new Map();
const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;

export function registerActivityFactor(def) {
  if (!def || !ID_RE.test(def.id || "")) throw new Error("activity factor id must be lower_snake_case");
  if (!isNum(def.min) || !isNum(def.max) || def.min < 0 || def.max < def.min || def.max > 2) throw new Error("activity factor min/max must be fractions of REE with 0 <= min <= max <= 2");
  if (!def.source) throw new Error("activity factor needs a source");
  activityRegistry.set(def.id, { evidence: "unspecified", ...def });
}

export function registerStressFactor(def) {
  if (!def || !ID_RE.test(def.id || "")) throw new Error("stress factor id must be lower_snake_case");
  if (typeof def.compute !== "function") throw new Error("stress factor needs compute(params)");
  if (!def.source) throw new Error("stress factor needs a source");
  stressRegistry.set(def.id, { evidence: "unspecified", inputs: [], ...def });
}

for (const [id, label, min, max] of [["minimal", "Minimal activity", 0.1, 0.2], ["moderate", "Moderate activity", 0.25, 0.4], ["strenuous", "Strenuous activity", 0.45, 0.6]]) {
  registerActivityFactor({ id, label, min, max, source: "Krause ch. 2, Determining Total Energy Expenditure", evidence: "expert opinion (the chapter says these are ranges used in practice, not evidence-based)" });
}

registerStressFactor({
  id: "fever",
  label: "Fever",
  source: "Hardy and DuBois 1937, cited in Krause ch. 2 (Temperature)",
  evidence: "classic study",
  inputs: [
    { name: "temperature_c", type: "number", unit: "C", description: "Body temperature. 13% REE increase per degree C above 37." },
    { name: "temperature_f", type: "number", unit: "F", description: "Alternative to temperature_c. 7% REE increase per degree F above 98.6." },
  ],
  compute(p) {
    const c = num(p.temperature_c);
    const f = num(p.temperature_f);
    if (isNum(c) && isNum(f)) return { error: "give temperature_c or temperature_f, not both" };
    if (!isNum(c) && !isNum(f)) return { error: "fever needs temperature_c or temperature_f" };
    if (isNum(c)) {
      if (c < 30 || c > 44) return { error: "temperature_c must be between 30 and 44" };
      const rise = Math.max(0, c - 37);
      return { multiplier: 1 + 0.13 * rise, detail: rise > 0 ? `${round(rise, 2)} C above 37 x 13% per degree` : "no rise above 37 C, no adjustment" };
    }
    if (f < 86 || f > 111) return { error: "temperature_f must be between 86 and 111" };
    const rise = Math.max(0, f - 98.6);
    return { multiplier: 1 + 0.07 * rise, detail: rise > 0 ? `${round(rise, 2)} F above 98.6 x 7% per degree` : "no rise above 98.6 F, no adjustment" };
  },
});

registerStressFactor({
  id: "custom",
  label: "Clinician-set factor",
  source: "Supplied by the caller. Not from the chapter.",
  evidence: "caller-supplied",
  inputs: [
    { name: "multiplier", type: "number", unit: "x REE", description: "Between 0.5 and 3. For example 1.2 for +20%." },
    { name: "label", type: "string", description: "What the factor represents, shown in the result." },
    { name: "source", type: "string", description: "Optional citation for the factor." },
  ],
  compute(p) {
    const m = num(p.multiplier);
    if (!isNum(m) || m < 0.5 || m > 3) return { error: "custom stress factor needs 'multiplier' between 0.5 and 3" };
    return { multiplier: m, detail: `${p.label ? String(p.label).slice(0, 80) + ": " : ""}x${m}${p.source ? ` (source: ${String(p.source).slice(0, 120)})` : ""}` };
  },
});

// ─── Building blocks ───────────────────────────────────────────────────────────────

export function normalizeSexMF(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (["male", "m", "man", "men", "boy", "boys"].includes(s)) return "male";
  if (["female", "f", "woman", "women", "girl", "girls"].includes(s)) return "female";
  return null;
}

/** Mifflin-St Jeor (adults). kcal/day. */
export function mifflinStJeor({ sex, weightKg, heightCm, ageYears }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === "male" ? base + 5 : base - 161;
}

export function palCategoryFor(pal) {
  if (!isNum(pal) || pal < 1 || pal > 2.5) return null;
  if (pal < 1.4) return "sedentary";
  if (pal < 1.6) return "low_active";
  if (pal < 1.9) return "active";
  return "very_active";
}

/** kcal = MET x kg x hours (1 MET = 1 kcal/kg/h). */
export function metEnergyKcal(mets, weightKg, hours) {
  return mets * weightKg * hours;
}

/**
 * PAL for a day from activities, as the chapter does it: 1 (BEE) + 0.1 (TEF) + sum of delta PAL.
 * Each entry: { id } from Table 2.4 with hours or minutes, or { label, delta_pal_per_hour, hours|minutes } for your own.
 */
export function palFromActivities(list, weightKg) {
  if (!Array.isArray(list) || !list.length) return { error: "activities must be a non-empty array" };
  if (list.length > 50) return { error: "at most 50 activities" };
  let delta = 0;
  let totalHours = 0;
  const rows = [];
  for (const [i, a] of list.entries()) {
    if (!a || typeof a !== "object") return { error: `activities[${i}] must be an object` };
    const hours = isNum(num(a.hours)) ? num(a.hours) : isNum(num(a.minutes)) ? num(a.minutes) / 60 : NaN;
    if (!isNum(hours) || hours < 0 || hours > 24) return { error: `activities[${i}] needs hours (or minutes) between 0 and 24` };
    let dph; let mets = null; let label;
    if (a.id !== undefined && a.id !== null && a.id !== "") {
      const row = ACTIVITY_BY_ID.get(String(a.id));
      if (!row) return { error: `activities[${i}]: unknown activity '${String(a.id).slice(0, 40)}'. See GET /energy/factors` };
      dph = row.delta_pal_per_hour; mets = row.mets; label = row.label;
    } else {
      dph = num(a.delta_pal_per_hour);
      if (!isNum(dph) || dph < 0 || dph > 2) return { error: `activities[${i}] needs an id from Table 2.4 or delta_pal_per_hour between 0 and 2` };
      mets = isNum(num(a.mets)) ? num(a.mets) : null;
      label = a.label ? String(a.label).slice(0, 60) : "Custom activity";
    }
    totalHours += hours;
    if (totalHours > 24.001) return { error: "activities add up to more than 24 hours" };
    const d = dph * hours;
    delta += d;
    rows.push({ label, hours: round(hours, 2), delta_pal: round(d, 3), mets, kcal_estimate: mets && isNum(weightKg) ? round(metEnergyKcal(mets, weightKg, hours)) : null });
  }
  const pal = round(1 + 0.1 + delta, 3);
  return { pal, delta_pal_total: round(delta, 3), activities: rows };
}

export function interpretRQ(vco2, vo2) {
  const v1 = num(vco2); const v2 = num(vo2);
  if (!isNum(v1) || !isNum(v2) || v1 <= 0 || v2 <= 0) return { error: "rq needs positive vco2 and vo2" };
  const rq = round(v1 / v2, 3);
  const out = { rq, closest_reference: null, flags: [], caution: "RQ is a marker of test validity and fuel mix. It is not a reliable guide to overfeeding or underfeeding (McClave 2003)." };
  if (rq > 1) out.flags.push("Above 1: net fat synthesis, glucose intake, or excessive total calorie intake.");
  if (rq <= 0.65) out.flags.push("0.65 or lower: ketone production, or inadequate nutrient intake.");
  out.closest_reference = RQ_REFERENCE.reduce((best, r) => (Math.abs(r.rq - rq) < Math.abs(best.rq - rq) ? r : best), RQ_REFERENCE[0]);
  return out;
}

function infantDeposition(months) {
  return INFANT_DEPOSITION.find((b) => months >= b.fromMonths && months <= b.toMonths) || null;
}

function applyEquation(eq, { ageYears, weightKg, heightM, paIndex }) {
  const pa = eq.pa[paIndex];
  const kcal = eq.a + eq.b * ageYears + pa * (eq.w * weightKg + eq.h * heightM) + eq.dep;
  return { pa_coefficient: pa, kcal };
}

const estimate = (o) => ({ ...o, kcal: Math.round(o.kcal_unrounded), kcal_unrounded: round(o.kcal_unrounded, 1) });

// ─── Orchestrator ──────────────────────────────────────────────────────────────────

/**
 * input (snake_case JSON): sex, age_years | age_months, weight_kg, height_cm | height_m,
 *   measured_ree_kcal?, rq? { vo2, vco2 }, bmi_for_age_percentile? (children),
 *   activity_factor? "minimal|moderate|strenuous|<registered>", activity_position? "low|mid|high" | 0..1,
 *   pal? | pal_category? | activities? [{ id|delta_pal_per_hour, hours|minutes }],
 *   stress? [{ id, ...params }], pregnancy? { trimester }, lactation? { months_postpartum },
 *   prefer? "iom" | "ree"
 * Returns { ok: true, data } or { ok: false, error }.
 */
export function computeEnergyRequirements(input) {
  const inp = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const warnings = [];
  const notes = [];

  const sex = normalizeSexMF(inp.sex);
  if (!sex) return { ok: false, error: "'sex' is required: male or female" };

  let ageMonths = null; let ageYears = null;
  if (inp.age_months !== undefined && inp.age_months !== null && inp.age_months !== "") {
    const m = num(inp.age_months);
    if (!isNum(m) || m < 0 || m > 1440) return { ok: false, error: "'age_months' must be between 0 and 1440" };
    ageMonths = m; ageYears = m / 12;
  } else if (inp.age_years !== undefined && inp.age_years !== null && inp.age_years !== "") {
    const y = num(inp.age_years);
    if (!isNum(y) || y < 0 || y > 120) return { ok: false, error: "'age_years' must be between 0 and 120" };
    ageYears = y; ageMonths = Math.floor(y * 12);
  } else return { ok: false, error: "'age_years' (or 'age_months') is required" };

  const weightKg = num(inp.weight_kg);
  if (!isNum(weightKg) || weightKg < 0.5 || weightKg > 500) return { ok: false, error: "'weight_kg' is required, in kilograms (0.5-500)" };
  let heightM = NaN;
  if (inp.height_cm !== undefined && inp.height_cm !== null && inp.height_cm !== "") heightM = num(inp.height_cm) / 100;
  else if (inp.height_m !== undefined && inp.height_m !== null && inp.height_m !== "") heightM = num(inp.height_m);
  const heightGiven = isNum(heightM);
  if (heightGiven && (heightM < 0.3 || heightM > 2.6)) return { ok: false, error: "height must be 30-260 cm (use height_cm, or height_m in metres)" };
  const heightCm = heightGiven ? heightM * 100 : null;
  const bmi = heightGiven ? weightKg / (heightM * heightM) : null;

  const bmiPct = num(inp.bmi_for_age_percentile);
  const bmiPctGiven = inp.bmi_for_age_percentile !== undefined && inp.bmi_for_age_percentile !== null && inp.bmi_for_age_percentile !== "";
  if (bmiPctGiven && (!isNum(bmiPct) || bmiPct <= 0 || bmiPct >= 100)) return { ok: false, error: "'bmi_for_age_percentile' must be between 0 and 100" };
  const bmiPctSource = bmiPctGiven ? (inp.bmi_percentile_source ? String(inp.bmi_percentile_source).slice(0, 200) : "supplied by the caller") : null;

  const pregnant = inp.pregnancy !== undefined && inp.pregnancy !== null;
  const lactating = inp.lactation !== undefined && inp.lactation !== null;
  if (pregnant && lactating) return { ok: false, error: "pregnancy and lactation cannot both be set" };
  if ((pregnant || lactating) && sex !== "female") return { ok: false, error: "pregnancy and lactation apply to female only" };

  // ── REE ──
  let ree = null;
  const measured = num(inp.measured_ree_kcal);
  if (inp.measured_ree_kcal !== undefined && inp.measured_ree_kcal !== null && inp.measured_ree_kcal !== "") {
    if (!isNum(measured) || measured < 200 || measured > 6000) return { ok: false, error: "'measured_ree_kcal' must be 200-6000" };
    ree = { kcal: measured, method: "measured", label: "Measured REE (indirect calorimetry)", note: "The chapter says measurement is best, even in non-acute care." };
  } else if (ageYears >= 18 && heightGiven) {
    const k = mifflinStJeor({ sex, weightKg, heightCm, ageYears });
    ree = { kcal: round(k, 1), method: "mifflin_st_jeor", label: "Mifflin-St Jeor", formula: sex === "male" ? "10 x kg + 6.25 x cm - 5 x age + 5" : "10 x kg + 6.25 x cm - 5 x age + 5 - 161" };
    if (k < 500) warnings.push("Predicted REE is unusually low. Check the weight, height and age entered.");
  } else if (ageYears < 18) {
    notes.push("Mifflin-St Jeor was built on and applied to adults, so no REE is predicted under 18. Use the IOM EER below, or supply measured_ree_kcal.");
  } else {
    notes.push("height_cm is needed for Mifflin-St Jeor, so only equations that need no height are shown.");
  }
  if (ree && ree.method === "mifflin_st_jeor") notes.push("The chapter does not recommend Harris-Benedict, so it is not offered. Mifflin-St Jeor was the most accurate in normal weight and obese adults (Frankenfield 2003).");

  let rq = null;
  if (inp.rq !== undefined && inp.rq !== null) {
    const r = isNum(num(inp.rq)) ? interpretRQ(num(inp.rq), 1) : interpretRQ(inp.rq?.vco2, inp.rq?.vo2);
    if (r.error) return { ok: false, error: r.error };
    rq = r;
  }

  // ── Stress factors ──
  const stressInput = inp.stress === undefined || inp.stress === null ? [] : inp.stress;
  if (!Array.isArray(stressInput)) return { ok: false, error: "'stress' must be an array of { id, ...params }" };
  if (stressInput.length > 10) return { ok: false, error: "at most 10 stress factors" };
  const stressFactors = [];
  let stressMultiplier = 1;
  const seen = new Set();
  for (const [i, s] of stressInput.entries()) {
    if (!s || typeof s !== "object" || typeof s.id !== "string") return { ok: false, error: `stress[${i}] needs an 'id'. See GET /energy/factors` };
    const def = stressRegistry.get(s.id);
    if (!def) return { ok: false, error: `stress[${i}]: unknown factor '${s.id.slice(0, 40)}'. Known: ${[...stressRegistry.keys()].join(", ")}` };
    if (s.id !== "custom") { if (seen.has(s.id)) return { ok: false, error: `stress factor '${s.id}' given twice` }; seen.add(s.id); }
    const r = def.compute(s);
    if (r.error) return { ok: false, error: `stress[${i}] (${s.id}): ${r.error}` };
    if (!isNum(r.multiplier) || r.multiplier <= 0) return { ok: false, error: `stress[${i}] (${s.id}): factor returned a bad multiplier` };
    stressMultiplier *= r.multiplier;
    stressFactors.push({ id: s.id, label: s.id === "custom" && s.label ? String(s.label).slice(0, 80) : def.label, multiplier: round(r.multiplier, 4), detail: r.detail, source: def.source, evidence: def.evidence });
  }
  if (stressFactors.length && !ree) warnings.push("Stress factors apply to REE, and no REE could be calculated, so they were not used. Supply measured_ree_kcal, or height_cm for an adult.");
  const stressedRee = ree ? ree.kcal * stressMultiplier : null;

  // ── Activity ──
  let palValue = null; let palInfo = null;
  const givenPal = num(inp.pal);
  if (inp.activities !== undefined && inp.activities !== null) {
    const p = palFromActivities(inp.activities, weightKg);
    if (p.error) return { ok: false, error: p.error };
    palValue = p.pal; palInfo = { source: "activities", ...p };
  } else if (inp.pal !== undefined && inp.pal !== null && inp.pal !== "") {
    if (!isNum(givenPal) || givenPal < 1 || givenPal > 2.5) return { ok: false, error: "'pal' must be 1-2.5" };
    palValue = givenPal; palInfo = { source: "pal", pal: givenPal };
  }
  let palCategory = null;
  if (inp.pal_category !== undefined && inp.pal_category !== null && inp.pal_category !== "") {
    palCategory = String(inp.pal_category).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!PAL_LEVELS.includes(palCategory)) return { ok: false, error: `'pal_category' must be one of ${PAL_LEVELS.join(", ")}` };
    if (palValue !== null && palCategoryFor(palValue) !== palCategory) warnings.push(`pal_category '${palCategory}' disagrees with the PAL of ${palValue} (${palCategoryFor(palValue)}). The category you gave was used.`);
  } else if (palValue !== null) palCategory = palCategoryFor(palValue);

  let activityFactor = null;
  if (inp.activity_factor !== undefined && inp.activity_factor !== null && inp.activity_factor !== "") {
    const def = activityRegistry.get(String(inp.activity_factor));
    if (!def) return { ok: false, error: `unknown activity_factor '${String(inp.activity_factor).slice(0, 40)}'. Known: ${[...activityRegistry.keys()].join(", ")}` };
    let pos = 0.5; let posLabel = "mid";
    const rawPos = inp.activity_position;
    if (rawPos !== undefined && rawPos !== null && rawPos !== "") {
      if (rawPos === "low") { pos = 0; posLabel = "low"; } else if (rawPos === "mid") { pos = 0.5; posLabel = "mid"; } else if (rawPos === "high") { pos = 1; posLabel = "high"; } else {
        const n = num(rawPos);
        if (!isNum(n) || n < 0 || n > 1) return { ok: false, error: "'activity_position' must be low, mid, high, or a number 0-1" };
        pos = n; posLabel = String(n);
      }
    }
    const fraction = def.min + pos * (def.max - def.min);
    activityFactor = { id: def.id, label: def.label, range: { min: def.min, max: def.max }, position: posLabel, fraction: round(fraction, 4), multiplier: round(1 + fraction, 4), source: def.source, evidence: def.evidence };
  }

  const estimates = [];

  // ── REE x activity ──
  if (ree && activityFactor) {
    const k = stressedRee * activityFactor.multiplier;
    estimates.push(estimate({
      id: "ree_x_activity", label: `${ree.method === "measured" ? "Measured" : "Predicted"} REE${stressFactors.length ? " x stress" : ""} x ${activityFactor.label.toLowerCase()}`,
      kcal_unrounded: k, basis: "REE method", source: activityFactor.source, evidence: activityFactor.evidence,
      steps: [`REE ${round(ree.kcal, 1)}`, ...stressFactors.map((s) => `x ${s.multiplier} (${s.label})`), `x ${activityFactor.multiplier} (${activityFactor.label}, ${activityFactor.position} of ${Math.round(activityFactor.range.min * 100)}-${Math.round(activityFactor.range.max * 100)}%)`],
    }));
  } else if (ree && stressFactors.length && !palCategory) {
    estimates.push(estimate({ id: "ree_stressed", label: "REE x stress (no activity added)", kcal_unrounded: stressedRee, basis: "REE method", source: SOURCE, evidence: "see stress factors", steps: [`REE ${round(ree.kcal, 1)}`, ...stressFactors.map((s) => `x ${s.multiplier} (${s.label})`)] }));
  }

  // ── IOM ──
  let iom = null;
  const iomNotes = [];
  if (ageYears < 3) {
    const dep = infantDeposition(ageMonths);
    if (!dep) {
      iomNotes.push(ageMonths > 35 ? "" : "Age outside the infant and young-child equation (0-35 months).");
    } else {
      const k = 89 * weightKg - 100 + dep.kcal;
      iom = estimate({ id: "eer_infant_0_35m", label: "EER, infants and young children 0-35 months (weight-for-height 3rd-97th percentile)", kcal_unrounded: k, basis: "IOM EER", kind: "EER", pa_coefficient: null, energy_deposition_kcal: dep.kcal, steps: [`89 x ${weightKg} kg - 100 + ${dep.kcal} (energy deposition, ${dep.fromMonths}-${dep.toMonths} months)`], source: SOURCE, evidence: "IOM DRI" });
    }
  } else {
    if (palCategory === null) {
      iomNotes.push("No PAL given, so the IOM equations are not calculated. Send pal, pal_category or activities.");
    } else if (!heightGiven) {
      iomNotes.push("height_cm is needed for the IOM equations.");
    } else {
      const paIndex = PAL_LEVELS.indexOf(palCategory);
      const candidates = IOM_EQUATIONS.filter((e) => e.sex === sex && ageYears >= e.ageMin && ageYears < e.ageMax);
      const child = ageYears < 19;
      const results = [];
      for (const e of candidates) {
        if (child) {
          const status = bmiPctGiven ? (bmiPct > 85 ? "overweight" : "normal") : "normal";
          if (e.weight_status !== status) continue;
        } else {
          if (e.bmiMin !== undefined && bmi < e.bmiMin) continue;
          if (e.bmiMax !== undefined && bmi >= e.bmiMax) continue;
        }
        const r = applyEquation(e, { ageYears, weightKg, heightM, paIndex });
        results.push(estimate({ id: e.id, label: e.label, kcal_unrounded: r.kcal, basis: `IOM ${e.kind === "EER" ? "EER" : "weight-maintenance TEE"}`, kind: e.kind, pa_coefficient: r.pa_coefficient, energy_deposition_kcal: e.dep || 0, steps: [`${e.a} ${e.b < 0 ? "-" : "+"} ${Math.abs(e.b)} x ${round(ageYears, 2)} y + ${r.pa_coefficient} x (${e.w} x ${weightKg} kg + ${e.h} x ${round(heightM, 3)} m)${e.dep ? ` + ${e.dep}` : ""}`], source: SOURCE, evidence: "IOM DRI" }));
      }
      if (child && !bmiPctGiven) {
        const why = inp.bmi_percentile_lookup_error ? ` It could not be looked up (${String(inp.bmi_percentile_lookup_error).slice(0, 160)}).` : ageYears < 3 ? "" : " It needs height and weight to be looked up from the WHO tables.";
        warnings.push(`No BMI-for-age percentile, so the normal-weight child equation was used.${why} Send bmi_for_age_percentile (above 85 selects the overweight equation).`);
      }
      if (child && bmiPctGiven && bmiPct < 5) warnings.push("BMI-for-age below the 5th percentile: the IOM child equations were built for the 5th-85th percentile.");
      if (child && bmiPctGiven && inp.bmi_percentile_source) notes.push(`BMI-for-age percentile ${round(bmiPct, 1)}: ${bmiPctSource}.`);
      if (!child && bmi < 18.5) warnings.push(`BMI ${round(bmi, 1)} is below 18.5: no IOM adult equation in the chapter applies.`);
      if (results.length) { iom = results[0]; if (results.length > 1) iom.alternatives = results.slice(1); }
      else if (!child && bmi >= 18.5) iomNotes.push("No IOM equation matched.");
    }
  }
  iomNotes.filter(Boolean).forEach((n) => notes.push(n));

  // ── Pregnancy / lactation add-ons ──
  let addOn = null;
  if (iom && (pregnant || lactating)) {
    if (ageYears < 14 || ageYears > 50) warnings.push("The DRI pregnancy and lactation values cover ages 14-50. The adult or adolescent value was used anyway.");
    if (pregnant) {
      const t = Number(inp.pregnancy.trimester);
      if (![1, 2, 3].includes(t)) return { ok: false, error: "pregnancy needs trimester 1, 2 or 3" };
      addOn = { type: "pregnancy", trimester: t, kcal: PREGNANCY_ADD_KCAL[t], note: "Pre-pregnancy EER plus the change in TEE and pregnancy energy deposition (Box 2.1). Use pre-pregnancy weight." };
    } else {
      const mp = num(inp.lactation.months_postpartum);
      if (!isNum(mp) || mp < 0 || mp > 24) return { ok: false, error: "lactation needs months_postpartum (0-24)" };
      if (mp > 12) warnings.push("The DRI lactation values cover the first 12 months. The second-6-months add-on was used.");
      const period = mp <= 6 ? "first_6_months" : "second_6_months";
      addOn = { type: "lactation", period, kcal: LACTATION_ADD_KCAL[period], note: "Milk energy output minus weight loss (Box 2.1)." };
      if (period === "first_6_months") notes.push("Lactation, first 6 months: +330 kcal (500 milk energy - 170 weight loss), the value that matches Table 2.2. Box 2.1 prints 500 - 70 for adults, which looks like a typographical error because it does not reproduce Table 2.2's 2733.");
    }
    iom = estimate({ ...iom, add_on: addOn, kcal_unrounded: iom.kcal_unrounded + addOn.kcal, label: `${iom.label} + ${addOn.type}`, steps: [...iom.steps, `+ ${addOn.kcal} kcal (${addOn.type})`] });
    if (iom.alternatives) iom.alternatives = iom.alternatives.map((a) => estimate({ ...a, kcal_unrounded: a.kcal_unrounded + addOn.kcal }));
  } else if ((pregnant || lactating) && !iom) {
    warnings.push("Pregnancy and lactation add-ons need an IOM equation to build on (PAL and height are required).");
  }
  if (iom) {
    estimates.push(iom);
    notes.push("IOM equations maintain current weight and activity. They are not meant to promote weight loss.");
    if (iom.pa_coefficient === 1 && palCategory === "sedentary") notes.push("Sedentary PA coefficient is 1.");
  }

  if (!estimates.length && !ree) return { ok: false, error: "nothing could be calculated. Adults need height_cm; children need height_cm and a PAL (pal, pal_category or activities)." };
  if (!estimates.length) notes.push("Only REE was calculated. Add activity_factor (minimal, moderate, strenuous) for a REE-based total, or a PAL for the IOM equations.");

  // ── Recommended ──
  const reeEst = estimates.find((e) => e.id === "ree_x_activity" || e.id === "ree_stressed");
  const prefer = inp.prefer === "iom" || inp.prefer === "ree" ? inp.prefer : null;
  let recommended = null; let reason = null;
  if (!estimates.length) { /* REE only */ }
  else if (prefer === "ree" && reeEst) { recommended = reeEst; reason = "You asked for the REE-based estimate."; }
  else if (prefer === "iom" && iom) { recommended = iom; reason = "You asked for the IOM estimate."; }
  else if (reeEst && (stressFactors.length || ree.method === "measured")) { recommended = reeEst; reason = stressFactors.length ? "Stress factors or illness are present, and the IOM equations describe healthy people." : "A measured REE is more reliable than a predicted one."; }
  else if (iom) { recommended = iom; reason = "Healthy-person estimate from the IOM equations, which come from doubly labeled water studies."; }
  else { recommended = reeEst; reason = "Only the REE-based estimate could be calculated."; }
  if (iom && reeEst && Math.abs(iom.kcal - reeEst.kcal) / Math.max(iom.kcal, reeEst.kcal) > 0.15) warnings.push(`The IOM and REE-based estimates differ by more than 15% (${iom.kcal} vs ${reeEst.kcal} kcal). Check the activity level.`);

  const finalKcal = recommended ? recommended.kcal : null;
  const data = {
    inputs_used: { sex, age_years: round(ageYears, 2), age_months: ageMonths, weight_kg: weightKg, height_cm: heightCm === null ? null : round(heightCm, 1), bmi: bmi === null ? null : round(bmi, 1), bmi_for_age_percentile: bmiPctGiven ? round(bmiPct, 1) : null, bmi_percentile_source: bmiPctSource, pal: palValue, pal_category: palCategory },
    ree: ree ? { ...ree, kcal: round(ree.kcal, 1) } : null,
    stress: ree ? { factors: stressFactors, multiplier: round(stressMultiplier, 4), ree_after_stress_kcal: round(stressedRee, 1) } : { factors: [], multiplier: 1, ree_after_stress_kcal: null },
    activity: { factor: activityFactor, pal: palInfo, pal_category: palCategory },
    estimates: estimates.map((e) => e),
    recommended: recommended ? { id: recommended.id, kcal: finalKcal, reason } : null,
    components: ree && recommended ? { ree_kcal: round(ree.kcal, 1), tef_note: `TEF is about 10% of TEE and is already inside the activity multipliers and IOM equations. It is not added again. For reference, 10% of REE is ${round(ree.kcal * 0.1)} kcal.`, activity_and_other_kcal: round(finalKcal - ree.kcal) } : null,
    rq,
    warnings,
    notes,
    sources: [SOURCE],
    disclaimer: "Estimates for adults and children who are not critically ill unless a measured REE and stress factors are supplied. Individual variation can be wide. For critically ill patients the chapter refers to chapter 39. A dietitian's judgement applies.",
  };
  return { ok: true, data };
}

/** Everything a client needs to build an input form, and the reference tables behind the engine. */
export function energyFactorCatalog() {
  return {
    source: SOURCE,
    activity_factors: [...activityRegistry.values()].map(({ id, label, min, max, source, evidence }) => ({ id, label, min, max, min_percent: Math.round(min * 100), max_percent: Math.round(max * 100), source, evidence })),
    stress_factors: [...stressRegistry.values()].map(({ id, label, source, evidence, inputs }) => ({ id, label, source, evidence, inputs })),
    pal_categories: PAL_CATEGORIES,
    activities: ACTIVITY_TABLE,
    iom_equations: IOM_EQUATIONS.map(({ id, label, kind, sex, ageMin, ageMax, bmiMin, bmiMax, weight_status, a, b, w, h, dep, pa }) => ({
      id, label, kind, sex, age_min_years: ageMin, age_max_years: ageMax >= 200 ? null : ageMax,
      bmi_min: bmiMin ?? null, bmi_max: bmiMax ?? null, weight_status: weight_status ?? null,
      intercept: a, age_coefficient: b, weight_coefficient: w, height_m_coefficient: h, energy_deposition_kcal: dep,
      pa_coefficients: Object.fromEntries(PAL_LEVELS.map((l, i) => [l, pa[i]])),
    })),
    infant_equation: { formula: "EER = 89 x weight_kg - 100 + energy deposition", energy_deposition_kcal: INFANT_DEPOSITION },
    pregnancy_add_kcal: PREGNANCY_ADD_KCAL,
    lactation_add_kcal: LACTATION_ADD_KCAL,
    dri_reference_eer: DRI_REFERENCE_EER,
    rq_reference: RQ_REFERENCE,
    ree_measurement_protocol: REE_MEASUREMENT_PROTOCOL,
    food_energy: foodEnergyCatalog(),
    combining_rule: "REE x stress factors, then x (1 + activity fraction). IOM equations stand alone. TEF is never added separately.",
  };
}
