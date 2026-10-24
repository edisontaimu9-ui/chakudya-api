// Enteral nutrition (tube feeding) prescription calculator (POST /enteral-nutrition/calculate, GET /enteral-nutrition/reference).
// Pure functions, no I/O. The formula row lookup (enteral_formulas) is done in index.js; this module only maps a row to numbers.
//
// Follows the Edge Nutrition "Tube Feeding Calculation Guide" (12 steps): volume = kcal needs / kcal per ml, rate = volume / hours,
// protein and water from the rounded rate, free water flush = fluid needs - formula water. Every fixed number below comes from that guide.

export const SOURCE = "Edge Nutrition, Tube Feeding Calculation Guide (www.edge-clinical.com), 12-step method";
const DISCLAIMER =
  "Calculation aid only. Check that the patient is safe to feed enterally (functional gut, low or no vasopressors), confirm the formula " +
  "values against your facility formulary card, and individualise to the patient and local protocol. Not a prescription.";

export const GUIDE = {
  max_adult_rate_ml_per_hr: 150,
  refeeding_adult_kcal_per_kg: [10, 20],
  refeeding_paediatric_pct_of_goal: [40, 50],
  refeeding_adult_fluid_ml_per_day_below: 2000,
  trophic_adult_rate_ml_per_hr: [10, 20],
  min_flush_ml: 30,
  adult_flush_ml_per_flush_below: 300,
  adult_flush_ml_start: [100, 150],
  typical_delivery_pct: 65,
  buffer_hours: [20, 22],
  advancement_ml_per_step_adult: 10,
  advancement_interval_hours: 4,
};

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const round5 = (x) => Math.round(x / 5) * 5;
const present = (v) => v !== undefined && v !== null && v !== "";
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const fail = (error) => ({ ok: false, error });

function readNum(inp, key, { min = null, minExclusive = false, max = null, required = false } = {}) {
  if (!present(inp[key])) return required ? { error: `'${key}' is required` } : { value: null };
  const v = typeof inp[key] === "number" ? inp[key] : Number(inp[key]);
  if (!Number.isFinite(v)) return { error: `'${key}' must be a number` };
  if (min !== null && (minExclusive ? v <= min : v < min)) return { error: `'${key}' must be ${minExclusive ? "greater than" : "at least"} ${min}` };
  if (max !== null && v > max) return { error: `'${key}' must be at most ${max}` };
  return { value: v };
}
const readBool = (v) => v === true || v === "true" || v === 1 || v === "1" || v === "yes";

// ── formula row mapping ──────────────────────────────────────────────────────
// The enteral_formulas column names are not fixed anywhere in the repo, so a row is read through a list of likely names.
// Each entry: [column, multiplier to reach the unit used here]. kcal per ml, protein g per litre, water ml per litre.
const COLS = {
  kcal_per_ml: [["kcal_per_ml", 1], ["energy_kcal_per_ml", 1], ["kcal_ml", 1], ["energy_density_kcal_ml", 1], ["calories_per_ml", 1], ["kcal_per_100ml", 0.01], ["energy_kcal_per_100ml", 0.01], ["kcal_per_l", 0.001], ["kcal_per_litre", 0.001], ["kcal_per_liter", 0.001], ["energy_kcal_per_l", 0.001], ["calories_per_liter", 0.001], ["calories_per_litre", 0.001], ["kcal_per_1000ml", 0.001]],
  protein_g_per_l: [["protein_g_per_l", 1], ["protein_g_per_litre", 1], ["protein_g_per_liter", 1], ["protein_per_l", 1], ["protein_g_per_1000ml", 1], ["protein_g_per_100ml", 10], ["protein_per_100ml", 10]],
  water_ml_per_l: [["water_ml_per_l", 1], ["water_ml_per_litre", 1], ["water_ml_per_liter", 1], ["free_water_ml_per_l", 1], ["water_per_l", 1], ["water_ml_per_1000ml", 1], ["water_ml_per_100ml", 10], ["water_per_100ml", 10], ["water_percent", 10], ["water_pct", 10]],
};
const NAME_COLS = ["formula_name", "name", "product_name", "product", "brand"];

export const formulaRowName = (row) => { for (const c of NAME_COLS) if (present(row?.[c])) return String(row[c]); return null; };

/** Maps one enteral_formulas row to {kcal_per_ml, protein_g_per_l, water_ml_per_l, name, columns}. Missing values stay null. */
export function mapFormulaRow(row) {
  const out = { name: formulaRowName(row), kcal_per_ml: null, protein_g_per_l: null, water_ml_per_l: null, columns: {} };
  if (!isObj(row)) return out;
  for (const [field, list] of Object.entries(COLS)) {
    for (const [col, mult] of list) {
      if (!present(row[col])) continue;
      const n = Number(row[col]);
      if (!Number.isFinite(n)) continue;
      out[field] = round(n * mult, 4);
      out.columns[field] = col;
      break;
    }
  }
  return out;
}

/** Picks one row from a list of rows by name: exact match first, then a single "contains" match. Returns {row} or {error, matches}. */
export function pickFormulaByName(rows, name) {
  const q = String(name).trim().toLowerCase();
  const list = Array.isArray(rows) ? rows : [];
  const nm = (r) => (formulaRowName(r) || "").toLowerCase();
  const exact = list.filter((r) => nm(r) === q);
  if (exact.length === 1) return { row: exact[0] };
  const part = list.filter((r) => nm(r).includes(q));
  if (part.length === 1) return { row: part[0] };
  const found = (exact.length ? exact : part).map(formulaRowName);
  if (found.length > 1) return { error: `'${name}' matches ${found.length} formulas: ${found.slice(0, 8).join("; ")}. Send formula_id or the exact name.`, matches: found };
  return { error: `No enteral formula named '${name}' was found.` };
}

// ── the calculation ──────────────────────────────────────────────────────────
const MODES = ["continuous", "cyclic", "bolus", "trophic", "volume_based"];

export function computeEnteralPlan(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const f = isObj(inp.formula) ? inp.formula : {};
  const pick = (a, b) => (present(f[a]) ? f[a] : inp[b]);
  const formulaIn = { kcal_per_ml: pick("kcal_per_ml", "formula_kcal_per_ml"), protein_g_per_l: pick("protein_g_per_l", "formula_protein_g_per_l"), water_ml_per_l: pick("water_ml_per_l", "formula_water_ml_per_l") };
  const k = readNum(formulaIn, "kcal_per_ml", { min: 0, minExclusive: true, max: 3, required: true });
  if (k.error) return fail(k.error.replace("'kcal_per_ml'", "formula kcal_per_ml (or formula_id / formula_name)"));
  const p = readNum(formulaIn, "protein_g_per_l", { min: 0, max: 300 });
  if (p.error) return fail(p.error);
  const w = readNum(formulaIn, "water_ml_per_l", { min: 0, max: 1000 });
  if (w.error) return fail(w.error);

  const weight = readNum(inp, "weight_kg", { min: 0, minExclusive: true, max: 500 });
  if (weight.error) return fail(weight.error);
  const needsKcal = readNum(inp, "kcal_needs", { min: 0, minExclusive: true, max: 10000 });
  if (needsKcal.error) return fail(needsKcal.error);
  const needsProt = readNum(inp, "protein_needs_g", { min: 0, max: 500 });
  if (needsProt.error) return fail(needsProt.error);
  const needsFluid = readNum(inp, "fluid_needs_ml", { min: 0, max: 10000 });
  if (needsFluid.error) return fail(needsFluid.error);
  const med = readNum(inp, "medication_kcal", { min: 0, max: 5000 });
  if (med.error) return fail(med.error);
  const hoursIn = readNum(inp, "hours_per_day", { min: 0, minExclusive: true, max: 24 });
  if (hoursIn.error) return fail(hoursIn.error);
  const flushEvery = readNum(inp, "flush_every_hours", { min: 1, max: 24 });
  if (flushEvery.error) return fail(flushEvery.error);
  const deliveredPct = readNum(inp, "delivered_pct", { min: 0, max: 100 });
  if (deliveredPct.error) return fail(deliveredPct.error);
  const feedsIn = readNum(inp, "feeds_per_day", { min: 1, max: 24 });
  if (feedsIn.error) return fail(feedsIn.error);
  const trophicIn = readNum(inp, "trophic_rate_ml_hr", { min: 0, minExclusive: true, max: 500 });
  if (trophicIn.error) return fail(trophicIn.error);

  const mode = present(inp.mode) ? String(inp.mode).trim().toLowerCase().replace(/[- ]/g, "_") : "continuous";
  if (!MODES.includes(mode)) return fail(`'mode' must be one of: ${MODES.join(", ")}`);
  const paediatric = present(inp.patient_type) && /^p(a)?ediatric$/i.test(String(inp.patient_type).trim());
  const refeeding = readBool(inp.refeeding_risk);
  const ventilated = readBool(inp.mechanically_ventilated);
  const tolerance = readBool(inp.high_risk_tolerance);

  const kcalPerMl = k.value;
  const warnings = [];
  const notes = [];

  // Step 3: needs. Step 1: medication calories come off the formula target.
  const med_kcal = med.value ?? 0;
  const refeedRange = GUIDE.refeeding_adult_kcal_per_kg;
  let goalKcal = needsKcal.value;
  let targetKcal;
  let refeedingInfo;
  if (refeeding) {
    if (paediatric) {
      if (goalKcal === null) return fail("'kcal_needs' is required for a paediatric patient (the start is 40-50% of goal energy needs)");
      const pct = readNum(inp, "refeeding_start_pct", { min: GUIDE.refeeding_paediatric_pct_of_goal[0], max: GUIDE.refeeding_paediatric_pct_of_goal[1] });
      if (pct.error) return fail(pct.error);
      const use = pct.value ?? 45;
      targetKcal = goalKcal * use / 100;
      refeedingInfo = { rule: "Paediatric: start at 40-50% of goal energy needs", start_pct_of_goal: use, goal_kcal: goalKcal };
    } else {
      if (weight.value === null) return fail("'weight_kg' is required when refeeding_risk is true (adults start at 10-20 kcal/kg)");
      const kg = readNum(inp, "refeeding_kcal_per_kg", { min: refeedRange[0], max: refeedRange[1] });
      if (kg.error) return fail(kg.error);
      const use = kg.value ?? 15;
      targetKcal = use * weight.value;
      refeedingInfo = { rule: "Adult: start at 10-20 kcal/kg", start_kcal_per_kg: use, start_kcal_range: [round(refeedRange[0] * weight.value), round(refeedRange[1] * weight.value)], goal_kcal: goalKcal };
      if (kg.value === null) notes.push("No refeeding_kcal_per_kg sent, so the midpoint (15 kcal/kg) was used. Send a value from 10 to 20.");
    }
    refeedingInfo.monitoring = "Monitor electrolytes and increase slowly to goal. Do not provide too much fluid.";
    notes.push("Refeeding risk: this is the starting prescription. Protein needs cannot be met at this energy level without exceeding the recommended calories.");
  } else {
    if (goalKcal === null) {
      if (mode === "trophic") targetKcal = null;
      else return fail("'kcal_needs' is required");
    } else targetKcal = goalKcal;
  }
  if (targetKcal !== null && targetKcal !== undefined) targetKcal = Math.max(0, targetKcal - med_kcal);
  if (targetKcal === 0 && mode !== "trophic") return fail("Medication calories cover the whole energy target; there is nothing left for formula");

  // Steps 5-7: volume, rate, hours.
  const defaultHours = 24;
  let hours = hoursIn.value ?? defaultHours;
  if (mode === "bolus" && hoursIn.value === null) hours = defaultHours;
  let rate = null, volume, perFeed = null, feeds = null, ratePrescribed = false;
  if (mode === "trophic") {
    const r = trophicIn.value ?? 15;
    if (trophicIn.value === null) notes.push("Trophic rate defaults to 15 ml/hr (adult range 10-20 ml/hr). Send trophic_rate_ml_hr to change it.");
    else if (!paediatric && (r < GUIDE.trophic_adult_rate_ml_per_hr[0] || r > GUIDE.trophic_adult_rate_ml_per_hr[1])) warnings.push(`Trophic feeds for adults are usually 10-20 ml/hr; ${r} ml/hr was sent.`);
    rate = round(r); volume = rate * hours; ratePrescribed = true;
    notes.push("Trophic feeding: write for the rate plus free water flushes, and add protein modulars if available.");
  } else if (mode === "volume_based") {
    const v = targetKcal / kcalPerMl;
    volume = Math.round(v / 100) * 100;
    if (volume === 0) volume = 100;
    notes.push("Volume-based order: prescribe the daily volume only. Nurses set the rate and increase it to meet the volume goal. No rate is calculated.");
  } else if (mode === "bolus") {
    feeds = Math.round(feedsIn.value ?? 6);
    if (feedsIn.value === null) notes.push("feeds_per_day defaults to 6. Send feeds_per_day to change it.");
    const v = targetKcal / kcalPerMl;
    perFeed = Math.max(5, round5(v / feeds));
    volume = perFeed * feeds;
  } else {
    const v = Math.round(targetKcal / kcalPerMl);
    rate = Math.round(v / hours);
    if (rate < 1) rate = 1;
    volume = rate * hours;
    ratePrescribed = true;
    if (mode === "cyclic" && hoursIn.value === null) notes.push("Cyclic feeding with no hours_per_day: 24 hours was used. Send the cycle length.");
  }
  volume = round(volume);
  const litres = volume / 1000;

  // Step 7b, 8, 9: what the prescription gives.
  const kcalFormula = round(volume * kcalPerMl);
  const kcalTotal = kcalFormula + med_kcal;
  const protein = p.value === null ? null : round(litres * p.value, 1);
  const formulaWater = w.value === null ? null : round(litres * w.value);

  // Protein modular (optional).
  let modular = null;
  if (isObj(inp.protein_modular) && needsProt.value !== null && protein !== null) {
    const pg = readNum(inp.protein_modular, "protein_g_per_serving", { min: 0, minExclusive: true });
    const pk = readNum(inp.protein_modular, "kcal_per_serving", { min: 0 });
    if (pg.error) return fail(`protein_modular: ${pg.error}`);
    if (pk.error) return fail(`protein_modular: ${pk.error}`);
    const gap = Math.max(0, needsProt.value - protein);
    const servings = gap > 0 ? Math.ceil(gap / pg.value) : 0;
    modular = { servings_per_day: servings, protein_g: round(servings * pg.value, 1), kcal: round(servings * (pk.value ?? 0)), note: "Added on top of the formula. If the extra kcal push energy above target, lower the formula volume (go back to the volume step) unless refeeding guidelines apply." };
  }
  const proteinTotal = protein === null ? null : round(protein + (modular ? modular.protein_g : 0), 1);
  const kcalGrand = kcalTotal + (modular ? modular.kcal : 0);

  // Steps 3 (fluid), 10, 11: free water flush.
  let fluidNeed = needsFluid.value;
  if (fluidNeed === null && weight.value !== null && !paediatric) {
    fluidNeed = round(30 * weight.value);
    notes.push("No fluid_needs_ml sent, so 30 ml/kg/day was used as the educated guess. Send fluid_needs_ml to override.");
  }
  const everyH = flushEvery.value ?? 4;
  const flushesPerDay = 24 / everyH;
  let flush = null;
  if (fluidNeed === null) {
    notes.push("No fluid_needs_ml or weight_kg sent, so only the minimum free water flush is shown.");
  }
  if (formulaWater === null) warnings.push("The formula water content (water_ml_per_l) is unknown, so formula water was not counted and the flush cannot be matched to fluid needs. Only the minimum flush is shown.");
  const remaining = fluidNeed !== null && formulaWater !== null ? Math.max(0, fluidNeed - formulaWater) : null;
  let perFlush = remaining === null ? GUIDE.min_flush_ml : round5(remaining / flushesPerDay);
  let minApplied = false;
  if (perFlush < GUIDE.min_flush_ml) { perFlush = GUIDE.min_flush_ml; minApplied = true; }
  const flushTotal = round(perFlush * flushesPerDay);
  flush = { ml_per_flush: perFlush, every_hours: everyH, flushes_per_day: round(flushesPerDay, 1), label: `${perFlush} ml free water flush Q${everyH}`, total_ml_per_day: flushTotal, remaining_fluid_ml: remaining === null ? null : round(remaining), minimum_applied: minApplied };
  const fluidTotal = formulaWater === null ? null : round(formulaWater + flushTotal);

  // Adequacy against the whole goal, and against a realistic delivery.
  const pctOf = (x, need) => (need ? round((x / need) * 100) : null);
  const goalEnergy = goalKcal ?? null;
  const adequacy = {
    energy_pct_of_goal: goalEnergy ? pctOf(kcalGrand, goalEnergy) : null,
    energy_pct_of_target: targetKcal ? pctOf(kcalGrand - med_kcal, targetKcal) : null,
    protein_pct_of_needs: needsProt.value && proteinTotal !== null ? pctOf(proteinTotal, needsProt.value) : null,
    fluid_pct_of_needs: fluidNeed && fluidTotal !== null ? pctOf(fluidTotal, fluidNeed) : null,
  };
  const scenario = (pct, label) => {
    const vol = volume * pct / 100;
    const kcal = round(vol * kcalPerMl + med_kcal + (modular ? modular.kcal * pct / 100 : 0));
    const prot = protein === null ? null : round((vol / 1000) * p.value + (modular ? modular.protein_g * pct / 100 : 0), 1);
    return { label, pct_of_prescribed_delivered: pct, volume_ml: round(vol), energy_kcal: kcal, energy_pct_of_goal: goalEnergy ? pctOf(kcal, goalEnergy) : null, protein_g: prot, protein_pct_of_needs: needsProt.value && prot !== null ? pctOf(prot, needsProt.value) : null };
  };
  const scenarios = [scenario(GUIDE.typical_delivery_pct, "Typical delivery (studies estimate about 65% of prescribed EN is received)")];
  if (deliveredPct.value !== null && deliveredPct.value !== GUIDE.typical_delivery_pct) scenarios.push(scenario(deliveredPct.value, "Your delivered_pct"));
  let deliveredFromVolume = null;
  if (present(inp.delivered_volume_ml)) {
    const dv = readNum(inp, "delivered_volume_ml", { min: 0, max: 20000 });
    if (dv.error) return fail(dv.error);
    deliveredFromVolume = scenario(round((dv.value / volume) * 100, 1), "Actual delivered_volume_ml");
    scenarios.push(deliveredFromVolume);
  }

  // Buffer rates (continuous): the guide suggests calculating off 20-22 h so there is a cushion when the pump is off.
  let bufferRates = null;
  if ((mode === "continuous") && targetKcal) {
    const v = Math.round(targetKcal / kcalPerMl);
    bufferRates = GUIDE.buffer_hours.map((h) => ({ hours: h, rate_ml_per_hr: Math.max(1, Math.round(v / h)) }));
    notes.push("Ask your facility whether EN is calculated over 24 hours or fewer. Calculating over 20-22 hours (see buffer_rates) leaves a cushion for the times the pump is off.");
  }

  // Safety flags from the guide.
  if (ratePrescribed && !paediatric && rate > GUIDE.max_adult_rate_ml_per_hr) warnings.push(`Rate ${rate} ml/hr is above 150 ml/hr, the usual adult ceiling. Use a more concentrated formula, more hours or another mode.`);
  if (paediatric) notes.push("Paediatric patients tolerate much lower volumes. The adult 150 ml/hr and flush limits were not applied.");
  if (!paediatric && perFlush > GUIDE.adult_flush_ml_per_flush_below) warnings.push(`Flush of ${perFlush} ml is above 300 ml, the usual adult limit per flush. Start with 100-150 ml per flush and use a shorter interval.`);
  if (refeeding && !paediatric && fluidTotal !== null && fluidTotal >= GUIDE.refeeding_adult_fluid_ml_per_day_below) warnings.push(`Total fluid ${fluidTotal} ml/day: keep adult refeeding patients under 2 L/day.`);
  if (refeeding && !paediatric && fluidTotal === null) notes.push("Keep adult refeeding patients under 2 L/day total fluid.");
  if (ventilated) {
    notes.push("Mechanically ventilated: avoid overfeeding, which can prolong days on the ventilator, particularly in patients with obese BMIs.");
    if (goalEnergy && kcalGrand > goalEnergy * 1.05) warnings.push(`Prescribed energy is ${adequacy.energy_pct_of_goal}% of goal in a ventilated patient. Avoid overfeeding.`);
  }
  if (proteinTotal !== null && needsProt.value && proteinTotal < needsProt.value) {
    const gap = round(needsProt.value - proteinTotal, 1);
    if (refeeding) notes.push(`Protein is ${gap} g/day short of needs, expected at refeeding energy levels.`);
    else if (!modular) notes.push(`Protein is ${gap} g/day short of needs. Add a protein modular (send protein_modular {protein_g_per_serving, kcal_per_serving}) or choose a higher-protein formula.`);
    if (med_kcal > 0) notes.push("Calorie-containing medications reduce the room for formula, so protein needs may be hard to meet in critically ill patients.");
  }
  if (p.value === null) notes.push("Formula protein (protein_g_per_l) was not given, so protein was not calculated.");

  let advancement = null;
  if (tolerance && ratePrescribed && !paediatric && mode !== "trophic") {
    advancement = { start_rate_ml_per_hr: Math.max(1, Math.round(rate / 2)), goal_rate_ml_per_hr: rate, increase_ml_per_hr: GUIDE.advancement_ml_per_step_adult, every_hours: GUIDE.advancement_interval_hours, steps_to_goal: Math.max(0, Math.ceil((rate - Math.round(rate / 2)) / GUIDE.advancement_ml_per_step_adult)), note: "Start at half rate for patients with intolerance, critical illness or proning, then increase 10 ml every 4 hours until goal." };
  } else if (ratePrescribed && mode !== "trophic") notes.push("Most patients can start at full rate. Send high_risk_tolerance: true for a half-rate start (history of intolerance, critically ill, proned).");

  return {
    ok: true,
    data: {
      mode,
      patient_type: paediatric ? "paediatric" : "adult",
      formula: { kcal_per_ml: kcalPerMl, protein_g_per_l: p.value, water_ml_per_l: w.value, name: present(inp.formula_label) ? String(inp.formula_label) : (f.name ?? null), source: f.source ?? "request body" },
      needs: { kcal_goal: goalKcal, protein_g: needsProt.value, fluid_ml: fluidNeed, medication_kcal: med_kcal, formula_kcal_target: targetKcal === null ? null : round(targetKcal) },
      refeeding: refeedingInfo ?? null,
      prescription: {
        volume_ml_per_day: volume,
        volume_litres_per_day: round(litres, 2),
        rate_ml_per_hr: rate,
        hours_per_day: ratePrescribed ? hours : (mode === "volume_based" ? null : hours),
        bolus: perFeed ? { feeds_per_day: feeds, ml_per_feed: perFeed } : null,
        free_water_flush: flush,
        protein_modular: modular,
        text: prescriptionText({ mode, volume, rate, hours, perFeed, feeds, flush, modular }),
      },
      delivered_by_prescription: {
        formula_kcal: kcalFormula,
        medication_kcal: med_kcal,
        modular_kcal: modular ? modular.kcal : 0,
        total_kcal: kcalGrand,
        kcal_per_kg: weight.value ? round(kcalGrand / weight.value, 1) : null,
        protein_g: proteinTotal,
        protein_g_per_kg: weight.value && proteinTotal !== null ? round(proteinTotal / weight.value, 2) : null,
        formula_water_ml: formulaWater,
        flush_water_ml: flushTotal,
        total_fluid_ml: fluidTotal,
      },
      adequacy,
      delivery_scenarios: scenarios,
      buffer_rates: bufferRates,
      advancement,
      warnings,
      notes,
      source: SOURCE,
      disclaimer: DISCLAIMER,
    },
  };
}

function prescriptionText({ mode, volume, rate, hours, perFeed, feeds, flush, modular }) {
  let s;
  if (mode === "volume_based") s = `${volume} ml formula per day (volume-based; nursing to set and adjust the rate to meet the volume)`;
  else if (mode === "bolus") s = `${perFeed} ml formula x ${feeds} feeds/day (${volume} ml/day)`;
  else if (mode === "trophic") s = `Trophic: ${rate} ml/hr x ${hours} hours (${volume} ml/day)`;
  else s = `${rate} ml/hr x ${hours} hours (${volume} ml/day)${mode === "cyclic" ? ", cyclic" : ""}`;
  s += `; ${flush.label}`;
  if (modular && modular.servings_per_day) s += `; protein modular ${modular.servings_per_day} serving(s)/day`;
  return s;
}

// ── reference ────────────────────────────────────────────────────────────────
const STEPS = [
  "Check the patient is safe to feed enterally (functional gut, low or no vasopressors)",
  "1. Calculate calories from medications",
  "2. Is the patient at refeeding syndrome risk?",
  "3. Daily kcal, protein and fluid needs",
  "4. Choose the formula",
  "5. Choose how to provide it: trophic, bolus, continuous, cyclic or volume-based",
  "6. Volume per day = kcal needs / formula kcal per ml (volume-based: round to the nearest 100 ml and skip to step 8)",
  "7. Rate = volume / hours per day, rounded; then ml per day = rate x hours, kcal = ml x kcal per ml, litres = ml / 1000",
  "8. Protein = litres x g protein per litre; add protein modulars if short",
  "9. Fluid from formula = litres x ml water per litre",
  "10. Free water flush = remaining fluid / flushes per day, minimum 30 ml Q4, round to 5 ml",
  "11. Total fluid = formula water + flushes",
  "12. Write the final EN prescription",
];
const SECTIONS = {
  steps: () => STEPS,
  limits: () => GUIDE,
  quick_math: () => ({ "1 L": "1000 ml", "1 kg": "2.2 lb", "1 inch": "2.54 cm", BMI: "kg/m2", flush_Q4: "every 4 hours, 6 times/day", flush_Q6: "every 6 hours, 4 times/day", percentage_example: "15% of calories from protein in 1000 ml: 1000 x 0.15 = 150 kcal; 150 / 4 = 38 g protein" }),
  modes: () => ({ trophic: "Adult 10-20 ml/hr plus free water flushes plus protein modulars if available", bolus: "Volume per feed x feeds per day", continuous: "Rate over 24 hours or fewer", cyclic: "Rate over a set cycle of hours", volume_based: "Prescribe the volume; nursing sets the rate. Do not calculate the rate" }),
  request_fields: () => ({
    formula: "one of: formula_id, formula_name (looked up in enteral_formulas) or inline {kcal_per_ml, protein_g_per_l, water_ml_per_l}; inline values override looked-up ones",
    needs: "kcal_needs, protein_needs_g, fluid_needs_ml (optional: defaults to 30 ml/kg when weight_kg is sent), weight_kg, medication_kcal",
    feeding: "mode, hours_per_day (default 24), feeds_per_day (bolus, default 6), trophic_rate_ml_hr, flush_every_hours (default 4)",
    flags: "refeeding_risk (+ refeeding_kcal_per_kg 10-20, or refeeding_start_pct 40-50 for paediatric), patient_type adult|paediatric, mechanically_ventilated, high_risk_tolerance",
    adequacy: "delivered_pct, delivered_volume_ml, protein_modular {protein_g_per_serving, kcal_per_serving}",
  }),
};

export function enteralReferenceCatalog(section) {
  if (present(section)) {
    const key = String(section).trim().toLowerCase();
    if (!SECTIONS[key]) return fail(`Unknown section '${section}'. Use one of: ${Object.keys(SECTIONS).join(", ")}.`);
    return { ok: true, data: { section: key, data: SECTIONS[key](), source: SOURCE, disclaimer: DISCLAIMER } };
  }
  const all = {};
  for (const [k, fn] of Object.entries(SECTIONS)) all[k] = fn();
  return { ok: true, data: { ...all, sections: Object.keys(SECTIONS), source: SOURCE, disclaimer: DISCLAIMER } };
}
