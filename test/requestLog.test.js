import { test } from "node:test";
import assert from "node:assert/strict";
import { routePattern, buildLogRow, summarize, handleAdminMonitoring, logRequest } from "../src/requestLog.js";

const helpers = {
  success: (data) => ({ ok: true, data }),
  err: (message, status = 400) => ({ ok: false, message, status }),
};

test("routePattern replaces ids but keeps names and FHIR operations", () => {
  assert.equal(routePattern("/foods/123"), "/foods/:id");
  assert.equal(routePattern("/log/3f2b8c1e-1111-4222-8333-444455556666"), "/log/:id");
  assert.equal(routePattern("/fhir/Condition/$diagnose"), "/fhir/Condition/$diagnose");
  assert.equal(routePattern("/foods/search"), "/foods/search");
});

test("buildLogRow keeps failures and slow calls, drops fast successes, 401, 404 and OPTIONS", () => {
  const base = { requestId: "r", method: "GET", path: "/foods/9", cache: null };
  assert.equal(buildLogRow({ ...base, status: 200, durationMs: 80 }), null);
  assert.equal(buildLogRow({ ...base, status: 401, durationMs: 5 }), null);
  assert.equal(buildLogRow({ ...base, status: 404, durationMs: 5 }), null);
  assert.equal(buildLogRow({ ...base, method: "OPTIONS", status: 500, durationMs: 5 }), null);
  assert.equal(buildLogRow({ ...base, status: 500, durationMs: 40 }).kind, "error");
  assert.equal(buildLogRow({ ...base, status: 429, durationMs: 40 }).kind, "error");
  assert.equal(buildLogRow({ ...base, status: 200, durationMs: 2300 }).kind, "slow");
  const both = buildLogRow({ ...base, status: 502, durationMs: 9000 });
  assert.equal(both.kind, "both");
  assert.equal(both.route, "/foods/:id");
  assert.equal(both.duration_ms, 9000);
});

test("logRequest writes only when REQUEST_LOG_STORE=true", () => {
  let inserted = 0;
  const db = { insert: () => { inserted++; return Promise.resolve({}); } };
  const info = { requestId: "r", method: "GET", path: "/foods", status: 500, durationMs: 10 };
  logRequest({}, null, db, info);
  assert.equal(inserted, 0);
  logRequest({ REQUEST_LOG_STORE: "true" }, null, db, info);
  assert.equal(inserted, 1);
});

const rows = [
  { at: "2026-10-14T10:00:00Z", request_id: "a", method: "GET", route: "/foods", status: 500, duration_ms: 300, kind: "error" },
  { at: "2026-10-14T11:00:00Z", request_id: "b", method: "GET", route: "/foods", status: 502, duration_ms: 4000, kind: "both" },
  { at: "2026-10-14T09:00:00Z", request_id: "c", method: "POST", route: "/rag/ask", status: 200, duration_ms: 2500, kind: "slow" },
];

test("summarize groups failing and slow endpoints", () => {
  const s = summarize(rows);
  assert.equal(s.totals.failed, 2);
  assert.equal(s.totals.slow, 2);
  assert.deepEqual(s.totals.by_status, { 500: 1, 502: 1 });
  assert.equal(s.failing_endpoints[0].route, "/foods");
  assert.equal(s.failing_endpoints[0].count, 2);
  assert.equal(s.slow_endpoints[0].route, "/foods");
  assert.equal(s.slow_endpoints[0].max_ms, 4000);
  assert.equal(s.slow_endpoints[1].avg_ms, 2500);
});

test("monitoring endpoint returns the summary, and a hint when the table is missing", async () => {
  const okDb = { select: async () => ({ ok: true, body: rows, total: 3 }) };
  const res = await handleAdminMonitoring(new Request("https://x/admin/monitoring?hours=48"), okDb, { REQUEST_LOG_STORE: "true" }, helpers);
  assert.equal(res.data.window_hours, 48);
  assert.equal(res.data.available, true);
  assert.equal(res.data.recent.length, 3);
  const badDb = { select: async () => ({ ok: false, status: 404, body: null }) };
  const res2 = await handleAdminMonitoring(new Request("https://x/admin/monitoring"), badDb, {}, helpers);
  assert.equal(res2.data.available, false);
  assert.equal(res2.data.storage_enabled, false);
  const post = await handleAdminMonitoring(new Request("https://x/admin/monitoring", { method: "POST" }), okDb, {}, helpers);
  assert.equal(post.status, 405);
});
