// Weight management calculators (GET /weight-management/reference, /weight-management/bariatric,
// POST /weight-management/assess, /loss-plan, /gain-plan, /progress, /diet-pattern).
// Pure functions, no I/O. Source: Krause and Mahan's Food and the Nutrition Care Process, 16th ed., chapter 21
// "Nutrition in Weight Management" (Lysen, Robinson, Rudel). Where the chapter gives a range, the result gives the range.
// Where the chapter contradicts itself, prints an apparent misprint or leaves a gap, the result says so (KNOWN_ISSUES)
// instead of choosing silently.
//
// Reuse, not duplication
//   - Maintenance energy is the existing chapter 2 engine (computeEnergyRequirements, POST /energy/requirements). This
//     module only adds the deficit or surplus on top of it, and never changes that engine.
//   - Adult BMI classes and the Blackburn % weight-loss significance come from fhirNcp.js (the same code behind
//     POST /fhir/Observation/$assess-nutrition), not a second copy.
//   - Grams to kcal and percent of energy come from foodEnergy.js; AMDR percentages from dri_data.js (GET /dri).
//   - Child BMI-for-age percentile is looked up by the route with enrichBmiPercentile (WHO tables), exactly as /energy does.
//   - Athlete body-fat and weekly-rate logic stays in /sports/body-composition (chapter 23). This is the general-population
//     chapter 21 method and shares only the 3500 kcal/lb constant.
//
// Safety rules built in: no plan below 800 kcal (VLCD is medically supervised only), no deficit plan from age 65, none for
// BMI under 25, none in pregnancy or lactation, no weight-gain plan at BMI 25 or more.

import { normalizeSexMF, computeEnergyRequirements } from "./energyEngine.js";
import { computeFoodEnergy, KCAL_PER_GRAM } from "./foodEnergy.js";
import { DRI_AMDR_BY_AGE_BUCKET, amdrBucketForAge } from "./dri_data.js";
import { whoAdultBmiClass, weightLossSignificance } from "./fhirNcp.js";

export const SOURCE = "Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 21 (Nutrition in Weight Management)";
const NOT_ADVICE = "Screening and planning aid from a textbook chapter. It is not a prescription. Individual plans need clinical judgement, and anyone with an eating disorder, a medical condition or medicines that affect weight needs supervision.";

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const present = (v) => v !== undefined && v !== null && v !== "";
const num = (v) => (present(v) ? Number(v) : NaN);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const range = (min, max, d = 0) => ({ min: round(min, d), max: round(max, d) });
const bool = (v) => v === true || v === "true" || v === 1 || v === "1";

export const KG_PER_LB = 0.45359237;
/** About 3500 kcal per pound of body fat. Printed in chapter 23 (Fat section); chapter 21 prints no energy value per pound. */
export const KCAL_PER_LB_FAT = 3500;
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
  for (const [key, opts] of Object.entries(specs)) {
    const r = readNum(inp, key, opts);
    if (r.error) return { error: r.error };
    out[key] = r.value;
  }
  return { values: out };
}

// ─── Reference tables (transcribed from the chapter) ────────────────────────────────

/** Table 21.3 classes. Codes come from whoAdultBmiClass (fhirNcp.js), which uses the same cut-points from 25 up. */
const CLASS_BY_CODE = {
  "severe-thinness": { id: "underweight", label: "Underweight", nih_class: null },
  "moderate-thinness": { id: "underweight", label: "Underweight", nih_class: null },
  "mild-thinness": { id: "underweight", label: "Underweight", nih_class: null },
  normal: { id: "normal", label: "Normal", nih_class: null },
  overweight: { id: "overweight", label: "Overweight", nih_class: null },
  "obesity-class-1": { id: "obesity_class_1", label: "Obesity", nih_class: "I" },
  "obesity-class-2": { id: "obesity_class_2", label: "Obesity", nih_class: "II" },
  "obesity-class-3": { id: "obesity_class_3", label: "Extreme obesity", nih_class: "III" },
};

/** Table 21.3: disease risk (type 2 diabetes, hypertension, CVD) relative to normal weight and waist. [normal waist, high waist] */
export const NIH_RISK_MATRIX = {
  overweight: ["Increased", "High"],
  obesity_class_1: ["High", "Very High"],
  obesity_class_2: ["Very High", "Very High"],
  obesity_class_3: ["Extremely High", "Extremely High"],
};
export const WAIST_CUTOFFS_CM = { male: 102, female: 88 };

/** Metabolic syndrome: three or more of five (Fat Deposition and the Metabolic Syndrome). */
export const METS_CRITERIA = [
  { id: "waist", label: "Waist circumference", rule: "102 cm (40 in) or more in men, 88 cm (35 in) or more in women" },
  { id: "triglycerides", label: "Serum triglycerides", rule: "150 mg/dL or more" },
  { id: "hdl", label: "HDL cholesterol", rule: "below 40 mg/dL in men, below 50 mg/dL in women" },
  { id: "blood_pressure", label: "Blood pressure", rule: "135/85 mm Hg or higher (printed; read here as systolic 135 or more, or diastolic 85 or more)" },
  { id: "glucose", label: "Fasting glucose", rule: "100 mg/dL or more" },
];

/** Rate and extent of weight loss: lb/week guideline by BMI. */
export const LOSS_RATE_BANDS = [
  { id: "bmi_27_to_35", label: "BMI 27 to 35", lb_per_week: [0.5, 1] },
  { id: "bmi_over_35", label: "BMI over 35", lb_per_week: [1, 2] },
];

/** Table 21.5 */
export const AMDR_TABLE = {
  current_2005: { protein: [10, 35], carbohydrate: [45, 65], fat: [20, 35] },
  previous_guidelines: { protein: [10, 35], carbohydrate: ["50 or more"], fat: ["30 or less"] },
};
/** Weight Management in Children and Adolescents: "Balanced micronutrient intake" (sic) as percent of kcal. */
export const CHILD_MACROS = { carbohydrate: [45, 60], fat: [25, 40], protein: [10, 35] };

export const ACTIVITY_TARGETS = [
  { id: "health", label: "General health", target: "At least 150 min/week of moderate aerobic activity, plus 2 muscle-strengthening sessions" },
  { id: "loss", label: "Weight loss and weight loss maintenance", target: "250 to 300 min/week of moderate-intensity aerobic activity", note: "Under 150 min/week has a minimal effect on weight. Over 150 min/week usually gives modest loss (2 to 3 kg). 225 to 420 min/week is likely to give the greatest loss (5 to 7.5 kg)." },
  { id: "prevent_gain", label: "Preventing weight gain", target: "150 to 250 min/week of moderate to vigorous activity, about 1200 to 2000 kcal/week (12 to 20 miles/week of jogging or running)" },
  { id: "maintain_after_loss", label: "Keeping lost weight off", target: "200 to 300 min/week may be more effective. Most National Weight Control Registry members report 1 h/day (at least 420 min/week), and report 60 to 90 min/day of activity.", note: "Obese people who lost weight may need substantially more activity to maintain it." },
  { id: "minimum_for_obese", label: "If the full target cannot be reached", target: "At least 30 min a day of moderate activity still gives significant health benefits" },
];

/** Table 21.6 (USDA review of popular diets): nutrient gaps by pattern. */
export const DIET_ADEQUACY = {
  high_fat_low_carbohydrate: { low_in: ["vitamin E", "vitamin A", "thiamin", "vitamin B6", "folate", "calcium", "magnesium", "iron", "potassium", "dietary fiber"], metabolic: ["causes ketosis", "may significantly raise blood uric acid"] },
  very_low_fat: { low_in: ["vitamin E", "vitamin B12", "zinc"], metabolic: [] },
  moderate_fat_balanced: { low_in: [], metabolic: ["nutritionally adequate with proper food choices"] },
};

/** Table 21.11 */
export const UNINTENTIONAL_LOSS_TIPS = [
  { concern: "Anxiety, stress, depression", tip: "Antidepressants can help; monitor choice so they do not contribute to weight fluctuations. Ensure adequacy of physical activity, folate, B6, B12 and essential fatty acids." },
  { concern: "Cancer", tip: "GI cancers are especially detrimental. Some treatments and medicines can cause loss of appetite, as can the cancer itself." },
  { concern: "Celiac disease", tip: "Ensure all gluten-containing foods and ingredients are eliminated from the diet." },
  { concern: "Changes in activity level or dietary preparation methods", tip: "Avoid skipping meals; prepare foods with high energy density; add snacks between meals." },
  { concern: "Diabetes, new onset", tip: "See a physician; monitor medicines and ensure adequate intake." },
  { concern: "Dysphagia or chewing difficulties", tip: "Alter food and liquid textures to improve chewing and swallowing capability." },
  { concern: "Hyperthyroidism", tip: "Too much thyroxine can cause weight loss." },
  { concern: "Inflammatory bowel disease", tip: "Small frequent protein and calorie-rich meals, low residue; may need enteral or parenteral nutrition." },
  { concern: "Intestinal ischemia", tip: "Needs medical intervention and potentially enteral or parenteral feeding." },
  { concern: "Medications", tip: "Some medicines can cause weight loss; check with the physician; add protein and calorie-rich meals and snacks; manage nausea, constipation and diarrhea." },
  { concern: "Nausea and vomiting", tip: "Small, frequent meals; serve liquids between meals instead of with meals to reduce fullness." },
  { concern: "Pancreatitis and cystic fibrosis", tip: "Monitor sufficiency of pancreatic enzyme replacement; easy to digest, small frequent meals and snacks; lower fat if steatorrhea is present." },
  { concern: "Food insecurity", tip: "Provide resources for food assistance programs." },
];

/** Table 21.12: foods to add between meals for +500, +1000 and +1500 kcal. [item, kcal, protein g or null] */
export const ENERGY_BOOSTERS = [
  { tier_kcal: 500, option: "A", items: [["whole-grain fruit and nut cereal", 270, 5], ["1 banana", 80, null], ["1 c whole milk", 160, 8]], printed_total: { kcal: 510, protein_g: 13 } },
  { tier_kcal: 500, option: "B", items: [["milkshake made with 1/2 cup ice cream", 145, 3], ["1 tbsp peanut butter", 90, 4], ["1 medium banana", 105, 8], ["1 c whole milk", 160, 8]], printed_total: { kcal: 500, protein_g: 23 } },
  { tier_kcal: 500, option: "C", items: [["6 graham cracker squares", 165, 3], ["2 T peanut butter", 172, 8], ["1 c orange juice", 122, null], ["2 T raisins", 52, null]], printed_total: { kcal: 511, protein_g: 11 } },
  { tier_kcal: 1000, option: "A", items: [["8 oz fruit-on-the-bottom Greek whole-milk yogurt", 260, 18], ["1 slice whole-grain bread", 70, 3], ["2 oz cheese", 226, 14], ["1 medium apple", 87, null], ["1/4 of 14-in cheese pizza", 306, 16], ["1 small banana", 81, 1]], printed_total: { kcal: 1030, protein_g: 52 } },
  { tier_kcal: 1000, option: "B", items: [["instant breakfast with whole milk", 280, 15], ["1 c cottage cheese", 239, 31], ["1/2 c pineapple", 95, null], ["1 c apple juice", 117, null], ["6 graham cracker squares", 165, 3], ["1 pear", 100, 1]], printed_total: { kcal: 996, protein_g: 50 } },
  { tier_kcal: 1500, option: "A", items: [["2 slices whole grain bread", 140, 6], ["2 T peanut butter", 180, 8], ["1 T jam", 110, null], ["6 whole-grain crackers", 120, 3], ["8 oz fruit-on-the-bottom Greek whole-milk yogurt", 260, 18], ["3/4 c roasted peanuts", 630, 28], ["1/2 c apricot nectar", 70, null]], printed_total: { kcal: 1510, protein_g: 63 } },
  { tier_kcal: 1500, option: "B", items: [["1 medium fruit muffin", 350, 6], ["2 tsp butter", 70, null], ["4 oz fruit-on-the-bottom Greek whole-milk yogurt", 130, 10], ["whole-grain fruit and nut cereal", 272, 5], ["1 banana", 80, null], ["1 c whole milk", 160, 8], ["1 bagel", 260, 10], ["2 T cream cheese", 100, 2], ["2 T jam", 110, null]], printed_total: { kcal: 1530, protein_g: 40 } },
].map((o) => {
  const kcal = o.items.reduce((s, i) => s + i[1], 0);
  const protein = o.items.reduce((s, i) => s + (i[2] || 0), 0);
  return { tier_kcal: o.tier_kcal, option: o.option, items: o.items.map(([food, k, p]) => ({ food, kcal: k, protein_g: p })), kcal_sum: kcal, protein_g_sum: protein, printed_total: o.printed_total, source: "Table 21.12 (USDA FoodData Central)" };
});

/** Table 21.9 */
export const BARIATRIC_DIET_STAGES = [
  { stage: "Clear liquids", duration: "Start within 24 h after surgery; 2 to 3 meals", foods: "Sugar-free clear liquids: water, unsweetened decaffeinated tea, sugar-free gelatin, sugar-free popsicles, broth" },
  { stage: "Stage 2: full liquid diet", duration: "A few days to 1 week", foods: "Protein drink, fat-free (skim) milk, unsweetened nondairy milk, strained cream soups" },
  { stage: "Stage 3: puréed", duration: "A few weeks to about 1 month", foods: "Smooth paste or thick liquid with no solid pieces: low-fat cottage cheese, low-fat or fat-free ricotta, blended meats, fish, eggs, beans, fruits, vegetables" },
  { stage: "Stage 4: soft foods", duration: "About 1 month", foods: "Ground or finely diced meats, canned or soft fresh fruit, cooked vegetables without skin, eggs, beans" },
  { stage: "Stage 5: solid foods", duration: "Start about 8 weeks after surgery", foods: "Gradually add firmer, diced or chopped foods" },
];

export const BARIATRIC_PROCEDURES = {
  lagb: { label: "Laparoscopic adjustable gastric banding (LAGB)" },
  lsg: { label: "Laparoscopic sleeve gastrectomy (LSG)" },
  rygb: { label: "Roux-en-Y gastric bypass (RYGB)" },
  bpd_ds: { label: "Biliopancreatic diversion with duodenal switch (BPD/DS)" },
};

/** Things in the chapter that disagree with themselves or look misprinted. Shown in the reference and echoed in results. */
export const KNOWN_ISSUES = [
  { id: "loss_example_not_reproducible", where: "Restricted-Energy Eating Plan", issue: "The example (35-year-old woman, 65 in, a 500 kcal deficit leaves about 1400 kcal at BMI 30 and about 1700 at BMI 40) cannot be reproduced from the IOM overweight equation, which gives 2124 kcal maintenance at BMI 30 (sedentary) and so about 1624 after the deficit. The printed figures fit roughly 1.25 x Mifflin-St Jeor REE minus 500 (my back-calculation, not stated in the chapter).", handling: "Maintenance comes from POST /energy/requirements (its recommended estimate), shown with its source. A caller who prefers another estimate can send maintenance_kcal." },
  { id: "deficit_vs_rate", where: "Restricted-Energy Eating Plan vs Rate and Extent of Weight Loss", issue: "A 500 to 1000 kcal daily deficit equals 1 to 2 lb/week on the 3500 kcal/lb rule, but the chapter gives 0.5 to 1 lb/week for BMI 27 to 35 and 1 to 2 lb/week only above BMI 35. The chapter explains the gap with metabolic compensation (RMR can fall up to 15%).", handling: "Both are returned: the static expectation from the deficit and the chapter's guideline band." },
  { id: "rate_band_gap", where: "Rate and Extent of Weight Loss", issue: "No rate is printed for BMI 25 to under 27, and BMI exactly 35 sits in both ranges.", handling: "The lower band (0.5 to 1 lb/week) is used below 27 and at 35, and flagged." },
  { id: "waist_boundary", where: "Table 21.3 vs Metabolic Syndrome text", issue: "Table 21.3 uses 102 cm or less / over 102 cm (men) and 88 cm or less / over 88 cm (women). The text and the metabolic syndrome criteria use 102 cm or more and 88 cm or more.", handling: "Risk by Table 21.3 uses 'over'; the metabolic syndrome criterion uses 'or more'." },
  { id: "bp_cutoff", where: "Metabolic syndrome", issue: "Blood pressure is printed as 135/85 mm Hg or higher. The cut-off commonly used elsewhere is 130/85.", handling: "The printed value is used (systolic 135 or more, or diastolic 85 or more) and the criterion says so." },
  { id: "supplement_threshold", where: "Restricted-Energy Eating Plan", issue: "A multivitamin and mineral supplement is recommended below 1200 kcal/day for women and below 1800 kcal/day for men. The 1800 figure for men is high next to typical reduced-calorie plans.", handling: "Returned as printed." },
  { id: "protein_basis", where: "Restricted-Energy Eating Plan", issue: "Protein of 1.2 g/kg is advised during energy restriction without saying which weight (current, ideal or adjusted).", handling: "Current body weight is used and the result says so. At high BMI it can give a large share of a small energy budget, so the share is shown and flagged." },
  { id: "child_macro_wording", where: "Weight Management in Children and Adolescents", issue: "'Balanced micronutrient intake' is followed by carbohydrate, fat and protein percentages, which are macronutrients. They also differ from the DRI AMDR for ages 4 to 18.", handling: "The chapter's percentages are used for children in /diet-pattern and the DRI AMDR is shown beside them." },
  { id: "child_percentile_source", where: "Weight Management in Children and Adolescents", issue: "The chapter's 85th and 95th percentile bands come from CDC growth charts. This API looks percentiles up in the WHO tables (the only ones it holds).", handling: "The percentile source is returned, and a percentile supplied by the caller is used as given." },
  { id: "bariatric_table_21_10_misprints", where: "Table 21.10", issue: "Vitamin A for RYGB and LSG is printed '5000-1000 IU', vitamin A for BPD/DS '1000 IU', zinc for BPD/DS '1622 mg/d' (a lost dash, probably 16 to 22 mg), and vitamin D target '30 ng/L' (probably ng/mL).", handling: "Those values are returned exactly as printed with suspect: true and are not corrected." },
  { id: "surgery_failure_definition", where: "Bariatric Surgery", issue: "Failure of a comprehensive program is defined as being unable to lose one-third of body weight and one-half of body fat. That is far beyond what the same chapter says programs achieve (5% to 10% of body weight).", handling: "Listed as printed in the surgery eligibility checklist; BMI criteria are what the API checks." },
  { id: "table_21_12_sums", where: "Table 21.12", issue: "In option B of the +500 kcal tier the banana row prints 8 g of protein (and the printed total of 23 g includes it), which looks too high for a banana. Option B of the +1500 kcal tier adds up to 1532 kcal and 41 g protein against printed totals of 1530 and 40.", handling: "Items are returned as printed with the sum of the items next to the printed total." },
  { id: "not_in_chapter", where: "Scope", issue: "ABSI and waist-to-height ratio are mentioned with no formula or cut-off. Ideal body weight, the 15% to 20% below 'accepted weight standards' definition of underweight, and the dynamic weight-change model (Hall 2011) have no formula either.", handling: "Not implemented." },
];

// ─── Shared helpers ─────────────────────────────────────────────────────────────────

const bmiOf = (kg, cm) => kg / (cm / 100) ** 2;
const weightAtBmi = (bmi, cm) => bmi * (cm / 100) ** 2;

export function adultBmiClass(bmi) {
  const c = whoAdultBmiClass(bmi);
  return { ...CLASS_BY_CODE[c.code], code: c.code };
}

function lossRateBand(bmi) {
  if (bmi > 35) return { ...LOSS_RATE_BANDS[1], assumed: false };
  if (bmi >= 27) return { ...LOSS_RATE_BANDS[0], assumed: false };
  return { ...LOSS_RATE_BANDS[0], id: "below_27_assumed", label: "BMI 25 to under 27 (no printed band, the lower band is used)", assumed: true };
}

/** Treatment options from the chapter (Fig 21.6 and text). Flags, not prescriptions. */
export function treatmentOptions(bmi, comorbidityCount, ageYears) {
  const co = comorbidityCount ?? 0; const withCo = co >= 1;
  const older = ageYears !== null && ageYears !== undefined && ageYears >= 65;
  const opts = [];
  opts.push({
    option: "Reduced-calorie diet, physical activity and lifestyle modification",
    eligible: bmi >= 25,
    criteria: "Overweight or obesity (BMI 25 or more). Fig 21.6 shows a low-calorie diet (LCD) of 800 to 1500 kcal for BMI 25 to 30 and above.",
    note: older ? "From age 65 weight loss is not advised (loss of lean mass)." : undefined,
  });
  opts.push({
    option: "Pharmacotherapy added to diet, activity and behavior therapy",
    eligible: bmi >= 30 || (bmi >= 27 && withCo),
    criteria: "BMI 30 or more, or 27 or more with significant risk factors or disease. Needs a physician; not a magic pill; less effective without lifestyle change.",
    ...(bmi >= 27 && bmi < 30 && comorbidityCount === null ? { note: "Give comorbidity_count to check the BMI 27 to 29.9 route." } : {}),
  });
  opts.push({
    option: "Very-low-calorie diet (VLCD, 800 kcal or less)",
    eligible: bmi >= 30 || (bmi >= 27 && withCo),
    criteria: "BMI 30 or more, or 27 or more with at least one comorbidity, after other diet programs have been unsuccessful. Medically supervised only: 12 to 16 weeks, protein 0.8 to 1.5 g/kg/day, regular medical monitoring and weekly group classes. Fig 21.6: VLCD 400 to 800 kcal (or LCD 800 to 1500) from BMI 30.",
    note: "This API never plans an intake below 800 kcal.",
  });
  opts.push({
    option: "Bariatric surgery",
    eligible: bmi >= 40 || (bmi >= 35 && withCo),
    criteria: "BMI 40 or more, or 35 or more with comorbidities, after failure of a comprehensive program (calorie reduction, exercise, lifestyle modification, psychological counseling, family involvement), with an extensive medical and psychological evaluation.",
  });
  return opts;
}

/** Maintenance energy from the chapter 2 engine. Returns { ok, kcal, ... } or { ok: false, error }. */
const ENGINE_KEYS = ["pal", "pal_category", "activities", "activity_factor", "activity_position"];
function maintenance(inp, weightKg, ageYears, sex) {
  if (present(inp.maintenance_kcal)) {
    const m = num(inp.maintenance_kcal);
    if (!isNum(m) || m < 800 || m > 8000) return { ok: false, error: "'maintenance_kcal' must be between 800 and 8000" };
    return { ok: true, kcal: round(m), source: "supplied by the caller", estimate_id: null, reason: "Supplied by the caller.", warnings: [], ree_kcal: null };
  }
  const eng = { sex, age_years: ageYears, weight_kg: weightKg, height_cm: inp.height_cm };
  for (const k of ENGINE_KEYS) if (present(inp[k])) eng[k] = inp[k];
  const r = computeEnergyRequirements(eng);
  if (!r.ok) return { ok: false, error: `maintenance energy: ${r.error}` };
  const rec = r.data.recommended;
  if (!rec) return { ok: false, error: "maintenance energy could not be estimated from these inputs. Send an activity level (pal_category: sedentary, low_active, active or very_active), activities, an activity_factor (minimal, moderate or strenuous), or maintenance_kcal. Below BMI 18.5 no IOM equation applies, so activity_factor or maintenance_kcal is needed." };
  return { ok: true, kcal: rec.kcal, source: "POST /energy/requirements (chapter 2 engine)", estimate_id: rec.id, reason: rec.reason, warnings: r.data.warnings || [], ree_kcal: r.data.ree?.kcal ?? null };
}

function macroSplit(kcal, proteinG, fat = [20, 35]) {
  const protKcal = proteinG * KCAL_PER_GRAM.protein;
  const out = { protein: { grams: round(proteinG), percent_of_energy: round((protKcal / kcal) * 100, 1) } };
  const at = (fatPct) => {
    const fatG = (kcal * fatPct) / 100 / KCAL_PER_GRAM.fat;
    const carbG = Math.max(0, (kcal - protKcal - fatG * KCAL_PER_GRAM.fat) / KCAL_PER_GRAM.carbohydrate);
    return { fat_percent: fatPct, fat_g: round(fatG), carbohydrate_g: round(carbG), carbohydrate_percent: round(((carbG * 4) / kcal) * 100, 1) };
  };
  out.at_fat_low = at(fat[0]); out.at_fat_high = at(fat[1]);
  out.amdr = { fat: range(...fat), carbohydrate: range(...AMDR_TABLE.current_2005.carbohydrate), protein: range(...AMDR_TABLE.current_2005.protein) };
  return out;
}

const eatingDisorderNote = "Not for anyone with a current or past eating disorder unless a trained clinician supervises. The chapter notes that people with body-image disturbance are at higher risk, and that programs run by trained, empathetic professionals did not raise the rate of eating disorders.";

// ─── Assessment ─────────────────────────────────────────────────────────────────────

/**
 * Adult (19 y and over): sex, age_years, weight_kg, height_cm; optional waist_cm, hip_cm, body_fat_percent,
 *   usual_weight_kg + period_days, comorbidity_count, and for the metabolic syndrome: systolic_mmhg / diastolic_mmhg,
 *   triglycerides_mg_dl, hdl_mg_dl, fasting_glucose_mg_dl.
 * Child (2 to under 19 y): sex, age_years | age_months, weight_kg, height_cm, bmi_for_age_percentile (the route looks it up for
 *   3 to 18 y), secondary_complications (boolean).
 */
export function computeWeightAssessment(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const sex = normalizeSexMF(inp.sex);
  if (!sex) return { ok: false, error: "'sex' is required: male or female" };
  let ageYears = null;
  if (present(inp.age_months)) { const m = num(inp.age_months); if (!isNum(m) || m < 0 || m > 1440) return { ok: false, error: "'age_months' must be between 0 and 1440" }; ageYears = m / 12; }
  else if (present(inp.age_years)) { const y = num(inp.age_years); if (!isNum(y) || y < 0 || y > 120) return { ok: false, error: "'age_years' must be between 0 and 120" }; ageYears = y; }
  else return { ok: false, error: "'age_years' (or 'age_months') is required" };
  if (ageYears < 2) return { ok: false, error: "This chapter covers ages 2 and over. For younger children use GET /growth/assess." };
  return ageYears < 19 ? childAssessment(inp, sex, ageYears) : adultAssessment(inp, sex, ageYears);
}

function adultAssessment(inp, sex, ageYears) {
  const r = readAll(inp, {
    weight_kg: { min: 25, max: 500, required: true, label: "kilograms" }, height_cm: { min: 100, max: 260, required: true, label: "centimetres" },
    waist_cm: { min: 40, max: 250 }, hip_cm: { min: 50, max: 250 }, body_fat_percent: { min: 2, max: 70 },
    usual_weight_kg: { min: 25, max: 500 }, period_days: { min: 1, max: 3650 }, comorbidity_count: { min: 0, max: 20 },
    systolic_mmhg: { min: 60, max: 260 }, diastolic_mmhg: { min: 30, max: 160 },
    triglycerides_mg_dl: { min: 20, max: 3000 }, hdl_mg_dl: { min: 5, max: 200 }, fasting_glucose_mg_dl: { min: 20, max: 700 },
  });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const warnings = []; const notes = []; const nextSteps = [];
  const bmi = bmiOf(v.weight_kg, v.height_cm);
  if (bmi < 8 || bmi > 90) return { ok: false, error: `BMI ${round(bmi, 1)} is not plausible. Check weight and height.` };
  const cls = adultBmiClass(bmi);
  const data = {
    group: "adult",
    inputs_used: { sex, age_years: round(ageYears, 1), weight_kg: v.weight_kg, height_cm: v.height_cm },
    bmi: round(bmi, 1),
    bmi_class: { id: cls.id, label: cls.label, nih_obesity_class: cls.nih_class, detailed_code: cls.code, source: "Table 21.3 (the same cut-points as the WHO adult classes used by $assess-nutrition)" },
    older_adult: null, waist: null, waist_hip_ratio: null, body_fat: null, metabolic_syndrome: null, weight_change: null,
    weight_for_height_kg: { bmi_18_5: round(weightAtBmi(18.5, v.height_cm), 1), bmi_24_9: round(weightAtBmi(24.9, v.height_cm), 1), bmi_25: round(weightAtBmi(25, v.height_cm), 1) },
    treatment_options: null, next_steps: nextSteps, warnings, notes,
  };

  // waist and NIH risk
  if (v.waist_cm !== null) {
    const high = v.waist_cm > WAIST_CUTOFFS_CM[sex];
    const row = NIH_RISK_MATRIX[cls.id];
    data.waist = { waist_cm: v.waist_cm, cutoff_cm: WAIST_CUTOFFS_CM[sex], above_cutoff: high, disease_risk: row ? row[high ? 1 : 0] : null, risk_note: row ? "Risk of type 2 diabetes, hypertension and CVD relative to normal weight and waist (Table 21.3)." : "Table 21.3 gives no risk grade for underweight or normal BMI. An increased waist circumference can still be a marker of increased risk even in persons of normal weight." };
    if (v.waist_cm >= WAIST_CUTOFFS_CM[sex] && !high) notes.push("Waist is exactly at the cut-off: Table 21.3 reads 'over', the metabolic syndrome criterion reads 'or more'. See known issues.");
    if (high && (cls.id === "normal")) warnings.push("Waist above the cut-off with a normal BMI is still a marker of increased risk (Table 21.3, note b).");
  }
  if (v.hip_cm !== null && v.waist_cm !== null) {
    const whr = v.waist_cm / v.hip_cm; const cut = sex === "female" ? 0.8 : 1;
    data.waist_hip_ratio = { ratio: round(whr, 2), cutoff: cut, high_risk: whr > cut, note: "A waist-to-hip ratio over 0.8 for women and over 1 for men is associated with high risk of cardiovascular events." };
  }
  if (v.body_fat_percent !== null) {
    const cut = sex === "male" ? 25 : 30;
    data.body_fat = { percent: v.body_fat_percent, obesity_cutoff_percent: cut, obese_by_body_fat: v.body_fat_percent >= cut, essential_fat_percent: sex === "male" ? 3 : 12, average_total_fat_percent: sex === "male" ? range(18, 24) : range(25, 31), source: "Body Fat and Assessment" };
    if (v.body_fat_percent >= cut && cls.id === "normal") warnings.push("Normal BMI with excess body fat (normal weight obesity) carries greater cardiovascular risk and is easily missed.");
    if (v.body_fat_percent < cut && (cls.id === "overweight")) notes.push("BMI in the overweight range with body fat below the obesity cut-off: BMI is only a proxy for adiposity.");
  }

  // metabolic syndrome
  {
    const met = []; const notMet = []; const unknown = [];
    const test = (id, value, pass) => { if (value === null) unknown.push(id); else (pass ? met : notMet).push(id); };
    test("waist", v.waist_cm, v.waist_cm !== null && v.waist_cm >= WAIST_CUTOFFS_CM[sex]);
    test("triglycerides", v.triglycerides_mg_dl, v.triglycerides_mg_dl >= 150);
    test("hdl", v.hdl_mg_dl, v.hdl_mg_dl < (sex === "male" ? 40 : 50));
    const bpKnown = v.systolic_mmhg !== null || v.diastolic_mmhg !== null;
    test("blood_pressure", bpKnown ? 1 : null, (v.systolic_mmhg !== null && v.systolic_mmhg >= 135) || (v.diastolic_mmhg !== null && v.diastolic_mmhg >= 85));
    test("glucose", v.fasting_glucose_mg_dl, v.fasting_glucose_mg_dl >= 100);
    if (met.length + notMet.length > 0) {
      const status = met.length >= 3 ? "present" : met.length + unknown.length >= 3 ? "possible" : "not_present";
      data.metabolic_syndrome = { status, criteria_met: met, criteria_not_met: notMet, criteria_unknown: unknown, count_met: met.length, rule: "Three or more of five criteria", criteria: METS_CRITERIA };
      if (status === "possible") notes.push("Metabolic syndrome cannot be ruled out: not enough criteria were supplied.");
      if (status === "present") warnings.push("Metabolic syndrome criteria are met (three or more). It raises the risk of CAD, hypertension, stroke and type 2 diabetes.");
    }
  }

  // older adults
  if (ageYears >= 65) {
    data.older_adult = { age_years: round(ageYears, 1), weight_loss_advised: false, bmi_below_desirable: bmi < 23, note: "In general weight loss after age 65 is not advised: actuarial tables show no benefit and possible harm from loss of lean body mass, and sarcopenia is the strongest predictor of disability. A BMI below 23 is below desirable in older adults." };
    if (bmi < 23) warnings.push(`BMI ${round(bmi, 1)} is below 23, below desirable for an older adult.`);
  }

  // unintentional change
  if (v.usual_weight_kg !== null) {
    if (v.period_days === null) return { ok: false, error: "'period_days' is required with 'usual_weight_kg' (days between the usual weight and now)" };
    const lossPct = ((v.usual_weight_kg - v.weight_kg) / v.usual_weight_kg) * 100;
    const sig = weightLossSignificance(lossPct, v.period_days);
    data.weight_change = { usual_weight_kg: v.usual_weight_kg, current_weight_kg: v.weight_kg, period_days: v.period_days, change_kg: round(v.weight_kg - v.usual_weight_kg, 2), loss_percent: round(lossPct, 2), significance: sig, note: "Percent loss of usual weight over the standard intervals (Blackburn), the same rule as $assess-nutrition. Only meaningful for unintentional loss: unexplained weight loss in adults is often a symptom of stress or underlying disease." };
    if (sig && (sig.level === "significant" || sig.level === "severe")) warnings.push(`Weight loss of ${round(lossPct, 1)}% over ${v.period_days} days is ${sig.level} (${sig.interval}). If unintentional, look for the cause first (see GET /weight-management/reference?section=unintentional_loss).`);
  }

  // classification messages, treatment and next steps
  if (cls.id === "underweight") {
    warnings.push(`BMI ${round(bmi, 1)} is below 18.5 (underweight), linked to greater mortality risk. Assess the cause medically before starting a treatment program.`);
    nextSteps.push("POST /weight-management/gain-plan for an energy and protein plan once the cause is addressed.");
    nextSteps.push("GET /weight-management/reference?section=unintentional_loss for cause-specific tips.");
    if (bmi < 16) warnings.push("BMI below 16 (severe thinness): medical assessment comes first. Refeeding risk is not covered by this chapter and needs separate screening before intake is raised.");
  } else if (cls.id === "normal") {
    if (ageYears >= 65 && bmi < 23) nextSteps.push("POST /weight-management/gain-plan if weight gain is wanted (target BMI of at least 23 in older adults).");
  } else {
    data.treatment_options = treatmentOptions(bmi, v.comorbidity_count, ageYears);
    if (v.comorbidity_count === null) notes.push("Give comorbidity_count (type 2 diabetes, hypertension, stroke, sleep apnea and so on) to check the options that depend on comorbidities.");
    if (ageYears < 65) nextSteps.push("POST /weight-management/loss-plan for a calorie target, rate and goal weights.");
    nextSteps.push("A 5% to 10% loss of initial body weight is the first goal: it improves blood glucose, blood pressure and cholesterol and lowers inflammation markers.");
  }
  data.sources = [SOURCE + " - Assessment, Fat Deposition and the Metabolic Syndrome, Goals of Treatment, Table 21.3"];
  data.disclaimer = NOT_ADVICE;
  return { ok: true, data };
}

function childAssessment(inp, sex, ageYears) {
  const r = readAll(inp, { weight_kg: { min: 5, max: 250 }, height_cm: { min: 60, max: 230 }, bmi_for_age_percentile: { min: 0, max: 100 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const warnings = []; const notes = []; const nextSteps = [];
  if (v.bmi_for_age_percentile === null) return { ok: false, error: "'bmi_for_age_percentile' is required for children (0 to 100). For ages 3 to 18 it is looked up in the WHO tables when weight_kg, height_cm and age are given; outside that range send the percentile from your growth chart. See GET /bmi-for-age or GET /growth/assess." };
  const p = v.bmi_for_age_percentile;
  const complications = bool(inp.secondary_complications);
  const bmi = v.weight_kg !== null && v.height_cm !== null ? bmiOf(v.weight_kg, v.height_cm) : null;
  const band = p < 5 ? "underweight" : p < 85 ? "below_85th" : p < 95 ? "overweight" : "obesity";
  const young = ageYears < 6;
  const needsWorkup = (p >= 85 && complications) || p >= 95;
  let goal; let lossMayBeAdvised = false;
  if (band === "underweight") goal = "BMI below the 5th percentile: assess the cause (undernutrition, disease, eating disorder, food insecurity) before any weight plan. Nonnutritional factors, insufficient intake, excess losses and abnormal metabolism can cause growth failure.";
  else if (band === "below_85th") goal = "No weight goal. Keep healthy eating and activity habits.";
  else if (young) {
    if (p >= 95 && complications) { goal = "Age 2 to 5 with a BMI at the 95th percentile or higher and secondary complications: weight loss may be beneficial."; lossMayBeAdvised = true; }
    else goal = "Age 2 to 5: the goal is prolonged weight maintenance or slowing the rate of weight gain, which lets BMI decline gradually as the child grows in height. This is appropriate when there are no secondary complications.";
  } else {
    if (complications || p >= 95) { goal = "Age 6 and older with a secondary complication or a BMI at or above the 95th percentile: weight loss may be advised. Offer comprehensive, intensive behavioral interventions."; lossMayBeAdvised = true; }
    else goal = "Age 6 and older, BMI between the 85th and 95th percentile with no secondary complications: prolonged weight maintenance is appropriate.";
  }
  if (needsWorkup) nextSteps.push("Assess carefully for genetic, endocrinologic and psychological conditions and for secondary complications: hypertension, dyslipidemia, type 2 diabetes, sleep apnea and orthopedic problems.");
  if (p >= 85) {
    nextSteps.push("Assess social and environmental factors, family dynamics, eating and activity habits and readiness for change. The primary goal is healthy eating and activity, not an ideal body weight. Involve the family and plan for the whole growth period.");
    notes.push("Vitamin D: low 25(OH)D (57 nmol/L or 20 ng/mL or lower) is common in obese children and is linked to inflammation and insulin resistance. The chapter recommends testing.");
  }
  if (lossMayBeAdvised && p >= 95 && ageYears >= 6) notes.push("A child who already exceeds an optimal adult weight can safely lose slowly: 10 to 12 lb (4.5 to 5.4 kg) a year until the optimal adult weight is reached, and if the weight suited to the anticipated adult height is already reached, maintain it for life.");
  notes.push("The chapter's percentile bands come from CDC growth charts. A percentile looked up by this API comes from the WHO tables.");
  return {
    ok: true,
    data: {
      group: "child_or_adolescent",
      inputs_used: { sex, age_years: round(ageYears, 2), weight_kg: v.weight_kg, height_cm: v.height_cm, secondary_complications: complications },
      bmi: bmi === null ? null : round(bmi, 1),
      bmi_for_age_percentile: p,
      percentile_source: present(inp.bmi_percentile_source) ? String(inp.bmi_percentile_source).slice(0, 200) : "supplied by the caller",
      band,
      band_rule: "Below the 5th percentile underweight; 85th to under 95th overweight; 95th and above obesity",
      goal, weight_loss_may_be_advised: lossMayBeAdvised, needs_workup: needsWorkup,
      macronutrient_ranges_percent_of_energy: { carbohydrate: range(...CHILD_MACROS.carbohydrate), fat: range(...CHILD_MACROS.fat), protein: range(...CHILD_MACROS.protein), note: "As printed in the chapter. See known issues." },
      next_steps: nextSteps, warnings, notes,
      sources: [SOURCE + " - Weight Management in Children and Adolescents"], disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Loss plan ──────────────────────────────────────────────────────────────────────

/**
 * sex, age_years, weight_kg, height_cm, an activity input for maintenance (pal_category | pal | activities | activity_factor)
 * or maintenance_kcal; deficit_kcal (500-1000, default 500) or intake_kcal; target_weight_kg?; comorbidity_count?
 */
export function computeLossPlan(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const sex = normalizeSexMF(inp.sex);
  if (!sex) return { ok: false, error: "'sex' is required: male or female" };
  const r = readAll(inp, {
    age_years: { min: 0, max: 120, required: true }, weight_kg: { min: 30, max: 500, required: true, label: "kilograms" }, height_cm: { min: 120, max: 230, required: true, label: "centimetres" },
    deficit_kcal: { min: 500, max: 1000, label: "the chapter's deficit range" }, intake_kcal: { min: 800, max: 6000, label: "800 kcal is the VLCD ceiling and is not planned here" },
    target_weight_kg: { min: 30, max: 500 }, comorbidity_count: { min: 0, max: 20 },
  });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  if (bool(inp.pregnant) || bool(inp.lactating)) return { ok: false, error: "No weight-loss plan during pregnancy or breastfeeding. Use POST /energy/requirements for pregnancy and lactation energy." };
  if (v.age_years < 19) return { ok: false, error: "Adult plans only (19 and over). For children use POST /weight-management/assess, which applies the age-based goals." };
  if (v.deficit_kcal !== null && v.intake_kcal !== null) return { ok: false, error: "give deficit_kcal or intake_kcal, not both" };
  const warnings = []; const notes = []; const steps = [];
  const bmi = bmiOf(v.weight_kg, v.height_cm);
  const cls = adultBmiClass(bmi);
  if (bmi < 18.5) return { ok: false, error: `BMI ${round(bmi, 1)} is below 18.5. No weight-loss plan. Use POST /weight-management/assess and, if appropriate, /gain-plan.` };
  if (bmi < 25) return { ok: false, error: `BMI ${round(bmi, 1)} is in the normal range. A calorie deficit is not indicated by this chapter, which treats overweight and obesity (BMI 25 or more).` };

  const maint = maintenance(inp, v.weight_kg, v.age_years, sex);
  if (!maint.ok) return maint;
  const head = {
    group: "adult",
    inputs_used: { sex, age_years: round(v.age_years, 1), weight_kg: v.weight_kg, height_cm: v.height_cm },
    bmi: round(bmi, 1), bmi_class: { id: cls.id, label: cls.label, nih_obesity_class: cls.nih_class },
    maintenance: { kcal: maint.kcal, source: maint.source, estimate_id: maint.estimate_id, reason: maint.reason, ree_kcal: maint.ree_kcal },
  };
  const tail = (extra) => ({ ...extra, sources: [SOURCE + " - Goals of Treatment, Rate and Extent of Weight Loss, Restricted-Energy Eating Plan, Physical Activity", "Chapter 2 energy engine for maintenance; chapter 23 for 3500 kcal/lb"], disclaimer: NOT_ADVICE });

  // older adults: maintenance only
  if (v.age_years >= 65) {
    warnings.push("Weight loss after age 65 is not advised: actuarial tables show no benefit and possible harm from loss of lean body mass, and sarcopenia is the strongest predictor of disability and of being unable to do daily activities.");
    return { ok: true, data: tail({ ...head, deficit_plan: null, reason_no_plan: "Age 65 or older. Only the maintenance estimate is returned. A clinician may still choose to treat; this API does not produce a deficit.", treatment_options: treatmentOptions(bmi, v.comorbidity_count, v.age_years), warnings, notes }) };
  }

  // deficit and intake
  let deficit; let intake;
  if (v.intake_kcal !== null) { intake = v.intake_kcal; deficit = maint.kcal - intake; if (deficit <= 0) return { ok: false, error: `intake_kcal (${intake}) is not below the maintenance estimate (${maint.kcal} kcal), so there is no deficit.` }; }
  else { deficit = v.deficit_kcal ?? 500; intake = maint.kcal - deficit; }
  if (intake < 800) return { ok: false, error: `That leaves ${round(intake)} kcal/day, below 800 kcal: the very-low-calorie diet range, which is medically supervised only (12 to 16 weeks, protein 0.8 to 1.5 g/kg/day, regular monitoring). This API does not plan it. Use a smaller deficit, or a clinician-run VLCD program.` };
  if (deficit < 500 || deficit > 1000) warnings.push(`A deficit of ${round(deficit)} kcal/day is outside the 500 to 1000 kcal the chapter gives for BMI 30 or more.`);
  steps.push(`Maintenance ${maint.kcal} kcal (${maint.source})`, `Daily deficit ${round(deficit)} kcal, intake ${round(intake)} kcal`);
  if (bmi < 27) notes.push("The chapter's deficit of 500 to 1000 kcal is stated for BMI 30 or more. For BMI 25 to under 27 no rate or deficit is printed.");

  const band = lossRateBand(bmi);
  const guideLb = band.lb_per_week;
  const guideKg = [guideLb[0] * KG_PER_LB, guideLb[1] * KG_PER_LB];
  const staticLb = (deficit * 7) / KCAL_PER_LB_FAT;
  const rate = {
    chapter_guideline: { band: band.label, lb_per_week: range(...guideLb, 2), kg_per_week: range(...guideKg, 2), assumed: band.assumed },
    static_expectation: { lb_per_week: round(staticLb, 2), kg_per_week: round(staticLb * KG_PER_LB, 2), method: `${round(deficit)} kcal/day x 7 / ${KCAL_PER_LB_FAT} kcal per lb of body fat (chapter 23 value)` },
    note: "Real loss is usually slower than the static figure: resting metabolic rate can drop up to 15% within 2 weeks of restriction, a lighter body needs less energy, and the thermic effect of food (about 10% of intake) falls with intake. Steady loss over a longer period favors loss of fat and limits loss of lean tissue and of REE.",
  };
  if (band.assumed) notes.push("No rate is printed for BMI under 27, so the lower band (0.5 to 1 lb/week) is used.");
  if (staticLb * KG_PER_LB > guideKg[1] * 1.0001) notes.push("The deficit predicts a faster loss than the chapter's guideline band. Expect the slower, guideline rate.");

  // goals
  const goals = [];
  const goalFor = (label, pct) => {
    const w = v.weight_kg * (1 - pct / 100); const lossKg = v.weight_kg - w;
    return { label, percent_of_initial: pct, weight_kg: round(w, 1), weight_lb: round(lb(w), 1), loss_kg: round(lossKg, 1), bmi_at_goal: round(bmiOf(w, v.height_cm), 1), weeks_at_guideline: range(lossKg / guideKg[1], lossKg / guideKg[0], 0), weeks_at_static_rate: round(lossKg / (staticLb * KG_PER_LB), 0) };
  };
  goals.push(goalFor("5% of initial weight", 5), goalFor("10% of initial weight", 10));
  let targetCheck = null;
  if (v.target_weight_kg !== null) {
    if (v.target_weight_kg >= v.weight_kg) return { ok: false, error: "target_weight_kg must be below the current weight" };
    const tb = bmiOf(v.target_weight_kg, v.height_cm);
    if (tb < 18.5) return { ok: false, error: `target_weight_kg gives a BMI of ${round(tb, 1)}, below 18.5 (underweight). Choose a higher target.` };
    const pct = ((v.weight_kg - v.target_weight_kg) / v.weight_kg) * 100;
    targetCheck = { ...goalFor("Your target", pct), percent_of_initial: round(pct, 1) };
    if (pct > 10) notes.push(`A target loss of ${round(pct, 1)}% is above 10%. The chapter notes that patients' own goals are often far higher than realistic and advises a first goal of 5% to 10%, which already improves blood glucose, blood pressure and cholesterol.`);
  }

  // protein, macros, floors
  const proteinG = 1.2 * v.weight_kg;
  const split = macroSplit(intake, proteinG);
  if (split.protein.percent_of_energy > 35) warnings.push(`Protein at 1.2 g/kg (${round(proteinG)} g) is ${split.protein.percent_of_energy}% of this energy, above the 35% AMDR ceiling. Protein is based on current weight (the chapter does not say which weight to use), so a lower figure may suit a very high BMI.`);
  if (split.at_fat_high.carbohydrate_percent < 45 || split.at_fat_low.carbohydrate_percent < 45) notes.push("At 1.2 g/kg protein, carbohydrate falls below the 45% AMDR floor at the higher fat share. All reduced-calorie diets (low-fat, low-carbohydrate, balanced) give similar long-term loss, so the split can follow preference.");
  const supplementBelow = sex === "female" ? 1200 : 1800;
  const needsSupp = intake < supplementBelow;
  if (needsSupp) warnings.push(`Intake under ${supplementBelow} kcal/day: the chapter recommends a vitamin and mineral supplement that meets age-related requirements (printed threshold: below 1200 kcal for women and 1800 kcal for men).`);
  const programBand = intake <= 1500 ? "low-calorie diet band (800 to 1500 kcal)" : "above the 800 to 1500 kcal low-calorie diet band";

  // maintenance at goal weights (the chapter: smaller bodies need less energy)
  const atGoal = [];
  const goalWeights = targetCheck ? [{ label: "target", w: v.target_weight_kg }] : [{ label: "5% goal", w: goals[0].weight_kg }, { label: "10% goal", w: goals[1].weight_kg }];
  for (const g of goalWeights) {
    const m = maintenance({ ...inp, maintenance_kcal: undefined }, g.w, v.age_years, sex);
    if (m.ok && !present(inp.maintenance_kcal)) atGoal.push({ label: g.label, weight_kg: g.w, maintenance_kcal: m.kcal, change_from_now_kcal: round(m.kcal - maint.kcal) });
  }
  const maintenanceAtGoal = present(inp.maintenance_kcal) ? { note: "Not recalculated because maintenance_kcal was supplied. Re-estimate at the new weight with POST /energy/requirements." } : { estimates: atGoal, note: "Energy needs for keeping weight off are lower than at the original weight because smaller bodies have smaller energy requirements. Intake must stay lower for good." };

  return {
    ok: true,
    data: tail({
      ...head,
      deficit_plan: {
        deficit_kcal: round(deficit), intake_kcal: round(intake), intake_kj: round(intake * 4.184), band: programBand,
        rate, goals, target_check: targetCheck,
        protein: { g_per_kg: 1.2, grams: round(proteinG), basis: "current body weight", rule: "1.2 g/kg during energy restriction to limit loss of lean body mass, prevent a fall in REE and preserve bone mineral density. The protein RDA is for maintenance and does not apply." },
        macronutrients: split,
        supplement: { recommended: needsSupp, rule: "Multivitamin and mineral supplement meeting age-related requirements when intake is below 1200 kcal (women) or 1800 kcal (men), or when it is hard to choose foods that meet all nutrient needs." },
        food_pattern: "Mostly whole foods: fresh unprocessed vegetables, fruit, beans (legumes), whole grains, plus a variety of seafood, poultry and lean meats. Keep alcohol (7 kcal/g) and sugary drinks small. Nonnutritive sweeteners are not shown to help weight loss.",
        physical_activity: ACTIVITY_TARGETS.filter((a) => ["health", "loss", "maintain_after_loss"].includes(a.id)),
        support: "Behavior modification is the cornerstone: goal setting, self-monitoring of food and activity, stimulus control, problem solving, cognitive restructuring and relapse prevention. Ongoing contact with a therapist or dietitian improves maintenance.",
        plateau: "A plateau mostly means the deficit has been lost (people hold a deficit for about 6 weeks, then drift back toward their old intake). Re-establish the deficit, and re-estimate energy at the new weight.",
        steps,
      },
      maintenance_at_goal: maintenanceAtGoal,
      treatment_options: treatmentOptions(bmi, v.comorbidity_count, v.age_years),
      warnings,
      notes: [...notes, eatingDisorderNote],
    }),
  };
}

// ─── Gain plan ──────────────────────────────────────────────────────────────────────

/**
 * sex, age_years, weight_kg, height_cm, an activity input (pal_category | pal | activities | activity_factor) or maintenance_kcal;
 * surplus_kcal (500-1000, default is the range); target_weight_kg?
 */
export function computeGainPlan(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const sex = normalizeSexMF(inp.sex);
  if (!sex) return { ok: false, error: "'sex' is required: male or female" };
  const r = readAll(inp, { age_years: { min: 0, max: 120, required: true }, weight_kg: { min: 25, max: 300, required: true, label: "kilograms" }, height_cm: { min: 120, max: 230, required: true, label: "centimetres" }, surplus_kcal: { min: 500, max: 1000, label: "the chapter's surplus range" }, target_weight_kg: { min: 25, max: 300 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  if (v.age_years < 19) return { ok: false, error: "Adult plans only (19 and over). For children use POST /weight-management/assess; underweight in children needs the cause assessed and a growth-based plan." };
  const warnings = []; const notes = [];
  const bmi = bmiOf(v.weight_kg, v.height_cm);
  if (bmi >= 25) return { ok: false, error: `BMI ${round(bmi, 1)} is 25 or more. A weight-gain plan is not indicated.` };
  const older = v.age_years >= 65;
  const maint = maintenance(inp, v.weight_kg, v.age_years, sex);
  if (!maint.ok) return maint;
  const cls = adultBmiClass(bmi);
  if (bmi >= 18.5 && !(older && bmi < 23)) notes.push("BMI is in the normal range. The chapter's gain section is written for underweight (BMI under 18.5, or under 23 in older adults).");
  if (bmi < 16) warnings.push("BMI below 16 (severe thinness): medical assessment comes first, and refeeding risk is not covered by this chapter. Raise intake gradually under supervision.");
  if (cls.id === "underweight") warnings.push("Assess the cause first (inadequate intake, excessive activity, malabsorption, a wasting disease, stress, hyperthyroidism). Treat any underlying cause as the first priority; see GET /weight-management/reference?section=unintentional_loss.");

  const lowS = v.surplus_kcal ?? 500; const highS = v.surplus_kcal ?? 1000;
  const startKcal = maint.kcal + lowS; const goalKcal = maint.kcal + highS;
  const levels = [{ label: "start", kcal: startKcal }, ...(highS !== lowS ? [{ label: "goal", kcal: goalKcal }] : [])].map((l) => {
    const protMin = (0.12 * l.kcal) / KCAL_PER_GRAM.protein; const protMax = (0.15 * l.kcal) / KCAL_PER_GRAM.protein;
    const fatG = (0.30 * l.kcal) / KCAL_PER_GRAM.fat;
    const carbAtProtMin = (l.kcal - protMin * 4 - fatG * 9) / 4; const carbAtProtMax = (l.kcal - protMax * 4 - fatG * 9) / 4;
    return { label: l.label, energy_kcal: round(l.kcal), protein_g: range(protMin, protMax), protein_percent: range(12, 15), fat_g: round(fatG), fat_percent: 30, carbohydrate_g: range(carbAtProtMax, carbAtProtMin), carbohydrate_percent: range(((carbAtProtMax * 4) / l.kcal) * 100, ((carbAtProtMin * 4) / l.kcal) * 100, 1) };
  });
  const rateLb = [(lowS * 7) / KCAL_PER_LB_FAT, (highS * 7) / KCAL_PER_LB_FAT];
  const lowBmi = older ? 23 : 18.5;
  const wLow = weightAtBmi(lowBmi, v.height_cm); const wHigh = weightAtBmi(24.9, v.height_cm);
  const toLow = Math.max(0, wLow - v.weight_kg);
  const weeks = toLow > 0 ? range(toLow / (rateLb[1] * KG_PER_LB), toLow / (rateLb[0] * KG_PER_LB), 0) : null;
  let targetCheck = null;
  if (v.target_weight_kg !== null) {
    if (v.target_weight_kg <= v.weight_kg) return { ok: false, error: "target_weight_kg must be above the current weight" };
    const tb = bmiOf(v.target_weight_kg, v.height_cm);
    if (tb >= 25) return { ok: false, error: `target_weight_kg gives a BMI of ${round(tb, 1)}, which is 25 or more. Choose a target below BMI 25.` };
    const diff = v.target_weight_kg - v.weight_kg;
    targetCheck = { target_weight_kg: v.target_weight_kg, gain_kg: round(diff, 1), bmi_at_target: round(tb, 1), weeks: range(diff / (rateLb[1] * KG_PER_LB), diff / (rateLb[0] * KG_PER_LB), 0) };
  }
  const tiers = [500, 1000];
  const boosters = ENERGY_BOOSTERS.filter((b) => tiers.includes(b.tier_kcal) && b.tier_kcal <= Math.max(500, highS));
  return {
    ok: true,
    data: {
      group: "adult",
      inputs_used: { sex, age_years: round(v.age_years, 1), weight_kg: v.weight_kg, height_cm: v.height_cm },
      bmi: round(bmi, 1), bmi_class: { id: cls.id, label: cls.label },
      maintenance: { kcal: maint.kcal, source: maint.source, estimate_id: maint.estimate_id, reason: maint.reason, ree_kcal: maint.ree_kcal },
      energy: {
        surplus_kcal: highS === lowS ? lowS : range(lowS, highS), start_kcal: round(startKcal), goal_kcal: highS === lowS ? null : round(goalKcal),
        rule: "Intake for the present weight plus 500 to 1000 kcal a day. The chapter's example: if 2400 kcal keeps weight, 2900 to 3400 kcal is needed for gain.",
        gradual: "Increase intake gradually (Table 21.12 step-up plans) to avoid gastric discomfort, discouragement, electrolyte imbalances and cardiac dysfunction.",
      },
      macronutrients: { levels, rule: "Protein at least 12% to 15% of kcal; about 30% of kcal from fat, mostly mono- or polyunsaturated.", amdr: { carbohydrate: range(...AMDR_TABLE.current_2005.carbohydrate) } },
      expected_rate: { lb_per_week: range(...rateLb, 2), kg_per_week: range(rateLb[0] * KG_PER_LB, rateLb[1] * KG_PER_LB, 2), method: "surplus x 7 / 3500 kcal per lb (chapter 23 value). Chapter 21 prints no rate of gain.", note: "An estimate for planning, not a promise. Chapter 23's rates for lean-mass gain in athletes are lower (0.25 to 1 lb/week)." },
      target_range: { lowest_weight_kg: round(wLow, 1), highest_weight_kg: round(wHigh, 1), lowest_bmi: lowBmi, basis: older ? "BMI 23 to 24.9 (a BMI under 23 is below desirable in older adults)" : "BMI 18.5 to 24.9", weeks_to_lowest: weeks },
      target_check: targetCheck,
      eating_guidance: [
        "Individualize with readily available foods the person enjoys, at regular times through the day.",
        "Meals scheduled and eaten when relaxed, not rushed. Encourage eating even when not hungry.",
        "Add snacks between meals; use high-calorie liquids with or between meals if appetite is poor or fullness comes early.",
        "Fortify everyday foods to raise calories and protein.",
        "Limit activity if the cause is inadequate intake, and arrange psychological counseling if needed. If the cause is food insecurity, provide local food assistance.",
      ],
      energy_boosters: boosters,
      energy_boosters_note: "Foods to add between meals, from Table 21.12 (US foods and portions). Pick the tier that matches the surplus.",
      warnings,
      notes: [...notes, "Appetite stimulants (orexigenic drugs) are reserved for those whose conditions are refractory to usual treatment, and are a physician's decision."],
      sources: [SOURCE + " - Excessive Leanness or Unintentional Weight Loss, High-Energy Diets, Table 21.12"], disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Progress ───────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dayNumber(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t / 86400000;
}

/**
 * goal: loss | gain | maintain; weigh_ins: [{ date: YYYY-MM-DD, weight_kg }]; height_cm? (rate band by BMI);
 * start_weight_kg? (default: first weigh-in); target_weight_kg?; recent_days? (14-90, default 28);
 * weight_before_loss_kg? (maintain: for the National Weight Control Registry check)
 */
export function computeWeightProgress(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const goal = String(inp.goal ?? "").trim().toLowerCase();
  if (!["loss", "gain", "maintain"].includes(goal)) return { ok: false, error: "'goal' is required: loss, gain or maintain" };
  if (!Array.isArray(inp.weigh_ins) || inp.weigh_ins.length < 2) return { ok: false, error: "'weigh_ins' must be an array of at least 2 { date: 'YYYY-MM-DD', weight_kg }" };
  if (inp.weigh_ins.length > 400) return { ok: false, error: "at most 400 weigh-ins" };
  const r = readAll(inp, { height_cm: { min: 100, max: 260 }, start_weight_kg: { min: 20, max: 500 }, target_weight_kg: { min: 20, max: 500 }, recent_days: { min: 14, max: 90 }, weight_before_loss_kg: { min: 20, max: 500 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const pts = [];
  for (const [i, w] of inp.weigh_ins.entries()) {
    if (!isObj(w)) return { ok: false, error: `weigh_ins[${i}] must be an object` };
    const d = dayNumber(w.date); const kg = num(w.weight_kg);
    if (d === null) return { ok: false, error: `weigh_ins[${i}].date must be a real date written YYYY-MM-DD` };
    if (!isNum(kg) || kg < 20 || kg > 500) return { ok: false, error: `weigh_ins[${i}].weight_kg must be between 20 and 500` };
    pts.push({ day: d, date: String(w.date), kg });
  }
  pts.sort((a, b) => a.day - b.day);
  for (let i = 1; i < pts.length; i++) if (pts[i].day === pts[i - 1].day) return { ok: false, error: `two weigh-ins share the date ${pts[i].date}. Send one per date.` };
  const first = pts[0]; const last = pts[pts.length - 1];
  const spanDays = last.day - first.day;
  if (spanDays < 7) return { ok: false, error: "the weigh-ins must span at least 7 days" };
  const startKg = v.start_weight_kg ?? first.kg;
  const warnings = []; const notes = [];
  const changeKg = last.kg - startKg; const pctChange = (changeKg / startKg) * 100;
  const weeks = spanDays / 7;
  const ratePerWeekKg = (last.kg - first.kg) / weeks;
  const recentDays = v.recent_days ?? 28;
  const windowStart = last.day - recentDays;
  const inWin = pts.filter((p) => p.day >= windowStart);
  const recentFirst = inWin.length ? inWin[0] : null;
  let recent = null;
  if (recentFirst && last.day - recentFirst.day >= 7) { const wk = (last.day - recentFirst.day) / 7; recent = { days: last.day - recentFirst.day, from: recentFirst.date, change_kg: round(last.kg - recentFirst.kg, 2), kg_per_week: round((last.kg - recentFirst.kg) / wk, 2), lb_per_week: round(lb((last.kg - recentFirst.kg) / wk), 2) }; }
  const bmiStart = v.height_cm !== null ? bmiOf(startKg, v.height_cm) : null;
  const summary = {
    first_date: first.date, last_date: last.date, weigh_ins: pts.length, span_days: spanDays, start_weight_kg: round(startKg, 2), current_weight_kg: round(last.kg, 2),
    change_kg: round(changeKg, 2), change_lb: round(lb(changeKg), 2), change_percent_of_start: round(pctChange, 2),
    average_kg_per_week: round(ratePerWeekKg, 2), average_lb_per_week: round(lb(ratePerWeekKg), 2), recent,
    bmi_start: bmiStart === null ? null : round(bmiStart, 1), bmi_now: v.height_cm !== null ? round(bmiOf(last.kg, v.height_cm), 1) : null,
  };
  const data = { goal, summary, warnings, notes, sources: [SOURCE + " - Goals of Treatment, Rate and Extent of Weight Loss, Plateau Effect, Maintaining Reduced Body Weight"], disclaimer: NOT_ADVICE };

  if (goal === "loss") {
    const lostPct = -pctChange;
    const band = bmiStart !== null ? lossRateBand(bmiStart) : { label: "BMI not given (0.5 to 2 lb/week spans both printed bands)", lb_per_week: [0.5, 2], assumed: true };
    const lossLb = -lb(ratePerWeekKg);
    const gl = band.lb_per_week;
    let status = "within_guideline";
    if (lossLb < gl[0]) status = lossLb <= 0 ? "no_loss_or_gain" : "slower_than_guideline";
    else if (lossLb > gl[1]) status = "faster_than_guideline";
    const milestones = [5, 10].map((p) => ({ percent: p, reached: lostPct >= p, weight_kg: round(startKg * (1 - p / 100), 1) }));
    data.loss = {
      lost_percent: round(lostPct, 2), rate_band: { label: band.label, lb_per_week: range(...gl, 2), assumed: band.assumed }, average_rate_status: status, milestones,
      benefits: "Losing 5% to 10% of initial body weight is likely to improve blood glucose, blood pressure and cholesterol and lower markers of systemic inflammation.",
      benchmarks: "A comprehensive lifestyle program produced about 10% loss in 16 to 26 weeks in a review of trials. Professional programs average 9.5% loss and keep 54% of it at one year.",
    };
    if (status === "faster_than_guideline") warnings.push("Loss is faster than the guideline band. Steady loss over a longer period favors loss of fat and limits loss of lean tissue; check intake and that the loss is not mostly water.");
    if (status === "no_loss_or_gain") warnings.push("Weight has not gone down over this period. Check intake against the plan (underreporting of intake and overestimating activity are common) and re-establish the deficit.");
    if (recent) {
      const recentLoss = -recent.lb_per_week;
      const plateau = recentLoss < gl[0];
      data.loss.plateau = { suspected: plateau, recent_lb_per_week_lost: round(recentLoss, 2), rule: `Loss over the last ${recent.days} days is below the lowest guideline rate (${gl[0]} lb/week). This threshold is derived from the chapter's rate band; the chapter prints no numeric plateau definition.` };
      if (plateau && lostPct > 0) notes.push("Possible plateau. It is mainly due to a lost energy deficit (people keep a deficit for about 6 weeks, then drift back to their baseline intake), so re-establish the deficit. Also re-estimate energy at the current, lower weight: POST /weight-management/loss-plan.");
    }
    if (v.target_weight_kg !== null) {
      const toGo = last.kg - v.target_weight_kg; const totalPlan = startKg - v.target_weight_kg;
      data.loss.target = { target_weight_kg: v.target_weight_kg, kg_to_go: round(Math.max(0, toGo), 2), percent_of_planned_loss_done: totalPlan > 0 ? round(((startKg - last.kg) / totalPlan) * 100, 1) : null, weeks_to_go_at_current_average: ratePerWeekKg < 0 && toGo > 0 ? round(toGo / -ratePerWeekKg, 0) : null };
    }
  } else if (goal === "gain") {
    const gainLb = lb(ratePerWeekKg);
    const band = [1, 2];
    let status = "within_expected";
    if (gainLb < band[0]) status = gainLb <= 0 ? "no_gain_or_loss" : "slower_than_expected";
    else if (gainLb > band[1]) status = "faster_than_expected";
    data.gain = { gained_percent: round(pctChange, 2), expected_lb_per_week: range(...band, 2), expected_basis: "a surplus of 500 to 1000 kcal/day on the 3500 kcal/lb rule (chapter 21 prints no rate of gain)", average_rate_status: status };
    if (status === "no_gain_or_loss") warnings.push("No weight gain over this period. Re-check the cause of underweight and the energy intake, and see Table 21.11.");
    if (status === "faster_than_expected") notes.push("Gain is faster than a 500 to 1000 kcal surplus predicts, which may include fluid. Increase intake gradually.");
    if (v.target_weight_kg !== null) { const toGo = v.target_weight_kg - last.kg; data.gain.target = { target_weight_kg: v.target_weight_kg, kg_to_go: round(Math.max(0, toGo), 2), weeks_to_go_at_current_average: ratePerWeekKg > 0 && toGo > 0 ? round(toGo / ratePerWeekKg, 0) : null }; }
  } else {
    const before = v.weight_before_loss_kg;
    data.maintenance = { change_since_start_percent: round(pctChange, 2), drift_kg_per_week: round(ratePerWeekKg, 2), note: "Energy needs for keeping weight off are lower than at the original weight. Weight cycling (the yo-yo effect) is common." };
    if (before !== undefined && before !== null) {
      const keptPct = ((before - last.kg) / before) * 100;
      data.maintenance.weight_before_loss_kg = before;
      data.maintenance.kept_off_percent = round(keptPct, 1);
      data.maintenance.nwcr_criteria = { rule: "National Weight Control Registry: kept off at least 10% of body weight for at least a year", kept_off_at_least_10_percent: keptPct >= 10, span_days: spanDays, at_least_a_year: spanDays >= 365, met: keptPct >= 10 && spanDays >= 365 };
    }
    data.maintenance.habits_of_successful_maintainers = ["Eat a relatively low-fat (24%) diet", "Eat breakfast almost every day", "Weigh themselves regularly, once a day to once a week", "Do high levels of physical activity (60 to 90 min/day)"];
    if (pctChange > 0 && before !== undefined) warnings.push("Weight is rising during maintenance. Return to self-monitoring, and re-check intake and activity.");
  }
  // unintentional loss (not the goal)
  if (goal !== "loss" && changeKg < 0) {
    const sig = weightLossSignificance(-pctChange, spanDays);
    data.unintentional_loss = { loss_percent: round(-pctChange, 2), period_days: spanDays, significance: sig, note: "Weight went down while the goal was not loss. Percent loss of usual weight over the standard intervals (Blackburn), as in $assess-nutrition." };
    if (sig && (sig.level === "significant" || sig.level === "severe")) warnings.push(`Unplanned weight loss of ${round(-pctChange, 1)}% over ${spanDays} days is ${sig.level} (${sig.interval}). Look for the cause.`);
  }
  return { ok: true, data };
}

// ─── Diet pattern ───────────────────────────────────────────────────────────────────

/** daily grams { carbohydrate_g, protein_g, fat_g, alcohol_g? }; optional weight_kg, age_years, energy_restriction (boolean), vlcd (boolean). */
export function computeDietPattern(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const r = readAll(inp, { weight_kg: { min: 3, max: 500 }, age_years: { min: 1, max: 120 } });
  if (r.error) return { ok: false, error: r.error };
  const { weight_kg: kg, age_years: age } = r.values;
  const food = computeFoodEnergy({ carbohydrate_g: inp.carbohydrate_g, protein_g: inp.protein_g, fat_g: inp.fat_g, alcohol_g: inp.alcohol_g });
  if (!food.ok) return { ok: false, error: food.error };
  const total = food.data.total.kcal;
  if (!(total > 0)) return { ok: false, error: "give at least one of carbohydrate_g, protein_g, fat_g or alcohol_g above zero" };
  const pct = (n) => food.data.breakdown.find((b) => b.nutrient === n)?.percent_of_energy ?? 0;
  const grams = (n) => food.data.breakdown.find((b) => b.nutrient === n)?.grams ?? 0;
  const carbPct = pct("carbohydrate"); const fatPct = pct("fat"); const protPct = pct("protein"); const alcPct = pct("alcohol");
  const carbG = grams("carbohydrate");
  const child = age !== null && age < 19;
  const ranges = child ? CHILD_MACROS : { carbohydrate: AMDR_TABLE.current_2005.carbohydrate, fat: AMDR_TABLE.current_2005.fat, protein: AMDR_TABLE.current_2005.protein };
  const bucket = amdrBucketForAge(age);
  const status = (p, [lo, hi]) => (p < lo ? "below" : p > hi ? "above" : "within");
  const compare = { basis: child ? "the chapter's range for children and adolescents (as printed)" : "AMDR, Table 21.5 (2005)", carbohydrate: { percent: carbPct, range: range(...ranges.carbohydrate), status: status(carbPct, ranges.carbohydrate) }, fat: { percent: fatPct, range: range(...ranges.fat), status: status(fatPct, ranges.fat) }, protein: { percent: protPct, range: range(...ranges.protein), status: status(protPct, ranges.protein) } };
  if (child) compare.dri_amdr_for_age_shown_beside = DRI_AMDR_BY_AGE_BUCKET[bucket] ? { bucket, carbohydrate: DRI_AMDR_BY_AGE_BUCKET[bucket].carbohydrate, fat: DRI_AMDR_BY_AGE_BUCKET[bucket].fat, protein: DRI_AMDR_BY_AGE_BUCKET[bucket].protein } : null;

  const tags = []; const gaps = new Set(); const metabolic = new Set(); const warnings = []; const notes = [];
  if (fatPct < 10) { tags.push("very_low_fat"); ["vitamin E", "vitamin B12", "zinc"].forEach((n) => gaps.add(n)); warnings.push("Under 10% of energy from fat is well below the AMDR floor of 20%. Less than 20% may harm essential fatty acid intake and the absorption of fat-soluble nutrients, and compensatory sugar and processed carbohydrate can trigger metabolic syndrome."); }
  else if (fatPct < 20 && !child) { tags.push("low_fat_below_amdr"); warnings.push("Fat under 20% of energy is below the AMDR and may reduce essential fatty acid intake and fat-soluble nutrient absorption."); }
  if (carbG < 50) { tags.push("ketogenic_range"); DIET_ADEQUACY.high_fat_low_carbohydrate.low_in.forEach((n) => gaps.add(n)); DIET_ADEQUACY.high_fat_low_carbohydrate.metabolic.forEach((n) => metabolic.add(n)); notes.push("Under 50 g of carbohydrate a day produces ketosis. Early weight loss is 60% or more water (glycogen holds three to four times its weight in water), so early loss is not fat loss."); }
  else if (carbPct < ranges.carbohydrate[0]) { tags.push("low_carbohydrate"); DIET_ADEQUACY.high_fat_low_carbohydrate.low_in.forEach((n) => gaps.add(n)); }
  if (carbPct <= 40 && protPct >= 25 && protPct <= 35 && fatPct >= 25 && fatPct <= 35) tags.push("high_protein_low_carbohydrate_pattern");
  if (fatPct > 35) tags.push("fat_above_amdr");
  if (!tags.length && compare.carbohydrate.status === "within" && compare.fat.status === "within" && compare.protein.status === "within") { tags.push("balanced_within_amdr"); metabolic.add("nutritionally adequate with proper food choices"); }
  if (alcPct > 0) {
    notes.push(`Alcohol supplies ${alcPct}% of this energy at 7 kcal/g.`);
    if (alcPct >= 50) warnings.push("Alcohol at 50% or more of energy: heavy drinkers may have a depressed appetite and poor intake.");
    else if (alcPct >= 10) warnings.push("Alcohol at 10% or more of energy, which is about what regular drinkers take. Alcohol should be limited to small amounts in a weight-loss diet, and habitual use can lead to lipid storage and weight gain.");
  }
  let protein = null;
  if (kg !== null) {
    const gpk = grams("protein") / kg;
    protein = { g_per_kg: round(gpk, 2), basis: "the weight supplied" };
    if (bool(inp.vlcd)) { protein.rule = "VLCD: 0.8 to 1.5 g/kg/day"; protein.status = status(gpk, [0.8, 1.5]); }
    else if (bool(inp.energy_restriction)) { protein.rule = "During energy restriction about 1.2 g/kg is needed to limit loss of lean mass"; protein.status = gpk >= 1.2 ? "meets" : "below"; if (gpk < 1.2) warnings.push(`Protein of ${round(gpk, 2)} g/kg is below the 1.2 g/kg advised during energy restriction.`); }
  }
  if (total < 800) warnings.push(`${total} kcal is in the very-low-calorie diet range (800 kcal or less), which is medically supervised only.`);
  notes.push("All reduced-calorie diets (low-fat, low-carbohydrate, balanced) give similar long-term weight loss, so the pattern can follow preference. No diet was best for hunger. Carbohydrate-insulin theory has not held up in controlled studies at equal energy.");
  return {
    ok: true,
    data: {
      energy_kcal: total, breakdown: food.data.breakdown.map((b) => ({ nutrient: b.nutrient, grams: b.grams, kcal: b.kcal, percent_of_energy: b.percent_of_energy })),
      compare_with_ranges: compare, pattern_tags: tags, nutrients_at_risk: [...gaps], metabolic_effects: [...metabolic], protein, warnings, notes,
      sources: [SOURCE + " - Dietary Modification Recommendations, Very-Low-Fat Diets, Low-Carbohydrate and Ketogenic Diets, Tables 21.5 and 21.6"], disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Bariatric guidance (Tables 21.9 and 21.10) ─────────────────────────────────────

/** procedure: lagb | lsg | rygb | bpd_ds; sex?; childbearing_age? (boolean); pregnant? (boolean) */
export function computeBariatricGuidance(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "query must be an object" };
  const id = String(inp.procedure ?? "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
  const proc = BARIATRIC_PROCEDURES[id];
  if (!proc) return { ok: false, error: `'procedure' is required: ${Object.keys(BARIATRIC_PROCEDURES).join(", ")}` };
  const sex = present(inp.sex) ? normalizeSexMF(inp.sex) : null;
  if (present(inp.sex) && !sex) return { ok: false, error: "'sex' must be male or female" };
  const childbearing = bool(inp.childbearing_age); const pregnant = bool(inp.pregnant);
  const suspect = (printed, why) => ({ as_printed: printed, suspect: true, why });
  const ironHigh = id !== "lagb";
  const supplements = [
    { nutrient: "Thiamine", recommendation: "At least 12 mg daily, preferably 50 mg of thiamine from a B-complex supplement or multivitamin once daily." },
    { nutrient: "Vitamin B12", recommendation: "350 to 500 µg orally daily (disintegrating tablet, sublingual or liquid), OR nasal spray as directed by the manufacturer, OR 1000 µg monthly parenterally." },
    { nutrient: "Folate (folic acid)", recommendation: childbearing ? "800 to 1000 µg daily (women of childbearing age)" : "400 to 800 µg daily from a multivitamin. Women of childbearing age take 800 to 1000 µg daily." },
    { nutrient: "Iron", recommendation: ironHigh ? "At least 45 to 60 mg elemental iron cumulatively daily (multivitamins and other supplements), in divided doses, separately from calcium, acid-reducing medicines and foods high in phytates and polyphenols." : (sex === "male" ? "At least 18 mg from the multivitamin (low risk of deficiency, such as males with LAGB), in divided doses, separately from calcium and acid-reducing medicines." : "The chapter gives LAGB only for low-risk patients (at least 18 mg from the multivitamin, for example males). A higher-risk LAGB patient is not covered; the 45 to 60 mg figure is for RYGB, LSG and BPD/DS.") },
    { nutrient: "Calcium", recommendation: id === "bpd_ds" ? "1800 to 2400 mg/day in divided doses. Calcium carbonate with meals; calcium citrate with or without meals." : "1200 to 1500 mg/day in divided doses. Calcium carbonate with meals; calcium citrate with or without meals." },
    { nutrient: "Vitamin D", recommendation: "Dose is based on 25(OH)D levels. 3000 IU daily until 25(OH)D is above the target.", target: suspect("30 ng/L", "Almost certainly ng/mL; not corrected here.") },
  ];
  if (id === "lagb") supplements.push({ nutrient: "Vitamin A and K", recommendation: "Vitamin A 5000 IU and vitamin K 90 to 120 µg daily." });
  else if (id === "bpd_ds") supplements.push({ nutrient: "Vitamin A and K", recommendation: "Vitamin K 300 µg daily.", vitamin_a: suspect("1000 IU", "Printed once as '1000 IU'. The value looks short by a digit and is not corrected here.") });
  else supplements.push({ nutrient: "Vitamin A and K", recommendation: "Vitamin K 90 to 120 µg daily.", vitamin_a: suspect("5000-1000 IU", "A range with its numbers reversed (probably 5000 to 10,000 IU). Not corrected here.") });
  supplements.push({ nutrient: "Vitamin E", recommendation: "15 mg daily (all weight loss surgeries)." });
  const zinc = id === "bpd_ds" ? { recommendation: "Multivitamin with minerals containing 200% of the RDA.", amount: suspect("1622 mg/d", "A lost dash: probably 16 to 22 mg/d. Not corrected here.") }
    : id === "rygb" ? { recommendation: "Multivitamin with minerals containing 100% to 200% of the RDA (8 to 22 mg/d)." }
      : { recommendation: "Multivitamin with minerals containing 100% of the RDA (8 to 11 mg/d)." };
  supplements.push({ nutrient: "Zinc", ...zinc, note: "To limit the risk of copper deficiency, keep a ratio of 8 to 15 mg of supplemental zinc to 1 mg of copper." });
  supplements.push({ nutrient: "Copper", recommendation: id === "bpd_ds" || id === "rygb" ? "200% of the RDA (2 mg/day)." : "100% of the RDA (1 mg/day).", note: "Copper gluconate or sulfate is the recommended source." });
  const warnings = [];
  if (pregnant) warnings.push("Special attention should be paid to supplementation of vitamins A and K in pregnant women after weight loss surgery.");
  const stagesApply = id === "lsg" || id === "rygb";
  return {
    ok: true,
    data: {
      procedure: { id, label: proc.label },
      diet_progression: stagesApply ? BARIATRIC_DIET_STAGES : null,
      diet_progression_note: stagesApply ? "Table 21.9 (sleeve gastrectomy and Roux-en-Y gastric bypass). Emphasis on protein and fluid intake. New stomach capacity may be as small as 30 mL (about 2 tablespoons)." : "Table 21.9 covers sleeve gastrectomy and Roux-en-Y bypass only. The chapter gives no staged diet for this procedure.",
      supplements,
      monitoring: "Lifelong follow-up by the multidisciplinary team and a dietitian: total-body fat loss and a full micronutrient assessment, including thiamine, vitamin B12, folate, iron, vitamin D, calcium, the other fat-soluble vitamins, zinc and copper, before and after surgery. A liquid multivitamin-mineral supplement is often used.",
      eligibility_reminder: "Bariatric surgery is considered for BMI 40 or more, or 35 or more with comorbidities, after failure of a comprehensive program.",
      warnings,
      notes: ["Table 21.10 has misprints. Suspect values are returned exactly as printed and marked suspect: true. Check the ASMBS guideline (Parrott 2017) before using them."],
      sources: [SOURCE + " - Bariatric Surgery, Tables 21.9 and 21.10 (Parrott et al, 2017)"], disclaimer: NOT_ADVICE,
    },
  };
}

// ─── Catalog ────────────────────────────────────────────────────────────────────────

const REFERENCE_SECTIONS = {
  bmi_classes: () => ({ table: "Table 21.3", classes: [{ id: "underweight", bmi: "under 18.5" }, { id: "normal", bmi: "18.5 to 24.9" }, { id: "overweight", bmi: "25.0 to 29.9" }, { id: "obesity_class_1", bmi: "30.0 to 34.9" }, { id: "obesity_class_2", bmi: "35.0 to 39.9" }, { id: "obesity_class_3", bmi: "40 or more (extreme obesity)" }], older_adults: "BMI under 23 is below desirable", children: "Percentile of BMI-for-age: under 5th underweight, 85th to under 95th overweight, 95th and above obesity" }),
  disease_risk: () => ({ table: "Table 21.3", waist_cutoff_cm: WAIST_CUTOFFS_CM, matrix: NIH_RISK_MATRIX, order: ["waist at or under the cut-off", "waist over the cut-off"], note: "Disease risk for type 2 diabetes, hypertension and CVD relative to normal weight and waist." }),
  body_fat: () => ({ obesity_percent: { male: 25, female: 30 }, essential_fat_percent: { male: 3, female: 12 }, average_total_fat_percent: { male: range(18, 24), female: range(25, 31) }, elite_fit_percent: { male: range(2, 5), female: range(10, 13) }, waist_hip_ratio_high_risk: { female: "over 0.8", male: "over 1" } }),
  metabolic_syndrome: () => ({ rule: "Three or more of five", criteria: METS_CRITERIA }),
  rates: () => ({ loss_guideline: LOSS_RATE_BANDS, deficit_kcal_per_day: range(500, 1000), kcal_per_lb_fat: KCAL_PER_LB_FAT, goal_percent_of_initial_weight: range(5, 10), older_adults: "Weight loss after 65 is not advised", gain_energy_surplus_kcal_per_day: range(500, 1000) }),
  energy_floors: () => ({ low_calorie_diet_kcal: range(800, 1500), vlcd_kcal: "800 or less (medically supervised only; Fig 21.6 shows 400 to 800)", supplement_below_kcal: { female: 1200, male: 1800 }, vlcd_protein_g_per_kg: range(0.8, 1.5, 1), vlcd_duration_weeks: range(12, 16), protein_g_per_kg_during_restriction: 1.2, alcohol_kcal_per_gram: 7 }),
  macronutrients: () => ({ amdr: AMDR_TABLE, children_and_adolescents_percent: CHILD_MACROS, gain_diet: { protein_percent_at_least: "12 to 15", fat_percent_about: 30 }, low_carbohydrate: "Under 50 g/day carbohydrate gives ketosis", high_protein_variants: "Zone and South Beach: carbohydrate 40% or less, fat and protein about 30% each" }),
  diets: () => ({ table: "Table 21.6 (USDA review)", adequacy: DIET_ADEQUACY, findings: ["Diets that reduce caloric intake result in weight loss; all popular diets give short-term loss if followed.", "All low-calorie diets lose body fat. In the short term, high-fat low-carbohydrate and ketogenic diets lose more water than fat.", "Low-carbohydrate diets cause ketosis and may raise blood uric acid.", "No diet was optimal for hunger.", "Weight maintenance and long-term health data are lacking."] }),
  activity: () => ({ targets: ACTIVITY_TARGETS }),
  treatment: () => ({ options: treatmentOptions(30, 0, null).map(({ option, criteria }) => ({ option, criteria })), figure: "Fig 21.6: LCD 800 to 1500 kcal from BMI 25; VLCD 400 to 800 or LCD 800 to 1500 from BMI 30; surgery only with comorbidities at BMI 35 to under 40, and acceptable at 40 or more" }),
  unintentional_loss: () => ({ table: "Table 21.11", tips: UNINTENTIONAL_LOSS_TIPS, underweight_definitions: "BMI under 18.5 in adults, under the 5th percentile in children, under 23 in older adults" }),
  energy_boosters: () => ({ table: "Table 21.12", tiers: ENERGY_BOOSTERS }),
  bariatric: () => ({ diet_stages: BARIATRIC_DIET_STAGES, procedures: BARIATRIC_PROCEDURES, see: "GET /weight-management/bariatric?procedure=rygb for one procedure's supplements" }),
  known_issues: () => KNOWN_ISSUES,
};
export const REFERENCE_SECTION_IDS = Object.keys(REFERENCE_SECTIONS);

export function weightReferenceCatalog(section) {
  if (present(section)) {
    const s = String(section).trim().toLowerCase();
    const fn = REFERENCE_SECTIONS[s];
    if (!fn) return { ok: false, error: `unknown section '${String(section).slice(0, 40)}'. Use ${REFERENCE_SECTION_IDS.join(", ")}` };
    return { ok: true, data: { source: SOURCE, section: s, [s]: fn(), disclaimer: NOT_ADVICE } };
  }
  const all = { source: SOURCE, sections: REFERENCE_SECTION_IDS, disclaimer: NOT_ADVICE };
  for (const id of REFERENCE_SECTION_IDS) all[id] = REFERENCE_SECTIONS[id]();
  all.related_endpoints = ["POST /energy/requirements (maintenance energy, reused)", "POST /energy/food-energy (grams and alcohol to kcal)", "GET /dri (AMDR)", "GET /bmi-for-age and GET /growth/assess (child growth)", "POST /sports/body-composition (athletes, chapter 23)", "POST /fhir/Observation/$assess-nutrition (BMI class and weight-loss significance)"];
  return { ok: true, data: all };
}
