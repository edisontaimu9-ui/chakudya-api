import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCount, recordUsage, summarizeUsage, dayRange, handleAdminUsage } from "../src/routeUsage.js";

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
  assert.deepEqual(s.totals, { calls: 100, errors: 3, routes: 2 });
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
