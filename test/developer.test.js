import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  consumerRateLimit, validateLabel, keyPrefix, utcDay, recentDays, usageKvKey, bumpUsage, readUsage, readUsageDaily,
  verifySupabaseUser, buildConsumerKeyRow, publicKeyView, CONSUMER_FHIR_SCOPES, MAX_KEYS_PER_USER,
} from "../src/developer.js";
import { scopesForRole, scopeAllows, parseScopes } from "../src/fhirGovernance.js";

const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

describe("rate limit", () => {
  test("consumer limit is 3x the route limit", () => {
    assert.equal(consumerRateLimit(100), 300);
    assert.equal(consumerRateLimit(15), 45);
    assert.equal(consumerRateLimit(5), 15);
  });
  test("never below 1", () => assert.equal(consumerRateLimit(0), 1));
});

describe("validateLabel", () => {
  test("accepts and trims", () => assert.deepEqual(validateLabel("  My   app "), { value: "My app" }));
  test("rejects empty", () => assert.ok(validateLabel("  ").error));
  test("rejects too long", () => assert.ok(validateLabel("x".repeat(61)).error));
  test("rejects angle brackets", () => assert.ok(validateLabel("<b>x").error));
});

describe("usage counters", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  test("days", () => {
    assert.equal(utcDay(now), "2026-10-12");
    assert.deepEqual(recentDays(3, now), ["2026-10-12", "2026-10-11", "2026-10-10"]);
    assert.equal(usageKvKey(7, "2026-10-12"), "usage:7:2026-10-12");
  });
  test("bump and read", async () => {
    const env = { RATE_LIMIT_KV: kv() };
    await bumpUsage(env, 7, now); await bumpUsage(env, 7, now);
    env.RATE_LIMIT_KV.m.set("usage:7:2026-10-10", "5");
    assert.deepEqual(await readUsage(env, 7, now), { today: 2, last_7_days: 7 });
  });
  test("daily breakdown is oldest first and matches the totals", async () => {
    const env = { RATE_LIMIT_KV: kv() };
    await bumpUsage(env, 7, now); await bumpUsage(env, 7, now);
    env.RATE_LIMIT_KV.m.set("usage:7:2026-10-10", "5");
    const d = await readUsageDaily(env, 7, 7, now);
    assert.equal(d.length, 7);
    assert.equal(d[0].day, "2026-10-06");
    assert.deepEqual(d[6], { day: "2026-10-12", count: 2 });
    assert.deepEqual(d[4], { day: "2026-10-10", count: 5 });
    assert.equal(d.reduce((n, x) => n + x.count, 0), (await readUsage(env, 7, now)).last_7_days);
  });
  test("daily breakdown without KV is zeros", async () => {
    const d = await readUsageDaily({}, 1, 7, now);
    assert.equal(d.length, 7);
    assert.ok(d.every((x) => x.count === 0));
  });
  test("no KV is a no-op", async () => {
    await bumpUsage({}, 1);
    assert.deepEqual(await readUsage({}, 1), { today: 0, last_7_days: 0 });
  });
});

describe("verifySupabaseUser", () => {
  const env = { SUPABASE_URL: "https://x.supabase.co/", SUPABASE_KEY: "k" };
  const ok = (body) => async (url, init) => { ok.url = url; ok.init = init; return { ok: true, json: async () => body }; };
  test("valid confirmed user", async () => {
    const f = ok({ id: "u1", email: "A@B.com", email_confirmed_at: "2026-01-01" });
    const r = await verifySupabaseUser(env, "tok", f);
    assert.deepEqual(r, { ok: true, user: { id: "u1", email: "a@b.com", emailConfirmed: true } });
    assert.equal(ok.url, "https://x.supabase.co/auth/v1/user");
    assert.equal(ok.init.headers.Authorization, "Bearer tok");
  });
  test("unconfirmed email is reported", async () => {
    const r = await verifySupabaseUser(env, "t", ok({ id: "u", email: "a@b.com" }));
    assert.equal(r.user.emailConfirmed, false);
  });
  test("rejected token", async () => {
    const r = await verifySupabaseUser(env, "t", async () => ({ ok: false, status: 401 }));
    assert.equal(r.ok, false); assert.equal(r.status, 401);
  });
  test("anonymous users rejected", async () => {
    const r = await verifySupabaseUser(env, "t", ok({ id: "u", email: "a@b.com", is_anonymous: true }));
    assert.equal(r.ok, false);
  });
  test("unconfigured", async () => assert.equal((await verifySupabaseUser({}, "t")).status, 503));
  test("network failure", async () => assert.equal((await verifySupabaseUser(env, "t", async () => { throw new Error("x"); })).status, 503));
});

describe("rows and views", () => {
  const user = { id: "u1", email: "a@b.com" };
  test("row never holds the raw key", () => {
    const row = buildConsumerKeyRow({ keyHash: "h", label: "app", user, rawKey: "cnr_abcdef1234567890" });
    assert.equal(row.role, "consumer");
    assert.equal(row.key_prefix, "cnr_abcdef12");
    assert.equal(row.fhir_scopes, CONSUMER_FHIR_SCOPES);
    assert.ok(!JSON.stringify(row).includes("cnr_abcdef1234567890"));
  });
  test("public view hides hash and owner", () => {
    const v = publicKeyView({ id: 1, label: "a", key_hash: "h", owner_email: "x", key_prefix: "cnr_1", created_at: "t" });
    assert.deepEqual(Object.keys(v).sort(), ["created_at", "id", "key_prefix", "label", "last_used_at", "usage"]);
  });
  test("key limit", () => assert.equal(MAX_KEYS_PER_USER, 3));
});

describe("consumer FHIR scopes", () => {
  test("stored scopes parse", () => assert.deepEqual(parseScopes(CONSUMER_FHIR_SCOPES), [{ type: "*", level: "*" }]));
  test("role fallback covers clinical ops but never AuditEvent", () => {
    const s = scopesForRole("consumer");
    assert.equal(scopeAllows(s, "Condition", "write"), true);
    assert.equal(scopeAllows(s, "Observation", "read"), true);
    assert.equal(scopeAllows(s, "AuditEvent", "read"), false);
  });
});
