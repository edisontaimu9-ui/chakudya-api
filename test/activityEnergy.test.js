import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeActivityEnergy, kcalPerHour, findActivity, listActivities, parseWeight, TABLE_WEIGHTS_LB } from "../src/activityEnergy.js";

const seed = JSON.parse(readFileSync(new URL("../scripts/activity_energy_seed.json", import.meta.url), "utf8")).items;
const rows = seed.map((r, i) => ({ id: i + 1, ...r }));
const pick = (a, t) => findActivity(rows, a, t).row;

test("seed file has 130 rows, unique activity+type, rising values, 7 flagged misprints", () => {
  assert.equal(seed.length, 130);
  assert.equal(new Set(seed.map((r) => `${r.activity}|${r.type}`)).size, 130);
  for (const r of seed) {
    const suspect = new Set(r.suspect_weights_lb);
    const vals = TABLE_WEIGHTS_LB.filter((w) => !suspect.has(w)).map((w) => r[`kcal_${w}`]);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] > vals[i - 1], `${r.activity} ${r.type} not rising`);
  }
  assert.equal(seed.filter((r) => r.suspect_weights_lb.length).length, 7);
});

test("printed weight returns the printed value", () => {
  const k = kcalPerHour(pick("Run", "6 mph, 10 min/mile"), 150);
  assert.equal(k.kcal_per_hour, 716);
  assert.match(k.method, /table value at 150 lb/);
});

test("in-between weight is interpolated", () => {
  const k = kcalPerHour(pick("Run", "6 mph, 10 min/mile"), 140);
  assert.equal(k.kcal_per_hour, 668.5);
  assert.match(k.method, /interpolated between 130 lb and 150 lb/);
});

test("a suspect cell is skipped: walking 2.5 mph at 130 lb is interpolated from 110 and 150 lb, not the printed 133", () => {
  const row = pick("Walk", "2.5 mph, 24 min/mile");
  const k = kcalPerHour(row, 130);
  assert.equal(k.kcal_per_hour, 186.5);
  assert.match(k.method, /between 110 lb and 150 lb/);
  assert.match(k.notes.join(" "), /misprint/);
});

test("Hike General at 150 lb ignores the printed 460", () => {
  assert.equal(kcalPerHour(pick("Hike", "General"), 150).kcal_per_hour, 429.5);
});

test("outside 110-250 lb is scaled and flagged", () => {
  const k = kcalPerHour(pick("Run", "6 mph, 10 min/mile"), 275);
  assert.equal(Math.round(k.kcal_per_hour), Math.round((1193 * 275) / 250));
  assert.match(k.notes.join(" "), /above the table range/);
  assert.match(kcalPerHour(pick("Run", "6 mph, 10 min/mile"), 90).notes.join(" "), /below the table range/);
});

test("calculate: 30 min run plus 60 min walk at 70 kg", () => {
  const r = computeActivityEnergy({ weight_kg: 68.0389, activities: [{ activity: "Run", type: "6 mph, 10 min/mile", minutes: 30 }, { activity: "Walk", type: "3 mph, 20 min/mile", hours: 1 }] }, rows);
  assert.equal(r.ok, true);
  assert.equal(r.data.weight.lb, 150);
  assert.equal(r.data.activities[0].kcal, 358);
  assert.equal(r.data.activities[1].kcal, 236);
  assert.equal(r.data.total.kcal, 594);
  assert.equal(r.data.total.minutes, 90);
});

test("activity lookup is case-insensitive and asks for a type when needed", () => {
  assert.ok(findActivity(rows, "swim", "butterfly").row);
  assert.match(findActivity(rows, "Swim").error, /more than one type/);
  assert.match(findActivity(rows, "Quidditch").error, /unknown activity/);
  assert.match(findActivity(rows, "Walk", "9 mph").error, /no type/);
});

test("validation", () => {
  assert.equal(computeActivityEnergy(null, rows).ok, false);
  assert.equal(computeActivityEnergy({ activities: [] }, rows).ok, false);
  assert.equal(computeActivityEnergy({ weight_kg: 70, weight_lb: 150, activities: [{ activity: "Run", type: "5 mph, 12 min/mile", minutes: 10 }] }, rows).ok, false);
  assert.equal(computeActivityEnergy({ weight_kg: 70, activities: [{ activity: "Run", type: "5 mph, 12 min/mile" }] }, rows).ok, false);
  assert.equal(computeActivityEnergy({ weight_kg: 70, activities: [{ activity: "Run", type: "5 mph, 12 min/mile", minutes: 10, hours: 1 }] }, rows).ok, false);
  assert.equal(computeActivityEnergy({ weight_kg: 5, activities: [{ activity: "Run", type: "5 mph, 12 min/mile", minutes: 10 }] }, rows).ok, false);
  assert.ok(parseWeight({}).error);
});

test("listActivities filters and can read kcal per hour at a weight", () => {
  assert.equal(listActivities(rows, { activity: "Swim" }).length, 7);
  const l = listActivities(rows, { q: "butterfly", weightLb: 150 });
  assert.equal(l.length, 1);
  assert.equal(l[0].kcal_per_hour, 788);
  assert.equal(listActivities(rows, { q: "butterfly" })[0].kcal_per_hour_by_weight["250_lb"], 1312);
});
