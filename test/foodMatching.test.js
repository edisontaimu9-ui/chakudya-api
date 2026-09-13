import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseFoodName,
  parseQueryAttributes,
  scoreFoodCandidates,
  pickBestFoodMatch,
  pickBestFoodMatchDetailed,
} from "../src/foodMatching.js";

// ── Real Malawi FCT rows, as actually returned by the live API during
// this engagement (see the PR description for the exact API responses
// these were taken from) — not hypothetical/invented data. Synthetic rows
// used to cover attribute categories with no real conflicting pair
// currently in the local table (variety, flour/form) are clearly labeled
// SYNTHETIC below; they test the general scoring logic itself, which is
// food-agnostic by design (see foodMatching.js's doc comment).
const REAL_RICE_ROWS = [
  { id: 101, food_name: "Rice, soaked, (Mpunga woviika)" },
  { id: 102, food_name: "Rice pudding" },
  { id: 103, food_name: "Rice pudding with eggs" },
];

const REAL_RICE_PORRIDGE_ROW = { id: 104, food_name: "Rice porridge, (Phala la mpunga)" };

const REAL_NSIMA_ROWS = [
  { id: 9, food_name: "Cassava thick porridge, (Nsima ya kondowole)" },
  { id: 10, food_name: "Maize thick porridge, refined flour, (Nsima ya ufa oyera)" },
];

const REAL_OTHER_ROWS = [
  { id: 200, food_name: "Custard apple, wild, Annona senegalensis, (Mpoza)" },
  { id: 198, food_name: "Banana, white fleshed, raw, peeled, (Nthochi yoyela mkati yokupsya)" },
  { id: 48, food_name: "Plantain, green, boiled, (Matochi)" },
];

const REAL_FRUIT_SALAD_ROW = {
  id: 300,
  food_name: "Fruit salad, fresh, (mango, banana, pineapple & pawpaw)",
};

describe("parseFoodName", () => {
  test("splits base segment, qualifier segments, and trailing parenthetical", () => {
    const parsed = parseFoodName("Rice, soaked, (Mpunga woviika)");
    assert.equal(parsed.baseSegment, "Rice");
    assert.deepEqual(parsed.qualifierSegments, ["soaked"]);
    assert.equal(parsed.parenPart, "Mpunga woviika");
  });

  test("handles a food_name with no comma or parenthetical", () => {
    const parsed = parseFoodName("Rice pudding");
    assert.equal(parsed.baseSegment, "Rice pudding");
    assert.deepEqual(parsed.baseWords, ["rice", "pudding"]);
    assert.equal(parsed.parenPart, null);
  });

  test("treats an English ingredient list in parens the same as a local name", () => {
    const parsed = parseFoodName(REAL_FRUIT_SALAD_ROW.food_name);
    assert.deepEqual(parsed.parenWords, ["mango", "banana", "pineapple", "pawpaw"]);
  });
});

describe("parseQueryAttributes", () => {
  test("extracts a stated preparation state and leaves the rest as core words", () => {
    assert.deepEqual(parseQueryAttributes("cooked rice"), {
      words: ["cooked", "rice"],
      coreWords: ["rice"],
      stated: { state: "cooked", form: null, freshness: null, variety: null },
    });
  });

  test("extracts a stated variety", () => {
    const attrs = parseQueryAttributes("brown rice");
    assert.equal(attrs.stated.variety, "brown");
    assert.deepEqual(attrs.coreWords, ["rice"]);
  });

  test("a bare generic query has no stated attributes", () => {
    const attrs = parseQueryAttributes("rice");
    assert.deepEqual(attrs.stated, { state: null, form: null, freshness: null, variety: null });
    assert.deepEqual(attrs.coreWords, ["rice"]);
  });
});

// 1. Generic food query against multiple variants.
describe("generic query vs multiple variants (real data — the original bug)", () => {
  test("'rice' prefers the plain ingredient over unrelated dishes that merely contain the word", () => {
    const best = pickBestFoodMatch(REAL_RICE_ROWS, "rice");
    assert.equal(best.food_name, "Rice, soaked, (Mpunga woviika)");
  });

  test("the winning margin comes from the dish-word penalty, not name length alone", () => {
    const scored = scoreFoodCandidates(REAL_RICE_ROWS, "rice");
    const pudding = scored.find((s) => s.row.id === 102);
    assert.ok(pudding.reasons.includes("unrequested_dish_word"));
  });
});

// 2. Query explicitly specifying a preparation state.
describe("query with an explicit preparation state", () => {
  // SYNTHETIC: local FCT has no actual raw/cooked rice pair currently: this
  // tests the scoring logic's state-match/conflict handling directly.
  const rows = [
    { id: 501, food_name: "Rice, raw" },
    { id: 502, food_name: "Rice, cooked" },
  ];

  test("'cooked rice' prefers the cooked record over the raw one", () => {
    assert.equal(pickBestFoodMatch(rows, "cooked rice").food_name, "Rice, cooked");
  });

  test("'raw rice' prefers the raw record over the cooked one", () => {
    assert.equal(pickBestFoodMatch(rows, "raw rice").food_name, "Rice, raw");
  });

  test("a stated state conflicting with the record's is penalized (real data)", () => {
    // "cooked rice" against the real local rows, none of which is actually
    // "cooked" — "Rice, soaked" still wins (best available) but scores
    // lower than its own bare-query score, reflecting the state conflict.
    const bareScore = scoreFoodCandidates(REAL_RICE_ROWS, "rice")[0].score;
    const cookedScore = scoreFoodCandidates(REAL_RICE_ROWS, "cooked rice")[0].score;
    assert.ok(cookedScore < bareScore);
  });
});

// 3. Query explicitly specifying a variety.
describe("query with an explicit variety", () => {
  // SYNTHETIC: tests variety-category matching directly.
  const rows = [
    { id: 601, food_name: "Rice, white, raw" },
    { id: 602, food_name: "Rice, brown, raw" },
  ];

  test("'brown rice' prefers the brown variety", () => {
    assert.equal(pickBestFoodMatch(rows, "brown rice").food_name, "Rice, brown, raw");
  });

  test("'white rice' prefers the white variety", () => {
    assert.equal(pickBestFoodMatch(rows, "white rice").food_name, "Rice, white, raw");
  });
});

// 4. Query referring to a prepared dish.
describe("query naming a prepared dish (real data)", () => {
  test("'rice porridge' prefers the porridge record over the plain ingredient", () => {
    const rows = [REAL_RICE_PORRIDGE_ROW, ...REAL_RICE_ROWS];
    const best = pickBestFoodMatch(rows, "rice porridge");
    assert.equal(best.food_name, "Rice porridge, (Phala la mpunga)");
  });

  test("the dish match is rewarded, not just tolerated", () => {
    const rows = [REAL_RICE_PORRIDGE_ROW, ...REAL_RICE_ROWS];
    const scored = scoreFoodCandidates(rows, "rice porridge");
    const porridge = scored.find((s) => s.row.id === REAL_RICE_PORRIDGE_ROW.id);
    assert.ok(porridge.reasons.includes("requested_dish_word"));
  });
});

// 5. Query referring to flour/ground/powdered form.
describe("query naming a flour/ground form", () => {
  // SYNTHETIC plain-flour entry alongside the real porridge entry — tests
  // that a bare-ingredient-form query doesn't get pulled onto a cooked
  // dish just because the dish's name also contains "flour".
  const rows = [
    { id: 701, food_name: "Maize flour, refined" },
    { id: 10, food_name: "Maize thick porridge, refined flour, (Nsima ya ufa oyera)" },
  ];

  test("'maize flour' prefers the plain flour over the cooked porridge", () => {
    assert.equal(pickBestFoodMatch(rows, "maize flour").food_name, "Maize flour, refined");
  });
});

// 6. Multiple Malawi FCT candidates with similar lexical scores (real data)
// — flagged ambiguous rather than silently guessing.
describe("bare query with only a weak/tied match across candidates (real data)", () => {
  test("'nsima' (Chichewa-only match on both candidates) is flagged ambiguous", () => {
    const { ambiguous, alternates } = pickBestFoodMatchDetailed(REAL_NSIMA_ROWS, "nsima");
    assert.equal(ambiguous, true);
    assert.ok(alternates.length >= 1);
  });

  test("a specific query resolves the same pair confidently, no longer ambiguous", () => {
    const { ambiguous, match } = pickBestFoodMatchDetailed(REAL_NSIMA_ROWS, "nsima ya kondowole");
    assert.equal(ambiguous, false);
    assert.equal(match.food_name, "Cassava thick porridge, (Nsima ya kondowole)");
  });
});

// 7. The most lexically-similar/shortest result is not the most
// semantically appropriate one (real data — this IS the original bug).
describe("shortest/most lexically similar result is not the best one (real data)", () => {
  test("'Rice pudding' is lexically closer in length but still loses to 'Rice, soaked'", () => {
    assert.ok("Rice pudding".length < "Rice, soaked, (Mpunga woviika)".length);
    const best = pickBestFoodMatch(REAL_RICE_ROWS, "rice");
    assert.equal(best.food_name, "Rice, soaked, (Mpunga woviika)");
  });
});

// 8. No-match / low-confidence situations.
describe("no rows / low-confidence handling", () => {
  test("returns null (not a throw) for an empty candidate list", () => {
    assert.equal(pickBestFoodMatch([], "anything"), null);
  });

  test("pickBestFoodMatchDetailed reports no ambiguity for a single candidate", () => {
    const { ambiguous } = pickBestFoodMatchDetailed([REAL_RICE_ROWS[0]], "rice");
    assert.equal(ambiguous, false);
  });

  test("an ingredient-list parenthetical still contributes a weak match", () => {
    const rows = [REAL_FRUIT_SALAD_ROW, ...REAL_OTHER_ROWS];
    const scored = scoreFoodCandidates(rows, "mango");
    assert.equal(scored[0].row.id, REAL_FRUIT_SALAD_ROW.id);
    assert.ok(scored[0].reasons.includes("parenthetical_match"));
  });
});

// Backward-compatibility spot checks against other real entries, to make
// sure the new scorer doesn't regress unrelated, already-correct lookups.
describe("backward compatibility (real data)", () => {
  test("an exact whole-name match always wins outright", () => {
    const best = pickBestFoodMatch(REAL_OTHER_ROWS, "Plantain, green, boiled, (Matochi)");
    assert.equal(best.id, 48);
  });

  test("a specific real multi-qualifier query still resolves correctly", () => {
    const best = pickBestFoodMatch(REAL_OTHER_ROWS, "banana raw peeled");
    assert.equal(best.id, 198);
  });
});
