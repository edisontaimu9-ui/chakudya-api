import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { capSearchTerms, MAX_FOOD_SEARCH_TERMS } from "../src/searchTerms.js";

describe("capSearchTerms", () => {
  test("removes duplicate keywords", () => {
    assert.deepEqual(capSearchTerms(["which", "salt", "which", "limit"]), ["which", "salt", "limit"]);
  });
  test("caps a long keyword list and keeps the user's own words first", () => {
    const kw = ["nsima", "rice", "salt", "limit", "covers", "multiple", "conditions", "topics", "address"];
    const out = capSearchTerms(kw);
    assert.equal(out.length, MAX_FOOD_SEARCH_TERMS);
    assert.deepEqual(out.slice(0, 4), ["nsima", "rice", "salt", "limit"]);
  });
  test("short lists and empty lists are unchanged", () => {
    assert.deepEqual(capSearchTerms(["nsima"]), ["nsima"]);
    assert.deepEqual(capSearchTerms([]), []);
  });
});
