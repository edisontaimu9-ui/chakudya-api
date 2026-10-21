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
