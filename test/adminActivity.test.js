import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminActivity } from "../src/adminActivity.js";

const helpers = {
  success: (data) => ({ ok: true, data }),
  err: (message, status = 400) => ({ ok: false, message, status }),
};

function fakeDb({ keysOk = true } = {}) {
  return {
    async select(table) {
      if (table === "api_keys") {
        if (!keysOk) return { ok: false, status: 500, body: null };
        return { ok: true, status: 200, body: [
          { id: 1, label: "partner", role: "reviewer", created_at: "2026-10-10T08:00:00Z", revoked_at: "2026-10-13T09:00:00Z", key_hash: "secret" },
          { id: 2, label: "dev key", role: "consumer", created_at: "2026-10-12T08:00:00Z", revoked_at: null, owner_user_id: "u1" },
        ] };
      }
      if (table === "packaged_foods") return { ok: true, status: 200, body: [
        { id: 7, product_name: "Maize flour", brand: "Mill", barcode: "123", status: "approved", reviewed_at: "2026-10-14T07:00:00Z", reviewed_by: "a@b.mw" },
        { id: 8, product_name: "Juice", status: "rejected", reviewed_at: "2026-10-11T07:00:00Z", reviewed_by: "a@b.mw", rejection_reason: "Wrong label" },
      ] };
      return { ok: false, status: 404, body: null };
    },
  };
}

test("activity merges key and review events newest first, skips developer keys, no hashes", async () => {
  const res = await handleAdminActivity(new Request("https://x/admin/activity"), fakeDb(), helpers);
  assert.equal(res.ok, true);
  const types = res.data.events.map((e) => e.type);
  assert.deepEqual(types, ["packaged_approved", "key_revoked", "packaged_rejected", "key_created"]);
  assert.equal(res.data.events[0].actor, "a@b.mw");
  assert.equal(res.data.events[2].detail, "Wrong label");
  assert.equal(JSON.stringify(res.data).includes("secret"), false);
  assert.equal(res.data.events.some((e) => e.subject === "dev key"), false);
});

test("activity honours ?limit= and survives a failing source", async () => {
  const res = await handleAdminActivity(new Request("https://x/admin/activity?limit=2"), fakeDb({ keysOk: false }), helpers);
  assert.equal(res.data.events.length, 2);
  assert.equal(res.data.sources.api_keys, false);
  assert.equal(res.data.sources.packaged_reviews, true);
});

test("activity rejects non-GET", async () => {
  const res = await handleAdminActivity(new Request("https://x/admin/activity", { method: "POST" }), fakeDb(), helpers);
  assert.equal(res.ok, false);
  assert.equal(res.status, 405);
});
