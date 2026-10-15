import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFoodEnergy, alcoholDrinkKcal, KCAL_PER_GRAM } from "../src/foodEnergy.js";

test("Atwater factors are 4, 9, 4 and 7 kcal/g", () => {
  assert.deepEqual(KCAL_PER_GRAM, { protein: 4, fat: 9, carbohydrate: 4, alcohol: 7 });
});

test("the chapter's egg example: 50 g egg, 13% protein, 12% fat, 1% carbohydrate = 82 kcal", () => {
  const r = computeFoodEnergy({ weight_g: 50, protein_pct: 13, fat_pct: 12, carbohydrate_pct: 1 });
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.data.breakdown.map((b) => [b.nutrient, b]));
  assert.equal(by.protein.kcal, 26);
  assert.equal(by.fat.kcal, 54);
  assert.equal(by.carbohydrate.kcal, 2);
  assert.equal(r.data.total.kcal, 82);
  assert.equal(r.data.total.kj, Math.round(82 * 4.184));
  assert.equal(r.data.per_100g.kcal, 164);
  assert.equal(by.protein.percent_of_energy, 31.7);
});

test("grams input, alcohol grams at 7 kcal/g, and fiber is not added", () => {
  const r = computeFoodEnergy({ protein_g: 10, fat_g: 5, carbohydrate_g: 30, alcohol_g: 10, fiber_g: 8 });
  assert.equal(r.data.total.kcal, 40 + 45 + 120 + 70);
  assert.match(r.data.notes.join(" "), /Fiber is an unavailable carbohydrate/);
});

test("alcohol drink: 1.5 oz of 86 proof whiskey = 103 kcal, and abv_percent doubles to proof", () => {
  const r = computeFoodEnergy({ alcohol: { volume_oz: 1.5, proof: 86 } });
  assert.equal(r.data.total.kcal, 103);
  assert.equal(r.data.alcohol_drink.abv_percent, 43);
  assert.equal(alcoholDrinkKcal({ volume_oz: 1.5, abv_percent: 43 }).kcal, 1.5 * 86 * 0.8);
  assert.ok(alcoholDrinkKcal({ volume_oz: 1, proof: 80, abv_percent: 40 }).error);
  assert.ok(alcoholDrinkKcal({ volume_oz: 0, proof: 80 }).error);
  const mixed = computeFoodEnergy({ protein_g: 5, alcohol: { volume_oz: 1.5, proof: 86 } });
  assert.equal(mixed.data.total.kcal, 20 + 103);
});

test("validation", () => {
  assert.equal(computeFoodEnergy(null).ok, false);
  assert.equal(computeFoodEnergy({}).ok, false);
  assert.equal(computeFoodEnergy({ protein_g: 5, protein_pct: 10, weight_g: 50 }).ok, false);
  assert.equal(computeFoodEnergy({ protein_pct: 10 }).ok, false); // weight_g missing
  assert.equal(computeFoodEnergy({ weight_g: 50, protein_pct: 80, fat_pct: 30 }).ok, false);
  assert.equal(computeFoodEnergy({ protein_g: -1 }).ok, false);
  assert.equal(computeFoodEnergy({ weight_g: 10, protein_g: 8, fat_g: 8 }).ok, false);
  assert.equal(computeFoodEnergy({ alcohol_g: 5, alcohol: { volume_oz: 1, proof: 80 } }).ok, false);
});
