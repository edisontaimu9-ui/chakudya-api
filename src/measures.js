// Household and standard (metric) measures: one shared unit table, the printed reference tables
// it came from, and the maths that turns "2 cups" or "300 g" of a food into both.
//
// Sources (all three are kept as printed in REFERENCE_TABLES; calculations use exact unit sizes):
//   uct     University of Cape Town, Division of Human Nutrition, Household Measurements Guide
//           ("Measurements", p. 3). Metric household: cup = 250 ml, dessertspoon = 20 ml.
//   kitchen Kitchen Measurement Conversion Tables (liquid/volume and dry/weight, approximate).
//           US customary: cup 237 ml, pint 473 ml, quart 946 ml, gallon 3785 ml.
//   krause  Krause and Mahan's Food & the Nutrition Care Process, 16th ed., Appendix 2
//           (Equivalents, Conversions, and Portion (Scoop) Sizes), pp. 1043-1044, adapted from the
//           North Carolina Dietetic Association Nutrition Care Manual, 2011. Nutrition cup = 240 ml.
//
// "cup" means the 250 ml metric household cup (the Malawi / southern Africa convention that the
// recipe calculator already used). "us cup" is the 240 ml nutrition cup. Nothing here guesses a
// density: a volume is only turned into grams with a density taken from the food's own serving
// sizes, otherwise the long-standing 1 g/ml assumption applies and is flagged in the result.

export const MEASURE_SOURCES = {
  uct: "University of Cape Town, Division of Human Nutrition. Household Measurements Guide ('Measurements', p. 3).",
  kitchen: "Kitchen Measurement Conversion Tables (liquid or volume measures and dry or weight measurements, approximate).",
  krause:
    "Krause and Mahan's Food & the Nutrition Care Process, 16th ed., Appendix 2: Equivalents, Conversions, and Portion (Scoop) Sizes, pp. 1043-1044 (from North Carolina Dietetic Association, Nutrition Care Manual, 2011).",
};

// ── unit table ───────────────────────────────────────────────────────────────
// amount = millilitres for volume units, grams for mass units.
// household: true for the spoon/cup/scoop family whose weight depends on the food (a cup of rice is
// not a cup of flour); false for units that are exact or that already assumed water-like density.
const U = (id, kind, amount, label, plural, system, aliases, o = {}) => ({
  id, kind, amount, label, plural, system, aliases, household: !!o.household, sources: o.sources || [], note: o.note || null,
});

const BASE_UNITS = [
  U("g", "mass", 1, "gram", "grams", "metric", ["g", "gram", "grams", "gm"], { sources: ["krause"] }),
  U("kg", "mass", 1000, "kilogram", "kilograms", "metric", ["kg", "kilogram", "kilograms"], { sources: ["kitchen", "krause"] }),
  U("mg", "mass", 0.001, "milligram", "milligrams", "metric", ["mg", "milligram", "milligrams"]),
  U("oz", "mass", 28.35, "ounce (weight)", "ounces", "us_customary", ["oz", "ounce", "ounces"], {
    sources: ["kitchen", "krause"],
    note: "28.35 g exactly. The printed kitchen table rounds (1 oz = 30 g, 8 oz = 240 g); calculations use 28.35.",
  }),
  U("lb", "mass", 453.6, "pound", "pounds", "us_customary", ["lb", "lbs", "pound", "pounds"], { sources: ["kitchen", "krause"] }),

  U("ml", "volume", 1, "millilitre", "millilitres", "metric", ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"], { sources: ["uct", "kitchen", "krause"] }),
  U("l", "volume", 1000, "litre", "litres", "metric", ["l", "liter", "liters", "litre", "litres"], { sources: ["kitchen", "krause"] }),
  U("fl_oz", "volume", 29.57, "fluid ounce", "fluid ounces", "us_customary", ["fl oz", "floz", "fl_oz", "fluid ounce", "fluid ounces", "fluidounce", "fluidounces"], {
    sources: ["kitchen", "krause"],
    note: "29.57 ml. Krause rounds to 30 ml in its equivalents list.",
  }),
  U("pint", "volume", 473.2, "pint (US liquid)", "pints", "us_customary", ["pint", "pints"], { sources: ["kitchen", "krause"] }),
  U("quart", "volume", 946.2, "quart (US liquid)", "quarts", "us_customary", ["quart", "quarts"], { sources: ["kitchen", "krause"] }),
  U("gallon", "volume", 3785, "gallon (US liquid)", "gallons", "us_customary", ["gallon", "gallons"], { sources: ["kitchen", "krause"] }),
  U("dry_pint", "volume", 550.5, "dry pint", "dry pints", "us_customary", ["dry pint", "dry pints", "dry_pint"], {
    sources: ["krause"], note: "Half a dry quart (1.101 L). Dry pints and quarts are about 1/6 larger than liquid ones.",
  }),
  U("dry_quart", "volume", 1101, "dry quart", "dry quarts", "us_customary", ["dry quart", "dry quarts", "dry_quart"], { sources: ["krause"] }),

  U("tsp", "volume", 5, "teaspoon", "teaspoons", "metric_household", ["tsp", "tsps", "teaspoon", "teaspoons"], { household: true, sources: ["uct", "kitchen", "krause"] }),
  U("tbsp", "volume", 15, "tablespoon", "tablespoons", "metric_household", ["tbsp", "tbsps", "tbs", "tablespoon", "tablespoons"], { household: true, sources: ["uct", "kitchen", "krause"] }),
  U("dsp", "volume", 20, "dessertspoon", "dessertspoons", "metric_household", ["dsp", "dessertspoon", "dessertspoons", "dessert spoon", "dessert spoons"], {
    household: true, sources: ["uct"],
  }),
  U("hdsp", "volume", 30, "heaped dessertspoon", "heaped dessertspoons", "metric_household", ["h dsp", "hdsp", "heaped dsp", "heaped dessertspoon", "heaped dessertspoons", "heaped dessert spoon", "heaped dessert spoons"], {
    household: true, sources: ["uct"],
  }),
  U("cup", "volume", 250, "cup", "cups", "metric_household", ["cup", "cups"], {
    household: true, sources: ["uct"], note: "250 ml metric household cup (UCT guide). Use 'us cup' for the 240 ml nutrition cup.",
  }),
  U("us_cup", "volume", 240, "US cup", "US cups", "us_customary", ["us cup", "us cups", "us_cup", "uscup", "american cup", "american cups"], {
    household: true, sources: ["krause", "kitchen"], note: "240 ml per Krause. The kitchen table prints 237 ml (strict US customary).",
  }),
];

// Portion (scoop) sizes, Krause Appendix 2. The number is how many level scoops make a quart.
// Printed as cups or tablespoons with the fluid-ounce equivalent in brackets.
export const SCOOP_SIZES = [
  { number: 6, printed: "2/3 cup (5 fluid oz)", fl_oz: 5 },
  { number: 8, printed: "1/2 cup (4 fluid oz)", fl_oz: 4 },
  { number: 10, printed: "3/8 cup (3 1/4 fluid oz)", fl_oz: 3.25 },
  { number: 12, printed: "1/3 cup (2 2/3 fluid oz)", fl_oz: 2 + 2 / 3 },
  { number: 16, printed: "1/4 cup (2 fluid oz)", fl_oz: 2 },
  { number: 20, printed: "3 1/5 Tbsp (1 3/5 fluid oz)", fl_oz: 1.6 },
  { number: 24, printed: "2 2/3 Tbsp (1 1/3 fluid oz)", fl_oz: 1 + 1 / 3 },
  { number: 30, printed: "2 1/5 Tbsp (1 fluid oz)", fl_oz: 1 },
  { number: 40, printed: "1 3/5 Tbsp (0.8 fluid oz)", fl_oz: 0.8 },
  { number: 60, printed: "1 Tbsp (0.5 fluid oz)", fl_oz: 0.5 },
].map((s) => ({ ...s, approx_ml: Math.round(s.fl_oz * 30 * 10) / 10 })); // Krause: 1 fl oz = 30 mL

const SCOOP_UNITS = SCOOP_SIZES.map((s) =>
  U(`scoop_${s.number}`, "volume", s.approx_ml, `#${s.number} scoop`, `#${s.number} scoops`, "portion_scoop",
    [`scoop ${s.number}`, `scoop${s.number}`, `#${s.number} scoop`, `#${s.number} scoops`, `no ${s.number} scoop`, `size ${s.number} scoop`],
    { household: true, sources: ["krause"], note: `Portion scoop number ${s.number}: ${s.printed}. Approximate (printed fluid ounces x 30 ml).` })
);

export const UNITS = [...BASE_UNITS, ...SCOOP_UNITS];

/** Lowercase, drop dots/underscores/hyphens/extra spaces: "Fl. Oz", "fl_oz" and "fl  oz" all become "fl oz". */
export function normalizeUnitKey(raw) {
  return String(raw ?? "").toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

const UNIT_BY_ALIAS = new Map();
for (const u of UNITS) {
  UNIT_BY_ALIAS.set(normalizeUnitKey(u.id), u);
  for (const a of u.aliases) UNIT_BY_ALIAS.set(normalizeUnitKey(a), u);
}

/** The unit definition for a surface form ("Tbs", "tablespoons", "fl oz", "h dsp"), or null. */
export function findUnit(raw) {
  const key = normalizeUnitKey(raw);
  return key ? UNIT_BY_ALIAS.get(key) || null : null;
}

/** Every unit spelling the ingredient parser should recognise (declared forms plus their normalised forms). */
export const UNIT_SURFACE_FORMS = new Set(UNITS.flatMap((u) => [u.id, ...u.aliases, ...u.aliases.map(normalizeUnitKey)]));

/** Count-like household units with no food-independent size: coarse generic grams, used only as a last resort. */
export const COUNT_UNIT_GRAMS = { slice: 30, slices: 30, handful: 30, handfuls: 30, pinch: 0.5, pinches: 0.5 };

// ── quantities ───────────────────────────────────────────────────────────────

const UNICODE_FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875, "⅕": 0.2, "⅙": 1 / 6 };

/** "2", "1.5", "1/2", "1 1/2", "½", "1½" or a number to a positive-or-zero number; null if it isn't one. */
export function parseQuantity(input) {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const t = String(input ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(\d+)?\s*([¼½¾⅓⅔⅛⅜⅝⅞⅕⅙])$/);
  if (m) return (m[1] ? Number(m[1]) : 0) + UNICODE_FRACTIONS[m[2]];
  m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m && Number(m[3]) !== 0) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m && Number(m[2]) !== 0) return Number(m[1]) / Number(m[2]);
  return /^\d*\.?\d+$/.test(t) ? Number(t) : null;
}

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

const NICE_FRACTIONS = [[0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"], [1, ""]];

/** "100g", "100g / 100ml", "250 ml": a weight or volume restated, not a household measure. */
export const isPlainMassLabel = (labelText) =>
  /^\s*\d+(?:\.\d+)?\s*(?:g|ml|kg|l)\s*(?:\/\s*\d+(?:\.\d+)?\s*(?:g|ml))?\s*$/i.test(String(labelText || ""));

/** 1.5 -> "1½", 0.33 -> "⅓", 2.97 -> "3", 41.6 -> "41.6": a quantity as a cook would write it. */
export function formatQuantity(q) {
  if (q == null || !Number.isFinite(q)) return null;
  if (q < 0.1) return String(round(q, 2));
  if (q >= 10) return String(round(q, 1));
  const whole = Math.floor(q);
  const frac = q - whole;
  const hit = NICE_FRACTIONS.find(([v]) => Math.abs(frac - v) < 0.04);
  if (!hit) return String(round(q, q < 1 ? 2 : 1));
  if (hit[0] === 1) return String(whole + 1);
  if (hit[0] === 0) return whole === 0 ? "0" : String(whole);
  return `${whole || ""}${hit[1]}`;
}

// ── unit-to-unit conversion (no food involved) ───────────────────────────────

/** Converts between two units of the same kind (volume to volume, mass to mass). */
export function convertUnits(amount, fromRaw, toRaw) {
  const from = findUnit(fromRaw);
  const to = findUnit(toRaw);
  if (!from) return { ok: false, error: `Unknown unit '${fromRaw}'` };
  if (!to) return { ok: false, error: `Unknown unit '${toRaw}'` };
  if (from.kind !== to.kind) {
    return { ok: false, error: `Cannot convert ${from.kind} (${from.id}) to ${to.kind} (${to.id}) without a food: use GET /foods/convert, which knows each food's weight per cup, spoon or serving.` };
  }
  return { ok: true, value: (amount * from.amount) / to.amount, from, to };
}

const HOUSEHOLD_VOLUME_UNITS = ["tsp", "tbsp", "dsp", "cup", "us_cup", "fl_oz"];
const label = (u, q) => (Math.abs(q - 1) < 1e-9 ? u.label : u.plural);

/** A volume (ml) expressed in the household volume units, with a suggested natural one. */
export function volumeEquivalents(ml) {
  const out = HOUSEHOLD_VOLUME_UNITS.map((id) => {
    const u = findUnit(id);
    const q = ml / u.amount;
    return { unit: u.id, label: label(u, q), quantity: round(q), display: `${formatQuantity(q)} ${label(u, q)}` };
  });
  const pick = ml >= 125 ? "cup" : ml >= 15 ? "tbsp" : "tsp";
  return { suggested: out.find((e) => e.unit === pick), all: out };
}

/** A weight (g) in kilograms, ounces and pounds. */
export function weightEquivalents(grams) {
  return [
    { unit: "kg", quantity: round(grams / 1000, 3) },
    { unit: "oz", quantity: round(grams / 28.35) },
    { unit: "lb", quantity: round(grams / 453.6, 3) },
  ];
}

// ── reading a serving label ("1 cup cooked rice (150g)") as a volume ─────────

const LABEL_VOLUME_RE = /^\s*((?:\d+\s+\d+\/\d+)|(?:\d+\/\d+)|(?:\d*\.?\d+)|[¼½¾⅓⅔⅛⅜⅝⅞])?\s*(cups?|tablespoons?|tbsps?|tbs|teaspoons?|tsps?|dessertspoons?|dsp)\b/i;

/**
 * If a serving label is itself a volume ("1 cup ...", "2 tablespoons ...", "1 can (330ml)"),
 * returns {unitId, qty, ml}; otherwise null ("1 chipande", "1 slice", "1 medium piece").
 */
export function parseServingVolume(labelText) {
  const text = String(labelText || "");
  const m = text.match(LABEL_VOLUME_RE);
  if (m) {
    const unit = findUnit(m[2]);
    const qty = m[1] ? parseQuantity(m[1]) : 1;
    if (unit && qty > 0) return { unitId: unit.id, qty, ml: qty * unit.amount };
  }
  const ml = text.match(/\(\s*(\d+(?:\.\d+)?)\s*ml\s*\)/i);
  if (ml && Number(ml[1]) > 0) return { unitId: "ml", qty: Number(ml[1]), ml: Number(ml[1]) };
  return null;
}

/**
 * grams per millilitre implied by the food's own volume-style serving ("1 cup cooked rice (150g)" is
 * 150 g in 250 ml = 0.6 g/ml). First usable serving wins (they arrive highest-priority first). Null when
 * the food has no volume serving, so callers fall back to 1 g/ml and say so.
 */
export function deriveDensity(servings) {
  for (const s of servings || []) {
    if (!s || s.source === "reference") continue;
    const v = parseServingVolume(s.label);
    if (!v || !(Number(s.grams) > 0)) continue;
    const gPerMl = Number(s.grams) / v.ml;
    if (gPerMl >= 0.05 && gPerMl <= 3) return { gPerMl, basis: s.label, volumeMl: v.ml };
  }
  return null;
}

// ── quantity + unit of a food to grams ───────────────────────────────────────

/**
 * Converts {quantity, unit} of one food to grams. `getServings` returns that food's serving_sizes
 * candidates (buildServingSizes), called lazily so a plain "200 g" never builds them.
 *
 *   1. Weight unit (g, kg, oz, lb ...): exact.
 *   2. "serving": the food's most specific serving.
 *   3. Volume unit (ml, tsp, tbsp, dsp, cup, us cup, fl oz, scoop #16 ...):
 *        a. the food's own serving in that same unit ("1 cup cooked rice (150g)" for cup),
 *        b. otherwise the food's density from any of its volume servings,
 *        c. otherwise 1 g/ml, flagged (water-like; the behaviour before density was used).
 *   4. A food-specific label ("chipande", "piece", "sachet"), matched by text.
 *   5. Generic count units (slice, handful, pinch).
 */
export function resolveQuantityToGrams(getServings, quantity, unitRaw) {
  const u = normalizeUnitKey(unitRaw || "g");
  const def = findUnit(u);

  if (def && def.kind === "mass") {
    return { grams: quantity * def.amount, basis: `${u} (direct mass conversion)` };
  }

  const servings = getServings();

  if (u === "serving" || u === "servings") {
    const best =
      servings.find((c) => c.source !== "reference" && !isPlainMassLabel(c.label)) ||
      servings.find((c) => c.source !== "reference") ||
      servings[0];
    if (best) return { grams: quantity * best.grams, basis: best.label };
  }

  if (def && def.kind === "volume") {
    for (const s of servings) {
      if (s.source === "reference") continue;
      const v = parseServingVolume(s.label);
      if (v && v.unitId === def.id && Number(s.grams) > 0) {
        return { grams: (quantity * s.grams) / v.qty, basis: s.label, density_g_per_ml: s.grams / v.ml, density_basis: s.label };
      }
    }
    const d = deriveDensity(servings);
    if (d) {
      return {
        grams: quantity * def.amount * d.gPerMl,
        basis: `${u} using this food's own density (${round(d.gPerMl)} g/ml, from '${d.basis}')`,
        density_g_per_ml: d.gPerMl,
        density_basis: d.basis,
      };
    }
    return {
      grams: quantity * def.amount,
      basis: def.household ? `generic '${u}' estimate (not food-specific; assumes 1 g/ml)` : `${u} (direct volume conversion; assumes 1 g/ml)`,
      density_g_per_ml: 1,
      density_basis: null,
      assumed_density: true,
    };
  }

  const labelMatch = servings.find((c) => c.label.toLowerCase().includes(u));
  if (labelMatch) return { grams: quantity * labelMatch.grams, basis: labelMatch.label };

  if (COUNT_UNIT_GRAMS[u] != null) {
    return { grams: quantity * COUNT_UNIT_GRAMS[u], basis: `generic '${u}' estimate (not food-specific)` };
  }

  return {
    grams: null,
    reason: `unrecognized unit '${unitRaw}' — use g/kg/mg/oz/lb, ml/l/fl oz, a household unit (tsp/tbsp/dsp/cup/us cup/scoop 16/slice/handful/piece/serving), or a food-specific label such as chipande (see GET /measures for the full list)`,
  };
}

// ── grams to standard + household ────────────────────────────────────────────

/**
 * Describes an amount of one food (already in grams) in standard measures and in household measures:
 * the food's own servings (chipande, cup, piece ...) as fractional counts, plus spoons and cups when a
 * density is known. Volume equivalents are left out, not guessed, when no density is known.
 */
export function describeAmount({ grams, servings, densityGPerMl }) {
  const ml = densityGPerMl > 0 ? grams / densityGPerMl : null;
  const household = {
    servings: (servings || [])
      .filter((s) => s.source !== "reference" && Number(s.grams) > 0 && !isPlainMassLabel(s.label))
      .map((s) => {
        const q = grams / s.grams;
        return { label: s.label, source: s.source, grams_per_serving: s.grams, quantity: round(q), display_quantity: formatQuantity(q) };
      }),
    volume: ml != null ? volumeEquivalents(ml) : null,
  };
  return {
    standard: { grams: round(grams), kilograms: round(grams / 1000, 3), milliliters: round(ml), other_weight_units: weightEquivalents(grams) },
    household,
  };
}

const COOKED_LABEL = /\bcooked\b/i;
const COOKED_FOOD_NAME = /(cooked|boiled|steamed|porridge|nsima|stew|fried|roasted|baked|soup|sauce)/i;

/**
 * Cup and spoon servings are usually written for the cooked food ("1 cup cooked rice (150g)"). When the
 * serving that supplies the density says cooked but the food's own name doesn't, say so: the grams per cup
 * of a raw, soaked or dry food are different.
 */
export function densityFormWarning(foodName, densityBasis) {
  if (!densityBasis || !COOKED_LABEL.test(densityBasis)) return null;
  if (COOKED_FOOD_NAME.test(String(foodName || ""))) return null;
  return `The cup/spoon serving used here is for a cooked food ('${densityBasis}') but this food is listed as '${foodName}'. If it is raw, soaked or dry, a cup weighs differently: check the grams, or ask with weight (g) instead.`;
}

// ── printed reference tables (as in the sources; for display, not calculation) ─

export const REFERENCE_TABLES = {
  household_metric_uct: {
    source: MEASURE_SOURCES.uct,
    system: "metric_household",
    rows: [
      { label: "1 tsp (teaspoon)", ml: 5 },
      { label: "1 Tbs (tablespoon)", ml: 15 },
      { label: "3 Tbs (tablespoon)", ml: 45 },
      { label: "1 Dsp (dessertspoon)", ml: 20 },
      { label: "1 h Dsp (heaped dessert spoon)", ml: 30 },
      { label: "2 h Dsp (heaped dessert spoon)", ml: 60 },
      { label: "1/4 cup", ml: 60 },
      { label: "1/3 cup", ml: 80 },
      { label: "1/2 cup", ml: 125 },
      { label: "1 cup", ml: 250 },
      { label: "2 cups", ml: 500 },
      { label: "3 cups", ml: 750 },
      { label: "1 slice of bread", g: 42, approximate: true },
    ],
  },
  kitchen_volume: {
    source: MEASURE_SOURCES.kitchen,
    system: "us_customary",
    note: "Printed values are approximate.",
    rows: [
      { label: "1 teaspoon", equals: ["1/3 tablespoon"], ml: 5 },
      { label: "1 tablespoon", equals: ["1/2 fluid ounce", "3 teaspoons"], ml: 15 },
      { label: "2 tablespoons", equals: ["1 fluid ounce", "1/8 cup", "6 teaspoons"], ml: 30 },
      { label: "1/4 cup", equals: ["2 fluid ounces", "4 tablespoons"], ml: 59 },
      { label: "1/3 cup", equals: ["2 2/3 fluid ounces", "5 tablespoons & 1 teaspoon"], ml: 79 },
      { label: "1/2 cup", equals: ["4 fluid ounces", "8 tablespoons"], ml: 118 },
      { label: "2/3 cup", equals: ["5 1/3 fluid ounces", "10 tablespoons & 2 teaspoons"], ml: 158 },
      { label: "3/4 cup", equals: ["6 fluid ounces", "12 tablespoons"], ml: 177 },
      { label: "7/8 cup", equals: ["7 fluid ounces", "14 tablespoons"], ml: 207 },
      { label: "1 cup", equals: ["8 fluid ounces", "1/2 pint", "16 tablespoons"], ml: 237 },
      { label: "2 cups", equals: ["16 fluid ounces", "1 pint", "32 tablespoons"], ml: 473 },
      { label: "4 cups", equals: ["32 fluid ounces", "1 quart"], ml: 946 },
      { label: "1 pint", equals: ["2 cups", "16 fluid ounces"], ml: 473 },
      { label: "2 pints", equals: ["1 quart", "32 fluid ounces"], ml: 946, liters: 0.946 },
      { label: "8 pints", equals: ["1 gallon", "128 fluid ounces"], ml: 3785, liters: 3.78 },
      { label: "4 quarts", equals: ["1 gallon", "128 fluid ounces"], ml: 3785, liters: 3.78 },
      { label: "1 liter", equals: ["1.057 quarts"], ml: 1000 },
    ],
  },
  kitchen_weight: {
    source: MEASURE_SOURCES.kitchen,
    system: "us_customary",
    note: "Printed values are rounded for the kitchen (8 oz is 226.8 g exactly); calculations use 28.35 g per ounce.",
    rows: [
      { label: "1 ounce", g: 30, exact_g: 28.35 },
      { label: "2 ounces", g: 55 },
      { label: "3 ounces", g: 85 },
      { label: "4 ounces", equals: ["1/4 pound"], g: 125 },
      { label: "8 ounces", equals: ["1/2 pound"], g: 240 },
      { label: "12 ounces", equals: ["3/4 pound"], g: 375 },
      { label: "16 ounces", equals: ["1 pound"], g: 454 },
      { label: "32 ounces", equals: ["2 pounds"], g: 907 },
      { label: "1 kilogram", equals: ["2.2 pounds", "35.2 ounces"], g: 1000 },
    ],
  },
  krause_liquid_equivalents: {
    source: MEASURE_SOURCES.krause,
    system: "us_customary",
    rows: [
      { label: "1 tsp", equals: ["1/3 Tbsp"], ml: 5 },
      { label: "1 Tbsp", equals: ["3 tsp"], ml: 15 },
      { label: "2 Tbsp", equals: ["1 fluid oz", "1/8 cup"], ml: 30 },
      { label: "2 Tbsp + 2 tsp", equals: ["1/6 cup"], ml: 40 },
      { label: "4 Tbsp", equals: ["1/4 cup", "2 fluid oz"], ml: 60 },
      { label: "5 Tbsp + 1 tsp", equals: ["1/3 cup"], ml: 80 },
      { label: "6 Tbsp", equals: ["3 fluid oz", "3/8 cup"], ml: 90 },
      { label: "8 Tbsp", equals: ["1/2 cup"], ml: 120 },
      { label: "10 Tbsp + 2 tsp", equals: ["2/3 cup"], ml: 160 },
      { label: "12 Tbsp", equals: ["3/4 cup"], ml: 180 },
      { label: "48 tsp", equals: ["16 Tbsp", "1 cup (8 fluid oz)", "1/2 pint"], ml: 240 },
      { label: "2 cups", equals: ["1 pint (16 fluid oz)"], liters: 0.4732 },
      { label: "4 cups", equals: ["2 pints", "1 quart (32 fluid oz)"], liters: 0.9462 },
      { label: "1.06 quarts", equals: ["34 fluid oz"], ml: 1000 },
      { label: "4 quarts", equals: ["1 gallon"], ml: 3785 },
    ],
  },
  krause_dry_measure: {
    source: MEASURE_SOURCES.krause,
    system: "us_customary",
    note: "Dry-measure pints and quarts are approximately 1/6 larger than liquid-measure pints and quarts.",
    rows: [{ label: "1 dry quart", equals: ["2 dry pints"], liters: 1.101 }],
  },
  krause_weights: {
    source: MEASURE_SOURCES.krause,
    system: "us_customary",
    rows: [
      { label: "1 oz", g: 30, approximate: true },
      { label: "1 lb (16 oz)", g: 454 },
      { label: "2.2 lb", g: 1000, equals: ["1 kg"] },
    ],
  },
  krause_metric_conversion_factors: {
    source: MEASURE_SOURCES.krause,
    note: "Multiply the first quantity by the factor to get the second. The gallons-to-cubic-centimetres row is printed as 3.785; a gallon is 3785 cc, so that factor looks like a printing slip and is not used.",
    rows: [
      { from: "fluid ounces", factor: 29.57, to: "grams" },
      { from: "ounces (dry)", factor: 28.35, to: "grams" },
      { from: "grams", factor: 0.0353, to: "ounces" },
      { from: "grams", factor: 0.0022, to: "pounds" },
      { from: "kilograms", factor: 2.21, to: "pounds" },
      { from: "pounds", factor: 453.6, to: "grams" },
      { from: "pounds", factor: 0.4536, to: "kilograms" },
      { from: "quarts", factor: 0.946, to: "liters" },
      { from: "quarts (dry)", factor: 67.2, to: "cubic inches" },
      { from: "quarts (liquid)", factor: 57.7, to: "cubic inches" },
      { from: "liters", factor: 1.0567, to: "quarts" },
      { from: "gallons", factor: 3.785, to: "cubic centimeters", printed_as_is: true },
      { from: "gallons", factor: 3.785, to: "liters" },
    ],
  },
};

/** Everything GET /measures returns: units, the printed tables, scoop sizes, sources. */
export function measureCatalog() {
  return {
    note: "'cup' is the 250 ml metric household cup (UCT guide); 'us cup' is the 240 ml nutrition cup (Krause). Reference tables are as printed; calculations use the exact sizes in `units`. Weight-to-volume needs a food: use GET /foods/convert.",
    units: UNITS.filter((u) => !u.id.startsWith("scoop_")).map((u) => ({
      id: u.id, label: u.label, kind: u.kind, system: u.system,
      [u.kind === "volume" ? "ml" : "grams"]: u.amount,
      household: u.household, aliases: u.aliases, sources: u.sources.map((s) => ({ id: s, citation: MEASURE_SOURCES[s] })), note: u.note,
    })),
    scoop_sizes: SCOOP_SIZES.map((s) => ({ ...s, unit_id: `scoop_${s.number}`, source: MEASURE_SOURCES.krause })),
    reference_tables: REFERENCE_TABLES,
    sources: MEASURE_SOURCES,
  };
}
