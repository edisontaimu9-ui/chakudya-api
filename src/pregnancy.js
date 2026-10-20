// Pregnancy and lactation calculators (GET /pregnancy/reference, POST /pregnancy/gestational-age, /weight-gain, /plan, /assess).
// Pure functions, no I/O. Source: Krause and Mahan's Food and the Nutrition Care Process, 16th ed., chapter 14 "Nutrition in
// Pregnancy and Lactation", plus Appendix 3 (prenatal weight category table). Where the chapter gives a range the result gives the
// range. Where it contradicts itself or leaves a gap the result says so (KNOWN_ISSUES) instead of choosing silently.
//
// Reuse, not duplication
//   - Energy is the existing chapter 2 engine (computeEnergyRequirements): its pregnancy {trimester} and lactation {months_postpartum}
//     add-ons (+340 kcal in trimester 2, +452 in trimester 3, +330 / +400 for lactation) are exactly the chapter's figures. This
//     module only works out the trimester from gestational age and adds what the engine does not have.
//   - Nutrient targets come from the DRI tables behind GET /dri (pregnancy and lactation life stages), not a second copy.
//   - The pre-pregnancy BMI bands (18.5, 25, 30) match the NACS categories already used by $assess-nutrition.
//
// Conventions that are NOT in the chapter (stated in every result that uses them): pregnancy lasts 280 days from the last menstrual
// period; trimester 1 is under 14 weeks, trimester 2 is 14 to under 28 weeks, trimester 3 is 28 weeks and over.

import { computeEnergyRequirements } from "./energyEngine.js";
import { DRI_VALUES, DRI_NUTRIENT_META, resolveDriLifeStage } from "./dri_data.js";

export const SOURCE = "Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 14 (Nutrition in Pregnancy and Lactation) and Appendix 3";
const NOT_ADVICE = "Screening and planning aid from a textbook chapter. It does not replace antenatal care. Results are not a diagnosis, and any concerning value needs a clinician.";

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const present = (v) => v !== undefined && v !== null && v !== "";
const num = (v) => (present(v) ? Number(v) : NaN);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const range = (min, max, d = 0) => ({ min: round(min, d), max: round(max, d) });
const bool = (v) => v === true || v === "true" || v === 1 || v === "1";
export const KG_PER_LB = 0.45359237;
const lb = (kg) => kg / KG_PER_LB;

function readNum(inp, key, { min, max, required = false, label } = {}) {
  if (!present(inp[key])) return required ? { error: `'${key}' is required${label ? ` (${label})` : ""}` } : { value: null };
  const v = num(inp[key]);
  if (!isNum(v)) return { error: `'${key}' must be a number` };
  if ((min !== undefined && v < min) || (max !== undefined && v > max)) return { error: `'${key}' must be between ${min} and ${max}${label ? ` (${label})` : ""}` };
  return { value: v };
}
function readAll(inp, specs) {
  const out = {};
  for (const [key, opts] of Object.entries(specs)) { const r = readNum(inp, key, opts); if (r.error) return { error: r.error }; out[key] = r.value; }
  return { values: out };
}

// ─── Reference tables (transcribed from the chapter) ────────────────────────────────

/** Table 14.11 (IOM). Pre-pregnancy BMI category by BMI: under 18.5, 18.5-24.9, 25-29.9, 30 and over. */
export const WEIGHT_GAIN = {
  underweight: { label: "Underweight (BMI under 18.5)", singleton_lb: [28, 40], singleton_kg: [12.5, 18], rate_lb: { mean: 1, range: [1, 1.3] }, rate_kg: { mean: 0.51, range: [0.44, 0.58] }, twins_lb: null, twins_kg: null },
  normal: { label: "Normal weight (BMI 18.5 to 24.9)", singleton_lb: [25, 35], singleton_kg: [11.5, 16], rate_lb: { mean: 1, range: [0.8, 1] }, rate_kg: { mean: 0.42, range: [0.35, 0.5] }, twins_lb: [37, 54], twins_kg: [17, 25] },
  overweight: { label: "Overweight (BMI 25.0 to 29.9)", singleton_lb: [15, 25], singleton_kg: [7, 11.5], rate_lb: { mean: 0.6, range: [0.5, 0.7] }, rate_kg: { mean: 0.28, range: [0.23, 0.33] }, twins_lb: [31, 50], twins_kg: [14, 23] },
  obese: { label: "Obese (BMI 30 or more)", singleton_lb: [11, 20], singleton_kg: [5, 9], rate_lb: { mean: 0.5, range: [0.4, 0.6] }, rate_kg: { mean: 0.22, range: [0.17, 0.27] }, twins_lb: [25, 42], twins_kg: [11, 19] },
};
/** Footnote to Table 14.11: first-trimester gain assumed by the rates. */
export const FIRST_TRIMESTER_GAIN_KG = { standard: [1, 3], obese: [0.5, 2] };
export const MULTIPLES_NOTES = {
  3: "Target a gain of at least 36 pounds (16.3 kg) by 24 weeks for triplets. Mean gestational gain for triplets is 45 to 51 pounds (20.5 to 23 kg) at 32 to 34 weeks.",
  4: "For quadruplets the mean gain is 46 to 68 pounds (20.8 to 31 kg) at 31 to 32 weeks, but better outcomes have been seen with higher gains.",
};

/** Table 14.12 (twins). Absolute figures by pre-pregnancy category. */
export const TWINS_TABLE = {
  energy_kcal: { underweight: [4000, 4000], normal: [3000, 3500], overweight: [3250, 3250], obese: [2700, 3000] },
  protein_g: { underweight: 200, normal: 175, overweight: 163, obese: 150 },
  carbohydrate_g: { underweight: 400, normal: 350, overweight: 325, obese: 300 },
  fat_g: { underweight: 178, normal: 156, overweight: 144, obese: 133 },
  kcal_per_kg: [40, 45],
  split_percent: { protein: 20, carbohydrate: 40, fat: 40 },
  nutrients: [
    { nutrient: "Vitamin D", twins: "1000 IU/day or more as needed", comment: "Assess maternal levels in the first and early third trimesters; important if on bed rest. The table says 1000 IU raises blood level by 5 'mg/dL' (printed; the unit looks wrong)." },
    { nutrient: "Vitamin C", twins: "500 to 1000 mg/day", comment: "Half of the UL of 1800 to 2000 mg/day. See more recent cautions." },
    { nutrient: "Vitamin E", twins: "400 mg/day", comment: "Half of the UL of 800 to 1000 mg/day. See more recent cautions." },
    { nutrient: "Zinc", twins: "15 mg/day (T1); 30 to 45 mg/day (T2 to T3)", comment: "Diet alone may not be enough. Supplementation may be required." },
    { nutrient: "Iron", twins: "30 mg/day as part of 1 multivitamin/day (T1); 2 multivitamins/day (T2 and T3)", comment: "Twin requirement is likely double that of singletons. Higher intakes may be needed to treat anemia." },
    { nutrient: "Folic acid", twins: "800 to 1000 mcg/day; 4 mg if there is a history of NTD" },
    { nutrient: "Calcium", twins: "1500 mg/day (T1); 2500 to 3000 mg/day (T2 to T3)", comment: "UL: 2500 mg/day; consider limiting if there is a history of kidney stones. The printed T2 to T3 range runs above the UL it quotes." },
    { nutrient: "Magnesium", twins: "400 mg/day (T1); 800 to 1200 mg/day (T2 to T3)" },
    { nutrient: "DHA + EPA", twins: "300 to 1000 mg/day" },
  ],
};

/** Table 14.4: reference ranges. [nonpregnant, T1, T2, T3]. A bound of null is open. */
export const LAB_RANGES = {
  albumin_g_dl: { label: "Albumin", unit: "g/dL", nonpregnant: [3.5, 5.5], t1: [3.1, 5.1], t2: [2.6, 4.5], t3: [2.3, 4.2] },
  total_protein_g_dl: { label: "Total protein", unit: "g/dL", nonpregnant: [6.4, 8.3], t1: [6.2, 7.6], t2: [5.7, 6.9], t3: [5.6, 6.7] },
  cholesterol_mg_dl: { label: "Cholesterol", unit: "mg/dL", nonpregnant: [null, 200], t1: [141, 210], t2: [176, 299], t3: [219, 349] },
  triglycerides_mg_dl: { label: "Triglycerides", unit: "mg/dL", nonpregnant: [null, 150], t1: [40, 159], t2: [75, 382], t3: [131, 453] },
  vitamin_a_mcg_dl: { label: "Vitamin A", unit: "µg/dL", nonpregnant: [20, 80], t1: [32, 47], t2: [35, 52], t3: [29, 51] },
  vitamin_b12_pg_ml: { label: "Vitamin B12", unit: "pg/mL", nonpregnant: [279, 996], t1: [118, 438], t2: [130, 656], t3: [99, 526] },
  vitamin_c_mg_dl: { label: "Vitamin C", unit: "mg/dL", nonpregnant: [0.6, 2], t1: null, t2: null, t3: [0.9, 1.3] },
  vitamin_d_ng_ml: { label: "Vitamin D (25-OH)", unit: "ng/mL", nonpregnant: [20, 100], t1: null, t2: null, t3: null },
  vitamin_e_mcg_ml: { label: "Vitamin E", unit: "µg/mL", nonpregnant: [5, 18], t1: [7, 16], t2: [10, 23], t3: [13, 23] },
  folate_rbc_ng_ml: { label: "Folate (RBC)", unit: "ng/mL", nonpregnant: [150, 450], t1: [137, 589], t2: [94, 828], t3: [109, 663] },
  calcium_mg_dl: { label: "Calcium", unit: "mg/dL", nonpregnant: [8.6, 10.2], t1: [8.8, 10.6], t2: [8.2, 9.0], t3: [8.2, 9.7] },
  copper_mcg_dl: { label: "Copper", unit: "µg/dL", nonpregnant: [70, 155], t1: [112, 199], t2: [165, 295], t3: [130, 330] },
  ferritin_ng_ml: { label: "Ferritin", unit: "ng/mL", nonpregnant: [12, 150], t1: [6, 130], t2: [2, 230], t3: [0, 116] },
  hemoglobin_g_dl: { label: "Hemoglobin", unit: "g/dL", nonpregnant: [12, 15.8], t1: [11.6, 13.9], t2: [9.7, 14.8], t3: [9.5, 15] },
  hematocrit_percent: { label: "Hematocrit", unit: "%", nonpregnant: [35.4, 44.4], t1: [31, 41], t2: [30, 39], t3: [28, 40] },
  magnesium_mg_dl: { label: "Magnesium", unit: "mg/dL", nonpregnant: [1.5, 2.5], t1: [1.6, 2.2], t2: [1.5, 2.2], t3: [1.1, 2.2] },
  selenium_mcg_l: { label: "Selenium", unit: "µg/L", nonpregnant: [63, 160], t1: [116, 556], t2: [119, 218], t3: [118, 218] },
  zinc_mcg_dl: { label: "Zinc", unit: "µg/dL", nonpregnant: [60, 120], t1: [57, 88], t2: [51, 80], t3: [50, 77] },
};

/** Table 14.5: prenatal anemia cut-points at sea level. */
export const ANEMIA_CUTPOINTS = { 1: { hb: 11.0, hct: 33.0 }, 2: { hb: 10.5, hct: 32.0 }, 3: { hb: 11.0, hct: 33.0 } };
/** Altitude adjustments to ADD to the cut-points: [feet from, feet to, hb low, hb high, hct]. Rows given in metres only come last. */
export const ALTITUDE_ADJUSTMENTS = [
  { label: "under 3000 ft (under 1000 m)", ft: [0, 2999], hb: [0, 0], hct: 0 },
  { label: "3000 to 3999 ft (1000 m)", ft: [3000, 3999], hb: [0.2, 0.2], hct: 0.5 },
  { label: "4000 to 4999 ft", ft: [4000, 4999], hb: [0.3, 0.3], hct: 1.0 },
  { label: "5000 to 5999 ft (1500 m)", ft: [5000, 5999], hb: [0.5, 0.5], hct: 1.5 },
  { label: "6000 to 6999 ft (2000 m)", ft: [6000, 6999], hb: [0.7, 0.8], hct: 2.0 },
  { label: "7000 to 7999 ft", ft: [7000, 7999], hb: [1.0, 1.0], hct: 3.0 },
  { label: "8000 to 8999 ft (2500 m)", ft: [8000, 8999], hb: [1.3, 1.3], hct: 4.0 },
  { label: "9000 to 9999 ft (3000 m)", ft: [9000, 9999], hb: [1.6, 1.9], hct: 5.0 },
  { label: "10,000 to 11,000 ft", ft: [10000, 11000], hb: [2.0, 2.0], hct: 6.0 },
  { label: "3500 m", m: 3500, hb: [2.7, 2.7], hct: 8.0 },
  { label: "4000 m", m: 4000, hb: [3.5, 3.5], hct: 10.5 },
  { label: "4500 m", m: 4500, hb: [4.5, 4.5], hct: 13.5 },
];
/** Cigarette smoking adjustments to add: [pack/day from, hb, hct]. */
export const SMOKING_ADJUSTMENTS = [
  { label: "0.5 to under 1.0 pack per day", hb: 0.3, hct: 1.0 }, { label: "1.0 to under 2.0 packs per day", hb: 0.5, hct: 1.5 }, { label: "2.0 or more packs per day", hb: 0.7, hct: 2.0 }, { label: "all smokers", hb: 0.3, hct: 1.0 },
];

/** Table 14.14. mg/dL. */
export const GDM = {
  screen_50g_one_hour: [130, 135, 140],
  ogtt_100g: { carpenter_coustan: { fasting: 95, one_hour: 180, two_hour: 155, three_hour: 140 }, nddg: { fasting: 105, one_hour: 190, two_hour: 165, three_hour: 145 }, rule: "Two or more values at or above the cut-point" },
  ogtt_75g: { iadpsg: { fasting: 92, one_hour: 180, two_hour: 153, rule: "One value at or above" }, who: { fasting: [92, 125], one_hour: 180, two_hour: [153, 199], rule: "One value in range or above. Fasting above 125 or 2 h at 200 or more is diabetes in pregnancy, not GDM" } },
  random_diabetes: 200,
};

/** Box 14.4 preeclampsia criteria. */
export const PREECLAMPSIA = {
  bp: "Confirmed 160 or more systolic or 110 or more diastolic at any time (confirmed over a few minutes), or 140 or more / 90 or more after 20 weeks (confirmed over 4 h) if previously normal",
  proteinuria: "300 mg or more in a 24 h urine, protein/creatinine ratio of 0.3 or more, or a dipstick of 2+ if no quantitative method is available",
  organ_features: ["platelets under 100,000/µL", "serum creatinine over 1.1 mg/dL or doubling", "liver transaminases at twice normal", "pulmonary edema", "cerebral or visual symptoms"],
};

/** Nutrient notes printed in the chapter text (verified). */
export const NUTRIENT_NOTES = [
  { nutrient: "Folic acid", note: "The DRI of 600 µg DFE is met partly from food folate; the chapter's supplement figures are synthetic folic acid. USPSTF: 400 to 800 µg/day preconceptually. After a previous neural tube defect-affected pregnancy: 400 µg/day when not planning, and 4000 µg (4 mg)/day from 3 months before to 3 months after conception (ACOG). The higher dose should be a separate supplement, not a multivitamin." },
  { nutrient: "Iron", note: "DRI 27 mg/day. Prescribed supplements are usually a ferrous salt (better absorbed), taken with a vitamin C source and away from coffee, tea and milk." },
  { nutrient: "Calcium", note: "DRI 1000 mg/day (1300 for ages 14 to 18). Supplementation may reduce preeclampsia severity if baseline intake is under 600 mg/day (ACOG)." },
  { nutrient: "DHA", note: "Fatty fish low in methylmercury twice a week; about 200 mg/day on average is the usual target." },
  { nutrient: "Caffeine", note: "Under 200 mg/day was not linked to miscarriage, low birth weight or preterm birth. The effect cannot be determined definitively, and the half-life of caffeine is longer in pregnancy. Energy drinks and energy shots are not recommended (they can exceed 500 mg)." },
  { nutrient: "Vitamins C and E", note: "Supplements do not prevent preeclampsia and may be linked to a higher risk of gestational hypertension and low birth weight." },
];

/** Things in the chapter that disagree with themselves or leave gaps. */
export const KNOWN_ISSUES = [
  { id: "no_trimester_boundaries", where: "Scope", issue: "The chapter gives no trimester week boundaries and no due-date rule.", handling: "280 days from the last menstrual period; trimester 1 under 14 weeks, trimester 2 from 14 to under 28, trimester 3 from 28 weeks. Stated in every result as a convention." },
  { id: "second_half_definition", where: "Protein", issue: "The protein RDA changes in the 'second half of pregnancy' without a week number.", handling: "20 weeks (half of 40) is used and stated." },
  { id: "expected_gain_derived", where: "Table 14.11", issue: "The chapter prints total gain, a weekly rate for trimesters 2 and 3, and the first-trimester assumption (1 to 3 kg; 0.5 to 2 kg if obese), but no week-by-week curve (the chart is a graph in Appendix 3).", handling: "The expected range at a given week is a straight line from the first-trimester allowance at 13 weeks to the printed total at 40 weeks, labelled approximate." },
  { id: "underweight_twins", where: "Table 14.11", issue: "No twin gain guideline is printed for underweight women (insufficient information), and the twin guideline is called provisional.", handling: "No range is returned; the result says so." },
  { id: "twins_kcal_per_kg", where: "Table 14.12", issue: "The table prints absolute energy by BMI category (for example normal weight 3000 to 3500 kcal) next to 40 to 45 kcal/kg, which disagree for many body weights.", handling: "Both are returned; the weight the per-kg figure applies to is not stated, so current weight is used and labelled." },
  { id: "twins_calcium_above_ul", where: "Table 14.12", issue: "Calcium 2500 to 3000 mg/day in trimesters 2 and 3 is printed beside a UL of 2500 mg/day.", handling: "Returned as printed with the UL beside it." },
  { id: "twins_vitamin_d_unit", where: "Table 14.12", issue: "Vitamin D 1000 IU is said to raise blood level by '5 mg/dL', which is not a plausible unit.", handling: "Returned as printed, with the doubt noted." },
  { id: "protein_rda_vs_need", where: "Protein", issue: "The protein RDA is 0.8 g/kg in the first half and 1.1 g/kg in the second half (on current weight), but amino acid oxidation studies cited in the chapter suggest higher needs late in pregnancy (about 1.2 to 1.52 g/kg).", handling: "The RDA is returned with a note, never overridden." },
  { id: "adolescent_gain", where: "Adolescent Pregnancy", issue: "The chapter lists risk factors for adolescents (Box 14.3) but prints no separate weight-gain figures or BMI categories for them.", handling: "The adult BMI bands and the IOM ranges are used and the result adds the Box 14.3 risk factors." },
  { id: "appendix_3_edges", where: "Appendix 3", issue: "At the edges of a category the printed weights can differ from the BMI formula the table itself gives (BMI = lb / in2 x 703) by up to about 1.5 lb. For example at 4 ft 9 in, 85 lb is printed as normal weight but its BMI is 18.4.", handling: "The BMI formula is used, so a weight within 1 or 2 lb of a printed boundary can fall in the neighbouring category." },
  { id: "dri_folate_unit", where: "Folate", issue: "The chapter's supplement figures are folic acid (µg), while the DRI is in µg DFE.", handling: "The DRI value is returned in DFE and the supplement notes are kept separate." },
];

// ─── Dates and gestational age ──────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dayNumber(s) {
  const m = DATE_RE.exec(String(s ?? ""));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t / 86400000;
}
const isoOf = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

export function trimesterOf(weeksFloat) { return weeksFloat < 14 ? 1 : weeksFloat < 28 ? 2 : 3; }

/**
 * One of: lmp (YYYY-MM-DD) | edd (YYYY-MM-DD) | ga_weeks (+ ga_days). reference_date defaults to ctx.today (the server's date).
 * With ga_weeks the gestational age is taken as at reference_date.
 */
export function computeGestationalAge(input, ctx = {}) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const given = ["lmp", "edd", "ga_weeks"].filter((k) => present(inp[k]));
  if (given.length !== 1) return { ok: false, error: "give exactly one of lmp (last menstrual period), edd (due date) or ga_weeks (with optional ga_days)" };
  const refStr = present(inp.reference_date) ? inp.reference_date : ctx.today;
  const ref = dayNumber(refStr);
  if (ref === null) return { ok: false, error: present(inp.reference_date) ? "'reference_date' must be a real date written YYYY-MM-DD" : "no reference date: send reference_date (YYYY-MM-DD)" };
  const warnings = []; const notes = [];
  let lmp;
  if (given[0] === "lmp") { const d = dayNumber(inp.lmp); if (d === null) return { ok: false, error: "'lmp' must be a real date written YYYY-MM-DD" }; lmp = d; }
  else if (given[0] === "edd") { const d = dayNumber(inp.edd); if (d === null) return { ok: false, error: "'edd' must be a real date written YYYY-MM-DD" }; lmp = d - 280; }
  else {
    const r = readAll(inp, { ga_weeks: { min: 0, max: 45, required: true }, ga_days: { min: 0, max: 6 } });
    if (r.error) return { ok: false, error: r.error };
    if (!Number.isInteger(r.values.ga_weeks)) return { ok: false, error: "'ga_weeks' must be a whole number; put the extra days in 'ga_days' (0 to 6)" };
    if (r.values.ga_days !== null && !Number.isInteger(r.values.ga_days)) return { ok: false, error: "'ga_days' must be a whole number from 0 to 6" };
    lmp = ref - (r.values.ga_weeks * 7 + (r.values.ga_days ?? 0));
  }
  const totalDays = ref - lmp;
  if (totalDays < 0) return { ok: false, error: "the reference date is before the last menstrual period (or the due date is more than 280 days after the reference date)" };
  if (totalDays > 45 * 7) return { ok: false, error: "that is over 45 weeks of gestation. Check the dates." };
  const weeks = Math.floor(totalDays / 7); const days = totalDays % 7; const wf = totalDays / 7;
  const edd = lmp + 280;
  const tri = trimesterOf(wf);
  if (totalDays > 294) warnings.push("Over 42 weeks: post-term.");
  else if (totalDays >= 259 && totalDays < 280) notes.push("Term (37 weeks or more).");
  notes.push("Dating conventions are not from the chapter: 280 days from the last menstrual period; trimester 1 under 14 weeks, 2 from 14 to under 28, 3 from 28 weeks.");
  const milestones = {
    first_trimester_weight_gain_window: wf < 14,
    weight_gain_rate_phase: wf >= 14,
    protein_phase: wf < 20 ? "first_half" : "second_half",
    gdm_screening_window: { weeks: [24, 28], status: wf < 24 ? "not_yet" : wf <= 28 + 6 / 7 ? "in_window" : "past" },
    preeclampsia_criteria_apply: wf >= 20,
  };
  return {
    ok: true,
    data: {
      lmp: isoOf(lmp), edd: isoOf(edd), reference_date: isoOf(ref),
      gestational_age: { weeks, days, total_days: totalDays, display: `${weeks}w${days}d`, decimal_weeks: round(wf, 2) },
      trimester: tri, weeks_to_edd: round((edd - ref) / 7, 1), days_to_edd: edd - ref,
      milestones, warnings, notes, sources: [SOURCE + " (dating conventions are not from the chapter)"], disclaimer: NOT_ADVICE,
    },
  };
}

/** Gestational age for the other endpoints: from lmp | edd | ga_weeks (+ga_days). Returns { ok, ga } or { ok: false, error }. */
function gestationFrom(inp, ctx) {
  const g = computeGestationalAge({ lmp: inp.lmp, edd: inp.edd, ga_weeks: inp.ga_weeks, ga_days: inp.ga_days, reference_date: inp.reference_date }, ctx);
  return g.ok ? { ok: true, ga: g.data } : g;
}

// ─── Pre-pregnancy BMI category and weight gain ─────────────────────────────────────

export function prepregnancyCategory(bmi) { return bmi < 18.5 ? "underweight" : bmi < 25 ? "normal" : bmi < 30 ? "overweight" : "obese"; }
const bmiOf = (kg, cm) => kg / (cm / 100) ** 2;
const adolescentRisk = ["Young maternal age", "Pregnancy less than 2 years after menarche", "Poor nutrition and low pre-pregnancy weight", "Preexisting anemia", "Gain that is too low or too high", "Obesity", "Substance use (smoking, drinking, drugs)", "Lack of social support and of age-appropriate prenatal care", "Late entry into care"];

/**
 * pre_pregnancy_weight_kg + height_cm | prepregnancy_bmi; multiples (1-4, default 1); age_years?;
 * optional current_weight_kg with lmp | edd | ga_weeks (+ga_days) for the status; weigh_ins [{ date, weight_kg }] with lmp | edd.
 */
export function computePregnancyWeightGain(input, ctx = {}) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, { pre_pregnancy_weight_kg: { min: 30, max: 250 }, height_cm: { min: 120, max: 210 }, prepregnancy_bmi: { min: 12, max: 70 }, multiples: { min: 1, max: 4 }, age_years: { min: 10, max: 55 }, current_weight_kg: { min: 30, max: 300 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const warnings = []; const notes = [];
  let bmi;
  if (v.prepregnancy_bmi !== null) { if (v.pre_pregnancy_weight_kg !== null) return { ok: false, error: "give prepregnancy_bmi or pre_pregnancy_weight_kg with height_cm, not both" }; bmi = v.prepregnancy_bmi; }
  else { if (v.pre_pregnancy_weight_kg === null || v.height_cm === null) return { ok: false, error: "give pre_pregnancy_weight_kg and height_cm, or prepregnancy_bmi" }; bmi = bmiOf(v.pre_pregnancy_weight_kg, v.height_cm); }
  const multiples = v.multiples ?? 1;
  if (!Number.isInteger(multiples)) return { ok: false, error: "'multiples' must be a whole number: 1, 2, 3 or 4" };
  const cat = prepregnancyCategory(bmi);
  const g = WEIGHT_GAIN[cat];
  const data = {
    inputs_used: { bmi: round(bmi, 1), pre_pregnancy_weight_kg: v.pre_pregnancy_weight_kg, height_cm: v.height_cm, multiples, age_years: v.age_years },
    prepregnancy_category: { id: cat, label: g.label, source: "Table 14.11 and Appendix 3" },
    warnings, notes,
  };
  if (v.age_years !== null && v.age_years < 19) { data.adolescent_risk_factors = adolescentRisk; notes.push("Pregnant adolescent: the chapter prints no separate gain figures or BMI categories, so the adult bands and IOM ranges are used. Box 14.3 lists risk factors for poor outcome."); }
  const first = cat === "obese" ? FIRST_TRIMESTER_GAIN_KG.obese : FIRST_TRIMESTER_GAIN_KG.standard;
  let total; let totalKg;
  if (multiples === 1) {
    total = g.singleton_lb; totalKg = g.singleton_kg;
    data.total_gain = { kg: range(...totalKg, 1), lb: range(...total, 1) };
    data.first_trimester_allowance = { kg: range(...first, 1), lb: range(first[0] / KG_PER_LB, first[1] / KG_PER_LB, 1), note: "The weekly rates assume this first-trimester gain." };
    data.weekly_rate_2nd_3rd_trimester = { kg_mean: g.rate_kg.mean, kg: range(...g.rate_kg.range, 2), lb_mean: g.rate_lb.mean, lb: range(...g.rate_lb.range, 2) };
  } else if (multiples === 2) {
    total = g.twins_lb; totalKg = g.twins_kg;
    if (!total) { data.total_gain = null; notes.push("Underweight with twins: the chapter has insufficient information for a guideline. No range is given."); }
    else { data.total_gain = { kg: range(...totalKg, 1), lb: range(...total, 1), provisional: true }; notes.push("Twin guidelines are provisional (IOM). No weekly rate is printed for twins."); }
  } else {
    data.total_gain = null; data.multiples_note = MULTIPLES_NOTES[multiples];
    notes.push("For triplets and quadruplets the chapter gives only the figures in multiples_note, not a BMI-based range.");
  }

  // status against the range at a given gestation
  const lo = totalKg ? totalKg[0] : null; const hi = totalKg ? totalKg[1] : null;
  const expectedAt = (wf) => {
    if (multiples !== 1 || lo === null) return null;
    if (wf < 13) return null;
    const t = Math.min(1, (wf - 13) / 27);
    return { min: first[0] + (lo - first[0]) * t, max: first[1] + (hi - first[1]) * t };
  };
  const statusOf = (gainKg, wf) => {
    if (lo === null) return { status: "no_guideline" };
    if (multiples !== 1) return { status: gainKg > hi ? "above_total_range" : gainKg >= lo ? "at_or_above_minimum" : "below_total_range_so_far" };
    if (wf < 13) return { status: gainKg > first[1] ? "above_first_trimester_allowance" : "within_or_below_first_trimester_allowance", allowance_kg: range(...first, 1) };
    const e = expectedAt(wf);
    return { status: gainKg < e.min ? "below" : gainKg > e.max ? "above" : "within", expected_kg: range(e.min, e.max, 1) };
  };
  const basis = v.pre_pregnancy_weight_kg;
  if (v.current_weight_kg !== null) {
    if (basis === null) return { ok: false, error: "current_weight_kg needs pre_pregnancy_weight_kg to work out the gain" };
    const gs = gestationFrom(inp, ctx);
    if (!gs.ok) return { ok: false, error: `gestational age: ${gs.error}` };
    const gain = v.current_weight_kg - basis; const wf = gs.ga.gestational_age.decimal_weeks;
    const st = statusOf(gain, wf);
    data.current = { gestational_age: gs.ga.gestational_age, trimester: gs.ga.trimester, current_weight_kg: v.current_weight_kg, gain_kg: round(gain, 1), gain_lb: round(lb(gain), 1), ...st };
    if (multiples === 1 && wf >= 13) notes.push("The expected range at this week is approximate: a straight line from the first-trimester allowance at 13 weeks to the printed total at 40 weeks. The chapter prints no weekly curve.");
    if (st.status === "below") warnings.push("Gain is below the expected range. Low gain, especially with a low pre-pregnancy weight, is linked to small-for-gestational-age babies and spontaneous preterm delivery.");
    if (st.status === "above" || st.status === "above_first_trimester_allowance" || st.status === "above_total_range") warnings.push("Gain is above the expected range. Excess gain often leads to large-for-gestational-age babies, with increased risk at delivery, and is the strongest predictor of later maternal obesity.");
    if (st.status === "above" || st.status === "above_total_range") notes.push("The aim is gain within the range from here on, not weight loss. Adjust food quality and activity rather than restricting energy sharply.");
  }
  if (Array.isArray(inp.weigh_ins) && inp.weigh_ins.length) {
    if (basis === null) return { ok: false, error: "weigh_ins need pre_pregnancy_weight_kg" };
    if (inp.weigh_ins.length > 60) return { ok: false, error: "at most 60 weigh-ins" };
    if (!present(inp.lmp) && !present(inp.edd)) return { ok: false, error: "weigh_ins need lmp or edd so each date has a gestational age" };
    const base = present(inp.lmp) ? dayNumber(inp.lmp) : (dayNumber(inp.edd) === null ? null : dayNumber(inp.edd) - 280);
    if (base === null) return { ok: false, error: "'lmp' or 'edd' must be a real date written YYYY-MM-DD" };
    const pts = [];
    for (const [i, w] of inp.weigh_ins.entries()) {
      const d = dayNumber(w?.date); const kg = num(w?.weight_kg);
      if (d === null) return { ok: false, error: `weigh_ins[${i}].date must be a real date written YYYY-MM-DD` };
      if (!isNum(kg) || kg < 30 || kg > 300) return { ok: false, error: `weigh_ins[${i}].weight_kg must be between 30 and 300` };
      if (d < base || d - base > 45 * 7) return { ok: false, error: `weigh_ins[${i}].date is outside the pregnancy` };
      pts.push({ day: d, kg, date: w.date });
    }
    pts.sort((a, b) => a.day - b.day);
    data.series = pts.map((p) => { const wf = (p.day - base) / 7; const gain = p.kg - basis; return { date: p.date, gestational_weeks: round(wf, 1), weight_kg: p.kg, gain_kg: round(gain, 1), ...statusOf(gain, wf) }; });
    if (pts.length >= 2) {
      const a = pts[pts.length - 2]; const b = pts[pts.length - 1];
      if (b.day - a.day >= 7 && (b.day - base) / 7 >= 14 && multiples === 1) {
        const rate = (b.kg - a.kg) / ((b.day - a.day) / 7);
        const band = g.rate_kg.range;
        data.recent_rate = { kg_per_week: round(rate, 2), lb_per_week: round(lb(rate), 2), guideline_kg_per_week: range(...band, 2), status: rate < band[0] ? "below" : rate > band[1] ? "above" : "within", note: "Rate between the last two weigh-ins at least a week apart, in the second or third trimester. Single intervals are noisy; look at the trend." };
      }
    }
  }
  data.sources = [SOURCE + " - Table 14.11 (IOM), Table 14.12, Appendix 3"]; data.disclaimer = NOT_ADVICE;
  return { ok: true, data };
}

// ─── Plan: energy, protein, nutrient targets (pregnancy and lactation) ───────────────

const KEY_NUTRIENTS = ["protein_g", "carbs_g", "fiber_g", "water_l", "linoleic_acid_g", "ala_g", "folate_mcg", "iron_mg", "calcium_mg", "vitd_mcg", "iodine_mcg", "choline_mg", "vitb12_mcg", "vitb6_mg", "vita_rae_mcg", "vitc_mg", "vite_mg", "zinc_mg", "magnesium_mg", "selenium_mcg", "copper_mcg"];
const ENGINE_KEYS = ["pal", "pal_category", "activities", "activity_factor", "activity_position"];

function driTargets(age, kind) {
  const stage = resolveDriLifeStage(age, "female", kind);
  const base = resolveDriLifeStage(age, "female", "normal");
  if (!stage) return { error: `no DRI life stage for age ${age} (the DRI pregnancy and lactation stages cover ages 14 to 50)` };
  const values = DRI_VALUES[stage.code] || {}; const bvalues = base ? DRI_VALUES[base.code] || {} : {};
  const rows = [];
  for (const k of KEY_NUTRIENTS) {
    const val = values[k]; if (!val) continue;
    const meta = DRI_NUTRIENT_META[k] || {};
    const target = val.rda ?? val.ai ?? null; const bt = bvalues[k] ? (bvalues[k].rda ?? bvalues[k].ai ?? null) : null;
    rows.push({ key: k, label: meta.label || k, unit: meta.unit || null, rda: val.rda ?? null, ai: val.ai ?? null, ear: val.ear ?? null, ul: val.ul ?? null, nonpregnant_target: bt, percent_of_nonpregnant: target !== null && bt ? round((target / bt) * 100, 0) : null });
  }
  return { stage: { code: stage.code, label: stage.label }, nonpregnant_stage: base ? { code: base.code, label: base.label } : null, rows };
}

/**
 * status: "pregnant" | "lactating"; age_years (14-50); pre_pregnancy_weight_kg; height_cm; an activity input (pal_category | pal |
 * activities | activity_factor) for the engine; pregnant: lmp | edd | ga_weeks (+ga_days), current_weight_kg?, multiples?;
 * lactating: months_postpartum (0-24).
 */
export function computePregnancyPlan(input, ctx = {}) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const status = String(inp.status ?? "").trim().toLowerCase();
  if (!["pregnant", "lactating"].includes(status)) return { ok: false, error: "'status' is required: pregnant or lactating" };
  const r = readAll(inp, { age_years: { min: 14, max: 50, required: true, label: "the DRI pregnancy and lactation stages" }, pre_pregnancy_weight_kg: { min: 30, max: 250, required: true, label: "kilograms before pregnancy" }, height_cm: { min: 120, max: 210, required: true }, current_weight_kg: { min: 30, max: 300 }, months_postpartum: { min: 0, max: 24 }, multiples: { min: 1, max: 4 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const warnings = []; const notes = [];
  const bmi = bmiOf(v.pre_pregnancy_weight_kg, v.height_cm);
  const cat = prepregnancyCategory(bmi);
  const head = { status, inputs_used: { age_years: v.age_years, pre_pregnancy_weight_kg: v.pre_pregnancy_weight_kg, height_cm: v.height_cm, prepregnancy_bmi: round(bmi, 1) }, prepregnancy_category: { id: cat, label: WEIGHT_GAIN[cat].label } };
  if (v.age_years < 19) { head.adolescent_risk_factors = adolescentRisk; notes.push("Pregnant adolescent: the chapter prints no separate adult-style BMI categories for teens, so adult bands are used. Box 14.3 lists risk factors for poor outcome."); }
  const eng = { sex: "female", age_years: v.age_years, weight_kg: v.pre_pregnancy_weight_kg, height_cm: v.height_cm };
  for (const k of ENGINE_KEYS) if (present(inp[k])) eng[k] = inp[k];

  if (status === "pregnant") {
    const multiples = v.multiples ?? 1;
    if (!Number.isInteger(multiples)) return { ok: false, error: "'multiples' must be a whole number: 1, 2, 3 or 4" };
    const gs = gestationFrom(inp, ctx);
    if (!gs.ok) return { ok: false, error: `gestational age: ${gs.error}` };
    const ga = gs.ga; const wf = ga.gestational_age.decimal_weeks; const tri = ga.trimester;
    const cw = v.current_weight_kg ?? v.pre_pregnancy_weight_kg;
    if (v.current_weight_kg === null) notes.push("No current_weight_kg: protein per kg uses the pre-pregnancy weight. The chapter's protein RDA is per kg of current weight.");
    const dri = driTargets(v.age_years, "pregnancy");
    if (dri.error) return { ok: false, error: dri.error };
    // energy from the engine (singleton add-ons)
    eng.pregnancy = { trimester: tri };
    const e = computeEnergyRequirements(eng);
    if (!present(inp.maintenance_kcal) && !e.ok) return { ok: false, error: `energy: ${e.error}` };
    let energy = null;
    if (present(inp.maintenance_kcal)) {
      const m = num(inp.maintenance_kcal);
      if (!isNum(m) || m < 1000 || m > 6000) return { ok: false, error: "'maintenance_kcal' must be between 1000 and 6000 (the pre-pregnancy requirement)" };
      const add = tri === 1 ? 0 : tri === 2 ? 340 : 452;
      energy = { kcal: round(m + add), pre_pregnancy_kcal: round(m), add_on_kcal: add, source: "supplied pre-pregnancy requirement plus the chapter's add-on", estimate_id: null };
    } else if (e.data.recommended) {
      const comp = e.data.components;
      const add = tri === 1 ? 0 : tri === 2 ? 340 : 452;
      energy = { kcal: e.data.recommended.kcal, pre_pregnancy_kcal: e.data.recommended.kcal - add, add_on_kcal: add, source: "POST /energy/requirements (chapter 2 engine)", estimate_id: e.data.recommended.id, reason: e.data.recommended.reason, components: comp ?? null };
    } else return { ok: false, error: "energy could not be estimated from these inputs. Send an activity level (pal_category: sedentary, low_active, active or very_active), an activity_factor, or maintenance_kcal." };
    if (tri === 1) notes.push("No extra energy is needed in the first trimester.");
    const proteinPerKg = wf < 20 ? 0.8 : 1.1;
    const protein = { g_per_kg: proteinPerKg, grams: round(proteinPerKg * cw), basis: v.current_weight_kg === null ? "pre-pregnancy weight (no current weight given)" : "current weight", phase: wf < 20 ? "first half (under 20 weeks)" : "second half (20 weeks and over)", dri_reference_woman_g: DRI_VALUES[dri.stage.code]?.protein_g?.rda ?? null, note: "RDA of 0.8 g/kg in the first half and 1.1 g/kg in the second half. Amino acid oxidation studies cited in the chapter suggest higher needs late in pregnancy (about 1.2 to 1.52 g/kg). The RDA is not overridden here." };
    if (energy) protein.percent_of_energy = round(((protein.grams * 4) / energy.kcal) * 100, 1);
    const data = {
      ...head, gestational_age: { ...ga.gestational_age, trimester: tri, edd: ga.edd }, trimester: tri, multiples,
      energy: multiples === 1 ? energy : { singleton_estimate_not_for_multiples: energy, note: "The engine's add-ons are for singleton pregnancies. For twins use the twin table below." },
      protein, dri_targets: dri, nutrient_notes: NUTRIENT_NOTES,
      weight_gain_goal: computePregnancyWeightGain({ pre_pregnancy_weight_kg: v.pre_pregnancy_weight_kg, height_cm: v.height_cm, multiples, age_years: v.age_years, ...(v.current_weight_kg !== null ? { current_weight_kg: v.current_weight_kg, lmp: ga.lmp, reference_date: ga.reference_date } : {}) }, ctx).data,
      warnings, notes,
    };
    if (multiples === 2) {
      const t = TWINS_TABLE; const k = cat;
      data.twins = {
        category: cat, energy_kcal: range(...t.energy_kcal[k]), protein_g: t.protein_g[k], carbohydrate_g: t.carbohydrate_g[k], fat_g: t.fat_g[k],
        per_kg_estimate: { kcal: range(t.kcal_per_kg[0] * cw, t.kcal_per_kg[1] * cw), basis: v.current_weight_kg === null ? "pre-pregnancy weight" : "current weight" },
        split_percent: t.split_percent, nutrients: t.nutrients,
        notes: ["Estimated needs are 40 to 45 kcal/kg. Monitor weight gain and modify calories to meet target weight goals.", "Choose concentrated sources of protein as space becomes limiting; encourage low-glycemic carbohydrate choices and healthy fats; a woman carrying twins may need to eat very frequently.", "The table's absolute energy and the per-kg figure disagree for many body weights; both are shown."],
      };
      if (cat === "underweight") data.twins.notes.push("Underweight with twins has no weight-gain guideline in the chapter.");
    } else if (multiples >= 3) { data.multiples_note = MULTIPLES_NOTES[multiples]; notes.push("The chapter gives no energy or nutrient table for triplets or more; a clinician or dietitian should individualize."); }
    return { ok: true, data: { ...data, sources: [SOURCE + " - Energy, Protein, Weight Gain, Table 14.12; DRI tables (GET /dri); chapter 2 energy engine"], disclaimer: NOT_ADVICE } };
  }

  // lactation
  if (v.months_postpartum === null) return { ok: false, error: "'months_postpartum' is required for status lactating (0 to 24)" };
  const dri = driTargets(v.age_years, "lactation");
  if (dri.error) return { ok: false, error: dri.error };
  eng.lactation = { months_postpartum: v.months_postpartum };
  const e = computeEnergyRequirements(eng);
  let energy;
  if (present(inp.maintenance_kcal)) {
    const m = num(inp.maintenance_kcal);
    if (!isNum(m) || m < 1000 || m > 6000) return { ok: false, error: "'maintenance_kcal' must be between 1000 and 6000" };
    const add = v.months_postpartum <= 6 ? 330 : 400;
    energy = { kcal: round(m + add), pre_pregnancy_kcal: round(m), add_on_kcal: add, source: "supplied pre-pregnancy requirement plus the chapter's add-on", estimate_id: null };
  } else if (e.ok && e.data.recommended) {
    const add = v.months_postpartum <= 6 ? 330 : 400;
    energy = { kcal: e.data.recommended.kcal, pre_pregnancy_kcal: e.data.recommended.kcal - add, add_on_kcal: add, source: "POST /energy/requirements (chapter 2 engine)", estimate_id: e.data.recommended.id, reason: e.data.recommended.reason };
  } else return { ok: false, error: e.ok ? "energy could not be estimated from these inputs. Send an activity level (pal_category), an activity_factor, or maintenance_kcal." : `energy: ${e.error}` };
  const minimum = 1800;
  if (energy.kcal < minimum) warnings.push(`The estimate is below ${minimum} kcal/day, the chapter's minimum for breastfeeding. Milk production decreases when intake is under about 1500 to 1800 kcal/day.`);
  const baseProteinG = DRI_VALUES[resolveDriLifeStage(v.age_years, "female", "normal")?.code]?.protein_g?.rda ?? 46;
  return {
    ok: true,
    data: {
      ...head, months_postpartum: v.months_postpartum,
      energy: { ...energy, minimum_kcal: minimum, add_on_rule: "+330 kcal/day for months 0 to 6 and +400 kcal/day for months 7 to 12 (the engine's figures; the chapter's figures agree)" },
      protein: { additional_g: 25, note: "About an additional 25 g/day over the pre-pregnancy base, which often means 20% of energy from protein.", reference_base_g: baseProteinG, approximate_total_g: round(baseProteinG + 25), percent_of_energy_if_total: round(((baseProteinG + 25) * 4 / energy.kcal) * 100, 1) },
      fat_stores: "A mother can draw about 100 to 150 kcal/day from pregnancy fat stores, which is part of why the add-on is smaller than the energy cost of milk.",
      weight_loss: { advised_early: false, rule: "Intentional weight loss is not advised before breastfeeding is well established (about 2 months). Healthy breastfeeding women can lose as much as 1 lb (0.45 kg) a week and still supply enough milk, and exclusive breastfeeding was linked to greater postpartum weight loss.", months_postpartum: v.months_postpartum, loss_may_be_considered: v.months_postpartum >= 2 },
      dha: "DHA from fatty fish low in methylmercury twice a week.",
      dri_targets: dri, nutrient_notes: NUTRIENT_NOTES.filter((n) => ["Iron", "Calcium", "DHA", "Caffeine"].includes(n.nutrient)),
      warnings, notes,
      sources: [SOURCE + " - Lactation, Box 14.14; DRI tables (GET /dri); chapter 2 energy engine"], disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Assessment sections ────────────────────────────────────────────────────────────

function altitudeAdjustment(altitudeM) {
  const ft = altitudeM * 3.28084;
  if (ft < 3000) return ALTITUDE_ADJUSTMENTS[0];
  if (ft <= 11000) return ALTITUDE_ADJUSTMENTS.find((r) => r.ft && ft >= r.ft[0] && ft <= r.ft[1]) ?? ALTITUDE_ADJUSTMENTS[0];
  const rows = ALTITUDE_ADJUSTMENTS.filter((r) => r.m && altitudeM >= r.m);
  return rows.length ? rows[rows.length - 1] : ALTITUDE_ADJUSTMENTS.find((r) => r.ft && r.ft[0] === 10000);
}

function anemiaSection(inp, tri) {
  const r = readAll(inp, { hemoglobin_g_dl: { min: 3, max: 22 }, hematocrit_percent: { min: 10, max: 65 }, altitude_m: { min: -100, max: 6000 }, cigarettes_per_day: { min: 0, max: 100 } });
  if (r.error) return { error: r.error };
  const v = r.values;
  if (v.hemoglobin_g_dl === null && v.hematocrit_percent === null) return { error: "give hemoglobin_g_dl and/or hematocrit_percent" };
  if (tri === null) return { error: "the trimester is needed (send lmp, edd, ga_weeks or trimester)" };
  const base = ANEMIA_CUTPOINTS[tri];
  const alt = v.altitude_m !== null ? altitudeAdjustment(v.altitude_m) : ALTITUDE_ADJUSTMENTS[0];
  let smoke = { hb: 0, hct: 0, label: null };
  if (bool(inp.smoker) || (v.cigarettes_per_day !== null && v.cigarettes_per_day > 0)) {
    const packs = v.cigarettes_per_day !== null ? v.cigarettes_per_day / 20 : null;
    const row = packs === null ? SMOKING_ADJUSTMENTS[3] : packs >= 2 ? SMOKING_ADJUSTMENTS[2] : packs >= 1 ? SMOKING_ADJUSTMENTS[1] : packs >= 0.5 ? SMOKING_ADJUSTMENTS[0] : SMOKING_ADJUSTMENTS[3];
    smoke = { hb: row.hb, hct: row.hct, label: row.label };
  }
  const out = { trimester: tri, sea_level_cutpoints: { hemoglobin_g_dl: base.hb, hematocrit_percent: base.hct }, altitude: v.altitude_m !== null ? { altitude_m: v.altitude_m, band: alt.label, add_hemoglobin_g_dl: alt.hb, add_hematocrit_percent: alt.hct } : null, smoking: smoke.label ? { band: smoke.label, add_hemoglobin_g_dl: smoke.hb, add_hematocrit_percent: smoke.hct } : null, notes: ["Cut-points are the maximum values for a prenatal anemia diagnosis: a value below the (adjusted) cut-point is anemic.", "Altitude and smoking adjustments are added to the sea-level cut-points (CDC)."] };
  if (v.hemoglobin_g_dl !== null) {
    const low = base.hb + alt.hb[0] + smoke.hb; const high = base.hb + alt.hb[1] + smoke.hb;
    out.hemoglobin = { value_g_dl: v.hemoglobin_g_dl, adjusted_cutpoint_g_dl: low === high ? round(low, 1) : range(low, high, 1), status: v.hemoglobin_g_dl < low ? "anemia" : v.hemoglobin_g_dl < high ? "borderline_altitude_adjustment_is_a_range" : "not_anemic" };
  }
  if (v.hematocrit_percent !== null) {
    const cut = base.hct + alt.hct + smoke.hct;
    out.hematocrit = { value_percent: v.hematocrit_percent, adjusted_cutpoint_percent: round(cut, 1), status: v.hematocrit_percent < cut ? "anemia" : "not_anemic" };
  }
  const flagged = [out.hemoglobin?.status, out.hematocrit?.status];
  out.anemia = flagged.includes("anemia") ? "anemia" : flagged.includes("borderline_altitude_adjustment_is_a_range") ? "borderline" : "not_anemic";
  if (out.anemia === "anemia") out.notes.push("Anemia in pregnancy needs a cause: iron deficiency is the most common, but folate, vitamin B12 and other causes also occur. Iron needs are 27 mg/day (DRI); the chapter notes higher intakes may be needed to treat anemia, and ferrous salts are usually prescribed.");
  return { data: out };
}

function labsSection(inp, tri) {
  if (!isObj(inp.labs)) return { error: "'labs' must be an object of values, for example { ferritin_ng_ml: 12 }" };
  const keys = Object.keys(inp.labs);
  if (!keys.length) return { error: "'labs' is empty" };
  const rows = [];
  for (const k of keys) {
    const def = LAB_RANGES[k];
    if (!def) return { error: `unknown lab '${String(k).slice(0, 40)}'. Use ${Object.keys(LAB_RANGES).join(", ")}` };
    const val = num(inp.labs[k]);
    if (!isNum(val) || val < 0 || val > 100000) return { error: `labs.${k} must be a number` };
    const key = tri === null ? null : `t${tri}`;
    const rng = key ? def[key] : null;
    const st = (r) => (r === null || r === undefined ? null : (r[0] !== null && val < r[0]) ? "below" : (r[1] !== null && val > r[1]) ? "above" : "within");
    rows.push({ lab: k, label: def.label, unit: def.unit, value: val, trimester_range: rng ? { min: rng[0], max: rng[1] } : null, status_for_trimester: rng ? st(rng) : null, nonpregnant_range: { min: def.nonpregnant[0], max: def.nonpregnant[1] }, status_vs_nonpregnant: st(def.nonpregnant), note: tri !== null && !rng ? "No range is printed for this trimester." : undefined });
  }
  return { data: { trimester: tri, results: rows, notes: ["Table 14.4 reference ranges: many values shift in pregnancy because of hemodilution and hormonal change, so non-pregnant ranges can mislabel a normal result. Ranges are not a diagnosis."] } };
}

function glucoseSection(inp, ga) {
  const t = String(inp.test ?? "").trim().toLowerCase();
  if (!["screen_50g", "ogtt_100g", "ogtt_75g", "random"].includes(t)) return { error: "'test' is required: screen_50g, ogtt_100g, ogtt_75g or random" };
  const r = readAll(inp, { fasting_mg_dl: { min: 20, max: 700 }, one_hour_mg_dl: { min: 20, max: 700 }, two_hour_mg_dl: { min: 20, max: 700 }, three_hour_mg_dl: { min: 20, max: 700 }, random_mg_dl: { min: 20, max: 1000 } });
  if (r.error) return { error: r.error };
  const v = r.values; const out = { test: t, notes: [] };
  if (ga) out.screening_window = { status: ga.milestones.gdm_screening_window.status, weeks: "24 to 28", note: "Universal screening is done at 24 to 28 weeks. Earlier testing is for women at high risk." };
  const flag = (value, cut) => value !== null && value >= cut;
  if (t === "screen_50g") {
    if (v.one_hour_mg_dl === null) return { error: "screen_50g needs one_hour_mg_dl" };
    out.thresholds = GDM.screen_50g_one_hour.map((c) => ({ cutpoint_mg_dl: c, positive: v.one_hour_mg_dl >= c }));
    out.result = v.one_hour_mg_dl >= 140 ? "positive_at_all_cutpoints" : v.one_hour_mg_dl >= 130 ? "positive_at_some_cutpoints" : "negative_at_all_cutpoints";
    out.notes.push("A 50 g one-hour screen is positive at 130, 135 or 140 mg/dL depending on the program's chosen cut-point. A positive screen needs a diagnostic test.");
  } else if (t === "ogtt_100g") {
    const names = { fasting_mg_dl: "fasting", one_hour_mg_dl: "one_hour", two_hour_mg_dl: "two_hour", three_hour_mg_dl: "three_hour" };
    const tally = (set) => { const hit = []; for (const [k, n] of Object.entries(names)) if (flag(v[k], set[n])) hit.push(n); return hit; };
    if (Object.keys(names).every((k) => v[k] === null)) return { error: "ogtt_100g needs at least one of fasting_mg_dl, one_hour_mg_dl, two_hour_mg_dl, three_hour_mg_dl" };
    const cc = tally(GDM.ogtt_100g.carpenter_coustan); const nd = tally(GDM.ogtt_100g.nddg);
    out.carpenter_coustan = { cutpoints: GDM.ogtt_100g.carpenter_coustan, values_at_or_above: cc, gdm: cc.length >= 2 };
    out.nddg = { cutpoints: GDM.ogtt_100g.nddg, values_at_or_above: nd, gdm: nd.length >= 2 };
    out.result = out.carpenter_coustan.gdm || out.nddg.gdm ? "gdm_criteria_met" : "gdm_criteria_not_met";
    out.notes.push("100 g test: GDM when two or more values reach the cut-points (Carpenter-Coustan or the more lenient NDDG set). Missing time points count as not reached, so supply all four for a complete read.");
  } else if (t === "ogtt_75g") {
    if (v.fasting_mg_dl === null && v.one_hour_mg_dl === null && v.two_hour_mg_dl === null) return { error: "ogtt_75g needs at least one of fasting_mg_dl, one_hour_mg_dl, two_hour_mg_dl" };
    const i = GDM.ogtt_75g.iadpsg; const w = GDM.ogtt_75g.who;
    const ih = []; if (flag(v.fasting_mg_dl, i.fasting)) ih.push("fasting"); if (flag(v.one_hour_mg_dl, i.one_hour)) ih.push("one_hour"); if (flag(v.two_hour_mg_dl, i.two_hour)) ih.push("two_hour");
    const wh = []; let diab = false;
    if (v.fasting_mg_dl !== null) { if (v.fasting_mg_dl >= w.fasting[0]) wh.push("fasting"); if (v.fasting_mg_dl > w.fasting[1]) diab = true; }
    if (flag(v.one_hour_mg_dl, w.one_hour)) wh.push("one_hour");
    if (v.two_hour_mg_dl !== null) { if (v.two_hour_mg_dl >= w.two_hour[0]) wh.push("two_hour"); if (v.two_hour_mg_dl > w.two_hour[1]) diab = true; }
    out.iadpsg = { cutpoints: { fasting: i.fasting, one_hour: i.one_hour, two_hour: i.two_hour }, values_at_or_above: ih, gdm: ih.length >= 1 };
    out.who = { fasting_mg_dl: w.fasting, one_hour_mg_dl: w.one_hour, two_hour_mg_dl: w.two_hour, values_at_or_above: wh, gdm_or_above: wh.length >= 1, diabetes_in_pregnancy_range: diab };
    out.result = diab ? "diabetes_in_pregnancy_range" : ih.length || wh.length ? "gdm_criteria_met" : "gdm_criteria_not_met";
    out.notes.push("75 g test: one value at or above is enough. Values above the upper bounds (fasting over 125 or 2 hour at 200 or more) are diabetes in pregnancy, not GDM.");
  } else {
    if (v.random_mg_dl === null) return { error: "random needs random_mg_dl" };
    out.result = v.random_mg_dl >= GDM.random_diabetes && bool(inp.symptoms) ? "diabetes_in_pregnancy_range" : v.random_mg_dl >= GDM.random_diabetes ? "high_without_symptoms_needs_confirmation" : "below_200";
    out.notes.push("A random plasma glucose of 200 mg/dL or more with symptoms of hyperglycemia is diagnostic of diabetes, not GDM.");
  }
  return { data: out };
}

function bpSection(inp, ga) {
  const r = readAll(inp, { systolic_mmhg: { min: 50, max: 300, required: true }, diastolic_mmhg: { min: 30, max: 200, required: true }, urine_protein_24h_mg: { min: 0, max: 50000 }, protein_creatinine_ratio: { min: 0, max: 100 }, dipstick_plus: { min: 0, max: 4 } });
  if (r.error) return { error: r.error };
  const v = r.values; const weeks = ga ? ga.gestational_age.decimal_weeks : null;
  const confirmed = bool(inp.bp_confirmed);
  const severeRange = v.systolic_mmhg >= 160 || v.diastolic_mmhg >= 110;
  const after20 = weeks !== null && weeks >= 20;
  const elevated = v.systolic_mmhg >= 140 || v.diastolic_mmhg >= 90;
  const bpCriterion = severeRange || (after20 && elevated && inp.previously_normal !== false && inp.previously_normal !== "false");
  const protein = (v.urine_protein_24h_mg !== null && v.urine_protein_24h_mg >= 300) || (v.protein_creatinine_ratio !== null && v.protein_creatinine_ratio >= 0.3) || (v.dipstick_plus !== null && v.dipstick_plus >= 2);
  const features = [];
  const lab = isObj(inp.labs) ? inp.labs : {};
  const plate = num(lab.platelets_per_ul); if (isNum(plate) && plate < 100000) features.push("platelets under 100,000/µL");
  const cr = num(lab.creatinine_mg_dl); if (isNum(cr) && cr > 1.1) features.push("serum creatinine over 1.1 mg/dL");
  if (bool(lab.creatinine_doubled)) features.push("doubling of serum creatinine");
  if (bool(lab.transaminases_twice_normal)) features.push("transaminases at twice normal");
  if (bool(inp.pulmonary_edema)) features.push("pulmonary edema");
  if (bool(inp.cerebral_or_visual_symptoms)) features.push("cerebral or visual symptoms");
  let status;
  if (!bpCriterion) status = elevated && !after20 ? "elevated_bp_before_20_weeks_or_gestation_unknown" : "blood_pressure_criterion_not_met";
  else if (protein || features.length) status = confirmed ? "preeclampsia_criteria_met" : "preeclampsia_criteria_possible_if_bp_confirmed";
  else status = "blood_pressure_criterion_met_without_proteinuria_or_organ_feature";
  const out = { gestational_weeks: weeks, bp_criterion_met: bpCriterion, severe_range: severeRange, bp_confirmed: confirmed, proteinuria_met: protein, new_onset_features: features, status, criteria: PREECLAMPSIA,
    notes: ["Box 14.4 requires the blood pressure to be confirmed (over a few minutes for the 160/110 range, over 4 hours otherwise). Send bp_confirmed: true only if it was.", "A diagnosis needs a clinician. The nutrition chapter notes that low-dose aspirin may help prevention (ACOG), that calcium supplements may reduce severity if baseline intake is under 600 mg/day, and that vitamin C and E supplements do not prevent it."] };
  if (weeks === null) out.notes.push("Gestational age was not given, so the 140/90 criterion (which applies after 20 weeks) could not be applied. Only the 160/110 range was checked.");
  return { data: out };
}

/**
 * Sections (any combination): hemoglobin_g_dl/hematocrit_percent (+altitude_m, smoker, cigarettes_per_day) | labs {...} |
 * glucose { test, ... } | blood_pressure { systolic_mmhg, diastolic_mmhg, ... }. Gestational age from lmp | edd | ga_weeks | trimester.
 */
export function computePregnancyAssessment(input, ctx = {}) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  let ga = null; let tri = null; const notes = [];
  if (present(inp.lmp) || present(inp.edd) || present(inp.ga_weeks)) {
    const g = gestationFrom(inp, ctx);
    if (!g.ok) return { ok: false, error: `gestational age: ${g.error}` };
    ga = g.ga; tri = g.ga.trimester;
  } else if (present(inp.trimester)) {
    const t = num(inp.trimester);
    if (![1, 2, 3].includes(t)) return { ok: false, error: "'trimester' must be 1, 2 or 3" };
    tri = t;
  }
  const sections = {}; const errors = {}; const notAssessed = [];
  const run = (name, fn) => { const r = fn(); if (r.error) errors[name] = r.error; else sections[name] = r.data; };
  if (present(inp.hemoglobin_g_dl) || present(inp.hematocrit_percent)) run("anemia", () => anemiaSection(inp, tri)); else notAssessed.push({ section: "anemia", reason: "needs hemoglobin_g_dl or hematocrit_percent" });
  if (present(inp.labs) && !(isObj(inp.blood_pressure) && Object.keys(inp.labs).every((k) => ["platelets_per_ul", "creatinine_mg_dl", "creatinine_doubled", "transaminases_twice_normal"].includes(k)))) run("labs", () => labsSection(inp, tri)); else if (!present(inp.labs)) notAssessed.push({ section: "labs", reason: "needs labs { name: value }" });
  if (isObj(inp.glucose)) run("glucose", () => glucoseSection(inp.glucose, ga)); else notAssessed.push({ section: "glucose", reason: "needs glucose { test: screen_50g | ogtt_100g | ogtt_75g | random, ... }" });
  if (isObj(inp.blood_pressure)) run("blood_pressure", () => bpSection({ ...inp.blood_pressure, labs: inp.blood_pressure.labs ?? (isObj(inp.labs) ? inp.labs : undefined) }, ga)); else notAssessed.push({ section: "blood_pressure", reason: "needs blood_pressure { systolic_mmhg, diastolic_mmhg, ... }" });
  if (!Object.keys(sections).length && !Object.keys(errors).length) return { ok: false, error: "nothing to assess. Send hemoglobin_g_dl or hematocrit_percent, labs, glucose, or blood_pressure." };
  if (tri === null) notes.push("No gestational age or trimester was given, so trimester-specific cut-points and ranges could not be used.");
  return { ok: true, data: { gestational_age: ga ? ga.gestational_age : null, trimester: tri, sections, errors, not_assessed: notAssessed, notes, sources: [SOURCE + " - Tables 14.4, 14.5, 14.14, Box 14.4"], disclaimer: NOT_ADVICE } };
}

// ─── Reference ──────────────────────────────────────────────────────────────────────

const REFERENCE_SECTIONS = {
  weight_gain: () => ({ table: "Table 14.11 (IOM) and Appendix 3", categories: WEIGHT_GAIN, bmi_cut_points: "under 18.5, 18.5 to 24.9, 25.0 to 29.9, 30 or more (BMI = kg / m2, or lb / in2 x 703)", first_trimester_gain_kg: FIRST_TRIMESTER_GAIN_KG, multiples_notes: MULTIPLES_NOTES, note: "Rates are per week in trimesters 2 and 3 for singletons. Twin guidelines are provisional." }),
  energy: () => ({ add_on_kcal_per_day: { trimester_1: 0, trimester_2: 340, trimester_3: 452, lactation_0_to_6_months: 330, lactation_7_to_12_months: 400 }, lactation_minimum_kcal: 1800, via: "POST /energy/requirements with pregnancy {trimester} or lactation {months_postpartum}; POST /pregnancy/plan works the trimester out from gestational age", twins_kcal_per_kg: TWINS_TABLE.kcal_per_kg }),
  protein: () => ({ rda_g_per_kg_current_weight: { first_half: 0.8, second_half: 1.1 }, reference_woman_g_per_day: 71, lactation: "about an additional 25 g/day, often 20% of energy", twins_split_percent: TWINS_TABLE.split_percent, note: "Amino acid oxidation studies suggest higher late-pregnancy needs (about 1.2 to 1.52 g/kg)." }),
  twins: () => ({ table: "Table 14.12", energy_kcal: TWINS_TABLE.energy_kcal, protein_g: TWINS_TABLE.protein_g, carbohydrate_g: TWINS_TABLE.carbohydrate_g, fat_g: TWINS_TABLE.fat_g, kcal_per_kg: TWINS_TABLE.kcal_per_kg, split_percent: TWINS_TABLE.split_percent, nutrients: TWINS_TABLE.nutrients }),
  lab_ranges: () => ({ table: "Table 14.4", order: "[min, max] by nonpregnant, trimester 1, 2, 3; null means open or not printed", ranges: LAB_RANGES }),
  anemia: () => ({ table: "Table 14.5", sea_level_cutpoints: ANEMIA_CUTPOINTS, altitude_adjustments_to_add: ALTITUDE_ADJUSTMENTS, smoking_adjustments_to_add: SMOKING_ADJUSTMENTS }),
  gdm: () => ({ table: "Table 14.14", ...GDM }),
  preeclampsia: () => ({ box: "Box 14.4", ...PREECLAMPSIA, nutrition_notes: NUTRIENT_NOTES.filter((n) => ["Calcium", "Vitamins C and E"].includes(n.nutrient)) }),
  nutrients: () => ({ notes: NUTRIENT_NOTES, dri: "GET /dri?life_stage=pregnancy_19_30 (and the other pregnancy_ and lactation_ stages); GET /dri/compare for intake against them" }),
  adolescent: () => ({ box: "Box 14.3", risk_factors: ["Young maternal age", "Pregnancy less than 2 years after onset of menarche", "Poor nutrition and low pre-pregnancy weight", "Preexisting anemia", "Inappropriate weight gain (too low and too high)", "Obesity", "Sexually transmitted disease or infection", "Substance abuse: smoking, drinking, and drugs", "Poverty", "Lack of social support", "Low educational level", "Rapid repeat pregnancies", "Lack of access to age-appropriate prenatal care", "Late entry into the health system", "Unmarried status", "Unstable housing"] }),
  lactation: () => ({ box: "Box 14.14", minimum_kcal: 1800, protein: "about an additional 25 g/day, often 20% of energy", dha: "fatty fish low in methylmercury twice a week", fat_stores_kcal_per_day: range(100, 150), weight_loss: "Not advised before breastfeeding is established (about 2 months). Up to 1 lb (0.45 kg) a week is compatible with adequate milk.", low_intake_effect: "Milk production decreases when intake is under about 1500 to 1800 kcal/day" }),
  known_issues: () => KNOWN_ISSUES,
};
export const REFERENCE_SECTION_IDS = Object.keys(REFERENCE_SECTIONS);

export function pregnancyReferenceCatalog(section) {
  if (present(section)) {
    const s = String(section).trim().toLowerCase(); const fn = REFERENCE_SECTIONS[s];
    if (!fn) return { ok: false, error: `unknown section '${String(section).slice(0, 40)}'. Use ${REFERENCE_SECTION_IDS.join(", ")}` };
    return { ok: true, data: { source: SOURCE, section: s, [s]: fn(), disclaimer: NOT_ADVICE } };
  }
  const all = { source: SOURCE, sections: REFERENCE_SECTION_IDS, disclaimer: NOT_ADVICE };
  for (const id of REFERENCE_SECTION_IDS) all[id] = REFERENCE_SECTIONS[id]();
  all.related_endpoints = ["POST /energy/requirements (energy with pregnancy or lactation add-ons, reused)", "GET /dri and GET /dri/compare (pregnancy and lactation life stages, reused)", "POST /fhir/Observation/$assess-nutrition (pre-pregnancy BMI category, MUAC)", "POST /weight-management/assess (non-pregnant BMI)", "POST /meals/analyze (nutrients eaten)"];
  return { ok: true, data: all };
}
