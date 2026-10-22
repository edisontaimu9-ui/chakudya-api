#!/usr/bin/env node
// Loads clearly-labelled SYNTHETIC screening records into the surveillance engine, so hotspots, early warnings,
// trends and insights can be seen working. Nothing here is real data: every record has source "demo".
//
//   CHAKUDYA_API_KEY=your_key node scripts/surveillance_demo.mjs                send the demo data
//   CHAKUDYA_API_KEY=your_key node scripts/surveillance_demo.mjs --dry-run      only show what would be sent
//   CHAKUDYA_API_URL=https://...  to point at another deployment (default: the live API)
//
// Safe to run twice: each record has a fixed submission_id, so repeats are counted once.
//
// REMOVE ALL DEMO DATA (Supabase SQL editor):
//   delete from surveillance_records where source = 'demo';
//
// The story the data tells (so you can check the engine finds it):
//   Mangochi    very high stunting; wasting jumps in the last 3 months      -> hotspot + rising alert
//   Salima      wasting jumps in the last 3 months                          -> rising alert
//   Machinga    wasting up a little in the last 3 months                    -> rising (smaller)
//   Nsanje, Chikwawa   steady high wasting and food insecurity              -> hotspots
//   Karonga, Rumphi, Mzimba   low stunting                                  -> below national
//   Likoma      a handful of records                                        -> hidden (too few)
//   Neno, Chitipa   a few records                                           -> not compared (too few)
//   Mchinji, Ntchisi   no records at all                                    -> data gaps
//   Everywhere  wasting drifts up over the year                             -> national rising trend
//   Blantyre, Lilongwe, Zomba   high adult overweight                       -> adult hotspots

import { DISTRICTS } from "../src/surveillance.js";

export const DEMO_SOURCE = "demo";

/* deterministic random numbers, so everyone gets the same demo */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, "0");

const NO_DATA = new Set(["Mchinji", "Ntchisi"]);
const FEW = { Likoma: 0.45, Neno: 2, Chitipa: 2 }; // average records per month (under 5)
const BIG = new Set(["Mangochi", "Salima", "Machinga"]); // a bit more data, so the alerts have power
const HIGH_WASTING = new Set(["Nsanje", "Chikwawa"]);
const LOW_STUNTING = new Set(["Karonga", "Rumphi", "Mzimba"]);
const ADULT_DISTRICTS = ["Blantyre", "Lilongwe", "Zomba", "Mzimba", "Kasungu", "Mangochi", "Thyolo", "Dedza", "Salima", "Machinga"];
const URBAN = new Set(["Blantyre", "Lilongwe", "Zomba"]);

const monthList = (now, count = 12) => {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, index: count - 1 - i });
  }
  return out;
};

/** Builds the full set of demo records (plain objects, ready to POST). */
export function generateDemoRecords(now = new Date()) {
  const rand = mulberry32(20261022);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;
  const grade = (p, severeShare) => (chance(p) ? (chance(severeShare) ? "severe" : "moderate") : "normal");
  const settings = () => (chance(0.5) ? "facility" : chance(0.7) ? "community" : "outreach");
  const months = monthList(now, 12);
  const last = months.length - 1;
  const records = [];
  let serial = 0;

  const day = (mo) => {
    const isCurrent = mo.index === last;
    const maxDay = isCurrent ? Math.max(1, Math.min(28, now.getUTCDate())) : 28;
    return 1 + Math.floor(rand() * maxDay);
  };
  const base = (district, mo) => ({
    submission_id: `demo-${String(++serial).padStart(6, "0")}-${district.replace(/\W/g, "").toLowerCase().slice(0, 8)}`,
    consent_confirmed: true,
    observed_on: `${mo.y}-${pad(mo.m)}-${pad(day(mo))}`,
    district,
    sex: chance(0.5) ? "female" : "male",
    setting: settings(),
    source: DEMO_SOURCE,
  });

  /* children under 5 */
  for (const { district } of DISTRICTS) {
    if (NO_DATA.has(district)) continue;
    for (const mo of months) {
      let n;
      if (FEW[district] !== undefined) {
        const avg = FEW[district];
        n = avg < 1 ? (chance(avg) ? 1 : 0) : Math.max(1, Math.round(avg + (rand() - 0.5)));
      } else {
        n = (BIG.has(district) ? 24 : 12) + Math.floor(rand() * 9);
      }
      const recent = mo.index >= last - 2;
      for (let i = 0; i < n; i++) {
        const ageMonths = Math.floor(rand() * 60);
        let stunt = LOW_STUNTING.has(district) ? 0.17 : district === "Mangochi" ? 0.42 : 0.27;
        let waste = 0.03 + 0.015 * (mo.index / last); // gentle national drift upwards over the year
        if (HIGH_WASTING.has(district)) waste = 0.085;
        if (district === "Mangochi" && recent) waste = 0.15;
        if (district === "Salima" && recent) waste = 0.13;
        if (district === "Machinga" && recent) waste = 0.09;
        const food = HIGH_WASTING.has(district) ? 0.55 : 0.3;
        const outcomes = {
          stunting: grade(stunt, 0.35),
          wasting: grade(waste, 0.3),
          underweight: grade(0.1 + (stunt - 0.27) * 0.3, 0.2),
          muac_gam: grade(waste * 0.7, 0.3),
          overweight: chance(0.03) ? "overweight" : "normal",
          anaemia_suspected: chance(0.25),
          low_dietary_diversity: chance(0.6),
          food_insecure_household: chance(food),
          recent_diarrhoea: chance(0.12),
          bilateral_oedema: chance(0.003),
        };
        if (ageMonths < 6) outcomes.not_exclusively_breastfed = chance(0.4);
        records.push({ ...base(district, mo), age_months: ageMonths, population_group: "under5", outcomes });
      }
    }
  }

  /* adults */
  for (const district of ADULT_DISTRICTS) {
    for (const mo of months) {
      const n = 8 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const over = URBAN.has(district) ? 0.4 : 0.2;
        const outcomes = {
          adult_underweight: grade(0.08, 0.15) === "normal" ? "normal" : pick(["mild", "mild", "moderate", "severe"]),
          adult_overweight: chance(over) ? (chance(0.3) ? "obese" : "overweight") : "normal",
          anaemia_suspected: chance(0.2),
          food_insecure_household: chance(0.3),
        };
        records.push({ ...base(district, mo), age_years: 19 + Math.floor(rand() * 50), population_group: "adult", outcomes });
      }
    }
  }
  return records;
}

/* ───────────── sending ───────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(url, key, batch) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${url}/surveillance/records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch }),
    });
    if (res.status === 429) {
      const wait = Math.max(5, parseInt(res.headers.get("Retry-After") || "30", 10));
      console.log(`  rate limited, waiting ${wait}s ...`);
      await sleep(wait * 1000);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${body.message || ""} ${JSON.stringify(body.data?.rejected?.slice(0, 2) || "")}`);
    return body.data;
  }
  throw new Error("Gave up after repeated rate limits");
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const url = (process.env.CHAKUDYA_API_URL || "https://chakudya-api.edisontaimu9.workers.dev").replace(/\/+$/, "");
  const key = process.env.CHAKUDYA_API_KEY;
  const records = generateDemoRecords(new Date());

  const bySource = records.reduce((a, r) => ((a[r.population_group] = (a[r.population_group] || 0) + 1), a), {});
  console.log(`Demo data: ${records.length} synthetic records (${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  if (dry) { console.log("Dry run, nothing sent."); return; }
  if (!key) { console.error("Set CHAKUDYA_API_KEY first, for example:\n  CHAKUDYA_API_KEY=your_key node scripts/surveillance_demo.mjs"); process.exit(1); }

  let stored = 0, already = 0, rejected = 0;
  const size = 100;
  const batches = Math.ceil(records.length / size);
  for (let i = 0; i < records.length; i += size) {
    const out = await send(url, key, records.slice(i, i + size));
    stored += out.stored; already += out.already_received; rejected += out.rejected.length;
    console.log(`  batch ${i / size + 1}/${batches}: stored ${out.stored}, already had ${out.already_received}, rejected ${out.rejected.length}`);
    if (out.rejected.length) console.log("   first problem:", JSON.stringify(out.rejected[0]));
    await sleep(1300); // the API allows 60 requests a minute per address
  }
  console.log(`\nDone. Stored ${stored}, already had ${already}, rejected ${rejected}.`);
  console.log(`\nNow look at it (admin key):\n  curl -H "Authorization: Bearer ADMIN_KEY" "${url}/surveillance/insights"`);
  console.log("\nRemove all demo data later (Supabase SQL editor):\n  delete from surveillance_records where source = 'demo';");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
}
