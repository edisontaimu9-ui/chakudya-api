import { test } from "node:test";
import assert from "node:assert/strict";
import { trackedFetch, recordUpstreamFailure, flushUpstreamFailures, isFatSecretError } from "../src/upstreamFailures.js";

const ENV = { UPSTREAM_FAILURES_STORE: "true", SUPABASE_URL: "https://x.supabase.co/", SUPABASE_KEY: " k " };

function stubBumps(t) {
  const bumps = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bumps.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true }; };
  t.after(() => { globalThis.fetch = real; });
  return bumps;
}

test("a non-2xx reply bumps the service and is returned unchanged", async (t) => {
  const bumps = stubBumps(t);
  const reply = { ok: false, status: 429 };
  const res = await trackedFetch(ENV, "groq", "https://api.groq.com/x", {}, async () => reply);
  await flushUpstreamFailures();
  assert.equal(res, reply);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].url, "https://x.supabase.co/rest/v1/rpc/bump_upstream_failure");
  assert.deepEqual(bumps[0].body, { p_service: "groq" });
  assert.equal(bumps[0].headers.apikey, "k");
});

test("a thrown error (timeout, network) bumps the service and rethrows", async (t) => {
  const bumps = stubBumps(t);
  const boom = new Error("Timed out");
  await assert.rejects(trackedFetch(ENV, "usda", "u", {}, async () => { throw boom; }), (e) => e === boom);
  await flushUpstreamFailures();
  assert.deepEqual(bumps.map((b) => b.body), [{ p_service: "usda" }]);
});

test("a 2xx reply bumps nothing", async (t) => {
  const bumps = stubBumps(t);
  await trackedFetch(ENV, "cohere", "u", {}, async () => ({ ok: true, status: 200 }));
  await flushUpstreamFailures();
  assert.equal(bumps.length, 0);
});

test("off unless UPSTREAM_FAILURES_STORE=true, and ignores unknown services", async (t) => {
  const bumps = stubBumps(t);
  recordUpstreamFailure({ ...ENV, UPSTREAM_FAILURES_STORE: "false" }, "groq");
  recordUpstreamFailure({ UPSTREAM_FAILURES_STORE: "true" }, "groq");
  recordUpstreamFailure(ENV, "openfoodfacts");
  await flushUpstreamFailures();
  assert.equal(bumps.length, 0);
});

test("a failing counter write never breaks the call", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("db down"); };
  t.after(() => { globalThis.fetch = real; });
  const res = await trackedFetch(ENV, "fatsecret", "u", {}, async () => ({ ok: false, status: 500 }));
  await flushUpstreamFailures();
  assert.equal(res.status, 500);
});

test("isFatSecretError ignores 211 (no food for barcode) and clean bodies", () => {
  assert.equal(isFatSecretError({ error: { code: 211, message: "No food item detected" } }), false);
  assert.equal(isFatSecretError({ error: { code: "21", message: "Invalid IP" } }), true);
  assert.equal(isFatSecretError({ food: {} }), false);
  assert.equal(isFatSecretError(null), false);
});
