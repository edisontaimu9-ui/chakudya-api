// Links the renal nutrition targets (src/renalNutrition.js) to the existing food lists:
// exchange_lists (GET /exchange) and renal_foods (GET /renal). Used by POST /renal-nutrition/food-plan.
// Pure functions, no I/O: the route in index.js reads the two tables and passes the rows in.
//
// Reuse, not duplication: the daily targets come from computeRenalRequirements() unchanged. Nothing here re-derives protein,
// energy or sodium. This module only divides those targets by what one exchange (portion) of each food supplies.
//
// The column names of exchange_lists and renal_foods are not defined in this repo (the rest of the code reads them with
// schema-agnostic scans), so each nutrient column is detected from a list of likely names (FIELD_CANDIDATES). The result
// reports the columns it found (field_map) and the ones it could not (missing_fields), so a wrong guess is visible and the fix
// is a one-line change to FIELD_CANDIDATES.
//
// NOT from KDOQI 2020 or Krause (stated in every result): the share-of-day arithmetic, the per-group averages, the
// "high share" flag threshold (share_flag_pct, default 25), and the name matching between the two lists. KDOQI 2020 has no
// numeric potassium or phosphorus intake, so those two budgets exist only if the clinician sends a limit or asks for the older
// Krause Table 35.9 figures, and the result labels which.

import { computeRenalRequirements, SOURCE } from "./renalNutrition.js";

const NOT_ADVICE = "Planning aid built from guideline tables and the registry's food lists. It does not replace a renal dietitian or nephrologist. Portion values are only as good as the list they come from, and every plan needs individual clinical judgement.";
const METHOD_NOTE = "Share-of-day figures, group averages, the share_flag_pct threshold and the name matching between exchange_lists and renal_foods are arithmetic added by this API. They are not from KDOQI 2020 or Krause.";

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const present = (v) => v !== undefined && v !== null && v !== "";
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** Likely column names, first match wins. Edit here if the tables use other names. */
export const FIELD_CANDIDATES = {
  name: ["food_item", "food_name", "name", "item", "food"],
  group: ["exchange_type", "exchange_list", "exchange_group", "exchange", "category", "group", "list", "type"],
  portion: ["portion", "portion_size", "serving", "serving_size", "measure", "household_measure", "amount"],
  grams: ["weight_g", "portion_g", "serving_g", "grams", "amount_g"],
  kcal: ["kcal", "calories", "energy_kcal"],
  protein_g: ["protein_g", "protein"],
  sodium_mg: ["sodium_mg", "sodium", "na_mg"],
  potassium_mg: ["potassium_mg", "potassium", "k_mg"],
  phosphorus_mg: ["phosphorus_mg", "phosphorus", "phosphate_mg", "p_mg"],
};
const NUTRIENTS = ["kcal", "protein_g", "sodium_mg", "potassium_mg", "phosphorus_mg"];
const LIMITED = ["protein_g", "sodium_mg", "potassium_mg", "phosphorus_mg"];

/** "150 mg" -> 150, 12 -> 12, "" / "n/a" -> null. */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Which real column stands for each logical field, judged from the rows themselves. */
export function detectFields(rows) {
  const map = {};
  const keys = new Set();
  for (const r of rows || []) if (isObj(r)) for (const k of Object.keys(r)) keys.add(k);
  for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
    const numeric = NUTRIENTS.includes(field) || field === "grams";
    const hit = candidates.find((c) => keys.has(c) && (rows || []).some((r) => isObj(r) && (numeric ? toNumber(r[c]) !== null : present(r[c]))));
    if (hit) map[field] = hit;
  }
  return map;
}

const normName = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(/s\b/g, "");
function namesMatch(a, b) {
  const x = normName(a); const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

function readRow(row, map) {
  const out = { id: row.id ?? null, name: map.name ? String(row[map.name] ?? "") : "", group: map.group && present(row[map.group]) ? String(row[map.group]) : "ungrouped", portion: map.portion && present(row[map.portion]) ? String(row[map.portion]) : null, grams: map.grams ? toNumber(row[map.grams]) : null, nutrients: {} };
  for (const n of NUTRIENTS) out.nutrients[n] = map[n] ? toNumber(row[map[n]]) : null;
  return out;
}

const EXCLUDED = new Set(["embedding", "created_at", "updated_at", "id"]);
function compactFields(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!EXCLUDED.has(k) && present(v)) out[k] = v;
  return out;
}

/** Daily limits the foods are measured against, each with where it came from. */
export function dailyBudget(req, input) {
  const b = {}; const t = req.targets || {};
  if (t.protein?.g_per_day) b.protein_g = { min: t.protein.g_per_day.min, max: t.protein.g_per_day.max, source: `KDOQI 2020 ${t.protein.statement}` };
  if (t.energy?.kcal_per_day) b.kcal = { min: t.energy.kcal_per_day.min, max: t.energy.kcal_per_day.max, source: `KDOQI 2020 ${t.energy.statement}` };
  if (t.sodium?.mg_per_day_max) b.sodium_mg = { max: t.sodium.mg_per_day_max, source: `KDOQI 2020 ${t.sodium.statement}` };
  const legacy = Array.isArray(req.legacy_krause) ? req.legacy_krause[0] : null;
  const legacyOn = input.legacy_krause_limits === true || input.legacy_krause_limits === "true";
  const own = (key, label) => {
    const v = toNumber(input[key]);
    if (v !== null && v > 0) return { max: v, source: `clinician-set limit (${label})` };
    return null;
  };
  const k = own("potassium_mg_per_day_max", "potassium_mg_per_day_max");
  const p = own("phosphorus_mg_per_day_max", "phosphorus_mg_per_day_max");
  const old = "Krause Table 35.9 (KDOQI 2000), older than KDOQI 2020";
  if (k) b.potassium_mg = k;
  else if (legacyOn && legacy) {
    const mg = legacy.potassium_g_per_day ? legacy.potassium_g_per_day[1] * 1000 : legacy.totals_at_ibw?.potassium_mg_per_day;
    if (mg) b.potassium_mg = { max: round(mg), source: old };
  }
  if (p) b.phosphorus_mg = p;
  else if (legacyOn && legacy?.phosphorus_mg_per_day) b.phosphorus_mg = { max: legacy.phosphorus_mg_per_day[1], source: old };
  return b;
}

function mean(xs) { return xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null; }

function groupSummaries(items, budget) {
  const by = new Map();
  for (const it of items) { if (!by.has(it.group)) by.set(it.group, []); by.get(it.group).push(it); }
  const groups = [];
  for (const [group, list] of by) {
    const per_exchange = {};
    for (const n of NUTRIENTS) { const vals = list.map((i) => i.nutrients[n]).filter((v) => v !== null); per_exchange[n] = vals.length ? round(mean(vals), 1) : null; }
    const by_nutrient = {};
    for (const n of LIMITED) {
      const cap = budget[n]?.max; const per = per_exchange[n];
      if (cap && per) by_nutrient[n] = round(cap / per, 1);
    }
    let binding = null;
    for (const [n, v] of Object.entries(by_nutrient)) if (binding === null || v < by_nutrient[binding]) binding = n;
    groups.push({ group, items: list.length, per_exchange, exchanges_until_limit: binding ? { max_exchanges_per_day: by_nutrient[binding], binding_nutrient: binding, by_nutrient } : null });
  }
  return groups.sort((a, b) => a.group.localeCompare(b.group));
}

/**
 * input: the same body as /renal-nutrition/requirements (status, weight_kg, ...) plus optional
 *   exchange_type, q, limit (1-300, default 100), share_flag_pct (5-100, default 25),
 *   potassium_mg_per_day_max, phosphorus_mg_per_day_max, legacy_krause_limits.
 * exchangeRows / renalRows: rows of exchange_lists / renal_foods.
 */
export function linkRenalFoods(input, exchangeRows, renalRows) {
  const inp = isObj(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const req = computeRenalRequirements(inp);
  if (!req.ok) return req;
  const flagPct = present(inp.share_flag_pct) ? toNumber(inp.share_flag_pct) : 25;
  if (flagPct === null || flagPct < 5 || flagPct > 100) return { ok: false, error: "'share_flag_pct' must be between 5 and 100" };
  const limit = present(inp.limit) ? toNumber(inp.limit) : 100;
  if (limit === null || limit < 1 || limit > 300) return { ok: false, error: "'limit' must be between 1 and 300" };

  const exRows = (Array.isArray(exchangeRows) ? exchangeRows : []).filter(isObj);
  const rnRows = (Array.isArray(renalRows) ? renalRows : []).filter(isObj);
  const exMap = detectFields(exRows); const rnMap = detectFields(rnRows);
  const budget = dailyBudget(req.data, inp);
  const warnings = [];

  const typeFilter = present(inp.exchange_type) ? String(inp.exchange_type).trim().toLowerCase() : null;
  const q = present(inp.q) ? normName(inp.q) : null;
  let items = exRows.map((r) => ({ raw: r, ...readRow(r, exMap) }));
  if (typeFilter) items = items.filter((i) => i.group.toLowerCase() === typeFilter);
  if (q) items = items.filter((i) => normName(i.name).includes(q));

  const renalRead = rnRows.map((r) => ({ raw: r, ...readRow(r, rnMap) }));
  const out = [];
  for (const it of items) {
    // Values missing from the exchange row are taken from the matching renal_foods row, never the other way round.
    const match = it.name ? renalRead.find((r) => namesMatch(it.name, r.name)) : null;
    const nutrients = { ...it.nutrients }; const from = {};
    if (match) for (const n of NUTRIENTS) if (nutrients[n] === null && match.nutrients[n] !== null) { nutrients[n] = match.nutrients[n]; from[n] = "renal_foods"; }
    const share = {}; const flags = [];
    for (const n of LIMITED) {
      const cap = budget[n]?.max;
      if (cap && nutrients[n] !== null) {
        share[n] = round((nutrients[n] / cap) * 100, 1);
        if (share[n] >= flagPct) flags.push({ nutrient: n, pct_of_daily_limit: share[n] });
      }
    }
    out.push({ id: it.id, name: it.name, group: it.group, portion: it.portion, grams: it.grams, nutrients, filled_from_renal_foods: Object.keys(from).length ? from : undefined, pct_of_daily_limit: share, high_share: flags, renal_foods_match: match ? { id: match.id, name: match.name, fields: compactFields(match.raw) } : null });
  }
  const groups = groupSummaries(out, budget);
  const shown = out.slice(0, limit);

  if (!exRows.length) warnings.push("exchange_lists returned no rows, so there are no portions to measure against the targets.");
  if (exRows.length && !exMap.name) warnings.push(`No name column found in exchange_lists (looked for ${FIELD_CANDIDATES.name.join(", ")}).`);
  const missing_fields = {};
  for (const [label, rows, map] of [["exchange_lists", exRows, exMap], ["renal_foods", rnRows, rnMap]]) {
    if (!rows.length) continue;
    const miss = LIMITED.filter((n) => !map[n]);
    if (miss.length) missing_fields[label] = miss;
  }
  for (const n of LIMITED) {
    if (budget[n] && exRows.length && !exMap[n] && !rnMap[n]) warnings.push(`Neither list has a ${n} column, so ${n} cannot be checked against its daily limit.`);
  }
  if (!budget.potassium_mg) warnings.push("No potassium budget: KDOQI 2020 gives no intake number. Send potassium_mg_per_day_max (clinician-set) or legacy_krause_limits: true. Use POST /renal-nutrition/labs for the serum result first.");
  if (!budget.phosphorus_mg) warnings.push("No phosphorus budget: KDOQI 2020 gives no intake number. Send phosphorus_mg_per_day_max (clinician-set) or legacy_krause_limits: true.");
  if (!budget.protein_g && req.data.targets.protein?.reason) warnings.push(`No protein limit for this status: ${req.data.targets.protein.reason}`);
  if (!budget.sodium_mg && req.data.targets.sodium?.reason) warnings.push(`No sodium limit for this status: ${req.data.targets.sodium.reason}`);

  return {
    ok: true,
    data: {
      status: req.data.status, status_label: req.data.status_label, weight: req.data.weight,
      daily_budget: budget, share_flag_pct: flagPct,
      field_map: { exchange_lists: exMap, renal_foods: rnMap }, missing_fields,
      counts: { exchange_rows: exRows.length, renal_rows: rnRows.length, matched_to_renal_foods: out.filter((i) => i.renal_foods_match).length, returned: shown.length, total_after_filters: out.length },
      groups, items: shown,
      requirements_steps: req.data.steps, requirements_warnings: req.data.warnings,
      warnings, notes: [METHOD_NOTE],
      sources: [SOURCE, "exchange_lists and renal_foods (this registry)"],
      disclaimer: NOT_ADVICE,
    },
  };
}
