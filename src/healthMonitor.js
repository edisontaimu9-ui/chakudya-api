// Scheduled health probe + GET /admin/health-history (root admin key only): uptime %, per-upstream status and outages.
// A cron trigger (every 5 minutes) runs the same checks as GET /health and stores one row per run in health_checks.
// Storage is off unless HEALTH_CHECK_STORE=true (run sql/034 first). Nothing here blocks or changes a user response.
//
// If the database itself is down the insert fails, so the row is parked in KV (RATE_LIMIT_KV) and written together
// with the next probe that gets through. That keeps a Supabase outage visible in the timeline instead of a blank gap.
// Rows hold statuses, probe latency and a short error detail. No keys, IPs, queries or bodies.
// When ALERT_WEBHOOK_URL is set, each probe also checks whether the verdict flipped and posts an alert (src/healthAlert.js).

import { checkVerdictFlip } from "./healthAlert.js";

export const HEALTH_CRON = "*/5 * * * *";
export const PROBE_INTERVAL_MIN = 5;
export const REQUIRED_SERVICES = ["supabase", "cohere", "groq"];
const RETENTION_DAYS = 30;
const MAX_HOURS = 720;
const DEFAULT_HOURS = 24;
const PAGE = 1000;
const MAX_PAGES = 10;
const PENDING_KEY = "health:pending";
const PENDING_CAP = 300;
const PENDING_TTL_S = 172800;
const STALE_AFTER_MIN = 15;
const MAX_INCIDENTS = 50;

/** One storable row from a probe result: {services: {name: {status, ms?, detail?}}, degraded}. */
export function buildHealthRow(result, now = new Date(), durationMs = 0) {
  const services = {};
  for (const [name, s] of Object.entries(result?.services || {})) {
    const out = { status: String(s?.status || "unknown") };
    if (Number.isFinite(s?.ms)) out.ms = Math.round(s.ms);
    if (s?.detail) out.detail = String(s.detail).slice(0, 120);
    services[name] = out;
  }
  return {
    at: now.toISOString(),
    status: result?.degraded ? "degraded" : "healthy",
    duration_ms: Math.max(0, Math.round(durationMs)),
    services,
  };
}

async function readPending(kv) {
  if (!kv) return [];
  try {
    const raw = await kv.get(PENDING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/** Insert the row (plus anything parked earlier). On failure, park everything in KV for the next probe. */
export async function recordHealthCheck(env, db, row) {
  const kv = env?.RATE_LIMIT_KV;
  const pending = await readPending(kv);
  const batch = [...pending, row];
  let ok = false;
  try {
    const r = await db.insertMany("health_checks", batch);
    ok = !!(r && r.ok);
  } catch (_) { /* parked below */ }

  if (ok) {
    if (kv && pending.length) { try { await kv.delete(PENDING_KEY); } catch (_) { /* ignore */ } }
    return { stored: batch.length, buffered: 0 };
  }
  const keep = batch.slice(-PENDING_CAP);
  if (kv) {
    try { await kv.put(PENDING_KEY, JSON.stringify(keep), { expirationTtl: PENDING_TTL_S }); } catch (_) { /* ignore */ }
  }
  return { stored: 0, buffered: kv ? keep.length : 0 };
}

/**
 * Cron entry point. `collect(env)` must return {services, degraded} (the same checks GET /health runs).
 * Returns what happened, mostly for tests; the caller wraps it in ctx.waitUntil.
 */
export async function runHealthProbe(env, db, collect, now = new Date(), fetchImpl = fetch) {
  const storeOn = env?.HEALTH_CHECK_STORE === "true";
  const alertOn = !!env?.ALERT_WEBHOOK_URL;
  if (!storeOn && !alertOn) return { skipped: true };
  const started = Date.now();
  const result = await collect(env);
  const row = buildHealthRow(result, now, Date.now() - started);

  // Alert first: it only needs KV, so a database outage (or a slow insert) cannot hold it back.
  const alert = alertOn ? await checkVerdictFlip(env, row, fetchImpl) : null;
  if (!storeOn) return { skipped: false, row, stored: 0, buffered: 0, alert };
  const outcome = await recordHealthCheck(env, db, row);

  // Housekeeping once a day, in the 03:00 UTC run.
  if (now.getUTCHours() === 3 && now.getUTCMinutes() < PROBE_INTERVAL_MIN && db?.rpc) {
    try { await db.rpc("purge_health_checks", { p_days: RETENTION_DAYS }); } catch (_) { /* ignore */ }
  }
  return { skipped: false, row, ...outcome, ...(alert ? { alert } : {}) };
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function failingRequired(row) {
  return REQUIRED_SERVICES.filter((n) => row.services?.[n]?.status === "error");
}

/** Oldest-first rows -> incidents (runs of consecutive degraded checks), newest first. */
export function buildIncidents(asc, now = new Date()) {
  const incidents = [];
  let cur = null;
  for (const r of asc) {
    if (r.status === "degraded") {
      if (!cur) cur = { started_at: r.at, resolved_at: null, checks: 0, services: new Set(), detail: null };
      cur.checks++;
      for (const n of failingRequired(r)) {
        cur.services.add(n);
        if (!cur.detail && r.services[n].detail) cur.detail = `${n}: ${r.services[n].detail}`;
      }
    } else if (cur) {
      cur.resolved_at = r.at;
      incidents.push(cur);
      cur = null;
    }
  }
  if (cur) incidents.push(cur);
  return incidents
    .map((i) => {
      const end = i.resolved_at ? new Date(i.resolved_at) : now;
      return {
        started_at: i.started_at,
        resolved_at: i.resolved_at,
        ongoing: !i.resolved_at,
        checks: i.checks,
        duration_minutes: Math.max(0, Math.round((end - new Date(i.started_at)) / 60000)),
        failing_services: [...i.services].sort(),
        detail: i.detail,
      };
    })
    .reverse()
    .slice(0, MAX_INCIDENTS);
}

export function summarizeHealth(rows, hours = DEFAULT_HOURS, now = new Date()) {
  const seen = new Set();
  const asc = [...rows]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .filter((r) => (seen.has(r.at) ? false : (seen.add(r.at), true)));

  const total = asc.length;
  const healthy = asc.filter((r) => r.status === "healthy").length;

  const since = now.getTime() - hours * 3600 * 1000;
  const first = total ? Math.max(since, new Date(asc[0].at).getTime()) : null;
  const expected = total ? Math.floor((now.getTime() - first) / (PROBE_INTERVAL_MIN * 60000)) + 1 : 0;

  const perService = new Map();
  for (const r of asc) {
    for (const [name, s] of Object.entries(r.services || {})) {
      const x = perService.get(name) || { ok: 0, error: 0, other: 0, ms: [] };
      if (s.status === "ok") x.ok++;
      else if (s.status === "error") x.error++;
      else x.other++;
      if (Number.isFinite(s.ms) && (s.status === "ok" || s.status === "error")) x.ms.push(s.ms);
      perService.set(name, x);
    }
  }
  const services = {};
  for (const [name, x] of [...perService.entries()].sort()) {
    const ms = [...x.ms].sort((a, b) => a - b);
    services[name] = {
      checks: x.ok + x.error,
      errors: x.error,
      uptime_pct: pct(x.ok, x.ok + x.error),
      avg_ms: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      p95_ms: percentile(ms, 95),
      max_ms: ms.length ? ms[ms.length - 1] : null,
      required: REQUIRED_SERVICES.includes(name),
    };
  }

  const days = new Map();
  for (const r of asc) {
    const day = String(r.at).slice(0, 10);
    const d = days.get(day) || { day, checks: 0, healthy: 0 };
    d.checks++;
    if (r.status === "healthy") d.healthy++;
    days.set(day, d);
  }

  const latest = asc[total - 1] || null;
  const ageMin = latest ? Math.round((now.getTime() - new Date(latest.at).getTime()) / 60000) : null;

  return {
    totals: { checks: total, healthy, degraded: total - healthy },
    uptime_pct: pct(healthy, total),
    coverage_pct: expected ? Math.min(100, pct(total, expected)) : null,
    current: latest
      ? {
          at: latest.at,
          status: latest.status,
          age_minutes: ageMin,
          stale: ageMin > STALE_AFTER_MIN,
          services: Object.fromEntries(Object.entries(latest.services || {}).map(([n, s]) => [n, s.status])),
        }
      : null,
    services,
    incidents: buildIncidents(asc, now),
    daily: [...days.values()].map((d) => ({ ...d, uptime_pct: pct(d.healthy, d.checks) })),
  };
}

async function fetchRows(db, since) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await db.select("health_checks", {
      filters: { at: `gte.${since}` },
      select: "at,status,duration_ms,services",
      order: "at.desc",
      limit: PAGE,
      offset: page * PAGE,
    });
    if (!res || !res.ok || !Array.isArray(res.body)) return page === 0 ? null : { rows, truncated: true };
    rows.push(...res.body);
    if (res.body.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function handleAdminHealthHistory(request, db, env, { success, err }) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  const url = new URL(request.url);
  const h = parseInt(url.searchParams.get("hours") || "", 10);
  const hours = Number.isFinite(h) && h >= 1 ? Math.min(h, MAX_HOURS) : DEFAULT_HOURS;
  const now = new Date();
  const since = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  const base = {
    generated_at: now.toISOString(),
    window_hours: hours,
    storage_enabled: env?.HEALTH_CHECK_STORE === "true",
    probe_every_minutes: PROBE_INTERVAL_MIN,
  };

  let fetched = null;
  try { fetched = await fetchRows(db, since); } catch (_) { /* reported below */ }

  if (!fetched) {
    return success({
      ...base,
      available: false,
      note: "health_checks is not readable. Run sql/034_add_health_checks.sql in Supabase and set HEALTH_CHECK_STORE=true.",
      totals: { checks: 0, healthy: 0, degraded: 0 },
      uptime_pct: null, coverage_pct: null, current: null, services: {}, incidents: [], daily: [],
    });
  }
  return success({ ...base, available: true, truncated: fetched.truncated, ...summarizeHealth(fetched.rows, hours, now) });
}
