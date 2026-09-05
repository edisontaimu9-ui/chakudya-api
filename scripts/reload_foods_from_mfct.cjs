#!/usr/bin/env node
// Chakudya Nutrition Registry
// Wipes public.foods (via the API, one DELETE per row) and reloads it from
// a Malawi FCT-style CSV (see mfct.csv), mapped onto the FULL schema added
// by sql/006_expand_foods_full_fct.sql — nothing from the CSV is dropped.
//
// Run this AFTER applying sql/006_expand_foods_full_fct.sql to the DB.
//
// Usage:
//   CHAKUDYA_ADMIN_KEY=chakudya_admin_xxx node scripts/reload_foods_from_mfct.js mfct.csv
//
// Optional:
//   CHAKUDYA_API_URL=https://chakudya-api.edisontaimu9.workers.dev  (default)
//   --yes     skip the interactive confirmation prompt
//
// Requires Node 18+ (built-in fetch). No npm install needed.

const fs = require("fs");
const readline = require("readline");

const API_URL = (process.env.CHAKUDYA_API_URL || "https://chakudya-api.edisontaimu9.workers.dev").replace(/\/$/, "");
const ADMIN_KEY = process.env.CHAKUDYA_ADMIN_KEY;
const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith("--"));
const skipConfirm = args.includes("--yes");

if (!ADMIN_KEY) {
  console.error("Set CHAKUDYA_ADMIN_KEY in the environment first.");
  process.exit(1);
}
if (!csvPath) {
  console.error("Usage: node reload_foods_from_mfct.js <path-to-csv> [--yes]");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${ADMIN_KEY}`,
};

// ── minimal RFC4180 CSV parser (handles quoted fields with embedded commas) ──
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\r") { /* skip, \n follows */ }
    else if (c === "\n") { pushField(); pushRow(); }
    else field += c;
  }
  if (field.length || row.length) { pushField(); pushRow(); }

  const header = rows.shift();
  return rows.filter((r) => r.length === header.length && r.some((v) => v !== "")).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx]; });
    return obj;
  });
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  return v === undefined || v === null || v === "" ? null : v;
}

// CSV column -> foods column. Anything not listed here has nowhere to go
// (there isn't anything left over post-006 — this is the full FCT panel).
function mapRow(r) {
  return {
    food_name: r.food_item_name,
    category: r.food_group,
    measure: "100g",
    weight_g: 100,

    mfct_code: str(r.code),
    mfct_reference: str(r.reference),

    moisture_g: num(r.moisture_g),
    kcal: num(r.energy_kcal),
    kj: num(r.energy_kj),
    nitrogen_g: num(r.nitrogen_g),
    protein_g: num(r.protein_g),
    fat_g: num(r.fat_g),
    safa_g: num(r.safa_g),
    mufa_g: num(r.mufa_g),
    pufa_g: num(r.pufa_g),
    cholesterol_mg: num(r.cholesterol_mg),
    carb_total_g: num(r.carbohydrate_total_g),
    carbs_g: num(r.carbohydrate_available_g),
    sugar_total_g: num(r.total_sugar_g),
    sugar_added_g: num(r.added_sugar_g),
    fiber_g: num(r.fiber_g),
    starch_g: num(r.starch_g),
    ash_g: num(r.ash_g),

    calcium_mg: num(r.calcium_mg),
    iron_mg: num(r.iron_mg),
    magnesium_mg: num(r.magnesium_mg),
    phosphorus_mg: num(r.phosphorus_mg),
    potassium_mg: num(r.potassium_mg),
    sodium_mg: num(r.sodium_mg),
    zinc_mg: num(r.zinc_mg),
    copper_mg: num(r.copper_mg),
    manganese_mcg: num(r.manganese_mcg),
    iodine_mcg: num(r.iodine_mcg),
    selenium_mcg: num(r.selenium_mcg),

    vita_rae_mcg: num(r.vitamin_a_rae_mcg),
    vita_re_mcg: num(r.vitamin_a_re_mcg),
    thiamin_mg: num(r.thiamin_mg),
    riboflavin_mg: num(r.riboflavin_mg),
    niacin_mg: num(r.niacin_mg),
    vitb6_mg: num(r.vitamin_b6_mg),
    folate_mcg: num(r.folate_mcg),
    vitb12_mcg: num(r.vitamin_b12_mcg),
    pantothenic_acid_mg: num(r.pantothenate_mg),
    biotin_mcg: num(r.biotin_mcg),
    vitc_mg: num(r.vitamin_c_mg),
    vitd_mcg: num(r.vitamin_d_mcg),
    vite_mg: num(r.vitamin_e_mg),
    phytate_mg: num(r.phytate_mg),

    data_quality_flags: str(r.data_quality_flags),
  };
}

async function confirm(promptText) {
  if (skipConfirm) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(promptText, res));
  rl.close();
  return answer.trim() === "DELETE";
}

async function fetchAllFoodIds() {
  const ids = [];
  let cursor = "";
  for (;;) {
    const url = `${API_URL}/foods?cursor=${cursor}&limit=500`;
    const resp = await fetch(url, { headers });
    const body = await resp.json();
    if (!resp.ok) throw new Error(`GET /foods failed: ${resp.status} ${JSON.stringify(body)}`);
    for (const row of body.data) ids.push(row.id);
    if (!body.has_more) break;
    cursor = String(body.next_cursor);
  }
  return ids;
}

async function deleteAll(ids) {
  const CONCURRENCY = 8;
  let done = 0;
  let failed = 0;
  const queue = [...ids];

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const resp = await fetch(`${API_URL}/foods/${id}`, { method: "DELETE", headers });
      if (!resp.ok) { failed++; console.error(`  ✗ delete id=${id} → ${resp.status}`); }
      done++;
      if (done % 25 === 0 || done === ids.length) process.stdout.write(`\r  deleted ${done}/${ids.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("");
  return failed;
}

async function bulkInsert(items) {
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const resp = await fetch(`${API_URL}/foods/bulk`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: chunk }),
    });
    const body = await resp.json();
    if (!resp.ok) throw new Error(`POST /foods/bulk failed: ${resp.status} ${JSON.stringify(body)}`);
    inserted += body.count || chunk.length;
    console.log(`  inserted ${inserted}/${items.length}`);
  }
  return inserted;
}

(async () => {
  const csvText = fs.readFileSync(csvPath, "utf-8");
  const rawRows = parseCSV(csvText);
  const items = rawRows.map(mapRow).filter((f) => f.food_name);

  console.log(`Parsed ${items.length} foods from ${csvPath}`);
  console.log("Sample:", JSON.stringify(items[0], null, 2));

  console.log(`\nFetching existing /foods rows from ${API_URL} ...`);
  const existingIds = await fetchAllFoodIds();
  console.log(`Found ${existingIds.length} existing rows.`);

  const ok = await confirm(
    `\nThis will PERMANENTLY delete all ${existingIds.length} existing foods rows, then insert ${items.length} new rows.\nType DELETE to continue: `
  );
  if (!ok) { console.log("Aborted — nothing changed."); process.exit(0); }

  if (existingIds.length) {
    console.log(`\nDeleting ${existingIds.length} rows...`);
    const failed = await deleteAll(existingIds);
    if (failed) console.warn(`${failed} deletes failed — check above before re-running.`);
  }

  console.log(`\nInserting ${items.length} rows...`);
  const inserted = await bulkInsert(items);

  console.log(`\nDone. ${inserted} foods loaded.`);
})().catch((e) => { console.error(e); process.exit(1); });
