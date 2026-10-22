import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCount, recordUsage, summarizeUsage, dayRange, handleAdminUsage, estimateP95 } from "../src/routeUsage.js";

const helpers = {
  success: (data) => ({ ok: true, data }),
  err: (message, status = 400) => ({ ok: false, message, status }),
};

test("shouldCount skips OPTIONS, root, health and admin routes", () => {
  assert.equal(shouldCount("GET", "/foods"), true);
  assert.equal(shouldCount("OPTIONS", "/foods"), false);
  assert.equal(shouldCount("GET", "/"), false);
  assert.equal(shouldCount("GET", "/health"), false);
  assert.equal(shouldCount("GET", "/admin/overview"), false);
});

test("recordUsage bumps via rpc only when ROUTE_USAGE_STORE=true", () => {
  const calls = [];
  const db = { rpc: (fn, args) => { calls.push([fn, args]); return Promise.resolve({}); } };
  const info = { method: "GET", path: "/foods/42", status: 500, durationMs: 120.4 };
  recordUsage({}, null, db, info);
  assert.equal(calls.length, 0);
  recordUsage({ ROUTE_USAGE_STORE: "true" }, null, db, info);
  assert.deepEqual(calls[0], ["bump_route_usage", { p_method: "GET", p_route: "/foods/:id", p_error: true, p_ms: 120 }]);
  recordUsage({ ROUTE_USAGE_STORE: "true" }, null, db, { ...info, path: "/health" });
  assert.equal(calls.length, 1);
});

const now = new Date("2026-10-15T12:00:00Z");
const rows = [
  { day: "2026-10-15", method: "GET", route: "/foods", calls: 60, errors: 3, total_ms: 6000 },
  { day: "2026-10-14", method: "GET", route: "/foods", calls: 20, errors: 0, total_ms: 2000 },
  { day: "2026-10-15", method: "POST", route: "/rag/ask", calls: 20, errors: 0, total_ms: 40000 },
];

test("summarizeUsage ranks routes, fills missing days and computes shares", () => {
  assert.deepEqual(dayRange(3, now), ["2026-10-13", "2026-10-14", "2026-10-15"]);
  const s = summarizeUsage(rows, 3, now);
  assert.deepEqual(s.totals, { calls: 100, errors: 3, routes: 2, p95_ms: null, p95_over_cap: false });
  assert.equal(s.top[0].p95_ms, null); // rows from before sql/036 have no latency buckets
  assert.deepEqual(s.daily.map((d) => d.count), [0, 20, 80]);
  assert.equal(s.top[0].route, "/foods");
  assert.equal(s.top[0].calls, 80);
  assert.equal(s.top[0].share, 80);
  assert.equal(s.top[0].avg_ms, 100);
  assert.equal(s.top[0].error_rate, 3.8);
  assert.equal(s.top[1].avg_ms, 2000);
});

test("usage endpoint returns the summary, a hint when the table is missing, and 405 for POST", async () => {
  const ok = { select: async () => ({ ok: true, body: rows }) };
  const res = await handleAdminUsage(new Request("https://x/admin/usage?days=3"), ok, { ROUTE_USAGE_STORE: "true" }, helpers);
  assert.equal(res.data.available, true);
  assert.equal(res.data.window_days, 3);
  assert.equal(res.data.daily.length, 3);
  const bad = { select: async () => ({ ok: false, status: 404, body: null }) };
  const res2 = await handleAdminUsage(new Request("https://x/admin/usage"), bad, {}, helpers);
  assert.equal(res2.data.available, false);
  assert.equal(res2.data.storage_enabled, false);
  const post = await handleAdminUsage(new Request("https://x/admin/usage", { method: "POST" }), ok, {}, helpers);
  assert.equal(post.status, 405);
});

test("estimateP95 interpolates inside the bucket that holds the 95th percentile", () => {
  assert.equal(estimateP95([0, 0, 0, 0, 0, 0, 0, 0]), null);
  // 100 requests, all in the 100-250 ms bucket: rank 95 is 95% of the way through it.
  assert.deepEqual(estimateP95([0, 0, 100, 0, 0, 0, 0, 0]), { p95_ms: 243, over_cap: false });
  // 90 fast (<=50) and 10 slow (500-1000): the 95th request is halfway through the slow bucket.
  assert.deepEqual(estimateP95([90, 0, 0, 0, 10, 0, 0, 0]), { p95_ms: 750, over_cap: false });
  // 20 requests over 5 s is more than 5%, so the estimate lands in the open top bucket and is only a floor.
  assert.deepEqual(estimateP95([80, 0, 0, 0, 0, 0, 0, 20]), { p95_ms: 5000, over_cap: true });
});

test("summarizeUsage reports p95 per route and overall from the latency buckets", () => {
  const b = (over) => ({ ms_le_50: 0, ms_le_100: 0, ms_le_250: 0, ms_le_500: 0, ms_le_1000: 0, ms_le_2500: 0, ms_le_5000: 0, ms_gt_5000: 0, ...over });
  const bucketed = [
    { day: "2026-10-15", method: "GET", route: "/foods", calls: 100, errors: 0, total_ms: 5000, ...b({ ms_le_50: 100 }) },
    { day: "2026-10-14", method: "GET", route: "/foods", calls: 100, errors: 0, total_ms: 5000, ...b({ ms_le_50: 100 }) },
    { day: "2026-10-15", method: "POST", route: "/rag/ask", calls: 100, errors: 0, total_ms: 99000, ...b({ ms_le_1000: 100 }) },
  ];
  const s = summarizeUsage(bucketed, 3, now);
  const foods = s.top.find((r) => r.route === "/foods");
  const rag = s.top.find((r) => r.route === "/rag/ask");
  assert.equal(foods.p95_ms, 48);
  assert.equal(rag.p95_ms, 975);
  assert.equal(s.totals.p95_over_cap, false);
  assert.ok(s.totals.p95_ms > foods.p95_ms && s.totals.p95_ms <= rag.p95_ms);
});

test("usage endpoint falls back to the old columns when sql/036 has not been run", async () => {
  const asked = [];
  const db = { select: async (_t, q) => { asked.push(q.select); return q.select.includes("ms_le_50") ? { ok: false, status: 400, body: null } : { ok: true, body: rows }; } };
  const res = await handleAdminUsage(new Request("https://x/admin/usage?days=3"), db, { ROUTE_USAGE_STORE: "true" }, helpers);
  assert.equal(res.data.available, true);
  assert.equal(asked.length, 2);
  assert.ok(asked[0].includes("ms_gt_5000"));
  assert.equal(res.data.totals.p95_ms, null);
});
