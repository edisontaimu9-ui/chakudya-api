import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activityLogToPalEntries, DELTA_PAL_DIVISOR } from "../src/activityEnergy.js";
import { enrichActivityLog } from "../src/energyLookup.js";
import { computeEnergyRequirements, ACTIVITY_TABLE } from "../src/energyEngine.js";

const rows = JSON.parse(readFileSync(new URL("../scripts/activity_energy_seed.json", import.meta.url), "utf8")).items.map((r, i) => ({ id: i + 1, ...r }));
const fakeDb = ({ ok = true, data = rows, boom = false } = {}) => ({ async select() { if (boom) throw new Error("x"); return { ok, status: ok ? 200 : 500, body: data }; } });
const run30 = { activity: "Run", type: "6 mph, 10 min/mile", minutes: 30 };
const walk60 = { activity: "Walk", type: "3 mph, 20 min/mile", hours: 1 };

test("delta PAL relation (METs - 1) / 17.5 reproduces Krause Table 2.4 within rounding", () => {
  assert.equal(DELTA_PAL_DIVISOR, 17.5);
  for (const a of ACTIVITY_TABLE) {
    if (a.mets <= 1) continue;
    assert.ok(Math.abs((a.mets - 1) / DELTA_PAL_DIVISOR - a.delta_pal_per_hour) < 0.005, a.id);
  }
});

test("a log becomes PAL entries with METs from kcal per hour / kg", () => {
  const r = activityLogToPalEntries({ weight_kg: 65, activity_log: [run30, walk60] }, rows);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].hours, 0.5);
  assert.ok(Math.abs(r.entries[0].mets - 10.52) < 0.02);
  assert.ok(Math.abs(r.entries[0].delta_pal_per_hour - 0.544) < 0.003);
  assert.ok(Math.abs(r.entries[1].mets - 3.47) < 0.02);
  assert.equal(r.log.activities.length, 2);
  assert.match(r.log.notes.join(" "), /everyday activities/);
});

test("errors name activity_log, not activities", () => {
  assert.match(activityLogToPalEntries({ weight_kg: 65, activity_log: [{ activity: "Quidditch", minutes: 5 }] }, rows).error, /^activity_log\[0\]: unknown activity/);
  assert.match(activityLogToPalEntries({ weight_kg: 65, activity_log: [] }, rows).error, /^activity_log must/);
  assert.ok(activityLogToPalEntries({ activity_log: [run30] }, rows).error);
});

test("enrichActivityLog leaves a body without activity_log alone", async () => {
  const body = { sex: "female" };
  const r = await enrichActivityLog(body, fakeDb());
  assert.equal(r.body, body);
  assert.equal(r.activityLog, null);
});

test("enrichActivityLog merges with Table 2.4 activities and reports problems", async () => {
  const body = { weight_kg: 65, activities: [{ id: "light_activity_sitting", hours: 8 }], activity_log: [run30] };
  const r = await enrichActivityLog(body, fakeDb());
  assert.equal(r.body.activities.length, 2);
  assert.equal(r.body.activities[0].id, "light_activity_sitting");
  assert.equal((await enrichActivityLog({ weight_kg: 65, activity_log: "run" }, fakeDb())).status, 400);
  assert.equal((await enrichActivityLog({ weight_kg: 65, activities: "x", activity_log: [run30] }, fakeDb())).status, 400);
  assert.equal((await enrichActivityLog({ weight_kg: 65, activity_log: [run30] }, fakeDb({ ok: false }))).status, 502);
  assert.equal((await enrichActivityLog({ weight_kg: 65, activity_log: [run30] }, fakeDb({ boom: true }))).status, 502);
  assert.equal((await enrichActivityLog({ weight_kg: 65, activity_log: [run30] }, fakeDb({ data: [] }))).status, 503);
  assert.equal((await enrichActivityLog({ activity_log: [run30] }, fakeDb())).status, 400);
});

test("end to end: the log feeds the PAL and the IOM equations", async () => {
  const body = { sex: "female", age_years: 30, weight_kg: 65, height_cm: 177, activity_log: [run30, walk60] };
  const withLog = await enrichActivityLog(body, fakeDb());
  const r = computeEnergyRequirements(withLog.body);
  assert.equal(r.ok, true);
  const pal = r.data.activity.pal;
  assert.equal(pal.source, "activities");
  assert.ok(Math.abs(pal.pal - 1.513) < 0.01, String(pal.pal));
  assert.equal(pal.activities.length, 2);
  assert.ok(r.data.estimates.some((e) => e.basis.startsWith("IOM")));
  // more activity, more energy
  const more = computeEnergyRequirements((await enrichActivityLog({ ...body, activity_log: [run30, walk60, { activity: "Swim", type: "Laps freestyle, fast", hours: 1 }] }, fakeDb())).body);
  const kcal = (x) => x.data.estimates.find((e) => e.basis.startsWith("IOM")).kcal;
  assert.ok(kcal(more) > kcal(r));
});
