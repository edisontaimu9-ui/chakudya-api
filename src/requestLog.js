// Request log + GET /admin/monitoring (root admin key only): failed calls and slow endpoints.
// The Worker stores one row per failed or slow request (never successes that were fast), so this view
// answers "what is breaking and what is slow", not "what is the overall error rate".
// Rows hold method, a normalised route, status, duration and request id - no query strings, bodies, tokens or IPs.
// Storage is off unless REQUEST_LOG_STORE=true (run sql/031 first). Nothing here blocks a response.

export const DEFAULT_SLOW_MS = 1500;
const MAX_HOURS = 168;
const ROW_CAP = 2000;

/** /foods/123 -> /foods/:id, uuids and long hex ids too. Keeps FHIR operation names ($diagnose) as they are. */
export function routePattern(path) {
  return String(path || "/")
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{20,}$/i.test(seg) ? ":id" : seg))
    .join("/")
    .slice(0, 120) || "/";
}

export function isFailure(status) {
  if (status >= 500 || status === 429) return true;
  return status >= 400 && status !== 401 && status !== 404;
}

/** Returns a row to store, or null when the request is neither failed nor slow. */
export function buildLogRow({ requestId, method, path, status, durationMs, cache }, slowMs = DEFAULT_SLOW_MS) {
  if (method === "OPTIONS") return null;
  const failed = isFailure(status);
  const slow = durationMs >= slowMs;
  if (!failed && !slow) return null;
  return {
    request_id: requestId || null,
    method,
    route: routePattern(path),
    status,
    duration_ms: Math.round(durationMs),
    kind: failed && slow ? "both" : failed ? "error" : "slow",
    cache: cache || null,
  };
}

export function slowThreshold(env) {
  const n = parseInt(env?.REQUEST_LOG_SLOW_MS || "", 10);
  return Number.isFinite(n) && n >= 100 ? n : DEFAULT_SLOW_MS;
}

/** Fire-and-forget write from the fetch wrapper. */
export function logRequest(env, ctx, db, info) {
  if (env.REQUEST_LOG_STORE !== "true") return;
  const row = buildLogRow(info, slowThreshold(env));
  if (!row) return;
  const write = db.insert("request_log", row).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write);
}

export function summarize(rows) {
  const failing = new Map();
  const slow = new Map();
  const byStatus = {};
  let failed = 0;
  let slowCount = 0;
  for (const r of rows) {
    const key = `${r.method} ${r.route}`;
    if (r.kind === "error" || r.kind === "both") {
      failed++;
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      const f = failing.get(key) || { method: r.method, route: r.route, count: 0, statuses: {}, last_at: r.at };
      f.count++;
      f.statuses[r.status] = (f.statuses[r.status] || 0) + 1;
      if (String(r.at) > String(f.last_at)) f.last_at = r.at;
      failing.set(key, f);
    }
    if (r.kind === "slow" || r.kind === "both") {
      slowCount++;
      const s = slow.get(key) || { method: r.method, route: r.route, count: 0, total_ms: 0, max_ms: 0, last_at: r.at };
      s.count++;
      s.total_ms += r.duration_ms;
      s.max_ms = Math.max(s.max_ms, r.duration_ms);
      if (String(r.at) > String(s.last_at)) s.last_at = r.at;
      slow.set(key, s);
    }
  }
  return {
    totals: { failed, slow: slowCount, by_status: byStatus },
    failing_endpoints: [...failing.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    slow_endpoints: [...slow.values()]
      .map(({ total_ms, ...s }) => ({ ...s, avg_ms: Math.round(total_ms / s.count) }))
      .sort((a, b) => b.max_ms - a.max_ms)
      .slice(0, 15),
  };
}

export async function handleAdminMonitoring(request, db, env, { success, err }) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  const url = new URL(request.url);
  const h = parseInt(url.searchParams.get("hours") || "", 10);
  const hours = Number.isFinite(h) && h >= 1 ? Math.min(h, MAX_HOURS) : 24;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  let res = null;
  try {
    res = await db.select("request_log", {
      filters: { at: `gte.${since}` },
      select: "at,request_id,method,route,status,duration_ms,kind",
      order: "at.desc",
      limit: ROW_CAP,
    });
  } catch (_) { /* reported below */ }

  if (!res || !res.ok || !Array.isArray(res.body)) {
    return success({
      generated_at: new Date().toISOString(), window_hours: hours, available: false,
      storage_enabled: env?.REQUEST_LOG_STORE === "true", slow_ms: slowThreshold(env),
      note: "request_log is not readable. Run sql/031_add_request_log.sql in Supabase.",
      totals: { failed: 0, slow: 0, by_status: {} }, failing_endpoints: [], slow_endpoints: [], recent: [],
    });
  }

  const rows = res.body;
  return success({
    generated_at: new Date().toISOString(),
    window_hours: hours,
    available: true,
    storage_enabled: env?.REQUEST_LOG_STORE === "true",
    slow_ms: slowThreshold(env),
    truncated: typeof res.total === "number" ? res.total > rows.length : rows.length >= ROW_CAP,
    ...summarize(rows),
    recent: rows.slice(0, 40),
  });
}
