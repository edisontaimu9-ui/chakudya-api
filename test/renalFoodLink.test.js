import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectFields, toNumber, linkRenalFoods } from "../src/renalFoodLink.js";

const exchange = [
  { id: 1, food_item: "Nsima", exchange_type: "starch", portion: "1/2 cup", kcal: 80, protein_g: 3, sodium_mg: 5, potassium_mg: 60, phosphorus_mg: "40 mg" },
  { id: 2, food_item: "Beans, cooked", exchange_type: "protein", portion: "1/2 cup", kcal: 110, protein_g: 7, sodium_mg: 10, potassium_mg: 300 },
  { id: 3, food_item: "Egg", exchange_type: "protein", portion: "1 egg", kcal: 75, protein_g: 6, sodium_mg: 70 },
];
const renal = [{ id: 9, food_name: "Egg", phosphorus_mg: 100, potassium_mg: 65, notes: "high phosphorus" }];
const body = { status: "hd", weight_kg: 60 };

describe("renalFoodLink", () => {
  test("toNumber reads plain numbers and numbers with units", () => {
    assert.equal(toNumber(12), 12); assert.equal(toNumber("40 mg"), 40); assert.equal(toNumber("n/a"), null); assert.equal(toNumber(null), null);
  });
  test("detectFields picks the first matching column that holds data", () => {
    const m = detectFields(exchange);
    assert.equal(m.name, "food_item"); assert.equal(m.group, "exchange_type"); assert.equal(m.protein_g, "protein_g"); assert.equal(m.phosphorus_mg, "phosphorus_mg");
  });
  test("targets come from /requirements and foods become shares of the daily limit", () => {
    const r = linkRenalFoods({ ...body, potassium_mg_per_day_max: 2000 }, exchange, renal);
    assert.equal(r.ok, true);
    const d = r.data;
    assert.equal(d.daily_budget.protein_g.max, 72);   // 1.2 g/kg x 60 kg
    assert.equal(d.daily_budget.sodium_mg.max, 2300);
    assert.equal(d.daily_budget.potassium_mg.source, "clinician-set limit (potassium_mg_per_day_max)");
    const beans = d.items.find((i) => i.name === "Beans, cooked");
    assert.equal(beans.pct_of_daily_limit.potassium_mg, 15);
    assert.equal(beans.pct_of_daily_limit.protein_g, round1(7 / 72 * 100));
    assert.ok(d.sources[0].includes("KDOQI"));
  });
  test("missing values are filled from the matching renal_foods row and the row is attached", () => {
    const d = linkRenalFoods({ ...body, phosphorus_mg_per_day_max: 1000 }, exchange, renal).data;
    const egg = d.items.find((i) => i.name === "Egg");
    assert.equal(egg.nutrients.phosphorus_mg, 100);
    assert.equal(egg.filled_from_renal_foods.phosphorus_mg, "renal_foods");
    assert.equal(egg.renal_foods_match.id, 9);
    assert.equal(egg.pct_of_daily_limit.phosphorus_mg, 10);
    assert.equal(d.counts.matched_to_renal_foods, 1);
  });
  test("an item at or above share_flag_pct is flagged", () => {
    const d = linkRenalFoods({ ...body, potassium_mg_per_day_max: 1000, share_flag_pct: 25 }, exchange, renal).data;
    assert.deepEqual(d.items.find((i) => i.name === "Beans, cooked").high_share.map((f) => f.nutrient), ["potassium_mg"]);
    assert.equal(d.items.find((i) => i.name === "Nsima").high_share.length, 0);
  });
  test("group averages give the exchanges that fit before the tightest limit", () => {
    const d = linkRenalFoods({ ...body, potassium_mg_per_day_max: 1500 }, exchange, renal).data;
    const g = d.groups.find((x) => x.group === "protein");
    assert.equal(g.items, 2);
    assert.ok(g.exchanges_until_limit.max_exchanges_per_day > 0);
    assert.ok(Object.keys(g.exchanges_until_limit.by_nutrient).includes("protein_g"));
  });
  test("no potassium or phosphorus budget without a clinician limit; legacy Krause figures only on request", () => {
    const plain = linkRenalFoods(body, exchange, renal).data;
    assert.equal(plain.daily_budget.potassium_mg, undefined);
    assert.ok(plain.warnings.some((w) => w.includes("No potassium budget")));
    const legacy = linkRenalFoods({ ...body, legacy_krause_limits: true }, exchange, renal).data;
    assert.equal(legacy.daily_budget.potassium_mg.max, 3000);
    assert.equal(legacy.daily_budget.phosphorus_mg.max, 1200);
    assert.ok(legacy.daily_budget.potassium_mg.source.includes("older than KDOQI 2020"));
  });
  test("exchange_type and q filter the items; limit caps them", () => {
    assert.equal(linkRenalFoods({ ...body, exchange_type: "STARCH" }, exchange, renal).data.items.length, 1);
    assert.equal(linkRenalFoods({ ...body, q: "bean" }, exchange, renal).data.items[0].name, "Beans, cooked");
    assert.equal(linkRenalFoods({ ...body, limit: 1 }, exchange, renal).data.items.length, 1);
  });
  test("unknown columns and empty tables are reported, not guessed", () => {
    const d = linkRenalFoods(body, [{ id: 1, label: "Rice" }], []).data;
    assert.ok(d.warnings.some((w) => w.includes("No name column")));
    assert.deepEqual(d.missing_fields.exchange_lists, ["protein_g", "sodium_mg", "potassium_mg", "phosphorus_mg"]);
    assert.ok(linkRenalFoods(body, [], []).data.warnings.some((w) => w.includes("no rows")));
  });
  test("bad input is rejected with the /requirements error or its own", () => {
    assert.equal(linkRenalFoods({ weight_kg: 60 }, exchange, renal).ok, false);
    assert.equal(linkRenalFoods({ ...body, share_flag_pct: 2 }, exchange, renal).ok, false);
    assert.equal(linkRenalFoods({ ...body, limit: 0 }, exchange, renal).ok, false);
    assert.equal(linkRenalFoods(null, exchange, renal).ok, false);
  });
});
function round1(x) { return Math.round((x + Number.EPSILON) * 10) / 10; }

describe("renalFoodLink with the live table shapes", () => {
  // Real rows from GET /exchange and GET /renal (renal numbers are text, per the row's own portion).
  const ex = [
    { id: 1, food_name: "Brown / wholewheat bread", exchange_type: "Starch", portion: "1 slice (±42 g)", kcal: 80, kj: 335, protein_g: 3, carbs_g: 15, fat_g: 0 },
    { id: 9, food_name: "Canned pilchards", exchange_type: "Lean meat", portion: "1/2 cup", kcal: 45, kj: 190, protein_g: 7, carbs_g: 0, fat_g: 2 },
    { id: 10, food_name: "Cheese (tussers, cheddar, gouda, normal feta)", exchange_type: "High fat meat", portion: "30 g", kcal: 100, kj: 420, protein_g: 7, carbs_g: 0, fat_g: 8 },
  ];
  const rn = [
    { id: 2, name: "Canned fish, pilchards in brine", code: "3055", grams: "30g", measure: "1 heaped DSP", energy_kj: "162.0", protein: "6.0", fat: "1.6", cho: "0.0", po4: "115.0", na: "156.0", k: "126.0" },
    { id: 6, name: "Cheese, Cheddar", code: "2722", grams: "30g", measure: "size of small matchbox", energy_kj: "494.0", protein: "7.4", fat: "9.7", cho: "0.5", po4: "160.0", na: "146.0", k: "25.0" },
  ];
  test("po4, na and k are detected as phosphorus, sodium and potassium", () => {
    const m = detectFields(rn);
    assert.equal(m.phosphorus_mg, "po4"); assert.equal(m.sodium_mg, "na"); assert.equal(m.potassium_mg, "k"); assert.equal(m.protein_g, "protein"); assert.equal(m.name, "name");
    const e = detectFields(ex);
    assert.equal(e.name, "food_name"); assert.equal(e.group, "exchange_type"); assert.equal(e.kcal, "kcal"); assert.equal(e.protein_g, "protein_g");
  });
  test("a strong name match fills missing K, P and Na; a one-word match is only offered", () => {
    const d = linkRenalFoods({ status: "hd", weight_kg: 60, potassium_mg_per_day_max: 2000, phosphorus_mg_per_day_max: 1000 }, ex, rn).data;
    const cheese = d.items.find((i) => i.name.startsWith("Cheese"));
    assert.equal(cheese.renal_foods_match.id, 6);
    assert.equal(cheese.nutrients.phosphorus_mg, 160); assert.equal(cheese.nutrients.potassium_mg, 25); assert.equal(cheese.nutrients.sodium_mg, 146);
    assert.equal(cheese.pct_of_daily_limit.phosphorus_mg, 16);
    const pilch = d.items.find((i) => i.name === "Canned pilchards");
    assert.equal(pilch.renal_foods_match, null);
    assert.equal(pilch.renal_foods_possible_match.id, 2);
    assert.equal(pilch.nutrients.phosphorus_mg, null);
    assert.equal(d.items.find((i) => i.name.startsWith("Brown")).renal_foods_possible_match, undefined);
    assert.equal(d.counts.matched_to_renal_foods, 1); assert.equal(d.counts.possible_matches, 1);
  });
});
