import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminOverview } from "../src/adminOverview.js";

const helpers = {
  success: (data) => ({ ok: true, data }),
  err: (message, status = 400) => ({ ok: false, message, status }),
};

function fakeDb() {
  return {
    async select(table, { filters = {} } = {}) {
      if (table === "api_keys") {
        return { ok: true, status: 200, total: 2, body: [
          { id: 1, label: "docs", role: "consumer", last_used_at: "2026-10-14", revoked_at: null, key_hash: "x" },
          { id: 2, label: "old", role: "admin", revoked_at: "2026-10-01" },
        ] };
      }
      if (table === "foods") return { ok: true, status: 200, total: 316, body: [] };
      if (table === "packaged_foods") return { ok: true, status: 200, total: filters.status === "eq.pending" ? 4 : 9, body: [] };
      if (table === "rag_ingest_jobs") return { ok: true, status: 200, total: 1, body: [] };
      return { ok: false, status: 404, total: null, body: null };
    },
  };
}

test("overview returns counts, nulls for missing tables, and never key hashes", async () => {
  const res = await handleAdminOverview(new Request("https://x/admin/overview"), fakeDb(), {}, helpers);
  assert.equal(res.ok, true);
  const d = res.data;
  assert.equal(d.registry.find((r) => r.table === "foods").count, 316);
  assert.equal(d.registry.find((r) => r.table === "renal_foods").count, null);
  assert.equal(d.packaged_review.pending, 4);
  assert.equal(d.api_keys.total, 2);
  assert.equal(d.api_keys.active, 1);
  assert.deepEqual(d.api_keys.by_role, { consumer: 1 });
  assert.equal(JSON.stringify(d).includes("key_hash"), false);
});

test("overview rejects non-GET", async () => {
  const res = await handleAdminOverview(new Request("https://x/admin/overview", { method: "POST" }), fakeDb(), {}, helpers);
  assert.equal(res.status, 405);
});

test("overview includes a 7-day usage trend, total and per key", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const m = new Map([[`usage:1:${today}`, "4"], [`usage:1:${yest}`, "6"], [`usage:2:${today}`, "99"]]);
  const env = { RATE_LIMIT_KV: { get: async (k) => m.get(k) ?? null } };
  const res = await handleAdminOverview(new Request("https://x/admin/overview"), fakeDb(), env, helpers);
  const k = res.data.api_keys;
  assert.equal(k.usage_daily.length, 7);
  assert.equal(k.usage_daily[6].day, today);
  assert.equal(k.usage_daily[6].count, 4); // key 2 is revoked, so its calls are not counted
  assert.equal(k.usage_daily[5].count, 6);
  assert.equal(k.usage_today, 4);
  assert.equal(k.usage_last_7_days, 10);
  assert.deepEqual(k.top[0].daily, [0, 0, 0, 0, 0, 6, 4]);
  assert.equal(k.top[0].last_7_days, 10);
});

test("overview trend is seven zero days when there is no usage data", async () => {
  const res = await handleAdminOverview(new Request("https://x/admin/overview"), fakeDb(), {}, helpers);
  assert.equal(res.data.api_keys.usage_daily.length, 7);
  assert.ok(res.data.api_keys.usage_daily.every((d) => d.count === 0));
});
