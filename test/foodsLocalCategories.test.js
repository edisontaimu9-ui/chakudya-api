// GET /foods/local-categories through the Worker entry point with a mocked Supabase.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };

// 1,250 rows so the handler has to read a second page: 900 Staples, 300 Animal, 40 Baby foods, 10 with no category.
const ROWS = [
  ...Array(900).fill({ category: "Staples" }),
  ...Array(300).fill({ category: " Animal " }),
  ...Array(40).fill({ category: "Baby foods" }),
  ...Array(10).fill({ category: null }),
];
let dbOk = true;
const pages = [];

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/rest/v1/foods") {
      if (!dbOk) return json({ message: "boom" }, 500);
      const [start, end] = (init.headers?.Range || "0-49").split("-").map(Number);
      pages.push(start);
      return json(ROWS.slice(start, end + 1));
    }
    return json([]);
  };
});
after(() => { globalThis.fetch = realFetch; });

const kv = new Map();
const env = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret",
  RATE_LIMIT_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
};
const ctx = { waitUntil: () => {} };
let ip = 10;
const call = (method, path, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "CF-Connecting-IP": `10.3.${Math.floor(ip / 250)}.${ip++ % 250}` },
  }), env, ctx);

describe("GET /foods/local-categories", () => {
  test("needs an API key", async () => {
    assert.equal((await call("GET", "/foods/local-categories", null)).status, 401);
  });

  test("returns each category once with its count, sorted, across pages", async () => {
    pages.length = 0;
    const res = await call("GET", "/foods/local-categories");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, [
      { name: "Animal", count: 300 },
      { name: "Baby foods", count: 40 },
      { name: "Staples", count: 900 },
    ]);
    assert.equal(body.count, 3);
    assert.deepEqual(pages, [0, 1000]);
  });

  test("reports a database failure as 502, not an empty list", async () => {
    dbOk = false;
    const res = await call("GET", "/foods/local-categories");
    dbOk = true;
    assert.equal(res.status, 502);
  });

  test("rejects non-GET methods", async () => {
    const res = await call("POST", "/foods/local-categories");
    assert.notEqual(res.status, 200);
  });
});
