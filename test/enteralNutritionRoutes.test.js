// /enteral-nutrition routes through the Worker entry point. The enteral_formulas read is faked.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
const ROWS = [
  { id: 1, formula: "Test Std 1.0", route: "Oral (Sip Feed)", kcal_per_ml: 1.0, protein_g_per_l: 40, fibre_g_per_l: null },
  { id: 2, formula: "Test Odd", route: "Tube" },
];
before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/enteral_formulas")) {
      const m = u.match(/id=eq\.([^&]+)/);
      const rows = m ? ROWS.filter((r) => String(r.id) === decodeURIComponent(m[1])) : ROWS;
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": `0-${rows.length}/${rows.length}` } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

const kv = new Map();
const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_KEY: "svc", ADMIN_API_KEY: "root-secret", RATE_LIMIT_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const ctx = { waitUntil: () => {} };
let ip = 10;
const call = (method, path, body, token = "root-secret") =>
  worker.fetch(new Request("https://api.test" + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": `10.8.${Math.floor(ip / 250)}.${ip++ % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
const read = async (res) => ({ status: res.status, body: await res.json() });
const need = { kcal_needs: 1800, fluid_needs_ml: 2000, protein_needs_g: 90 };

describe("/enteral-nutrition", () => {
  test("needs a key; method and path checks", async () => {
    assert.equal((await call("POST", "/enteral-nutrition/calculate", need, null)).status, 401);
    assert.equal((await call("GET", "/enteral-nutrition/calculate")).status, 405);
    assert.equal((await call("POST", "/enteral-nutrition/reference", {})).status, 405);
    assert.equal((await call("POST", "/enteral-nutrition/nope", {})).status, 404);
  });

  test("inline formula", async () => {
    const r = await read(await call("POST", "/enteral-nutrition/calculate", { ...need, formula: { kcal_per_ml: 1, protein_g_per_l: 40, water_ml_per_l: 840 } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.prescription.rate_ml_per_hr, 75);
    assert.equal(r.body.data.delivered_by_prescription.protein_g, 72);
  });

  test("formula_id and formula_name look up the row; body overrides it", async () => {
    const byId = await read(await call("POST", "/enteral-nutrition/calculate", { ...need, formula_id: 1 }));
    assert.equal(byId.status, 200);
    assert.ok(byId.body.data.notes.some((n) => /estimate from energy density/.test(n)));
    assert.ok(byId.body.data.notes.some((n) => /Sip Feed/.test(n)));
    assert.equal(byId.body.data.formula.water_ml_per_l, 850);
    assert.equal(byId.body.data.formula.name, "Test Std 1.0");
    assert.equal(byId.body.data.prescription.volume_ml_per_day, 1800);
    const byName = await read(await call("POST", "/enteral-nutrition/calculate", { ...need, formula_name: "test std" }));
    assert.equal(byName.status, 200);
    const over = await read(await call("POST", "/enteral-nutrition/calculate", { ...need, formula_id: 1, formula: { protein_g_per_l: 50 } }));
    assert.equal(over.body.data.formula.protein_g_per_l, 50);
  });

  test("lookup failures", async () => {
    assert.equal((await call("POST", "/enteral-nutrition/calculate", { ...need, formula_id: "nope" })).status, 404);
    assert.equal((await call("POST", "/enteral-nutrition/calculate", { ...need, formula_name: "zzz" })).status, 404);
    const odd = await read(await call("POST", "/enteral-nutrition/calculate", { ...need, formula_id: 2 }));
    assert.equal(odd.status, 422);
    assert.match(odd.body.error ?? odd.body.message ?? JSON.stringify(odd.body), /energy density/);
  });

  test("validation and reference", async () => {
    assert.equal((await call("POST", "/enteral-nutrition/calculate", { kcal_needs: 1800 })).status, 400);
    const ref = await read(await call("GET", "/enteral-nutrition/reference?section=limits"));
    assert.equal(ref.status, 200);
    assert.equal(ref.body.data.data.min_flush_ml, 30);
  });
});
