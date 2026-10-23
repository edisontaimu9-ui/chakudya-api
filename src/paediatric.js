/**
 * Paediatric nutrition calculators (birth to 18 years). Pure functions, no database or network.
 * Every function takes the request body and returns { ok: true, data } or { ok: false, error }.
 *
 * Reuses the energy engine (src/energyEngine.js) for the IOM EER, so the child equations are not duplicated.
 *
 * References behind the tables (cited by name; each table in GET /paediatric/reference carries its own source):
 *  - Holliday MA, Segar WE. The maintenance need for water in parenteral fluid therapy. Pediatrics 1957.
 *  - Schofield WN. Predicting basal metabolic rate, new standards and review of previous work. Hum Nutr Clin Nutr 1985.
 *  - WHO. Energy and protein requirements. Technical Report Series 724, 1985.
 *  - FAO. Human energy requirements. Food and Nutrition Technical Report Series 1, 2004 (DRI/FAO total energy expenditure).
 *  - Institute of Medicine. Dietary Reference Intakes (energy, macronutrients, protein), 2005/2006.
 *  - ASPEN Pediatric and Neonatal Nutrition Support Handbook, 3rd ed. (2024), and ASPEN guidance for sick children.
 *  - ESPGHAN preterm enteral nutrition guidelines (preterm fluid, energy and protein requirements).
 *
 * Screening and planning aids. They do not replace a dietitian or doctor, and the sick-child, preterm and catch-up values
 * are starting points to be reviewed against the child's clinical course.
 */

import { computeEnergyRequirements, normalizeSexMF } from "./energyEngine.js";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
const rnd = (n, d = 1) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const fail = (error) => ({ ok: false, error });
const MAX_MONTHS = 216; // 18 years

export const SOURCES = {
  holliday_segar: "Holliday MA, Segar WE. Pediatrics 1957 (maintenance fluid by body weight)",
  schofield: "Schofield WN. Hum Nutr Clin Nutr 1985 (basal metabolic rate, weight and height equations)",
  who_1985: "WHO Technical Report Series 724, 1985 (basal metabolic rate from weight)",
  dri_fao_2004: "FAO Human Energy Requirements, Food and Nutrition Technical Report Series 1, 2004 (total energy expenditure, kcal/kg/day)",
  iom_eer: "Institute of Medicine Dietary Reference Intakes, estimated energy requirement (2005/2006)",
  iom_protein: "Institute of Medicine Dietary Reference Intakes, protein RDA/AI for healthy growth (2005)",
  iom_amdr: "Institute of Medicine Dietary Reference Intakes, acceptable macronutrient distribution ranges (2005)",
  aspen_protein: "ASPEN guidance for sick children (protein dose)",
  aspen_handbook: "ASPEN Pediatric and Neonatal Nutrition Support Handbook, 3rd ed. (2024)",
  preterm: "ESPGHAN (European Society for Paediatric Gastroenterology, Hepatology and Nutrition) preterm enteral nutrition guidelines",
  catch_up: "Standard clinical catch-up growth method: requirement for weight-age x ideal weight for length/height / actual weight",
};

// ─── Reference data ─────────────────────────────────────────────────────────

// Schofield 1985 (height versions). kcal/day = w*kg + h*cm + c. Bands are [from, to) in years; the last band includes 18.
const SCHOFIELD = [
  { from: 0, to: 3, male: { w: 0.167, h: 15.174, c: -617.6 }, female: { w: 16.252, h: 10.232, c: -413.5 } },
  { from: 3, to: 10, male: { w: 19.59, h: 1.303, c: 414.9 }, female: { w: 16.969, h: 1.618, c: 371.2 } },
  { from: 10, to: 18.0001, male: { w: 16.25, h: 1.372, c: 515.5 }, female: { w: 8.365, h: 4.65, c: 200 } },
];

// WHO 1985 (weight only). kcal/day = w*kg + c.
const WHO_1985 = [
  { from: 0, to: 3, male: { w: 60.9, c: -54 }, female: { w: 61, c: -51 } },
  { from: 3, to: 10, male: { w: 22.7, c: 495 }, female: { w: 22.5, c: 499 } },
  { from: 10, to: 18.0001, male: { w: 17.5, c: 651 }, female: { w: 12.2, c: 746 } },
];

export const ACTIVITY_FACTORS = {
  confined_to_bed: { label: "Confined to bed", min: 1, max: 1.1, definition: "Cerebral palsy, hospitalisation, paralysis" },
  light: { label: "Light activity", min: 1.3, max: 1.5, definition: "Spends several hours a day at school or in sedentary activity, no physical sports, motor transport, leisure activities with little physical effort (TV, reading, computers)" },
  moderate: { label: "Moderate activity", min: 1.5, max: 1.85, definition: "In between light and vigorous activity" },
  vigorous: { label: "High or vigorous activity", min: 1.8, max: 2.15, definition: "Walks long distances daily or cycles for transport, high-energy occupations or chores for several hours a day, and/or sport or exercise for several hours a day" },
};

export const STRESS_FACTORS = {
  starvation: { label: "Starvation", min: 0.7, max: 0.85 },
  surgery: { label: "Surgery", min: 1.05, max: 1.5 },
  infection_sepsis: { label: "Infection / sepsis", min: 1.2, max: 1.6 },
  closed_head_injury: { label: "Closed head injury", min: 1.3, max: 1.3 },
  trauma: { label: "Trauma", min: 1.1, max: 1.8 },
  burn: { label: "Burn", min: 1.5, max: 2.5 },
  growth_failure: { label: "Growth failure", min: 1.5, max: 2 },
};

// DRI/FAO 2004 total energy expenditure, kcal/kg/day: [girls, boys].
const TEE_MONTHS = [
  [107, 113], [101, 104], [94, 95], [84, 82], [83, 81], [82, 81],
  [78, 79], [78, 79], [78, 79], [79, 80], [79, 80], [79, 81],
]; // index = completed months 0..11
const TEE_YEARS = {
  1: [80, 82], 2: [81, 84], 3: [77, 80], 4: [74, 77], 5: [72, 75], 6: [69, 73], 7: [67, 71], 8: [64, 69],
  9: [61, 67], 10: [58, 65], 11: [55, 62], 12: [52, 60], 13: [49, 58], 14: [47, 56], 15: [45, 53], 16: [44, 52], 17: [44, 50],
}; // key = completed years 1..17

// Acceptable macronutrient distribution ranges, % of energy.
const AMDR = [
  { id: "infant", label: "Full-term infant (0-12 months)", carbohydrate: [35, 65], fat: [30, 55], protein: [7, 16] },
  { id: "1_3y", label: "1-3 years", carbohydrate: [45, 65], fat: [30, 40], protein: [5, 20] },
  { id: "4_18y", label: "4-18 years", carbohydrate: [45, 65], fat: [25, 35], protein: [10, 30] },
];

// IOM protein, healthy growth, g/kg/day.
const PROTEIN_RDA = [
  { id: "1_6m", label: "1-6 months", fromMonths: 0, toMonths: 6, g_per_kg: 1.52, type: "AI" },
  { id: "6_12m", label: "6-12 months", fromMonths: 6, toMonths: 12, g_per_kg: 1.5, type: "RDA" },
  { id: "1_3y", label: "1-3 years", fromMonths: 12, toMonths: 48, g_per_kg: 1.1, type: "RDA" },
  { id: "4_13y", label: "4-13 years", fromMonths: 48, toMonths: 168, g_per_kg: 0.95, type: "RDA" },
  { id: "14_18y", label: "14-18 years", fromMonths: 168, toMonths: 217, g_per_kg: 0.85, type: "RDA" },
];

// ASPEN sick-child protein dose, g/kg/day.
const PROTEIN_SICK = [
  { id: "0_2y", label: "0-2 years", fromMonths: 0, toMonths: 24, min: 3, max: 3 },
  { id: "2_13y", label: "2-13 years", fromMonths: 24, toMonths: 156, min: 1.5, max: 2 },
  { id: "13_18y", label: "13-18 years", fromMonths: 156, toMonths: 217, min: 1.5, max: 1.5 },
];

// Preterm enteral requirements. Protein by birth/current weight band (upper boundary belongs to the lower band, except <1000 g).
const PRETERM = {
  fluid_ml_per_kg_day: { min: 120, max: 200 },
  energy_kcal_per_kg_day: { min: 110, max: 130 },
  protein_bands: [
    { label: "Birth/current weight < 1000 g", maxG: 1000, inclusive: false, min: 3.5, max: 4.5 },
    { label: "1000-1500 g", maxG: 1500, inclusive: true, min: 3.5, max: 4.5 },
    { label: "1500-2000 g", maxG: 2000, inclusive: true, min: 3, max: 4 },
    { label: "2000-2500 g", maxG: 2500, inclusive: true, min: 2.5, max: 3.5 },
    { label: "> 2500 g", maxG: Infinity, inclusive: true, min: 2, max: 2.5 },
  ],
  monitoring: {
    initial_weight_loss_max_percent: 15,
    regain_birth_weight_days: { min: 10, max: 14 },
    weight_gain_g_per_kg_day: { min: 15, max: 20 },
    length_cm_per_week_min: 1,
    head_circumference_cm_per_week: { min: 0.8, max: 1 },
  },
};

// Reference normal growth velocity (ASPEN handbook). Weight g/day, length mm/day. null = no usable reference value.
// Girls 3-6 months weight is printed as "21-21" in the data supplied, which is not a usable range, so it is left out.
const VELOCITY_INFANT = [
  { from: 0, to: 1, girls: { w: [22, 42], l: [0.8, 1.1] }, boys: { w: [24, 48], l: [0.8, 1.1] } },
  { from: 1, to: 2, girls: { w: [24, 43], l: [0.8, 1.1] }, boys: { w: [30, 51], l: [0.8, 1.1] } },
  { from: 2, to: 3, girls: { w: [16, 23], l: [0.8, 1.1] }, boys: { w: [19, 36], l: [0.8, 1.1] } },
  { from: 3, to: 6, girls: { w: null, l: [0.5, 0.85] }, boys: { w: [13, 23], l: [0.5, 0.85] } },
  { from: 6, to: 9, girls: { w: [6, 15], l: [0.4, 0.55] }, boys: { w: [7, 15], l: [0.4, 0.55] } },
  { from: 9, to: 12, girls: { w: [4, 12], l: [0.4, 0.55] }, boys: { w: [4, 12], l: [0.4, 0.55] } },
  { from: 12, to: 18, girls: { w: [4, 10], l: [0.37, 0.37] }, boys: { w: [4, 10], l: [0.36, 0.36] } },
  { from: 18, to: 24, girls: { w: [4, 10], l: [0.31, 0.31] }, boys: { w: [4, 9], l: [0.3, 0.3] } },
]; // months
const VELOCITY_CHILD = [
  { from: 2, to: 4, w: [3.5, 5], h: [0.15, 0.23] },
  { from: 4, to: 7, w: [4.5, 6.5], h: [0.16, 0.16] },
  { from: 7, to: 9, w: [5, 8.5], h: [0.13, 0.16] },
  { from: 9, to: 10, w: [6, 10], h: [0.09, 0.13] },
  { from: 10, to: 11, w: [7, 11], h: [0.09, 0.15] },
]; // years, both sexes

// Enteral feeds in paediatrics (ASPEN handbook, 3rd ed.). unit: per_kg_hr (mL/kg/hr), per_kg (mL/kg per feed), ml_hr, ml_feed.
const ENTERAL = {
  infant: {
    label: "0-12 months",
    continuous: {
      initiation: { min: 1, max: 2, unit: "mL/kg/hr" },
      advancement: { min: 1, max: 2, unit: "mL/kg/hr", every_hours: { min: 2, max: 8 } },
      goal: { min: 6, max: 6, unit: "mL/kg/hr" },
    },
    bolus: {
      initiation: { min: 10, max: 15, unit: "mL/kg/feed", every_hours: { min: 2, max: 3 } },
      advancement: { min: 10, max: 30, unit: "mL/feed" },
      goal: { min: 20, max: 30, unit: "mL/kg/feed", every_hours: { min: 3, max: 5 } },
    },
  },
  child_1_6: {
    label: "1-6 years",
    continuous: {
      initiation: { min: 1, max: 1, unit: "mL/kg/hr" },
      advancement: { min: 1, max: 1, unit: "mL/kg/hr", every_hours: { min: 2, max: 8 } },
      goal: { min: 6, max: 6, unit: "mL/kg/hr", up_to: true },
    },
    bolus: {
      initiation: { min: 5, max: 10, unit: "mL/kg/feed", every_hours: { min: 3, max: 3 } },
      advancement: { min: 30, max: 45, unit: "mL/feed" },
      goal: { min: 15, max: 20, unit: "mL/kg/feed", every_hours: { min: 4, max: 6 } },
    },
  },
  child_7_plus: {
    label: "7 years and over",
    continuous: {
      initiation: { min: 25, max: 25, unit: "mL/hr" },
      advancement: { min: 25, max: 25, unit: "mL/hr", every_hours: { min: 2, max: 8 } },
      goal: { min: 100, max: 150, unit: "mL/hr" },
    },
    bolus: {
      initiation: { min: 90, max: 120, unit: "mL/feed", every_hours: { min: 3, max: 4 } },
      advancement: { min: 60, max: 90, unit: "mL/feed" },
      goal: { min: 240, max: 480, unit: "mL/feed", every_hours: { min: 4, max: 6 } },
    },
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseChild(b, { weight = true } = {}) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Body must be a JSON object" };
  const sex = normalizeSexMF(b.sex);
  if (!sex) return { error: "'sex' is required: male or female (boy or girl)" };

  let ageMonths;
  if (b.age_months != null && b.age_months !== "") {
    ageMonths = num(b.age_months);
    if (!isNum(ageMonths) || ageMonths < 0 || ageMonths > MAX_MONTHS) return { error: "'age_months' must be 0-216 (birth to 18 years)" };
  } else if (b.age_years != null && b.age_years !== "") {
    const y = num(b.age_years);
    if (!isNum(y) || y < 0 || y > 18) return { error: "'age_years' must be 0-18" };
    ageMonths = y * 12;
  } else return { error: "'age_months' (or 'age_years') is required" };

  let weightKg = null;
  if (b.weight_kg != null && b.weight_kg !== "") weightKg = num(b.weight_kg);
  else if (b.weight_g != null && b.weight_g !== "") weightKg = num(b.weight_g) / 1000;
  if (weight && weightKg == null) return { error: "'weight_kg' (or 'weight_g') is required" };
  if (weightKg != null && (!isNum(weightKg) || weightKg < 0.3 || weightKg > 150)) return { error: "weight must be 0.3-150 kg. Check you did not pass grams as weight_kg" };

  let heightCm = null;
  if (b.height_cm != null && b.height_cm !== "") {
    heightCm = num(b.height_cm);
    if (!isNum(heightCm) || heightCm < 25 || heightCm > 220) return { error: "'height_cm' (length for under 2 years) must be 25-220" };
  }
  return { sex, ageMonths, ageYears: ageMonths / 12, weightKg, heightCm };
}

function pickPosition(raw, label) {
  if (raw === undefined || raw === null || raw === "") return { pos: 0.5, label: "mid" };
  if (raw === "low") return { pos: 0, label: "low" };
  if (raw === "mid") return { pos: 0.5, label: "mid" };
  if (raw === "high") return { pos: 1, label: "high" };
  const n = num(raw);
  if (!isNum(n) || n < 0 || n > 1) return { error: `'${label}' must be low, mid, high, or a number 0-1` };
  return { pos: n, label: String(n) };
}

const inBand = (bands, ageMonths) => bands.find((x) => ageMonths >= x.fromMonths && ageMonths < x.toMonths) || null;

/** DRI/FAO 2004 total energy expenditure, kcal/kg/day. Under 12 months uses the monthly table. */
export function driFaoTee(sex, ageMonths) {
  const i = sex === "female" ? 0 : 1;
  if (ageMonths < 12) {
    const m = Math.floor(ageMonths);
    return { kcal_per_kg_day: TEE_MONTHS[m][i], age_band: `${m}-${m + 1} months`, table: "0-12 months" };
  }
  const y = Math.floor(ageMonths / 12);
  if (y >= 18) return null;
  return { kcal_per_kg_day: TEE_YEARS[y][i], age_band: `${y}-${y + 1} years`, table: "1-18 years" };
}

function amdrFor(ageMonths) {
  return ageMonths < 12 ? AMDR[0] : ageMonths < 48 ? AMDR[1] : AMDR[2];
}

function macroGrams(kcal, ageMonths) {
  const a = amdrFor(ageMonths);
  const g = (range, perG) => ({ min: rnd((kcal * range[0] / 100) / perG, 0), max: rnd((kcal * range[1] / 100) / perG, 0) });
  return {
    reference: a.label,
    source: SOURCES.iom_amdr,
    percent_of_energy: { carbohydrate: a.carbohydrate, fat: a.fat, protein: a.protein },
    grams_per_day: { carbohydrate: g(a.carbohydrate, 4), fat: g(a.fat, 9), protein: g(a.protein, 4) },
  };
}

function schofieldBmr(sex, ageYears, weightKg, heightCm) {
  const band = SCHOFIELD.find((x) => ageYears >= x.from && ageYears < x.to);
  const k = band[sex];
  return { kcal: k.w * weightKg + k.h * heightCm + k.c, band: `${band.from}-${Math.min(band.to, 18)} years` };
}
function who1985Bmr(sex, ageYears, weightKg) {
  const band = WHO_1985.find((x) => ageYears >= x.from && ageYears < x.to);
  const k = band[sex];
  return { kcal: k.w * weightKg + k.c, band: `${band.from}-${Math.min(band.to, 18)} years` };
}

// ─── Energy ─────────────────────────────────────────────────────────────────

/**
 * body: sex, age_months|age_years, weight_kg, height_cm?, pal_category? (sedentary|low_active|active|very_active, for the IOM EER from 3 years),
 *   activity_level? (confined_to_bed|light|moderate|vigorous) | activity_factor? (number), activity_position? (low|mid|high|0-1),
 *   stress_condition? (starvation|surgery|infection_sepsis|closed_head_injury|trauma|burn|growth_failure) | stress_factor? (number), stress_position?
 */
export function computePaediatricEnergy(b) {
  const c = parseChild(b);
  if (c.error) return fail(c.error);
  const { sex, ageMonths, ageYears, weightKg, heightCm } = c;
  const warnings = [];
  const notes = [];

  // Activity and stress factors (ranges, position picks a point in the range).
  let activity = null;
  if (b.activity_factor != null && b.activity_factor !== "") {
    const f = num(b.activity_factor);
    if (!isNum(f) || f < 0.8 || f > 2.5) return fail("'activity_factor' must be a number 0.8-2.5");
    activity = { id: "custom", label: "Activity factor supplied", min: f, max: f, value: f };
  } else if (b.activity_level != null && b.activity_level !== "") {
    const def = ACTIVITY_FACTORS[b.activity_level];
    if (!def) return fail(`'activity_level' must be one of: ${Object.keys(ACTIVITY_FACTORS).join(", ")}`);
    const p = pickPosition(b.activity_position, "activity_position");
    if (p.error) return fail(p.error);
    activity = { id: b.activity_level, label: def.label, min: def.min, max: def.max, position: p.label, value: rnd(def.min + p.pos * (def.max - def.min), 3) };
  }
  let stress = null;
  if (b.stress_factor != null && b.stress_factor !== "") {
    const f = num(b.stress_factor);
    if (!isNum(f) || f < 0.5 || f > 3) return fail("'stress_factor' must be a number 0.5-3");
    stress = { id: "custom", label: "Stress factor supplied", min: f, max: f, value: f };
  } else if (b.stress_condition != null && b.stress_condition !== "") {
    const def = STRESS_FACTORS[b.stress_condition];
    if (!def) return fail(`'stress_condition' must be one of: ${Object.keys(STRESS_FACTORS).join(", ")}`);
    const p = pickPosition(b.stress_position, "stress_position");
    if (p.error) return fail(p.error);
    stress = { id: b.stress_condition, label: def.label, min: def.min, max: def.max, position: p.label, value: rnd(def.min + p.pos * (def.max - def.min), 3) };
  }

  // Basal metabolic rate.
  const bmrs = [];
  if (heightCm != null) {
    const s = schofieldBmr(sex, ageYears, weightKg, heightCm);
    bmrs.push({ id: "schofield_1985", label: "Schofield (1985), weight and height", kcal: s.kcal, band: s.band, source: SOURCES.schofield });
  } else notes.push("Add height_cm (length under 2 years) for the Schofield equation.");
  const w = who1985Bmr(sex, ageYears, weightKg);
  bmrs.push({ id: "who_1985", label: "WHO (1985), weight only", kcal: w.kcal, band: w.band, source: SOURCES.who_1985 });

  const factorKcal = (bmr) => {
    const lo = bmr * (activity ? activity.min : 1) * (stress ? stress.min : 1);
    const hi = bmr * (activity ? activity.max : 1) * (stress ? stress.max : 1);
    const at = bmr * (activity ? activity.value : 1) * (stress ? stress.value : 1);
    return { low: Math.round(lo), selected: Math.round(at), high: Math.round(hi) };
  };
  const estimates = bmrs.map((m) => ({
    id: m.id, label: m.label, source: m.source, age_band: m.band,
    bmr_kcal: Math.round(m.kcal),
    ...(activity || stress ? { tee_kcal: factorKcal(m.kcal), steps: [`BMR ${Math.round(m.kcal)}`, ...(activity ? [`x ${activity.value} (${activity.label})`] : []), ...(stress ? [`x ${stress.value} (${stress.label})`] : [])] } : {}),
  }));
  if (!activity && !stress) notes.push("Add activity_level (or activity_factor) and/or stress_condition (or stress_factor) to turn the BMR into a total energy estimate.");
  if (activity && stress) warnings.push("Both an activity factor and a stress factor were applied. In hospital many teams use one or the other. Check which fits the child.");

  // Total energy expenditure by age (DRI/FAO 2004).
  const fao = driFaoTee(sex, ageMonths);
  const faoEst = fao ? { id: "dri_fao_2004", label: "DRI/FAO (2004) total energy expenditure by age", kcal_per_kg_day: fao.kcal_per_kg_day, age_band: fao.age_band, kcal: Math.round(fao.kcal_per_kg_day * weightKg), source: SOURCES.dri_fao_2004 } : null;

  // IOM EER through the energy engine.
  let iom = null;
  const engineIn = { sex, age_months: Math.floor(ageMonths), weight_kg: weightKg };
  if (heightCm != null) engineIn.height_cm = heightCm;
  if (b.pal_category != null && b.pal_category !== "") engineIn.pal_category = b.pal_category;
  if (b.bmi_for_age_percentile != null && b.bmi_for_age_percentile !== "") engineIn.bmi_for_age_percentile = b.bmi_for_age_percentile;
  const eng = computeEnergyRequirements(engineIn);
  if (eng.ok) {
    const e = (eng.data.estimates || []).find((x) => /^(eer|tee)_/.test(x.id));
    if (e) iom = { id: e.id, label: e.label, kcal: e.kcal, kind: e.kind, steps: e.steps, source: SOURCES.iom_eer };
    for (const n of eng.data.notes || []) if (/PAL|height_cm is needed|No PAL/.test(n)) notes.push(n);
    for (const wn of eng.data.warnings || []) warnings.push(wn);
  } else if (ageMonths >= 36) {
    notes.push("The IOM EER needs height_cm and pal_category (sedentary, low_active, active, very_active) from 3 years.");
  }

  // Recommended.
  let recommended = null;
  const bmrPref = bmrs[0];
  if ((activity || stress) && bmrPref) {
    recommended = { id: bmrPref.id, kcal: factorKcal(bmrPref.kcal).selected, range_kcal: [factorKcal(bmrPref.kcal).low, factorKcal(bmrPref.kcal).high], reason: "Activity and/or stress factors were supplied, so the BMR-based estimate is used. The IOM and DRI/FAO values describe healthy children." };
  } else if (iom) {
    recommended = { id: iom.id, kcal: iom.kcal, reason: "Healthy-child estimate from the IOM EER." };
  } else if (faoEst) {
    recommended = { id: faoEst.id, kcal: faoEst.kcal, reason: "Healthy-child estimate from the DRI/FAO energy table (kcal/kg/day x weight)." };
  }
  if (iom && faoEst && Math.abs(iom.kcal - faoEst.kcal) / Math.max(iom.kcal, faoEst.kcal) > 0.2) {
    warnings.push(`The IOM EER (${iom.kcal} kcal) and the DRI/FAO table (${faoEst.kcal} kcal) differ by more than 20%. Check the weight, height and activity level.`);
  }

  return {
    ok: true,
    data: {
      inputs_used: { sex, age_months: rnd(ageMonths, 1), weight_kg: weightKg, height_cm: heightCm },
      bmr_estimates: estimates,
      activity_factor: activity,
      stress_factor: stress,
      dri_fao_2004: faoEst,
      iom_eer: iom,
      recommended,
      macronutrient_distribution: recommended ? macroGrams(recommended.kcal, ageMonths) : null,
      warnings,
      notes,
      sources: [SOURCES.schofield, SOURCES.who_1985, SOURCES.dri_fao_2004, SOURCES.iom_eer],
      disclaimer: "Estimates. Re-assess against weight gain and clinical course. A dietitian should review a sick child's targets.",
    },
  };
}

// ─── Protein ────────────────────────────────────────────────────────────────

/** body: sex?, age_months|age_years, weight_kg, clinical_status? ("healthy"|"sick", default healthy), energy_kcal? (adds protein as % of energy) */
export function computePaediatricProtein(b) {
  const c = parseChild({ sex: "male", ...b });
  if (c.error) return fail(c.error);
  const { ageMonths, weightKg } = c;
  const status = b.clinical_status === "sick" ? "sick" : "healthy";
  if (b.clinical_status != null && !["healthy", "sick"].includes(b.clinical_status)) return fail("'clinical_status' must be healthy or sick");

  const rda = inBand(PROTEIN_RDA, ageMonths);
  const sick = inBand(PROTEIN_SICK, ageMonths);
  const healthy = { band: rda.label, type: rda.type, g_per_kg_day: rda.g_per_kg, g_per_day: rnd(rda.g_per_kg * weightKg, 1), source: SOURCES.iom_protein };
  const sickOut = { band: sick.label, g_per_kg_day: { min: sick.min, max: sick.max }, g_per_day: { min: rnd(sick.min * weightKg, 1), max: rnd(sick.max * weightKg, 1) }, source: SOURCES.aspen_protein };
  const notes = [];
  if (ageMonths < 1) notes.push("The IOM infant value (AI 1.52 g/kg/day) covers 0-6 months. It is applied from birth.");
  notes.push("Protein targets for the sick child assume adequate energy is also given. In kidney or liver disease the dose is adjusted by the clinical team.");

  let energyCheck = null;
  const kcal = num(b.energy_kcal);
  if (isNum(kcal) && kcal > 0) {
    const g = status === "sick" ? (sick.min + sick.max) / 2 * weightKg : rda.g_per_kg * weightKg;
    const pct = rnd((g * 4 / kcal) * 100, 1);
    const a = amdrFor(ageMonths);
    energyCheck = { protein_g_used: rnd(g, 1), percent_of_energy: pct, amdr_percent: a.protein, within_amdr: pct >= a.protein[0] && pct <= a.protein[1], note: status === "sick" ? "Uses the middle of the sick-child range." : null };
  }

  return {
    ok: true,
    data: {
      inputs_used: { age_months: rnd(ageMonths, 1), weight_kg: weightKg, clinical_status: status },
      healthy_child: healthy,
      sick_child: sickOut,
      recommended: status === "sick"
        ? { basis: "sick_child", g_per_kg_day: sickOut.g_per_kg_day, g_per_day: sickOut.g_per_day }
        : { basis: "healthy_child", g_per_kg_day: healthy.g_per_kg_day, g_per_day: healthy.g_per_day },
      protein_vs_energy: energyCheck,
      notes,
      sources: [SOURCES.iom_protein, SOURCES.aspen_protein],
    },
  };
}

// ─── Fluid ──────────────────────────────────────────────────────────────────

/** Maintenance fluid for a weight in kg (Holliday-Segar). */
export function maintenanceFluid(weightKg) {
  if (weightKg <= 10) {
    return { min: 100 * weightKg, max: 150 * weightKg, standard: 100 * weightKg, formula: "0-10 kg: 100-150 mL/kg/day (Holliday-Segar 100 mL/kg)" };
  }
  if (weightKg <= 20) {
    const v = 1000 + 50 * (weightKg - 10);
    return { min: v, max: v, standard: v, formula: "11-20 kg: 1000 mL + 50 mL for each kg above 10 kg" };
  }
  const v = 1500 + 20 * (weightKg - 20);
  return { min: v, max: v, standard: v, formula: "Above 20 kg: 1500 mL + 20 mL for each kg above 20 kg" };
}

/** body: weight_kg (age optional). */
export function computePaediatricFluid(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return fail("Body must be a JSON object");
  let w = num(b.weight_kg);
  if (!isNum(w) && b.weight_g != null) w = num(b.weight_g) / 1000;
  if (!isNum(w) || w < 0.3 || w > 150) return fail("'weight_kg' is required (0.3-150)");
  const f = maintenanceFluid(w);
  const notes = [];
  if (f.standard > 2400) notes.push("This is above 2400 mL/day, the usual upper limit used for large children and adults. Check the local protocol.");
  return {
    ok: true,
    data: {
      weight_kg: w,
      formula: f.formula,
      daily_ml: { min: Math.round(f.min), max: Math.round(f.max), standard: Math.round(f.standard) },
      ml_per_kg_day: { min: rnd(f.min / w, 1), max: rnd(f.max / w, 1), standard: rnd(f.standard / w, 1) },
      ml_per_hour: { min: rnd(f.min / 24, 1), max: rnd(f.max / 24, 1), standard: rnd(f.standard / 24, 1) },
      notes: [...notes, "Maintenance fluid for a child with normal losses. Fever, vomiting, diarrhoea, burns, heart, kidney or brain conditions change the need. Fluid from feeds counts toward the total."],
      sources: [SOURCES.holliday_segar],
    },
  };
}

// ─── Preterm ────────────────────────────────────────────────────────────────

function pretermBand(weightG) {
  for (const b of PRETERM.protein_bands) {
    if (b.maxG === Infinity) return b;
    if (b.inclusive ? weightG <= b.maxG : weightG < b.maxG) return b;
  }
  return PRETERM.protein_bands.at(-1);
}

/**
 * body: weight_g (birth or current), monitoring? { birth_weight_g, nadir_weight_g, days_to_regain_birth_weight,
 *   weight_g_start, weight_g_end, days, length_cm_start, length_cm_end, hc_cm_start, hc_cm_end }
 */
export function computePretermRequirements(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return fail("Body must be a JSON object");
  let g = num(b.weight_g);
  if (!isNum(g) && b.weight_kg != null) g = num(b.weight_kg) * 1000;
  if (!isNum(g) || g < 300 || g > 6000) return fail("'weight_g' is required: the birth or current weight in grams (300-6000)");
  const kg = g / 1000;
  const band = pretermBand(g);
  const fl = PRETERM.fluid_ml_per_kg_day;
  const en = PRETERM.energy_kcal_per_kg_day;
  const data = {
    weight_g: g,
    requirements: {
      fluid: { ml_per_kg_day: fl, ml_per_day: { min: Math.round(fl.min * kg), max: Math.round(fl.max * kg) } },
      energy: { kcal_per_kg_day: en, kcal_per_day: { min: Math.round(en.min * kg), max: Math.round(en.max * kg) } },
      protein: { band: band.label, g_per_kg_day: { min: band.min, max: band.max }, g_per_day: { min: rnd(band.min * kg, 1), max: rnd(band.max * kg, 1) } },
    },
    protein_energy_ratio: { protein_kcal_percent_at_mid: rnd((((band.min + band.max) / 2) * 4 / ((en.min + en.max) / 2)) * 100, 1) },
    monitoring_targets: {
      initial_weight_loss: "Up to 15% of birth weight, regained within 10-14 days",
      weight: "Daily, gain 15-20 g/kg/day",
      length: "Weekly, more than 1 cm/week",
      head_circumference: "Weekly, 0.8-1 cm/week",
    },
    notes: ["Enteral requirements. Parenteral nutrition and fortifier choices follow the unit's protocol. Plot growth on a preterm chart (POST /fenton-preterm/profile)."],
    sources: [SOURCES.preterm, SOURCES.aspen_handbook],
  };

  const m = b.monitoring;
  if (m && typeof m === "object") {
    const out = {};
    const T = PRETERM.monitoring;
    const bw = num(m.birth_weight_g), nadir = num(m.nadir_weight_g);
    if (isNum(bw) && isNum(nadir) && bw > 0) {
      const loss = rnd(((bw - nadir) / bw) * 100, 1);
      out.initial_weight_loss = { percent: loss, limit_percent: T.initial_weight_loss_max_percent, status: loss <= T.initial_weight_loss_max_percent ? "within_limit" : "above_limit" };
    }
    const regain = num(m.days_to_regain_birth_weight);
    if (isNum(regain)) {
      out.regain_birth_weight = { days: regain, expected_days: T.regain_birth_weight_days, status: regain <= T.regain_birth_weight_days.max ? "on_time" : "late" };
    }
    const w1 = num(m.weight_g_start), w2 = num(m.weight_g_end), days = num(m.days);
    if (isNum(w1) && isNum(w2) && isNum(days) && days > 0 && w1 > 0) {
      const meanKg = (w1 + w2) / 2 / 1000;
      const gkgd = rnd((w2 - w1) / days / meanKg, 1);
      out.weight_gain = { g_per_kg_day: gkgd, target: T.weight_gain_g_per_kg_day, g_per_day: rnd((w2 - w1) / days, 1), status: gkgd < T.weight_gain_g_per_kg_day.min ? "below_target" : gkgd > T.weight_gain_g_per_kg_day.max ? "above_target" : "within_target", basis: "Uses the average of the start and end weight." };
    }
    const l1 = num(m.length_cm_start), l2 = num(m.length_cm_end);
    if (isNum(l1) && isNum(l2) && isNum(days) && days > 0) {
      const cmw = rnd(((l2 - l1) / days) * 7, 2);
      out.length = { cm_per_week: cmw, target: `more than ${T.length_cm_per_week_min} cm/week`, status: cmw > T.length_cm_per_week_min ? "meets_target" : "below_target" };
    }
    const h1 = num(m.hc_cm_start), h2 = num(m.hc_cm_end);
    if (isNum(h1) && isNum(h2) && isNum(days) && days > 0) {
      const cmw = rnd(((h2 - h1) / days) * 7, 2);
      const t = T.head_circumference_cm_per_week;
      out.head_circumference = { cm_per_week: cmw, target: t, status: cmw < t.min ? "below_target" : cmw > t.max ? "above_target" : "within_target" };
    }
    if (!Object.keys(out).length) return fail("'monitoring' had no complete set of values. See GET /paediatric/reference?section=preterm");
    data.monitoring = out;
  }
  return { ok: true, data };
}

// ─── Growth velocity ────────────────────────────────────────────────────────

function velocityRange(sex, ageMonths) {
  if (ageMonths < 24) {
    const row = VELOCITY_INFANT.find((r) => ageMonths >= r.from && ageMonths < r.to);
    const s = row[sex === "female" ? "girls" : "boys"];
    return { band: `${row.from}-${row.to} months`, weight_g_per_day: s.w, length_mm_per_day: s.l };
  }
  const y = ageMonths / 12;
  const row = VELOCITY_CHILD.find((r) => y >= r.from && y < r.to);
  if (!row) return null;
  return { band: `${row.from}-${row.to === 4 || row.to === 7 || row.to === 9 || row.to === 10 || row.to === 11 ? "<" : ""}${row.to} years`, weight_g_per_day: row.w, length_mm_per_day: row.h };
}

const judge = (v, r) => (r == null ? "no_reference" : v < r[0] ? "below_reference" : v > r[1] ? "above_reference" : "within_reference");

/**
 * body: sex, age_months|age_years (at the START of the interval), days (interval length), and
 *   weight_kg_start + weight_kg_end (or weight_g_start/weight_g_end), and/or height_cm_start + height_cm_end,
 *   or weight_gain_g_per_day / length_mm_per_day directly.
 */
export function computeGrowthVelocity(b) {
  const c = parseChild(b, { weight: false });
  if (c.error) return fail(c.error);
  const { sex, ageMonths } = c;
  const ref = velocityRange(sex, ageMonths);
  if (!ref) return fail("The reference velocity table covers birth to under 11 years. Use /weight-velocity/classify or /length-velocity/classify (WHO increments) for other ages");

  const days = num(b.days);
  let wGd = null, hMmd = null;
  if (b.weight_gain_g_per_day != null && b.weight_gain_g_per_day !== "") wGd = num(b.weight_gain_g_per_day);
  else {
    const w1 = b.weight_kg_start != null ? num(b.weight_kg_start) * 1000 : num(b.weight_g_start);
    const w2 = b.weight_kg_end != null ? num(b.weight_kg_end) * 1000 : num(b.weight_g_end);
    if (isNum(w1) && isNum(w2)) {
      if (!isNum(days) || days <= 0) return fail("'days' (length of the interval, over 0) is required with start and end values");
      wGd = (w2 - w1) / days;
    }
  }
  if (b.length_mm_per_day != null && b.length_mm_per_day !== "") hMmd = num(b.length_mm_per_day);
  else {
    const h1 = num(b.height_cm_start ?? b.length_cm_start), h2 = num(b.height_cm_end ?? b.length_cm_end);
    if (isNum(h1) && isNum(h2)) {
      if (!isNum(days) || days <= 0) return fail("'days' (length of the interval, over 0) is required with start and end values");
      hMmd = ((h2 - h1) * 10) / days;
    }
  }
  if (wGd == null && hMmd == null) return fail("Send weight and/or length/height at the start and end with 'days', or weight_gain_g_per_day / length_mm_per_day");
  if ((wGd != null && !isNum(wGd)) || (hMmd != null && !isNum(hMmd))) return fail("Velocity values must be numbers");

  const notes = [`Compared with the reference for the age at the start of the interval (${ref.band}).`];
  if (isNum(days) && days < 14) notes.push("An interval under 2 weeks is too short for length or height velocity. Weight velocity over a short interval is also noisy.");
  if (ref.weight_g_per_day == null) notes.push("No usable reference weight range for girls aged 3-6 months in the data held (the printed range is not valid), so weight velocity is not judged. Use /weight-velocity/classify (WHO).");

  const out = {
    inputs_used: { sex, age_months_at_start: rnd(ageMonths, 1), days: isNum(days) ? days : null },
    reference_band: ref.band,
    weight: wGd == null ? null : { g_per_day: rnd(wGd, 2), reference_g_per_day: ref.weight_g_per_day, status: judge(wGd, ref.weight_g_per_day) },
    length_height: hMmd == null ? null : { mm_per_day: rnd(hMmd, 3), reference_mm_per_day: ref.length_mm_per_day, status: judge(hMmd, ref.length_mm_per_day) },
    notes,
    sources: [SOURCES.aspen_handbook],
    disclaimer: "Screening against reference velocity. Interpret with the growth chart (z-scores), the child's history and the clinical picture. For WHO z-scores use POST /growth/assess.",
  };
  const flags = [out.weight?.status, out.length_height?.status].filter(Boolean);
  out.summary = flags.includes("below_reference")
    ? "Growth velocity is below the reference range. Look for inadequate intake, illness or other causes."
    : flags.includes("above_reference")
      ? "Growth velocity is above the reference range. This can be expected during catch-up growth or fluid shifts."
      : flags.every((s) => s === "within_reference") ? "Growth velocity is within the reference range." : "Not enough reference data to judge all measures.";
  return { ok: true, data: out };
}

// ─── Catch-up growth ────────────────────────────────────────────────────────

/** Ask the route to look up the WHO median weight-for-length/height? Returns the lookup inputs, or null. */
export function idealWeightLookupFor(b) {
  if (!b || b.ideal_weight_kg != null && b.ideal_weight_kg !== "") return null;
  const sex = normalizeSexMF(b.sex);
  const m = num(b.age_months ?? (b.age_years != null ? Number(b.age_years) * 12 : NaN));
  const h = num(b.height_cm);
  if (!sex || !isNum(m) || !isNum(h) || m > 60) return null;
  return { sex: sex === "female" ? "girls" : "boys", ageMonths: Math.floor(m), heightCm: h, measured: b.measured === "lying" || b.measured === "standing" ? b.measured : undefined };
}

/**
 * Catch-up growth: energy and protein for a child whose weight is below the ideal weight for length/height.
 * body: sex, age_months|age_years, weight_kg, height_cm?, ideal_weight_kg? (else the route looks up the WHO median, under 5 years),
 *   weight_age_months? (age at which the current weight would be the median; default the chronological age).
 * opts.idealWeightKg / opts.idealWeightSource: from the route's WHO lookup.
 */
export function computeCatchUp(b, opts = {}) {
  const c = parseChild(b);
  if (c.error) return fail(c.error);
  const { sex, ageMonths, weightKg, heightCm } = c;

  let ideal = null, idealSource = null;
  if (b.ideal_weight_kg != null && b.ideal_weight_kg !== "") {
    ideal = num(b.ideal_weight_kg);
    if (!isNum(ideal) || ideal < 0.5 || ideal > 150) return fail("'ideal_weight_kg' must be 0.5-150");
    idealSource = "supplied by the caller";
  } else if (opts.idealWeightKg) {
    ideal = opts.idealWeightKg;
    idealSource = opts.idealWeightSource || "WHO median weight-for-length/height";
  }
  if (ideal == null) {
    return fail("The ideal weight for length/height is needed. Send 'ideal_weight_kg', or for a child under 5 years send 'height_cm' (length if under 2 years) and the WHO median is looked up. For older children use the median BMI-for-age weight at the child's height");
  }

  let weightAge = ageMonths;
  let weightAgeNote = "Chronological age was used as the weight-age. If the child is much smaller than expected for age, send weight_age_months (the age at which this weight is the median).";
  if (b.weight_age_months != null && b.weight_age_months !== "") {
    weightAge = num(b.weight_age_months);
    if (!isNum(weightAge) || weightAge < 0 || weightAge > MAX_MONTHS) return fail("'weight_age_months' must be 0-216");
    weightAgeNote = "Weight-age supplied by the caller.";
  }

  const fao = driFaoTee(sex, weightAge);
  const prot = inBand(PROTEIN_RDA, weightAge);
  if (!fao || !prot) return fail("Could not find the energy or protein reference for that weight-age");

  const energyKgD = (fao.kcal_per_kg_day * ideal) / weightKg;
  const proteinKgD = (prot.g_per_kg * ideal) / weightKg;
  const pctIdeal = rnd((weightKg / ideal) * 100, 1);
  const waterlow = pctIdeal >= 90 ? "no wasting" : pctIdeal >= 80 ? "mild wasting" : pctIdeal >= 70 ? "moderate wasting" : "severe wasting";

  // Second method: BMR x growth-failure stress factor.
  let stressMethod = null;
  const ageYears = ageMonths / 12;
  const bmr = heightCm != null ? schofieldBmr(sex, ageYears, weightKg, heightCm) : who1985Bmr(sex, ageYears, weightKg);
  const gf = STRESS_FACTORS.growth_failure;
  stressMethod = {
    label: "BMR x growth-failure stress factor (1.5-2)",
    bmr_method: heightCm != null ? "Schofield (1985)" : "WHO (1985)",
    bmr_kcal: Math.round(bmr.kcal),
    kcal_per_day: { low: Math.round(bmr.kcal * gf.min), high: Math.round(bmr.kcal * gf.max) },
    kcal_per_kg_day: { low: rnd((bmr.kcal * gf.min) / weightKg, 0), high: rnd((bmr.kcal * gf.max) / weightKg, 0) },
  };

  const kcalDay = Math.round(energyKgD * weightKg);
  const protDay = rnd(proteinKgD * weightKg, 1);
  const protPct = rnd(((proteinKgD * weightKg * 4) / kcalDay) * 100, 1);
  const a = amdrFor(ageMonths);

  const ref = velocityRange(sex, ageMonths);
  const warnings = [];
  if (pctIdeal >= 100) warnings.push("The weight is at or above the ideal weight for length/height, so catch-up weight gain is not indicated by this method.");
  if (pctIdeal < 70) warnings.push("Severe wasting. Start with a stabilisation protocol (for example for severe acute malnutrition) and watch for refeeding syndrome before moving to catch-up targets.");
  if (energyKgD > 220) warnings.push("The calculated energy is very high. Check the weight, height and ideal weight.");

  return {
    ok: true,
    data: {
      inputs_used: { sex, age_months: rnd(ageMonths, 1), weight_kg: weightKg, height_cm: heightCm, weight_age_months: rnd(weightAge, 1) },
      ideal_weight_kg: rnd(ideal, 2),
      ideal_weight_source: idealSource,
      weight_deficit_kg: rnd(Math.max(0, ideal - weightKg), 2),
      percent_of_ideal_weight: pctIdeal,
      waterlow_weight_for_height: waterlow,
      energy: {
        reference_kcal_per_kg_day_for_weight_age: fao.kcal_per_kg_day,
        reference_age_band: fao.age_band,
        catch_up_kcal_per_kg_day: rnd(energyKgD, 0),
        catch_up_kcal_per_day: kcalDay,
        formula: "Reference kcal/kg for weight-age x ideal weight for length/height / actual weight",
        source: SOURCES.dri_fao_2004,
      },
      protein: {
        reference_g_per_kg_day_for_weight_age: prot.g_per_kg,
        catch_up_g_per_kg_day: rnd(proteinKgD, 2),
        catch_up_g_per_day: protDay,
        percent_of_energy: protPct,
        amdr_percent: a.protein,
        formula: "Reference g/kg for weight-age x ideal weight for length/height / actual weight",
        source: SOURCES.iom_protein,
      },
      alternative_stress_factor_method: stressMethod,
      reference_normal_velocity: ref,
      goal: "Catch-up growth means gaining faster than the reference velocity until the weight reaches the ideal weight for length/height. Re-weigh at least weekly and adjust.",
      warnings,
      notes: [weightAgeNote, "The two methods are different ways to the same target. Use the one your unit prefers and check the child's weight gain."],
      sources: [SOURCES.catch_up, SOURCES.dri_fao_2004, SOURCES.iom_protein, SOURCES.schofield, SOURCES.who_1985],
    },
  };
}

// ─── Enteral feeds ──────────────────────────────────────────────────────────

const stageFor = (ageMonths) => (ageMonths < 12 ? "infant" : ageMonths < 84 ? "child_1_6" : "child_7_plus");

function perKg(unit) {
  return unit.includes("/kg");
}

/**
 * body: age_months|age_years, weight_kg, route ("continuous" | "bolus", default both), formula_kcal_per_ml?, energy_target_kcal?
 * Gives the starting rate, advancement and goal for the child's weight, the steps and time to goal, and what the goal delivers.
 */
export function computeEnteralFeeds(b) {
  const c = parseChild({ sex: "male", ...b });
  if (c.error) return fail(c.error);
  const { ageMonths, weightKg } = c;
  const stageId = stageFor(ageMonths);
  const stage = ENTERAL[stageId];
  const routes = b.route == null || b.route === "" ? ["continuous", "bolus"] : [b.route];
  if (routes.some((r) => !["continuous", "bolus"].includes(r))) return fail("'route' must be continuous or bolus");

  const dens = num(b.formula_kcal_per_ml);
  if (b.formula_kcal_per_ml != null && b.formula_kcal_per_ml !== "" && (!isNum(dens) || dens < 0.3 || dens > 2.5)) return fail("'formula_kcal_per_ml' must be 0.3-2.5");
  const target = num(b.energy_target_kcal);

  const scale = (x, unit) => {
    const f = perKg(unit) ? weightKg : 1;
    return { min: rnd(x.min * f, 0), max: rnd(x.max * f, 0) };
  };
  const out = {};
  for (const r of routes) {
    const s = stage[r];
    const init = scale(s.initiation, s.initiation.unit);
    const step = scale(s.advancement, s.advancement.unit);
    const goal = scale(s.goal, s.goal.unit);
    const unitLabel = r === "continuous" ? "mL/hr" : "mL per feed";
    // Steps to goal: fastest = largest step, slowest = smallest step.
    const stepsFast = Math.max(0, Math.ceil((goal.min - init.max) / (step.max || 1)));
    const stepsSlow = Math.max(0, Math.ceil((goal.max - init.min) / (step.min || 1)));
    const everyH = s.advancement.every_hours;
    const block = {
      initiation: { ...init, unit: unitLabel, ...(s.initiation.every_hours ? { every_hours: s.initiation.every_hours } : {}) },
      advancement: { ...step, unit: unitLabel, ...(everyH ? { every_hours: everyH } : {}) },
      goal: { ...goal, unit: unitLabel, ...(s.goal.every_hours ? { every_hours: s.goal.every_hours } : {}), ...(s.goal.up_to ? { up_to: true } : {}) },
      steps_to_goal: { min: stepsFast, max: stepsSlow },
      ...(everyH ? { hours_to_goal: { min: stepsFast * everyH.min, max: stepsSlow * everyH.max } } : {}),
    };
    // What the goal delivers per day.
    let dailyMl;
    if (r === "continuous") dailyMl = { min: Math.round(goal.min * 24), max: Math.round(goal.max * 24) };
    else dailyMl = { min: Math.round(goal.min * (24 / s.goal.every_hours.max)), max: Math.round(goal.max * (24 / s.goal.every_hours.min)) };
    block.goal_volume_ml_per_day = dailyMl;
    block.goal_volume_ml_per_kg_day = { min: rnd(dailyMl.min / weightKg, 0), max: rnd(dailyMl.max / weightKg, 0) };
    if (isNum(dens)) {
      block.goal_energy = { kcal_per_day: { min: Math.round(dailyMl.min * dens), max: Math.round(dailyMl.max * dens) }, kcal_per_kg_day: { min: rnd(dailyMl.min * dens / weightKg, 0), max: rnd(dailyMl.max * dens / weightKg, 0) } };
      if (isNum(target) && target > 0) {
        block.goal_energy.percent_of_energy_target = { min: rnd((dailyMl.min * dens / target) * 100, 0), max: rnd((dailyMl.max * dens / target) * 100, 0) };
      }
    }
    out[r] = block;
  }

  const fluid = maintenanceFluid(weightKg);
  const notes = [
    "Advancement for continuous feeds is read as an increase in the hourly rate (per kg where the unit is per kg) every 2-8 hours, as tolerated.",
    "Range ends are shown as printed: the low end of the daily volume uses the longest interval and smallest goal, the high end the shortest interval and largest goal.",
    "Advance only if the child tolerates the feeds (no vomiting, distension or rising gastric residuals). Count feed volume toward the daily fluid.",
  ];
  if (ageMonths >= 72 && ageMonths < 84) notes.push("Age 6 to under 7 years falls between the printed 1-6 year and over-7 year groups, so the 1-6 year group is used until 7 years.");
  return {
    ok: true,
    data: {
      inputs_used: { age_months: rnd(ageMonths, 1), weight_kg: weightKg },
      age_group: stage.label,
      feeds: out,
      maintenance_fluid_ml_per_day: { min: Math.round(fluid.min), max: Math.round(fluid.max) },
      notes,
      sources: [SOURCES.aspen_handbook],
    },
  };
}

// ─── Plan ───────────────────────────────────────────────────────────────────

/**
 * One call: energy, protein, fluid (and, when the inputs are there, catch-up and enteral feeds).
 * body: everything the energy route takes, plus clinical_status, ideal_weight_kg?, feeding_route?, formula_kcal_per_ml?
 */
export function computePaediatricPlan(b) {
  const energy = computePaediatricEnergy(b);
  if (!energy.ok) return energy;
  const e = energy.data;
  const kcal = e.recommended?.kcal;
  const protein = computePaediatricProtein({ ...b, energy_kcal: kcal });
  if (!protein.ok) return protein;
  const fluid = computePaediatricFluid(b);
  if (!fluid.ok) return fluid;

  const data = {
    inputs_used: e.inputs_used,
    energy: { recommended: e.recommended, dri_fao_2004: e.dri_fao_2004, iom_eer: e.iom_eer, bmr_estimates: e.bmr_estimates },
    protein: protein.data.recommended,
    protein_detail: { healthy_child: protein.data.healthy_child, sick_child: protein.data.sick_child, protein_vs_energy: protein.data.protein_vs_energy },
    fluid: { daily_ml: fluid.data.daily_ml, ml_per_kg_day: fluid.data.ml_per_kg_day, ml_per_hour: fluid.data.ml_per_hour, formula: fluid.data.formula },
    macronutrient_distribution: e.macronutrient_distribution,
    warnings: e.warnings,
    notes: [...e.notes],
    sources: [...new Set([...e.sources, ...protein.data.sources, ...fluid.data.sources])],
  };

  if (b.ideal_weight_kg != null && b.ideal_weight_kg !== "") {
    const cu = computeCatchUp(b);
    if (cu.ok) data.catch_up = { ideal_weight_kg: cu.data.ideal_weight_kg, percent_of_ideal_weight: cu.data.percent_of_ideal_weight, energy: cu.data.energy, protein: cu.data.protein, warnings: cu.data.warnings };
    else data.notes.push(`Catch-up not calculated: ${cu.error}`);
  }
  if (b.feeding_route != null && b.feeding_route !== "") {
    const ef = computeEnteralFeeds({ ...b, route: b.feeding_route, energy_target_kcal: kcal });
    if (ef.ok) data.enteral_feeds = { age_group: ef.data.age_group, feeds: ef.data.feeds };
    else data.notes.push(`Enteral feeds not calculated: ${ef.error}`);
  }
  data.disclaimer = "Planning estimates for a dietitian or doctor to review. A sick child's targets change with the clinical course.";
  return { ok: true, data };
}

// ─── Reference catalogue ────────────────────────────────────────────────────

export function paediatricReferenceCatalog(section) {
  const sections = {
    fluid: {
      source: SOURCES.holliday_segar,
      table: [
        { body_weight: "0-10 kg", maintenance: "100-150 mL/kg/day" },
        { body_weight: "11-20 kg", maintenance: "1000 mL + 50 mL for each kg above 10 kg" },
        { body_weight: "Above 20 kg", maintenance: "1500 mL + 20 mL for each kg above 20 kg" },
      ],
    },
    energy_equations: {
      schofield_1985: { source: SOURCES.schofield, unit: "kcal/day = w x kg + h x cm + c", bands: SCHOFIELD.map((b) => ({ years: `${b.from}-${Math.min(b.to, 18)}`, male: b.male, female: b.female })) },
      who_1985: { source: SOURCES.who_1985, unit: "kcal/day = w x kg + c", bands: WHO_1985.map((b) => ({ years: `${b.from}-${Math.min(b.to, 18)}`, male: b.male, female: b.female })) },
      iom_eer: { source: SOURCES.iom_eer, note: "Calculated by the energy engine (POST /energy/requirements). 0-35 months: (89 x kg - 100) + 175, 56, 22 or 20 kcal by age. 3-18 years: sex-specific equations with a PA coefficient. PA: boys 1.0/1.13/1.26/1.42, girls 1.0/1.16/1.31/1.56 (sedentary, low active, active, very active)." },
    },
    activity_factors: ACTIVITY_FACTORS,
    stress_factors: STRESS_FACTORS,
    dri_fao_2004_tee: {
      source: SOURCES.dri_fao_2004,
      unit: "kcal/kg/day",
      months_0_12: TEE_MONTHS.map(([g, bo], m) => ({ age: `${m}-${m + 1} months`, girls: g, boys: bo })),
      years_1_18: Object.entries(TEE_YEARS).map(([y, [g, bo]]) => ({ age: `${y}-${Number(y) + 1} years`, girls: g, boys: bo })),
    },
    macronutrient_distribution: { source: SOURCES.iom_amdr, unit: "% of energy", ranges: AMDR.map((a) => ({ age: a.label, carbohydrate: a.carbohydrate, fat: a.fat, protein: a.protein })) },
    protein: {
      healthy_growth: { source: SOURCES.iom_protein, unit: "g/kg/day", table: PROTEIN_RDA.map((p) => ({ age: p.label, value: p.g_per_kg, type: p.type })) },
      sick_child: { source: SOURCES.aspen_protein, unit: "g/kg/day", table: PROTEIN_SICK.map((p) => ({ age: p.label, min: p.min, max: p.max })) },
    },
    preterm: {
      source: SOURCES.preterm,
      fluid_ml_per_kg_day: PRETERM.fluid_ml_per_kg_day,
      energy_kcal_per_kg_day: PRETERM.energy_kcal_per_kg_day,
      protein_g_per_kg_day: PRETERM.protein_bands.map((p) => ({ weight: p.label, min: p.min, max: p.max })),
      monitoring: PRETERM.monitoring,
      note: "Weight-band boundaries: an exact boundary belongs to the lower band, except 1000 g, which belongs to 1000-1500 g.",
    },
    growth_velocity: {
      source: SOURCES.aspen_handbook,
      infants_0_24_months: VELOCITY_INFANT.map((r) => ({ months: `${r.from}-${r.to}`, girls: r.girls, boys: r.boys })),
      children_2_to_under_11_years: VELOCITY_CHILD.map((r) => ({ years: `${r.from}-<${r.to}`, weight_g_per_day: r.w, height_mm_per_day: r.h })),
      units: "weight g/day, length or height mm/day",
      known_issue: "Girls 3-6 months weight is printed as '21-21' in the data supplied, which is not a usable range, so no reference is held for it.",
    },
    enteral_feeds: { source: SOURCES.aspen_handbook, groups: ENTERAL },
    sources: SOURCES,
  };
  if (section == null || section === "") return { ok: true, data: { sections: Object.keys(sections), ...sections } };
  if (!sections[section]) return fail(`Unknown section '${section}'. Valid: ${Object.keys(sections).join(", ")}`);
  return { ok: true, data: { section, [section]: sections[section] } };
}
