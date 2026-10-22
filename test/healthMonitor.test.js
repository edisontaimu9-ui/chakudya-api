import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHealthRow, recordHealthCheck, runHealthProbe, summarizeHealth, buildIncidents, handleAdminHealthHistory,
} from "../src/healthMonitor.js";

const helpers = {
  success: (data) => ({ ok: true, data }),
  err: (message, status = 400) => ({ ok: false, message, status }),
};

const ok = (ms = 100) => ({ status: "ok", ms });
const bad = (detail = "HTTP 500", ms = 200) => ({ status: "error", ms, detail });
const row = (at, status, services) => ({ at, status, duration_ms: 300, services });
const healthy = (at) => row(at, "healthy", { supabase: ok(), cohere: ok(), groq: ok(), open_food_facts: ok() });

function fakeKv() {
  const m = new Map();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}

test("buildHealthRow keeps status, ms and a trimmed detail, and sets the verdict", () => {
  const r = buildHealthRow(
    { degraded: true, services: { groq: { status: "error", ms: 5001.4, detail: "x".repeat(300) }, usda_fdc: { status: "configured" } } },
    new Date("2026-10-22T10:00:00Z"), 812.6
  );
  assert.equal(r.status, "degraded");
  assert.equal(r.at, "2026-10-22T10:00:00.000Z");
  assert.equal(r.duration_ms, 813);
  assert.equal(r.services.groq.ms, 5001);
  assert.equal(r.services.groq.detail.length, 120);
  assert.deepEqual(r.services.usda_fdc, { status: "configured" });
});

test("recordHealthCheck inserts one row and clears nothing when KV is empty", async () => {
  const calls = [];
  const db = { insertMany: async (t, rows) => { calls.push([t, rows]); return { ok: true }; } };
  const out = await recordHealthCheck({ RATE_LIMIT_KV: fakeKv() }, db, healthy("2026-10-22T10:00:00.000Z"));
  assert.deepEqual(out, { stored: 1, buffered: 0 });
  assert.equal(calls[0][0], "health_checks");
  assert.equal(calls[0][1].length, 1);
});

test("a failed insert is parked in KV and written with the next probe that gets through", async () => {
  const kv = fakeKv();
  const env = { RATE_LIMIT_KV: kv };
  let up = false;
  const written = [];
  const db = { insertMany: async (_t, rows) => { if (!up) return { ok: false }; written.push(...rows); return { ok: true }; } };

  const down = row("2026-10-22T10:00:00.000Z", "degraded", { supabase: bad("Timed out"), cohere: ok(), groq: ok() });
  assert.deepEqual(await recordHealthCheck(env, db, down), { stored: 0, buffered: 1 });
  assert.equal(JSON.parse(kv.m.get("health:pending")).length, 1);

  up = true;
  const back = healthy("2026-10-22T10:05:00.000Z");
  assert.deepEqual(await recordHealthCheck(env, db, back), { stored: 2, buffered: 0 });
  assert.deepEqual(written.map((r) => r.status), ["degraded", "healthy"]);
  assert.equal(kv.m.has("health:pending"), false);
});

test("a throwing database is treated like a failed insert", async () => {
  const kv = fakeKv();
  const db = { insertMany: async () => { throw new Error("boom"); } };
  const out = await recordHealthCheck({ RATE_LIMIT_KV: kv }, db, healthy("2026-10-22T10:00:00.000Z"));
  assert.deepEqual(out, { stored: 0, buffered: 1 });
});

test("runHealthProbe does nothing unless HEALTH_CHECK_STORE=true", async () => {
  let collected = 0;
  const collect = async () => { collected++; return { degraded: false, services: { supabase: ok() } }; };
  assert.deepEqual(await runHealthProbe({}, {}, collect), { skipped: true });
  assert.equal(collected, 0);
});

test("runHealthProbe collects, stores, and purges once a day at 03:00 UTC", async () => {
  const rpcs = [];
  const db = { insertMany: async () => ({ ok: true }), rpc: async (fn, args) => { rpcs.push([fn, args]); return { ok: true }; } };
  const collect = async () => ({ degraded: false, services: { supabase: ok() } });
  const env = { HEALTH_CHECK_STORE: "true" };

  const a = await runHealthProbe(env, db, collect, new Date("2026-10-22T10:00:00Z"));
  assert.equal(a.row.status, "healthy");
  assert.equal(a.stored, 1);
  assert.equal(rpcs.length, 0);

  await runHealthProbe(env, db, collect, new Date("2026-10-22T03:02:00Z"));
  assert.deepEqual(rpcs, [["purge_health_checks", { p_days: 30 }]]);
});

test("buildIncidents merges consecutive degraded checks and names required services only", () => {
  const asc = [
    healthy("2026-10-22T10:00:00.000Z"),
    row("2026-10-22T10:05:00.000Z", "degraded", { supabase: ok(), cohere: ok(), groq: bad("HTTP 401"), open_food_facts: bad("Timed out") }),
    row("2026-10-22T10:10:00.000Z", "degraded", { supabase: ok(), cohere: bad("HTTP 503"), groq: bad("HTTP 401") }),
    healthy("2026-10-22T10:15:00.000Z"),
    row("2026-10-22T10:20:00.000Z", "degraded", { supabase: bad("HTTP 500"), cohere: ok(), groq: ok() }),
  ];
  const inc = buildIncidents(asc, new Date("2026-10-22T10:30:00Z"));
  assert.equal(inc.length, 2);
  assert.equal(inc[0].ongoing, true);
  assert.equal(inc[0].duration_minutes, 10);
  assert.deepEqual(inc[0].failing_services, ["supabase"]);
  assert.equal(inc[1].resolved_at, "2026-10-22T10:15:00.000Z");
  assert.equal(inc[1].duration_minutes, 10);
  assert.equal(inc[1].checks, 2);
  assert.deepEqual(inc[1].failing_services, ["cohere", "groq"]);
  assert.equal(inc[1].detail, "groq: HTTP 401");
});

test("summarizeHealth: uptime, per-service latency, coverage, duplicates and staleness", () => {
  const now = new Date("2026-10-22T10:30:00Z");
  const rows = [
    healthy("2026-10-22T10:00:00.000Z"),
    healthy("2026-10-22T10:00:00.000Z"), // duplicate from a retried batch
    row("2026-10-22T10:05:00.000Z", "degraded", { supabase: ok(), cohere: ok(), groq: bad("HTTP 401", 900), open_food_facts: ok() }),
    healthy("2026-10-22T10:10:00.000Z"),
    healthy("2026-10-22T10:15:00.000Z"),
  ];
  const s = summarizeHealth(rows, 24, now);
  assert.deepEqual(s.totals, { checks: 4, healthy: 3, degraded: 1 });
  assert.equal(s.uptime_pct, 75);
  assert.equal(s.services.groq.errors, 1);
  assert.equal(s.services.groq.uptime_pct, 75);
  assert.equal(s.services.groq.max_ms, 900);
  assert.equal(s.services.groq.required, true);
  assert.equal(s.services.open_food_facts.required, false);
  assert.equal(s.current.status, "healthy");
  assert.equal(s.current.age_minutes, 15);
  assert.equal(s.current.stale, false);
});

test("summarizeHealth marks a probe older than 15 minutes as stale and a fresh one as not", () => {
  const rows = [healthy("2026-10-22T10:00:00.000Z")];
  assert.equal(summarizeHealth(rows, 24, new Date("2026-10-22T10:14:00Z")).current.stale, false);
  assert.equal(summarizeHealth(rows, 24, new Date("2026-10-22T10:16:00Z")).current.stale, true);
});

test("summarizeHealth with no rows returns nulls, not NaN", () => {
  const s = summarizeHealth([], 24, new Date());
  assert.equal(s.uptime_pct, null);
  assert.equal(s.coverage_pct, null);
  assert.equal(s.current, null);
  assert.deepEqual(s.incidents, []);
});

test("coverage counts missed probes since the first sample, not the whole window", () => {
  const now = new Date("2026-10-22T10:20:00Z");
  const rows = [healthy("2026-10-22T10:00:00.000Z"), healthy("2026-10-22T10:10:00.000Z")];
  const s = summarizeHealth(rows, 24, now); // expected 5 (10:00,05,10,15,20), got 2
  assert.equal(s.coverage_pct, 40);
});

test("handleAdminHealthHistory reports available:false when the table cannot be read", async () => {
  const db = { select: async () => ({ ok: false, status: 404, body: null }) };
  const out = await handleAdminHealthHistory({ method: "GET", url: "https://x/admin/health-history" }, db, {}, helpers);
  assert.equal(out.data.available, false);
  assert.match(out.data.note, /034/);
});

test("handleAdminHealthHistory pages through rows and clamps hours", async () => {
  const now = Date.now();
  const mk = (i) => healthy(new Date(now - i * 60000).toISOString());
  const pages = [Array.from({ length: 1000 }, (_, i) => mk(i)), Array.from({ length: 10 }, (_, i) => mk(1000 + i))];
  const offsets = [];
  const db = { select: async (_t, o) => { offsets.push(o.offset); return { ok: true, body: pages[o.offset / 1000] || [] }; } };
  const out = await handleAdminHealthHistory({ method: "GET", url: "https://x/admin/health-history?hours=99999" }, db, { HEALTH_CHECK_STORE: "true" }, helpers);
  assert.deepEqual(offsets, [0, 1000]);
  assert.equal(out.data.window_hours, 720);
  assert.equal(out.data.totals.checks, 1010);
  assert.equal(out.data.truncated, false);
  assert.equal(out.data.storage_enabled, true);
});

test("handleAdminHealthHistory rejects non-GET", async () => {
  const out = await handleAdminHealthHistory({ method: "POST", url: "https://x/admin/health-history" }, {}, {}, helpers);
  assert.equal(out.status, 405);
});
