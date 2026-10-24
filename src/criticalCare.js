// Critical care (ICU) nutrition support calculators (GET /critical-care/reference, /fat, /cho-fat-ratio,
// POST /critical-care/protein-by-stress, /npe-nitrogen-ratio, /nitrogen-balance, /carbohydrate, /propofol-fat,
// /electrolytes, /potassium-deficit, /fluid).
// Pure functions, no I/O.
//
// Moved here from chakudya-mcp-server-cloudflare (src/tools/criticalCareNutritionSupportTools.ts), where the same
// numbers were calculated locally. The MCP tools now call these routes, so the API is the single source of truth.
// Nothing was changed in the arithmetic or the tables while moving them.
//
// Source: a hospital dietetics ICU nutrition support guideline (sections 2-6: "Estimation of protein requirements",
// "Estimation of carbohydrate requirements", "Estimation of fat requirements", "Micronutrients", "Electrolyte
// supplementation", "Fluid requirements"). ESPEN 2009 is cited by that guideline for the fat ceiling.
// General (non-burn) nitrogen balance only. Burns have their own UUN-based formula in the MCP burn tools.
//
// NOT here: energy equation selection for the critically ill (Penn State, Ireton-Jones, Swinamer, ASPEN/ESPEN
// kcal/kg ranges). Nothing in this module estimates energy. See KNOWN_ISSUES.

export const SOURCE = "Hospital dietetics ICU nutrition support guideline (sections 2-6); ESPEN 2009 for the fat ceiling";
const DISCLAIMER =
  "Reference/estimate only, from a hospital dietetics ICU nutrition support guideline. Individualize to the patient: hydration status, " +
  "organ function, and losses from wounds/stoma/fistula are not captured by these formulas. Not a substitute for individualized " +
  "clinical assessment or institutional protocol.";
const PROTEIN_CEILING_NOTE = "Not often > 16g N (100g protein)/day except in catabolic critical illness.";

const KNOWN_ISSUES = [
  "The protein 'Severe' range is 1.6-2.5 g/kg in the stress-level table (2.1) but 1.9-2.5 g/kg in the urinary nitrogen interpretation table (2.2). Both are returned as printed in the source, not reconciled.",
  "The source prints the usual carbohydrate requirement as '3-5 g/kg/min'. That unit cannot be right (it would be hundreds of grams an hour). It is returned as printed and flagged; the mg/kg/min figure beside it is the one used for g/day.",
  "No energy requirement or equation selection for critically ill adults is in this module. Use POST /energy/requirements (measured REE and stress factors) or the indication-based references until a sourced equation-selection reference is added.",
];

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const present = (v) => v !== undefined && v !== null && v !== "";
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** Reads one number from the body. Returns {value} (null when absent and optional) or {error}. */
function readNum(inp, key, { min = null, minExclusive = false, max = null, int = false, required = false } = {}) {
  if (!present(inp[key])) return required ? { error: `'${key}' is required` } : { value: null };
  const v = typeof inp[key] === "number" ? inp[key] : Number(inp[key]);
  if (!Number.isFinite(v)) return { error: `'${key}' must be a number` };
  if (int && !Number.isInteger(v)) return { error: `'${key}' must be a whole number` };
  if (min !== null && (minExclusive ? v <= min : v < min)) return { error: `'${key}' must be ${minExclusive ? "greater than" : "at least"} ${min}` };
  if (max !== null && v > max) return { error: `'${key}' must be at most ${max}` };
  return { value: v };
}
const fail = (error) => ({ ok: false, error });
const done = (data) => ({ ok: true, data: { ...data, source: SOURCE, disclaimer: DISCLAIMER } });

// ── 2.1 Protein requirement by stress level ─────────────────────────────────
export const PROTEIN_STRESS_TABLE = [
  { stress_level: 0, label: "Normal", protein_g_per_kg_low: 0.8, protein_g_per_kg_high: 0.8, protein_g_per_kg_range: "0.8 g/kg" },
  { stress_level: 1, label: "Mild", protein_g_per_kg_low: 0.8, protein_g_per_kg_high: 1, protein_g_per_kg_range: "0.8 - 1 g/kg" },
  { stress_level: 2, label: "Moderate", protein_g_per_kg_low: 1.2, protein_g_per_kg_high: 1.5, protein_g_per_kg_range: "1.2 - 1.5 g/kg" },
  { stress_level: 3, label: "Severe", protein_g_per_kg_low: 1.6, protein_g_per_kg_high: 2.5, protein_g_per_kg_range: "1.6 - 2.5 g/kg" },
];

// ── 2.2 Urinary N2 (g/24h) → stress → protein g/kg ──────────────────────────
export const URINARY_N2_INTERPRETATION_TABLE = [
  { urinary_n2_g_per_24h_range: "< 5", stress_level: 0, label: "Normal", protein_g_per_kg_range: "0.8 g/kg" },
  { urinary_n2_g_per_24h_range: "5 - 10", stress_level: 1, label: "Mild", protein_g_per_kg_range: "0.8 - 1 g/kg" },
  { urinary_n2_g_per_24h_range: "10 - 15", stress_level: 2, label: "Moderate", protein_g_per_kg_range: "1.2 - 1.5 g/kg" },
  { urinary_n2_g_per_24h_range: "> 15", stress_level: 3, label: "Severe", protein_g_per_kg_range: "1.9 - 2.5 g/kg" },
];

export const CHO_FAT_RATIOS = [
  { cho_fat_npe_ratio: "70:30", indication: "Normal requirements" },
  { cho_fat_npe_ratio: "60:40", indication: "Glucose intolerance: blood glucose level >10 mmol/L" },
  { cho_fat_npe_ratio: "50:50", indication: "Patient difficult to wean off the ventilator, or respiratory failure (i.e. high pCO2)" },
];

export const ELECTROLYTE_TABLE = {
  phosphate: {
    dosing: "Supplement 1-2 mg daily = 50 mmol/24h, or 0.08 mmol/kg over 8h",
    rapid_replacement: "15 mmol NaPO4 over 2h",
  },
  potassium: {
    dosing: "20-80 mmol at 10 mmol/hr via peripheral line, or 20 mmol/hr via central line",
    expected_rise: "Expect serum K to rise by 0.25 mmol/L for each 20 mmol KCl infused IV",
    deficit_estimation: "See POST /critical-care/potassium-deficit (serum K 3-4 ≈ 100-200 mmol deficit; serum K 2-3 ≈ 200-400 mmol deficit)",
  },
  magnesium: {
    dosing: "1-2 g MgSO4, e.g. 2g over 4h, or 0.5 mmol/kg/day",
  },
};

function interpretNpeN2Ratio(ratio) {
  if (ratio > 150) return "Normal / mildly elevated";
  if (ratio >= 100) return "Moderate stress";
  if (ratio >= 80) return "Severe stress";
  return "Below the charted range (<80:1): very severe stress, not covered by the source table";
}

// ── POST /critical-care/protein-by-stress ───────────────────────────────────
export function computeProteinByStress(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const lvl = readNum(inp, "stress_level", { min: 0, max: 3, int: true });
  if (lvl.error) return fail(`${lvl.error} (0=Normal, 1=Mild, 2=Moderate, 3=Severe)`);
  const w = readNum(inp, "weight_kg", { min: 0, minExclusive: true });
  if (w.error) return fail(w.error);
  const withGPerDay = (row) => ({
    ...row,
    protein_g_per_day_low: w.value !== null ? round(row.protein_g_per_kg_low * w.value, 1) : undefined,
    protein_g_per_day_high: w.value !== null ? round(row.protein_g_per_kg_high * w.value, 1) : undefined,
  });
  if (lvl.value !== null) {
    const row = PROTEIN_STRESS_TABLE.find((r) => r.stress_level === lvl.value);
    return done({ ...withGPerDay(row), note: PROTEIN_CEILING_NOTE });
  }
  return done({ stress_levels: PROTEIN_STRESS_TABLE.map(withGPerDay), note: PROTEIN_CEILING_NOTE });
}

// ── POST /critical-care/npe-nitrogen-ratio ──────────────────────────────────
export function computeNpeNitrogenRatio(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const npe = readNum(inp, "npe_kcal", { min: 0, minExclusive: true, required: true });
  if (npe.error) return fail(npe.error);
  const prot = readNum(inp, "protein_g", { min: 0, minExclusive: true, required: true });
  if (prot.error) return fail(prot.error);
  const nitrogenG = prot.value / 6.25;
  const ratio = npe.value / nitrogenG;
  return done({
    npe_kcal: npe.value,
    protein_g: prot.value,
    nitrogen_g: round(nitrogenG, 2),
    npe_to_n2_ratio: `${Math.round(ratio)}:1`,
    interpretation: interpretNpeN2Ratio(ratio),
    formula: "g N2 = g protein / 6.25; ratio = NPE kcal / g N2",
    bands: ">150:1 normal/mildly elevated; 100-150:1 moderate stress; 80-100:1 severe stress",
  });
}

// ── POST /critical-care/nitrogen-balance (general ICU) ──────────────────────
export function computeNitrogenBalance(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const vol = readNum(inp, "urine_volume_l", { min: 0, minExclusive: true, required: true });
  if (vol.error) return fail(vol.error);
  const urea = readNum(inp, "urinary_urea_mmol_l", { min: 0, required: true });
  if (urea.error) return fail(urea.error);
  const urinaryNitrogenG = vol.value * urea.value * 0.028;
  const totalUrinaryNitrogenG = urinaryNitrogenG * 1.2;
  const totalNitrogenOutputG = totalUrinaryNitrogenG + 4;
  const band = URINARY_N2_INTERPRETATION_TABLE.find((row) => {
    if (row.urinary_n2_g_per_24h_range === "< 5") return totalNitrogenOutputG < 5;
    if (row.urinary_n2_g_per_24h_range === "5 - 10") return totalNitrogenOutputG >= 5 && totalNitrogenOutputG <= 10;
    if (row.urinary_n2_g_per_24h_range === "10 - 15") return totalNitrogenOutputG > 10 && totalNitrogenOutputG <= 15;
    return totalNitrogenOutputG > 15;
  });
  return done({
    urine_volume_l: vol.value,
    urinary_urea_mmol_l: urea.value,
    urinary_nitrogen_g: round(urinaryNitrogenG, 2),
    total_urinary_nitrogen_g_per_24h: round(totalUrinaryNitrogenG, 2),
    total_nitrogen_output_g_per_24h: round(totalNitrogenOutputG, 2),
    formulas: {
      urinary_nitrogen: "urine_volume_L x urinary_urea_mmol_L x 0.028 = g N (urea-derived only)",
      total_urinary_nitrogen: "urinary_nitrogen_g x 1.2 = g N/24h",
      total_nitrogen_output: "total_urinary_nitrogen_g + 4g N/24h obligatory losses",
    },
    interpretation: band ? { stress_level: band.stress_level, label: band.label, protein_g_per_kg_range: band.protein_g_per_kg_range } : undefined,
    caution:
      "May be inaccurate in unstable patients: affected by changes in hydration status, impaired liver and renal function, gastrointestinal " +
      "haemorrhage, and catabolic critical illness. Does not account for losses from wounds/fistulae. Burn patients use a different (UUN-based) formula.",
  });
}

// ── POST /critical-care/carbohydrate ────────────────────────────────────────
export function computeCarbohydrateRequirement(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const w = readNum(inp, "weight_kg", { min: 0, minExclusive: true });
  if (w.error) return fail(w.error);
  const gPerDay = (mgPerKgMin) => (w.value !== null ? round(mgPerKgMin * w.value * 1.44, 1) : undefined);
  return done({
    usual_requirements: {
      text: "60-70% of NPE OR 30-70% of total energy OR 2-4 mg/kg/min OR 3-5 g/kg/min",
      usual_low_g_per_day: gPerDay(2),
      usual_high_g_per_day: gPerDay(4),
      unit_warning: "The source prints '3-5 g/kg/min', which cannot be right. Kept as printed. g/day here uses the mg/kg/min figure.",
    },
    minimum_requirements: { text: "150 - 200 g/24h" },
    maximum_recommendations: {
      no_metabolic_stress: { text: "6-7 mg/kg/min", g_per_day: gPerDay(6.5) },
      severe_stress: { text: "4-5 mg/kg/min (7.2 g/kg/day)", g_per_day: gPerDay(4.5) },
      tpn: { text: "4-5 mg/kg/min", g_per_day: gPerDay(4.5) },
    },
    note: "mg/kg/min -> g/day conversion: mg/kg/min x weight_kg x 1440 min/day / 1000 mg/g. g/day uses the midpoint of each range (6.5 and 4.5 mg/kg/min).",
    consider: "Other sources of glucose, e.g. glucose administration in intravenous fluids.",
  });
}

// ── GET /critical-care/fat ──────────────────────────────────────────────────
export function fatRequirement() {
  return done({
    usual_requirements: "30 - 40% of non-protein energy",
    minimum_requirements: "100 - 200 g/week, absolute minimum for providing essential fatty acids (EFAs)",
    maximum_recommendations: "1-2 g/kg/day is considered safe (ESPEN 2009)",
    acute_pancreatitis: "Give 0.8-1.5 g/kg fat via TPN and keep serum triglycerides <12 mmol/L.",
    other_iv_fat_sources: "Consider other sources of intravenous fat, e.g. propofol administered in a fat emulsion. See POST /critical-care/propofol-fat.",
  });
}

// ── POST /critical-care/propofol-fat ────────────────────────────────────────
export function computePropofolFat(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const pct = present(inp.propofol_percent) ? String(inp.propofol_percent).replace("%", "").trim() : "";
  if (pct !== "1" && pct !== "2") return fail("'propofol_percent' is required and must be 1 or 2 (percent)");
  const vol = readNum(inp, "volume_ml", { min: 0, minExclusive: true, required: true });
  if (vol.error) return fail(vol.error);
  const propofolMgPerMl = pct === "1" ? 10 : 20;
  const fatGPerMl = 0.1;
  return done({
    propofol_percent: `${pct}%`,
    volume_ml: vol.value,
    propofol_mg_total: round(propofolMgPerMl * vol.value, 1),
    fat_g_total: round(fatGPerMl * vol.value, 2),
    basis: `1 mL of Propofol ${pct}% contains ${propofolMgPerMl} mg propofol and 0.1 g fat`,
  });
}

// ── GET /critical-care/cho-fat-ratio ────────────────────────────────────────
export function choFatRatioReference() {
  return done({
    ratios: CHO_FAT_RATIOS,
    consider: "Other sources of glucose, e.g. glucose administration in intravenous fluids.",
  });
}

// ── POST /critical-care/electrolytes ────────────────────────────────────────
export function computeElectrolyteReplacement(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  if (!present(inp.electrolyte)) return done({ ...ELECTROLYTE_TABLE });
  const key = String(inp.electrolyte).trim().toLowerCase();
  if (!ELECTROLYTE_TABLE[key]) return fail("'electrolyte' must be phosphate, potassium or magnesium (omit it to get all three)");
  return done({ electrolyte: key, ...ELECTROLYTE_TABLE[key] });
}

// ── POST /critical-care/potassium-deficit ───────────────────────────────────
export function computePotassiumDeficit(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const k = readNum(inp, "serum_k_mmol_l", { min: 0, minExclusive: true, required: true });
  if (k.error) return fail(k.error);
  let band;
  if (k.value >= 3 && k.value < 4) band = "100-200 mmol K deficit";
  else if (k.value >= 2 && k.value < 3) band = "200-400 mmol K deficit";
  return done({
    serum_k_mmol_l: k.value,
    estimated_deficit: band ?? "Outside the charted bands (2-4 mmol/L): use clinical judgment",
    expected_rise_per_20mmol_kcl_iv: "0.25 mmol/L",
    replacement_rate: "20-80 mmol at 10 mmol/hr via peripheral line, or 20 mmol/hr via central line",
  });
}

// ── POST /critical-care/fluid ───────────────────────────────────────────────
export function computeIcuFluid(inp = {}) {
  if (!isObj(inp)) return fail("Body must be a JSON object");
  const w = readNum(inp, "weight_kg", { min: 0, minExclusive: true, required: true });
  if (w.error) return fail(w.error);
  return done({
    weight_kg: w.value,
    fluid_ml_per_day_low: Math.round(30 * w.value),
    fluid_ml_per_day_high: Math.round(35 * w.value),
    basis: "30-35 mL/kg (normal adult requirements)",
    note: "In the intensive care unit, fluid requirements are normally determined by the treating doctor.",
  });
}

// ── GET /critical-care/reference ────────────────────────────────────────────
const SECTIONS = {
  protein_by_stress: () => PROTEIN_STRESS_TABLE,
  urinary_nitrogen: () => URINARY_N2_INTERPRETATION_TABLE,
  npe_n2_bands: () => [
    { ratio: ">150:1", interpretation: "Normal / mildly elevated" },
    { ratio: "100-150:1", interpretation: "Moderate stress" },
    { ratio: "80-100:1", interpretation: "Severe stress" },
  ],
  cho_fat_ratio: () => CHO_FAT_RATIOS,
  electrolytes: () => ELECTROLYTE_TABLE,
  known_issues: () => KNOWN_ISSUES,
};

export function criticalCareReferenceCatalog(section) {
  if (present(section)) {
    const fn = SECTIONS[String(section).trim().toLowerCase()];
    if (!fn) return fail(`Unknown section '${section}'. Use one of: ${Object.keys(SECTIONS).join(", ")}.`);
    return { ok: true, data: { section: String(section).trim().toLowerCase(), data: fn(), source: SOURCE, disclaimer: DISCLAIMER } };
  }
  const all = {};
  for (const [k, fn] of Object.entries(SECTIONS)) all[k] = fn();
  return { ok: true, data: { ...all, sections: Object.keys(SECTIONS), source: SOURCE, disclaimer: DISCLAIMER } };
}
