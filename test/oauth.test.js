import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  signJwt,
  verifyJwt,
  looksLikeJwt,
  parseClientCredentials,
  resolveScope,
  buildAccessTokenClaims,
  generateClientCredentials,
  timingSafeEqual,
  OAUTH_TOKEN_TTL_SECONDS,
} from "../src/oauth.js";

const SECRET = "a".repeat(64);
const ISS = "https://chakudya-api.example.workers.dev";
const claims = (o = {}) => buildAccessTokenClaims({ clientId: "cnr_client_1", label: "mcp", role: "admin", issuer: ISS, ...o });

describe("JWT sign/verify", () => {
  test("round-trips valid claims", async () => {
    const token = await signJwt(claims(), SECRET);
    assert.ok(looksLikeJwt(token));
    const out = await verifyJwt(token, SECRET, { issuer: ISS });
    assert.equal(out.sub, "cnr_client_1");
    assert.equal(out.role, "admin");
    assert.equal(out.exp - out.iat, OAUTH_TOKEN_TTL_SECONDS);
  });
  test("rejects wrong secret, wrong issuer, tampered payload", async () => {
    const token = await signJwt(claims(), SECRET);
    assert.equal(await verifyJwt(token, "b".repeat(64), { issuer: ISS }), null);
    assert.equal(await verifyJwt(token, SECRET, { issuer: "https://evil.example" }), null);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims(), role: "admin", sub: "x" })).toString("base64url");
    assert.equal(await verifyJwt(`${h}.${forged}.${s}`, SECRET, { issuer: ISS }), null);
  });
  test("rejects expired tokens", async () => {
    const token = await signJwt(claims({ now: 1000 }), SECRET);
    assert.equal(await verifyJwt(token, SECRET, { issuer: ISS, now: 1000 + OAUTH_TOKEN_TTL_SECONDS }), null);
    assert.ok(await verifyJwt(token, SECRET, { issuer: ISS, now: 1000 + OAUTH_TOKEN_TTL_SECONDS - 1 }));
  });
  test("rejects alg=none and unknown roles", async () => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b({ alg: "none", typ: "JWT" })}.${b(claims())}.sig`;
    assert.equal(await verifyJwt(none, SECRET, { issuer: ISS }), null);
    const badRole = await signJwt(claims({ role: "superuser" }), SECRET);
    assert.equal(await verifyJwt(badRole, SECRET, { issuer: ISS }), null);
  });
  test("non-JWT strings (API keys) are not treated as JWTs", () => {
    assert.equal(looksLikeJwt("cnr_" + "ab".repeat(32)), false);
  });
});

describe("parseClientCredentials", () => {
  test("HTTP Basic", () => {
    const h = "Basic " + Buffer.from("cid:sec").toString("base64");
    assert.deepEqual(parseClientCredentials(h, new URLSearchParams()), { clientId: "cid", clientSecret: "sec", method: "client_secret_basic" });
  });
  test("form body and JSON body", () => {
    assert.equal(parseClientCredentials(null, new URLSearchParams("client_id=a&client_secret=b")).method, "client_secret_post");
    assert.equal(parseClientCredentials(null, { client_id: "a", client_secret: "b" }).clientSecret, "b");
  });
  test("missing credentials -> null", () => {
    assert.equal(parseClientCredentials(null, new URLSearchParams("client_id=a")), null);
  });
});

describe("resolveScope", () => {
  test("defaults to client role", () => assert.deepEqual(resolveScope("admin", ""), { role: "admin" }));
  test("admin client may narrow to reviewer", () => assert.deepEqual(resolveScope("admin", "reviewer"), { role: "reviewer" }));
  test("reviewer client cannot escalate", () => assert.equal(resolveScope("reviewer", "admin").error, "invalid_scope"));
  test("unknown / multiple scopes rejected", () => {
    assert.equal(resolveScope("admin", "root").error, "invalid_scope");
    assert.equal(resolveScope("admin", "admin reviewer").error, "invalid_scope");
  });
});

describe("misc", () => {
  test("generated credentials are unique and well-formed", () => {
    const a = generateClientCredentials();
    const b = generateClientCredentials();
    assert.match(a.clientId, /^cnr_client_[0-9a-f]{16}$/);
    assert.match(a.clientSecret, /^cnr_secret_[0-9a-f]{64}$/);
    assert.notEqual(a.clientSecret, b.clientSecret);
  });
  test("timingSafeEqual", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
  });
});
