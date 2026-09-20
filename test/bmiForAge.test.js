import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBmiForAgeQuery, classifyBmiForAge } from "../src/bmiForAge.js";

// girls, 95 months (7y 11m), from the guide's Annex 2 table
const girls95 = { sd_neg3: 11.9, sd_neg2: 12.9, sd_neg1: 14.1, median: 15.7, sd_pos1: 17.7, sd_pos2: 20.5, sd_pos3: 24.6 };
const q = (s) => parseBmiForAgeQuery(new URLSearchParams(s));

describe("parseBmiForAgeQuery", () => {
  test("accepts weight and height, keeps BMI unrounded (Annex 2 worked example)", () => {
    const r = q("sex=girls&age_months=95&weight_kg=26&height_cm=121.1");
    assert.equal(r.sex, "girls");
    assert.equal(r.ageMonths, 95);
    assert.ok(r.bmi > 17.72 && r.bmi < 17.74);
  });
  test("normalises sex aliases", () => {
    assert.equal(q("sex=Female&age_months=100&bmi=15").sex, "girls");
    assert.equal(q("sex=m&age_months=100&bmi=15").sex, "boys");
  });
  test("rejects bad input", () => {
    assert.ok(q("age_months=95&bmi=15").error);                  // no sex
    assert.ok(q("sex=girls&bmi=15").error);                      // no age
    assert.ok(q("sex=girls&age_months=40&bmi=15").error);        // under 5y 1m
    assert.ok(q("sex=girls&age_months=229&bmi=15").error);       // over 19y 0m
    assert.ok(q("sex=girls&age_months=95").error);               // no bmi or weight/height
  });
});

describe("classifyBmiForAge", () => {
  test("Annex 2 worked example (Mary, 7y 11m, 26.0 kg, 121.1 cm) is overweight", () => {
    const { bmi } = q("sex=girls&age_months=95&weight_kg=26&height_cm=121.1");
    assert.equal(classifyBmiForAge(girls95, bmi).status, "overweight");
  });
  test("bands", () => {
    assert.equal(classifyBmiForAge(girls95, 15.7).status, "normal");
    assert.equal(classifyBmiForAge(girls95, 17.7).status, "normal");   // exactly +1SD is not above it
    assert.equal(classifyBmiForAge(girls95, 12.5).status, "thinness");
    assert.equal(classifyBmiForAge(girls95, 11.5).status, "severe thinness");
    assert.equal(classifyBmiForAge(girls95, 20.5).status, "overweight"); // exactly +2SD
    assert.equal(classifyBmiForAge(girls95, 21.0).status, "obesity");
  });
});
