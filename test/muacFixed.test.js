import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseMuacFixedQuery, classifyMuacFixed } from "../src/muacFixed.js";

const q = (s) => parseMuacFixedQuery(new URLSearchParams(s));
const c = (age, x) => classifyMuacFixed(age, x).status;

describe("classifyMuacFixed", () => {
  test("6-11 months: <11 severe, 11-12 moderate, >12 normal", () => {
    assert.equal(c(8, 10.9), "severe");
    assert.equal(c(8, 11), "moderate");
    assert.equal(c(8, 12), "moderate");
    assert.equal(c(8, 12.1), "normal");
  });
  test("12-59 months: <11 severe, 11-13 moderate, >13 normal", () => {
    assert.equal(c(12, 10.9), "severe");
    assert.equal(c(30, 13), "moderate");
    assert.equal(c(59, 13.1), "normal");
  });
  test("5-9 years: <13.5 / 13.5-14.5 / >14.5", () => {
    assert.equal(c(60, 13.4), "severe");
    assert.equal(c(100, 14.5), "moderate");
    assert.equal(c(119, 14.6), "normal");
  });
  test("10-14 years: <16 / 16-18 / >18", () => {
    assert.equal(c(120, 15.9), "severe");
    assert.equal(c(150, 18), "moderate");
    assert.equal(c(179, 18.1), "normal");
  });
  test("adults (15 y+): <18 / 18-21 / >21", () => {
    assert.equal(c(180, 17.9), "severe");
    assert.equal(c(360, 21), "moderate");
    assert.equal(c(360, 21.1), "normal");
  });
  test("group labels and cut-offs", () => {
    assert.deepEqual(classifyMuacFixed(8, 11.5), { age_group: "6-11 months", status: "moderate", muac_cm: 11.5, cutoffs_cm: { severe_below: 11, normal_above: 12 } });
    assert.equal(classifyMuacFixed(59, 12).age_group, "12-59 months");
    assert.equal(classifyMuacFixed(60, 14).age_group, "5-9 years");
  });
});

describe("parseMuacFixedQuery", () => {
  test("accepts cm and mm", () => {
    assert.equal(q("age_months=8&muac_cm=11.5").muacCm, 11.5);
    assert.equal(q("age_months=8&muac_mm=115").muacCm, 11.5);
  });
  test("rejects bad input", () => {
    assert.ok(q("muac_cm=11").error);
    assert.ok(q("age_months=5&muac_cm=11").error);      // under 6 months
    assert.ok(q("age_months=8.5&muac_cm=11").error);
    assert.ok(q("age_months=8").error);                 // no muac
    assert.ok(q("age_months=8&muac_cm=115").error);     // mm passed as cm
  });
});
