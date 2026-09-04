/**
 * Dietary Reference Intakes (DRI) — EAR / RDA / AI / UL / AMDR
 * Source: Food and Nutrition Board, National Academies of Sciences,
 * Engineering, and Medicine (NASEM/IOM) — the standard tables covering
 * Estimated Average Requirement, Recommended Dietary Allowance, Adequate
 * Intake, Tolerable Upper Intake Level, and Acceptable Macronutrient
 * Distribution Range, transcribed from the user-supplied source pages
 * (NASEM DRI summary tables, prepublication edition).
 *
 * Data-entry approach: each table is column/row data (as printed in the
 * source), assembled into a per-life-stage nutrient map at load time —
 * this keeps the transcription close to the source layout and easy to
 * spot-check against it, rather than hand-writing ~450 individual object
 * literals.
 *
 * RDA vs AI: the source tables mark this per cell with bold vs an
 * asterisk. Rather than re-encode that per cell, it's derived from a
 * documented rule that matches the source exactly: every infant value is
 * AI (no EAR has ever been established for infants); for every other
 * life stage, a nutrient is AI only if it has no EAR at all (the set in
 * AI_ONLY_NUTRIENTS below, taken from the EAR table's own footnote:
 * "EARs have not been established for vitamin K, pantothenic acid,
 * biotin, choline, chromium, fluoride, manganese, potassium, sodium,
 * chloride" — plus fiber, water, and the essential fatty acids, which
 * the AMDR/macronutrient table also gives only as AI). Everything else
 * is RDA.
 *
 * Coverage note: UL is included only for nutrients with an unambiguous
 * published number in the source. Arsenic, Chromium, Potassium,
 * Silicon, and Vanadium have no established UL (per the source's own
 * notes) and are omitted rather than guessed. Sodium's UL was
 * superseded by the 2019 Chronic Disease Risk Reduction Intake
 * (DRI_SODIUM_CDRR below) — no separate UL is stored for it.
 *
 * "trackable" on a nutrient means CNR's own `foods` table / SERVING_SCALE_FIELDS
 * has a matching column, so a food or a logged intake can actually be
 * compared against it. Untrackable nutrients (thiamin, riboflavin,
 * niacin, vitamin B6/E/K, and most trace minerals) are still stored for
 * standalone lookup via GET /dri, just not usable by POST /dri/compare.
 */

// ─── Life stages ──────────────────────────────────────────────────────────

const DRI_LIFE_STAGES = [
  { code: "infant_0_6mo", label: "Infants, 0–6 months", sex: null, life_stage_type: "infant", age_min: 0, age_max: 0.5 },
  { code: "infant_7_12mo", label: "Infants, 7–12 months", sex: null, life_stage_type: "infant", age_min: 0.5, age_max: 1 },
  { code: "child_1_3", label: "Children, 1–3 years", sex: null, life_stage_type: "child", age_min: 1, age_max: 3 },
  { code: "child_4_8", label: "Children, 4–8 years", sex: null, life_stage_type: "child", age_min: 4, age_max: 8 },
  { code: "male_9_13", label: "Males, 9–13 years", sex: "male", life_stage_type: "normal", age_min: 9, age_max: 13 },
  { code: "male_14_18", label: "Males, 14–18 years", sex: "male", life_stage_type: "normal", age_min: 14, age_max: 18 },
  { code: "male_19_30", label: "Males, 19–30 years", sex: "male", life_stage_type: "normal", age_min: 19, age_max: 30 },
  { code: "male_31_50", label: "Males, 31–50 years", sex: "male", life_stage_type: "normal", age_min: 31, age_max: 50 },
  { code: "male_51_70", label: "Males, 51–70 years", sex: "male", life_stage_type: "normal", age_min: 51, age_max: 70 },
  { code: "male_71_plus", label: "Males, >70 years", sex: "male", life_stage_type: "normal", age_min: 71, age_max: 150 },
  { code: "female_9_13", label: "Females, 9–13 years", sex: "female", life_stage_type: "normal", age_min: 9, age_max: 13 },
  { code: "female_14_18", label: "Females, 14–18 years", sex: "female", life_stage_type: "normal", age_min: 14, age_max: 18 },
  { code: "female_19_30", label: "Females, 19–30 years", sex: "female", life_stage_type: "normal", age_min: 19, age_max: 30 },
  { code: "female_31_50", label: "Females, 31–50 years", sex: "female", life_stage_type: "normal", age_min: 31, age_max: 50 },
  { code: "female_51_70", label: "Females, 51–70 years", sex: "female", life_stage_type: "normal", age_min: 51, age_max: 70 },
  { code: "female_71_plus", label: "Females, >70 years", sex: "female", life_stage_type: "normal", age_min: 71, age_max: 150 },
  { code: "pregnancy_14_18", label: "Pregnancy, 14–18 years", sex: "female", life_stage_type: "pregnancy", age_min: 14, age_max: 18 },
  { code: "pregnancy_19_30", label: "Pregnancy, 19–30 years", sex: "female", life_stage_type: "pregnancy", age_min: 19, age_max: 30 },
  { code: "pregnancy_31_50", label: "Pregnancy, 31–50 years", sex: "female", life_stage_type: "pregnancy", age_min: 31, age_max: 50 },
  { code: "lactation_14_18", label: "Lactation, 14–18 years", sex: "female", life_stage_type: "lactation", age_min: 14, age_max: 18 },
  { code: "lactation_19_30", label: "Lactation, 19–30 years", sex: "female", life_stage_type: "lactation", age_min: 19, age_max: 30 },
  { code: "lactation_31_50", label: "Lactation, 31–50 years", sex: "female", life_stage_type: "lactation", age_min: 31, age_max: 50 },
];

// Nutrients with no EAR at any life stage — AI at every life stage, not just infancy.
const AI_ONLY_NUTRIENTS = new Set([
  "vitk_mcg", "pantothenic_acid_mg", "biotin_mcg", "choline_mg",
  "chromium_mcg", "fluoride_mg", "manganese_mg", "potassium_mg",
  "sodium_mg", "chloride_g", "fiber_g", "water_l", "linoleic_acid_g", "ala_g",
]);

// nutrient_key -> { label, unit, trackable, foods_column }
// foods_column matches the SERVING_SCALE_FIELDS / foods-table column name
// for every nutrient CNR can actually resolve a food's content of.
const DRI_NUTRIENT_META = {
  protein_g: { label: "Protein", unit: "g/d", trackable: true, foods_column: "protein_g" },
  carbs_g: { label: "Carbohydrate", unit: "g/d", trackable: true, foods_column: "carbs_g" },
  fiber_g: { label: "Total Fiber", unit: "g/d", trackable: true, foods_column: "fiber_g" },
  vita_rae_mcg: { label: "Vitamin A", unit: "µg RAE/d", trackable: true, foods_column: "vita_rae_mcg" },
  vitc_mg: { label: "Vitamin C", unit: "mg/d", trackable: true, foods_column: "vitc_mg" },
  vitd_mcg: { label: "Vitamin D", unit: "µg/d", trackable: true, foods_column: "vitd_mcg" },
  vitb12_mcg: { label: "Vitamin B12", unit: "µg/d", trackable: true, foods_column: "vitb12_mcg" },
  folate_mcg: { label: "Folate", unit: "µg DFE/d", trackable: true, foods_column: "folate_mcg" },
  calcium_mg: { label: "Calcium", unit: "mg/d", trackable: true, foods_column: "calcium_mg" },
  iron_mg: { label: "Iron", unit: "mg/d", trackable: true, foods_column: "iron_mg" },
  zinc_mg: { label: "Zinc", unit: "mg/d", trackable: true, foods_column: "zinc_mg" },
  magnesium_mg: { label: "Magnesium", unit: "mg/d", trackable: true, foods_column: "magnesium_mg" },
  potassium_mg: { label: "Potassium", unit: "mg/d", trackable: true, foods_column: "potassium_mg" },
  sodium_mg: { label: "Sodium", unit: "mg/d", trackable: true, foods_column: "sodium_mg" },
  iodine_mcg: { label: "Iodine", unit: "µg/d", trackable: true, foods_column: "iodine_mcg" },
  // Reference-only — not columns CNR's foods table tracks yet.
  vite_mg: { label: "Vitamin E", unit: "mg/d", trackable: false },
  vitk_mcg: { label: "Vitamin K", unit: "µg/d", trackable: false },
  thiamin_mg: { label: "Thiamin (B1)", unit: "mg/d", trackable: false },
  riboflavin_mg: { label: "Riboflavin (B2)", unit: "mg/d", trackable: false },
  niacin_mg: { label: "Niacin (B3)", unit: "mg/d", trackable: false },
  vitb6_mg: { label: "Vitamin B6", unit: "mg/d", trackable: false },
  pantothenic_acid_mg: { label: "Pantothenic Acid (B5)", unit: "mg/d", trackable: false },
  biotin_mcg: { label: "Biotin (B7)", unit: "µg/d", trackable: false },
  choline_mg: { label: "Choline", unit: "mg/d", trackable: false },
  copper_mcg: { label: "Copper", unit: "µg/d", trackable: false },
  chromium_mcg: { label: "Chromium", unit: "µg/d", trackable: false },
  fluoride_mg: { label: "Fluoride", unit: "mg/d", trackable: false },
  manganese_mg: { label: "Manganese", unit: "mg/d", trackable: false },
  molybdenum_mcg: { label: "Molybdenum", unit: "µg/d", trackable: false },
  phosphorus_mg: { label: "Phosphorus", unit: "mg/d", trackable: false },
  selenium_mcg: { label: "Selenium", unit: "µg/d", trackable: false },
  boron_mg: { label: "Boron", unit: "mg/d", trackable: false },
  nickel_mg: { label: "Nickel", unit: "mg/d", trackable: false },
  water_l: { label: "Total Water", unit: "L/d", trackable: false },
  linoleic_acid_g: { label: "Linoleic Acid (n-6)", unit: "g/d", trackable: false },
  ala_g: { label: "α-Linolenic Acid (n-3)", unit: "g/d", trackable: false },
  protein_g_per_kg: { label: "Protein (EAR basis)", unit: "g/kg body weight/d", trackable: false },
};

// ─── Table-driven row data ──────────────────────────────────────────────────
// Each block: [columnKeys], { life_stage_code: [values in column order] }.
// null = not established / not applicable for that life stage.

function zipRows(columns, rows) {
  const out = {};
  for (const [code, values] of Object.entries(rows)) {
    const entry = {};
    columns.forEach((key, i) => {
      if (values[i] != null) entry[key] = values[i];
    });
    out[code] = entry;
  }
  return out;
}

// RDA/AI — Vitamins
const RDA_AI_VITAMIN_COLUMNS = [
  "vita_rae_mcg", "vitc_mg", "vitd_mcg", "vite_mg", "vitk_mcg", "thiamin_mg",
  "riboflavin_mg", "niacin_mg", "vitb6_mg", "folate_mcg", "vitb12_mcg",
  "pantothenic_acid_mg", "biotin_mcg", "choline_mg",
];
const RDA_AI_VITAMIN_ROWS = {
  infant_0_6mo: [400, 40, 10, 4, 2.0, 0.2, 0.3, 2, 0.1, 65, 0.4, 1.7, 5, 125],
  infant_7_12mo: [500, 50, 10, 5, 2.5, 0.3, 0.4, 4, 0.3, 80, 0.5, 1.8, 6, 150],
  child_1_3: [300, 15, 15, 6, 30, 0.5, 0.5, 6, 0.5, 150, 0.9, 2, 8, 200],
  child_4_8: [400, 25, 15, 7, 55, 0.6, 0.6, 8, 0.6, 200, 1.2, 3, 12, 250],
  male_9_13: [600, 45, 15, 11, 60, 0.9, 0.9, 12, 1.0, 300, 1.8, 4, 20, 375],
  male_14_18: [900, 75, 15, 15, 75, 1.2, 1.3, 16, 1.3, 400, 2.4, 5, 25, 550],
  male_19_30: [900, 90, 15, 15, 120, 1.2, 1.3, 16, 1.3, 400, 2.4, 5, 30, 550],
  male_31_50: [900, 90, 15, 15, 120, 1.2, 1.3, 16, 1.3, 400, 2.4, 5, 30, 550],
  male_51_70: [900, 90, 15, 15, 120, 1.2, 1.3, 16, 1.7, 400, 2.4, 5, 30, 550],
  male_71_plus: [900, 90, 20, 15, 120, 1.2, 1.3, 16, 1.7, 400, 2.4, 5, 30, 550],
  female_9_13: [600, 45, 15, 11, 60, 0.9, 0.9, 12, 1.0, 300, 1.8, 4, 20, 375],
  female_14_18: [700, 65, 15, 15, 75, 1.0, 1.0, 14, 1.2, 400, 2.4, 5, 25, 400],
  female_19_30: [700, 75, 15, 15, 90, 1.1, 1.1, 14, 1.3, 400, 2.4, 5, 30, 425],
  female_31_50: [700, 75, 15, 15, 90, 1.1, 1.1, 14, 1.3, 400, 2.4, 5, 30, 425],
  female_51_70: [700, 75, 15, 15, 90, 1.1, 1.1, 14, 1.5, 400, 2.4, 5, 30, 425],
  female_71_plus: [700, 75, 20, 15, 90, 1.1, 1.1, 14, 1.5, 400, 2.4, 5, 30, 425],
  pregnancy_14_18: [750, 80, 15, 15, 75, 1.4, 1.4, 18, 1.9, 600, 2.6, 6, 30, 450],
  pregnancy_19_30: [770, 85, 15, 15, 90, 1.4, 1.4, 18, 1.9, 600, 2.6, 6, 30, 450],
  pregnancy_31_50: [770, 85, 15, 15, 90, 1.4, 1.4, 18, 1.9, 600, 2.6, 6, 30, 450],
  lactation_14_18: [1200, 115, 15, 19, 75, 1.4, 1.6, 17, 2.0, 500, 2.8, 7, 35, 550],
  lactation_19_30: [1300, 120, 15, 19, 90, 1.4, 1.6, 17, 2.0, 500, 2.8, 7, 35, 550],
  lactation_31_50: [1300, 120, 15, 19, 90, 1.4, 1.6, 17, 2.0, 500, 2.8, 7, 35, 550],
};

// RDA/AI — Elements
const RDA_AI_ELEMENT_COLUMNS = [
  "calcium_mg", "chromium_mcg", "copper_mcg", "fluoride_mg", "iodine_mcg", "iron_mg",
  "magnesium_mg", "manganese_mg", "molybdenum_mcg", "phosphorus_mg", "selenium_mcg",
  "zinc_mg", "potassium_mg", "sodium_mg", "chloride_g",
];
const RDA_AI_ELEMENT_ROWS = {
  infant_0_6mo: [200, 0.2, 200, 0.01, 110, 0.27, 30, 0.003, 2, 100, 15, 2, 400, 110, 0.18],
  infant_7_12mo: [260, 5.5, 220, 0.5, 130, 11, 75, 0.6, 3, 275, 20, 3, 860, 370, 0.57],
  child_1_3: [700, 11, 340, 0.7, 90, 7, 80, 1.2, 17, 460, 20, 3, 2000, 800, 1.5],
  child_4_8: [1000, 15, 440, 1, 90, 10, 130, 1.5, 22, 500, 30, 5, 2300, 1000, 1.9],
  male_9_13: [1300, 25, 700, 2, 120, 8, 240, 1.9, 34, 1250, 40, 8, 2500, 1200, 2.3],
  male_14_18: [1300, 35, 890, 3, 150, 11, 410, 2.2, 43, 1250, 55, 11, 3000, 1500, 2.3],
  male_19_30: [1000, 35, 900, 4, 150, 8, 400, 2.3, 45, 700, 55, 11, 3400, 1500, 2.3],
  male_31_50: [1000, 35, 900, 4, 150, 8, 420, 2.3, 45, 700, 55, 11, 3400, 1500, 2.3],
  male_51_70: [1000, 30, 900, 4, 150, 8, 420, 2.3, 45, 700, 55, 11, 3400, 1500, 2.0],
  male_71_plus: [1200, 30, 900, 4, 150, 8, 420, 2.3, 45, 700, 55, 11, 3400, 1500, 1.8],
  female_9_13: [1300, 21, 700, 2, 120, 8, 240, 1.6, 34, 1250, 40, 8, 2300, 1200, 2.3],
  female_14_18: [1300, 24, 890, 3, 150, 15, 360, 1.6, 43, 1250, 55, 9, 2300, 1500, 2.3],
  female_19_30: [1000, 25, 900, 3, 150, 18, 310, 1.8, 45, 700, 55, 8, 2600, 1500, 2.3],
  female_31_50: [1000, 25, 900, 3, 150, 18, 320, 1.8, 45, 700, 55, 8, 2600, 1500, 2.3],
  female_51_70: [1200, 20, 900, 3, 150, 8, 320, 1.8, 45, 700, 55, 8, 2600, 1500, 2.0],
  female_71_plus: [1200, 20, 900, 3, 150, 8, 320, 1.8, 45, 700, 55, 8, 2600, 1500, 1.8],
  pregnancy_14_18: [1300, 29, 1000, 3, 220, 27, 400, 2.0, 50, 1250, 60, 12, 2600, 1500, 2.3],
  pregnancy_19_30: [1000, 30, 1000, 3, 220, 27, 350, 2.0, 50, 700, 60, 11, 2900, 1500, 2.3],
  pregnancy_31_50: [1000, 30, 1000, 3, 220, 27, 360, 2.0, 50, 700, 60, 11, 2900, 1500, 2.3],
  lactation_14_18: [1300, 44, 1300, 3, 290, 10, 360, 2.6, 50, 1250, 70, 13, 2500, 1500, 2.3],
  lactation_19_30: [1000, 45, 1300, 3, 290, 9, 310, 2.6, 50, 700, 70, 12, 2800, 1500, 2.3],
  lactation_31_50: [1000, 45, 1300, 3, 290, 9, 320, 2.6, 50, 700, 70, 12, 2800, 1500, 2.3],
};

// RDA/AI — Total Water and Macronutrients (absolute amounts, g/d and L/d)
const MACRO_WATER_COLUMNS = ["water_l", "carbs_g", "fiber_g", "linoleic_acid_g", "ala_g", "protein_g"];
const MACRO_WATER_ROWS = {
  infant_0_6mo: [0.7, 60, null, 4.4, 0.5, 9.1],
  infant_7_12mo: [0.8, 95, null, 4.6, 0.5, 11.0],
  child_1_3: [1.3, 130, 19, 7, 0.7, 13],
  child_4_8: [1.7, 130, 25, 10, 0.9, 19],
  male_9_13: [2.4, 130, 31, 12, 1.2, 34],
  male_14_18: [3.3, 130, 38, 16, 1.6, 52],
  male_19_30: [3.7, 130, 38, 17, 1.6, 56],
  male_31_50: [3.7, 130, 38, 17, 1.6, 56],
  male_51_70: [3.7, 130, 30, 14, 1.6, 56],
  male_71_plus: [3.7, 130, 30, 14, 1.6, 56],
  female_9_13: [2.1, 130, 26, 10, 1.0, 34],
  female_14_18: [2.3, 130, 26, 11, 1.1, 46],
  female_19_30: [2.7, 130, 25, 12, 1.1, 46],
  female_31_50: [2.7, 130, 25, 12, 1.1, 46],
  female_51_70: [2.7, 130, 21, 11, 1.1, 46],
  female_71_plus: [2.7, 130, 21, 11, 1.1, 46],
  pregnancy_14_18: [3.0, 175, 28, 13, 1.4, 71],
  pregnancy_19_30: [3.0, 175, 28, 13, 1.4, 71],
  pregnancy_31_50: [3.0, 175, 28, 13, 1.4, 71],
  lactation_14_18: [3.8, 210, 29, 13, 1.3, 71],
  lactation_19_30: [3.8, 210, 29, 13, 1.3, 71],
  lactation_31_50: [3.8, 210, 29, 13, 1.3, 71],
};

// UL — Vitamins (only nutrients with an established UL)
const UL_VITAMIN_COLUMNS = ["vita_rae_mcg", "vitc_mg", "vitd_mcg", "vite_mg", "niacin_mg", "vitb6_mg", "folate_mcg"];
const UL_VITAMIN_ROWS = {
  infant_0_6mo: [600, null, 25, null, null, null, null],
  infant_7_12mo: [600, null, 38, null, null, null, null],
  child_1_3: [600, 400, 63, 200, 10, 30, 300],
  child_4_8: [900, 650, 75, 300, 15, 40, 400],
  male_9_13: [1700, 1200, 100, 600, 20, 60, 600],
  male_14_18: [2800, 1800, 100, 800, 30, 80, 800],
  male_19_30: [3000, 2000, 100, 1000, 35, 100, 1000],
  male_31_50: [3000, 2000, 100, 1000, 35, 100, 1000],
  male_51_70: [3000, 2000, 100, 1000, 35, 100, 1000],
  male_71_plus: [3000, 2000, 100, 1000, 35, 100, 1000],
  female_9_13: [1700, 1200, 100, 600, 20, 60, 600],
  female_14_18: [2800, 1800, 100, 800, 30, 80, 800],
  female_19_30: [3000, 2000, 100, 1000, 35, 100, 1000],
  female_31_50: [3000, 2000, 100, 1000, 35, 100, 1000],
  female_51_70: [3000, 2000, 100, 1000, 35, 100, 1000],
  female_71_plus: [3000, 2000, 100, 1000, 35, 100, 1000],
  pregnancy_14_18: [2800, 1800, 100, 800, 30, 80, 800],
  pregnancy_19_30: [3000, 2000, 100, 1000, 35, 100, 1000],
  pregnancy_31_50: [3000, 2000, 100, 1000, 35, 100, 1000],
  lactation_14_18: [2800, 1800, 100, 800, 30, 80, 800],
  lactation_19_30: [3000, 2000, 100, 1000, 35, 100, 1000],
  lactation_31_50: [3000, 2000, 100, 1000, 35, 100, 1000],
};

// UL — Elements. Arsenic, Chromium, Potassium, Silicon, Vanadium, and Sodium
// deliberately omitted — see file header note.
const UL_ELEMENT_COLUMNS = [
  "boron_mg", "calcium_mg", "copper_mcg", "fluoride_mg", "iodine_mcg", "iron_mg",
  "magnesium_mg", "manganese_mg", "molybdenum_mcg", "nickel_mg", "phosphorus_g",
  "selenium_mcg", "zinc_mg",
];
const UL_ELEMENT_ROWS = {
  infant_0_6mo: [null, 1000, null, 0.7, null, 40, null, null, null, null, null, 45, 4],
  infant_7_12mo: [null, 1500, null, 0.9, null, 40, null, null, null, null, null, 60, 5],
  child_1_3: [3, 2500, 1000, 1.3, 200, 40, 65, 2, 300, 0.2, 3, 90, 7],
  child_4_8: [6, 2500, 3000, 2.2, 300, 40, 110, 3, 600, 0.3, 3, 150, 12],
  male_9_13: [11, 3000, 5000, 10, 600, 40, 350, 6, 1100, 0.6, 4, 280, 23],
  male_14_18: [17, 3000, 8000, 10, 900, 45, 350, 9, 1700, 1.0, 4, 400, 34],
  male_19_30: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  male_31_50: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  male_51_70: [20, 2000, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  male_71_plus: [20, 2000, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 3, 400, 40],
  female_9_13: [11, 3000, 5000, 10, 600, 40, 350, 6, 1100, 0.6, 4, 280, 23],
  female_14_18: [17, 3000, 8000, 10, 900, 45, 350, 9, 1700, 1.0, 4, 400, 34],
  female_19_30: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  female_31_50: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  female_51_70: [20, 2000, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  female_71_plus: [20, 2000, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 3, 400, 40],
  pregnancy_14_18: [17, 3000, 8000, 10, 900, 45, 350, 9, 1700, 1.0, 3.5, 400, 34],
  pregnancy_19_30: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 3.5, 400, 40],
  pregnancy_31_50: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 3.5, 400, 40],
  lactation_14_18: [17, 3000, 8000, 10, 900, 45, 350, 9, 1700, 1.0, 4, 400, 34],
  lactation_19_30: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
  lactation_31_50: [20, 2500, 10000, 10, 1100, 45, 350, 11, 2000, 1.0, 4, 400, 40],
};

// EAR — only established for these ~20 nutrients; everything else is AI-only
// (see AI_ONLY_NUTRIENTS). protein_g_per_kg is g protein per kg body weight
// per day — the EAR's own basis for protein, distinct from the absolute
// protein_g RDA in MACRO_WATER_ROWS above.
const EAR_COLUMNS = [
  "calcium_mg", "carbs_g", "protein_g_per_kg", "vita_rae_mcg", "vitc_mg", "vitd_mcg",
  "vite_mg", "thiamin_mg", "riboflavin_mg", "niacin_mg", "vitb6_mg", "folate_mcg",
  "vitb12_mcg", "copper_mcg", "iodine_mcg", "iron_mg", "magnesium_mg",
  "molybdenum_mcg", "phosphorus_mg", "selenium_mcg", "zinc_mg",
];
const EAR_ROWS = {
  infant_7_12mo: [null, null, 1.0, null, null, null, null, null, null, null, null, null, null, null, null, 6.9, null, null, null, null, null],
  child_1_3: [500, 100, 0.87, 210, 13, 10, 5, 0.4, 0.4, 5, 0.4, 120, 0.7, 260, 65, 3.0, 65, 13, 380, 17, 2.5],
  child_4_8: [800, 100, 0.76, 275, 22, 10, 6, 0.5, 0.5, 6, 0.5, 160, 1.0, 340, 65, 4.1, 110, 17, 405, 23, 4.0],
  male_9_13: [1100, 100, 0.76, 445, 39, 10, 9, 0.7, 0.8, 9, 0.8, 250, 1.5, 540, 73, 5.9, 200, 26, 1055, 35, 7.0],
  male_14_18: [1100, 100, 0.73, 630, 63, 10, 12, 1.0, 1.1, 12, 1.1, 330, 2.0, 685, 95, 7.7, 340, 34, 1055, 45, 8.5],
  male_19_30: [800, 100, 0.66, 625, 75, 10, 12, 1.0, 1.1, 12, 1.1, 320, 2.0, 700, 95, 6, 330, 34, 580, 45, 9.4],
  male_31_50: [800, 100, 0.66, 625, 75, 10, 12, 1.0, 1.1, 12, 1.1, 320, 2.0, 700, 95, 6, 350, 34, 580, 45, 9.4],
  male_51_70: [800, 100, 0.66, 625, 75, 10, 12, 1.0, 1.1, 12, 1.4, 320, 2.0, 700, 95, 6, 350, 34, 580, 45, 9.4],
  male_71_plus: [1000, 100, 0.66, 625, 75, 10, 12, 1.0, 1.1, 12, 1.4, 320, 2.0, 700, 95, 6, 350, 34, 580, 45, 9.4],
  female_9_13: [1100, 100, 0.76, 420, 39, 10, 9, 0.7, 0.8, 9, 0.8, 250, 1.5, 540, 73, 5.7, 200, 26, 1055, 35, 7.0],
  female_14_18: [1100, 100, 0.71, 485, 56, 10, 12, 0.9, 0.9, 11, 1.0, 330, 2.0, 685, 95, 7.9, 340, 34, 1055, 45, 7.3],
  female_19_30: [800, 100, 0.66, 500, 60, 10, 12, 0.9, 0.9, 11, 1.1, 320, 2.0, 700, 95, 8.1, 255, 34, 580, 45, 6.8],
  female_31_50: [800, 100, 0.66, 500, 60, 10, 12, 0.9, 0.9, 11, 1.1, 320, 2.0, 700, 95, 8.1, 265, 34, 580, 45, 6.8],
  female_51_70: [1000, 100, 0.66, 500, 60, 10, 12, 0.9, 0.9, 11, 1.3, 320, 2.0, 700, 95, 5, 265, 34, 580, 45, 6.8],
  female_71_plus: [1000, 100, 0.66, 500, 60, 10, 12, 0.9, 0.9, 11, 1.3, 320, 2.0, 700, 95, 5, 265, 34, 580, 45, 6.8],
  pregnancy_14_18: [1000, 135, 0.88, 530, 66, 10, 12, 1.2, 1.2, 14, 1.6, 520, 2.2, 785, 160, 23, 335, 40, 1055, 49, 10.5],
  pregnancy_19_30: [800, 135, 0.88, 550, 70, 10, 12, 1.2, 1.2, 14, 1.6, 520, 2.2, 800, 160, 22, 290, 40, 580, 49, 9.5],
  pregnancy_31_50: [800, 135, 0.88, 550, 70, 10, 12, 1.2, 1.2, 14, 1.6, 520, 2.2, 800, 160, 22, 300, 40, 580, 49, 9.5],
  lactation_14_18: [1000, 160, 1.05, 885, 96, 10, 16, 1.2, 1.3, 13, 1.7, 450, 2.4, 985, 209, 7, 300, 35, 1055, 59, 10.9],
  lactation_19_30: [800, 160, 1.05, 900, 100, 10, 16, 1.2, 1.3, 13, 1.7, 450, 2.4, 1000, 209, 6.5, 255, 36, 580, 59, 10.4],
  lactation_31_50: [800, 160, 1.05, 900, 100, 10, 16, 1.2, 1.3, 13, 1.7, 450, 2.4, 1000, 209, 6.5, 265, 36, 580, 59, 10.4],
};

// ─── Merge EAR / RDA-AI / UL into one per-life-stage nutrient map ──────────

const EAR_BY_STAGE = zipRows(EAR_COLUMNS, EAR_ROWS);
const RDA_AI_VITAMINS_BY_STAGE = zipRows(RDA_AI_VITAMIN_COLUMNS, RDA_AI_VITAMIN_ROWS);
const RDA_AI_ELEMENTS_BY_STAGE = zipRows(RDA_AI_ELEMENT_COLUMNS, RDA_AI_ELEMENT_ROWS);
const MACRO_WATER_BY_STAGE = zipRows(MACRO_WATER_COLUMNS, MACRO_WATER_ROWS);
const UL_VITAMINS_BY_STAGE = zipRows(UL_VITAMIN_COLUMNS, UL_VITAMIN_ROWS);
const UL_ELEMENTS_BY_STAGE = zipRows(UL_ELEMENT_COLUMNS, UL_ELEMENT_ROWS);

const DRI_VALUES = {};
for (const stage of DRI_LIFE_STAGES) {
  const code = stage.code;
  const isInfant = stage.life_stage_type === "infant";
  const rdaAiSource = {
    ...(RDA_AI_VITAMINS_BY_STAGE[code] || {}),
    ...(RDA_AI_ELEMENTS_BY_STAGE[code] || {}),
    ...(MACRO_WATER_BY_STAGE[code] || {}),
  };
  const ulSource = { ...(UL_VITAMINS_BY_STAGE[code] || {}), ...(UL_ELEMENTS_BY_STAGE[code] || {}) };
  const earSource = EAR_BY_STAGE[code] || {};

  const nutrients = {};
  for (const [key, value] of Object.entries(rdaAiSource)) {
    const isAi = isInfant || AI_ONLY_NUTRIENTS.has(key);
    nutrients[key] = { [isAi ? "ai" : "rda"]: value };
  }
  for (const [key, value] of Object.entries(earSource)) {
    nutrients[key] = { ...(nutrients[key] || {}), ear: value };
  }
  for (const [key, value] of Object.entries(ulSource)) {
    nutrients[key] = { ...(nutrients[key] || {}), ul: value };
  }
  DRI_VALUES[code] = nutrients;
}

// ─── AMDR (% of energy) ─────────────────────────────────────────────────────

const DRI_AMDR_BY_AGE_BUCKET = {
  children_1_3: {
    fat: { min_percent: 30, max_percent: 40 },
    n6_polyunsaturated: { min_percent: 5, max_percent: 10 },
    n3_polyunsaturated: { min_percent: 0.6, max_percent: 1.2 },
    carbohydrate: { min_percent: 45, max_percent: 65 },
    protein: { min_percent: 5, max_percent: 20 },
  },
  children_4_18: {
    fat: { min_percent: 25, max_percent: 35 },
    n6_polyunsaturated: { min_percent: 5, max_percent: 10 },
    n3_polyunsaturated: { min_percent: 0.6, max_percent: 1.2 },
    carbohydrate: { min_percent: 45, max_percent: 65 },
    protein: { min_percent: 10, max_percent: 30 },
  },
  adults: {
    fat: { min_percent: 20, max_percent: 35 },
    n6_polyunsaturated: { min_percent: 5, max_percent: 10 },
    n3_polyunsaturated: { min_percent: 0.6, max_percent: 1.2 },
    carbohydrate: { min_percent: 45, max_percent: 65 },
    protein: { min_percent: 10, max_percent: 35 },
  },
};

function amdrBucketForAge(ageYears) {
  if (ageYears == null) return "adults";
  if (ageYears >= 1 && ageYears <= 3) return "children_1_3";
  if (ageYears >= 4 && ageYears <= 18) return "children_4_18";
  return "adults";
}

// Not a numeric target — qualitative recommendations from the same source table.
const DRI_ADDITIONAL_MACRO_RECOMMENDATIONS = [
  { nutrient: "dietary_cholesterol", recommendation: "As low as possible while consuming a nutritionally adequate diet" },
  { nutrient: "trans_fatty_acids", recommendation: "As low as possible while consuming a nutritionally adequate diet" },
  { nutrient: "saturated_fatty_acids", recommendation: "As low as possible while consuming a nutritionally adequate diet" },
  { nutrient: "added_sugars", recommendation: "Limit to no more than 25% of total energy (not a recommended intake — no healthful target was set)" },
];

// Sodium Chronic Disease Risk Reduction Intake (2019) — supersedes the older
// sodium UL; "reduce intake if above" this level, by age bucket.
const DRI_SODIUM_CDRR_MG = [
  { age_min: 1, age_max: 3, mg_per_day: 1200 },
  { age_min: 4, age_max: 8, mg_per_day: 1500 },
  { age_min: 9, age_max: 13, mg_per_day: 1800 },
  { age_min: 14, age_max: 18, mg_per_day: 2300 },
  { age_min: 19, age_max: 150, mg_per_day: 2300 },
];

function sodiumCdrrForAge(ageYears) {
  if (ageYears == null) return null;
  return DRI_SODIUM_CDRR_MG.find((b) => ageYears >= b.age_min && ageYears <= b.age_max) || null;
}

// ─── Life-stage resolver ────────────────────────────────────────────────────

/**
 * Resolves {ageYears, sex, lifeStageType} to one DRI_LIFE_STAGES entry.
 * lifeStageType: "normal" (default) | "pregnancy" | "lactation".
 * Infants/children ignore sex (the source tables don't split by sex under 9y).
 * Returns null if age is missing/out of range or pregnancy/lactation is
 * requested for an age the source has no such group for (under 14).
 */
function resolveDriLifeStage(ageYears, sex, lifeStageType) {
  const age = Number(ageYears);
  if (!Number.isFinite(age) || age < 0) return null;

  if (lifeStageType === "pregnancy" || lifeStageType === "lactation") {
    if (age < 14) return null;
    return (
      DRI_LIFE_STAGES.find(
        (s) => s.life_stage_type === lifeStageType && age >= s.age_min && age <= s.age_max
      ) || DRI_LIFE_STAGES.find((s) => s.life_stage_type === lifeStageType && s.code.endsWith("31_50")) // clamp to the oldest bracket for age > 50
    );
  }

  if (age < 9) {
    return DRI_LIFE_STAGES.find((s) => (s.life_stage_type === "infant" || s.life_stage_type === "child") && age >= s.age_min && age <= s.age_max);
  }

  const normalizedSex = String(sex || "").trim().toLowerCase();
  if (normalizedSex !== "male" && normalizedSex !== "female") return null;

  return (
    DRI_LIFE_STAGES.find(
      (s) => s.life_stage_type === "normal" && s.sex === normalizedSex && age >= s.age_min && age <= s.age_max
    ) || DRI_LIFE_STAGES.find((s) => s.life_stage_type === "normal" && s.sex === normalizedSex && s.code.endsWith("71_plus")) // clamp very old ages
  );
}

export {
  DRI_LIFE_STAGES,
  DRI_NUTRIENT_META,
  DRI_VALUES,
  DRI_AMDR_BY_AGE_BUCKET,
  DRI_ADDITIONAL_MACRO_RECOMMENDATIONS,
  DRI_SODIUM_CDRR_MG,
  amdrBucketForAge,
  sodiumCdrrForAge,
  resolveDriLifeStage,
};
