// GET /admin/overview (root admin key only) - one read-only snapshot for the admin monitor page.
// Counts come from Supabase (count=exact, 1 row fetched); per-key usage comes from the KV
// counters the API already keeps (approximate, last 7 UTC days, daily breakdown included). Nothing here writes.

import { readUsageDaily, recentDays } from "./developer.js";

// [label, table]
const REGISTRY_TABLES = [
  ["Foods", "foods"],
  ["Packaged foods", "packaged_foods"],
  ["Glycaemic index entries", "glycaemic_index_data"],
  ["Exchange list items", "exchange_lists"],
  ["Renal foods", "renal_foods"],
  ["Enteral formulas", "enteral_formulas"],
  ["Drug-nutrient interactions", "drug_nutrient_interactions"],
  ["Food synonyms", "food_synonyms"],
  ["NCP diagnosis terms", "ncp_diagnosis_terms"],
  ["Fenton preterm rows", "fenton_preterm_lms"],
  ["BMI-for-age rows", "bmi_for_age"],
];

async function countOf(db, table, filters = {}) {
  try {
    const r = await db.select(table, { filters, limit: 1 });
    return r.ok && typeof r.total === "number" ? r.total : null;
  } catch (_) {
    return null;
  }
}

export async function handleAdminOverview(request, db, env, { success, err }) {
  if (request.method !== "GET") return err("Method not allowed", 405);

  const registry = await Promise.all(
    REGISTRY_TABLES.map(async ([label, table]) => ({ label, table, count: await countOf(db, table) }))
  );

  const [pending, approved, rejected] = await Promise.all([
    countOf(db, "packaged_foods", { status: "eq.pending" }),
    countOf(db, "packaged_foods", { status: "eq.approved" }),
    countOf(db, "packaged_foods", { status: "eq.rejected" }),
  ]);

  const jobStatuses = ["queued", "processing", "done", "failed"];
  const jobCounts = await Promise.all(jobStatuses.map((s) => countOf(db, "rag_ingest_jobs", { status: `eq.${s}` })));
  const ingestJobs = Object.fromEntries(jobStatuses.map((s, i) => [s, jobCounts[i]]));

  // API keys: root-visible list without hashes, plus daily usage per active key (last 7 UTC days,
  // oldest first). `usage_daily` is the total across active keys; each `top` entry has `daily`
  // (7 numbers aligned with usage_daily[].day). Same 7 KV reads per key as before.
  let keys = { total: null, active: 0, by_role: {}, usage_today: 0, usage_last_7_days: 0, usage_daily: [], top: [] };
  try {
    const r = await db.select("api_keys", { filters: {}, order: "created_at.desc", limit: 200 });
    const rows = r.ok && Array.isArray(r.body) ? r.body : [];
    const active = rows.filter((k) => !k.revoked_at);
    const usages = await Promise.all(active.slice(0, 100).map(async (k) => {
      const days = await readUsageDaily(env, k.id);
      const daily = days.map((d) => d.count);
      return { k, daily, today: daily[daily.length - 1] || 0, last_7_days: daily.reduce((a, b) => a + b, 0) };
    }));
    const dayList = recentDays(7).reverse();
    const usage_daily = dayList.map((day, i) => ({ day, count: usages.reduce((n, x) => n + (x.daily[i] || 0), 0) }));
    keys = {
      total: rows.length,
      active: active.length,
      by_role: active.reduce((a, k) => ((a[k.role || "admin"] = (a[k.role || "admin"] || 0) + 1), a), {}),
      usage_today: usages.reduce((n, x) => n + x.today, 0),
      usage_last_7_days: usages.reduce((n, x) => n + x.last_7_days, 0),
      usage_daily,
      top: usages
        .sort((a, b) => b.last_7_days - a.last_7_days)
        .slice(0, 20)
        .map(({ k, daily, today, last_7_days }) => ({ id: k.id, label: k.label, role: k.role || "admin", last_used_at: k.last_used_at || null, today, last_7_days, daily })),
    };
  } catch (_) { /* leave defaults */ }

  return success({
    generated_at: new Date().toISOString(),
    registry,
    packaged_review: { pending, approved, rejected },
    rag_ingest_jobs: ingestJobs,
    api_keys: keys,
  });
}
