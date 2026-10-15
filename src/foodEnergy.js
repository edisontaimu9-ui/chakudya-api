// Food-energy calculations (POST /energy/food-energy). Pure functions.
// From Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 2, "Calculating Food Energy":
//   - Biologically available energy: protein 4, fat 9, carbohydrate 4, alcohol 7 kcal/g (Atwater values, rounded slightly
//     below bomb-calorimeter values because digestion and absorption are not fully efficient).
//   - Fiber is an "unavailable carbohydrate" with minimal energy. Send AVAILABLE carbohydrate; fiber is not added.
//   - Alcoholic drinks: kcal = amount (oz) x proof x 0.8. US proof is twice the percent alcohol by volume.
//   - 1 kcal = 4.184 kJ.

export const SOURCE = "Krause and Mahan's Food and the Nutrition Care Process, 16th ed., ch. 2 (Calculating Food Energy)";
export const KCAL_PER_GRAM = { protein: 4, fat: 9, carbohydrate: 4, alcohol: 7 };
export const KJ_PER_KCAL = 4.184;
export const ALCOHOL_KCAL_PER_PROOF_OZ = 0.8;

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const present = (v) => v !== undefined && v !== null && v !== "";

/** kcal of an alcoholic drink: oz x proof x 0.8. Give proof, or abv_percent (proof = 2 x abv). */
export function alcoholDrinkKcal({ volume_oz, proof, abv_percent }) {
  const oz = Number(volume_oz);
  if (!isNum(oz) || oz <= 0 || oz > 200) return { error: "alcohol.volume_oz must be above 0 and at most 200 (US fluid ounces)" };
  let p;
  if (present(proof) && present(abv_percent)) return { error: "give alcohol.proof or alcohol.abv_percent, not both" };
  if (present(proof)) p = Number(proof);
  else if (present(abv_percent)) p = Number(abv_percent) * 2;
  else return { error: "alcohol needs proof or abv_percent" };
  if (!isNum(p) || p <= 0 || p > 200) return { error: "alcohol proof must be above 0 and at most 200 (abv_percent at most 100)" };
  return { kcal: oz * p * ALCOHOL_KCAL_PER_PROOF_OZ, proof: p, abv_percent: p / 2, volume_oz: oz };
}

/**
 * input: grams { protein_g, fat_g, carbohydrate_g, alcohol_g }
 *     or percent of weight { weight_g, protein_pct, fat_pct, carbohydrate_pct, alcohol_pct }
 *     and/or a drink { alcohol: { volume_oz, proof | abv_percent } }. Optional fiber_g (informational, not added).
 * Returns { ok: true, data } or { ok: false, error }.
 */
export function computeFoodEnergy(input) {
  const inp = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const notes = [];
  const warnings = [];

  const grams = { protein: null, fat: null, carbohydrate: null, alcohol: null };
  const usingPercent = ["protein_pct", "fat_pct", "carbohydrate_pct", "alcohol_pct"].some((k) => present(inp[k]));
  const usingGrams = ["protein_g", "fat_g", "carbohydrate_g", "alcohol_g"].some((k) => present(inp[k]));
  if (usingPercent && usingGrams) return { ok: false, error: "use grams (protein_g, fat_g, ...) or percent of weight (weight_g with protein_pct, ...), not both" };

  let weightG = null;
  if (usingPercent) {
    weightG = Number(inp.weight_g);
    if (!isNum(weightG) || weightG <= 0 || weightG > 100000) return { ok: false, error: "weight_g is required with percent values (food weight in grams)" };
    let total = 0;
    for (const m of Object.keys(grams)) {
      const raw = inp[`${m}_pct`];
      if (!present(raw)) { grams[m] = 0; continue; }
      const p = Number(raw);
      if (!isNum(p) || p < 0 || p > 100) return { ok: false, error: `${m}_pct must be 0-100` };
      total += p;
      grams[m] = (p / 100) * weightG;
    }
    if (total > 100.0001) return { ok: false, error: "the percentages add up to more than 100" };
  } else if (usingGrams) {
    for (const m of Object.keys(grams)) {
      const raw = inp[`${m}_g`];
      if (!present(raw)) { grams[m] = 0; continue; }
      const g = Number(raw);
      if (!isNum(g) || g < 0 || g > 100000) return { ok: false, error: `${m}_g must be 0-100000 grams` };
      grams[m] = g;
    }
    if (present(inp.weight_g)) {
      weightG = Number(inp.weight_g);
      if (!isNum(weightG) || weightG <= 0 || weightG > 100000) return { ok: false, error: "weight_g must be above 0" };
      const sum = grams.protein + grams.fat + grams.carbohydrate + grams.alcohol;
      if (sum > weightG * 1.0001) return { ok: false, error: "the macronutrient grams add up to more than weight_g" };
    }
  }

  const lines = [];
  for (const m of ["protein", "fat", "carbohydrate", "alcohol"]) {
    if (grams[m] === null) continue;
    if (m === "alcohol" && grams.alcohol === 0 && !present(inp.alcohol_g) && !present(inp.alcohol_pct)) continue;
    lines.push({ nutrient: m, grams: round(grams[m], 2), kcal_per_gram: KCAL_PER_GRAM[m], kcal_unrounded: grams[m] * KCAL_PER_GRAM[m], steps: `${round(grams[m], 2)} g x ${KCAL_PER_GRAM[m]} kcal/g` });
  }

  let drink = null;
  if (present(inp.alcohol) && typeof inp.alcohol === "object") {
    if (lines.some((l) => l.nutrient === "alcohol")) return { ok: false, error: "give alcohol as grams/percent or as a drink {volume_oz, proof}, not both" };
    const d = alcoholDrinkKcal(inp.alcohol);
    if (d.error) return { ok: false, error: d.error };
    drink = { volume_oz: d.volume_oz, proof: d.proof, abv_percent: d.abv_percent, kcal: round(d.kcal, 1), steps: `${d.volume_oz} oz x ${d.proof} proof x ${ALCOHOL_KCAL_PER_PROOF_OZ} kcal/proof/oz`, kcal_unrounded: d.kcal };
    lines.push({ nutrient: "alcohol", grams: null, kcal_per_gram: null, kcal_unrounded: d.kcal, steps: drink.steps });
  }

  if (!lines.length) return { ok: false, error: "nothing to calculate. Send grams (protein_g, fat_g, carbohydrate_g, alcohol_g), percent of weight_g, or an alcohol drink {volume_oz, proof}" };

  const totalUnrounded = lines.reduce((s, l) => s + l.kcal_unrounded, 0);
  const total = Math.round(totalUnrounded);
  const breakdown = lines.map((l) => ({ nutrient: l.nutrient, grams: l.grams, kcal_per_gram: l.kcal_per_gram, kcal: round(l.kcal_unrounded, 1), percent_of_energy: totalUnrounded > 0 ? round((l.kcal_unrounded / totalUnrounded) * 100, 1) : 0, steps: l.steps }));

  if (present(inp.fiber_g)) {
    const f = Number(inp.fiber_g);
    if (!isNum(f) || f < 0) return { ok: false, error: "fiber_g must be 0 or more" };
    notes.push("Fiber is an unavailable carbohydrate with minimal energy, so fiber_g is not added. Send available carbohydrate in carbohydrate_g.");
  }
  if (usingPercent && grams.carbohydrate !== null && inp.carbohydrate_pct !== undefined) notes.push("Percent values are percent of the food's weight (not percent of energy).");

  const data = {
    total: { kcal: total, kj: round(totalUnrounded * KJ_PER_KCAL), kcal_unrounded: round(totalUnrounded, 2) },
    breakdown,
    per_100g: weightG ? { weight_g: round(weightG, 2), kcal: round((totalUnrounded / weightG) * 100, 1), kj: round(((totalUnrounded * KJ_PER_KCAL) / weightG) * 100) } : null,
    alcohol_drink: drink,
    factors: { ...KCAL_PER_GRAM, alcohol_per_proof_oz: ALCOHOL_KCAL_PER_PROOF_OZ, kj_per_kcal: KJ_PER_KCAL },
    warnings,
    notes,
    sources: [SOURCE],
  };
  return { ok: true, data };
}

export function foodEnergyCatalog() {
  return {
    kcal_per_gram: KCAL_PER_GRAM,
    alcohol_drink_formula: "kcal = volume (oz) x proof x 0.8 kcal/proof/oz. US proof = 2 x percent alcohol by volume.",
    kj_per_kcal: KJ_PER_KCAL,
    fiber: "Unavailable carbohydrate, minimal energy. Not added.",
    source: SOURCE,
  };
}
