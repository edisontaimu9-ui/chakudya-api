// Loads a glycaemic-index seed into the live API, skipping rows whose
// food_name already exists (case/punctuation-insensitive). Safe to re-run.
//
//   export CNR_KEY=cnr_xxx                       # admin key, never commit it
//   node scripts/load_gi_seed.mjs scripts/krause_gi_seed.json --dry-run
//   node scripts/load_gi_seed.mjs scripts/krause_gi_seed.json
//
// Optional: CNR_BASE=https://your-worker-url (defaults to the production Worker)
import { readFileSync } from "node:fs";

const BASE = (process.env.CNR_BASE || "https://chakudya-api.edisontaimu9.workers.dev").replace(/\/$/, "");
const KEY = process.env.CNR_KEY;
const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!file) { console.error("Usage: node scripts/load_gi_seed.mjs <seed.json> [--dry-run]"); process.exit(1); }
if (!KEY) { console.error("Set CNR_KEY first:  export CNR_KEY=cnr_..."); process.exit(1); }

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function existingNames() {
  const names = new Set();
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const url = `${BASE}/glycaemic-index?limit=100&cursor=${encodeURIComponent(cursor)}&_t=${Date.now()}`;
    const res = await fetch(url, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GET /glycaemic-index failed (${res.status}): ${JSON.stringify(body)}`);
    for (const r of body.data || []) names.add(norm(r.food_name));
    if (!body.has_more) break;
    cursor = body.next_cursor;
  }
  return names;
}

const { items } = JSON.parse(readFileSync(file, "utf8"));
const have = await existingNames();
const fresh = [], skipped = [];
for (const it of items) (have.has(norm(it.food_name)) ? skipped : fresh).push(it);

console.log(`Seed rows: ${items.length} | already in DB: ${skipped.length} | to insert: ${fresh.length}`);
skipped.forEach((s) => console.log("  skip:", s.food_name));
if (dryRun || !fresh.length) { console.log(dryRun ? "Dry run, nothing sent." : "Nothing to insert."); process.exit(0); }

const res = await fetch(`${BASE}/glycaemic-index/bulk`, { method: "POST", headers, body: JSON.stringify({ items: fresh }) });
const out = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Bulk insert failed (${res.status}):`, JSON.stringify(out)); process.exit(1); }
console.log(out.message || `Inserted ${fresh.length}`);
