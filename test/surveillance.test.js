import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeDistrict, validateRecord, buildIndicators, ingestRecords, adultIndicatorsFromBmi, whoBand, minCell,
  wilson, binomialUpperTail, benjaminiHochberg, trendTest, twoProportionZ, weightedSlope,
  parseMonth, addMonths, monthsBetween, resolveWindow, analyseHotspots, analyseTrend, analyseAlerts,
  dataQuality, buildInsights, handleSurveillance, referenceData, DISTRICTS, INDICATORS, consolidateAcute, fmtP,
} from "../src/surveillance.js";

const NOW = new Date("2026-10-22T09:00:00Z");

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
const fetchRows = async (table, filters, limit) => {
  const rows = (tables[table] || []).filter((r) => Object.entries(filters).every(([k, v]) => {
    const want = String(v).replace(/^eq\./, "");
    return typeof r[k] === "number" ? Number(want) === r[k] : String(r[k]) === want;
  }));
  return rows.slice(0, limit);
};

const helpers = {
  success: (data, extras = {}) => ({ ok: true, ...extras, data }),
  err: (message, status = 400) => ({ ok: false, message, status }),
  notFound: (what) => ({ ok: false, message: `${what} not found`, status: 404 }),
  json: (body, status = 200) => ({ ok: false, body, status }),
  parseBody: async (req) => req._body ?? null,
};
const req = (method, body) => ({ method, _body: body });

const good = (over = {}) => ({
  submission_id: "abc12345xyz", consent_confirmed: true, observed_on: "2026-10-14", district: "Zomba", sex: "female",
  age_months: 18, setting: "community", source: "oasis", outcomes: { recent_diarrhoea: true }, ...over,
});

describe("geography", () => {
  test("28 districts in three regions", () => {
    assert.equal(DISTRICTS.length, 28);
    assert.equal(DISTRICTS.filter((d) => d.region === "Southern").length, 13);
  });
  test("normalises case, spacing, suffixes and city councils", () => {
    assert.equal(normalizeDistrict("  zomba DISTRICT ").district, "Zomba");
    assert.equal(normalizeDistrict("nkhatabay").district, "Nkhata Bay");
    assert.equal(normalizeDistrict("Nkhata-Bay").district, "Nkhata Bay");
    assert.equal(normalizeDistrict("Mzuzu City").district, "Mzimba");
    assert.equal(normalizeDistrict("Lilongwe City").region, "Central");
    assert.equal(normalizeDistrict("Atlantis"), null);
    assert.equal(normalizeDistrict(""), null);
  });
});

describe("statistics", () => {
  test("wilson interval", () => {
    const w = wilson(10, 100);
    assert.ok(Math.abs(w.low - 0.0552) < 0.002 && Math.abs(w.high - 0.1744) < 0.002);
    assert.equal(wilson(0, 0), null);
  });
  test("exact binomial upper tail matches known values", () => {
    assert.ok(Math.abs(binomialUpperTail(8, 10, 0.5) - 0.0546875) < 1e-6);
    assert.ok(Math.abs(binomialUpperTail(10, 10, 0.5) - 0.0009765625) < 1e-9);
    assert.equal(binomialUpperTail(0, 10, 0.5), 1);
    assert.ok(binomialUpperTail(3, 50, 0.1) > 0.5); // below the mean: not significant
  });
  test("Benjamini-Hochberg keeps order and is monotone", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.5]);
    assert.deepEqual(q.map((x) => Math.round(x * 1000) / 1000), [0.04, 0.053, 0.053, 0.5]);
  });
  test("trend test finds a rising proportion and ignores a flat one", () => {
    const rising = [0, 1, 2, 3, 4, 5].map((x) => ({ x, n: 100, k: 10 + x * 4 }));
    const flat = [0, 1, 2, 3, 4, 5].map((x) => ({ x, n: 100, k: 20 }));
    assert.ok(trendTest(rising).p < 0.001 && trendTest(rising).z > 0);
    assert.ok(trendTest(flat).p > 0.9);
    assert.deepEqual(trendTest([{ x: 0, n: 10, k: 0 }, { x: 1, n: 10, k: 0 }]), { z: 0, p: 1 });
  });
  test("two-proportion z and weighted slope", () => {
    assert.ok(twoProportionZ(30, 100, 10, 100).p < 0.001);
    assert.ok(twoProportionZ(10, 100, 10, 100).p > 0.4);
    const s = weightedSlope([0, 1, 2, 3].map((x) => ({ x, n: 100, pct: 10 + 2 * x })));
    assert.ok(Math.abs(s - 2) < 1e-9);
  });
  test("WHO bands apply to children under 5 only", () => {
    assert.equal(whoBand("stunting", "under5", 31), "very high");
    assert.equal(whoBand("wasting", "under5", 12), "high");
    assert.equal(whoBand("wasting", "adult", 12), null);
    assert.equal(whoBand("anaemia_suspected", "under5", 50), null);
  });
});

describe("months and windows", () => {
  test("month maths", () => {
    assert.equal(parseMonth("2026-09"), "2026-09-01");
    assert.equal(parseMonth("2026-09-30"), "2026-09-01");
    assert.equal(parseMonth("2026-02-30"), null);
    assert.equal(parseMonth("2026-13"), null);
    assert.equal(addMonths("2026-01-01", -2), "2025-11-01");
    assert.deepEqual(monthsBetween("2026-08-01", "2026-10-01"), ["2026-08-01", "2026-09-01", "2026-10-01"]);
  });
  test("resolveWindow defaults to 12 months ending this month and validates", () => {
    assert.deepEqual(resolveWindow(new URLSearchParams(""), NOW), { from: "2025-11-01", to: "2026-10-01" });
    assert.deepEqual(resolveWindow(new URLSearchParams("months=3"), NOW), { from: "2026-08-01", to: "2026-10-01" });
    assert.ok(resolveWindow(new URLSearchParams("months=99"), NOW).error);
    assert.ok(resolveWindow(new URLSearchParams("from=2026-10&to=2026-01"), NOW).error);
    assert.ok(resolveWindow(new URLSearchParams("from=nope"), NOW).error);
  });
});

describe("validateRecord", () => {
  test("accepts a good record and keeps only the month", () => {
    const v = validateRecord(good(), NOW);
    assert.ok(v.ok, v.error);
    assert.equal(v.rec.observed_month, "2026-10-01");
    assert.equal(v.rec.district, "Zomba");
    assert.equal(v.rec.region, "Southern");
    assert.equal(v.rec.population_group, "under5");
    assert.equal(v.rec.age_band, "6-23m");
    assert.equal(v.rec.sex, "female");
    assert.ok(!("observed_on" in v.rec) && !("age_months" in v.rec));
  });
  test("rejects any unknown field, so identifiers cannot slip in", () => {
    for (const field of ["name", "patient_id", "phone", "facility", "latitude", "birth_date"]) {
      const v = validateRecord(good({ [field]: "x" }), NOW);
      assert.equal(v.ok, false, field);
      assert.match(v.error, /Unknown field/);
      assert.ok(!v.error.includes('"x"'));
    }
  });
  test("needs consent, a safe submission id and a valid district", () => {
    assert.match(validateRecord(good({ consent_confirmed: false }), NOW).error, /consent_confirmed/);
    assert.match(validateRecord(good({ consent_confirmed: undefined }), NOW).error, /consent_confirmed/);
    assert.match(validateRecord(good({ submission_id: "short" }), NOW).error, /submission_id/);
    assert.match(validateRecord(good({ submission_id: "has spaces and a name" }), NOW).error, /submission_id/);
    assert.match(validateRecord(good({ district: "Narnia" }), NOW).error, /district/);
  });
  test("dates: no future, not too old, only YYYY-MM-DD", () => {
    assert.match(validateRecord(good({ observed_on: "2026-12-01" }), NOW).error, /future/);
    assert.match(validateRecord(good({ observed_on: "2020-01-01" }), NOW).error, /months ago/);
    assert.match(validateRecord(good({ observed_on: "14/10/2026" }), NOW).error, /observed_on/);
    assert.equal(validateRecord(good({ observed_on: undefined }), NOW).rec.observed_month, "2026-10-01");
  });
  test("works out the group from age and checks explicit groups against the age", () => {
    assert.equal(validateRecord(good({ age_months: 84, outcomes: { anaemia_suspected: true } }), NOW).rec.population_group, "school_age");
    assert.equal(validateRecord(good({ age_months: 150, outcomes: { anaemia_suspected: true } }), NOW).rec.population_group, "adolescent");
    assert.equal(validateRecord(good({ age_months: undefined, age_years: 30, outcomes: { anaemia_suspected: true } }), NOW).rec.population_group, "adult");
    assert.match(validateRecord(good({ population_group: "adult" }), NOW).error, /adult/);
    assert.match(validateRecord(good({ population_group: "under5", age_months: 70 }), NOW).error, /under5/);
    const plw = validateRecord(good({ population_group: "pregnant_lactating", age_months: undefined, age_years: 24, outcomes: { maternal_muac_low: "moderate" } }), NOW);
    assert.ok(plw.ok, plw.error);
    assert.equal(plw.rec.age_band, "20-34y");
    assert.match(validateRecord(good({ age_months: undefined, age_years: 15, outcomes: { anaemia_suspected: true } }), NOW).error, /population_group/);
  });
  test("age may be left out only for pregnant and breastfeeding women", () => {
    const plw = validateRecord(good({ population_group: "pregnant_lactating", age_months: undefined, outcomes: { maternal_muac_low: "moderate" } }), NOW);
    assert.ok(plw.ok, plw.error);
    assert.equal(plw.rec.age_band, "unknown");
    assert.match(validateRecord(good({ age_months: undefined }), NOW).error, /age_months/);
    assert.match(validateRecord(good({ population_group: "adult", age_months: undefined, outcomes: { anaemia_suspected: true } }), NOW).error, /age_months/);
    assert.match(validateRecord(good({ population_group: "pregnant_lactating", age_months: undefined, age_years: 60, outcomes: { maternal_muac_low: "normal" } }), NOW).error, /10 to 54/);
  });
  test("outcomes are checked against the indicator list", () => {
    assert.match(validateRecord(good({ outcomes: { sugar: "high" } }), NOW).error, /Unknown indicator/);
    assert.match(validateRecord(good({ outcomes: { adult_underweight: "mild" } }), NOW).error, /does not apply/);
    assert.match(validateRecord(good({ outcomes: { stunting: "tiny" } }), NOW).error, /must be one of/);
    assert.match(validateRecord(good({ outcomes: undefined, measurements: undefined }), NOW).error, /measurements/);
    assert.match(validateRecord(good({ measurements: { weight_kg: 9, address: "x" } }), NOW).error, /Unknown measurement/);
  });
  test("sex, setting and source are constrained", () => {
    assert.match(validateRecord(good({ sex: "banana" }), NOW).error, /sex/);
    assert.equal(validateRecord(good({ sex: undefined }), NOW).rec.sex, "unknown");
    assert.match(validateRecord(good({ setting: "home" }), NOW).error, /setting/);
    assert.match(validateRecord(good({ source: "Dr. Banda's Clinic" }), NOW).error, /source/);
  });
});

describe("buildIndicators", () => {
  const work = (over) => ({ measurements: null, outcomes: {}, group: "under5", ageMonths: 18, ageYears: 1, sexGrowth: "girls", hadAgeMonths: true, ...over });

  test("classifies a child's measurements with the WHO tables, like /growth/assess", async () => {
    // 6-month girl, 5.5 kg: underweight (z -2.34 in the growth tests)
    const r = await buildIndicators(work({ ageMonths: 6, measurements: { weight_kg: 5.5 } }), fetchRows);
    assert.ok(r.ok, r.error);
    assert.equal(r.indicators.underweight, "moderate");
  });
  test("a healthy 18-month girl is normal on every computed indicator", async () => {
    const r = await buildIndicators(work({ measurements: { weight_kg: 9.2, length_cm: 78, muac_cm: 13.5 } }), fetchRows);
    assert.ok(r.ok, r.error);
    assert.deepEqual(
      [r.indicators.stunting, r.indicators.underweight, r.indicators.wasting, r.indicators.overweight, r.indicators.muac_gam, r.indicators.acute_malnutrition],
      ["normal", "normal", "normal", "normal", "normal", "normal"],
    );
  });
  test("a wasted child with low MUAC is acute malnutrition; raw values are not in the result", async () => {
    const r = await buildIndicators(work({ measurements: { weight_kg: 7.0, length_cm: 78, muac_cm: 11.0 } }), fetchRows);
    assert.ok(r.ok, r.error);
    assert.equal(r.indicators.muac_gam, "severe");
    assert.equal(r.indicators.acute_malnutrition, "severe");
    assert.ok(!JSON.stringify(r.indicators).match(/78|11\.0|7\.0/));
  });
  test("oedema makes acute malnutrition severe even with normal measurements", async () => {
    const r = await buildIndicators(work({ measurements: { weight_kg: 9.2, length_cm: 78 }, outcomes: { bilateral_oedema: "yes" } }), fetchRows);
    assert.equal(r.indicators.acute_malnutrition, "severe");
  });
  test("the server's classification wins over a client-sent one", async () => {
    const r = await buildIndicators(work({ measurements: { weight_kg: 9.2, length_cm: 78 }, outcomes: { stunting: "severe" } }), fetchRows);
    assert.equal(r.indicators.stunting, "normal");
  });
  test("an older child gets thinness and overweight from BMI-for-age", async () => {
    const r = await buildIndicators(work({ group: "school_age", ageMonths: 96, ageYears: 8, measurements: { weight_kg: 24, height_cm: 126 } }), fetchRows);
    assert.ok(r.ok, r.error);
    assert.ok("thinness" in r.indicators && "overweight" in r.indicators && "stunting" in r.indicators);
    assert.ok(!("wasting" in r.indicators));
  });
  test("children need age in months and sex for measurements", async () => {
    assert.match((await buildIndicators(work({ measurements: { weight_kg: 9 }, sexGrowth: null }), fetchRows)).error, /sex/);
    assert.match((await buildIndicators(work({ measurements: { weight_kg: 9 }, hadAgeMonths: false }), fetchRows)).error, /age_months/);
    assert.match((await buildIndicators(work({ measurements: { weight_kg: -3 } }), fetchRows)).error, /positive/);
  });
  test("adults: BMI categories", async () => {
    assert.deepEqual(adultIndicatorsFromBmi(15.5), { adult_underweight: "severe", adult_overweight: "normal" });
    assert.deepEqual(adultIndicatorsFromBmi(17.5), { adult_underweight: "mild", adult_overweight: "normal" });
    assert.deepEqual(adultIndicatorsFromBmi(22), { adult_underweight: "normal", adult_overweight: "normal" });
    assert.deepEqual(adultIndicatorsFromBmi(31), { adult_underweight: "normal", adult_overweight: "obese" });
    const r = await buildIndicators(work({ group: "adult", ageMonths: 360, ageYears: 30, measurements: { weight_kg: 50, height_cm: 170 } }), fetchRows);
    assert.equal(r.indicators.adult_underweight, "mild");
    assert.match((await buildIndicators(work({ group: "adult", measurements: { weight_kg: 500, height_cm: 170 } }), fetchRows)).error, /plausible/);
    assert.match((await buildIndicators(work({ group: "adult", measurements: { weight_kg: 60 } }), fetchRows)).error, /height/);
  });
  test("pregnant and breastfeeding women need pre-classified outcomes", async () => {
    assert.match((await buildIndicators(work({ group: "pregnant_lactating", measurements: { muac_cm: 22 } }), fetchRows)).error, /outcomes/);
    const ok = await buildIndicators(work({ group: "pregnant_lactating", outcomes: { maternal_muac_low: "moderate" } }), fetchRows);
    assert.equal(ok.indicators.maternal_muac_low, "moderate");
  });
});

describe("ingestRecords", () => {
  const dbOk = (n) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push([fn, args]); return { ok: true, status: 200, body: n ?? args.p_records.length }; } }; };

  test("stores valid records, reports bad ones by index and never echoes their content", async () => {
    const db = dbOk();
    const out = await ingestRecords([good(), good({ submission_id: "second123456", name: "Chikondi Banda" }), good({ submission_id: "third1234567", district: "Mzuzu City" })], { db, fetchRows, now: NOW });
    assert.equal(out.stored, 2);
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0].index, 1);
    assert.ok(!JSON.stringify(out).includes("Chikondi"));
    const sent = db.calls[0][1].p_records;
    assert.equal(sent.length, 2);
    assert.equal(sent[1].district, "Mzimba");
    assert.deepEqual(sent[0].indicators.recent_diarrhoea, "yes");
    assert.ok(!JSON.stringify(sent).match(/Chikondi|2026-10-14/));
  });
  test("a repeated id inside one batch is counted once; ids the database already has are 'already received'", async () => {
    const db = dbOk(1); // database says only 1 of the 2 unique rows was new
    const out = await ingestRecords([good(), good(), good({ submission_id: "another12345" })], { db, fetchRows, now: NOW });
    assert.equal(db.calls[0][1].p_records.length, 2);
    assert.equal(out.stored, 1);
    assert.equal(out.already_received, 2);
  });
  test("nothing valid means no database call", async () => {
    const db = dbOk();
    const out = await ingestRecords([{ foo: 1 }], { db, fetchRows, now: NOW });
    assert.equal(out.stored, 0);
    assert.equal(db.calls.length, 0);
  });
  test("a missing function is reported as setup needed", async () => {
    const db = { rpc: async () => ({ ok: false, status: 404, body: { code: "PGRST202", message: "Could not find the function public.surveillance_ingest" } }) };
    const out = await ingestRecords([good()], { db, fetchRows, now: NOW });
    assert.equal(out.ok, false);
    assert.equal(out.status, 503);
    assert.match(out.error, /037/);
  });
});

/* ───── synthetic aggregate data ───── */

const row = (district, region, counts, extra = {}) => ({ month: null, district, region, population_group: "under5", indicator: "stunting", counts, ...extra });
const districtRows = () => [
  row("Mangochi", "Southern", { normal: 140, moderate: 40, severe: 20 }), // 30% of 200
  row("Zomba", "Southern", { normal: 170, moderate: 25, severe: 5 }), // 15% of 200
  row("Salima", "Central", { normal: 180, moderate: 15, severe: 5 }), // 10% of 200
  row("Dowa", "Central", { normal: 185, moderate: 10, severe: 5 }), // 7.5% of 200
  row("Karonga", "Northern", { normal: 190, moderate: 8, severe: 2 }), // 5% of 200
  row("Likoma", "Northern", { normal: 12, moderate: 1, severe: 0 }), // n=13: too few to compare
  row("Rumphi", "Northern", { normal: 5, moderate: 1, severe: 0 }), // n=6: hidden
];

describe("analyseHotspots", () => {
  const a = analyseHotspots(districtRows(), "under5", "stunting", { minN: 30, cell: 10 });
  const by = Object.fromEntries(a.districts.map((d) => [d.district, d]));
  test("national figure pools every district", () => {
    assert.equal(a.national.n, 200 * 5 + 13 + 6);
    assert.equal(a.national.cases, 60 + 30 + 20 + 15 + 10 + 1 + 1);
    assert.equal(a.districts_compared, 5);
  });
  test("flags the district well above the national figure as a hotspot with a priority", () => {
    assert.equal(by.Mangochi.classification, "hotspot");
    assert.ok(by.Mangochi.q_value <= 0.1);
    assert.equal(by.Mangochi.who_band, "very high");
    assert.equal(by.Mangochi.priority, "critical");
    assert.deepEqual(a.hotspots.map((d) => d.district), ["Mangochi"]);
  });
  test("a district close to the national rate is typical; a clearly low one is below national", () => {
    assert.equal(by.Salima.classification, "typical");
    assert.equal(by.Karonga.classification, "below_national");
  });
  test("small districts are not compared, and tiny ones are hidden entirely", () => {
    assert.equal(by.Likoma.classification, "insufficient_data");
    assert.equal(by.Rumphi.classification, "suppressed");
    assert.ok(!("n" in by.Rumphi) && !("prevalence_pct" in by.Rumphi) && !("cases" in by.Rumphi));
  });
  test("worst first", () => {
    assert.equal(a.districts[0].district, "Mangochi");
    assert.equal(a.districts.at(-1).classification, "suppressed");
  });
  test("a uniform country has no hotspots", () => {
    const flat = ["A1", "A2", "A3", "A4"].map((d) => row(d, "Central", { normal: 160, moderate: 30, severe: 10 }));
    assert.equal(analyseHotspots(flat, "under5", "stunting", {}).hotspots.length, 0);
  });
  test("risk indicators have no severe count", () => {
    const rows = [row("Zomba", "Southern", { no: 80, yes: 20 }, { indicator: "anaemia_suspected" })];
    const r = analyseHotspots(rows, "under5", "anaemia_suspected", {});
    assert.equal(r.national.prevalence_pct, 20);
    assert.ok(!("severe_cases" in r.national));
  });
});

describe("analyseTrend", () => {
  const months = monthsBetween("2026-01-01", "2026-10-01");
  const rising = months.map((m, i) => row(null, null, { normal: 100 - (8 + i * 3), moderate: 8 + i * 3 }, { month: m, district: null }));
  test("detects a steady rise, with slope and year-on-year change", () => {
    const withLastYear = [...rising, row(null, null, { normal: 95, moderate: 5 }, { month: "2025-10-01", district: null })];
    const t = analyseTrend(withLastYear, "under5", "stunting", "2026-01-01", "2026-10-01", {});
    assert.equal(t.trend.direction, "increasing");
    assert.ok(t.trend.slope_pp_per_month > 2.5 && t.trend.slope_pp_per_month < 3.5);
    assert.equal(t.series.length, 10);
    assert.equal(t.vs_same_month_last_year.same_month_last_year_pct, 5);
    assert.equal(t.vs_same_month_last_year.significant_increase, true);
  });
  test("a flat series is stable", () => {
    const flat = months.map((m) => row(null, null, { normal: 80, moderate: 20 }, { month: m, district: null }));
    assert.equal(analyseTrend(flat, "under5", "stunting", "2026-01-01", "2026-10-01", {}).trend.direction, "stable");
  });
  test("too little data is said plainly; small months are hidden", () => {
    const few = [row(null, null, { normal: 90, moderate: 10 }, { month: "2026-10-01", district: null }), row(null, null, { normal: 4, moderate: 1 }, { month: "2026-09-01", district: null })];
    const t = analyseTrend(few, "under5", "stunting", "2026-08-01", "2026-10-01", {});
    assert.equal(t.trend.direction, "insufficient_data");
    assert.equal(t.series[0].n, 0);
    assert.equal(t.series[1].suppressed, true);
    assert.ok(!("cases" in t.series[1]));
  });
});

describe("analyseAlerts", () => {
  const mk = (cases, n) => ({ normal: n - cases, moderate: cases });
  const recent = [row("Mangochi", "Southern", mk(40, 150)), row("Zomba", "Southern", mk(20, 150)), row("Salima", "Central", mk(2, 150))];
  const base = [row("Mangochi", "Southern", mk(30, 450)), row("Zomba", "Southern", mk(60, 450)), row("Salima", "Central", mk(40, 450))];
  const out = analyseAlerts(recent, base, "under5");
  test("flags a district whose recent rate is clearly above its baseline", () => {
    const m = out.alerts.find((x) => x.district === "Mangochi");
    assert.ok(m, "Mangochi alerted");
    assert.equal(m.recent.prevalence_pct, 26.7);
    assert.equal(m.baseline.prevalence_pct, 6.7);
    assert.equal(m.priority, "high");
  });
  test("does not alert on a flat or falling district", () => {
    assert.ok(!out.alerts.find((x) => x.district === "Zomba"));
    assert.ok(!out.alerts.find((x) => x.district === "Salima"));
    assert.equal(out.tested, 2); // Salima has only 2 recent cases, too few to test
  });
  test("needs enough data in both windows", () => {
    const thin = analyseAlerts([row("Mangochi", "Southern", mk(8, 12))], base, "under5");
    assert.equal(thin.tested, 0);
  });
});

describe("small counts are never shown as numbers", () => {
  test("headline counts below the minimum read '<10'", async () => {
    const db = fakeDb((fn) => fn === "surveillance_volume"
      ? okRows([{ district: "Zomba", region: "Southern", population_group: "under5", setting: "community", n: 1, months_reporting: 1 }])
      : okRows([]));
    const r = await handleSurveillance(req("GET"), new URL("https://x/surveillance/summary"), db, {}, "summary", helpers, fetchRows, NOW);
    assert.equal(r.data.data_quality.records, "<10");
    assert.deepEqual(r.data.data_quality.by_population_group, { under5: "<10" });
    assert.deepEqual(r.data.data_quality.by_setting, { community: "<10" });
    assert.deepEqual(r.data.records_by_region, { Southern: "<10" });
    assert.ok(!JSON.stringify(r.data).match(/:\s?1[,}]/), "no raw count of 1 anywhere");
  });
  test("an empty window is a real zero, not hidden", async () => {
    const db = fakeDb(() => okRows([]));
    const r = await handleSurveillance(req("GET"), new URL("https://x/surveillance/summary"), db, {}, "summary", helpers, fetchRows, NOW);
    assert.equal(r.data.data_quality.records, 0);
  });
});

describe("dataQuality", () => {
  test("coverage, gaps and facility bias", () => {
    const vol = [
      { district: "Zomba", region: "Southern", population_group: "under5", setting: "facility", n: 500, months_reporting: 12 },
      { district: "Mangochi", region: "Southern", population_group: "under5", setting: "facility", n: 300, months_reporting: 3 },
      { district: "Likoma", region: "Northern", population_group: "under5", setting: "facility", n: 4, months_reporting: 1 },
    ];
    const q = dataQuality(vol, "2025-11-01", "2026-10-01", { cell: 10 });
    assert.equal(q.records, 804);
    assert.equal(q.districts_reporting, 2);
    assert.equal(q.districts_total, 28);
    assert.ok(q.districts_without_enough_data.includes("Likoma") && q.districts_without_enough_data.includes("Dedza"));
    assert.deepEqual(q.districts_reporting_in_under_half_of_months, ["Mangochi"]);
    assert.ok(q.notes.some((n) => /health facilities/.test(n)));
  });
});

/* ───── handler and insights, with a fake database ───── */

const fakeDb = (impl) => ({ rpc: async (fn, args) => impl(fn, args) });
const okRows = (body) => ({ ok: true, status: 200, body });

// A small country: one clear hotspot (Mangochi stunting) and one district whose wasting is rising.
const REPORTING = DISTRICTS.slice(0, 22); // 8 left out of the data on purpose; includes Salima and Mangochi
function scenarioDb() {
  return fakeDb((fn, a) => {
    if (fn === "surveillance_volume") {
      return okRows(REPORTING.map((d) => ({ district: d.district, region: d.region, population_group: "under5", setting: "community", n: 300, months_reporting: 12 })));
    }
    if (fn === "surveillance_counts") {
      if (a.p_by_month) {
        const rows = monthsBetween(a.p_from, a.p_to).map((m, i) => ({ month: m, district: null, region: null, population_group: a.p_group, indicator: a.p_indicator, counts: { normal: 200 - (20 + i * 3), moderate: 20 + i * 3 } }));
        return okRows(rows);
      }
      if (a.p_group && a.p_group !== "under5") return okRows([]);
      const recentWindow = a.p_from >= "2026-08-01";
      const baseWindow = a.p_to === "2026-07-01";
      const rows = [];
      for (const d of REPORTING) {
        const stunted = d.district === "Mangochi" ? 70 : 20;
        rows.push({ month: null, district: d.district, region: d.region, population_group: "under5", indicator: "stunting", counts: { normal: 300 - stunted, moderate: stunted } });
        const n = recentWindow ? 100 : baseWindow ? 200 : 300;
        const w = d.district === "Salima" ? (recentWindow ? 30 : baseWindow ? 12 : 22) : Math.round((6 / 300) * n);
        rows.push({ month: null, district: d.district, region: d.region, population_group: "under5", indicator: "wasting", counts: { normal: n - w, moderate: w } });
      }
      if (a.p_by_district) return okRows(rows);
      // no district breakdown asked for: collapse to one national row per indicator
      const national = new Map();
      for (const r of rows) {
        const x = national.get(r.indicator) || { month: null, district: null, region: null, population_group: "under5", indicator: r.indicator, counts: {} };
        for (const [k, v] of Object.entries(r.counts)) x.counts[k] = (x.counts[k] || 0) + v;
        national.set(r.indicator, x);
      }
      return okRows([...national.values()]);
    }
    return { ok: false, status: 404, body: null };
  });
}

describe("handleSurveillance", () => {
  const url = (path) => new URL(`https://x/surveillance/${path}`);
  const call = (method, path, param, db, body, env = { SURVEILLANCE_STORE: "true" }) =>
    handleSurveillance(req(method, body), url(path), db, env, param, helpers, fetchRows, NOW);

  test("reference lists districts, indicators and the privacy rules", async () => {
    const r = await call("GET", "reference", "reference", null);
    assert.equal(r.data.districts.length, 28);
    assert.ok(r.data.indicators.stunting && r.data.privacy.accepted_fields.includes("submission_id"));
    assert.ok(!r.data.privacy.accepted_fields.includes("name"));
    assert.equal(r.data.privacy.minimum_cell_size, 10);
    assert.match(r.data.data_caveat, /not a random survey/);
  });
  test("minimum cell size comes from the environment but never below 5", () => {
    assert.equal(minCell({}), 10);
    assert.equal(minCell({ SURVEILLANCE_MIN_CELL: "20" }), 20);
    assert.equal(minCell({ SURVEILLANCE_MIN_CELL: "1" }), 5);
  });
  test("records: off unless SURVEILLANCE_STORE=true; POST only; body and batch checks", async () => {
    assert.equal((await call("POST", "records", "records", fakeDb(() => okRows(1)), good(), {})).status, 503);
    assert.equal((await call("GET", "records", "records", fakeDb(() => okRows(1)))).status, 405);
    assert.equal((await call("POST", "records", "records", fakeDb(() => okRows(1)), null)).status, 400);
    assert.equal((await call("POST", "records", "records", fakeDb(() => okRows(1)), { records: [] })).status, 400);
    assert.equal((await call("POST", "records", "records", fakeDb(() => okRows(1)), { records: new Array(101).fill(good()) })).status, 400);
    assert.equal((await call("POST", "records", "records", fakeDb(() => okRows(1)), { records: [good()], extra: 1 })).status, 400);
  });
  test("records: a single record and a batch are stored; all-bad is a 422", async () => {
    const db = fakeDb((fn, a) => okRows(a.p_records.length));
    const one = await call("POST", "records", "records", db, good());
    assert.equal(one.data.stored, 1);
    const batch = await call("POST", "records", "records", db, { records: [good(), good({ submission_id: "second123456" })] });
    assert.equal(batch.data.stored, 2);
    const bad = await call("POST", "records", "records", db, { patient: "x" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.data.rejected.length, 1);
  });
  test("hotspots for one indicator list every district; without an indicator only flagged ones", async () => {
    const one = await call("GET", "hotspots?population_group=under5&indicator=stunting", "hotspots", scenarioDb());
    assert.equal(one.data.results.length, 1);
    assert.equal(one.data.results[0].hotspots[0].district, "Mangochi");
    assert.equal(one.data.results[0].districts.length, 22);
    const all = await call("GET", "hotspots?population_group=under5", "hotspots", scenarioDb());
    assert.ok(all.data.results.length >= 2);
    assert.ok(all.data.results.every((x) => x.districts === undefined));
    assert.match(one.data.data_caveat, /not a random survey/);
  });
  test("trends need an indicator; district is validated", async () => {
    assert.equal((await call("GET", "trends", "trends", scenarioDb())).status, 400);
    assert.equal((await call("GET", "trends?indicator=stunting&district=Narnia", "trends", scenarioDb())).status, 400);
    const t = await call("GET", "trends?indicator=stunting&population_group=under5&months=10", "trends", scenarioDb());
    assert.equal(t.data.results[0].trend.direction, "increasing");
    assert.equal(t.data.results[0].series.length, 10);
  });
  test("alerts find the district whose wasting is rising", async () => {
    const a = await call("GET", "alerts?population_group=under5", "alerts", scenarioDb());
    const found = a.data.alerts.find((x) => x.district === "Salima" && x.indicator === "wasting");
    assert.ok(found, JSON.stringify(a.data.alerts.map((x) => [x.district, x.indicator])));
    assert.equal(a.data.recent, "2026-08 to 2026-10");
    assert.equal(a.data.baseline, "2025-11 to 2026-07");
  });
  test("summary reports volume, coverage and national prevalence", async () => {
    const s = await call("GET", "summary", "summary", scenarioDb());
    assert.equal(s.data.data_quality.records, 6600);
    assert.equal(s.data.data_quality.districts_reporting, 22);
    assert.ok(s.data.national.find((x) => x.indicator === "stunting" && x.population_group === "under5"));
    assert.equal(s.data.records_by_region.Southern > 0, true);
  });
  test("insights: prioritised, with actions, research questions, quality and caveat", async () => {
    const r = await call("GET", "insights?population_group=under5", "insights", scenarioDb());
    const d = r.data;
    const hotspot = d.insights.find((i) => i.type === "hotspot" && i.district === "Mangochi" && i.indicator === "stunting");
    assert.ok(hotspot, "hotspot insight");
    assert.equal(hotspot.priority, "high"); // 23% stunting is the WHO "high" band (20 to 30%)
    assert.ok(hotspot.suggested_actions.length >= 2 && hotspot.research_questions.length >= 1);
    assert.ok(d.insights.find((i) => i.type === "rising" && i.district === "Salima"));
    assert.ok(d.insights.find((i) => i.type === "data_gap"), "6 districts have no data");
    assert.ok(d.insights.find((i) => i.type === "trend" && i.indicator === "stunting"));
    const ranks = d.insights.map((i) => ({ critical: 0, high: 1, medium: 2, info: 3 })[i.priority]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.equal(d.data_quality.districts_reporting, 22);
    assert.match(d.data_caveat, /not a random survey/);
    assert.ok(JSON.stringify(d).length < 60000);
  });
  test("when the tables are not there, reads say so instead of failing", async () => {
    const missing = fakeDb(() => ({ ok: false, status: 404, body: { code: "PGRST202", message: "Could not find the function public.surveillance_counts" } }));
    for (const p of ["summary", "hotspots?population_group=under5", "trends?indicator=stunting", "alerts", "insights"]) {
      const r = await call("GET", p, p.split("?")[0], missing);
      assert.equal(r.data?.available, false, p);
      assert.match(r.data.note, /037/);
    }
  });
  test("bad parameters and unknown routes", async () => {
    assert.equal((await call("GET", "hotspots?population_group=elderly", "hotspots", scenarioDb())).status, 400);
    assert.equal((await call("GET", "hotspots?indicator=sugar", "hotspots", scenarioDb())).status, 400);
    assert.equal((await call("GET", "summary?months=99", "summary", scenarioDb())).status, 400);
    assert.equal((await call("POST", "summary", "summary", scenarioDb())).status, 405);
    assert.equal((await call("GET", "nope", "nope", scenarioDb())).status, 404);
  });
});

describe("fmtP", () => {
  test("tiny values read '<0.0001', never 0", () => {
    assert.equal(fmtP(0), "<0.0001");
    assert.equal(fmtP(0.00004), "<0.0001");
    assert.equal(fmtP(0.0144), "0.0144");
    assert.equal(fmtP(0.094), "0.094");
    assert.equal(fmtP(null), "n/a");
  });
  test("insight text uses it", async () => {
    const r = await handleSurveillance(req("GET"), new URL("https://x/surveillance/insights?population_group=under5"), scenarioDb(), {}, "insights", helpers, fetchRows, NOW);
    const hs = r.data.insights.find((i) => i.type === "hotspot");
    assert.ok(hs && !/\(q 0\)/.test(hs.detail) && /q (<0\.0001|0\.\d+)/.test(hs.detail), hs?.detail);
  });
});

describe("consolidateAcute", () => {
  const mk = (indicator, priority, type = "hotspot", district = "Nsanje") => ({ id: `${type}:${indicator}:${district}`, type, indicator, priority, district, population_group: "under5", detail: "x." });
  test("three overlapping findings become one, at the highest priority, listing the others", () => {
    const out = consolidateAcute([mk("wasting", "high"), mk("muac_gam", "medium"), mk("acute_malnutrition", "medium"), mk("stunting", "medium")]);
    assert.equal(out.length, 2);
    const a = out.find((i) => i.indicator === "acute_malnutrition");
    assert.equal(a.priority, "high");
    assert.deepEqual(a.also_flagged.sort(), ["muac_gam", "wasting"]);
    assert.match(a.detail, /Related measures also flagged/);
    assert.ok(out.find((i) => i.indicator === "stunting"));
  });
  test("different districts or types stay separate; a lone finding is untouched", () => {
    const out = consolidateAcute([mk("wasting", "high"), mk("wasting", "high", "hotspot", "Chikwawa"), mk("wasting", "high", "rising")]);
    assert.equal(out.length, 3);
    assert.ok(out.every((i) => !i.also_flagged));
  });
});

describe("registry sanity", () => {
  test("every indicator is internally consistent", () => {
    for (const [name, def] of Object.entries(INDICATORS)) {
      assert.ok(def.groups.length && def.statuses.length >= 2, name);
      for (const c of def.case) assert.ok(def.statuses.includes(c), `${name} case ${c}`);
      for (const c of def.severe) assert.ok(def.case.includes(c), `${name} severe ${c}`);
      assert.ok(def.statuses.some((s) => !def.case.includes(s)), `${name} has a non-case status`);
    }
  });
  test("reference output is JSON-serialisable and complete", () => {
    const r = referenceData({});
    assert.ok(JSON.parse(JSON.stringify(r)).indicators.acute_malnutrition.derived);
  });
});
