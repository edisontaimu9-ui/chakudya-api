/**
 * Dietary assessment — nutrient intake analysis, comparison with requirements,
 * and identification of dietary gaps. Pure functions, no database or network.
 *
 * Reuses what the API already has:
 *  - DRI tables (EAR / RDA / AI / UL / AMDR / sodium CDRR) from ./dri_data.js
 *  - the IOM energy requirement (EER) from ./energyEngine.js
 * The route (POST /dietary-assessment in index.js) resolves foods to nutrient totals
 * with the same resolver as /recipes/calculate and /meals/analyze, then calls assessDiet().
 *
 * How adequacy is judged (NASEM approach):
 *  - Nutrient with an EAR + RDA: below the EAR = "likely inadequate"; between EAR and
 *    RDA = "borderline"; at or above the RDA = adequate.
 *  - Nutrient with only an AI: at or above the AI = adequate; below it = "possibly low"
 *    (an AI shortfall does not prove inadequacy).
 *  - Sodium is a limit, not a target: compared with the chronic disease risk reduction
 *    intake (CDRR). Intake below the AI is not flagged.
 *  - UL is flagged when the average intake from food exceeds it.
 * This is a screen against reference values. It is not a diagnosis, and a few days of
 * intake is a weak estimate of usual intake.
 */

import {
  DRI_LIFE_STAGES,
  DRI_NUTRIENT_META,
  DRI_VALUES,
  DRI_AMDR_BY_AGE_BUCKET,
  amdrBucketForAge,
  sodiumCdrrForAge,
  resolveDriLifeStage,
} from "./dri_data.js";
import { computeEnergyRequirements, normalizeSexMF } from "./energyEngine.js";

export const SOURCE =
  "NASEM Dietary Reference Intakes (EAR, RDA, AI, UL, AMDR, sodium CDRR) from src/dri_data.js; energy target from the IOM EER in src/energyEngine.js";

export const MAX_DAYS = 7;
export const MAX_INGREDIENTS = 40;

// Same core set as /meals/analyze (CORE_FOOD_GROUPS in index.js).
export const CORE_FOOD_GROUPS = ["Grains", "Legumes", "Protein", "Vegetables", "Fruits", "Dairy"];

// Columns of the `foods` table (sql/006) that have a DRI but are not in SERVING_SCALE_FIELDS.
// The resolver scales them only when asked (its optional extraFields argument).
export const EXTRA_FOOD_FIELDS = [
  "thiamin_mg", "riboflavin_mg", "niacin_mg", "vitb6_mg", "vite_mg", "pantothenic_acid_mg",
  "biotin_mcg", "phosphorus_mg", "selenium_mcg", "copper_mg", "manganese_mcg",
];

// foods column -> DRI key, where the unit differs (the DRI uses mcg copper and mg manganese).
const FIELD_TO_DRI = {
  copper_mg: { key: "copper_mcg", factor: 1000 },
  manganese_mcg: { key: "manganese_mg", factor: 0.001 },
};
const DRI_TO_FIELD = Object.fromEntries(Object.entries(FIELD_TO_DRI).map(([field, m]) => [m.key, field]));

const EXTRA_DRI_KEYS = [
  "thiamin_mg", "riboflavin_mg", "niacin_mg", "vitb6_mg", "vite_mg", "pantothenic_acid_mg",
  "biotin_mcg", "phosphorus_mg", "selenium_mcg", "copper_mcg", "manganese_mg",
];

const UL_NOTES = {
  vita_rae_mcg: "The UL applies to preformed vitamin A (supplements, liver, fortified foods).",
  folate_mcg: "The UL applies to synthetic folic acid from supplements and fortified foods, not to food folate.",
  niacin_mg: "The UL applies to niacin from supplements and fortified foods.",
  magnesium_mg: "The UL applies to magnesium from supplements, not from food.",
  vite_mg: "The UL applies to vitamin E from supplements.",
};

const NUTRIENT_CAVEATS = {
  niacin_mg: "Food tables give preformed niacin only, while the DRI is in niacin equivalents (tryptophan adds to it), so intake is understated.",
  vite_mg: "The DRI counts alpha-tocopherol only. Check what the food table reports.",
  iron_mg: "Absorption depends on the whole diet (phytate lowers it, vitamin C raises it). This is a screen against the DRI, not an absorption estimate.",
  zinc_mg: "Absorption depends on the whole diet (phytate lowers it). This is a screen against the DRI.",
};

const GAP_RANK = { likely_inadequate: 0, borderline: 1, possibly_low: 2 };

const rnd = (n, d = 1) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** DRI keys this assessment can compare: the ones the foods table tracks, plus EXTRA_FOOD_FIELDS. */
export function assessableNutrients() {
  const keys = Object.entries(DRI_NUTRIENT_META).filter(([, m]) => m.trackable).map(([k]) => k);
  return [...keys, ...EXTRA_DRI_KEYS];
}

/** The foods column to rank on for a DRI key (for the food suggestions). */
export function foodsColumnFor(key) {
  if (DRI_TO_FIELD[key]) return DRI_TO_FIELD[key];
  return DRI_NUTRIENT_META[key]?.foods_column || key;
}

/**
 * Turns a totals/intake object (foods column names or DRI keys) into DRI keys, dropping
 * non-numeric or negative values. kcal stays "kcal" (energy_kcal is accepted as an alias).
 */
export function normalizeIntake(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj && typeof obj === "object" ? obj : {})) {
    const n = Number(v);
    if (v === null || v === "" || !Number.isFinite(n) || n < 0) continue;
    const m = FIELD_TO_DRI[k];
    if (m) out[m.key] = rnd(n * m.factor, 3);
    else out[k] = n;
  }
  if (out.kcal == null && out.energy_kcal != null) out.kcal = out.energy_kcal;
  delete out.energy_kcal;
  return out;
}

/** Sums nutrient fields across resolved ingredients (each has .nutrients). Fields nobody has a value for are left out. */
export function sumResolved(resolved, fields) {
  const totals = {};
  for (const ing of resolved) {
    for (const f of fields) {
      const v = ing?.nutrients?.[f];
      if (v != null && v !== "" && Number.isFinite(Number(v))) totals[f] = (totals[f] ?? 0) + Number(v);
    }
  }
  for (const f of Object.keys(totals)) totals[f] = rnd(totals[f], 3);
  return totals;
}

/** Share (0-100) of resolved ingredients that have a value, per DRI key. Null when nothing was resolved. */
export function coverageOf(resolved, fields) {
  if (!resolved.length) return null;
  const out = {};
  for (const f of fields) {
    const have = resolved.filter((ing) => ing?.nutrients?.[f] != null && ing.nutrients[f] !== "").length;
    out[FIELD_TO_DRI[f]?.key || f] = rnd((have / resolved.length) * 100, 0);
  }
  return out;
}

// ─── Request parsing ────────────────────────────────────────────────────────

function resolveStage(body) {
  if (body.life_stage) {
    const stage = DRI_LIFE_STAGES.find((s) => s.code === body.life_stage);
    if (!stage) return { error: `Unknown life_stage '${body.life_stage}'. See GET /dri/life-stages for the valid codes` };
    return { stage };
  }
  if (body.age == null || body.age === "") return { error: "Provide either 'life_stage' or 'age' (plus 'sex' if age is 9 or more)" };
  const lifeStageType = body.life_stage_type || "normal";
  if (!["normal", "pregnancy", "lactation"].includes(lifeStageType)) return { error: "'life_stage_type' must be one of: normal, pregnancy, lactation" };
  const age = Number(body.age);
  if (!Number.isFinite(age) || age < 0 || age > 120) return { error: "'age' must be a number between 0 and 120 (years)" };
  const stage = resolveDriLifeStage(age, body.sex, lifeStageType);
  if (!stage) {
    return { error: "Could not resolve a life stage from that age, sex and life_stage_type. Check 'sex' is 'male' or 'female' for age 9 or more, and that pregnancy and lactation are only used from age 14" };
  }
  return { stage };
}

function parseDay(raw, index) {
  const label = `days[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} must be an object` };
  let date = null;
  if (raw.date != null && raw.date !== "") {
    if (typeof raw.date !== "string" || !DATE_RE.test(raw.date)) return { error: `${label}.date must be YYYY-MM-DD` };
    date = raw.date;
  }
  const hasMeals = raw.meals != null;
  const hasFlat = raw.ingredients != null;
  const hasIntake = raw.intake != null;
  if ([hasMeals, hasFlat, hasIntake].filter(Boolean).length !== 1) {
    return { error: `${label} needs exactly one of 'meals' (each with an ingredients array), 'ingredients', or 'intake' (a nutrient totals object)` };
  }
  if (hasIntake) {
    if (typeof raw.intake !== "object" || Array.isArray(raw.intake)) return { error: `${label}.intake must be an object like {"kcal": 1800, "iron_mg": 9}` };
    const intake = normalizeIntake(raw.intake);
    if (!Object.keys(intake).length) return { error: `${label}.intake has no numeric nutrient values` };
    return { day: { date, items: null, intake } };
  }
  let items;
  if (hasFlat) {
    if (!Array.isArray(raw.ingredients)) return { error: `${label}.ingredients must be an array` };
    items = raw.ingredients;
  } else {
    if (!Array.isArray(raw.meals)) return { error: `${label}.meals must be an array` };
    items = [];
    for (const [m, meal] of raw.meals.entries()) {
      if (!meal || !Array.isArray(meal.ingredients)) return { error: `${label}.meals[${m}].ingredients must be an array` };
      items.push(...meal.ingredients);
    }
  }
  if (!items.length) return { error: `${label} has no ingredients` };
  return { day: { date, items, intake: null } };
}

/** Validates the request body. Returns { ok, data } or { ok: false, error }. */
export function parseAssessmentRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };

  const st = resolveStage(body);
  if (st.error) return { ok: false, error: st.error };
  const { stage } = st;

  const ageYears = body.age != null && body.age !== "" ? Number(body.age) : stage.age_min ?? null;
  const sex = normalizeSexMF(body.sex) || stage.sex || null;

  let weightKg = null;
  if (body.weight_kg != null && body.weight_kg !== "") {
    weightKg = Number(body.weight_kg);
    if (!Number.isFinite(weightKg) || weightKg < 0.5 || weightKg > 500) return { ok: false, error: "'weight_kg' must be 0.5-500" };
  }
  let heightCm = null;
  if (body.height_cm != null && body.height_cm !== "") {
    heightCm = Number(body.height_cm);
    if (!Number.isFinite(heightCm) || heightCm < 30 || heightCm > 260) return { ok: false, error: "'height_cm' must be 30-260" };
  }
  let energyTargetKcal = null;
  if (body.energy_target_kcal != null && body.energy_target_kcal !== "") {
    energyTargetKcal = Number(body.energy_target_kcal);
    if (!Number.isFinite(energyTargetKcal) || energyTargetKcal < 200 || energyTargetKcal > 8000) return { ok: false, error: "'energy_target_kcal' must be 200-8000" };
  }

  let rawDays;
  if (Array.isArray(body.days)) rawDays = body.days;
  else if (body.meals != null || body.ingredients != null || body.intake != null) {
    rawDays = [{ date: body.date, meals: body.meals, ingredients: body.ingredients, intake: body.intake }];
  } else {
    return { ok: false, error: "'days' is required: an array of {date?, meals|ingredients|intake}. For a single day you may send meals, ingredients or intake at the top level" };
  }
  if (!rawDays.length) return { ok: false, error: "'days' must not be empty" };
  if (rawDays.length > MAX_DAYS) return { ok: false, error: `At most ${MAX_DAYS} days per request` };

  const days = [];
  let ingredientCount = 0;
  for (const [i, raw] of rawDays.entries()) {
    const d = parseDay(raw, i);
    if (d.error) return { ok: false, error: d.error };
    if (d.day.items) ingredientCount += d.day.items.length;
    days.push(d.day);
  }
  if (ingredientCount > MAX_INGREDIENTS) {
    return { ok: false, error: `At most ${MAX_INGREDIENTS} ingredients per request across all days (each one is a food lookup). For more, send a day's totals as 'intake', for example the total_nutrients from /meals/analyze` };
  }

  return {
    ok: true,
    data: {
      stage,
      ageYears,
      sex,
      weightKg,
      heightCm,
      energyTargetKcal,
      pal: body.pal,
      palCategory: body.pal_category,
      trimester: body.trimester,
      monthsPostpartum: body.months_postpartum,
      suggestFoods: body.suggest_foods !== false,
      days,
    },
  };
}

// ─── Energy target ──────────────────────────────────────────────────────────

/** Energy target in kcal/day: the caller's own, or the IOM EER from the energy engine. Returns { kcal, source } or { kcal: null, note }. */
export function buildEnergyTarget(req) {
  if (req.energyTargetKcal != null) return { kcal: Math.round(req.energyTargetKcal), source: "supplied by the caller" };
  if (req.weightKg == null) return { kcal: null, note: "No energy target. Send weight_kg (with height_cm and pal_category) or energy_target_kcal to compare energy intake." };
  if (!req.sex) return { kcal: null, note: "No energy target. Send 'sex' (male or female) to calculate one." };

  const input = { sex: req.sex, age_years: req.ageYears, weight_kg: req.weightKg };
  if (req.heightCm != null) input.height_cm = req.heightCm;
  if (req.palCategory != null) input.pal_category = req.palCategory;
  if (req.pal != null) input.pal = req.pal;
  let note = null;
  if (req.stage.life_stage_type === "pregnancy") {
    if (req.trimester != null) input.pregnancy = { trimester: Number(req.trimester) };
    else note = "Pregnancy: add 'trimester' (1-3) so the extra energy of pregnancy is included in the target.";
  } else if (req.stage.life_stage_type === "lactation") {
    if (req.monthsPostpartum != null) input.lactation = { months_postpartum: Number(req.monthsPostpartum) };
    else note = "Lactation: add 'months_postpartum' so the extra energy of lactation is included in the target.";
  }

  const r = computeEnergyRequirements(input);
  if (!r.ok) return { kcal: null, note: `No energy target: ${r.error}` };
  const kcal = r.data?.recommended?.kcal;
  if (!kcal) {
    return { kcal: null, note: "No energy target. Add height_cm and pal_category (sedentary, low_active, active, very_active) for the IOM estimate, or send energy_target_kcal." };
  }
  return { kcal: Math.round(kcal), source: "IOM EER from the energy engine (POST /energy/requirements)", ...(note ? { note } : {}) };
}

// ─── The assessment ─────────────────────────────────────────────────────────

/**
 * p = {
 *   stage, ageYears, weightKg,
 *   days: [{ date, totals (DRI keys + kcal, fat_g), groups (array of food categories | null) }],
 *   energy: { kcal, source, note? } | null,
 *   coverage: { dri_key: percent of resolved ingredients with a value } | null,
 *   skippedDays?: number
 * }
 */
export function assessDiet(p) {
  const { stage, ageYears, weightKg, days, energy, coverage } = p;
  const n = days.length;
  if (!n) return { ok: false, error: "No day had any food or intake to assess" };

  const values = DRI_VALUES[stage.code] || {};
  const avg = (key) => days.reduce((s, d) => s + (d.totals[key] ?? 0), 0) / n;
  const present = (key) => days.some((d) => d.totals[key] != null);

  const nutrients = [];
  const notAssessed = [];

  for (const key of assessableNutrients()) {
    const meta = DRI_NUTRIENT_META[key];
    const v = values[key];
    if (!v || (v.ear == null && v.rda == null && v.ai == null && key !== "sodium_mg")) {
      notAssessed.push({ nutrient: key, label: meta.label, reason: "no EAR, RDA or AI for this life stage" });
      continue;
    }
    if (!present(key)) {
      notAssessed.push({ nutrient: key, label: meta.label, reason: "no food in the intake has a value for this nutrient" });
      continue;
    }

    const intake = avg(key);
    const cov = coverage?.[key] ?? null;
    const notes = [];
    if (NUTRIENT_CAVEATS[key]) notes.push(NUTRIENT_CAVEATS[key]);
    const lowCoverage = cov != null && cov < 70;
    if (lowCoverage) notes.push(`Only ${cov}% of the foods have a value for this nutrient, so a low result may be missing data rather than a dietary gap.`);

    const entry = { nutrient: key, label: meta.label, unit: meta.unit, average_intake: rnd(intake, 2) };

    if (key === "sodium_mg") {
      const cdrr = sodiumCdrrForAge(ageYears)?.mg_per_day ?? null;
      entry.type = "limit";
      entry.limit = cdrr;
      entry.limit_type = "cdrr";
      entry.percent_of_limit = cdrr ? rnd((intake / cdrr) * 100, 1) : null;
      entry.status = cdrr == null ? "no_limit_for_age" : intake > cdrr ? "above_cdrr" : "within_cdrr";
      entry.gap_level = null;
      entry.exceeds_limit = cdrr != null && intake > cdrr;
      entry.confidence = cov == null ? null : lowCoverage ? "low" : "ok";
      if (cov != null) entry.data_coverage_percent = cov;
      notes.push("Sodium is judged against the chronic disease risk reduction intake (a limit). Intake below the AI is not treated as a gap, and table salt added at the table or in cooking is not in food data.");
      entry.notes = notes;
      nutrients.push(entry);
      continue;
    }

    const target = v.rda ?? v.ai;
    const targetType = v.rda != null ? "rda" : "ai";
    const ear = v.ear ?? null;
    const ref = ear ?? target;

    let status;
    let gapLevel = null;
    if (targetType === "rda" && ear != null) {
      if (intake < ear) { status = "below_ear"; gapLevel = "likely_inadequate"; }
      else if (intake < target) { status = "between_ear_and_rda"; gapLevel = "borderline"; }
      else status = "meets_rda";
    } else if (targetType === "rda") {
      if (intake < target) { status = "below_rda"; gapLevel = "borderline"; } else status = "meets_rda";
    } else if (intake < target) { status = "below_ai"; gapLevel = "possibly_low"; } else status = "meets_ai";

    const daysBelow = days.filter((d) => (d.totals[key] ?? 0) < target).length;
    const exceedsUl = v.ul != null && intake > v.ul;
    if (exceedsUl && UL_NOTES[key]) notes.push(UL_NOTES[key]);

    Object.assign(entry, {
      type: "target",
      ear,
      target,
      target_type: targetType,
      percent_of_target: target > 0 ? rnd((intake / target) * 100, 1) : null,
      percent_of_ear: ear ? rnd((intake / ear) * 100, 1) : null,
      status,
      gap_level: gapLevel,
      days_below_target: daysBelow,
      ul: v.ul ?? null,
      exceeds_ul: exceedsUl,
      confidence: cov == null ? null : lowCoverage ? "low" : "ok",
      ...(cov != null ? { data_coverage_percent: cov } : {}),
      notes,
    });
    entry._ref_pct = ref > 0 ? (intake / ref) * 100 : 100;
    nutrients.push(entry);
  }

  nutrients.sort((a, b) => a.label.localeCompare(b.label));

  const gaps = nutrients
    .filter((e) => e.gap_level)
    .sort((a, b) => GAP_RANK[a.gap_level] - GAP_RANK[b.gap_level] || a._ref_pct - b._ref_pct);
  const excesses = nutrients.filter((e) => e.exceeds_ul || e.exceeds_limit);
  const adequate = nutrients.filter((e) => e.type === "target" && !e.gap_level).map((e) => e.nutrient);
  const gapView = (e) => ({
    nutrient: e.nutrient,
    label: e.label,
    gap_level: e.gap_level,
    average_intake: e.average_intake,
    target: e.target,
    unit: e.unit,
    percent_of_target: e.percent_of_target,
    days_below_target: e.days_below_target,
    confidence: e.confidence,
  });
  for (const e of nutrients) delete e._ref_pct;

  // Macronutrients — Atwater 4/4/9, against the AMDR for the age.
  const protein = avg("protein_g");
  const carbs = avg("carbs_g");
  const fat = avg("fat_g");
  const kcalIntake = present("kcal") ? avg("kcal") : null;
  const macroKcal = protein * 4 + carbs * 4 + fat * 9;
  let macronutrients = null;
  if (macroKcal > 0 && present("protein_g") && present("carbs_g") && present("fat_g")) {
    const amdr = DRI_AMDR_BY_AGE_BUCKET[amdrBucketForAge(ageYears)] || DRI_AMDR_BY_AGE_BUCKET.adults;
    const pct = { protein: rnd((protein * 4 / macroKcal) * 100, 1), carbs: rnd((carbs * 4 / macroKcal) * 100, 1), fat: rnd((fat * 9 / macroKcal) * 100, 1) };
    const judge = (percent, range) => (!range ? null : percent < range.min_percent ? "below" : percent > range.max_percent ? "above" : "within");
    macronutrients = {
      average_grams: { protein: rnd(protein, 1), carbs: rnd(carbs, 1), fat: rnd(fat, 1) },
      percent_of_energy: pct,
      amdr: {
        protein: { ...amdr.protein, status: judge(pct.protein, amdr.protein) },
        carbs: { ...amdr.carbohydrate, status: judge(pct.carbs, amdr.carbohydrate) },
        fat: { ...amdr.fat, status: judge(pct.fat, amdr.fat) },
      },
      ...(weightKg ? { protein_g_per_kg: rnd(protein / weightKg, 2) } : {}),
    };
  }

  // Energy.
  let energyBlock = null;
  if (kcalIntake != null) {
    energyBlock = { average_intake_kcal: Math.round(kcalIntake) };
    if (energy?.kcal) {
      const pctE = rnd((kcalIntake / energy.kcal) * 100, 1);
      Object.assign(energyBlock, {
        target_kcal: energy.kcal,
        target_source: energy.source,
        percent_of_target: pctE,
        status: pctE < 90 ? "below_target" : pctE <= 110 ? "within_10_percent" : "above_target",
      });
    }
    if (energy?.note) energyBlock.note = energy.note;
  } else if (energy?.note) {
    energyBlock = { note: energy.note };
  }

  // Food groups.
  let foodGroups = null;
  const groupDays = days.filter((d) => Array.isArray(d.groups));
  if (groupDays.length) {
    const frequency = {};
    for (const g of CORE_FOOD_GROUPS) frequency[g] = groupDays.filter((d) => d.groups.includes(g)).length;
    foodGroups = {
      days_with_food_data: groupDays.length,
      frequency_days: frequency,
      missing_every_day: CORE_FOOD_GROUPS.filter((g) => frequency[g] === 0),
      missing_some_days: CORE_FOOD_GROUPS.filter((g) => frequency[g] > 0 && frequency[g] < groupDays.length),
    };
  }

  const counts = {
    likely_inadequate: gaps.filter((g) => g.gap_level === "likely_inadequate").length,
    borderline: gaps.filter((g) => g.gap_level === "borderline").length,
    possibly_low: gaps.filter((g) => g.gap_level === "possibly_low").length,
  };
  const parts = [];
  if (counts.likely_inadequate) parts.push(`${counts.likely_inadequate} likely inadequate`);
  if (counts.borderline) parts.push(`${counts.borderline} borderline`);
  if (counts.possibly_low) parts.push(`${counts.possibly_low} possibly low (below AI)`);
  const headline =
    `Average of ${n} day${n === 1 ? "" : "s"}: ` +
    (parts.length ? parts.join(", ") : "no nutrient gaps found") +
    `${excesses.length ? `; ${excesses.length} above a safe limit` : ""}.`;

  const notes = [
    "Screening against DRI reference values, not a diagnosis. It does not replace a clinical or biochemical assessment.",
    "EAR-based adequacy is strictly valid for groups. For one person, read 'below EAR' as a high chance of inadequate intake and 'borderline' as a lower chance.",
    "A food with no value for a nutrient counts as zero. Check 'confidence' and 'data_coverage_percent' before acting on a gap.",
    "Cooking losses, bioavailability and supplements are not modelled.",
  ];
  if (n < 3) notes.unshift(`Only ${n} day${n === 1 ? "" : "s"} analysed. Day-to-day intake varies a lot, so 3 or more days gives a more reliable picture of usual intake.`);
  if (p.skippedDays) notes.push(`${p.skippedDays} day(s) were left out because none of their foods could be resolved.`);

  return {
    ok: true,
    data: {
      life_stage: stage.code,
      life_stage_label: stage.label,
      days_assessed: n,
      summary: {
        headline,
        nutrients_assessed: nutrients.length,
        gap_counts: counts,
        above_limit_count: excesses.length,
        priority_gaps: gaps.slice(0, 5).map(gapView),
      },
      energy: energyBlock,
      macronutrients,
      nutrients,
      gaps: gaps.map(gapView),
      excesses: excesses.map((e) => ({ nutrient: e.nutrient, label: e.label, average_intake: e.average_intake, unit: e.unit, limit: e.ul ?? e.limit, limit_type: e.exceeds_ul ? "ul" : "cdrr", notes: e.notes })),
      adequate_nutrients: adequate,
      food_groups: foodGroups,
      not_assessed: notAssessed,
      notes,
      source: SOURCE,
    },
  };
}

/** Static reference for GET /dietary-assessment/reference. */
export function dietaryAssessmentReference() {
  return {
    ok: true,
    data: {
      purpose: "Nutrient intake analysis, comparison with requirements and identification of dietary gaps (POST /dietary-assessment).",
      input: {
        days: `Up to ${MAX_DAYS} days. Each day has exactly one of: meals (each {meal_type?, ingredients}), ingredients, or intake (nutrient totals).`,
        ingredients: `Items {food_id | food_name, quantity, unit?}. At most ${MAX_INGREDIENTS} across the request (each is a food lookup).`,
        intake: "Nutrient totals for one day, e.g. the total_nutrients from /meals/analyze. Keys: kcal, protein_g, carbs_g, fat_g, fiber_g and any assessable nutrient.",
        person: "age (or life_stage), sex, life_stage_type (normal, pregnancy, lactation). Optional: weight_kg, height_cm, pal_category, trimester, months_postpartum, energy_target_kcal.",
        suggest_foods: "Default true. Adds the foods richest in the top gap nutrients (per 100 g).",
      },
      assessable_nutrients: assessableNutrients().map((k) => ({
        nutrient: k,
        label: DRI_NUTRIENT_META[k].label,
        unit: DRI_NUTRIENT_META[k].unit,
        foods_column: foodsColumnFor(k),
        unit_conversion: DRI_TO_FIELD[k] ? `foods column ${DRI_TO_FIELD[k]} is converted (x${FIELD_TO_DRI[DRI_TO_FIELD[k]].factor})` : null,
        caveat: NUTRIENT_CAVEATS[k] || null,
      })),
      statuses: {
        below_ear: "Intake below the EAR: likely inadequate (gap_level likely_inadequate).",
        between_ear_and_rda: "Between the EAR and the RDA: borderline (gap_level borderline).",
        below_rda: "Below the RDA where no EAR exists: borderline.",
        meets_rda: "At or above the RDA: adequate.",
        below_ai: "Below the AI: possibly low. An AI shortfall does not prove inadequacy (gap_level possibly_low).",
        meets_ai: "At or above the AI: adequate.",
        above_cdrr: "Sodium above the chronic disease risk reduction intake.",
        within_cdrr: "Sodium within the CDRR.",
      },
      method_notes: [
        "Average intake over the assessed days is compared with the DRI of the resolved life stage.",
        "UL is checked against average intake from food. For several nutrients the UL covers supplements or fortification only, and the entry says so.",
        "Energy target is the caller's own, or the IOM EER when weight, height and PAL are supplied.",
        "Macronutrient shares use Atwater factors 4/4/9 against the AMDR for the age.",
      ],
      source: SOURCE,
    },
  };
}
