// Adds tube-feeding formulas and fills formula water in enteral_formulas through the live API. Safe to re-run.
// Rows are matched to existing formulas by name (case and punctuation ignored): a match gets a PATCH with the fields you
// supplied (nothing else is overwritten), a new name is inserted with POST /formulas/bulk.
//
//   Run sql/038_add_enteral_formula_water.sql first.
//   export CNR_KEY=cnr_xxx                         # admin key, never commit it
//   node scripts/load_enteral_formulas.mjs scripts/enteral_formulas_seed.json --dry-run
//   node scripts/load_enteral_formulas.mjs scripts/enteral_formulas_seed.json
//
// Optional: CNR_BASE=https://your-worker-url (defaults to the production Worker)
// Seed shape: see scripts/enteral_formulas_seed.template.json. Use values from the product sheet or formulary card only.
import { readFileSync } from "node:fs";

const BASE = (process.env.CNR_BASE || "https://chakudya-api.edisontaimu9.workers.dev").replace(/\/$/, "");
const KEY = process.env.CNR_KEY;
const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) { console.error("Usage: node scripts/load_enteral_formulas.mjs <seed.json> [--dry-run]"); process.exit(1); }
if (!KEY) { console.error("Set CNR_KEY first:  export CNR_KEY=cnr_..."); process.exit(1); }

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const num = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

async function existing() {
  const rows = new Map();
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const res = await fetch(`${BASE}/formulas?limit=100&cursor=${encodeURIComponent(cursor)}&_t=${Date.now()}`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GET /formulas failed (${res.status}): ${JSON.stringify(body)}`);
    for (const r of body.data || []) rows.set(norm(r.formula), r);
    if (!body.has_more) break;
    cursor = body.next_cursor;
  }
  return rows;
}

const { items } = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(items) || !items.length) { console.log("No items in the seed file."); process.exit(0); }

const problems = [];
const clean = items.map((it, i) => {
  const out = Object.fromEntries(Object.entries(it).filter(([k, v]) => !k.startsWith("_") && v !== undefined));
  const label = out.formula || `item ${i + 1}`;
  if (!out.formula) problems.push(`${label}: 'formula' (the product name) is required`);
  for (const k of ["kcal_per_ml", "protein_g_per_l", "water_ml_per_l", "cho_g_per_l", "fat_g_per_l", "fibre_g_per_l", "osmol"]) {
    if (out[k] !== undefined && out[k] !== null && !num(out[k])) problems.push(`${label}: '${k}' must be a number`);
  }
  if (num(out.kcal_per_ml) && (out.kcal_per_ml < 0.3 || out.kcal_per_ml > 3)) problems.push(`${label}: kcal_per_ml ${out.kcal_per_ml} looks wrong (expected 0.3-3 kcal per ml)`);
  if (num(out.water_ml_per_l) && (out.water_ml_per_l < 300 || out.water_ml_per_l > 1000)) problems.push(`${label}: water_ml_per_l ${out.water_ml_per_l} looks wrong (expected 300-1000 ml per litre)`);
  if (num(out.water_ml_per_l) && !out.water_source) problems.push(`${label}: add 'water_source' (where the water value came from)`);
  return out;
});
if (problems.length) { console.error("Fix these first:\n  " + problems.join("\n  ")); process.exit(1); }

const have = await existing();
const toInsert = [], toPatch = [];
for (const it of clean) {
  const row = have.get(norm(it.formula));
  if (!row) {
    if (!num(it.kcal_per_ml)) { console.error(`${it.formula}: a new formula needs kcal_per_ml`); process.exit(1); }
    toInsert.push(it);
  } else {
    const { formula, ...fields } = it;
    if (Object.keys(fields).length) toPatch.push({ id: row.id, name: row.formula, fields });
  }
}
console.log(`Seed rows: ${clean.length} | new: ${toInsert.length} | update existing: ${toPatch.length}`);
toInsert.forEach((r) => console.log(`  new:    ${r.formula}${num(r.water_ml_per_l) ? "" : "  (no water value, the calculator will estimate)"}`));
toPatch.forEach((p) => console.log(`  update: ${p.name} <- ${Object.keys(p.fields).join(", ")}`));
if (dryRun) { console.log("Dry run, nothing sent."); process.exit(0); }

if (toInsert.length) {
  const res = await fetch(`${BASE}/formulas/bulk`, { method: "POST", headers, body: JSON.stringify({ items: toInsert }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`Bulk insert failed (${res.status}):`, JSON.stringify(out)); process.exit(1); }
  console.log(out.message || `Inserted ${toInsert.length}`);
}
for (const p of toPatch) {
  const res = await fetch(`${BASE}/formulas/${p.id}`, { method: "PATCH", headers, body: JSON.stringify(p.fields) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`PATCH ${p.name} failed (${res.status}):`, JSON.stringify(out)); process.exit(1); }
  console.log(`updated ${p.name}`);
}
