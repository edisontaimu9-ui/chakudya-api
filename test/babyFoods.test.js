// Baby foods are kept out of plain name searches and served from their own endpoint.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };

const FOODS = [
  { id: 1, food_name: "Banana, ripe", category: "Fruits" },
  { id: 2, food_name: "Banana bread", category: null },
  { id: 3, food_name: "Baby food (jar), banana", category: "Baby foods" },
  { id: 4, food_name: "Baby cereal, banana", category: "Baby foods" },
  { id: 5, food_name: "Nestum wheat", category: "Baby foods" },
  { id: 6, food_name: "Nsima", category: "Staples" },
];

// Evaluates the PostgREST filters the Worker sends, against FOODS.
function runQuery(u, range) {
  let rows = FOODS.slice();
  const name = u.searchParams.get("food_name");
  if (name?.startsWith("ilike.")) {
    const needle = name.slice(6).replaceAll("*", "").toLowerCase();
    rows = rows.filter((r) => r.food_name.toLowerCase().includes(needle));
  }
  const cat = u.searchParams.get("category");
  if (cat?.startsWith("eq.")) rows = rows.filter((r) => r.category === cat.slice(3));
  const or = u.searchParams.get("or");
  if (or) {
    assert.equal(or, "(category.is.null,category.neq.Baby foods)");
    rows = rows.filter((r) => r.category === null || r.category !== "Baby foods");
  }
  rows.sort((a, b) => a.food_name.localeCompare(b.food_name));
  const [s, e] = (range || "0-49").split("-").map(Number);
  return rows.slice(s, e + 1);
}

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/rest/v1/foods") return json(runQuery(u, init.headers?.Range));
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
const get = (path, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "CF-Connecting-IP": `10.4.${Math.floor(ip / 250)}.${ip++ % 250}` },
  }), env, ctx);
const names = async (res) => (await res.json()).data.map((r) => r.food_name);

describe("GET /foods?search= and baby foods", () => {
  test("a plain search leaves baby foods out, so the ordinary banana comes first", async () => {
    const res = await get("/foods?search=banan");
    assert.equal(res.status, 200);
    assert.deepEqual(await names(res), ["Banana bread", "Banana, ripe"]);
  });

  test("rows with no category are kept", async () => {
    assert.ok((await names(await get("/foods?search=banana"))).includes("Banana bread"));
  });

  test("a baby word in the query brings them back", async () => {
    const list = await names(await get("/foods?search=baby"));
    assert.deepEqual(list, ["Baby cereal, banana", "Baby food (jar), banana"]);
  });

  test("category=Baby foods and include_baby_foods=true both include them", async () => {
    assert.equal((await names(await get("/foods?category=Baby%20foods&search=banan"))).length, 2);
    assert.equal((await names(await get("/foods?search=banan&include_baby_foods=true"))).length, 4);
  });

  test("falls back to baby foods when nothing else matches", async () => {
    assert.deepEqual(await names(await get("/foods?search=nestum")), ["Nestum wheat"]);
  });

  test("a request with no search is unchanged", async () => {
    assert.equal((await names(await get("/foods"))).length, FOODS.length);
  });
});

describe("GET /foods/baby-foods", () => {
  test("needs an API key", async () => {
    assert.equal((await get("/foods/baby-foods", null)).status, 401);
  });

  test("lists only baby foods, and can search within them", async () => {
    assert.equal((await names(await get("/foods/baby-foods"))).length, 3);
    assert.deepEqual(await names(await get("/foods/baby-foods?search=banana")), ["Baby cereal, banana", "Baby food (jar), banana"]);
  });

  test("is not mistaken for a food id", async () => {
    const res = await get("/foods/baby-foods");
    assert.equal(res.status, 200);
  });
});
