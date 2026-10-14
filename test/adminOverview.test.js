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
