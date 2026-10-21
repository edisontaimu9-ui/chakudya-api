// Renal nutrition calculators (GET /renal-nutrition/reference, GET /renal-nutrition/emergency-diet,
// POST /renal-nutrition/stage, /requirements, /labs, /adequacy, /plan).
// Pure functions, no I/O. Two sources, kept apart in every result:
//   1. KDOQI Clinical Practice Guideline for Nutrition in CKD: 2020 Update (Ikizler et al., Am J Kidney Dis 76(3) Suppl 1:S1-S107).
//      This is the CURRENT rule and drives every target.
//   2. Krause and Mahan's Food and the Nutrition Care Process, ch. 35 (Medical Therapy for Renal Disorders): Table 35.9
//      (nutrient requirements by therapy, KDOQI 2000), Table 35.10 (blood values for ESRD patients) and Box 35.3 (emergency
//      dialysis diet). Table 35.9 is older than KDOQI 2020, so its numbers are returned as `legacy_krause` next to the 2020
//      targets and are never mixed into them. Table 35.10 and Box 35.3 have no 2020 replacement and are used as printed.
// Where the two disagree, or a source contradicts itself, the result says so (KNOWN_ISSUES) instead of choosing silently.
//
// Reuse, not duplication: there is no second energy equation here. KDOQI 2020 prescribes 25-35 kcal/kg, so energy is that range
// times the weight. Food screening against these targets stays in POST /meals/analyze (clinical_conditions) and the renal food
// list stays at GET /renal.
//
// NOT from either source (stated in every result that uses it): CKD-EPI 2021 creatinine equation and KDIGO G/A categories
// (/stage), Daugirdas second-generation spKt/V and rate-adjusted eKt/V (/adequacy, optional), SI unit conversion factors.

export const SOURCE_KDOQI = "KDOQI Clinical Practice Guideline for Nutrition in CKD: 2020 Update (Ikizler et al., Am J Kidney Dis 76(3) Suppl 1:S1-S107)";
export const SOURCE_KRAUSE = "Krause and Mahan's Food and the Nutrition Care Process, ch. 35 (Medical Therapy for Renal Disorders): Table 35.9, Table 35.10, Box 35.3";
export const SOURCE = `${SOURCE_KDOQI}; ${SOURCE_KRAUSE}`;
const NOT_ADVICE = "Screening and planning aid built from guideline tables. It does not replace a renal dietitian or nephrologist. Targets apply to metabolically stable adults, and every value needs individual clinical judgement.";

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const present = (v) => v !== undefined && v !== null && v !== "";
const num = (v) => (present(v) ? Number(v) : NaN);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const bool = (v) => v === true || v === "true" || v === 1 || v === "1";
const times = (arr, w, d = 0) => ({ min: round(arr[0] * w, d), max: round(arr[1] * w, d) });
const rng = (arr, d = 2) => ({ min: round(arr[0], d), max: round(arr[1], d) });

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

// ─── Reference tables ───────────────────────────────────────────────────────────────

export const STATUSES = ["ckd_1_2", "ckd_3_5", "hd", "pd", "transplant"];
export const STATUS_LABELS = {
  ckd_1_2: "CKD stages 1-2, not on dialysis",
  ckd_3_5: "CKD stages 3-5, not on dialysis",
  hd: "CKD 5D, maintenance hemodialysis",
  pd: "CKD 5D, peritoneal dialysis",
  transplant: "Kidney transplant recipient",
};

/** KDOQI 2020 summary statements used by the targets. Paraphrased; ids and grades are the guideline's. */
export const KDOQI_2020 = [
  { id: "1.0.1", topic: "screening", text: "Consider routine nutrition screening at least twice a year in CKD 3-5D and transplant, to find people at risk of protein-energy wasting.", grade: "opinion" },
  { id: "1.0.3", topic: "assessment", text: "A renal dietitian should do a full nutrition assessment within 90 days of starting dialysis, then yearly, or sooner if screening or a referral calls for it.", grade: "opinion" },
  { id: "1.1.5", topic: "weight monitoring", text: "Measure weight and BMI at least monthly on hemodialysis or peritoneal dialysis, every 3 months in CKD 4-5 or after transplant, every 6 months in CKD 1-3.", grade: "opinion" },
  { id: "1.2.1", topic: "biomarkers", text: "nPCR, albumin and prealbumin are complementary tools. They are affected by non-nutritional factors and are not read alone.", grade: "opinion" },
  { id: "1.5.1", topic: "composite index", text: "In CKD 5D use the 7-point Subjective Global Assessment.", grade: "1B" },
  { id: "1.6.2", topic: "diet record", text: "A 3-day food record covering dialysis and non-dialysis days is the preferred intake method in CKD 3-5D.", grade: "2C" },
  { id: "3.0.1", topic: "protein", text: "CKD 3-5, stable, no diabetes: under close supervision, 0.55-0.60 g/kg/day, or 0.28-0.43 g/kg/day with keto/amino acid analogs.", grade: "1A (quality of life 2C)" },
  { id: "3.0.2", topic: "protein", text: "CKD 3-5 with diabetes: 0.6-0.8 g/kg/day under close supervision.", grade: "opinion" },
  { id: "3.0.3", topic: "protein", text: "Stable hemodialysis or peritoneal dialysis, no diabetes: 1.0-1.2 g/kg/day.", grade: "1C (hemodialysis), opinion (peritoneal dialysis)" },
  { id: "3.0.4", topic: "protein", text: "Dialysis with diabetes: 1.0-1.2 g/kg/day, higher if needed to keep glucose steady.", grade: "opinion" },
  { id: "3.1.1", topic: "energy", text: "CKD 1-5D and transplant, stable: 25-35 kcal/kg/day, set by age, sex, activity, body composition, weight goals, stage and illness.", grade: "1C (opinion for transplant)" },
  { id: "3.2.1", topic: "protein type", text: "Not enough evidence to prefer plant or animal protein.", grade: "1B" },
  { id: "6.1.1", topic: "acid load", text: "CKD 1-4: more fruit and vegetables is suggested to lower net acid production.", grade: "2C" },
  { id: "6.1.2", topic: "bicarbonate", text: "CKD 3-5D: lower net acid production with bicarbonate or citrate supplementation.", grade: "1C" },
  { id: "6.1.3", topic: "bicarbonate", text: "CKD 3-5D: keep serum bicarbonate at 24-26 mmol/L.", grade: "opinion" },
  { id: "6.2.1", topic: "calcium", text: "CKD 3-4 not on active vitamin D analogs: 800-1,000 mg/day total elemental calcium, counting food, supplements and calcium binders.", grade: "2B" },
  { id: "6.2.2", topic: "calcium", text: "CKD 5D: adjust calcium for vitamin D analogs and calcimimetics to avoid hypercalcemia.", grade: "opinion" },
  { id: "6.3.1", topic: "phosphorus", text: "CKD 3-5D: adjust dietary phosphorus to keep serum phosphate in the normal range.", grade: "1B" },
  { id: "6.3.2", topic: "phosphorus", text: "Consider how well each source is absorbed (additives, animal, plant) when restricting phosphorus.", grade: "opinion" },
  { id: "6.3.3", topic: "phosphorus", text: "After transplant with low phosphate, a high-phosphorus intake can be considered.", grade: "opinion" },
  { id: "6.4.1", topic: "potassium", text: "CKD 3-5D and transplant: adjust potassium intake to keep serum potassium normal.", grade: "opinion" },
  { id: "6.4.2", topic: "potassium", text: "With high or low potassium, set intake by the patient's needs and clinician judgement.", grade: "2D (opinion for transplant)" },
  { id: "6.5.1", topic: "sodium", text: "CKD 3-5, 5D and transplant: under 100 mmol/day (under 2.3 g/day sodium) for blood pressure and volume control.", grade: "1B (CKD 3-5), 1C (5D, transplant)" },
  { id: "6.5.2", topic: "sodium", text: "CKD 3-5: the same limit also lowers proteinuria alongside drugs.", grade: "2A" },
  { id: "6.5.3", topic: "sodium", text: "CKD 3-5D: less sodium helps volume control and dry weight.", grade: "2B" },
];

/** Krause Table 35.9 (KDOQI 2000, Wiggins 2002). Per kg of IBW. Kept as the older reference; see KNOWN_ISSUES. */
export const LEGACY_TABLE_35_9 = {
  ckd_3_5: [{ therapy: "Impaired renal function", kcal_per_kg_ibw: [30, 35], protein_g_per_kg_ibw: [0.6, 1.0], fluid: "ad libitum", sodium_g_per_day: [1.5, 2], potassium: "variable, usually ad libitum or raised to cover diuretic losses", phosphorus_mg_per_day: [800, 1200], phosphorus_mg_per_kg_ibw: [8, 12] }],
  hd: [{ therapy: "Hemodialysis", kcal_per_kg_ibw: [35, 35], protein_g_per_kg_ibw: [1.2, 1.2], fluid: "750-1000 mL/day plus urine output", fluid_ml_per_day: [750, 1000], sodium_g_per_day: [1.5, 2], potassium_g_per_day: [2, 3], potassium_mg_per_kg_ibw: 40, phosphorus_mg_per_day: [800, 1200], phosphorus_mg_per_kg_ibw_max: 17 }],
  pd: [{ therapy: "Peritoneal dialysis (CAPD/CCPD)", kcal_per_kg_ibw: [30, 35], protein_g_per_kg_ibw: [1.2, 1.5], fluid: "ad libitum (at least 1000 mL/day from urine plus output)", sodium_g_per_day: [1.5, 4], potassium_g_per_day: [3, 4], phosphorus_mg_per_day: [800, 1200] }],
  transplant_early: [{ therapy: "Transplant, 4-6 weeks", kcal_per_kg_ibw: [30, 35], protein_g_per_kg_ibw: [1.3, 2], fluid: "ad libitum", sodium_g_per_day: [1.5, 2], potassium: "variable; may need restriction with cyclosporine-induced hyperkalemia", calcium_g_per_day: 1.2, phosphorus: "no need to limit" }],
  transplant_late: [{ therapy: "6 weeks or longer after transplant", kcal: "enough to reach and keep IBW; limit simple carbohydrate", protein_g_per_kg_ibw: [1, 1], fluid: "ad libitum", sodium_g_per_day: [1.5, 2], potassium: "variable", calcium_g_per_day: 1.2, phosphorus: "no need to limit", fat: "under 35% of calories", cholesterol: "table prints 'CHO under 400 mg/day' (footnote: CHO = cholesterol); chapter text says under 300 mg/day", pufa_sfa_ratio: "above 1" }],
};
const LEGACY_NOTES = {
  hd: "Krause text: about 15 g of protein is lost per hemodialysis session, and at least 50% of protein should be high biological value (HBV).",
  pd: "Krause text: 20-30 g of protein can be lost over a 24-hour exchange schedule (about 1 g/hour), and at least 50% should be HBV.",
  transplant: "Krause text: after transplant, drink about 2 L/day depending on urine output, keep calcium and phosphorus at about 1200 mg each daily with vitamin D3 2000 IU, and cholesterol under 300 mg/day.",
};

/** Krause Table 35.10 (dialysis column and the "normal kidney function" column). Action text is paraphrased. */
const LABS = {
  sodium: { label: "Sodium", unit: "mEq/L", keys: [["sodium_meq_l", 1], ["sodium_mmol_l", 1]], general: [135, 145], dialysis: [135, 145],
    high: "Check fluid status. With high fluid gain between sessions, advise fewer salty foods. With low fluid gain, confirm the patient gains about 1.5 kg between sessions (under 4% of body weight) and is not dehydrated, which is rare.",
    low: "With high fluid gain the patient is probably drinking too much: cut salt and fluid, keep gain between sessions under 4% of body weight, and limit fluid to about 3 cups plus urine output." },
  potassium: { label: "Potassium", unit: "mEq/L", keys: [["potassium_meq_l", 1], ["potassium_mmol_l", 1]], general: [3.5, 5.5], dialysis: [3.5, 5.5],
    high: "Rule out other causes first (GI bleeding, trauma, medicines). Advise avoiding foods over 250 mg potassium per serving and keeping intake to about 2000 mg/day. Consider a lower-potassium dialysate bath and recheck at the next treatment. Dietary advice does not replace urgent clinical review when potassium is markedly raised.",
    low: "Add one high-potassium food a day and recheck. Salt substitute or potassium supplements can be used, and a higher-potassium dialysate bath can be considered if diet changes do not work." },
  bun: { label: "Urea nitrogen (BUN)", unit: "mg/dL", keys: [["bun_mg_dl", 1], ["urea_mmol_l", 2.801]], general: [7, 23], dialysis: [50, 100],
    high: "The patient is probably underdialyzed: check eKt/V and nPNA.",
    low: "Underdialysis can be a cause. BUN also falls when intake is poor because of uremic symptoms, and with muscle loss." },
  creatinine: { label: "Creatinine", unit: "mg/dL", keys: [["creatinine_mg_dl", 1], ["creatinine_umol_l", 1 / 88.4]], general: [0.6, 1.5], dialysis: [null, 15],
    high: "Dialysis normally controls creatinine. If the patient is losing weight, muscle breakdown can raise it: more protein and calories may be needed to stop the loss.",
    low: "A low value can mean good dialysis or low muscle mass. Check urea clearance (Kt/V) to judge dialysis adequacy." },
  albumin: { label: "Albumin", unit: "g/dL", keys: [["albumin_g_dl", 1], ["albumin_g_l", 0.1]], general: [3.5, 5], general_bcp: [3, 4.5], dialysis: [3.5, 5], dialysis_target_min: 4,
    high: null,
    low: "Increase protein-rich foods (meat, fish, chicken, eggs); a protein supplement may be needed. IV albumin helps short-term oncotic pressure but does not change serum levels. Below 2.9 g/dL fluid leaks into tissue and causes edema. Albumin is not read alone (KDOQI 1.2.1) and its method (bromocresol green or purple) changes the result." },
  calcium: { label: "Calcium", unit: "mg/dL", keys: [["calcium_mg_dl", 1], ["calcium_mmol_l", 4.008]], general: [8.5, 10.2], dialysis: [8.5, 10.2],
    high: "Check for calcium supplements or active vitamin D; these may need to be stopped temporarily.",
    low: "If albumin is low, ask for an ionized calcium, because total calcium reads falsely low. A calcium supplement between meals and active vitamin D may be needed: check with the physician." },
  phosphorus: { label: "Phosphorus", unit: "mg/dL", keys: [["phosphorus_mg_dl", 1], ["phosphate_mmol_l", 3.097]], general: [2.5, 4.8], dialysis: [3, 6],
    high: "Limit milk and milk products to 1 serving a day and remind the patient to take phosphate binders with meals and snacks. Missed binders are the most common cause.",
    low: "Add 1 serving of a milk product or other high-phosphorus food a day, or reduce the phosphate binder." },
  pth: { label: "Intact PTH", unit: "pg/mL", keys: [["pth_pg_ml", 1], ["pth_ng_l", 1]], general: [10, 65], dialysis: [150, 600],
    high: "Check for oral or IV active vitamin D and contact the physician about therapy. With no symptoms (high phosphorus, bone pain, fractures), treat less aggressively.",
    low: "No treatment available." },
  aluminum: { label: "Aluminum", unit: "mcg/L", keys: [["aluminum_mcg_l", 1], ["aluminium_mcg_l", 1]], general: [0, 10], dialysis: [null, 40],
    high: "Stop aluminum hydroxide phosphate binders. Check the value every 6 months in anyone taking them.", low: null },
  magnesium: { label: "Magnesium", unit: "mg/dL", keys: [["magnesium_mg_dl", 1], ["magnesium_mmol_l", 2.431]], general: [1.5, 2.4], dialysis: [1.5, 2.4],
    high: "Often from magnesium-containing antacids or laxatives. No diet change: use fiber for constipation. If magnesium is used as a phosphate binder, check levels more often.", low: null },
  ferritin: { label: "Ferritin", unit: "mcg/L", keys: [["ferritin_mcg_l", 1], ["ferritin_ng_ml", 1]], general: [20, 350], general_female: [6, 350], dialysis_epo: [300, 800], dialysis_no_epo: [50, null],
    high: null,
    low: "Iron in food is poorly absorbed and most patients need IV iron. Oral iron should not be taken at the same time as phosphate binders." },
  co2: { label: "Serum CO2 (bicarbonate)", unit: "mEq/L", keys: [["co2_meq_l", 1], ["bicarbonate_mmol_l", 1]], general: [22, 25], dialysis: [22, 25], kdoqi_2020_target: [24, 26],
    high: null,
    low: "Review eKt/V, BUN and nPNA. Oral sodium bicarbonate can raise CO2 but adds a sodium load. KDOQI 2020 aims for 24-26 mmol/L." },
  glucose: { label: "Glucose", unit: "mg/dL", keys: [["glucose_mg_dl", 1], ["glucose_mmol_l", 18.016]], general: [65, 114], dialysis: [65, 114], dialysis_diabetes: [null, 300],
    high: "In diabetes a high glucose can increase thirst. Avoid concentrated sweets unless glucose is low.",
    low: "The kidney metabolizes insulin, so low glucose from a longer insulin action is possible in kidney failure." },
};
export const LAB_IDS = Object.keys(LABS);

/** Krause Table 35.10 adequacy rows plus the text around them. */
export const ADEQUACY_TARGETS = {
  urr_percent_min: 65, ekt_v_min: 1.2, kt_v_hd_min: 1.2, kt_v_pd_weekly_min: 2, npna_g_per_kg_day: [0.8, 1.4], idwg_percent_max: 4, idwg_typical_kg: 1.5,
};

/** Box 35.3. Foods are US products and units; the source gives no Malawian equivalents. */
export const EMERGENCY_DIET = {
  box: "Box 35.3 Emergency Dialysis Diet Plan (Katy Wilkens, Northwest Kidney Centers, 2019)",
  use: "For short periods (5 days or less) when dialysis is not possible. It does not replace dialysis. If a food is not on the list, do not eat it.",
  guidelines: [
    "Limit meat to 3-4 oz a day (about 85-115 g).",
    "Avoid all high-potassium fruits and vegetables.",
    "Take only 1-2 cups (8 oz each, about 240 mL) of fluid a day.",
    "Choose low-salt foods and do not use salt or salt substitute.",
    "Use fats and sugars for extra calories.",
    "If the power is off for a day, eat food from the refrigerator first, then food from the freezer while it still has ice crystals in the center.",
    "Keep a portable emergency kit that can go with the patient to a disaster relief center.",
  ],
  groups: [
    { group: "Meat and protein", choices_per_day: [3, 4], serving: "1 oz each", options: ["1 egg", "1 oz meat, fish, tofu or poultry", "1/4 cup unsalted or rinsed canned fish or poultry", "2 Tbsp unsalted peanut butter", "1/4 cup cottage cheese", "1/2 can commercial liquid nutritional supplement"] },
    { group: "Starch", choices_per_day: [6, 10], options: ["1 slice white bread", "1/2 English muffin or bagel", "5 unsalted crackers", "2 graham crackers", "6 shortbread cookies or vanilla wafers", "1 cup unsalted rice, noodles or pasta", "1 cup puffed wheat, puffed rice or shredded wheat"] },
    { group: "Vegetables", choices_per_day: [1, 1], options: ["1/2 cup green beans, summer squash, corn, beets, carrots or peas (fresh or frozen, not canned)"] },
    { group: "Fruits", choices_per_day: [3, 4], options: ["1 small apple", "15 grapes", "1/2 cup berries, cherries, applesauce, canned pears or canned pineapple"] },
    { group: "Fats and oils", choices_per_day: [6, null], options: ["1 tsp butter, margarine, oil or mayonnaise"] },
    { group: "Fluids", choices_per_day: [1, 2], options: ["1 cup water, coffee, tea or soda", "1/2 cup Ensure Plus, Boost Plus or Nepro", "1/2 cup milk, half and half, soy or rice milk", "cranberry, apple or grape juice, or Kool-Aid (amount per the textbook box)"] },
  ],
  emergency_kit: ["The foods on this plan", "Can opener", "Two-gallon jugs of distilled water", "Bleach, 1 Tbsp per gallon of water, to sterilize", "Flashlight and extra batteries", "Sharp knife", "Aluminum foil", "Plastic mixing containers and lids", "Measuring cup", "Fork, knife and spoon", "Battery-operated transistor radio", "One-week supply of personal medicines, including blood pressure medicines and phosphate binders (insulin and some others must be kept cold)"],
  storage_tips: ["Store in a clean, dry place such as a new garbage can or rubber tub.", "Label and date food when it is stored.", "Change all stored food and water once a year; eat unused food or donate it to a food bank."],
  conversions: { oz_to_g: 28.35, cup_ml: 240, tbsp_ml: 15, tsp_ml: 5 },
  note: "The source lists US brands and foods. Local starch, protein and fruit equivalents are not given: pick them from the renal exchange list (GET /renal) and the potassium rule above.",
};

export const KNOWN_ISSUES = [
  "Krause Table 35.9 cites KDOQI 2000. KDOQI 2020 replaces it for protein, energy, sodium and calcium, and gives no numeric potassium or phosphorus target. Every target here comes from KDOQI 2020, and the Table 35.9 figures are returned as legacy_krause only.",
  "Protein on dialysis: Krause 1.2 g/kg (hemodialysis) and 1.2-1.5 g/kg (peritoneal dialysis) against KDOQI 2020 1.0-1.2 g/kg for both. Without dialysis: 0.6-1.0 g/kg against 0.55-0.60 g/kg (0.6-0.8 with diabetes).",
  "Energy: Krause 35 kcal/kg (hemodialysis) and 30-35 against KDOQI 2020 25-35 kcal/kg for all stages, set individually.",
  "Sodium: Krause 1.5-2 g/day (1.5-4 g on peritoneal dialysis) against KDOQI 2020 under 2.3 g/day (100 mmol).",
  "Phosphate range on dialysis: Krause Table 35.10 accepts 3-6 mg/dL. KDOQI 2020 6.3.1 aims for the normal range. Both are returned by /labs.",
  "Bicarbonate: Krause 22-25 mEq/L against the KDOQI 2020 target of 24-26 mmol/L (CKD 3-5D).",
  "Adjusted body weight: the KDOQI 2020 weight table prints two formulas. The general row gives IBW + (actual - IBW) x 0.25. The rule for when to adjust nutrient prescriptions (under 95% or over 115% of standard weight) gives edema-free weight + (standard - edema-free) x 0.25. The two give different answers. The API uses the second for 'auto' and returns both. The table's standard weight comes from NHANES II tables, which are not in the API, so Hamwi IBW stands in. KDOQI 1.1.6 also says to use clinical judgement for the weight.",
  "Transplant cholesterol: the Krause table prints 'CHO under 400 mg/day' (footnote: CHO = cholesterol) while the chapter text says under 300 mg/day.",
  "Salt substitute: Table 35.10 suggests it for low potassium, while Box 35.3 says never to use it in an emergency. They apply to different situations.",
  "Naming: KDOQI 2020 writes nPCR, Krause writes nPNA. Both are accepted and treated as the same measure.",
  "KDOQI 2020 makes no protein, sodium or potassium statement for CKD stages 1-2, and no protein statement for transplant recipients. Those targets are returned as null with the reason.",
  "Both documents set targets for metabolically stable patients. Acute illness, inflammation, catabolism and refeeding change them.",
];

// ─── Weight ─────────────────────────────────────────────────────────────────────────

/** Hamwi ideal body weight (KDOQI 2020 weight table): women 100 lb + 5 lb per inch over 5 ft, men 106 lb + 6 lb. Frame: small -10%, large +10%. */
export function hamwiIbwKg(sex, heightCm, frame) {
  const inches = heightCm / 2.54;
  const lb = (sex === "male" ? 106 : 100) + (sex === "male" ? 6 : 5) * (inches - 60);
  let kg = lb * 0.45359237;
  if (frame === "small") kg *= 0.9; else if (frame === "large") kg *= 1.1;
  return kg;
}

function weightBlock(v, sex, frame, basis, warnings, steps) {
  const actual = v.edema_free_weight_kg ?? v.weight_kg;
  const out = { actual_kg: v.weight_kg, edema_free_kg: v.edema_free_weight_kg, weight_basis_requested: basis };
  let ibw = null;
  if (sex && v.height_cm) ibw = hamwiIbwKg(sex, v.height_cm, frame);
  out.ibw_kg = ibw === null ? null : round(ibw, 1);
  if (ibw === null) {
    if (basis === "ibw" || basis === "adjusted") return { error: `weight_basis '${basis}' needs sex and height_cm` };
    out.weight_used_kg = round(actual, 1); out.basis_used = "actual"; out.percent_of_ibw = null;
    warnings.push("Sex and height_cm were not given, so ideal body weight and the 95%/115% adjustment check were not done. The weight sent is used as is, and the legacy Krause figures (per kg of IBW) have no totals.");
    steps.push(`Weight used: ${round(actual, 1)} kg (as sent)`);
    return { block: out, ibw: null };
  }
  const pct = (actual / ibw) * 100;
  out.percent_of_ibw = round(pct, 1);
  const adjustedGeneral = ibw + (actual - ibw) * 0.25;
  const adjustedEdemaFree = actual + (ibw - actual) * 0.25;
  out.adjusted_bw_kg = { rule_for_nutrient_prescriptions: round(adjustedEdemaFree, 1), general_formula: round(adjustedGeneral, 1), note: "KDOQI 2020 prints both formulas; see known issues. Hamwi IBW stands in for the NHANES II standard weight." };
  const outside = pct < 95 || pct > 115;
  let used; let basisUsed;
  if (basis === "actual") { used = actual; basisUsed = "actual"; }
  else if (basis === "ibw") { used = ibw; basisUsed = "ibw"; }
  else if (basis === "adjusted") { used = adjustedGeneral; basisUsed = "adjusted_general_formula"; }
  else if (outside) { used = adjustedEdemaFree; basisUsed = "adjusted_edema_free"; }
  else { used = actual; basisUsed = "actual"; }
  out.weight_used_kg = round(used, 1); out.basis_used = basisUsed;
  steps.push(`IBW (Hamwi${frame && frame !== "medium" ? `, ${frame} frame` : ""}) ${round(ibw, 1)} kg; weight is ${round(pct, 1)}% of IBW${basis === "auto" ? (outside ? " (outside 95-115%, so adjusted)" : " (within 95-115%, so actual weight)") : ""}; weight used ${round(used, 1)} kg`);
  if (basis === "auto" && outside) warnings.push(`Weight is ${round(pct, 1)}% of ideal body weight, outside the 95-115% band, so the adjusted weight was used for the per-kg targets. Use clinical judgement (KDOQI 1.1.6).`);
  return { block: out, ibw };
}

// ─── CKD stage ──────────────────────────────────────────────────────────────────────

/** CKD-EPI 2021 creatinine equation (race-free). Scr in mg/dL. */
export function ckdEpi2021(scrMgDl, ageYears, sex) {
  const female = sex === "female";
  const kappa = female ? 0.7 : 0.9; const alpha = female ? -0.241 : -0.302;
  const r = scrMgDl / kappa;
  return 142 * Math.min(r, 1) ** alpha * Math.max(r, 1) ** -1.2 * 0.9938 ** ageYears * (female ? 1.012 : 1);
}
export function gCategory(egfr) {
  if (egfr >= 90) return { id: "G1", label: "Normal or high", ckd_stage: 1 };
  if (egfr >= 60) return { id: "G2", label: "Mildly decreased", ckd_stage: 2 };
  if (egfr >= 45) return { id: "G3a", label: "Mildly to moderately decreased", ckd_stage: 3 };
  if (egfr >= 30) return { id: "G3b", label: "Moderately to severely decreased", ckd_stage: 3 };
  if (egfr >= 15) return { id: "G4", label: "Severely decreased", ckd_stage: 4 };
  return { id: "G5", label: "Kidney failure", ckd_stage: 5 };
}
export function aCategory(acrMgG) {
  if (acrMgG < 30) return { id: "A1", label: "Normal to mildly increased" };
  if (acrMgG <= 300) return { id: "A2", label: "Moderately increased" };
  return { id: "A3", label: "Severely increased" };
}

export function computeRenalStage(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const sex = String(inp.sex ?? "").trim().toLowerCase();
  if (!["male", "female"].includes(sex)) return { ok: false, error: "'sex' is required: male or female" };
  const r = readAll(inp, { age_years: { min: 18, max: 120, required: true, label: "adults only" }, creatinine_mg_dl: { min: 0.1, max: 30 }, creatinine_umol_l: { min: 9, max: 2650 }, acr_mg_g: { min: 0, max: 100000 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  if (v.creatinine_mg_dl === null && v.creatinine_umol_l === null) return { ok: false, error: "send creatinine_mg_dl or creatinine_umol_l" };
  const scr = v.creatinine_mg_dl !== null ? v.creatinine_mg_dl : v.creatinine_umol_l / 88.4;
  const egfr = ckdEpi2021(scr, v.age_years, sex);
  const g = gCategory(egfr);
  const out = {
    egfr_ml_min_1_73m2: round(egfr, 1), g_category: g,
    inputs_used: { sex, age_years: v.age_years, creatinine_mg_dl: round(scr, 2) },
    equation: "CKD-EPI 2021 creatinine (race-free): 142 x min(Scr/k,1)^a x max(Scr/k,1)^-1.200 x 0.9938^age x 1.012 if female; k = 0.7 (female) or 0.9 (male), a = -0.241 (female) or -0.302 (male)",
    requirements_status: g.ckd_stage <= 2 ? "ckd_1_2" : "ckd_3_5", requirements_ckd_stage: g.ckd_stage >= 3 ? g.ckd_stage : null,
    notes: [],
  };
  if (v.acr_mg_g !== null) out.a_category = aCategory(v.acr_mg_g);
  out.notes.push("A CKD diagnosis needs reduced eGFR or markers of kidney damage for more than 3 months. One value is a screen, not a diagnosis.");
  out.notes.push("Creatinine-based eGFR is unreliable with low muscle mass, amputation, malnutrition, very high meat intake or creatine supplements, and in acute kidney injury or on dialysis.");
  if (g.ckd_stage === 5) out.notes.push("G5: if the patient is on dialysis, send status 'hd' or 'pd' (CKD 5D) instead.");
  if (g.ckd_stage <= 2) out.notes.push("KDOQI 2020 has no protein restriction, sodium or potassium statement for CKD 1-2, so /requirements returns those as null.");
  return { ok: true, data: { ...out, sources: ["CKD-EPI 2021 (Inker et al., N Engl J Med 2021) and KDIGO 2012/2024 G and A categories: not in the supplied KDOQI or Krause documents"], disclaimer: NOT_ADVICE } };
}

// ─── Requirements ───────────────────────────────────────────────────────────────────

function legacyFor(status, weeks) {
  if (status === "transplant") {
    if (weeks !== null && weeks !== undefined) return weeks < 6 ? LEGACY_TABLE_35_9.transplant_early : LEGACY_TABLE_35_9.transplant_late;
    return [...LEGACY_TABLE_35_9.transplant_early, ...LEGACY_TABLE_35_9.transplant_late];
  }
  return LEGACY_TABLE_35_9[status] || [];
}
function legacyWithTotals(row, ibw) {
  const out = { ...row, source: "Krause Table 35.9 (KDOQI 2000): older than KDOQI 2020, shown for comparison only" };
  if (ibw) {
    const t = {};
    if (row.kcal_per_kg_ibw) t.energy_kcal_per_day = times(row.kcal_per_kg_ibw, ibw);
    if (row.protein_g_per_kg_ibw) t.protein_g_per_day = times(row.protein_g_per_kg_ibw, ibw, 1);
    if (row.potassium_mg_per_kg_ibw) t.potassium_mg_per_day = round(row.potassium_mg_per_kg_ibw * ibw);
    if (row.phosphorus_mg_per_kg_ibw) t.phosphorus_mg_per_day_by_weight = times(row.phosphorus_mg_per_kg_ibw, ibw);
    if (row.phosphorus_mg_per_kg_ibw_max) t.phosphorus_mg_per_day_by_weight_max = round(row.phosphorus_mg_per_kg_ibw_max * ibw);
    out.totals_at_ibw = { ibw_kg: round(ibw, 1), ...t };
  }
  return out;
}

export function computeRenalRequirements(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const status = String(inp.status ?? "").trim().toLowerCase();
  if (!STATUSES.includes(status)) return { ok: false, error: `'status' is required: ${STATUSES.join(", ")}` };
  const r = readAll(inp, { weight_kg: { min: 25, max: 300, required: true, label: "kilograms" }, edema_free_weight_kg: { min: 25, max: 300 }, height_cm: { min: 100, max: 230 }, age_years: { min: 18, max: 120, label: "KDOQI 2020 covers adults" }, ckd_stage: { min: 3, max: 5 }, weeks_post_transplant: { min: 0, max: 3000 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const sexRaw = present(inp.sex) ? String(inp.sex).trim().toLowerCase() : null;
  if (sexRaw !== null && !["male", "female"].includes(sexRaw)) return { ok: false, error: "'sex' must be male or female" };
  const frame = present(inp.frame) ? String(inp.frame).trim().toLowerCase() : "medium";
  if (!["small", "medium", "large"].includes(frame)) return { ok: false, error: "'frame' must be small, medium or large" };
  const basis = present(inp.weight_basis) ? String(inp.weight_basis).trim().toLowerCase() : "auto";
  if (!["auto", "actual", "ibw", "adjusted"].includes(basis)) return { ok: false, error: "'weight_basis' must be auto, actual, ibw or adjusted" };
  const diabetes = bool(inp.diabetes);
  const stable = !(inp.metabolically_stable === false || inp.metabolically_stable === "false");
  const warnings = []; const steps = []; const notes = [];
  if (!stable) warnings.push("The targets are for metabolically stable adults. Acute illness, inflammation or catabolism change energy and protein needs: individualize with the renal dietitian.");
  if (status === "ckd_3_5" && v.ckd_stage === null) notes.push("No ckd_stage was sent. The calcium target (CKD 3-4 only) is shown for stages 3 and 4; send ckd_stage 5 to see it withheld.");
  const wb = weightBlock(v, sexRaw, frame, basis, warnings, steps);
  if (wb.error) return { ok: false, error: wb.error };
  const w = wb.block.weight_used_kg;
  const targets = {};

  targets.energy = { kcal_per_kg: { min: 25, max: 35 }, kcal_per_day: times([25, 35], w), statement: "KDOQI 2020 3.1.1", grade: status === "transplant" ? "opinion" : "1C", note: "Pick within the range by age, sex, activity, body composition, weight goals, stage and illness. Indirect calorimetry is the gold standard for resting energy when available (1.4.1)." };
  steps.push(`Energy: 25-35 kcal/kg x ${w} kg = ${targets.energy.kcal_per_day.min}-${targets.energy.kcal_per_day.max} kcal/day`);

  if (status === "ckd_1_2") {
    targets.protein = { restriction: null, reason: "KDOQI 2020 has no protein-restriction statement for CKD stages 1-2. Use general adult guidance (DRI RDA 0.8 g/kg) unless the clinician sets otherwise." };
  } else if (status === "ckd_3_5") {
    if (diabetes) targets.protein = { g_per_kg: { min: 0.6, max: 0.8 }, statement: "KDOQI 2020 3.0.2", grade: "opinion", conditions: "close clinical supervision; keep stable nutritional status and good glycemic control" };
    else targets.protein = { g_per_kg: { min: 0.55, max: 0.6 }, statement: "KDOQI 2020 3.0.1", grade: "1A (quality of life 2C)", conditions: "metabolically stable, close clinical supervision", alternative_very_low_protein: { g_per_kg: { min: 0.28, max: 0.43 }, requires: "keto/amino acid analogs added to meet 0.55-0.60 g/kg", g_per_day: times([0.28, 0.43], w, 1) } };
    targets.protein.g_per_day = times([targets.protein.g_per_kg.min, targets.protein.g_per_kg.max], w, 1);
  } else if (status === "hd" || status === "pd") {
    targets.protein = { g_per_kg: { min: 1.0, max: 1.2 }, g_per_day: times([1.0, 1.2], w, 1), statement: diabetes ? "KDOQI 2020 3.0.4" : "KDOQI 2020 3.0.3", grade: diabetes ? "opinion" : (status === "hd" ? "1C" : "opinion"), conditions: "metabolically stable" + (diabetes ? "; higher intake may be needed if at risk of hyper- or hypoglycemia" : "") };
  } else {
    targets.protein = { restriction: null, reason: "KDOQI 2020 has no protein statement for transplant recipients. The older Krause figures are in legacy_krause." };
  }
  if (targets.protein.g_per_kg) steps.push(`Protein: ${targets.protein.g_per_kg.min}-${targets.protein.g_per_kg.max} g/kg x ${w} kg = ${targets.protein.g_per_day.min}-${targets.protein.g_per_day.max} g/day`);

  if (status === "ckd_1_2") {
    targets.sodium = { limit: null, reason: "KDOQI 2020 sodium statements start at CKD 3. General adult sodium advice applies." };
  } else {
    targets.sodium = { mg_per_day_max: 2300, mmol_per_day_max: 100, salt_g_per_day_max: 5.8, statement: "KDOQI 2020 6.5.1", grade: status === "ckd_3_5" ? "1B" : "1C", purpose: "blood pressure and volume control; also lowers proteinuria in CKD 3-5 (6.5.2, 2A)", note: "2.3 g sodium = 100 mmol = about 5.8 g of salt (the salt figure is arithmetic, not from the source)." };
  }

  if (status === "ckd_1_2") targets.potassium = { target: null, reason: "No KDOQI 2020 potassium statement for CKD 1-2." };
  else targets.potassium = { target: "Adjust intake to keep serum potassium in the normal range (3.5-5.5 mEq/L on Krause Table 35.10).", statement: "KDOQI 2020 6.4.1 and 6.4.2", grade: "opinion", note: "No numeric intake target. Use POST /renal-nutrition/labs for the serum result and its diet action. Krause's older figures are in legacy_krause." };

  if (status === "ckd_1_2") targets.phosphorus = { target: null, reason: "No KDOQI 2020 phosphorus-intake statement for CKD 1-2. Source bioavailability still matters (6.3.2)." };
  else if (status === "transplant") targets.phosphorus = { target: "Consider the absorbability of each source (6.3.2). With low serum phosphate after transplant, a high-phosphorus intake can be considered (6.3.3).", grade: "opinion" };
  else targets.phosphorus = { target: "Adjust intake to keep serum phosphate in the normal range (2.5-4.8 mg/dL; Krause accepts 3-6 mg/dL on dialysis).", statement: "KDOQI 2020 6.3.1", grade: "1B", note: "Count the absorbability of the source (additives are absorbed most, plant phosphorus least; 6.3.2). KDOQI 2020 gives no plant-versus-animal preference for protein itself (3.2.1)." };

  if ((status === "ckd_3_5") && (v.ckd_stage === null || v.ckd_stage <= 4)) targets.calcium = { mg_per_day: { min: 800, max: 1000 }, statement: "KDOQI 2020 6.2.1", grade: "2B", applies_to: "CKD 3-4 not taking active vitamin D analogs", note: "Total elemental calcium, counting food, supplements and calcium-based binders." };
  else if (status === "ckd_3_5") targets.calcium = { mg_per_day: null, reason: "The 800-1,000 mg/day statement covers CKD 3-4 only." };
  else if (status === "hd" || status === "pd") targets.calcium = { target: "Adjust calcium from food, supplements and binders with vitamin D analogs and calcimimetics in mind, to avoid hypercalcemia or calcium overload.", statement: "KDOQI 2020 6.2.2", grade: "opinion" };
  else if (status === "transplant") targets.calcium = { target: null, reason: "No KDOQI 2020 calcium statement for transplant. Krause lists 1.2 g/day (legacy_krause)." };

  if (status !== "ckd_1_2" && status !== "transplant") targets.bicarbonate = { serum_mmol_l: { min: 24, max: 26 }, statement: "KDOQI 2020 6.1.3 (target), 6.1.2 (bicarbonate or citrate, 1C)", grade: "opinion" };

  if (status === "ckd_1_2" || (status === "ckd_3_5" && (v.ckd_stage === null || v.ckd_stage <= 4))) targets.fruit_and_vegetables = { suggestion: "More fruit and vegetables can lower net acid production and may lower weight and blood pressure.", statement: "KDOQI 2020 3.3.2 and 6.1.1", grade: "2C", caution: "Check serum potassium before and after increasing them in advanced CKD." };

  targets.fluid = { kdoqi_2020: null, reason: "KDOQI 2020 gives no fluid statement. Krause's older figures are in legacy_krause. With rapid weight gain between sessions use /adequacy (gain over 4% of body weight)." };

  const legacy = legacyFor(status, v.weeks_post_transplant).map((row) => legacyWithTotals(row, wb.ibw));
  if (LEGACY_NOTES[status]) notes.push(LEGACY_NOTES[status]);
  if (status === "hd" || status === "pd") notes.push("KDOQI 2020 1.5.1: use the 7-point Subjective Global Assessment in CKD 5D. Albumin and nPCR are complementary and are not read alone (1.2.1).");

  return { ok: true, data: { status, status_label: STATUS_LABELS[status], diabetes, metabolically_stable: stable, weight: wb.block, targets, legacy_krause: legacy, steps, warnings, notes, known_issues_ref: "GET /renal-nutrition/reference?section=known_issues", sources: [SOURCE_KDOQI + " - Guidelines 1, 3 and 6", SOURCE_KRAUSE + " (legacy comparison)"], disclaimer: NOT_ADVICE } };
}

// ─── Labs ───────────────────────────────────────────────────────────────────────────

function labRange(spec, ctx) {
  if (ctx.context === "general") {
    if (spec.general_female && ctx.sex === "female") return { range: spec.general_female, set: "normal kidney function, female" };
    return { range: spec.general, set: "normal kidney function" };
  }
  if (spec.dialysis_epo) return ctx.on_epo ? { range: spec.dialysis_epo, set: "dialysis, on EPO" } : { range: spec.dialysis_no_epo, set: "dialysis, not on EPO" };
  if (spec.dialysis_diabetes && ctx.diabetes) return { range: spec.dialysis_diabetes, set: "dialysis, with diabetes" };
  return { range: spec.dialysis, set: "dialysis" };
}

export function computeRenalLabs(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const labsIn = isObj(inp.labs) ? inp.labs : inp;
  const context = present(inp.context) ? String(inp.context).trim().toLowerCase() : (present(inp.on_dialysis) && !bool(inp.on_dialysis) ? "general" : "dialysis");
  if (!["dialysis", "general"].includes(context)) return { ok: false, error: "'context' must be dialysis or general" };
  const sex = present(inp.sex) ? String(inp.sex).trim().toLowerCase() : null;
  const ctx = { context, sex, diabetes: bool(inp.diabetes), on_epo: !(inp.on_epo === false || inp.on_epo === "false") };
  const results = []; const warnings = []; const converted = {};
  const values = {};
  for (const [id, spec] of Object.entries(LABS)) {
    let raw = null; let usedKey = null; let factor = 1;
    for (const [key, f] of spec.keys) { if (present(labsIn[key])) { raw = num(labsIn[key]); usedKey = key; factor = f; break; } }
    if (usedKey === null) continue;
    if (!isNum(raw) || raw < 0) return { ok: false, error: `'${usedKey}' must be a non-negative number` };
    const value = raw * factor;
    values[id] = value;
    if (factor !== 1) converted[usedKey] = `${raw} -> ${round(value, 2)} ${spec.unit}`;
    const { range, set } = labRange(spec, ctx);
    const [lo, hi] = range;
    const status = lo !== null && value < lo ? "low" : hi !== null && value > hi ? "high" : "in_range";
    const row = { id, label: spec.label, value: round(value, 2), unit: spec.unit, range: { min: lo, max: hi }, range_set: set, status };
    if (status === "high") row.diet_action = spec.high; else if (status === "low") row.diet_action = spec.low;
    if (status !== "in_range" && !row.diet_action) row.diet_action = "The table gives no diet action for this direction. Review with the clinician.";
    if (id === "albumin") {
      row.method_note = "Normal ranges depend on the method: bromocresol green 3.5-5 g/dL, bromocresol purple 3-4.5 g/dL. The range used is the bromocresol green one unless 'albumin_method' is 'bcp'.";
      if (context === "general" && String(inp.albumin_method ?? "").toLowerCase() === "bcp") { row.range = { min: spec.general_bcp[0], max: spec.general_bcp[1] }; row.range_set = "normal kidney function, bromocresol purple"; row.status = value < spec.general_bcp[0] ? "low" : value > spec.general_bcp[1] ? "high" : "in_range"; if (row.status === "low") row.diet_action = spec.low; else delete row.diet_action; }
      if (context === "dialysis") row.below_dialysis_target = value < spec.dialysis_target_min ? `below ${spec.dialysis_target_min} g/dL, the level Krause says triggers nutrition intervention in dialysis units` : null;
      if (value < 2.9) row.edema_risk = "Below 2.9 g/dL: fluid leaks from vessels into tissue and is harder to remove with dialysis.";
    }
    if (id === "co2") row.kdoqi_2020_target = "24-26 mmol/L (CKD 3-5D)";
    if (id === "phosphorus" && context === "dialysis") row.kdoqi_2020_target = "normal range (2.5-4.8 mg/dL), KDOQI 6.3.1";
    if (id === "ferritin" && context === "dialysis" && ctx.on_epo === false) row.range_note = "The table prints '50 mcg/L without EPO'; read here as a lower limit.";
    results.push(row);
  }
  if (!results.length) return { ok: false, error: `send at least one lab. Keys: ${Object.values(LABS).map((s) => s.keys.map((k) => k[0]).join(" | ")).join("; ")}` };
  const out = { context, results, out_of_range: results.filter((x) => x.status !== "in_range").map((x) => `${x.label} ${x.status}`), unit_conversions: Object.keys(converted).length ? converted : undefined, warnings, notes: [] };
  if (values.calcium !== undefined && values.phosphorus !== undefined) {
    const product = values.calcium * values.phosphorus;
    out.calcium_phosphorus_product = { value: round(product, 1), limit: 59, status: product > 59 ? "above_limit" : "within_limit", meaning: product > 59 ? "A product over 59 raises the risk of calcium deposits in soft tissue." : "Within the limit of 59.", source: "Krause Table 35.10" };
  }
  if (context === "dialysis") out.notes.push("Dialysis ranges are Krause Table 35.10 'normal for people on dialysis'. Where KDOQI 2020 differs (phosphate, bicarbonate), the result carries kdoqi_2020_target.");
  else out.notes.push("Ranges are the 'normal' column of Krause Table 35.10 (normal kidney function). Send context 'dialysis' for the dialysis column.");
  out.notes.push("KDOQI 1.2.1: albumin, prealbumin and nPCR are not read alone. Diet is only one cause of an abnormal value; treatment, dialysis adequacy, medicines and illness all matter.");
  return { ok: true, data: { ...out, sources: [SOURCE_KRAUSE.replace(": Table 35.9, Table 35.10, Box 35.3", ": Table 35.10"), "SI conversion factors are standard and not in the source"], disclaimer: NOT_ADVICE } };
}

// ─── Dialysis adequacy ──────────────────────────────────────────────────────────────

export function computeDialysisAdequacy(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const modality = String(inp.modality ?? "").trim().toLowerCase();
  if (!["hd", "pd"].includes(modality)) return { ok: false, error: "'modality' is required: hd or pd" };
  const r = readAll(inp, { pre_bun_mg_dl: { min: 1, max: 500 }, post_bun_mg_dl: { min: 0, max: 500 }, pre_urea_mmol_l: { min: 0.5, max: 180 }, post_urea_mmol_l: { min: 0, max: 180 }, session_hours: { min: 0.5, max: 12 }, uf_litres: { min: 0, max: 15 }, post_weight_kg: { min: 25, max: 300 }, kt_v: { min: 0, max: 10 }, ekt_v: { min: 0, max: 10 }, weekly_kt_v: { min: 0, max: 15 }, npna: { min: 0, max: 5 }, npcr: { min: 0, max: 5 }, pre_dialysis_weight_kg: { min: 25, max: 300 }, dry_weight_kg: { min: 25, max: 300 } });
  if (r.error) return { ok: false, error: r.error };
  const v = r.values;
  const sections = {}; const notes = []; const warnings = [];
  const T = ADEQUACY_TARGETS;

  let pre = v.pre_bun_mg_dl; let post = v.post_bun_mg_dl; let unit = "BUN mg/dL";
  if (pre === null && v.pre_urea_mmol_l !== null) { pre = v.pre_urea_mmol_l; post = v.post_urea_mmol_l; unit = "urea mmol/L"; }
  if (pre !== null) {
    if (post === null) return { ok: false, error: "send the post-dialysis value as well as the pre-dialysis value" };
    if (post > pre) return { ok: false, error: "post-dialysis urea or BUN cannot be higher than pre-dialysis" };
    const urr = ((pre - post) / pre) * 100;
    sections.urr = { percent: round(urr, 1), ratio: round(urr / 100, 3), target: "65% or more reduction (Krause)", adequate: urr >= T.urr_percent_min, from: `${pre} -> ${post} (${unit})`, note: "URR is unit-free. It does not adjust for urea generation or fluid removal, unlike Kt/V." };
    if (modality === "pd") warnings.push("URR is a hemodialysis measure. For peritoneal dialysis use weekly Kt/V.");
    // Daugirdas second-generation spKt/V and rate-adjusted eKt/V (not in the supplied sources)
    if (v.session_hours !== null && v.uf_litres !== null && v.post_weight_kg !== null && modality === "hd") {
      const R = post / pre; const t = v.session_hours;
      const arg = R - 0.008 * t;
      if (arg <= 0) return { ok: false, error: "post/pre urea ratio is too low for the Daugirdas equation with this session length: check the values" };
      const sp = -Math.log(arg) + (4 - 3.5 * R) * (v.uf_litres / v.post_weight_kg);
      const ek = sp - (0.6 * sp) / t + 0.03;
      sections.kinetic_modeling = { sp_kt_v: round(sp, 2), ekt_v: round(ek, 2), ekt_v_adequate: ek >= T.ekt_v_min, equation: "spKt/V = -ln(R - 0.008 t) + (4 - 3.5 R) x UF / W; eKt/V = spKt/V - 0.6 spKt/V / t + 0.03 (Daugirdas 1993 and 1995, thrice-weekly schedules)", source: "Not in the supplied Krause or KDOQI documents. Krause says Kt/V is normally computed by program." };
    }
  }
  if (v.kt_v !== null) { if (modality === "hd") sections.kt_v = { value: v.kt_v, target: "above 1.2 for hemodialysis", adequate: v.kt_v >= T.kt_v_hd_min }; else warnings.push("kt_v was ignored for peritoneal dialysis: send weekly_kt_v."); }
  if (v.ekt_v !== null) sections.ekt_v_reported = { value: v.ekt_v, target: "1.2 or greater", adequate: v.ekt_v >= T.ekt_v_min };
  if (v.weekly_kt_v !== null) { if (modality === "pd") sections.weekly_kt_v = { value: v.weekly_kt_v, target: "weekly Kt/V of 2 or more for peritoneal dialysis", adequate: v.weekly_kt_v >= T.kt_v_pd_weekly_min }; else warnings.push("weekly_kt_v was ignored for hemodialysis."); }
  const np = v.npna !== null ? v.npna : v.npcr;
  if (np !== null) {
    const [lo, hi] = T.npna_g_per_kg_day;
    const status = np < lo ? "low" : np > hi ? "high" : "in_range";
    sections.npna = { value: np, target_g_per_kg_day: { min: lo, max: hi }, status, action: status === "high" ? "The patient may need to cut protein, or may be catabolic or eating a lot of protein." : status === "low" ? "The patient may need more protein. With residual urine, a small volume changes the result a lot: keep a 48-hour urine collection." : null, note: "KDOQI 2020 calls this nPCR. It assumes the patient is not catabolic from infection, fever, surgery or trauma, and is a good check of a stable patient's protein intake alongside the diet history and albumin." };
  }
  if (v.pre_dialysis_weight_kg !== null || v.dry_weight_kg !== null) {
    if (v.pre_dialysis_weight_kg === null || v.dry_weight_kg === null) return { ok: false, error: "send both pre_dialysis_weight_kg and dry_weight_kg (the previous post-dialysis weight)" };
    const gain = v.pre_dialysis_weight_kg - v.dry_weight_kg; const pct = (gain / v.dry_weight_kg) * 100;
    sections.interdialytic_weight_gain = { kg: round(gain, 2), percent_of_dry_weight: round(pct, 1), status: pct > T.idwg_percent_max ? "above_limit" : gain < 0 ? "below_dry_weight" : "within_limit", limit: "under 4% of body weight between sessions; about 1.5 kg is the usual gain (Krause Table 35.10)", action: pct > T.idwg_percent_max ? "Cut salty foods and fluid; Krause suggests limiting fluid to about 3 cups plus urine output." : null };
  }
  if (!Object.keys(sections).length) return { ok: false, error: "nothing to assess. Send pre_bun_mg_dl + post_bun_mg_dl (or the urea mmol/L pair), kt_v, ekt_v, weekly_kt_v, npna, or pre_dialysis_weight_kg + dry_weight_kg" };
  const flags = [];
  for (const [k, s] of Object.entries(sections)) { if (s.adequate === false || s.ekt_v_adequate === false) flags.push(`${k} below target`); if (s.status && !["in_range", "within_limit"].includes(s.status)) flags.push(`${k} ${s.status}`); }
  notes.push("Low URR or Kt/V means underdialysis, which also raises BUN and lowers appetite. Fix the dialysis dose first; diet changes cannot replace it.");
  return { ok: true, data: { modality, sections, flags, warnings, notes, sources: [SOURCE_KRAUSE.replace(": Table 35.9, Table 35.10, Box 35.3", ": Table 35.10 and the Evaluation of Dialysis Efficacy text")], disclaimer: NOT_ADVICE } };
}

// ─── Monitoring and plan ────────────────────────────────────────────────────────────

export function monitoringSchedule(status, ckdStage) {
  const weight = status === "hd" || status === "pd" ? "at least monthly" : status === "transplant" ? "at least every 3 months" : status === "ckd_1_2" ? "at least every 6 months" : ckdStage === 3 ? "at least every 6 months (CKD 1-3)" : ckdStage && ckdStage >= 4 ? "at least every 3 months (CKD 4-5)" : "every 6 months in CKD 3, every 3 months in CKD 4-5";
  const out = { weight_and_bmi: { frequency: weight, statement: "KDOQI 2020 1.1.5" } };
  if (status !== "ckd_1_2") {
    out.nutrition_screening = { frequency: "at least twice a year", statement: "KDOQI 2020 1.0.1" };
    out.full_assessment = { frequency: status === "hd" || status === "pd" ? "within 90 days of starting dialysis, then yearly or when screening or referral calls for it" : "yearly, or when screening or referral calls for it", statement: "KDOQI 2020 1.0.3" };
    out.diet_record = { method: "3-day food record, including dialysis and non-dialysis days", statement: "KDOQI 2020 1.6.2" };
  }
  if (status === "hd" || status === "pd") out.composite_index = { tool: "7-point Subjective Global Assessment", statement: "KDOQI 2020 1.5.1" };
  if (status === "hd") out.body_composition = { tool: "multi-frequency bioimpedance when available, 30 minutes or more after dialysis", statement: "KDOQI 2020 1.1.1" };
  out.labs = { note: "Serum potassium, phosphate, calcium, bicarbonate and albumin per the unit's schedule. Use POST /renal-nutrition/labs. Albumin and nPCR are not read alone (1.2.1)." };
  return out;
}

export function computeRenalPlan(input) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const errors = {}; const out = {}; const notes = [];
  let status = present(inp.status) ? String(inp.status).trim().toLowerCase() : null;
  let ckdStage = present(inp.ckd_stage) ? num(inp.ckd_stage) : null;
  if (present(inp.creatinine_mg_dl) || present(inp.creatinine_umol_l)) {
    const s = computeRenalStage(inp);
    if (s.ok) {
      out.stage = s.data;
      if (status === null) { status = s.data.requirements_status; if (ckdStage === null) ckdStage = s.data.requirements_ckd_stage; notes.push(`Status '${status}' was taken from the eGFR stage. Send status to override, or hd/pd/transplant if on dialysis or transplanted.`); }
    } else errors.stage = s.error;
  }
  if (status === null) return { ok: false, error: "send 'status' (ckd_1_2, ckd_3_5, hd, pd, transplant) or creatinine with sex and age_years so the stage can be worked out" };
  if (!STATUSES.includes(status)) return { ok: false, error: `'status' must be ${STATUSES.join(", ")}` };
  const req = computeRenalRequirements({ ...inp, status, ckd_stage: ckdStage ?? inp.ckd_stage });
  if (req.ok) out.requirements = req.data; else errors.requirements = req.error;
  if (isObj(inp.labs)) {
    const lab = computeRenalLabs({ labs: inp.labs, context: status === "hd" || status === "pd" ? "dialysis" : "general", diabetes: inp.diabetes, sex: inp.sex, on_epo: inp.on_epo, albumin_method: inp.albumin_method });
    if (lab.ok) out.labs = lab.data; else errors.labs = lab.error;
  }
  if (isObj(inp.adequacy) && (status === "hd" || status === "pd")) {
    const ad = computeDialysisAdequacy({ modality: status, ...inp.adequacy });
    if (ad.ok) out.adequacy = ad.data; else errors.adequacy = ad.error;
  } else if (isObj(inp.adequacy)) notes.push("adequacy was ignored: it applies to hd and pd only.");
  out.monitoring = monitoringSchedule(status, ckdStage);
  if (!out.requirements && !out.labs && !out.adequacy) return { ok: false, error: Object.values(errors)[0] || "nothing to calculate" };
  return { ok: true, data: { status, ...out, errors, notes, emergency_diet: status === "hd" || status === "pd" ? "GET /renal-nutrition/emergency-diet" : undefined, sources: [SOURCE], disclaimer: NOT_ADVICE } };
}

export function emergencyDiet() { return { ok: true, data: { ...EMERGENCY_DIET, source: SOURCE_KRAUSE.replace(": Table 35.9, Table 35.10, Box 35.3", ": Box 35.3"), disclaimer: NOT_ADVICE } }; }

// ─── Reference ──────────────────────────────────────────────────────────────────────

const REFERENCE_SECTIONS = {
  kdoqi_2020: () => ({ source: SOURCE_KDOQI, statements: KDOQI_2020 }),
  legacy_krause: () => ({ table: "Krause Table 35.9 (KDOQI 2000, Wiggins 2002)", per_kg_basis: "ideal body weight", rows: LEGACY_TABLE_35_9, notes: LEGACY_NOTES, warning: "Older than KDOQI 2020. Use for comparison only." }),
  labs: () => ({ table: "Krause Table 35.10", context_options: ["dialysis", "general"], labs: Object.fromEntries(Object.entries(LABS).map(([id, s]) => [id, { label: s.label, unit: s.unit, input_keys: s.keys.map((k) => k[0]), normal_kidney_function: s.general, dialysis: s.dialysis ?? s.dialysis_epo ?? null }])) }),
  adequacy: () => ({ table: "Krause Table 35.10 and Evaluation of Dialysis Efficacy text", targets: ADEQUACY_TARGETS, formulas: { urr: "(pre BUN - post BUN) / pre BUN", kt_v: "K = urea clearance of the dialyzer, t = time, V = urea distribution volume", ekt_v: "equilibrated Kt/V, adjusted for urea rebound after dialysis" } }),
  weight_adjustment: () => ({ table: "KDOQI 2020 body weight table", hamwi_ibw: "women 100 lb for the first 5 ft + 5 lb per inch; men 106 lb + 6 lb per inch; -10% small frame, +10% large frame", adjust_when: "weight under 95% or over 115% of ideal or standard weight", adjusted_bw_general: "IBW + (actual - IBW) x 0.25", adjusted_bw_for_prescriptions: "edema-free weight + (standard - edema-free) x 0.25", percent_usual_bw: "(usual - current) / usual x 100" }),
  monitoring: () => ({ statements: KDOQI_2020.filter((s) => ["1.0.1", "1.0.3", "1.1.5", "1.2.1", "1.5.1", "1.6.2"].includes(s.id)) }),
  ckd_stages: () => ({ equation: "CKD-EPI 2021 creatinine (not in the supplied documents)", g_categories: [{ id: "G1", egfr: "90 or more" }, { id: "G2", egfr: "60-89" }, { id: "G3a", egfr: "45-59" }, { id: "G3b", egfr: "30-44" }, { id: "G4", egfr: "15-29" }, { id: "G5", egfr: "under 15" }], a_categories: [{ id: "A1", acr_mg_g: "under 30" }, { id: "A2", acr_mg_g: "30-300" }, { id: "A3", acr_mg_g: "over 300" }], statuses: STATUS_LABELS }),
  emergency_diet: () => EMERGENCY_DIET,
  known_issues: () => KNOWN_ISSUES,
};
export const REFERENCE_SECTION_IDS = Object.keys(REFERENCE_SECTIONS);

export function renalReferenceCatalog(section) {
  if (present(section)) {
    const s = String(section).trim().toLowerCase(); const fn = REFERENCE_SECTIONS[s];
    if (!fn) return { ok: false, error: `unknown section '${String(section).slice(0, 40)}'. Use ${REFERENCE_SECTION_IDS.join(", ")}` };
    return { ok: true, data: { source: SOURCE, section: s, [s]: fn(), disclaimer: NOT_ADVICE } };
  }
  const all = { source: SOURCE, sections: REFERENCE_SECTION_IDS, disclaimer: NOT_ADVICE };
  for (const id of REFERENCE_SECTION_IDS) all[id] = REFERENCE_SECTIONS[id]();
  all.related_endpoints = ["GET /renal (renal exchange food list)", "POST /meals/analyze with clinical_conditions kidney_disease (single-meal screen)", "POST /energy/requirements (general energy engine; not used for renal targets)", "GET /dri (calcium and other micronutrient reference)"];
  return { ok: true, data: all };
}
