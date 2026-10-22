// Route usage + GET /admin/usage (root admin key only): which endpoints get called most.
// Every counted request bumps one row in route_usage (per UTC day, method and normalised route) through the
// bump_route_usage() Postgres function, fire-and-forget via ctx.waitUntil, so it never slows or fails a response.
// Skipped: OPTIONS, "/", "/health" (uptime pings would drown real use) and "/admin/*" (the monitor polling itself).
// Storage is off unless ROUTE_USAGE_STORE=true (run sql/032 first). Counts only - no keys, IPs, queries or bodies.
// sql/036 adds latency buckets to the same row, which GET /admin/usage turns into an estimated p95 per route and overall.

import { routePattern, isFailure } from "./requestLog.js";

const MAX_DAYS = 30;
const ROW_CAP = 5000;

// Latency histogram: bucket i holds requests that took more than BUCKET_FLOORS[i] ms and up to BUCKET_CEILS[i] ms
// (the last bucket has no upper bound). Column names match sql/036.
export const BUCKET_COLUMNS = ["ms_le_50", "ms_le_100", "ms_le_250", "ms_le_500", "ms_le_1000", "ms_le_2500", "ms_le_5000", "ms_gt_5000"];
const BUCKET_FLOORS = [0, 50, 100, 250, 500, 1000, 2500, 5000];
const BUCKET_CEILS = [50, 100, 250, 500, 1000, 2500, 5000, null];

/**
 * Estimates the 95th percentile from bucket counts (same order as BUCKET_COLUMNS), interpolating inside the bucket
 * that holds the 95th-percentile request. Returns { p95_ms, over_cap } or null when there are no bucketed requests.
 * The estimate is only as fine as the buckets; over_cap means it is in the open-ended top bucket, so p95_ms is a floor.
 */
export function estimateP95(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = total * 0.95;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    if (seen + counts[i] >= rank) {
      if (BUCKET_CEILS[i] == null) return { p95_ms: BUCKET_FLOORS[i], over_cap: true };
      const frac = (rank - seen) / counts[i];
      return { p95_ms: Math.round(BUCKET_FLOORS[i] + frac * (BUCKET_CEILS[i] - BUCKET_FLOORS[i])), over_cap: false };
    }
    seen += counts[i];
  }
  return { p95_ms: BUCKET_FLOORS[BUCKET_FLOORS.length - 1], over_cap: true };
}

function addBuckets(into, r) {
  for (let i = 0; i < BUCKET_COLUMNS.length; i++) into[i] += Number(r[BUCKET_COLUMNS[i]]) || 0;
}

export function shouldCount(method, path) {
  if (method === "OPTIONS") return false;
  if (path === "/" || path === "/health") return false;
  if (path === "/admin" || path.startsWith("/admin/")) return false;
  return true;
}

export function recordUsage(env, ctx, db, { method, path, status, durationMs }) {
  if (env.ROUTE_USAGE_STORE !== "true" || !db) return;
  if (!shouldCount(method, path)) return;
  const write = db
    .rpc("bump_route_usage", {
      p_method: method,
      p_route: routePattern(path),
      p_error: isFailure(status),
      p_ms: Math.round(durationMs),
    })
    .catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write);
}

function utcDay(d) {
  return d.toISOString().slice(0, 10);
}

/** Oldest-first list of the last `days` UTC days ending today. */
export function dayRange(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(new Date(now.getTime() - i * 86400000)));
  return out;
}

function p95Fields(buckets) {
  const e = estimateP95(buckets);
  return { p95_ms: e ? e.p95_ms : null, p95_over_cap: e ? e.over_cap : false };
}

export function summarizeUsage(rows, days, now = new Date()) {
  const routes = new Map();
  const perDay = new Map();
  let calls = 0;
  let errors = 0;
  const allBuckets = BUCKET_COLUMNS.map(() => 0);
  for (const r of rows) {
    const c = Number(r.calls) || 0;
    const e = Number(r.errors) || 0;
    calls += c;
    errors += e;
    perDay.set(r.day, (perDay.get(r.day) || 0) + c);
    const key = `${r.method} ${r.route}`;
    const x = routes.get(key) || { method: r.method, route: r.route, calls: 0, errors: 0, total_ms: 0, last_day: r.day, buckets: BUCKET_COLUMNS.map(() => 0) };
    addBuckets(x.buckets, r);
    addBuckets(allBuckets, r);
    x.calls += c;
    x.errors += e;
    x.total_ms += Number(r.total_ms) || 0;
    if (String(r.day) > String(x.last_day)) x.last_day = r.day;
    routes.set(key, x);
  }
  const top = [...routes.values()]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 25)
    .map(({ total_ms, buckets, ...x }) => ({
      ...x,
      avg_ms: x.calls ? Math.round(total_ms / x.calls) : 0,
      p95_ms: estimateP95(buckets)?.p95_ms ?? null,
      error_rate: x.calls ? Math.round((x.errors / x.calls) * 1000) / 10 : 0,
      share: calls ? Math.round((x.calls / calls) * 1000) / 10 : 0,
    }));
  return {
    totals: { calls, errors, routes: routes.size, ...p95Fields(allBuckets) },
    daily: dayRange(days, now).map((day) => ({ day, count: perDay.get(day) || 0 })),
    top,
  };
}

export async function handleAdminUsage(request, db, env, { success, err }) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  const url = new URL(request.url);
  const n = parseInt(url.searchParams.get("days") || "", 10);
  const days = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_DAYS) : 7;
  const now = new Date();
  const since = dayRange(days, now)[0];

  // Ask for the latency buckets (sql/036); if those columns are not there yet, fall back so the endpoint keeps working.
  const query = (select) => db.select("route_usage", { filters: { day: `gte.${since}` }, select, order: "day.desc", limit: ROW_CAP });
  let res = null;
  try { res = await query(`day,method,route,calls,errors,total_ms,${BUCKET_COLUMNS.join(",")}`); } catch (_) { /* retried below */ }
  if (!res || !res.ok || !Array.isArray(res.body)) {
    try { res = await query("day,method,route,calls,errors,total_ms"); } catch (_) { /* reported below */ }
  }

  const base = { generated_at: now.toISOString(), window_days: days, storage_enabled: env?.ROUTE_USAGE_STORE === "true" };
  if (!res || !res.ok || !Array.isArray(res.body)) {
    return success({
      ...base, available: false,
      note: "route_usage is not readable. Run sql/032_add_route_usage.sql in Supabase.",
      totals: { calls: 0, errors: 0, routes: 0, p95_ms: null, p95_over_cap: false }, daily: dayRange(days, now).map((day) => ({ day, count: 0 })), top: [],
    });
  }
  return success({ ...base, available: true, truncated: res.body.length >= ROW_CAP, ...summarizeUsage(res.body, days, now) });
}
