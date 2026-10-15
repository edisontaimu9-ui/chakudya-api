import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findUnit, convertUnits, parseQuantity, formatQuantity, parseServingVolume, deriveDensity,
  resolveQuantityToGrams, describeAmount, volumeEquivalents, measureCatalog, REFERENCE_TABLES, SCOOP_SIZES, UNIT_SURFACE_FORMS,
} from "../src/measures.js";

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

describe("unit table", () => {
  test("spellings from the three sources resolve to one unit", () => {
    for (const s of ["Tbs", "tbsp", "Tablespoons"]) assert.equal(findUnit(s).id, "tbsp");
    for (const s of ["Dsp", "dessertspoon", "dessert spoons"]) assert.equal(findUnit(s).id, "dsp");
    for (const s of ["h Dsp", "hdsp", "heaped dessert spoon", "Heaped Dessertspoon"]) assert.equal(findUnit(s).id, "hdsp");
    for (const s of ["fl oz", "Fl. Oz", "fl_oz", "fluid ounces"]) assert.equal(findUnit(s).id, "fl_oz");
    for (const s of ["us cup", "US_cup", "uscup"]) assert.equal(findUnit(s).id, "us_cup");
    assert.equal(findUnit("cc").id, "ml");
    assert.equal(findUnit("chipande"), null);
  });

  test("sizes match the sources", () => {
    assert.equal(findUnit("tsp").amount, 5);
    assert.equal(findUnit("tbsp").amount, 15);
    assert.equal(findUnit("dsp").amount, 20);
    assert.equal(findUnit("hdsp").amount, 30);
    assert.equal(findUnit("cup").amount, 250); // UCT: 1 cup = 250 ml
    assert.equal(findUnit("us cup").amount, 240); // Krause: 1 cup = 240 mL
    assert.equal(findUnit("oz").amount, 28.35);
    assert.equal(findUnit("lb").amount, 453.6);
    assert.equal(findUnit("pint").amount, 473.2);
    assert.equal(findUnit("quart").amount, 946.2);
    assert.equal(findUnit("gallon").amount, 3785);
    assert.equal(findUnit("dry quart").amount, 1101);
  });

  test("the parser still sees every unit the old tables had", () => {
    for (const u of ["g", "kg", "mg", "ml", "l", "oz", "lb", "floz", "fl_oz", "pint", "quart", "gallon", "dsp", "h dsp", "hdsp",
      "heaped dessertspoon", "cup", "cups", "tbsp", "tablespoon", "tsp", "teaspoons", "milliliter", "pounds"]) {
      assert.ok(UNIT_SURFACE_FORMS.has(u), u);
    }
  });
});

describe("unit to unit", () => {
  test("volume and weight conversions", () => {
    near(convertUnits(3, "tbsp", "ml").value, 45);
    near(convertUnits(2, "cups", "ml").value, 500);
    near(convertUnits(3, "cups", "ml").value, 750);
    near(convertUnits(2, "h dsp", "ml").value, 60);
    near(convertUnits(1, "cup", "us cup").value, 250 / 240, 1e-6);
    near(convertUnits(16, "oz", "g").value, 453.6);
    near(convertUnits(1, "kg", "lb").value, 2.2046, 0.01);
    near(convertUnits(4, "quarts", "gallon").value, 946.2 * 4 / 3785, 1e-6);
  });
  test("weight and volume do not convert without a food", () => {
    const c = convertUnits(1, "cup", "g");
    assert.equal(c.ok, false);
    assert.match(c.error, /\/foods\/convert/);
    assert.equal(convertUnits(1, "xyz", "g").ok, false);
  });
  test("exact sizes agree with the printed tables", () => {
    // Krause liquid equivalents (cup = 240) and the kitchen table (cup = 237) are within rounding of the units here.
    near(convertUnits(2, "tbsp", "fl_oz").value, 1.0156, 0.05); // 2 Tbsp = 1 fl oz
    near(convertUnits(1, "us cup", "tbsp").value, 16, 0.01); // 16 Tbsp = 1 cup
    near(convertUnits(2, "pint", "quart").value, 1, 0.01);
    near(convertUnits(1, "liter", "quart").value, 1.057, 0.01);
    // UCT rows: whole cups are exact, fractions are printed rounded.
    for (const r of REFERENCE_TABLES.household_metric_uct.rows) {
      const m = r.label.match(/^(\d+)\s+cups?$/);
      if (m) assert.equal(Number(m[1]) * 250, r.ml);
    }
  });
});

describe("quantities", () => {
  test("parseQuantity", () => {
    assert.equal(parseQuantity("2"), 2);
    assert.equal(parseQuantity("1/2"), 0.5);
    assert.equal(parseQuantity("1 1/2"), 1.5);
    assert.equal(parseQuantity("½"), 0.5);
    assert.equal(parseQuantity("1½"), 1.5);
    assert.equal(parseQuantity("abc"), null);
    assert.equal(parseQuantity("1/0"), null);
  });
  test("formatQuantity", () => {
    assert.equal(formatQuantity(1.5), "1½");
    assert.equal(formatQuantity(0.33), "⅓");
    assert.equal(formatQuantity(0.67), "⅔");
    assert.equal(formatQuantity(2.97), "3");
    assert.equal(formatQuantity(41.62), "41.6");
    assert.equal(formatQuantity(0.02), "0.02");
  });
});

describe("serving labels as volumes", () => {
  test("parseServingVolume", () => {
    assert.deepEqual(parseServingVolume("1 cup cooked rice (150g)"), { unitId: "cup", qty: 1, ml: 250 });
    assert.deepEqual(parseServingVolume("1 tablespoon / dzankho (15g)"), { unitId: "tbsp", qty: 1, ml: 15 });
    assert.deepEqual(parseServingVolume("1/2 cup (60g)"), { unitId: "cup", qty: 0.5, ml: 125 });
    assert.deepEqual(parseServingVolume("1 can (330ml)"), { unitId: "ml", qty: 330, ml: 330 });
    assert.equal(parseServingVolume("1 chipande (approx. 150-200g)"), null);
    assert.equal(parseServingVolume("1 slice (±42g)"), null);
    assert.equal(parseServingVolume("1 medium piece (150g)"), null);
  });
  test("deriveDensity", () => {
    const d = deriveDensity([{ label: "1 chipande (approx. 150-200g)", grams: 175, source: "local_intelligence" }, { label: "1 cup cooked rice (150g)", grams: 150, source: "fct" }]);
    near(d.gPerMl, 0.6, 1e-9);
    assert.equal(deriveDensity([{ label: "1 chipande (approx. 150-200g)", grams: 175, source: "local_intelligence" }]), null);
    assert.equal(deriveDensity([{ label: "1 cup (250ml)", grams: 250, source: "reference" }]), null);
  });
});

const RICE = [
  { label: "1 cup cooked rice (150g)", grams: 150, source: "local_intelligence" },
  { label: "100g", grams: 100, source: "reference" },
];
const NSIMA = [
  { label: "1 chipande (approx. 150-200g)", grams: 175, source: "local_intelligence" },
  { label: "100g", grams: 100, source: "reference" },
];
const MILK = [
  { label: "1 cup (250ml)", grams: 250, source: "local_intelligence" },
  { label: "100g / 100ml", grams: 100, source: "reference" },
];
const BREAD = [
  { label: "1 slice (±42g)", grams: 42, source: "local_intelligence" },
  { label: "100g", grams: 100, source: "reference" },
];

describe("quantity of a food to grams", () => {
  test("weights are exact and never build servings", () => {
    const r = resolveQuantityToGrams(() => { throw new Error("should not be called"); }, 2, "oz");
    near(r.grams, 56.7);
    assert.equal(resolveQuantityToGrams(() => { throw new Error("no"); }, 0.5, "kg").grams, 500);
  });
  test("a cup uses the food's own cup", () => {
    assert.equal(resolveQuantityToGrams(() => RICE, 2, "cups").grams, 300);
    assert.equal(resolveQuantityToGrams(() => MILK, 1.5, "cup").grams, 375);
  });
  test("spoons, ml and scoops use the food's density", () => {
    near(resolveQuantityToGrams(() => RICE, 1, "tbsp").grams, 9);
    near(resolveQuantityToGrams(() => RICE, 1, "tablespoon").grams, 9);
    near(resolveQuantityToGrams(() => RICE, 1, "dsp").grams, 12);
    near(resolveQuantityToGrams(() => RICE, 100, "ml").grams, 60);
    near(resolveQuantityToGrams(() => RICE, 1, "us cup").grams, 144);
    near(resolveQuantityToGrams(() => RICE, 1, "scoop 16").grams, 36); // 60 ml x 0.6
  });
  test("a food's tablespoon serving is used for tbsp and gives the cup via density", () => {
    const groundnuts = [{ label: "1 tablespoon / dzankho (15g)", grams: 15, source: "local_intelligence" }, { label: "100g", grams: 100, source: "reference" }];
    assert.equal(resolveQuantityToGrams(() => groundnuts, 3, "tbsp").grams, 45);
    near(resolveQuantityToGrams(() => groundnuts, 1, "cup").grams, 250);
  });
  test("no density on file: 1 g/ml, flagged", () => {
    const r = resolveQuantityToGrams(() => NSIMA, 2, "tbsp");
    assert.equal(r.grams, 30);
    assert.equal(r.assumed_density, true);
    const ml = resolveQuantityToGrams(() => NSIMA, 200, "ml");
    assert.equal(ml.grams, 200);
    assert.equal(ml.assumed_density, true);
  });
  test("food-specific labels and count units", () => {
    assert.equal(resolveQuantityToGrams(() => NSIMA, 2, "chipande").grams, 350);
    assert.equal(resolveQuantityToGrams(() => BREAD, 3, "slice").grams, 126);
    assert.equal(resolveQuantityToGrams(() => NSIMA, 2, "servings").grams, 350);
    assert.equal(resolveQuantityToGrams(() => NSIMA, 2, "handful").grams, 60);
  });
  test("unknown unit explains itself", () => {
    const r = resolveQuantityToGrams(() => NSIMA, 1, "bucket");
    assert.equal(r.grams, null);
    assert.match(r.reason, /GET \/measures/);
  });
});

describe("describing an amount", () => {
  test("grams in, household out", () => {
    const d = describeAmount({ grams: 300, servings: RICE, densityGPerMl: 0.6 });
    assert.equal(d.standard.grams, 300);
    assert.equal(d.standard.milliliters, 500);
    assert.equal(d.household.servings[0].quantity, 2);
    assert.equal(d.household.volume.suggested.unit, "cup");
    assert.equal(d.household.volume.suggested.quantity, 2);
    near(d.household.volume.all.find((e) => e.unit === "tbsp").quantity, 33.33);
  });
  test("no density: servings only, volume left out", () => {
    const d = describeAmount({ grams: 350, servings: NSIMA, densityGPerMl: null });
    assert.equal(d.standard.milliliters, null);
    assert.equal(d.household.volume, null);
    assert.equal(d.household.servings[0].quantity, 2);
    assert.equal(d.household.servings[0].display_quantity, "2");
  });
  test("suggested unit follows the size", () => {
    assert.equal(volumeEquivalents(500).suggested.unit, "cup");
    assert.equal(volumeEquivalents(45).suggested.unit, "tbsp");
    assert.equal(volumeEquivalents(5).suggested.unit, "tsp");
  });
});

describe("catalog", () => {
  test("has every source table and the scoop sizes", () => {
    const c = measureCatalog();
    assert.deepEqual(Object.keys(c.reference_tables).sort(), [
      "household_metric_uct", "kitchen_volume", "kitchen_weight", "krause_dry_measure",
      "krause_liquid_equivalents", "krause_metric_conversion_factors", "krause_weights",
    ]);
    assert.equal(c.scoop_sizes.length, 10);
    assert.equal(SCOOP_SIZES.find((s) => s.number === 16).approx_ml, 60);
    assert.equal(SCOOP_SIZES.find((s) => s.number === 60).approx_ml, 15);
    assert.ok(c.units.every((u) => u.sources.length >= 0 && u.id));
    assert.ok(c.units.find((u) => u.id === "cup").ml === 250);
  });
  test("uct table matches the printed guide", () => {
    const rows = Object.fromEntries(REFERENCE_TABLES.household_metric_uct.rows.map((r) => [r.label, r.ml ?? r.g]));
    assert.equal(rows["1 Dsp (dessertspoon)"], 20);
    assert.equal(rows["1 h Dsp (heaped dessert spoon)"], 30);
    assert.equal(rows["1/2 cup"], 125);
    assert.equal(rows["3 cups"], 750);
    assert.equal(rows["1 slice of bread"], 42);
  });
});
