// Route usage + GET /admin/usage (root admin key only): which endpoints get called most.
// Every counted request bumps one row in route_usage (per UTC day, method and normalised route) through the
// bump_route_usage() Postgres function, fire-and-forget via ctx.waitUntil, so it never slows or fails a response.
// Skipped: OPTIONS, "/", "/health" (uptime pings would drown real use) and "/admin/*" (the monitor polling itself).
// Storage is off unless ROUTE_USAGE_STORE=true (run sql/032 first). Counts only - no keys, IPs, queries or bodies.

import { routePattern, isFailure } from "./requestLog.js";

const MAX_DAYS = 30;
const ROW_CAP = 5000;

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

export function summarizeUsage(rows, days, now = new Date()) {
  const routes = new Map();
  const perDay = new Map();
  let calls = 0;
  let errors = 0;
  for (const r of rows) {
    const c = Number(r.calls) || 0;
    const e = Number(r.errors) || 0;
    calls += c;
    errors += e;
    perDay.set(r.day, (perDay.get(r.day) || 0) + c);
    const key = `${r.method} ${r.route}`;
    const x = routes.get(key) || { method: r.method, route: r.route, calls: 0, errors: 0, total_ms: 0, last_day: r.day };
    x.calls += c;
    x.errors += e;
    x.total_ms += Number(r.total_ms) || 0;
    if (String(r.day) > String(x.last_day)) x.last_day = r.day;
    routes.set(key, x);
  }
  const top = [...routes.values()]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 25)
    .map(({ total_ms, ...x }) => ({
      ...x,
      avg_ms: x.calls ? Math.round(total_ms / x.calls) : 0,
      error_rate: x.calls ? Math.round((x.errors / x.calls) * 1000) / 10 : 0,
      share: calls ? Math.round((x.calls / calls) * 1000) / 10 : 0,
    }));
  return {
    totals: { calls, errors, routes: routes.size },
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

  let res = null;
  try {
    res = await db.select("route_usage", {
      filters: { day: `gte.${since}` },
      select: "day,method,route,calls,errors,total_ms",
      order: "day.desc",
      limit: ROW_CAP,
    });
  } catch (_) { /* reported below */ }

  const base = { generated_at: now.toISOString(), window_days: days, storage_enabled: env?.ROUTE_USAGE_STORE === "true" };
  if (!res || !res.ok || !Array.isArray(res.body)) {
    return success({
      ...base, available: false,
      note: "route_usage is not readable. Run sql/032_add_route_usage.sql in Supabase.",
      totals: { calls: 0, errors: 0, routes: 0 }, daily: dayRange(days, now).map((day) => ({ day, count: 0 })), top: [],
    });
  }
  return success({ ...base, available: true, truncated: res.body.length >= ROW_CAP, ...summarizeUsage(res.body, days, now) });
}
