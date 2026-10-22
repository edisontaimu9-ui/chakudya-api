import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateDemoRecords, DEMO_SOURCE } from "../scripts/surveillance_demo.mjs";
import { ingestRecords, makeStore, buildInsights, analyseHotspots, INDICATORS, monthsBetween } from "../src/surveillance.js";

const NOW = new Date("2026-10-22T09:00:00Z");

// An in-memory stand-in for the three SQL functions, with the same grouping rules as sql/037.
function memoryDb() {
  const rows = [];
  return {
    rows,
    async rpc(fn, a) {
      if (fn === "surveillance_ingest") {
        let n = 0;
        for (const r of a.p_records) if (!rows.some((x) => x.submission_id === r.submission_id)) { rows.push(r); n++; }
        return { ok: true, status: 200, body: n };
      }
      const inWindow = rows.filter((r) => r.observed_month >= a.p_from && r.observed_month <= a.p_to && (!a.p_group || r.population_group === a.p_group) && (!a.p_district || r.district === a.p_district));
      if (fn === "surveillance_volume") {
        const m = new Map();
        for (const r of inWindow) {
          const k = [r.district, r.population_group, r.setting || "unknown"].join("|");
          const x = m.get(k) || { district: r.district, region: r.region, population_group: r.population_group, setting: r.setting || "unknown", n: 0, months: new Set() };
          x.n++; x.months.add(r.observed_month); m.set(k, x);
        }
        return { ok: true, status: 200, body: [...m.values()].map((x) => ({ ...x, months_reporting: x.months.size, months: undefined })) };
      }
      if (fn === "surveillance_counts") {
        const m = new Map();
        for (const r of inWindow) for (const [ind, st] of Object.entries(r.indicators)) {
          if (a.p_indicator && ind !== a.p_indicator) continue;
          const month = a.p_by_month ? r.observed_month : null, district = a.p_by_district ? r.district : null;
          const k = [month, district, r.population_group, ind].join("|");
          const x = m.get(k) || { month, district, region: a.p_by_district ? r.region : null, population_group: r.population_group, indicator: ind, counts: {} };
          x.counts[st] = (x.counts[st] || 0) + 1; m.set(k, x);
        }
        return { ok: true, status: 200, body: [...m.values()] };
      }
      return { ok: false, status: 404, body: null };
    },
  };
}

describe("demo data", () => {
  const records = generateDemoRecords(NOW);
  const db = memoryDb();
  let ingest;

  test("is synthetic, deterministic and accepted by the real validator", async () => {
    assert.ok(records.length > 4000 && records.length < 9000, `size ${records.length}`);
    assert.ok(records.every((r) => r.source === DEMO_SOURCE && r.consent_confirmed === true));
    assert.deepEqual(generateDemoRecords(NOW).slice(0, 50), records.slice(0, 50));
    assert.equal(new Set(records.map((r) => r.submission_id)).size, records.length);
    assert.ok(records.every((r) => new Date(r.observed_on) <= NOW));
    ingest = await ingestRecords(records, { db, fetchRows: async () => [], now: NOW });
    assert.equal(ingest.rejected.length, 0, JSON.stringify(ingest.rejected.slice(0, 2)));
    assert.equal(ingest.stored, records.length);
  });

  test("running it twice adds nothing", async () => {
    const again = await ingestRecords(records.slice(0, 300), { db, fetchRows: async () => [], now: NOW });
    assert.equal(again.stored, 0);
    assert.equal(again.already_received, 300);
  });

  test("stores no identifiers, exact dates or exact ages", () => {
    const sample = JSON.stringify(db.rows.slice(0, 500));
    assert.ok(!/age_months|age_years|observed_on|"2026-\d\d-(?!01")\d\d"/.test(sample));
    assert.ok(db.rows.every((r) => r.observed_month.endsWith("-01")));
  });

  test("the engine finds the story the data was built to tell", async () => {
    const store = makeStore(db);
    const out = await buildInsights(store, { groups: ["under5", "adult"], from: "2025-11-01", to: "2026-10-01", minN: 30, cell: 10 });
    assert.ok(out.ok);
    const ins = out.data.insights;
    const has = (type, district, indicator) => ins.find((i) => i.type === type && i.district === district && i.indicator === indicator);

    assert.ok(has("hotspot", "Mangochi", "stunting"), "Mangochi stunting hotspot");
    const acute = (type, district) => ins.find((i) => i.type === type && i.district === district && ["acute_malnutrition", "wasting", "muac_gam"].includes(i.indicator));
    assert.ok(acute("hotspot", "Nsanje"), "Nsanje acute malnutrition hotspot");
    assert.ok(acute("hotspot", "Chikwawa"), "Chikwawa acute malnutrition hotspot");
    assert.ok(has("hotspot", "Nsanje", "food_insecure_household"), "Nsanje food insecurity hotspot");
    assert.ok(acute("rising", "Mangochi"), "Mangochi rising");
    assert.ok(acute("rising", "Salima"), "Salima rising");
    for (const type of ["hotspot", "rising"]) {
      const seen = new Set();
      for (const i of ins.filter((x) => x.type === type && ["acute_malnutrition", "wasting", "muac_gam"].includes(x.indicator))) {
        const k = `${i.population_group}|${i.district}`;
        assert.ok(!seen.has(k), `one acute-malnutrition ${type} per district, saw two for ${k}`);
        seen.add(k);
      }
    }
    const mang = acute("rising", "Mangochi");
    assert.equal(mang.indicator, "acute_malnutrition");
    assert.ok(mang.also_flagged.includes("wasting"));
    assert.ok(!ins.find((i) => i.type === "rising" && i.indicator === "anaemia_suspected"), "no false alarm on anaemia");
    assert.ok(ins.find((i) => i.type === "hotspot" && i.indicator === "adult_overweight" && ["Blantyre", "Lilongwe", "Zomba"].includes(i.district)), "urban adult overweight hotspot");
    assert.ok(ins.find((i) => i.type === "trend" && i.indicator === "wasting"), "national wasting trend");
    const gap = ins.find((i) => i.type === "data_gap" && /Mchinji/.test(i.detail));
    assert.ok(gap && /Ntchisi/.test(gap.detail), "no-data districts reported");
    assert.ok(out.data.summary.high + out.data.summary.critical >= 3);
  });

  test("small districts are hidden or not compared; low-stunting districts read below national", async () => {
    const res = await makeStore(db).counts({ from: "2025-11-01", to: "2026-10-01", group: "under5", indicator: "stunting", byDistrict: true });
    const a = analyseHotspots(res.rows, "under5", "stunting", { minN: 30, cell: 10 });
    const by = Object.fromEntries(a.districts.map((d) => [d.district, d]));
    assert.equal(by.Likoma.classification, "suppressed");
    assert.ok(["insufficient_data", "suppressed"].includes(by.Neno.classification));
    assert.ok(!by.Mchinji && !by.Ntchisi, "no-data districts do not appear at all");
    assert.equal(by.Karonga.classification, "below_national");
    assert.equal(by.Mangochi.classification, "hotspot");
  });
});
