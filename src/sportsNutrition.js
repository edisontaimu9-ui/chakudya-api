// Sports nutrition calculators (POST /sports/energy, /sports/macros, /sports/fuel-timing, /sports/hydration,
// /sports/body-composition, /sports/supplement-dose, /sports/plan and GET /sports/reference).
// Pure functions, no I/O. Every number comes from one source: Krause and Mahan's Food and the Nutrition Care Process,
// 16th ed., chapter 23 "Nutrition in Exercise and Sports Performance" (Dorfman). Where the chapter gives a range, the
// result gives the range. Where the chapter contradicts itself or prints an arithmetic slip, the result says so
// (see KNOWN_ISSUES) instead of quietly picking one.
//
// Reuse, not duplication
//   - Mifflin-St Jeor and sex parsing come from energyEngine.js (used here only as a cross-check).
//   - Grams to kcal and percent of energy come from foodEnergy.js (Atwater 4/9/4).
//   - The AMDR percentages come from dri_data.js (the same table behind GET /dri).
//   - Named-exercise energy (Appendix 10) stays in activityEnergy.js; the route passes its result in as { activityLog }.
//   - Healthy-person and clinical energy estimates stay in POST /energy/requirements. This module is the athlete method
//     of chapter 23 and does not change that engine.
//
// Combining rule: Box 23.2 adds the thermic effect of food (10% of REE + activity) as its own step. The chapter 2
// engine treats TEF as already inside its activity multipliers. The two methods are therefore not interchangeable and
// the output of this module is labelled as the chapter 23 method.

import { normalizeSexMF, mifflinStJeor } from "./energyEngine.js";
import { computeFoodEnergy, KCAL_PER_GRAM } from "./foodEnergy.js";
import { DRI_AMDR_BY_AGE_BUCKET, amdrBucketForAge } from "./dri_data.js";

export const SOURCE = "Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 23 (Nutrition in Exercise and Sports Performance)";

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const present = (v) => v !== undefined && v !== null && v !== "";
const num = (v) => (present(v) ? Number(v) : NaN);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const range = (min, max, d = 0) => ({ min: round(min, d), max: round(max, d) });
const KG_PER_LB = 0.45359237;
const ML_PER_OZ = 29.5735;

/** Read an optional/required number with bounds. Returns { value } | { error } (value null when absent and optional). */
function readNum(inp, key, { min, max, required = false, label } = {}) {
  if (!present(inp[key])) return required ? { error: `'${key}' is required${label ? ` (${label})` : ""}` } : { value: null };
  const v = num(inp[key]);
  if (!isNum(v)) return { error: `'${key}' must be a number` };
  if ((min !== undefined && v < min) || (max !== undefined && v > max)) return { error: `'${key}' must be between ${min} and ${max}${label ? ` (${label})` : ""}` };
  return { value: v };
}
/** Run several readNum calls, return the first error or the values. */
function readAll(inp, specs) {
  const out = {};
  for (const [key, opts] of Object.entries(specs)) {
    const r = readNum(inp, key, opts);
    if (r.error) return { error: r.error };
    out[key] = r.value;
  }
  return { values: out };
}

// ─── Reference tables (transcribed from the chapter) ────────────────────────────────

/** Box 23.2, activity factors applied to REE. */
export const ACTIVITY_LEVELS = [
  { id: "sedentary", label: "Sedentary", factor: 1.2, description: "little or no exercise" },
  { id: "lightly_active", label: "Lightly active", factor: 1.375, description: "about 30 min of moderate training, 1-3 days/week" },
  { id: "moderately_active", label: "Moderately active", factor: 1.55, description: "45 min of moderate training, 3-5 days/week" },
  { id: "very_active", label: "Very active", factor: 1.725, description: "training for 1 h, 6-7 days/week" },
  { id: "extra_active", label: "Extra active", factor: 1.9, description: "very hard training, including weight lifting, 2-3 days/week" },
];
const LEVEL_BY_ID = new Map(ACTIVITY_LEVELS.map((l) => [l.id, l]));

/** Chapter text, "Energy": kcal/kg/day by training load. */
export const KCAL_PER_KG_TIERS = [
  { id: "general_fitness", label: "Overall fitness program (30-40 min/day, 3 times/week)", min: 25, max: 35, note: "roughly 1800-2400 kcal/day" },
  { id: "training_90_min", label: "Training about 90 min/day", min: 45, max: 50, note: "and in certain sports even more" },
  { id: "intense_training", label: "2-3 h/day 5-6 times/week, or 3-6 h in 1-2 workouts/day 5-6 days/week", min: 50, max: 80, note: "example in the chapter: 50 kg athlete, 2500-4000 kcal/day" },
  { id: "elite_large", label: "Elite athletes or athletes with larger bodies", min: 150, max: 200, note: "printed as 7500-10,000 kcal/day, which only matches a body of about 50 kg (see known issues)", as_printed: true },
];

/** Macronutrient targets by training profile. Carbohydrate and protein g/kg are the chapter's; fat is printed once (0.5-1.5 g/kg, 25-35%). */
export const MACRO_PROFILES = {
  general_fitness: { label: "General fitness, moderate activity", carbohydrate: [3, 5], protein: [0.8, 1.0], fat: [0.5, 1.5], printed_percent: { carbohydrate: [45, 55], protein: [10, 15], fat: [25, 35] }, source: "Macronutrients section (45-55% / 10-15% / 25-35% of energy)" },
  general_training: { label: "Competitive athlete, general training needs", carbohydrate: [5, 7], protein: [1.2, 2.0], fat: [0.5, 1.5], source: "Carbohydrate Recommendations (5-7 g/kg/day); Protein (1.2-2 g/kg/day)" },
  endurance: { label: "Endurance athlete", carbohydrate: [7, 10], protein: [1.2, 2.0], fat: [0.5, 1.5], source: "Carbohydrate Recommendations (7-10 g/kg/day for endurance athletes)" },
  elite_endurance: { label: "Elite athlete training 5-6 h/day", carbohydrate: [7, 12], protein: [1.2, 2.0], fat: [0.5, 1.5], source: "Carbohydrate Recommendations (as much as 12 g/kg/day; 420-720 g for a 60 kg athlete)" },
  resistance_hypertrophy: { label: "Resistance training for muscle hypertrophy", carbohydrate: [5, 7], protein: [1.2, 2.0], fat: [0.5, 1.5], source: "Protein for Muscle Hypertrophy (1.2-2 g/kg/day); carbohydrate as for general training" },
};

/** Table 23.1 */
export const BODY_FAT_STANDARDS = {
  lowest_adult: { male: 5, female: 12 },
  lowest_adolescent: { male: 7, female: 14 },
  healthy_range: { male: [10, 22], female: [20, 32] },
};

/** Box 23.4, pre-event meal energy by time before competition. */
export const PRE_EVENT_MEAL_TIERS = [
  { hours_min: 0, hours_max: 1, kcal: [100, 150], examples: ["fresh fruit such as a banana or orange slices", "half of a sports or breakfast bar", "1 slice of bread, 1/2 plain bagel or 1/2 English muffin", "8-12 oz of a sports drink"] },
  { hours_min: 2, hours_max: 3, kcal: [300, 400], examples: ["1/2 turkey or hummus sandwich on pita with 1/2 banana", "2 pancakes with light or sugar-free syrup and berries", "1 low-sugar smoothie with berries, banana and 1 scoop (20 g or less) of protein", "1 clear broth soup, plain baked or sweet potato"] },
  { hours_min: 3, hours_max: 4, kcal: [600, 700], examples: ["scrambled eggs/egg whites with 2 waffles or toast and a banana", "1-6 in turkey sub with lettuce, tomato and small bag of baked chips", "1-2 cups pasta, 2-3 oz chicken breast, 1 small roll", "1 20-oz sport shake with protein scoop, 1 sports bar, 1 banana, water"] },
];

/** Table 23.3, sweat electrolyte losses against sports drink content (mg/L). */
export const SWEAT_ELECTROLYTES = [
  { electrolyte: "Sodium", sweat_loss: "900-2600", standard_sport_drink: "230-1700", endurance_sport_drink: "800-1110" },
  { electrolyte: "Potassium", sweat_loss: "150", standard_sport_drink: "80-125", endurance_sport_drink: "390-650" },
  { electrolyte: "Magnesium", sweat_loss: "8.3-14.2", standard_sport_drink: "0", endurance_sport_drink: "10-815" },
  { electrolyte: "Chloride", sweat_loss: "900-1900", standard_sport_drink: "0", endurance_sport_drink: "390-1550" },
  { electrolyte: "Calcium", sweat_loss: "28", standard_sport_drink: "0-100", endurance_sport_drink: "24-275" },
  { electrolyte: "Iron", sweat_loss: "0.1-0.4", standard_sport_drink: "0", endurance_sport_drink: "0" },
  { electrolyte: "Phosphorus", sweat_loss: "40", standard_sport_drink: "0", endurance_sport_drink: "0" },
  { electrolyte: "Zinc", sweat_loss: "0.36-0.48", standard_sport_drink: "0", endurance_sport_drink: "0-5" },
];

/** Things in the chapter that disagree with themselves or with the book's other chapters. Shown in /sports/reference. */
export const KNOWN_ISSUES = [
  { id: "case_study_activity_arithmetic", where: "Clinical case study", issue: "REE 2128 x activity factor 1.73 is printed as 4581 kcal. The product is 3681 kcal. The 4581 figure is carried into the case study's diagnosis (4141 with sport fuel vs 4581 required).", handling: "This API uses the arithmetic. The other three case study totals (2553, 2979, 3404) check out." },
  { id: "tef_double_count", where: "Box 23.2", issue: "The activity-factor total is followed by a separate 10% thermic effect of food. The chapter 2 energy engine (POST /energy/requirements) treats TEF as already inside its activity multipliers.", handling: "POST /sports/energy follows Box 23.2 and labels the TEF step. Do not add its TEF to a /energy/requirements result." },
  { id: "met_constant", where: "Box 23.2 METs example", issue: "The chapter uses 0.0175 kcal/kg/min per MET (4.5 METs x 80 kg x 30 min = 189 kcal). The chapter 2 engine uses 1 kcal/kg/h per MET (180 kcal for the same case), a 5% difference.", handling: "POST /sports/energy uses the chapter 23 constant for METs entries." },
  { id: "elite_kcal_per_kg", where: "Energy", issue: "150-200 kcal/kg/day is printed against 7500-10,000 kcal/day, which only fits a body of about 50 kg. Larger elite athletes would need an implausible per-kg figure.", handling: "Returned as printed, tagged as_printed, with a warning when it is the matching tier." },
  { id: "drink_volume_cap", where: "Box 23.5", issue: "During exercise: 150-350 mL (6-12 oz) every 15-20 min, but no more than 1 cup (8-10 oz) every 15-20 min. 350 mL is more than a cup.", handling: "Both are returned. The planned total uses the 1 cup (240 mL) cap for its upper figure." },
  { id: "urine_specific_gravity_bands", where: "Fluid Balance", issue: "Hydrated is said to be 1.002-1.030, but above 1.010 can indicate mild dehydration. The two overlap.", handling: "Bands used: up to 1.010 hydrated, 1.011-1.030 possible mild dehydration, above 1.030 beyond the range given for a hydrated athlete." },
  { id: "recovery_carbohydrate_rate", where: "Postworkout and Recovery Fuel", issue: "1.2 g/kg/h gives a 150% greater glycogen response than lower amounts, yet 1.6 g/kg/h is called the optimal amount.", handling: "1.2 g/kg/h is returned as the working rate and 1.6 g/kg/h as the upper figure." },
  { id: "not_in_chapter", where: "Scope", issue: "The De Lorenzo equation is named but its coefficients are not printed. Energy availability (EA) and RED-S thresholds are described but no formula or cut-off is given.", handling: "Not implemented. Harris-Benedict is mentioned here but is deliberately not offered by this API (chapter 2)." },
];

const NOT_ADVICE = "Reference calculation from a textbook chapter. Individual needs vary with sport, training phase, body size, climate and health. A sports dietitian's judgement applies.";

// ─── Energy ─────────────────────────────────────────────────────────────────────────

/**
 * input: weight_kg, lean_body_mass_kg | body_fat_percent, activity_level | activity_multiplier,
 *   exercise? [{ mets, minutes, label? }], tef? (default true), sex?, age_years?, height_cm? (Mifflin cross-check)
 * ctx.activityLog: the data of computeActivityEnergy (Appendix 10), looked up by the route.
 */
export function computeSportsEnergy(input, ctx = {}) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, {
    weight_kg: { min: 30, max: 250, required: true, label: "kilograms" },
    lean_body_mass_kg: { min: 20, max: 200 },
    body_fat_percent: { min: 2, max: 60 },
    activity_multiplier: { min: 1, max: 2.5 },
    age_years: { min: 0, max: 120 },
    height_cm: { min: 100, max: 260 },
  });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const weightKg = v.weight_kg;
  const warnings = []; const notes = [];

  if (v.lean_body_mass_kg !== null && v.body_fat_percent !== null) return { ok: false, error: "give lean_body_mass_kg or body_fat_percent, not both" };
  if (v.lean_body_mass_kg === null && v.body_fat_percent === null) return { ok: false, error: "the Cunningham equation needs lean body mass: give lean_body_mass_kg, or body_fat_percent with weight_kg" };
  let lbm; let fatKg = null;
  if (v.lean_body_mass_kg !== null) {
    lbm = v.lean_body_mass_kg;
    if (lbm > weightKg) return { ok: false, error: "lean_body_mass_kg cannot be more than weight_kg" };
    fatKg = weightKg - lbm;
  } else {
    fatKg = weightKg * v.body_fat_percent / 100;
    lbm = weightKg - fatKg;
  }
  const sex = present(inp.sex) ? normalizeSexMF(inp.sex) : null;
  if (present(inp.sex) && !sex) return { ok: false, error: "'sex' must be male or female" };
  const fatPct = (fatKg / weightKg) * 100;
  if (sex) {
    const floor = BODY_FAT_STANDARDS.lowest_adult[sex];
    if (fatPct < floor) warnings.push(`Body fat ${round(fatPct, 1)}% is below the lowest reference value for adult ${sex === "male" ? "males" : "females"} (${floor}%, Table 23.1). Check the figures.`);
  }
  if (v.age_years !== null && v.age_years < 18) warnings.push("The Cunningham equation is recommended in the chapter for active adults. For adolescents use POST /energy/requirements (IOM equations).");

  const ree = 500 + 22 * lbm;
  const steps = [`Lean body mass ${round(lbm, 2)} kg${v.body_fat_percent !== null ? ` (${weightKg} kg - ${round(fatKg, 2)} kg fat at ${v.body_fat_percent}%)` : ""}`, `REE = 500 + 22 x ${round(lbm, 2)} = ${round(ree, 1)} kcal`];

  // activity
  let level = null; let multiplier = null; let multiplierLabel = null;
  if (present(inp.activity_level) && v.activity_multiplier !== null) return { ok: false, error: "give activity_level or activity_multiplier, not both" };
  if (present(inp.activity_level)) {
    const id = String(inp.activity_level).trim().toLowerCase().replace(/[\s-]+/g, "_");
    level = LEVEL_BY_ID.get(id);
    if (!level) return { ok: false, error: `unknown activity_level '${String(inp.activity_level).slice(0, 40)}'. Use ${ACTIVITY_LEVELS.map((l) => l.id).join(", ")}` };
    multiplier = level.factor; multiplierLabel = `${level.label}, Box 23.2`;
  } else if (v.activity_multiplier !== null) {
    multiplier = v.activity_multiplier; multiplierLabel = "supplied by the caller";
    if (!ACTIVITY_LEVELS.some((l) => l.factor === multiplier)) notes.push("The activity multiplier is not one of the five in Box 23.2 (1.2, 1.375, 1.55, 1.725, 1.9). The chapter's own case study uses 1.4, 1.6 and 1.73.");
  }

  // exercise entries
  const exercise = [];
  if (present(inp.exercise)) {
    if (!Array.isArray(inp.exercise) || !inp.exercise.length) return { ok: false, error: "exercise must be a non-empty array of { mets, minutes, label? }" };
    if (inp.exercise.length > 20) return { ok: false, error: "at most 20 exercise entries" };
    for (const [i, e] of inp.exercise.entries()) {
      if (!isObj(e)) return { ok: false, error: `exercise[${i}] must be an object` };
      const mets = num(e.mets); const minutes = num(e.minutes);
      if (!isNum(mets) || mets < 1 || mets > 25) return { ok: false, error: `exercise[${i}].mets must be between 1 and 25` };
      if (!isNum(minutes) || minutes <= 0 || minutes > 1440) return { ok: false, error: `exercise[${i}].minutes must be above 0 and at most 1440` };
      const kcalPerMin = 0.0175 * weightKg * mets;
      exercise.push({ label: e.label ? String(e.label).slice(0, 60) : `${mets} METs`, mets, minutes, kcal_per_minute: round(kcalPerMin, 2), kcal: round(kcalPerMin * minutes, 1), kcal_unrounded: kcalPerMin * minutes });
    }
  }
  const log = ctx.activityLog && isObj(ctx.activityLog) ? ctx.activityLog : null;
  if (multiplier === null && !exercise.length && !log) return { ok: false, error: "give activity_level, activity_multiplier, exercise [{mets, minutes}] or activity_log" };

  const base = multiplier !== null ? ree * multiplier : ree;
  if (multiplier !== null) steps.push(`REE x activity factor ${multiplier} (${multiplierLabel}) = ${round(base)} kcal`);
  else steps.push("No activity factor: daily non-exercise movement is not counted. Add activity_level sedentary for it.");
  const exerciseMets = exercise.reduce((s, e) => s + e.kcal_unrounded, 0);
  const exerciseLog = log ? Number(log.total?.kcal) || 0 : 0;
  const exerciseKcal = exerciseMets + exerciseLog;
  if (exercise.length) steps.push(`Exercise by METs: 0.0175 x ${weightKg} kg x METs x minutes = ${round(exerciseMets)} kcal`);
  if (log) steps.push(`Exercise from the activity table (Appendix 10): ${exerciseLog} kcal`);
  if (multiplier !== null && level && ["very_active", "extra_active"].includes(level.id) && exerciseKcal > 0) warnings.push("The chosen activity level already includes training. Listing exercise as well counts it twice. Use sedentary or lightly_active for daily life when you list exercise separately.");
  if (multiplier !== null && multiplier >= 1.55 && exerciseKcal > 0 && !level) warnings.push("A high activity multiplier already includes training. Listing exercise as well may count it twice.");
  if (log) warnings.push("Appendix 10 does not say whether resting energy is included in its kcal per hour. If it is, adding it to REE counts the resting part of that hour twice.");

  const subtotal = base + exerciseKcal;
  const tefOn = inp.tef !== false && inp.tef !== "false";
  const tef = tefOn ? subtotal * 0.1 : 0;
  const total = subtotal + tef;
  if (tefOn) steps.push(`Thermic effect of food = 10% x ${round(subtotal)} = ${round(tef)} kcal (separate step in Box 23.2)`);
  steps.push(`Total daily energy requirement = ${round(total)} kcal`);
  notes.push("Box 23.2 adds TEF as its own step. POST /energy/requirements does not, because its multipliers already include it. Do not mix the two methods.");
  notes.push("The chapter rounds intermediate values (for example REE 2075 x 1.9 = 3942), so a hand calculation can differ from this result by 1 kcal.");

  // kcal per kg cross-check
  const perKg = total / weightKg;
  const tiers = KCAL_PER_KG_TIERS.map((t) => ({ id: t.id, label: t.label, min: t.min, max: t.max, within: perKg >= t.min && perKg <= t.max, ...(t.as_printed ? { as_printed: true } : {}) }));
  if (perKg > 80 && !tiers.some((t) => t.within)) warnings.push(`${round(perKg, 1)} kcal/kg/day is above the 50-80 kcal/kg range the chapter gives for intense training. Check the activity inputs.`);
  if (tiers.find((t) => t.id === "elite_large")?.within) warnings.push("This falls in the elite tier printed as 150-200 kcal/kg, which only matches a body of about 50 kg. See known issues.");

  // Mifflin cross-check (existing engine)
  let mifflin = null;
  if (sex && v.age_years !== null && v.age_years >= 18 && v.height_cm !== null) {
    const m = mifflinStJeor({ sex, weightKg, heightCm: v.height_cm, ageYears: v.age_years });
    mifflin = { ree_kcal: round(m, 1), difference_kcal: round(ree - m, 1), difference_percent: round(((ree - m) / m) * 100, 1), note: "Cross-check only. Cunningham uses lean body mass and is the chapter's best predictor for active adults; Mifflin-St Jeor is what POST /energy/requirements uses." };
    if (Math.abs(ree - m) / m > 0.15) warnings.push("Cunningham and Mifflin-St Jeor differ by more than 15%. Check the body fat or lean mass figure.");
  }

  return {
    ok: true,
    data: {
      method: "Cunningham REE with Box 23.2 activity factor and thermic effect of food (chapter 23)",
      inputs_used: { weight_kg: weightKg, lean_body_mass_kg: round(lbm, 2), fat_mass_kg: round(fatKg, 2), body_fat_percent: round(fatPct, 1), activity_level: level?.id ?? null, activity_multiplier: multiplier, tef_included: tefOn },
      ree_kcal: round(ree, 1),
      activity: { multiplier, label: multiplierLabel, base_kcal: round(base), exercise: exercise.map(({ kcal_unrounded, ...rest }) => rest), exercise_from_activity_log_kcal: log ? exerciseLog : null, exercise_total_kcal: round(exerciseKcal) },
      tef_kcal: round(tef),
      total_kcal: round(total),
      total_kj: round(total * 4.184),
      kcal_per_kg: round(perKg, 1),
      kcal_per_kg_tiers: tiers,
      mifflin_cross_check: mifflin,
      steps, warnings, notes,
      sources: [SOURCE + " - Energy, Estimation of Energy Requirements, Boxes 23.1 and 23.2"],
      disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Macronutrients ─────────────────────────────────────────────────────────────────

const statusOf = (value, [lo, hi]) => (value < lo ? "below" : value > hi ? "above" : "within");

/**
 * input: weight_kg, profile (general_fitness | general_training | endurance | elite_endurance | resistance_hypertrophy),
 *   energy_kcal? (for percent of energy and the fat remainder), age_years? (AMDR bucket),
 *   intake? { carbohydrate_g, protein_g, fat_g } (daily, to compare with the ranges)
 */
export function computeSportsMacros(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, { weight_kg: { min: 30, max: 250, required: true, label: "kilograms" }, energy_kcal: { min: 800, max: 15000 }, age_years: { min: 1, max: 120 } });
  if (r.error) return { ok: false, error: r.error };
  const { weight_kg: kg, energy_kcal: energy, age_years: age } = r.values;
  const profileId = String(inp.profile ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const profile = MACRO_PROFILES[profileId];
  if (!profile) return { ok: false, error: `'profile' is required. Use ${Object.keys(MACRO_PROFILES).join(", ")}` };
  const warnings = []; const notes = [];

  const macros = {};
  for (const m of ["carbohydrate", "protein", "fat"]) {
    const [lo, hi] = profile[m];
    macros[m] = { g_per_kg: { min: lo, max: hi }, grams: range(lo * kg, hi * kg), midpoint_grams: round(((lo + hi) / 2) * kg), kcal: range(lo * kg * KCAL_PER_GRAM[m], hi * kg * KCAL_PER_GRAM[m]) };
    if (profile.printed_percent) macros[m].printed_percent_of_energy = { min: profile.printed_percent[m][0], max: profile.printed_percent[m][1] };
  }
  notes.push("Midpoints are the middle of a printed range, a starting point and not a recommendation. Carbohydrate is meant to be adjusted to training load, with more on heavy days (nutrition periodization).");
  if (profileId !== "general_fitness") notes.push("The chapter prints fat as 0.5-1.5 g/kg (25-35% of energy) for general fitness only. It is applied here as the guide for athletes too.");
  if (profileId === "elite_endurance") notes.push("The chapter prints this as 420-720 g of carbohydrate a day for a 60 kg athlete (7-12 g/kg).");

  const protein = { per_meal_g: round(0.3 * kg), per_meal_rule: "0.3 g/kg every 3-5 hours spreads protein through the day", minimum_per_meal_g: 30, minimum_per_meal_note: "at least 30 g of high-quality protein per meal, with about 2.5 g leucine, optimally stimulates synthesis for hypertrophy", after_resistance_exercise_g: range(20, 25), note: "20-25 g of high-quality protein after resistance exercise maximizes muscle protein synthesis. 40 g gave no extra response in young resistance-trained males." };
  if (profileId === "resistance_hypertrophy") { protein.before_sleep_g = range(27.5, 40, 1); protein.before_sleep_note = "studies used 27.5-40 g of casein before sleep"; }

  let energyCheck = null; let amdr = null;
  const bucket = amdrBucketForAge(age ?? null);
  const amdrRanges = DRI_AMDR_BY_AGE_BUCKET[bucket];
  if (energy !== null) {
    const carbMid = macros.carbohydrate.midpoint_grams; const protMid = macros.protein.midpoint_grams;
    const used = carbMid * KCAL_PER_GRAM.carbohydrate + protMid * KCAL_PER_GRAM.protein;
    if (used > energy) warnings.push(`The carbohydrate and protein midpoints alone (${round(used)} kcal) exceed the energy given (${energy} kcal). Lower the targets or recheck the energy.`);
    const fatG = Math.max(0, (energy - used) / KCAL_PER_GRAM.fat);
    const fatPerKg = fatG / kg;
    const pct = (g, k) => round(((g * KCAL_PER_GRAM[k]) / energy) * 100, 1);
    const split = { carbohydrate: { grams: carbMid, percent_of_energy: pct(carbMid, "carbohydrate") }, protein: { grams: protMid, percent_of_energy: pct(protMid, "protein") }, fat: { grams: round(fatG), g_per_kg: round(fatPerKg, 2), percent_of_energy: pct(fatG, "fat"), status_vs_range: statusOf(fatPerKg, profile.fat) } };
    energyCheck = { energy_kcal: energy, at_midpoints: split, note: "Fat is what is left of the energy after the carbohydrate and protein midpoints." };
    if (split.fat.status_vs_range === "above") warnings.push(`Left-over energy would put fat at ${round(fatPerKg, 2)} g/kg, above the 0.5-1.5 g/kg guide. Raise carbohydrate or protein, or recheck the energy.`);
    if (split.fat.status_vs_range === "below") warnings.push(`Left-over energy would put fat at ${round(fatPerKg, 2)} g/kg, below the 0.5-1.5 g/kg guide. The carbohydrate and protein midpoints take most of the energy.`);
    amdr = { age_bucket: bucket, ranges_percent_of_energy: amdrRanges, at_midpoints: {} };
    for (const k of ["carbohydrate", "protein", "fat"]) {
      const a = amdrRanges[k]; const p = split[k].percent_of_energy;
      amdr.at_midpoints[k] = { percent: p, status: statusOf(p, [a.min_percent, a.max_percent]) };
    }
    amdr.note = "The DRI AMDR (also behind GET /dri) is the healthy-population range. Athlete targets in g/kg can sit outside it, particularly carbohydrate above 65% on heavy training days.";
  }

  let intakeCheck = null;
  if (present(inp.intake)) {
    if (!isObj(inp.intake)) return { ok: false, error: "intake must be an object { carbohydrate_g, protein_g, fat_g }" };
    const food = computeFoodEnergy({ carbohydrate_g: inp.intake.carbohydrate_g, protein_g: inp.intake.protein_g, fat_g: inp.intake.fat_g });
    if (!food.ok) return { ok: false, error: `intake: ${food.error}` };
    const per = {};
    for (const m of ["carbohydrate", "protein", "fat"]) {
      const g = num(inp.intake[`${m}_g`]);
      if (!isNum(g)) continue;
      const gpk = g / kg;
      per[m] = { grams: g, g_per_kg: round(gpk, 2), target_g_per_kg: { min: profile[m][0], max: profile[m][1] }, status: statusOf(gpk, profile[m]), percent_of_energy: food.data.breakdown.find((b) => b.nutrient === m)?.percent_of_energy ?? null };
    }
    intakeCheck = { energy_kcal: food.data.total.kcal, nutrients: per };
    if (per.carbohydrate?.status === "below") warnings.push(`Carbohydrate intake of ${per.carbohydrate.g_per_kg} g/kg is below the ${profile.carbohydrate[0]} g/kg minimum for this profile.`);
  }

  return { ok: true, data: { profile: { id: profileId, label: profile.label, source: profile.source }, weight_kg: kg, macronutrients: macros, protein_distribution: protein, energy_check: energyCheck, amdr_check: amdr, intake_check: intakeCheck, warnings, notes, sources: [SOURCE + " - Macronutrients, Carbohydrate Recommendations, Protein"], disclaimer: NOT_ADVICE } };
}

// ─── Fuel timing ────────────────────────────────────────────────────────────────────

function drinkBand(pct) {
  if (pct < 4) return { band: "below_4", message: "Below the 4-8% range. Unlikely to help performance (under 5% is unlikely to be enough)." };
  if (pct < 5) return { band: "4_to_5", message: "Inside the 4-8% range but the chapter says under 5% is unlikely to be enough to help performance." };
  if (pct <= 8) return { band: "5_to_8", message: "Inside the 4-8% range the chapter recommends." };
  if (pct <= 10) return { band: "8_to_10", message: "Above 8%. Tolerated by many, but more likely to slow stomach emptying." };
  return { band: "above_10", message: "Above 10%. Often associated with abdominal cramps, nausea and diarrhea." };
}

/**
 * input: weight_kg, duration_min? (event or session), hours_before_event?, recovery_hours?,
 *   drink? { carbohydrate_g, serving_g | serving_ml } (concentration check; serving defaults to 240 g, 1 cup)
 */
export function computeFuelTiming(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, { weight_kg: { min: 30, max: 250, required: true, label: "kilograms" }, duration_min: { min: 1, max: 1440 }, hours_before_event: { min: 0.25, max: 24 }, recovery_hours: { min: 0.25, max: 24 } });
  if (r.error) return { ok: false, error: r.error };
  const { weight_kg: kg, duration_min: dur, hours_before_event: hb, recovery_hours: rh } = r.values;
  const warnings = []; const notes = [];

  // before
  let pre = null;
  if (hb !== null) {
    const perKg = Math.min(4, hb);
    const grams = perKg * kg;
    let tier = PRE_EVENT_MEAL_TIERS.find((t) => hb >= t.hours_min && hb <= t.hours_max) || null;
    if (hb === 3) { tier = PRE_EVENT_MEAL_TIERS[2]; notes.push("Exactly 3 hours sits on the boundary of the 2-3 hour tier (300-400 kcal) and the 3-4 hour tier (600-700 kcal). The larger one is shown."); }
    pre = {
      hours_before_event: hb,
      carbohydrate_g_per_kg: round(perKg, 2),
      carbohydrate_g: round(grams),
      rule: "4 g/kg of carbohydrate 4 hours before and 1 g/kg 1 hour before. Between those the chapter prints nothing, so 1 g/kg per hour is a straight-line reading of the two points. Never more than 4 g/kg.",
      fat: "Keep fat under 25% of the meal's kcal and the meal low in fiber and lactose: fat delays gastric emptying.",
      meal_energy_tier: tier ? { kcal: range(...tier.kcal), examples: tier.examples, source: "Box 23.4" } : null,
      eat_window: "The chapter puts the pre-event meal 3-4 hours before an event.",
    };
    if (dur !== null && dur > 90) pre.long_event_note = "For athletes exercising more than 90 minutes the pregame meal can supply up to 200-350 g of carbohydrate, within about 4 g/kg and personal tolerance.";
    if (hb > 4) warnings.push("Beyond 4 hours the chapter gives no further increase: 4 g/kg is the ceiling for the pre-event meal.");
    if (hb < 1) warnings.push("Under an hour before the event the chapter prints only 1 g/kg (at 1 hour). Go lower and stay with easily digested carbohydrate, or use a sports drink.");
    if (!tier && hb >= 1 && hb < 2) notes.push("Box 23.4 prints no meal-size tier between 1 and 2 hours before.");
    if (hb > 4) notes.push("Box 23.4 prints meal sizes only up to 4 hours before.");
  }

  // during
  let during = null;
  if (dur !== null) {
    if (dur <= 60) during = { applies: false, message: "Carbohydrate during exercise lasting under 60 minutes does not appear to be warranted. Mouth rinsing with a carbohydrate drink may reduce perceived effort in short, high-intensity work." };
    else {
      during = {
        applies: true,
        carbohydrate_g_per_30_min: range(25, 30),
        carbohydrate_g_per_hour: range(50, 60),
        carbohydrate_g_total: range((25 * dur) / 30, (30 * dur) / 30),
        drink_equivalent: "About 1 cup (240 mL) of a 4-8% carbohydrate solution every 15-20 minutes, which delivers about 1 g of carbohydrate a minute when fatigue sets in.",
        absorption_note: "Glucose and fructose use different transporters (SGLT1 and GLUT5), so a blend of both can be absorbed and oxidized at higher rates than one sugar alone.",
        source: "Training Fuel During Exercise",
      };
      if (dur > 90 && dur <= 240) during.note_long = "More than 90 minutes: carbohydrate during the event matters most.";
    }
  }

  // drink concentration
  let drink = null;
  if (present(inp.drink)) {
    if (!isObj(inp.drink)) return { ok: false, error: "drink must be an object { carbohydrate_g, serving_g | serving_ml }" };
    const c = num(inp.drink.carbohydrate_g);
    const hasG = present(inp.drink.serving_g); const hasMl = present(inp.drink.serving_ml);
    if (hasG && hasMl) return { ok: false, error: "drink: give serving_g or serving_ml, not both" };
    const servingG = hasG ? num(inp.drink.serving_g) : hasMl ? num(inp.drink.serving_ml) : 240;
    if (!isNum(c) || c < 0 || c > 200) return { ok: false, error: "drink.carbohydrate_g must be between 0 and 200" };
    if (!isNum(servingG) || servingG <= 0 || servingG > 2000) return { ok: false, error: "drink serving must be above 0 and at most 2000" };
    const pct = (c / servingG) * 100;
    drink = { carbohydrate_g: c, serving_g: servingG, serving_assumed_240g: !hasG && !hasMl, concentration_percent: round(pct, 1), ...drinkBand(pct), method: "grams of carbohydrate in a serving / weight of the serving (about 240 g for a cup of water) x 100. 6% = 14-16 g per 8 oz." };
    if (hasMl) drink.note = "Serving in mL is treated as grams, the way the chapter treats a cup of drink (about 240 g).";
  }

  // after
  const post = {
    carbohydrate_g_per_kg_per_hour: 1.2,
    carbohydrate_g_per_hour: round(1.2 * kg),
    upper_g_per_kg_per_hour: 1.6,
    upper_g_per_hour: round(1.6 * kg),
    protein_with_carbohydrate_g_per_100g_carbohydrate: range(5, 9),
    protein_after_resistance_exercise_g: range(20, 25),
    notes: ["Start as soon as the athlete can eat. Appetite is often low when body temperature is high, so liquids and easy carbohydrate-rich foods (fruit pops, bananas, oranges, melon, sports recovery shake) are practical.", "A high-glycemic-index carbohydrate gave higher muscle glycogen 24 hours after exercise than the same amount of a low-glycemic-index one.", "Adding 5-9 g of protein for every 100 g of carbohydrate may further raise glycogen resynthesis and supports muscle repair."],
    source: "Postworkout and Recovery Fuel",
  };
  if (rh !== null) {
    post.recovery_hours = rh;
    post.carbohydrate_g_total = round(1.2 * kg * rh);
    post.carbohydrate_g_total_upper = round(1.6 * kg * rh);
    post.protein_g_for_total = range((post.carbohydrate_g_total / 100) * 5, (post.carbohydrate_g_total / 100) * 9);
  }
  notes.push("Athletes should rehearse their fueling in training. Foods high in fiber, fat and lactose cause GI distress for some and are best avoided before competition.");
  if (dur === null && hb === null) notes.push("Give duration_min for during-exercise carbohydrate and hours_before_event for the pre-event meal.");

  return { ok: true, data: { weight_kg: kg, before: pre, during, drink_check: drink, after: post, warnings, notes, sources: [SOURCE + " - Food Timing, Training Fuel During Exercise, Postworkout and Recovery Fuel, Box 23.4"], disclaimer: NOT_ADVICE } };
}

// ─── Hydration ──────────────────────────────────────────────────────────────────────

function urineBand(sg) {
  if (sg < 1.002) return { band: "below_range", message: "Below 1.002, under the range the chapter gives for normally functioning kidneys." };
  if (sg <= 1.010) return { band: "hydrated", message: "Hydrated." };
  if (sg <= 1.030) return { band: "possible_mild_dehydration", message: "Inside 1.002-1.030, but above 1.010 can indicate mild dehydration. Read with body-mass change and urine color." };
  return { band: "above_range", message: "Above 1.030, beyond the range the chapter gives for a hydrated athlete. The higher the number, the more dehydrated." };
}

/**
 * input: weight_before_kg + weight_after_kg (a session), fluid_intake_ml?, urine_ml?, duration_min?,
 *   urine_specific_gravity?, age_years?, ambient_c?, hours_to_next_session?
 */
export function computeHydration(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, {
    weight_before_kg: { min: 20, max: 300 }, weight_after_kg: { min: 20, max: 300 },
    fluid_intake_ml: { min: 0, max: 20000 }, urine_ml: { min: 0, max: 5000 },
    duration_min: { min: 1, max: 1440 }, urine_specific_gravity: { min: 1.0, max: 1.05 },
    age_years: { min: 3, max: 120 }, ambient_c: { min: -40, max: 60 }, hours_to_next_session: { min: 0.25, max: 48 },
  });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const hasPair = v.weight_before_kg !== null || v.weight_after_kg !== null;
  if (hasPair && (v.weight_before_kg === null || v.weight_after_kg === null)) return { ok: false, error: "give both weight_before_kg and weight_after_kg" };
  if (!hasPair && v.urine_specific_gravity === null && v.duration_min === null) return { ok: false, error: "give weight_before_kg and weight_after_kg, urine_specific_gravity, or duration_min" };
  const warnings = []; const notes = [];
  const data = { warnings, notes };

  if (hasPair) {
    const lossKg = v.weight_before_kg - v.weight_after_kg;
    const pct = (lossKg / v.weight_before_kg) * 100;
    const level = pct >= 4 ? "3_to_4_percent_or_more" : pct >= 3 ? "3_to_4_percent" : pct >= 2 ? "2_percent_or_more" : pct > 0 ? "under_2_percent" : "no_loss";
    data.body_mass = { before_kg: v.weight_before_kg, after_kg: v.weight_after_kg, change_kg: round(-lossKg, 2), loss_kg: round(Math.max(0, lossKg), 2), loss_percent: round(pct, 2), level };
    if (pct >= 2) warnings.push(`Body mass loss of ${round(pct, 1)}%: a 2% loss can impair endurance performance, especially in hot, humid conditions. In team sports the effect is clearer from 3-4%, mostly when the dehydration came from heat stress.`);
    if (pct < 0) warnings.push("Body mass went up. Drinking more than was sweated out can lead to exercise-associated hyponatremia (symptoms from sodium below 130 mEq/L include lethargy, confusion and seizures). Do not push fluids beyond sweat losses.");
    if (lossKg > 0) {
      const lossMl = lossKg * 1000;
      data.rehydration = {
        volume_ml: range(lossMl * 1.25, lossMl * 1.5),
        rule: "Drink 25-50% more than the weight lost over the next 4-6 hours, so that fluid lost through sweat and urine is replaced.",
        per_pound_rule: { ml_per_lb: range(450, 675), ml_per_kg: range(450 / KG_PER_LB, 675 / KG_PER_LB), volume_ml: range((450 / KG_PER_LB) * lossKg, (675 / KG_PER_LB) * lossKg), note: "16-24 oz of fluid for every pound of body weight lost, as printed in Box 23.5." },
        sodium: "Include sodium in the fluid. Water alone dilutes the blood, stimulates urine output and removes much of the drive to drink.",
      };
      if (v.hours_to_next_session !== null) data.rehydration.before_next_session = { hours: v.hours_to_next_session, replace_at_least_percent: 80, volume_ml: round(lossMl * 0.8), note: "If there is another workout the same day, replace 80% of the fluid loss before it." };
    }
    if (v.fluid_intake_ml !== null || v.urine_ml !== null) {
      const intake = v.fluid_intake_ml ?? 0; const urine = v.urine_ml ?? 0;
      const sweatMl = lossKg * 1000 + intake - urine;
      data.sweat_estimate = { sweat_loss_ml: round(Math.max(0, sweatMl)), per_hour_ml: v.duration_min !== null ? round(Math.max(0, sweatMl) / (v.duration_min / 60)) : null, method: "mass balance: body-mass loss (1 kg taken as 1 L) + fluid drunk - urine passed", note: "This is a standard mass-balance estimate, not a formula printed in the chapter. It ignores respiratory water loss and metabolic water, so it is approximate." };
      if (sweatMl < 0) warnings.push("The mass-balance estimate is negative: check the weights, fluid and urine entered.");
    }
  }

  if (v.duration_min !== null) {
    const d = v.duration_min;
    data.during_exercise = {
      per_15_to_20_min_ml: range(150, 350),
      cap_per_15_to_20_min_ml: range(8 * ML_PER_OZ, 10 * ML_PER_OZ),
      planned_total_ml: d >= 15 ? range((150 * d) / 20, (240 * d) / 15) : null,
      note: "Box 23.5 says 150-350 mL every 15-20 minutes and also no more than 1 cup (8-10 oz) in that time, which conflicts at the top end. The upper planned figure uses the 1 cup (240 mL) cap. Fit the plan to the athlete's measured sweat loss and tolerance, and drink early and at regular intervals; thirst comes late.",
    };
    if (d > 60 && d >= 15) {
      const lowL = ((150 * d) / 20) / 1000; const highL = ((240 * d) / 15) / 1000;
      data.sodium = { grams_per_litre: range(0.5, 0.7, 1), planned_mg: range(500 * lowL, 700 * highL), note: "0.5-0.7 g of sodium per litre in activity longer than 1 hour to improve palatability, reduce the risk of hyponatremia and minimize muscle cramps. Sweat sodium is 900-2600 mg/L (Table 23.3)." };
    }
    data.before_exercise = { ml: range(400, 600), oz: range(14, 22), timing: "2-3 hours before the start of exercise, of water or a sports drink." };
  }

  if (v.urine_specific_gravity !== null) {
    data.urine_specific_gravity = { value: v.urine_specific_gravity, ...urineBand(v.urine_specific_gravity), note: "The best sample is the first urine of the morning, when it is most concentrated." };
  }

  if (v.age_years !== null) {
    const a = v.age_years;
    if (a <= 10) data.population = { group: "child_10_or_under", advice: "Drink until thirst is satisfied and then drink an additional 3-4 oz (about 90-120 mL, 1/3 to 1/2 cup) of fluid, at frequent intervals such as every 20 minutes. Children sweat less but reach higher core temperatures, and acclimate to heat more slowly.", additional_ml: range(3 * ML_PER_OZ, 4 * ML_PER_OZ) };
    else if (a < 18) data.population = { group: "older_child_adolescent", advice: "Same guidelines, with an additional cup (8 oz, about 240 mL) of fluid beyond satisfying thirst. A drink they like helps keep the drive to drink.", additional_ml: Math.round(8 * ML_PER_OZ) };
    else if (a > 40) data.population = { group: "master_athlete", advice: "The thirst drive is reduced, so drink adequately before exercise, well before becoming thirsty. Fluid losses are restored more slowly than in younger adults, and the first 5 days of heat acclimatization need particular care." };
  }
  if (v.ambient_c !== null && v.ambient_c >= 36) warnings.push(`At ${v.ambient_c} C (36 C / 96.8 F and above) the body relies on sweat evaporation alone to lose heat, so hydration becomes crucial. A body temperature rise of 3.5 C (6 F) is the threshold the chapter links to heat stroke.`);

  notes.push("Weigh in before and after practice and replace the difference. Do not restrict fluids before, during or after an event, and avoid alcohol, which acts as a diuretic.");
  notes.push("Daily fluid need (adequate intake 3.7 L men, 2.7 L women) is in the DRI table: GET /dri?nutrient=water_l.");
  data.sources = [SOURCE + " - Fluid, Fluid Balance, Box 23.5, Tables 23.3"];
  data.disclaimer = NOT_ADVICE;
  return { ok: true, data };
}

// ─── Body composition and weight goals ──────────────────────────────────────────────

/**
 * input: sex, weight_kg, body_fat_percent, age_years? (under 18 uses the adolescent floor), target_weight_kg?
 */
export function computeBodyComposition(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const sex = normalizeSexMF(inp.sex);
  if (!sex) return { ok: false, error: "'sex' is required: male or female" };
  const r = readAll(inp, { weight_kg: { min: 30, max: 250, required: true, label: "kilograms" }, body_fat_percent: { min: 2, max: 60, required: true }, age_years: { min: 5, max: 120 }, target_weight_kg: { min: 25, max: 250 } });
  if (r.error) return { ok: false, error: r.error };
  const { weight_kg: kg, body_fat_percent: bf, age_years: age, target_weight_kg: target } = r.values;
  const warnings = []; const notes = [];
  const adolescent = age !== null && age < 18;
  const floor = (adolescent ? BODY_FAT_STANDARDS.lowest_adolescent : BODY_FAT_STANDARDS.lowest_adult)[sex];
  const [healthyLo, healthyHi] = BODY_FAT_STANDARDS.healthy_range[sex];
  const fatKg = (kg * bf) / 100; const lbm = kg - fatKg;
  const weightAt = (pct) => lbm / (1 - pct / 100);
  const lowestSafe = weightAt(floor);

  let status;
  if (bf < floor) { status = "below_lowest_reference"; warnings.push(`Body fat ${bf}% is below the lowest reference value of ${floor}% (Table 23.1). Further weight loss is not advisable; consider screening for low energy availability or disordered eating.`); }
  else if (bf < healthyLo) status = "below_healthy_range";
  else if (bf <= healthyHi) status = "within_healthy_range";
  else status = "above_healthy_range";
  if (adolescent) notes.push("Adolescent floor used (7% males, 14% females). The chapter has no recommendation for body composition in children and adolescents, so sport performance and growth guide the goal.");
  if (age === null) notes.push("No age given, so the adult floor was used. Under 18 the floor is 7% (males) or 14% (females).");

  const data = {
    inputs_used: { sex, weight_kg: kg, body_fat_percent: bf, age_years: age },
    fat_mass_kg: round(fatKg, 2), lean_body_mass_kg: round(lbm, 2),
    reference: { lowest_body_fat_percent: floor, healthy_range_percent: { min: healthyLo, max: healthyHi }, source: "Table 23.1" },
    status,
    weights_kg: {
      lowest_safe: round(lowestSafe, 1),
      at_healthy_range_lower_end: round(weightAt(healthyLo), 1),
      highest_optimal: round(weightAt(healthyHi), 1),
      method: "lean body mass / (1 - body fat fraction), keeping lean mass constant. The lowest safe weight uses the low reference body fat (NATA, Turocy 2011); the highest optimal weight uses the top of the healthy range.",
    },
    warnings, notes,
  };

  const lossRate = range(1 * KG_PER_LB, 2 * KG_PER_LB, 2);
  const gainRate = sex === "male" ? { lean_kg_per_week: range(0.5 * KG_PER_LB, 1.0 * KG_PER_LB, 2), lean_lb_per_week: range(0.5, 1.0, 2) } : { lean_kg_per_week: range(0.25 * KG_PER_LB, 0.75 * KG_PER_LB, 2), lean_lb_per_week: range(0.25, 0.75, 2) };
  data.weekly_rates = {
    loss: { kg_per_week: lossRate, lb_per_week: range(1, 2), note: "A slow, steady loss of about 1-2 lb a week over several weeks, in the off-season or preseason when competition is not a priority." },
    gain: { ...gainRate, fat_gain_threshold_kg_per_week: round(2 * KG_PER_LB, 2), extra_energy_kcal_per_day: range(250, 500), note: "A gain above 2 lb (0.9 kg) a week may add body fat. Pair the extra energy with strength training." },
  };

  if (target !== null) {
    const diff = target - kg;
    const t = { target_weight_kg: target, change_kg: round(diff, 1), direction: diff < 0 ? "loss" : diff > 0 ? "gain" : "none" };
    if (diff < 0) {
      t.implied_body_fat_percent = target > lbm ? round(((target - lbm) / target) * 100, 1) : null;
      if (target < lowestSafe) {
        t.status = "below_lowest_safe_weight";
        t.weeks = null;
        warnings.push(`A target of ${target} kg is below the lowest safe weight of ${round(lowestSafe, 1)} kg for this lean body mass. No timeline is given.`);
      } else {
        t.status = "reachable";
        t.weeks = range(Math.abs(diff) / lossRate.max, Math.abs(diff) / lossRate.min, 0);
        t.assumption = "All of the loss is fat and lean body mass stays the same.";
      }
    } else if (diff > 0) {
      t.status = "gain";
      t.weeks = range(diff / gainRate.lean_kg_per_week.max, diff / gainRate.lean_kg_per_week.min, 0);
      t.assumption = "All of the gain is lean mass at the printed weekly rate, which is the best case.";
    }
    data.target_check = t;
  }

  data.sources = [SOURCE + " - Weight Management, Weight Loss, Weight Gain, Table 23.1"];
  data.disclaimer = NOT_ADVICE;
  return { ok: true, data };
}

// ─── Supplement doses (Table 23.4 and Popular Ergogenic Aids) ───────────────────────

export const SUPPLEMENT_IDS = ["caffeine", "creatine", "beta_alanine", "hmb", "beetroot_juice"];

/**
 * input: weight_kg, age_years, supplements? (ids, default all), pregnant?, lactating?
 * Doses are withheld under 18, in pregnancy and when nursing: the chapter gives no dose for them.
 */
export function computeSupplementDoses(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, { weight_kg: { min: 30, max: 250, required: true, label: "kilograms" }, age_years: { min: 0, max: 120, required: true, label: "doses are not given under 18" } });
  if (r.error) return { ok: false, error: r.error };
  const { weight_kg: kg, age_years: age } = r.values;
  let ids = SUPPLEMENT_IDS;
  if (present(inp.supplements)) {
    if (!Array.isArray(inp.supplements) || !inp.supplements.length) return { ok: false, error: "supplements must be a non-empty array" };
    ids = inp.supplements.map((s) => String(s).trim().toLowerCase().replace(/[\s-]+/g, "_"));
    const bad = ids.find((s) => !SUPPLEMENT_IDS.includes(s));
    if (bad) return { ok: false, error: `unknown supplement '${bad.slice(0, 40)}'. Use ${SUPPLEMENT_IDS.join(", ")}` };
  }
  const pregnant = inp.pregnant === true || inp.pregnant === "true";
  const lactating = inp.lactating === true || inp.lactating === "true";
  const warnings = []; const notes = [];
  const general = ["Supplements are not a substitute for a well-balanced diet.", "Check every product against the World Anti-Doping Agency prohibited list. Sports supplements are among the highest-risk products for adulteration with banned substances. Prefer products certified by NSF Certified for Sport or Informed Choice.", "The chapter gives doses studied in adults. Individual response varies, and a clinician or sports dietitian should review use alongside medicines and health conditions."];

  if (age < 18 || pregnant || lactating) {
    const why = age < 18 ? "under 18 years" : pregnant ? "pregnancy" : "breastfeeding";
    const extra = ids.includes("creatine") ? " Creatine in particular: the American Orthopedic Society for Sports Medicine, ACSM and the American Academy of Pediatrics advise against it for people under 18 and for pregnant or nursing women." : "";
    return { ok: true, data: { weight_kg: kg, age_years: age, doses_given: false, reason: `No doses are given for ${why}. The chapter gives none for this group.${extra}`, advice: "Speak to a doctor or sports dietitian. Food-first strategies are the approach for these athletes.", warnings: general, notes, sources: [SOURCE + " - Ergogenic Aids"], disclaimer: NOT_ADVICE } };
  }

  const out = [];
  for (const id of ids) {
    if (id === "caffeine") {
      out.push({ id, label: "Caffeine", dose_mg: round(3 * kg), dose_mg_per_kg: "up to 3", note: "An energy-enhancing effect is seen with up to 3 mg/kg body mass (about 200 mg for a 150-lb athlete). Side effects that can limit performance: headache, insomnia, GI irritation, reflux, shakiness, heart palpitations, increased urination. Do not combine with ephedra or ephedrine (banned in supplements by the FDA in 2004).", source: "Caffeine (Spriet 2014)" });
    } else if (id === "creatine") {
      out.push({
        id, label: "Creatine monohydrate", source: "Creatine; Table 23.4",
        with_loading: { loading_g_per_day: range(15, 20), loading_days: range(4, 7), maintenance_g_per_day: range(2, 5), note: "Table 23.4 prints 20 g/day for 5 days then 3-5 g/day." },
        without_loading: { g_per_day_first_phase: round(0.3 * kg, 1), first_phase_days: range(5, 7), maintenance_g_per_day: round(0.03 * kg, 1), maintenance_weeks: range(4, 6), note: "Creatine stores rise more slowly this way, and strength effects may take longer to appear." },
        notes: ["Absorption is helped by taking it with carbohydrate or protein.", "Stores return to baseline 4-6 weeks after stopping.", "Weight gain of 0.8-2.9% (water) makes it unsuitable for weight-dependent sports.", "Case reports of high creatinine or kidney problems exist, but there is no compelling evidence that it harms kidney function in healthy people. Anyone with kidney disease needs medical advice first.", "Benefit is for high-intensity work under about 150 seconds (greatest under 30 seconds); aerobic effects are conflicting."],
      });
    } else if (id === "beta_alanine") {
      out.push({ id, label: "Beta-alanine", dose_g_per_day: range(3.2, 6.4, 1), mg_per_kg_per_day: 65, dose_from_weight_g_per_day: round((65 * kg) / 1000, 1), split_dose_g: range(0.8, 1.6, 1), split_interval_hours: range(3, 4), duration: "At least 2-4 weeks (carnosine +65%) and up to 10-12 weeks (+80%).", note: "Small benefit for efforts from 30 seconds to 10 minutes. The only reported side effect is paresthesia (tingling), reduced by divided doses of about 1.6 g or a sustained-release form.", source: "Beta-Alanine; Table 23.4" });
    } else if (id === "hmb") {
      out.push({ id, label: "HMB (beta-hydroxy-beta-methylbutyrate)", dose_g_per_day: 3, split: "in two divided doses", duration: "No safety concerns reported for up to 2 months.", source: "Table 23.4" });
    } else if (id === "beetroot_juice") {
      out.push({ id, label: "Beetroot (nitrate)", dose: "About 0.5 L of beetroot juice, or powders giving 310-560 mg of nitrate", timing: "Plasma nitrite peaks within 3 hours and stays elevated 6-9 hours. The chapter suggests taking it 2-3 hours before and, for long events, around the event.", duration: "Daily for 4-6 days showed a 5% lower cost of submaximal exercise and a 16% longer time to exhaustion in one study.", note: "Gains are harder to obtain in highly trained athletes. GI upset in some.", source: "Nitrates and Beet Juice; Table 23.4" });
    }
  }
  const excluded = ["Sodium bicarbonate, citrulline, betaine, arginine, curcumin, CoQ10 and others in Table 23.4 have no per-kilogram dose in the chapter."];
  return { ok: true, data: { weight_kg: kg, age_years: age, doses_given: true, supplements: out, not_covered: excluded, warnings: general, notes, sources: [SOURCE + " - Ergogenic Aids, Popular Ergogenic Aids, Table 23.4"], disclaimer: NOT_ADVICE } };
}

// ─── One-athlete plan ───────────────────────────────────────────────────────────────

/**
 * Runs every calculator the body has the inputs for and returns each as its own section. A problem in one section only errors
 * that section (like GET /growth/assess). Top-level fields are shared: sex, age_years, height_cm, weight_kg, body_fat_percent |
 * lean_body_mass_kg, activity_level | activity_multiplier, exercise, profile, energy_kcal (overrides the energy section's total).
 * Nested objects: event { duration_min, hours_before_event, recovery_hours, drink }, hydration { ... }, weight_goal { target_weight_kg },
 * supplements { supplements?, pregnant?, lactating? }.
 */
export function computeSportsPlan(input, ctx = {}) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const sections = {}; const errors = {}; const notAssessed = [];
  const run = (name, fn) => { const r = fn(); if (r.ok) sections[name] = r.data; else errors[name] = r.error; return r; };
  const hasFat = present(inp.body_fat_percent) || present(inp.lean_body_mass_kg);
  const hasActivity = present(inp.activity_level) || present(inp.activity_multiplier) || present(inp.exercise) || ctx.activityLog;

  let energyKcal = present(inp.energy_kcal) ? num(inp.energy_kcal) : null;
  if (hasFat && hasActivity) {
    const e = run("energy", () => computeSportsEnergy(inp, ctx));
    if (e.ok && energyKcal === null) energyKcal = e.data.total_kcal;
  } else notAssessed.push({ section: "energy", reason: "needs body_fat_percent or lean_body_mass_kg, plus activity_level, activity_multiplier or exercise" });

  if (present(inp.profile)) run("macros", () => computeSportsMacros({ weight_kg: inp.weight_kg, profile: inp.profile, age_years: inp.age_years, intake: inp.intake, ...(energyKcal !== null && isNum(energyKcal) ? { energy_kcal: energyKcal } : {}) }));
  else notAssessed.push({ section: "macros", reason: "needs profile" });

  if (isObj(inp.event)) run("fuel_timing", () => computeFuelTiming({ weight_kg: inp.weight_kg, ...inp.event }));
  else notAssessed.push({ section: "fuel_timing", reason: "needs an event object { duration_min, hours_before_event, recovery_hours }" });

  if (isObj(inp.hydration)) run("hydration", () => computeHydration({ age_years: inp.age_years, ...inp.hydration, ...(present(inp.event?.duration_min) && !present(inp.hydration.duration_min) ? { duration_min: inp.event.duration_min } : {}) }));
  else notAssessed.push({ section: "hydration", reason: "needs a hydration object { weight_before_kg, weight_after_kg, ... }" });

  if (hasFat && present(inp.body_fat_percent) && present(inp.sex)) run("body_composition", () => computeBodyComposition({ sex: inp.sex, weight_kg: inp.weight_kg, body_fat_percent: inp.body_fat_percent, age_years: inp.age_years, ...(isObj(inp.weight_goal) ? inp.weight_goal : {}) }));
  else notAssessed.push({ section: "body_composition", reason: "needs sex and body_fat_percent" });

  if (isObj(inp.supplements)) run("supplements", () => computeSupplementDoses({ weight_kg: inp.weight_kg, age_years: inp.age_years, ...inp.supplements }));
  else notAssessed.push({ section: "supplements", reason: "optional: pass a supplements object to include doses" });

  if (!Object.keys(sections).length && !Object.keys(errors).length) return { ok: false, error: "nothing to calculate. Send body_fat_percent with an activity_level, a profile, an event, hydration, or a supplements object." };
  return {
    ok: true,
    data: {
      sections, errors, not_assessed: notAssessed,
      note: "Each section is the same calculation as its own endpoint (POST /sports/energy, /macros, /fuel-timing, /hydration, /body-composition, /supplement-dose). A bad value in one section only errors that section. The macro section uses the energy section's total unless energy_kcal is given.",
      sources: [SOURCE], disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Catalog ────────────────────────────────────────────────────────────────────────

export function sportsReferenceCatalog() {
  return {
    source: SOURCE,
    energy: { cunningham: "REE = 500 + 22 x lean body mass (kg). Lean body mass = weight - weight x body fat %. (Boxes 23.1, 23.2)", activity_levels: ACTIVITY_LEVELS, tef: "10% of (REE x activity factor + exercise), a separate step in Box 23.2", mets_formula: "kcal = 0.0175 x kg x METs x minutes (4.5 METs, 80 kg, 30 min = 189 kcal)", kcal_per_kg_tiers: KCAL_PER_KG_TIERS },
    macronutrients: Object.fromEntries(Object.entries(MACRO_PROFILES).map(([id, p]) => [id, { label: p.label, carbohydrate_g_per_kg: { min: p.carbohydrate[0], max: p.carbohydrate[1] }, protein_g_per_kg: { min: p.protein[0], max: p.protein[1] }, fat_g_per_kg: { min: p.fat[0], max: p.fat[1] }, source: p.source }])),
    fuel_timing: { pre_event: "4 g/kg 4 h before, 1 g/kg 1 h before, never above 4 g/kg; up to 200-350 g for events over 90 min", meal_tiers: PRE_EVENT_MEAL_TIERS, during: "none under 60 min; 25-30 g per 30 min after that (about 1 cup of a 4-8% solution every 15-20 min); under 5% unlikely to help, over 10% often causes GI distress", after: "1.2 g/kg/h carbohydrate (1.6 g/kg/h upper), plus 5-9 g protein per 100 g carbohydrate; 20-25 g protein after resistance exercise" },
    hydration: { before: "400-600 mL, 2-3 h before", during: "150-350 mL every 15-20 min, no more than 1 cup", after: "25-50% more than the weight lost over 4-6 h (450-675 mL per lb); 80% before the next session the same day", sodium_g_per_litre: "0.5-0.7 in activity over 1 h", performance_thresholds: "2% body mass loss can impair endurance; 3-4% matters most in team sports", urine_specific_gravity: { hydrated: "up to 1.010", possible_mild_dehydration: "1.011-1.030", above_range: "above 1.030" }, sweat_electrolytes_mg_per_litre: SWEAT_ELECTROLYTES },
    body_composition: BODY_FAT_STANDARDS,
    weight_change: { loss: "1-2 lb/week", gain_lean_lb_per_week: { male: "0.5-1.0", female: "0.25-0.75" }, fat_gain_above: "2 lb/week", extra_energy_kcal_per_day: "250-500" },
    supplements: SUPPLEMENT_IDS,
    energy_stores: { glycogen_total_kcal: 2600, body_fat_kcal_per_lb: 3500, glycogen_g_per_100g_muscle: { normal: 1.7, supercompensated: 5 }, water_g_per_g_glycogen: 2.7, note: "Reference values from the Fat section. A 74 kg athlete at 10% fat carries about 16.3 lb of fat, roughly 57,000 kcal." },
    known_issues: KNOWN_ISSUES,
    related_endpoints: ["POST /energy/requirements (healthy-person and clinical energy)", "POST /energy/food-energy (grams to kcal)", "POST /activity-energy/calculate (named exercise, Appendix 10)", "GET /dri (AMDR, water and electrolytes)", "POST /meals/analyze (nutrients in what was eaten)"],
    disclaimer: NOT_ADVICE,
  };
}
