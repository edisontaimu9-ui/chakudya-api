// Diabetes nutrition calculators and reference tables. Pure functions, no I/O: the routes in index.js read the food tables and pass rows in.
//
// Sources, in the order they win when they disagree:
//   ADA  = American Diabetes Association, Standards of Care in Diabetes 2026 (Diabetes Care 49 Suppl 1): glycaemic targets, hypoglycaemia
//          levels and treatment, pregnancy A1C goal, exercise glucose threshold.
//   KR   = Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 30 (Medical Nutrition Therapy for Diabetes Mellitus and
//          Hypoglycemia of Nondiabetic Origin). Written around ADA 2021, so ADA 2026 replaces it where the two differ (see KNOWN_ISSUES).
//   UCT  = University of Cape Town Exchange Lists Manual 2014 (the list behind exchange_lists).
// Arithmetic added by this API, and not printed in any of the three, is labelled in the result ("api_arithmetic" / notes).
// Clinician-set values (insulin-to-carbohydrate ratio, correction factor, carbohydrate prescription) always take precedence over a rule of thumb.

const SOURCE = "Krause 16th ed. ch. 30; ADA Standards of Care in Diabetes 2026; UCT Exchange Lists Manual 2014";
const NOT_ADVICE = "Education and planning aid built from published tables. It is not a prescription. Insulin doses and glucose targets are set by the treating clinician, and every figure here needs individual clinical judgement.";
const MGDL_PER_MMOL = 18.016; // glucose molar mass conversion (API arithmetic)

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const num = (v) => { if (typeof v === "number") return Number.isFinite(v) ? v : null; if (typeof v === "string" && v.trim() !== "") { const n = Number(v.replace(/,/g, "")); return Number.isFinite(n) ? n : null; } return null; };
const has = (o, k) => o[k] !== undefined && o[k] !== null && o[k] !== "";
const bad = (error) => ({ ok: false, error });
const finish = (data) => ({ ok: true, data: { ...data, sources: [SOURCE], disclaimer: NOT_ADVICE } });

/** Read a glucose given as mg/dL or mmol/L. Returns { mg, mmol } or null, or { error }. */
function readGlucose(o, base, min = 20, max = 1500) {
  const mg = has(o, `${base}_mg_dl`) ? num(o[`${base}_mg_dl`]) : null;
  const mmol = has(o, `${base}_mmol_l`) ? num(o[`${base}_mmol_l`]) : null;
  if (has(o, `${base}_mg_dl`) && mg === null) return { error: `'${base}_mg_dl' must be a number` };
  if (has(o, `${base}_mmol_l`) && mmol === null) return { error: `'${base}_mmol_l' must be a number` };
  if (mg === null && mmol === null) return null;
  const v = mg !== null ? mg : mmol * MGDL_PER_MMOL;
  if (v < min || v > max) return { error: `'${base}' is outside ${min}-${max} mg/dL, check the value and the unit` };
  return { mg: round(v, 1), mmol: round(v / MGDL_PER_MMOL, 1) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Glycaemic status: diagnosis category from labs, plus A1C <-> eAG and mmol/mol
// ---------------------------------------------------------------------------------------------------------------------------------
export const a1cToMmolMol = (a1c) => round((a1c - 2.15) * 10.929, 0); // IFCC master equation (API arithmetic)
export const a1cToEag = (a1c) => 28.7 * a1c - 46.7; // ADAG regression (API arithmetic); reproduces KR Table 30.2 to the mg/dL

export function computeGlycemicStatus(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const warnings = []; const tests = [];
  let a1c = null;
  if (has(input, "a1c_percent")) a1c = num(input.a1c_percent);
  else if (has(input, "a1c_mmol_mol")) { const m = num(input.a1c_mmol_mol); a1c = m === null ? null : m / 10.929 + 2.15; }
  if ((has(input, "a1c_percent") || has(input, "a1c_mmol_mol")) && a1c === null) return bad("'a1c_percent' or 'a1c_mmol_mol' must be a number");
  if (a1c !== null && (a1c < 3 || a1c > 20)) return bad("A1C is outside 3-20 %, check the value and the unit");
  const fpg = readGlucose(input, "fpg"); const ogtt = readGlucose(input, "ogtt_2h"); const random = readGlucose(input, "random");
  for (const g of [fpg, ogtt, random]) if (g && g.error) return bad(g.error);
  if (a1c === null && !fpg && !ogtt && !random) return bad("Send at least one of a1c_percent|a1c_mmol_mol, fpg_mg_dl|fpg_mmol_l, ogtt_2h_mg_dl|ogtt_2h_mmol_l, random_mg_dl|random_mmol_l");
  const a1cUnreliable = input.a1c_unreliable === true || input.a1c_unreliable === "true";
  const symptoms = input.classic_symptoms === true || input.classic_symptoms === "true";
  const rank = { normal: 0, prediabetes: 1, diabetes: 2 };
  const add = (test, value, unit, category, used = true) => tests.push({ test, value, unit, category, used });
  if (a1c !== null) {
    const cat = a1c >= 6.5 ? "diabetes" : a1c >= 5.7 ? "prediabetes" : "normal";
    add("A1C", round(a1c, 1), "%", cat, !a1cUnreliable);
    if (a1cUnreliable) warnings.push("A1C was left out of the category: with hemolysis or blood loss, pregnancy or iron deficiency the diagnosis must use glucose criteria only (KR p.632).");
  }
  if (fpg) add("Fasting plasma glucose", fpg.mg, "mg/dL", fpg.mg >= 126 ? "diabetes" : fpg.mg >= 100 ? "prediabetes" : "normal");
  if (ogtt) add("2-h plasma glucose, 75 g OGTT", ogtt.mg, "mg/dL", ogtt.mg >= 200 ? "diabetes" : ogtt.mg >= 140 ? "prediabetes" : "normal");
  if (random) {
    if (symptoms) add("Random plasma glucose with classic symptoms", random.mg, "mg/dL", random.mg >= 200 ? "diabetes" : "normal");
    else { add("Random plasma glucose", random.mg, "mg/dL", "not_diagnostic", false); warnings.push("A random glucose only counts when classic symptoms of hyperglycaemia or a hyperglycaemic crisis are present (send classic_symptoms: true)."); }
  }
  const used = tests.filter((t) => t.used);
  if (!used.length) return bad("No usable test: a random glucose needs classic_symptoms, and A1C is excluded when a1c_unreliable is true");
  const category = used.reduce((m, t) => (rank[t.category] > rank[m] ? t.category : m), "normal");
  const notes = [];
  if (category !== "normal") notes.push("Without unequivocal hyperglycaemia, confirm with repeat testing (KR Table 30.1 note a). Two different tests above threshold, or one repeated, are how this is usually confirmed.");
  if (category === "diabetes") notes.push("T1DM versus T2DM is a clinical call. C-peptide may help when unclear (KR p.629).");
  const out = { category, tests, criteria: { diabetes: "A1C >=6.5% (48 mmol/mol) OR FPG >=126 mg/dL (7.0 mmol/L) OR 2-h OGTT >=200 mg/dL (11.1 mmol/L) OR random >=200 mg/dL with classic symptoms", prediabetes: "A1C 5.7-6.4% (39-47 mmol/mol) OR FPG 100-125 mg/dL (5.6-6.9 mmol/L) OR 2-h OGTT 140-199 mg/dL (7.8-11.0 mmol/L)", source: "KR Table 30.1" }, warnings, notes };
  if (a1c !== null) out.a1c_conversions = { a1c_percent: round(a1c, 1), a1c_mmol_mol: a1cToMmolMol(a1c), estimated_average_glucose_mg_dl: round(a1cToEag(a1c), 0), estimated_average_glucose_mmol_l: round(a1cToEag(a1c) / MGDL_PER_MMOL, 1), basis: "eAG = 28.7 x A1C - 46.7 (ADAG regression) and mmol/mol = (A1C - 2.15) x 10.929 (IFCC). API arithmetic, not printed in the sources, but they reproduce KR Table 30.2 and the 6.5% = 48 and 7.0% = 53 mmol/mol pairs." };
  return finish(out);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Glucose targets
// ---------------------------------------------------------------------------------------------------------------------------------
export function computeGlucoseTargets(input) {
  const inp = input === undefined || input === null ? {} : input;
  if (!isObj(inp)) return bad("body must be a JSON object");
  const pop = String(inp.population || "nonpregnant_adult").toLowerCase();
  const cgm = (older) => ({ time_in_range_70_180_pct: older ? ">50" : ">70", time_below_70_pct: older ? "<1" : "<4", time_below_54_pct: "<1", time_above_180_pct: older ? "<50" : "<25", time_above_250_pct: older ? "<10" : "<5", population_note: older ? "older adults with high disease burden or limited life expectancy" : "most nonpregnant adults", source: "ADA 2026 Rec 6.3b-6.3c and the CGM targets table" });
  if (pop === "nonpregnant_adult") {
    return finish({ population: pop, targets: { a1c: "<7.0% (<53 mmol/mol) for many nonpregnant adults without severe hypoglycaemia or hypoglycaemia affecting health or quality of life (ADA 2026 Rec 6.3a)", lower_a1c_option: "Lower goals (for example <6.5%, <48 mmol/mol) may suit people in good health with low treatment burden and low hypoglycaemia risk (ADA 2026 Rec 6.4)", preprandial_capillary_glucose_mg_dl: "80-130 (4.4-7.2 mmol/L)", peak_postprandial_capillary_glucose_mg_dl: "<180 (<10.0 mmol/L), measured 1-2 h after the start of the meal", cgm: cgm(false), cgm_older_adults: cgm(true), hypoglycaemia_alert_value_mg_dl: 70 }, notes: ["Goals are individualised: duration of diabetes, age and life expectancy, comorbidities, known cardiovascular disease or advanced microvascular complications, and hypoglycaemia unawareness all move them (KR Table 30.4; ADA 2026).", "KR Table 30.4 gives the same A1C, preprandial and postprandial figures (from ADA 2018) and does not cover CGM metrics."] });
  }
  if (pop === "pregnancy" || pop === "gdm" || pop === "pregestational") {
    return finish({ population: pop, targets: { fasting_mg_dl: "<95 (5.3 mmol/L)", one_hour_postmeal_mg_dl: "<140 (7.8 mmol/L)", two_hour_postmeal_mg_dl: "<120 (6.7 mmol/L)", one_hour_or_two_hour: "Fasting AND EITHER the 1-h OR the 2-h value (KR Table 30.7).", a1c: "<6% (<42 mmol/mol) if achievable without significant hypoglycaemia; may be relaxed to <7% (<53 mmol/mol) to prevent hypoglycaemia (ADA 2026 Rec 15.9). KR gives 6-6.5% for pre-existing diabetes (ADA 2018)." }, notes: ["A1C runs slightly lower in pregnancy because of red cell turnover (ADA 2026 Rec 15.9), so glucose readings carry more weight.", "Add medication if glucose goals are exceeded on two or more occasions in a 1-2 week period without an obvious explanation (KR p.649)."] });
  }
  return bad("'population' must be nonpregnant_adult or pregnancy (gdm and pregestational are accepted as the same pregnancy targets)");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Carbohydrate prescription and distribution
// ---------------------------------------------------------------------------------------------------------------------------------
export const CHO_EXCHANGE_G = 15; // KR p.636: one carbohydrate exchange (serving) = 15 g

export function computeCarbPlan(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const pop = String(input.population || "general").toLowerCase();
  if (!["general", "gdm"].includes(pop)) return bad("'population' must be general or gdm");
  const meals = has(input, "meals") ? num(input.meals) : 3;
  const snacks = has(input, "snacks") ? num(input.snacks) : (pop === "gdm" ? 3 : 0);
  if (meals === null || !Number.isInteger(meals) || meals < 1 || meals > 6) return bad("'meals' must be a whole number from 1 to 6");
  if (snacks === null || !Number.isInteger(snacks) || snacks < 0 || snacks > 6) return bad("'snacks' must be a whole number from 0 to 6");
  const energy = has(input, "energy_kcal") ? num(input.energy_kcal) : null;
  if (has(input, "energy_kcal") && (energy === null || energy < 500 || energy > 6000)) return bad("'energy_kcal' must be 500-6000");
  const slots = []; for (let i = 1; i <= meals; i++) slots.push({ slot: meals === 3 ? ["breakfast", "lunch", "dinner"][i - 1] : `meal ${i}`, kind: "meal" });
  for (let i = 1; i <= snacks; i++) slots.push({ slot: i === snacks && pop === "gdm" ? "bedtime snack" : `snack ${i}`, kind: "snack" });
  const warnings = []; const notes = [];
  let basis; let dailyG = null; let rangeG = null; let slotRanges = null;

  if (has(input, "carb_g_per_day")) {
    dailyG = num(input.carb_g_per_day);
    if (dailyG === null || dailyG < 30 || dailyG > 700) return bad("'carb_g_per_day' must be 30-700");
    basis = "clinician-set carbohydrate prescription (carb_g_per_day)";
  } else if (energy !== null && has(input, "carb_pct")) {
    const pct = num(input.carb_pct);
    if (pct === null || pct < 10 || pct > 80) return bad("'carb_pct' must be 10-80");
    dailyG = (energy * pct) / 100 / 4;
    basis = `clinician-set ${pct}% of ${energy} kcal at 4 kcal/g`;
    notes.push("There is no ideal carbohydrate percentage for everyone with diabetes. The split is individualised to eating pattern, preferences and metabolic goals (KR p.636; ADA 2026).");
  } else if (input.sex === "female" || input.sex === "male") {
    const per = input.sex === "female" ? [3, 4] : [4, 5];
    slotRanges = { meal: per, snack: [1, 2] };
    const lo = meals * per[0] + snacks * 1; const hi = meals * per[1] + snacks * 2;
    rangeG = [lo * CHO_EXCHANGE_G, hi * CHO_EXCHANGE_G];
    dailyG = ((rangeG[0] + rangeG[1]) / 2);
    basis = `Krause starting point: ${per[0]}-${per[1]} carbohydrate servings per meal for adult ${input.sex === "female" ? "women" : "men"} and 1-2 per snack (KR p.650). It is a first plan to be adjusted to the person's usual intake, not a prescription.`;
  } else {
    return bad("Send carb_g_per_day, or energy_kcal with carb_pct, or sex (female|male) for the Krause starting point of servings per meal");
  }

  // distribution
  let weights = slots.map(() => 1);
  if (has(input, "meal_weights")) {
    const w = input.meal_weights;
    if (!Array.isArray(w) || w.length !== slots.length || w.some((x) => num(x) === null || num(x) <= 0)) return bad(`'meal_weights' must be ${slots.length} positive numbers (one per meal then snack)`);
    weights = w.map(Number);
  } else if (rangeG && slotRanges) {
    weights = slots.map((s) => { const r = slotRanges[s.kind]; return (r[0] + r[1]) / 2; });
  }
  let alloc;
  if (pop === "gdm") {
    const min = 175;
    if (dailyG < min) warnings.push(`${round(dailyG)} g/day is below the 175 g/day minimum for pregnancy (Academy of Nutrition and Dietetics EAL via KR p.649).`);
    if (snacks < 2 || snacks > 4) warnings.push("In GDM, carbohydrate is spread over 3 small-to-moderate meals and 2-4 snacks, with an evening snack to prevent accelerated ketosis overnight (KR p.649).");
    const bIdx = slots.findIndex((s) => s.kind === "meal");
    const breakfast = Math.min(30, dailyG * (weights[bIdx] / weights.reduce((a, b) => a + b, 0)));
    const restW = weights.reduce((a, b, i) => (i === bIdx ? a : a + b), 0);
    alloc = weights.map((w, i) => (i === bIdx ? breakfast : ((dailyG - breakfast) * w) / restW));
    notes.push("Breakfast is capped near 30 g because carbohydrate is less well tolerated in the morning (cortisol and growth hormone). Protein foods can be added to satisfy hunger (KR p.649). The 30 g cap and the even split of the rest are the plan's arithmetic.");
  } else {
    const tw = weights.reduce((a, b) => a + b, 0);
    alloc = weights.map((w) => (dailyG * w) / tw);
  }
  const plan = slots.map((s, i) => {
    const g = alloc[i];
    const row = { slot: s.slot, kind: s.kind, carb_g: round(g, 0), carb_exchanges: round(g / CHO_EXCHANGE_G, 1) };
    if (slotRanges) { const r = slotRanges[s.kind]; row.carb_exchanges_range = r; }
    return row;
  });
  const total = alloc.reduce((a, b) => a + b, 0);
  const out = { population: pop, basis, daily: { carb_g: round(total, 0), carb_exchanges: round(total / CHO_EXCHANGE_G, 1), carb_g_range: rangeG, carb_kcal: round(total * 4, 0) }, distribution: plan, warnings, notes: [...notes, "One carbohydrate exchange is 15 g (KR p.636). The split across meals is the API's arithmetic unless a source figure is named above.", "People on a fixed insulin dose or on insulin secretagogues should keep the carbohydrate at each meal consistent from day to day. People on flexible insulin match the dose to the carbohydrate (KR p.635-637, 647)."] };
  if (energy !== null) out.daily.carb_pct_of_energy = round(((total * 4) / energy) * 100, 0);
  out.other_nutrition_targets = {
    sodium_mg_per_day: "<2300 for people with diabetes (KR p.635; ADA 2026 Rec 5). Lower may be set individually when there is also hypertension.",
    fibre_g_per_day: "Krause: 25 g for women, 38 g for men; at least half of grains as whole grains (KR p.637).",
    protein: "No ideal amount for glycaemic control. Usual intake is typically 1-1.5 g/kg/day or 15-20% of energy without kidney disease; individualise (KR p.637). With diabetic kidney disease do not go below 0.8 g/kg/day (ADA 2026; KR p.655). Use /renal-nutrition for CKD targets.",
    alcohol: "Up to 1 drink/day for women and 2 for men, always with food (one drink = 15 g alcohol: 12 oz beer, 5 oz wine or 1.5 oz spirits) (KR p.638).",
    sugar_sweetened_beverages: "Avoid or minimise (KR p.633, 637; ADA 2026).",
  };
  return finish(out);
}

/** Label reading: KR p.637. Subtract half of fibre and sugar alcohol only when together they exceed 5 g per serving. */
export function computeCarbCount(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const total = num(input.total_carb_g);
  if (total === null || total < 0 || total > 500) return bad("'total_carb_g' (per serving) must be 0-500");
  const fibre = has(input, "fibre_g") ? num(input.fibre_g) : 0; const sa = has(input, "sugar_alcohol_g") ? num(input.sugar_alcohol_g) : 0;
  if (fibre === null || fibre < 0 || sa === null || sa < 0) return bad("'fibre_g' and 'sugar_alcohol_g' must be 0 or more");
  const servings = has(input, "servings") ? num(input.servings) : 1;
  if (servings === null || servings <= 0 || servings > 100) return bad("'servings' must be above 0 and at most 100");
  const sub = fibre + sa; const subtract = sub > 5;
  const per = subtract ? total - sub / 2 : total;
  return finish({ per_serving: { total_carb_g: total, fibre_g: fibre, sugar_alcohol_g: sa, counted_carb_g: round(per, 1), carb_exchanges: round(per / CHO_EXCHANGE_G, 1) }, servings, counted_carb_g: round(per * servings, 1), carb_exchanges: round((per * servings) / CHO_EXCHANGE_G, 1), rule: subtract ? "Fibre plus sugar alcohol is more than 5 g per serving, so half of it is subtracted (they supply about 2 kcal/g against 4 kcal/g)." : "Fibre plus sugar alcohol is 5 g or less per serving, so nothing is subtracted. For most people subtracting is not necessary.", rule_source: "KR p.637" });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Exchange list link (rows from exchange_lists)
// ---------------------------------------------------------------------------------------------------------------------------------
const EX_FIELDS = { name: ["food_name", "food_item", "name"], group: ["exchange_type", "exchange_list", "exchange_group", "category"], portion: ["portion", "serving", "measure"], kcal: ["kcal", "calories"], protein_g: ["protein_g", "protein"], carbs_g: ["carbs_g", "cho", "carbohydrate_g"], fat_g: ["fat_g", "fat"] };
function detectExFields(rows) {
  const keys = new Set(); for (const r of rows) if (isObj(r)) Object.keys(r).forEach((k) => keys.add(k));
  const map = {}; for (const [f, cands] of Object.entries(EX_FIELDS)) { const hit = cands.find((c) => keys.has(c)); if (hit) map[f] = hit; }
  return map;
}
const sameKey = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function computeExchangePlan(input, exchangeRows) {
  const inp = input === undefined || input === null ? {} : input;
  if (!isObj(inp)) return bad("body must be a JSON object");
  const rows = (Array.isArray(exchangeRows) ? exchangeRows : []).filter(isObj);
  if (!rows.length) return bad("exchange_lists returned no rows");
  const map = detectExFields(rows);
  for (const need of ["name", "group", "carbs_g"]) if (!map[need]) return bad(`exchange_lists has no ${need} column that this tool recognises (looked for ${EX_FIELDS[need].join(", ")})`);
  const items = rows.map((r) => ({ id: r.id ?? null, name: String(r[map.name] ?? ""), group: String(r[map.group] ?? "ungrouped"), portion: map.portion && r[map.portion] != null ? String(r[map.portion]) : null, kcal: map.kcal ? num(r[map.kcal]) : null, protein_g: map.protein_g ? num(r[map.protein_g]) : null, carbs_g: num(r[map.carbs_g]), fat_g: map.fat_g ? num(r[map.fat_g]) : null }));
  const mean = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 1) : null; };
  const groups = new Map(); for (const it of items) { if (!groups.has(it.group)) groups.set(it.group, []); groups.get(it.group).push(it); }
  const types = [...groups].map(([group, list]) => {
    const t = { group, items: list.length, per_exchange: { kcal: mean(list.map((i) => i.kcal)), protein_g: mean(list.map((i) => i.protein_g)), carbs_g: mean(list.map((i) => i.carbs_g)), fat_g: mean(list.map((i) => i.fat_g)) } };
    t.counts_as_carb_choice = t.per_exchange.carbs_g !== null && t.per_exchange.carbs_g >= 12;
    return t;
  }).sort((a, b) => a.group.localeCompare(b.group));
  const byType = (name) => types.find((t) => sameKey(t.group, name));
  const warnings = []; const out = { field_map: map, counts: { rows: rows.length, groups: types.length }, exchange_types: types, carb_exchange_g: CHO_EXCHANGE_G, notes: ["Per-exchange values are the mean of the rows in each exchange_type, so they follow whatever is stored. Carbohydrate choices are the exchange types averaging 12 g or more of carbohydrate; vegetables (5 g) are not counted unless starchy or eaten in large amounts (KR p.650; the 12 g cut-off is the API's)."], warnings };

  const prescription = (obj, label) => {
    const lines = []; let c = 0; let p = 0; let f = 0; let k = 0; let choices = 0;
    for (const [key, cnt] of Object.entries(obj)) {
      const n = num(cnt); if (n === null || n < 0 || n > 50) return { error: `${label}: '${key}' must be 0-50 exchanges` };
      const t = byType(key); if (!t) return { error: `${label}: unknown exchange type '${key}'. Available: ${types.map((x) => x.group).join(", ")}` };
      const pe = t.per_exchange; const v = (x) => (x === null ? 0 : x);
      c += n * v(pe.carbs_g); p += n * v(pe.protein_g); f += n * v(pe.fat_g); k += n * v(pe.kcal);
      if (t.counts_as_carb_choice) choices += n;
      lines.push({ exchange_type: t.group, exchanges: n, carbs_g: round(n * v(pe.carbs_g), 1), protein_g: round(n * v(pe.protein_g), 1), fat_g: round(n * v(pe.fat_g), 1) });
    }
    const atwater = c * 4 + p * 4 + f * 9;
    return { lines, totals: { carbs_g: round(c, 0), protein_g: round(p, 0), fat_g: round(f, 0), kcal_from_list_values: round(k, 0), kcal_by_4_4_9: round(atwater, 0), pct_energy_by_4_4_9: atwater ? { carbohydrate: round((c * 400) / atwater, 0), protein: round((p * 400) / atwater, 0), fat: round((f * 900) / atwater, 0) } : null }, cho_choices: round(choices, 1) };
  };

  if (isObj(inp.exchanges)) {
    const r = prescription(inp.exchanges, "exchanges"); if (r.error) return bad(r.error);
    out.day = r; out.method = "Grams of carbohydrate, protein and fat are totalled from the exchanges, then multiplied by 4, 4 and 9 for energy and percentages: the Krause worksheet method (KR p.650, Fig. 30.5-30.6).";
  }
  if (isObj(inp.meals)) {
    out.meals = [];
    for (const [meal, obj] of Object.entries(inp.meals)) { if (!isObj(obj)) return bad(`meals.${meal} must be an object of exchange counts`); const r = prescription(obj, `meals.${meal}`); if (r.error) return bad(r.error); out.meals.push({ meal, ...r }); }
  }
  if (isObj(inp.carb_plan)) {
    const cp = computeCarbPlan(inp.carb_plan); if (!cp.ok) return bad(`carb_plan: ${cp.error}`);
    const carbTypes = types.filter((t) => t.counts_as_carb_choice);
    const per = Number(inp.examples_per_slot) > 0 ? Math.min(Number(inp.examples_per_slot), 6) : 3;
    let n = 0;
    out.carb_plan = { daily: cp.data.daily, basis: cp.data.basis, warnings: cp.data.warnings, slots: cp.data.distribution.map((slot) => {
      const ex = []; for (let i = 0; i < per && carbTypes.length; i++) { const t = carbTypes[(n + i) % carbTypes.length]; const list = groups.get(t.group).filter((it) => it.carbs_g !== null && it.carbs_g >= 10); if (list.length) { const it = list[(n * 3 + i) % list.length]; ex.push({ food: it.name, exchange_type: it.group, portion: it.portion, carbs_g: it.carbs_g }); } }
      n += 1; return { ...slot, example_choices: ex };
    }) };
    out.notes.push("example_choices rotate through the carbohydrate exchange types as ideas for one carbohydrate exchange each. They are not a menu.");
  }
  if (!out.day && !out.meals && !out.carb_plan) {
    const type = has(inp, "exchange_type") ? String(inp.exchange_type) : null; const q = has(inp, "q") ? String(inp.q).toLowerCase() : null;
    const limit = has(inp, "limit") ? num(inp.limit) : 50; if (limit === null || limit < 1 || limit > 300) return bad("'limit' must be 1-300");
    let list = items; if (type) list = list.filter((i) => sameKey(i.group, type)); if (q) list = list.filter((i) => i.name.toLowerCase().includes(q));
    out.items = list.slice(0, limit).map((i) => ({ ...i, carb_exchanges: i.carbs_g === null ? null : round(i.carbs_g / CHO_EXCHANGE_G, 1) })); out.counts.matched = list.length;
  }
  return finish(out);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Glycaemic load (rows from glycaemic_index_data, matched with the existing keyword matcher)
// ---------------------------------------------------------------------------------------------------------------------------------
export function computeGlycemicLoad(input, giRows, matchFn) {
  if (!isObj(input) || !Array.isArray(input.foods) || !input.foods.length) return bad("Send { foods: [{ food, carbs_g, gi? }] } with 1-30 foods");
  if (input.foods.length > 30) return bad("At most 30 foods per request");
  const rows = Array.isArray(giRows) ? giRows : []; const out = []; const unmatched = []; let total = 0; let counted = 0; let carbTotal = 0;
  for (const [idx, f] of input.foods.entries()) {
    if (!isObj(f) || !has(f, "food")) return bad(`foods[${idx}] needs a 'food' name`);
    const carbs = num(f.carbs_g);
    if (carbs === null || carbs < 0 || carbs > 500) return bad(`foods[${idx}].carbs_g (available carbohydrate in the portion eaten) must be 0-500`);
    let gi = null; let source = null; let matched = null; let others = [];
    if (has(f, "gi")) { gi = num(f.gi); if (gi === null || gi < 0 || gi > 200) return bad(`foods[${idx}].gi must be 0-200`); source = "supplied by the caller"; }
    else { const m = typeof matchFn === "function" ? matchFn(rows, String(f.food)) : []; if (m.length) { matched = m[0]; others = m.slice(1, 4).map((x) => x.food_name); gi = num(matched.gi_value); source = `${matched.source || "glycaemic_index_data"}${matched.population ? ` (${matched.population})` : ""}`; } }
    if (gi === null) { unmatched.push(String(f.food)); out.push({ food: String(f.food), carbs_g: carbs, gi: null, gl: null, note: "No GI on file. Send gi to include it, or see /glycaemic-index for what is covered." }); carbTotal += carbs; continue; }
    const gl = (gi * carbs) / 100; total += gl; counted += 1; carbTotal += carbs;
    out.push({ food: String(f.food), carbs_g: carbs, gi: round(gi, 1), gi_source: source, matched_row: matched ? matched.food_name : undefined, other_matching_rows: others.length ? others : undefined, gl: round(gl, 1) });
  }
  return finish({ foods: out, meal: { gl_total: round(total, 1), foods_counted: counted, foods_without_gi: unmatched.length, carb_g_total: round(carbTotal, 1) }, formula: "GL = GI x available carbohydrate (g) / 100, summed over the foods in the meal (KR p.637).", notes: ["The total amount of carbohydrate eaten at a meal is the primary predictor of the glucose response. GI and GL are secondary (KR p.636).", "ADA's systematic review found no significant effect of GI or GL diets on A1C beyond 12 weeks, independent of weight loss. Lowering GI or GL may or may not help (KR p.637).", "GI values on file come from the rows listed, and several are Malawian studies on specific recipes. They do not transfer to other recipes."], warnings: unmatched.length ? [`No GI for: ${unmatched.join(", ")}. They are left out of gl_total.`] : [] });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Insulin: carbohydrate ratio, correction factor, mealtime dose
// ---------------------------------------------------------------------------------------------------------------------------------
export function computeInsulin(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const warnings = []; const notes = [];
  const tdd = has(input, "tdd_units") ? num(input.tdd_units) : null;
  if (has(input, "tdd_units") && (tdd === null || tdd < 5 || tdd > 300)) return bad("'tdd_units' (total daily insulin dose) must be 5-300");
  const w = has(input, "weight_kg") ? num(input.weight_kg) : null;
  if (has(input, "weight_kg") && (w === null || w < 5 || w > 400)) return bad("'weight_kg' must be 5-400");
  const out = {};
  if (w !== null && tdd === null) {
    const t = String(input.diabetes_type || "").toLowerCase();
    if (t === "t1dm") out.tdd_estimate = { diabetes_type: "t1dm", units_per_day: [round(0.5 * w, 1), round(1 * w, 1)], basis: "0.5-1 unit/kg/day for non-obese T1DM; about 50% is basal, the rest rapid-acting divided among meals (KR p.644)" };
    else if (t === "t2dm") out.tdd_estimate = { diabetes_type: "t2dm", units_per_day: [round(0.5 * w, 1), round(1.2 * w, 1)], basis: "0.5-1.2 units/kg/day in T2DM; more than 1.5 units/kg may be needed at first to overcome insulin resistance (KR p.644)" };
    else return bad("With weight_kg and no tdd_units, send diabetes_type t1dm or t2dm for the starting TDD range");
    notes.push("Send the person's actual total daily dose as tdd_units to get the carbohydrate ratio and correction factor.");
    return finish({ ...out, warnings, notes });
  }
  let icr; let icrSrc; let cf; let cfSrc;
  const icrIn = has(input, "icr_g_per_unit") ? num(input.icr_g_per_unit) : null; const cfIn = has(input, "cf_mg_dl_per_unit") ? num(input.cf_mg_dl_per_unit) : null;
  if (has(input, "icr_g_per_unit") && (icrIn === null || icrIn < 1 || icrIn > 100)) return bad("'icr_g_per_unit' must be 1-100");
  if (has(input, "cf_mg_dl_per_unit") && (cfIn === null || cfIn < 5 || cfIn > 400)) return bad("'cf_mg_dl_per_unit' must be 5-400");
  if (icrIn !== null) { icr = icrIn; icrSrc = "clinician-set insulin-to-carbohydrate ratio"; } else if (tdd !== null) { icr = 500 / tdd; icrSrc = "500 rule: 500 / total daily dose (KR p.637)"; }
  if (cfIn !== null) { cf = cfIn; cfSrc = "clinician-set correction factor"; } else if (tdd !== null) { cf = 1700 / tdd; cfSrc = "1700 rule: 1700 / total daily dose, mg/dL lowered per unit of rapid-acting insulin (KR p.645)"; }
  if (icr === undefined && cf === undefined) return bad("Send tdd_units (total daily insulin dose), or icr_g_per_unit and cf_mg_dl_per_unit set by the clinician");
  out.ratios = { icr_g_per_unit: icr === undefined ? null : round(icr, 1), icr_source: icrSrc || null, cf_mg_dl_per_unit: cf === undefined ? null : round(cf, 0), cf_mmol_l_per_unit: cf === undefined ? null : round(cf / MGDL_PER_MMOL, 1), cf_source: cfSrc || null, typical_range_note: "KR also quotes about 1-1.5 units per 10-15 g of carbohydrate (p.644). The rules give a starting point only: the person's own glucose records decide." };

  const cur = readGlucose(input, "current_glucose", 20, 800); if (cur && cur.error) return bad(cur.error);
  const tgt = readGlucose(input, "target_glucose", 60, 250); if (tgt && tgt.error) return bad(tgt.error);
  const carbs = has(input, "carbs_g") ? num(input.carbs_g) : null;
  if (has(input, "carbs_g") && (carbs === null || carbs < 0 || carbs > 300)) return bad("'carbs_g' must be 0-300");
  if (cur && cur.mg < 70) {
    return finish({ ...out, dose: null, stop: "Current glucose is below 70 mg/dL (3.9 mmol/L). Treat the low first and do not calculate a mealtime or correction dose now. Use POST /diabetes/hypoglycemia.", warnings: ["No dose was calculated."], notes });
  }
  if (carbs !== null || cur) {
    const dose = {};
    if (carbs !== null) { if (icr === undefined) return bad("A carbohydrate dose needs tdd_units or icr_g_per_unit"); dose.carb_dose_units = round(carbs / icr, 2); }
    if (cur) {
      if (!tgt) return bad("A correction dose needs a target: send target_glucose_mg_dl or target_glucose_mmol_l (set by the clinician)");
      if (cf === undefined) return bad("A correction dose needs tdd_units or cf_mg_dl_per_unit");
      dose.correction_units = cur.mg > tgt.mg ? round((cur.mg - tgt.mg) / cf, 2) : 0;
      if (cur.mg <= tgt.mg) notes.push("Glucose is at or below target, so the correction is 0. The API never subtracts insulin for a low-normal reading.");
    }
    dose.total_units_exact = round((dose.carb_dose_units || 0) + (dose.correction_units || 0), 2);
    const step = has(input, "dose_step") ? num(input.dose_step) : 1;
    if (![0.5, 1].includes(step)) return bad("'dose_step' must be 0.5 or 1");
    dose.dose_step = step; dose.total_units_rounded = Math.round(dose.total_units_exact / step) * step;
    out.dose = dose;
    warnings.push("Insulin still active from an earlier dose is not modelled. Rapid-acting insulin keeps working for 3-6 h (KR Table 30.6), so a correction soon after a dose can stack and cause hypoglycaemia.");
    notes.push("Many people need more insulin per gram of carbohydrate at breakfast, because counter-regulatory hormones are higher in the morning (KR p.644).");
    notes.push("Rapid-acting analogues work best taken 10-15 min before the meal (lag time). Regular insulin needs 30-60 min (KR p.643, 647).");
    notes.push("Round to the pen or syringe increment, then check the glucose 1-2 h after a rapid-acting dose (KR Table 30.6). Treat this as a starting estimate for the clinician to confirm.");
  }
  return finish({ ...out, warnings, notes });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Hypoglycaemia
// ---------------------------------------------------------------------------------------------------------------------------------
export function computeHypoglycemia(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const g = readGlucose(input, "glucose", 10, 800); if (g && g.error) return bad(g.error);
  const assist = input.assistance_needed === true || input.assistance_needed === "true";
  const swallow = !(input.able_to_swallow === false || input.able_to_swallow === "false");
  const agi = input.on_alpha_glucosidase_inhibitor === true || input.on_alpha_glucosidase_inhibitor === "true";
  const symptoms = input.symptoms === true || input.symptoms === "true";
  if (!g && !assist) return bad("Send glucose_mg_dl or glucose_mmol_l, or assistance_needed: true for a severe event");
  let level = null;
  if (assist) level = 3; else if (g.mg < 54) level = 2; else if (g.mg < 70) level = 1;
  const out = { glucose: g || undefined, level, level_definitions: { 1: "glucose <70 and >=54 mg/dL (<3.9 and >=3.0 mmol/L)", 2: "glucose <54 mg/dL (<3.0 mmol/L), clinically significant", 3: "severe event with altered mental and/or physical status needing assistance, whatever the glucose", source: "ADA 2026 Table 6.4" } };
  const steps = []; const notes = [];
  if (level === null) {
    out.assessment = symptoms ? "Glucose is 70 mg/dL or higher, so this is not hypoglycaemia by the alert value. Symptoms such as shakiness or sweating can have other causes. Recheck, and look at timing, food and medication (KR p.656)." : "Glucose is 70 mg/dL (3.9 mmol/L) or higher, no treatment needed for hypoglycaemia.";
  } else if (level === 3 || !swallow) {
    out.assessment = "Severe hypoglycaemia, or unable to swallow safely.";
    steps.push("Do not give food or drink by mouth to someone who cannot swallow.", "Give glucagon (subcutaneous or intramuscular) if available and call emergency services now. Preparations that need no mixing are preferred (ADA 2026 Rec 6.16).", "Turn the person onto their side to prevent choking. Nausea and vomiting are common after glucagon.", "Once awake and able to swallow, give a carbohydrate food or drink (KR p.653).");
  } else {
    out.assessment = level === 2 ? "Level 2 hypoglycaemia: treat immediately." : "Level 1 hypoglycaemia: treat immediately (glucose below 70 mg/dL).";
    steps.push(agi ? "Take 15-20 g of glucose (dextrose tablets or gel), not table sugar: acarbose and miglitol block the digestion of sucrose to glucose (KR Table 30.5)." : "Take 15-20 g of glucose. Preferred is glucose tablets (4) or gel; 4-6 oz (120-180 mL) of fruit juice or regular soft drink also gives about 15 g (KR Box 30.6; ADA 2026 Rec 6.15).", "Avoid fat and protein foods for the first treatment (ADA 2026 Rec 6.15). Protein does not prevent a later low (KR p.638).", "Recheck in 15 minutes (ADA 2026) (KR says 10-15 min). If glucose is still below 70 mg/dL (3.9 mmol/L), repeat 15 g.", "Repeat until glucose is back in range. If the next meal is more than 1 h away, test again 60 min after treating, as more carbohydrate may be needed (KR Box 30.6).");
    if (level === 2) steps.push("Level 2 or repeated lows: tell the care team the same day. Review insulin or secretagogue dose, timing and meals, exercise and alcohol (KR Box 30.5).");
  }
  out.steps = steps;
  if (level !== null) notes.push("Common causes: wrong insulin dose or timing, missed or late meals, unplanned or prolonged exercise, alcohol without food (KR Box 30.5). Alcohol and exercise can cause lows many hours later.");
  out.notes = notes;
  out.carbs_to_treat_g = (level === 1 || level === 2) && swallow ? [15, 20] : null;
  return finish(out);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 8. Exercise
// ---------------------------------------------------------------------------------------------------------------------------------
export function computeExerciseCarbs(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const dur = num(input.duration_min);
  if (dur === null || dur < 5 || dur > 600) return bad("'duration_min' must be 5-600");
  const onIns = input.on_insulin_or_secretagogue === true || input.on_insulin_or_secretagogue === "true";
  const pre = readGlucose(input, "pre_exercise_glucose", 20, 800); if (pre && pre.error) return bad(pre.error);
  const ketones = input.ketones_present === true || input.ketones_present === "true";
  const intensity = String(input.intensity || "moderate").toLowerCase();
  if (!["moderate", "vigorous"].includes(intensity)) return bad("'intensity' must be moderate or vigorous");
  const out = { duration_min: dur, intensity, on_insulin_or_secretagogue: onIns }; const notes = []; const warnings = [];
  if (ketones) warnings.push("Ketones present: avoid vigorous activity (ADA via KR p.639). In T1DM, 12-48 h without insulin plus ketosis can worsen with exercise.");
  if (pre && pre.mg < 70) warnings.push("Pre-exercise glucose is below 70 mg/dL: treat the low first (POST /diabetes/hypoglycemia), then reassess before starting.");
  if (!onIns) {
    out.extra_carbohydrate_g = 0;
    notes.push("Extra carbohydrate is generally not needed in people with T2DM not treated with insulin or an insulin secretagogue; it only adds energy (KR p.640).");
  } else if (dur < 30) {
    out.extra_carbohydrate_g = pre && pre.mg < 100 ? 15 : 0;
    notes.push("Moderate exercise under 30 min usually needs no extra carbohydrate or insulin change unless glucose is low beforehand (KR p.639).");
  } else {
    const lo = (15 * dur) / 60; const hi = (15 * dur) / 30;
    out.extra_carbohydrate_g_range = [round(lo, 0), round(hi, 0)];
    out.rule = "15 g of carbohydrate for every 30-60 min of activity, over and above the usual meals, because moderate exercise raises glucose uptake by 8-13 g/h (KR p.639). The range is 15 g per 60 min to 15 g per 30 min; use the upper end for harder or longer sessions. API arithmetic on that rule.";
    out.timing = "Take carbohydrate after the first 40-60 min of prolonged exercise and again soon afterwards, because the risk of late-onset hypoglycaemia runs for up to 24-30 h as glycogen is rebuilt (KR p.639-640).";
    if (dur > 45) notes.push("Moderate to strenuous activity over 45-60 min often needs a reduction of the rapid-acting insulin, about 1-2 units as a starting point, or a larger cut in the total daily dose for prolonged vigorous exercise (KR p.640). The dose change belongs to the prescriber.");
  }
  if (pre) {
    out.pre_exercise_glucose = pre;
    if (onIns && pre.mg < 100) notes.push("KR (ADA 2021) suggests extra carbohydrate if pre-exercise glucose is under 100 mg/dL (5.6 mmol/L) for people on insulin or secretagogues. ADA 2026 puts the threshold at 90 mg/dL (5.0 mmol/L) when insulin cannot be lowered during the workout. Both are shown because they differ.");
    if (pre.mg > 250 && !ketones) notes.push("High glucose alone is no reason to postpone exercise if the person feels well and ketones are negative (KR p.639).");
  }
  return finish({ ...out, warnings, notes });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 9. Plan: status + targets + carb plan in one call
// ---------------------------------------------------------------------------------------------------------------------------------
export function computeDiabetesPlan(input) {
  if (!isObj(input)) return bad("body must be a JSON object");
  const out = {}; const warnings = [];
  if (isObj(input.labs)) { const r = computeGlycemicStatus(input.labs); if (!r.ok) return bad(`labs: ${r.error}`); out.glycemic_status = r.data; }
  const t = computeGlucoseTargets({ population: input.population === "gdm" || input.population === "pregnancy" ? "pregnancy" : "nonpregnant_adult" }); out.glucose_targets = t.data;
  if (isObj(input.carb)) { const r = computeCarbPlan({ population: input.population === "gdm" ? "gdm" : "general", ...input.carb }); if (!r.ok) return bad(`carb: ${r.error}`); out.carb_plan = r.data; }
  else warnings.push("No carb section was sent, so no carbohydrate plan was made. Send carb: { carb_g_per_day | energy_kcal + carb_pct | sex, meals, snacks }.");
  const keep = (x) => { if (x) { delete x.sources; delete x.disclaimer; } return x; };
  Object.values(out).forEach(keep);
  return finish({ ...out, warnings });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 10. Reference
// ---------------------------------------------------------------------------------------------------------------------------------
const KNOWN_ISSUES = [
  { topic: "Random glucose criterion", detail: "Krause p.632 item 4 prints 'random plasma glucose <200 mg/dL'. It is a typo for >=200 mg/dL (Table 30.1 on p.631 is correct). The API uses >=200." },
  { topic: "Blood pressure goal", detail: "Krause p.634 and Table 30.9 give a goal around 140/90 mmHg (ADA 2018-2021). ADA 2026 recommends <130/80 mmHg when it can be safely reached, so this API does not use the Krause figure." },
  { topic: "Hypoglycaemia recheck time", detail: "Krause Box 30.6: retest in 10-15 min. ADA 2026 Rec 6.15: 15 min after treatment. The API says 15 min and names Krause's 10-15." },
  { topic: "Pre-exercise glucose threshold", detail: "Krause p.640 (ADA 2021): supplementary carbohydrate if glucose <100 mg/dL. ADA 2026: <90 mg/dL when insulin cannot be lowered. Both are shown." },
  { topic: "Milk and starch exchange values", detail: "Krause Table 30.8 gives fat-free milk 12 g carbohydrate, 8 g protein, 0-3 g fat, 100 kcal and starch 1 g fat. UCT (the list in exchange_lists) gives fat-free milk 80 kcal and 0-1 g fat (use 0) and starch 0-1 g fat (use 0). The exchange plan uses whatever exchange_lists stores, so it follows UCT." },
  { topic: "Glycaemic targets in Krause", detail: "Krause Table 30.4 reproduces ADA 2018. ADA 2026 adds the CGM metrics (time in range) and updated hypoglycaemia levels; /glucose-targets uses ADA 2026." },
  { topic: "Exchange list is South African", detail: "exchange_lists holds the UCT 2014 list (South African foods and brands). Malawian staples such as nsima appear only as maize meal portions. A Malawi-specific list and Malawi diabetes guidelines are not loaded yet." },
  { topic: "Glycaemic index coverage", detail: "glycaemic_index_data holds a small number of Malawian GI studies on specific recipes. Most foods have no GI on file." },
  { topic: "Not in either source", detail: "eAG and mmol/mol conversion formulas, mg/dL to mmol/L conversion (18.016), the even split of carbohydrate across meals, the 12 g carb-choice cut-off and the 15 g per 30-60 min exercise range arithmetic are the API's, and are labelled where used." },
];

const SECTIONS = {
  diagnosis: { title: "Diagnosis and prediabetes (KR Table 30.1)", criteria: { diabetes: ["A1C >=6.5% (48 mmol/mol)", "FPG >=126 mg/dL (7.0 mmol/L), fasting at least 8 h", "2-h plasma glucose >=200 mg/dL (11.1 mmol/L) in a 75 g OGTT", "Random plasma glucose >=200 mg/dL (11.1 mmol/L) with classic symptoms"], prediabetes: ["A1C 5.7-6.4% (39-47 mmol/mol)", "FPG 100-125 mg/dL (5.6-6.9 mmol/L)", "2-h OGTT 140-199 mg/dL (7.8-11.0 mmol/L)"] }, notes: ["Confirm with repeat testing without unequivocal hyperglycaemia.", "Use glucose criteria only with hemolysis, blood loss, pregnancy or iron deficiency (A1C unreliable)."] },
  a1c_eag: { title: "A1C and estimated average glucose (KR Table 30.2)", rows: [[4, 68], [4.5, 82], [5, 97], [5.5, 111], [6, 126], [6.5, 140], [7, 154], [7.5, 169], [8, 183], [8.5, 197], [9, 212], [9.5, 226], [10, 240], [10.5, 255], [11, 269], [11.5, 283], [12, 298]].map(([a, g]) => ({ a1c_percent: a, eag_mg_dl: g })) },
  glycemic_targets: { title: "Glucose targets, nonpregnant adults (ADA 2026)", ...computeGlucoseTargets({}).data },
  pregnancy_targets: { title: "Glucose targets in pregnancy (KR Table 30.7; ADA 2026 Rec 15.9)", ...computeGlucoseTargets({ population: "pregnancy" }).data, gdm_screening: "Screen at 24-28 weeks with a one-step 75 g OGTT, or a two-step 50 g non-fasting screen then 100 g OGTT. Test earlier for overt diabetes if risk factors exist (KR p.629). Postpartum screening 4-12 weeks, then every 1-3 years (KR p.631)." },
  hypoglycemia: { title: "Hypoglycaemia levels and treatment (ADA 2026 Table 6.4, Rec 6.15-6.16; KR Box 30.5-30.6)", levels: { 1: "<70 and >=54 mg/dL", 2: "<54 mg/dL", 3: "severe event needing assistance" }, treatment: ["15-20 g glucose (4 glucose tablets, gel, or 4-6 oz juice or regular soft drink)", "Recheck at 15 min, repeat if still <70 mg/dL", "If the next meal is over 1 h away, test again after 60 min", "Glucagon for severe events; turn the person on their side"], whipple_triad: "For hypoglycaemia in people without diabetes: low glucose, symptoms at the same time, symptoms resolve when glucose is restored (KR p.656). Management: 5-6 small meals, spread carbohydrate (KR Box 30.8)." },
  insulin_rules: { title: "Insulin rules of thumb (KR p.637, 644-645)", rules: { insulin_to_carbohydrate_ratio: "500 / total daily dose = grams of carbohydrate covered by 1 unit of rapid-acting insulin (example: TDD 50 gives 1 unit per 10 g)", correction_factor: "1700 / total daily dose = mg/dL lowered by 1 unit of rapid-acting insulin over 2-4 h (example: TDD 50 gives 35 mg/dL, about 2 mmol/L)", total_daily_dose: "T1DM non-obese 0.5-1 unit/kg/day, about 50% basal; T2DM 0.5-1.2 units/kg/day, sometimes more than 1.5", typical_carb_ratio: "about 1-1.5 units per 10-15 g carbohydrate" }, note: "Starting points only. Doses are the prescriber's." },
  insulin_action_times: { title: "Action times of insulin preparations (KR Table 30.6, ADA 2018 data)", rows: [
    { type: "Rapid-acting: lispro", onset: "<0.25-0.5 h", peak: "0.5-2.5 h", duration: "3-6.5 h", monitor_in: "1-2 h" }, { type: "Rapid-acting: aspart", onset: "<0.25 h", peak: "0.5-1.0 h", duration: "3-5 h", monitor_in: "1-2 h" }, { type: "Rapid-acting: glulisine", onset: "<0.25 h", peak: "1-1.5 h", duration: "3-5 h", monitor_in: "1-2 h" },
    { type: "Short-acting: human regular", onset: "0.5-1 h", peak: "2-3 h", duration: "3-6 h", monitor_in: "4 h (next meal)" }, { type: "Intermediate: human NPH", onset: "2-4 h", peak: "4-10 h", duration: "10-16 h", monitor_in: "8-12 h" },
    { type: "Basal analogue: glargine", onset: "2-4 h", peak: "peakless", duration: "20-24 h", monitor_in: "10-12 h" }, { type: "Basal analogue: detemir", onset: "0.8-2 h (dose dependent)", peak: "peakless", duration: "12-24 h (dose dependent)", monitor_in: "10-12 h" },
    { type: "Premixed 70/30 (70% NPH, 30% regular)", onset: "0.5-1 h", peak: "dual", duration: "10-16 h" }, { type: "Premixed lispro 75/25 or 50/50", onset: "<0.25 h", peak: "dual", duration: "10-16 h" }, { type: "Premixed aspart 70/30", onset: "<0.25 h", peak: "dual", duration: "15-18 h" }], note: "Degludec and inhaled insulin are listed without figures in the source. Check which insulins are stocked in Malawi." },
  exercise: { title: "Exercise and diabetes (KR p.639-640; ADA 2026)", rules: ["150 min/week of moderate aerobic activity over at least 3 days, no more than 2 days in a row without; resistance training twice a week in T2DM; children 60 min/day", "On insulin or secretagogues: 15 g carbohydrate per 30-60 min of activity beyond usual meals (8-13 g/h glucose uptake)", "Under 30 min of moderate activity usually needs nothing extra", "Rapid-acting insulin: about 1-2 units less for 45-60+ min of moderate to strenuous activity", "No vigorous activity with ketones present; high glucose alone is not a reason to postpone if ketones are negative"] },
  sick_day: { title: "Sick-day guidelines (KR Box 30.7)", rules: ["Keep taking insulin and other glucose-lowering medicine. Need may increase.", "Check glucose and ketones at least 4 times a day. Glucose above 250 mg/dL with ketones means more insulin is needed.", "Drink fluids every hour. If vomiting, diarrhoea or fever, sips of 1-2 tablespoons every 15-30 min. Call the team if unable to take fluids for over 4 h.", "If normal food is not tolerated, take soft or liquid carbohydrate: 10-15 g every 1-2 h or 50 g every 3-4 h (about 150-200 g/day).", "Call the care team if illness continues for more than 1 day."] },
  nutrition_recommendations: { title: "Nutrition recommendations summary (KR p.633-638; ADA 2026)", items: ["No ideal macronutrient split. Individualise (KR p.636).", "Total carbohydrate eaten is the main driver of the glucose response; counting or estimating is a key strategy (KR p.636).", "Sucrose can replace other carbohydrate isocalorically, but sugar-sweetened beverages should be avoided (KR p.637).", "Fibre 25 g (women) and 38 g (men) per day; at least half of grains whole (KR p.637).", "Sodium under 2300 mg/day (KR p.635).", "Replace saturated and trans fat with unsaturated fat; fish twice a week; omega-3 supplements are not recommended (KR p.638).", "Alcohol: up to 1 drink (women) or 2 (men) a day with food; none in pregnancy, history of dependence, pancreatitis or severe hypertriglyceridaemia (KR p.638).", "No routine vitamin or mineral supplements without a deficiency. Metformin lowers vitamin B12, so check it periodically (KR p.638-639).", "MNT lowers A1C by 1.0-1.9% in T1DM and 0.3-2% in T2DM (KR p.635)."] },
  food_list_values: { title: "Energy and macronutrients per exchange", krause_table_30_8: [
    { list: "Starch", carbohydrate_g: 15, protein_g: 3, fat_g: 1, kcal: 80 }, { list: "Fruit", carbohydrate_g: 15, protein_g: 0, fat_g: 0, kcal: 60 }, { list: "Milk, fat-free / low-fat 1%", carbohydrate_g: 12, protein_g: 8, fat_g: "0-3", kcal: 100 }, { list: "Milk, reduced-fat 2%", carbohydrate_g: 12, protein_g: 8, fat_g: 5, kcal: 120 }, { list: "Milk, whole", carbohydrate_g: 12, protein_g: 8, fat_g: 8, kcal: 160 }, { list: "Sweets, desserts, other carbohydrates", carbohydrate_g: 15, protein_g: "varies", fat_g: "varies", kcal: "varies" }, { list: "Non-starchy vegetables", carbohydrate_g: 5, protein_g: 2, fat_g: 0, kcal: 25 }, { list: "Protein, lean", carbohydrate_g: 0, protein_g: 7, fat_g: 2, kcal: 45 }, { list: "Protein, medium-fat", carbohydrate_g: 0, protein_g: 7, fat_g: 5, kcal: 75 }, { list: "Protein, high-fat", carbohydrate_g: 0, protein_g: 7, fat_g: 8, kcal: 100 }, { list: "Fats", carbohydrate_g: 0, protein_g: 0, fat_g: 5, kcal: 45 }, { list: "Alcohol (1 equivalent)", carbohydrate_g: "varies", kcal: 100 }],
    uct_2014: [{ list: "Starch", carbohydrate_g: 15, protein_g: 3, fat_g: "0-1 (use 0)", kcal: 80 }, { list: "Lean meat", protein_g: 7, fat_g: "0-3 (use 2)", kcal: 45 }, { list: "Medium-fat meat", protein_g: 7, fat_g: "4-7 (use 5)", kcal: 75 }, { list: "High-fat meat", protein_g: 7, fat_g: "8+", kcal: 100 }, { list: "Milk, fat-free / 1%", carbohydrate_g: 12, protein_g: 8, fat_g: "0-1 (use 0)", kcal: 80 }, { list: "Milk, low-fat 2%", carbohydrate_g: 12, protein_g: 8, fat_g: 5, kcal: 120 }, { list: "Milk, full cream", carbohydrate_g: 12, protein_g: 8, fat_g: 8, kcal: 160 }, { list: "Fruit", carbohydrate_g: 15, kcal: 60 }, { list: "Vegetables", carbohydrate_g: 5, protein_g: 2, kcal: 25 }, { list: "Fat", fat_g: 5, kcal: 45 }, { list: "Sugar", carbohydrate_g: 15, kcal: "about 60 (varies)" }, { list: "Alcohol", carbohydrate_g: "0-15", kcal: 100 }],
    note: "UCT: starchy vegetables used as a vegetable exchange carry 5 g, not 15 g (portion sizes are smaller). Legumes count as 1 starch and 1 lean meat. Peanut butter is a high-fat meat with no carbohydrate." },
  medication_nutrition: { title: "Glucose-lowering drugs with nutrition relevance (KR Table 30.5, p.640-643)", rows: [{ class: "Biguanide (metformin)", note: "Take with food; GI effects; lowers vitamin B12 and folate; contraindicated with eGFR <30; no hypoglycaemia alone" }, { class: "Sulfonylureas, glinides", note: "Insulin secretagogues: hypoglycaemia and weight gain; meal timing matters; glyburide not for diabetic kidney disease" }, { class: "Thiazolidinediones", note: "Weight gain, fluid retention, heart failure risk" }, { class: "GLP-1 receptor agonists", note: "Weight loss, slower gastric emptying, nausea; once-daily to once-weekly" }, { class: "DPP-4 inhibitors", note: "Weight neutral, no hypoglycaemia alone" }, { class: "SGLT2 inhibitors", note: "Weight loss, genitourinary infections, volume depletion; rare DKA" }, { class: "Alpha-glucosidase inhibitors (acarbose, miglitol)", note: "Treat hypoglycaemia with glucose, not sucrose; flatulence and diarrhoea" }, { class: "Amylin mimetic (pramlintide)", note: "Severe hypoglycaemia risk within 3 h of injection" }, { class: "Insulin", note: "See insulin_action_times; consistent carbohydrate with premixed or fixed doses" }] },
  known_issues: { title: "Differences between sources and gaps", items: KNOWN_ISSUES },
};

export function diabetesReferenceCatalog(section) {
  if (!section) return finish({ sections: Object.entries(SECTIONS).map(([key, v]) => ({ key, title: v.title })) });
  const s = SECTIONS[String(section).toLowerCase()];
  if (!s) return bad(`Unknown section '${section}'. Use one of: ${Object.keys(SECTIONS).join(", ")}`);
  return finish({ section: String(section).toLowerCase(), ...s });
}
