import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVerdictFlip, buildAlertPayload, ALERT_STATE_KEY } from "../src/healthAlert.js";
import { runHealthProbe } from "../src/healthMonitor.js";

function fakeKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
function hook(ok = true) {
  const posts = [];
  const fn = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok }; };
  return { posts, fn };
}
const URL_ = "https://hooks.example.com/abc";
const mk = (status, at, services = {}) => ({ at, status, duration_ms: 100, services });
const good = (at) => mk("healthy", at, { supabase: { status: "ok" }, groq: { status: "ok" } });
const bad = (at, detail = "Timed out") => mk("degraded", at, { supabase: { status: "ok" }, groq: { status: "error", detail } });
const state = (kv) => JSON.parse(kv.m.get(ALERT_STATE_KEY));

test("does nothing without a webhook URL, without KV, or with a non-https URL", async () => {
  const h = hook();
  assert.deepEqual(await checkVerdictFlip({ RATE_LIMIT_KV: fakeKv() }, good("t"), h.fn), { skipped: true });
  assert.deepEqual(await checkVerdictFlip({ ALERT_WEBHOOK_URL: URL_ }, good("t"), h.fn), { skipped: true });
  const r = await checkVerdictFlip({ ALERT_WEBHOOK_URL: "http://x.test/h", RATE_LIMIT_KV: fakeKv() }, good("t"), h.fn);
  assert.equal(r.skipped, true);
  assert.equal(h.posts.length, 0);
});

test("the first probe only records the starting verdict, even if it is degraded", async () => {
  const kv = fakeKv(); const h = hook();
  const env = { ALERT_WEBHOOK_URL: URL_, RATE_LIMIT_KV: kv };
  const r = await checkVerdictFlip(env, bad("2026-10-22T10:00:00.000Z"), h.fn);
  assert.equal(r.started, "degraded");
  assert.equal(h.posts.length, 0);
  assert.equal(state(kv).status, "degraded");
});

test("a flip alerts only after two probes in a row, then a recovery alerts the same way", async () => {
  const kv = fakeKv(); const h = hook();
  const env = { ALERT_WEBHOOK_URL: URL_, RATE_LIMIT_KV: kv };
  await checkVerdictFlip(env, good("2026-10-22T10:00:00.000Z"), h.fn);

  const first = await checkVerdictFlip(env, bad("2026-10-22T10:05:00.000Z"), h.fn);
  assert.deepEqual([first.alerted, first.pending, first.needed], [null, 1, 2]);
  assert.equal(h.posts.length, 0);

  const second = await checkVerdictFlip(env, bad("2026-10-22T10:10:00.000Z"), h.fn);
  assert.equal(second.alerted, "degraded");
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].url, URL_);
  assert.equal(h.posts[0].body.event, "health.degraded");
  assert.equal(h.posts[0].body.text, h.posts[0].body.content);
  assert.match(h.posts[0].body.text, /DEGRADED: groq \(Timed out\)/);
  assert.equal(h.posts[0].body.degraded_since, "2026-10-22T10:05:00.000Z");

  // Still degraded: no repeat alert.
  await checkVerdictFlip(env, bad("2026-10-22T10:15:00.000Z"), h.fn);
  assert.equal(h.posts.length, 1);

  await checkVerdictFlip(env, good("2026-10-22T10:20:00.000Z"), h.fn);
  const rec = await checkVerdictFlip(env, good("2026-10-22T10:25:00.000Z"), h.fn);
  assert.equal(rec.alerted, "recovered");
  assert.equal(h.posts[1].body.event, "health.recovered");
  assert.match(h.posts[1].body.text, /RECOVERED after about 20 min/);
  assert.equal(state(kv).status, "healthy");
});

test("a single bad probe that clears does not alert and clears the candidate", async () => {
  const kv = fakeKv(); const h = hook();
  const env = { ALERT_WEBHOOK_URL: URL_, RATE_LIMIT_KV: kv };
  await checkVerdictFlip(env, good("2026-10-22T10:00:00.000Z"), h.fn);
  await checkVerdictFlip(env, bad("2026-10-22T10:05:00.000Z"), h.fn);
  await checkVerdictFlip(env, good("2026-10-22T10:10:00.000Z"), h.fn);
  await checkVerdictFlip(env, bad("2026-10-22T10:15:00.000Z"), h.fn);
  assert.equal(h.posts.length, 0); // the second bad probe is again the first of a new run
  assert.equal(state(kv).pending.count, 1);
});

test("ALERT_CONFIRM_CHECKS=1 alerts on the first bad probe", async () => {
  const kv = fakeKv(); const h = hook();
  const env = { ALERT_WEBHOOK_URL: URL_, RATE_LIMIT_KV: kv, ALERT_CONFIRM_CHECKS: "1" };
  await checkVerdictFlip(env, good("2026-10-22T10:00:00.000Z"), h.fn);
  const r = await checkVerdictFlip(env, bad("2026-10-22T10:05:00.000Z"), h.fn);
  assert.equal(r.alerted, "degraded");
});

test("a failed webhook keeps the old state so the next probe retries, and never throws", async () => {
  const kv = fakeKv();
  const env = { ALERT_WEBHOOK_URL: URL_, RATE_LIMIT_KV: kv, ALERT_CONFIRM_CHECKS: "1" };
  await checkVerdictFlip(env, good("2026-10-22T10:00:00.000Z"), hook().fn);
  const down = hook(false);
  const r1 = await checkVerdictFlip(env, bad("2026-10-22T10:05:00.000Z"), down.fn);
  assert.equal(r1.failed, true);
  assert.equal(state(kv).status, "healthy");
  const up = hook(true);
  const r2 = await checkVerdictFlip(env, bad("2026-10-22T10:10:00.000Z"), up.fn);
  assert.equal(r2.alerted, "degraded");
  const thrower = async () => { throw new Error("network"); };
  const r3 = await checkVerdictFlip({ ...env, RATE_LIMIT_KV: fakeKv() }, good("t"), thrower);
  assert.equal(r3.skipped, false); // first probe on a fresh KV just records state
});

test("buildAlertPayload lists failing services and carries structured fields", () => {
  const p = buildAlertPayload("degraded", bad("2026-10-22T10:10:00.000Z", "HTTP 503"), "2026-10-22T10:05:00.000Z");
  assert.deepEqual(p.failing_services, ["groq (HTTP 503)"]);
  assert.equal(p.status, "degraded");
  assert.equal(p.event, "health.degraded");
});

test("runHealthProbe alerts even when HEALTH_CHECK_STORE is off, and before the database write", async () => {
  const kv = fakeKv(); const h = hook();
  const order = [];
  const db = { insertMany: async () => { order.push("insert"); return { ok: true }; } };
  const hookFn = async (u, i) => { order.push("alert"); return h.fn(u, i); };
  const env = { ALERT_WEBHOOK_URL: URL_, RATE_LIMIT_KV: kv, ALERT_CONFIRM_CHECKS: "1" };
  const collectGood = async () => ({ degraded: false, services: { groq: { status: "ok", ms: 10 } } });
  const collectBad = async () => ({ degraded: true, services: { groq: { status: "error", ms: 5000, detail: "Timed out" } } });

  const a = await runHealthProbe(env, db, collectGood, new Date("2026-10-22T10:00:00Z"), hookFn);
  assert.equal(a.stored, 0);
  const b = await runHealthProbe(env, db, collectBad, new Date("2026-10-22T10:05:00Z"), hookFn);
  assert.equal(b.alert.alerted, "degraded");
  assert.deepEqual(order, ["alert"]); // store is off: nothing written

  order.length = 0;
  const env2 = { ...env, HEALTH_CHECK_STORE: "true" };
  await runHealthProbe(env2, db, collectGood, new Date("2026-10-22T10:10:00Z"), hookFn);
  await runHealthProbe(env2, db, collectGood, new Date("2026-10-22T10:15:00Z"), hookFn);
  // State is "degraded" from above, so the first healthy probe is a recovery: the alert goes out before its insert.
  assert.deepEqual(order, ["alert", "insert", "insert"]);
});
