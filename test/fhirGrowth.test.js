import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAssessQuery, assessGrowth } from "../src/growthAssess.js";
import { parseEvaluateGrowth, decideGrowthRoute } from "../src/fhir.js";
import { measurementsToAssessQuery, buildWhoGrowthBundle, INDICATOR_CODES } from "../src/fhirGrowth.js";
import { codeSystemResource, structureDefinitionResource, operationDefinitionResource } from "../src/fhirTerminology.js";

const BASE = "https://example.test";
const load = (f) => JSON.parse(readFileSync(new URL(`../scripts/${f}`, import.meta.url))).items;
const tables = {
  who_length_height_for_age: [...load("length_height_for_age_seed.json"), ...load("height_for_age_5_19_seed.json")],
  who_weight_for_age: load("weight_for_age_seed.json"),
  who_weight_for_length_height: [1, 2, 3, 4, 5].flatMap((n) => load(`weight_for_length_height_seed_${n}.json`)),
  who_bmi_for_age_under_5: load("bmi_for_age_under5_seed.json"),
  bmi_for_age: load("bmi_for_age_seed.json"),
  who_hc_for_age: load("hc_for_age_seed.json"),
  who_muac_for_age: [...load("muac_for_age_seed.json"), ...load("muac_for_age_seed_36_60.json")],
};
const fetchRows = async (table, filters, limit) =>
  (tables[table] || []).filter((r) => Object.entries(filters).every(([k, v]) => {
    const want = String(v).replace(/^eq\./, "");
    return typeof r[k] === "number" ? Number(want) === r[k] : String(r[k]) === want;
  })).slice(0, limit);

const q = (name, v) => ({ name, valueQuantity: v });
const part = (type, value, unit) => ({ name: "measurement", part: [{ name: "type", valueCode: type }, { name: "value", valueQuantity: { value, unit, code: unit } }] });
const params = (extra) => ({ resourceType: "Parameters", parameter: [{ name: "sex", valueCode: "female" }, { name: "birthDate", valueDate: "2025-10-11" }, { name: "effectiveDateTime", valueString: "2026-10-11T08:00:00Z" }, ...extra] });

async function run(extra) {
  const parsed = parseEvaluateGrowth(params(extra));
  assert.ok(!parsed.error, parsed.error);
  const route = decideGrowthRoute(parsed);
  assert.ok(!route.error, route.error);
  const mapped = measurementsToAssessQuery({ sex: parsed.sex, ageMonths: route.ageMonths, measurements: parsed.measurements, measured: parsed.measured, muacScheme: parsed.muacScheme });
  assert.ok(!mapped.error, mapped.error);
  const result = await assessGrowth(parseAssessQuery(mapped.query), fetchRows);
  return { route, bundle: buildWhoGrowthBundle(BASE, route.ageMonths, result, parsed.effectiveDateTime) };
}

test("a 12-month girl routes to who-growth and gets one Observation per indicator plus acute signals", async () => {
  const { route, bundle } = await run([part("weight", 6, "kg"), part("length", 74, "cm"), part("hc", 42, "cm"), part("muac", 11, "cm")]);
  assert.equal(route.route, "who-growth");
  assert.equal(route.ageMonths, 12);
  assert.equal(bundle.resourceType, "Bundle");
  const obs = bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === "Observation");
  const byInd = Object.fromEntries(obs.map((o) => [o.component.find((c) => c.code.coding[0].code === "indicator")?.valueCodeableConcept.coding[0].code ?? o.code.coding[0].code, o]));
  assert.deepEqual(Object.keys(byInd).sort(), [...INDICATOR_CODES].sort());
  const status = (o) => o.component.find((c) => c.code.coding[0].code === "status").valueCodeableConcept.coding[0].code;
  const z = (o) => o.component.find((c) => c.code.coding[0].code === "z-score").valueQuantity.value;
  assert.equal(status(byInd["weight-for-age"]), "severely underweight");
  assert.equal(z(byInd["weight-for-age"]), -3.36);
  assert.equal(status(byInd["weight-for-length-height"]), "severe wasting");
  assert.equal(status(byInd["muac-fixed-cutoffs"]), "severe");
  assert.equal(byInd["weight-for-age"].interpretation[0].coding[0].code, "LL");
  assert.equal(status(byInd["acute-malnutrition-signals"]), "severe");
  assert.equal(byInd["weight-for-age"].valueQuantity.value, 6);
  assert.equal(byInd["muac-for-age"].code.coding[0].code, "56072-2");
});

test("birth to 5 years is no longer an OperationOutcome gap; a lone BMI above 5 keeps the original route", () => {
  for (const [birth, want] of [["2026-09-01", "who-growth"], ["2016-01-01", "who-growth"]]) {
    const p = parseEvaluateGrowth({ ...params([part("weight", 9, "kg")]), parameter: params([part("weight", 9, "kg")]).parameter.map((x) => x.name === "birthDate" ? { name: "birthDate", valueDate: birth } : x) });
    assert.equal(decideGrowthRoute(p).route, want);
  }
  const lone = parseEvaluateGrowth(params([part("bmi", 17, "kg/m2")]).parameter ? { ...params([part("bmi", 17, "kg/m2")]), parameter: params([part("bmi", 17, "kg/m2")]).parameter.map((x) => x.name === "birthDate" ? { name: "birthDate", valueDate: "2016-01-01" } : x) } : null);
  assert.equal(decideGrowthRoute(lone).route, "bmi-for-age");
  const tooOld = parseEvaluateGrowth({ ...params([part("weight", 60, "kg")]), parameter: params([part("weight", 60, "kg")]).parameter.map((x) => x.name === "birthDate" ? { name: "birthDate", valueDate: "2000-01-01" } : x) });
  assert.ok(decideGrowthRoute(tooOld).error);
});

test("unit handling: g and mm are converted, unknown units are rejected, duplicates refused", () => {
  const ok = measurementsToAssessQuery({ sex: "male", ageMonths: 20, measurements: [{ type: "weight", value: { value: 9500, unit: "g", code: "g" } }, { type: "muac", value: { value: 135, unit: "mm", code: "mm" } }, { type: "length", value: { value: 0.82, unit: "m", code: "m" } }] });
  assert.equal(ok.query.get("weight_kg"), "9.5");
  assert.equal(ok.query.get("muac_mm"), "135");
  assert.equal(ok.query.get("length_cm"), "82");
  assert.equal(ok.query.get("sex"), "boys");
  assert.ok(measurementsToAssessQuery({ sex: "male", ageMonths: 20, measurements: [{ type: "weight", value: { value: 9, unit: "lb", code: "lb" } }] }).error);
  assert.ok(measurementsToAssessQuery({ sex: "male", ageMonths: 20, measurements: [{ type: "muac", value: { value: 13, unit: "kg", code: "kg" } }] }).error);
  assert.ok(measurementsToAssessQuery({ sex: "male", ageMonths: 20, measurements: [{ type: "hc", value: { value: 1, unit: "cm", code: "cm" } }, { type: "hc", value: { value: 1, unit: "cm", code: "cm" } }] }).error);
});

test("every code system, code and extension the growth Observations emit is defined", async () => {
  const samples = [];
  for (const [birth, meas] of [
    ["2025-10-11", [part("weight", 6, "kg"), part("length", 74, "cm"), part("hc", 42, "cm"), part("muac", 11, "cm")]],
    ["2025-10-11", [part("weight", 12.5, "kg"), part("length", 75, "cm"), part("hc", 50, "cm"), part("muac", 17.5, "cm")]],
    ["2015-10-11", [part("weight", 24, "kg"), part("length", 125, "cm")]],
    ["2007-10-11", [part("weight", 45, "kg"), part("length", 160, "cm")]],
  ]) {
    const p = params(meas); p.parameter = p.parameter.map((x) => x.name === "birthDate" ? { name: "birthDate", valueDate: birth } : x);
    const parsed = parseEvaluateGrowth(p); const route = decideGrowthRoute(parsed);
    const m = measurementsToAssessQuery({ sex: parsed.sex, ageMonths: route.ageMonths, measurements: parsed.measurements });
    samples.push(buildWhoGrowthBundle(BASE, route.ageMonths, await assessGrowth(parseAssessQuery(m.query), fetchRows), "2026-10-11"));
  }
  const missing = new Set();
  let checked = 0;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (typeof n.system === "string" && n.system.startsWith(`${BASE}/fhir/CodeSystem/`) && typeof n.code === "string") {
      checked++;
      const def = codeSystemResource(BASE, n.system.split("/").pop());
      if (!def) missing.add(n.system); else if (!def.concept.some((c) => c.code === n.code)) missing.add(`${n.code} in ${n.system}`);
    }
    if (typeof n.url === "string" && n.url.startsWith(`${BASE}/fhir/StructureDefinition/`) && !structureDefinitionResource(BASE, n.url.split("/").pop())) missing.add(n.url);
    Object.values(n).forEach(walk);
  };
  samples.forEach(walk);
  assert.deepEqual([...missing], []);
  assert.ok(checked > 40, `checked ${checked}`);
});

test("OperationDefinition documents the new parameters", () => {
  const names = operationDefinitionResource(BASE, "Observation-evaluate-growth").parameter.map((p) => p.name);
  for (const n of ["measured", "muacScheme", "measurement", "birthDate"]) assert.ok(names.includes(n), n);
});
