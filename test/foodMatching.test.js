import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseFoodName,
  parseQueryAttributes,
  scoreFoodCandidates,
  pickBestFoodMatch,
  pickBestFoodMatchDetailed,
  defaultStapleFor,
  preferDefaultStaple,
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
  test("a bare 'nsima' resolves to maize nsima, not cassava, and is no longer a toss-up", () => {
    const { ambiguous, match, alternates } = pickBestFoodMatchDetailed(REAL_NSIMA_ROWS, "nsima");
    assert.equal(match.food_name, "Maize thick porridge, refined flour, (Nsima ya ufa oyera)");
    assert.equal(ambiguous, false);
    assert.equal(alternates[0].food_name, "Cassava thick porridge, (Nsima ya kondowole)");
  });

  test("naming the staple still wins: 'cassava nsima' is cassava", () => {
    assert.equal(pickBestFoodMatch(REAL_NSIMA_ROWS, "cassava nsima").food_name, "Cassava thick porridge, (Nsima ya kondowole)");
    assert.equal(pickBestFoodMatch(REAL_NSIMA_ROWS, "maize nsima").food_name, "Maize thick porridge, refined flour, (Nsima ya ufa oyera)");
  });

  test("a specific query resolves the same pair confidently, no longer ambiguous", () => {
    const { ambiguous, match } = pickBestFoodMatchDetailed(REAL_NSIMA_ROWS, "nsima ya kondowole");
    assert.equal(ambiguous, false);
    assert.equal(match.food_name, "Cassava thick porridge, (Nsima ya kondowole)");
  });
});

// 6b. Default staple for a bare dish name, and the list-endpoint reorder.
describe("default staple for a bare dish name", () => {
  test("defaultStapleFor", () => {
    assert.equal(defaultStapleFor("nsima"), "maize");
    assert.equal(defaultStapleFor("  Nsima "), "maize");
    assert.equal(defaultStapleFor("nsima ya"), "maize");
    assert.equal(defaultStapleFor("cassava nsima"), null);
    assert.equal(defaultStapleFor("nsima ya kondowole"), null);
    assert.equal(defaultStapleFor("nsima ya ufa oyera"), null);
    assert.equal(defaultStapleFor("rice"), null);
    assert.equal(defaultStapleFor(""), null);
  });

  test("a specific Chichewa name still reaches its own row", () => {
    assert.equal(pickBestFoodMatch(REAL_NSIMA_ROWS, "nsima ya kondowole").food_name, "Cassava thick porridge, (Nsima ya kondowole)");
    assert.equal(pickBestFoodMatch(REAL_NSIMA_ROWS, "nsima ya ufa oyera").food_name, "Maize thick porridge, refined flour, (Nsima ya ufa oyera)");
  });

  test("with several maize and non-maize rows, maize leads a bare 'nsima'", () => {
    const rows = [
      { id: 9, food_name: "Cassava thick porridge, (Nsima ya kondowole)" },
      { id: 11, food_name: "Sorghum thick porridge, (Nsima ya mapira)" },
      { id: 12, food_name: "Maize thick porridge, whole grain, (Nsima ya mgaiwa)" },
      { id: 10, food_name: "Maize thick porridge, refined flour, (Nsima ya ufa oyera)" },
    ];
    const best = pickBestFoodMatchDetailed(rows, "nsima");
    assert.match(best.match.food_name, /^Maize thick porridge/);
    assert.match(best.scored[1].row.food_name, /^Maize thick porridge/);
  });

  // The maize nsima rows as the live API returns them (cassava first, the maize+soya porridge shortest).
  const LIVE_NSIMA = [
    { id: 9, food_name: "Cassava thick porridge, (Nsima ya kondowole)" },
    { id: 14, food_name: "Maize and soya thick porridge, (Nsima ya ufa wa chimanga ndi soya)" },
    { id: 12, food_name: "Maize thick porridge, white, whole flour, (Nsima ya mgaiwa)" },
    { id: 13, food_name: "Maize thick porridge, degermed- dehulled flour, (Nsima ya galamilu)" },
    { id: 10, food_name: "Maize thick porridge, refined flour, (Nsima ya ufa oyera)" },
    { id: 15, food_name: "Maize thick porridge, white, whole flour, (Nsima ya mgaiwa), Calculated" },
  ];

  test("live rows: a bare 'nsima' is plain refined maize, never the maize+soya porridge or cassava", () => {
    assert.equal(pickBestFoodMatch(LIVE_NSIMA, "nsima").id, 10);
    const order = preferDefaultStaple(LIVE_NSIMA, "nsima").map((r) => r.id);
    assert.equal(order[0], 10);
    assert.ok(order.indexOf(14) > order.indexOf(13), "composite after every plain maize row");
    assert.ok(order.indexOf(14) > order.indexOf(12));
    assert.equal(order.at(-1), 9, "cassava last");
    assert.deepEqual(order.slice(0, 4).sort(), [10, 12, 13, 15].sort());
  });

  test("live rows: a specific query still reaches its own row", () => {
    assert.equal(pickBestFoodMatch(LIVE_NSIMA, "nsima ya mgaiwa").id, 12);
    assert.equal(pickBestFoodMatch(LIVE_NSIMA, "nsima ya galamilu").id, 13);
    assert.equal(pickBestFoodMatch(LIVE_NSIMA, "nsima ya kondowole").id, 9);
    assert.equal(pickBestFoodMatch(LIVE_NSIMA, "cassava nsima").id, 9);
    assert.equal(pickBestFoodMatch(LIVE_NSIMA, "maize and soya nsima").id, 14);
  });

  test("preferDefaultStaple is a stable reorder, and leaves other queries alone", () => {
    const rows = [
      { id: 9, food_name: "Cassava thick porridge, (Nsima ya kondowole)" },
      { id: 12, food_name: "Maize thick porridge, whole grain, (Nsima ya mgaiwa)" },
      { id: 11, food_name: "Sorghum thick porridge, (Nsima ya mapira)" },
      { id: 10, food_name: "Maize thick porridge, refined flour, (Nsima ya ufa oyera)" },
    ];
    assert.deepEqual(preferDefaultStaple(rows, "nsima").map((r) => r.id), [10, 12, 9, 11]); // refined flour first, then whole grain
    assert.deepEqual(preferDefaultStaple(rows, "cassava nsima").map((r) => r.id), [9, 12, 11, 10]);
    assert.deepEqual(preferDefaultStaple(rows, "rice").map((r) => r.id), [9, 12, 11, 10]);
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

// ── v1.45.0: intent-aware search (state, variety, local names, aliases) ──────────────────────────────
import {
  stateOf,
  stateRelation,
  hasStatedAttributes,
  retrievalTermFor,
  rankFoodRows,
  conflictsWithQuery,
  searchFoodsRanked,
} from "../src/foodMatching.js";

// REAL rows are the ones captured from the live API (see the fixtures at the top of this file).
// SYNTHETIC rows follow the FCT naming pattern ("<food>, <qualifiers>, (<local name>)") for variety/state
// pairs the local fixtures do not contain; they exercise the general scoring, not a claim about the table.
const SYNTHETIC_RICE = [
  { id: 901, food_name: "Rice, brown, cooked, (Mpunga wofiira wophika)" },
  { id: 902, food_name: "Rice, white, cooked, (Mpunga woyera wophika)" },
  { id: 903, food_name: "Rice, white, raw, (Mpunga woyera waiwisi)" },
];
const ALL_RICE = [...REAL_RICE_ROWS, REAL_RICE_PORRIDGE_ROW, ...SYNTHETIC_RICE];

// Stand-in for fuzzy_food_search(): like the real function, EVERY word of the term must be found in the
// name (stricter than trigram similarity, which is the point being tested).
function fakeFuzzyDb(rows) {
  return async (term, width) => {
    const words = (term || "").toLowerCase().match(/[a-z']+/g) || [];
    return rows
      .filter((r) => {
        const nameWords = (r.food_name || "").toLowerCase().match(/[a-z']+/g) || [];
        return words.every((w) => nameWords.includes(w));
      })
      .slice(0, width);
  };
}

describe("preparation state is compared by meaning", () => {
  test("synonyms and Chichewa state words collapse to one state", () => {
    assert.equal(stateOf("uncooked"), "raw");
    assert.equal(stateOf("wophika"), "cooked");
    assert.equal(stateOf("yophika"), "cooked");
    assert.equal(stateOf("woviika"), "soaked");
    assert.equal(stateOf("rice"), null);
  });

  test("cooked is related to a cooking method, in conflict with raw/soaked/dried/fermented", () => {
    assert.equal(stateRelation("cooked", "cooked").kind, "match");
    assert.equal(stateRelation("cooked", "boiled").kind, "related");
    assert.equal(stateRelation("boiled", "cooked").kind, "related");
    for (const other of ["raw", "soaked", "dried", "fermented"]) {
      assert.equal(stateRelation("cooked", other).kind, "conflict", other);
    }
    assert.equal(stateRelation("boiled", "fried").kind, "conflict");
    assert.equal(stateRelation("boiled", "steamed").kind, "related");
  });

  test("a Chichewa state word in the query is read as that state, not as the food", () => {
    const attrs = parseQueryAttributes("mpunga wophika");
    assert.equal(attrs.stated.state, "cooked");
    assert.deepEqual(attrs.coreWords, ["mpunga"]);
  });

  test("spelling variants of the same word are folded", () => {
    assert.deepEqual(parseQueryAttributes("Sima ya mgayiwa").words, ["nsima", "ya", "mgaiwa"]);
  });
});

describe("rice: state, variety and word order (the examples from the brief)", () => {
  test("'Brown cooked rice' and 'Rice, Brown, Cooked' pick the same record", () => {
    assert.equal(rankFoodRows(ALL_RICE, "Brown cooked rice")[0].id, 901);
    assert.equal(rankFoodRows(ALL_RICE, "Rice, Brown, Cooked")[0].id, 901);
  });

  test("an explicit state outranks the unqualified base food", () => {
    assert.equal(rankFoodRows(ALL_RICE, "raw rice")[0].id, 903);
    assert.ok(["901", "902"].includes(String(rankFoodRows(ALL_RICE, "cooked rice")[0].id)));
  });

  test("a bare 'rice' prefers the plain base food over a dish or a specific variant", () => {
    const order = rankFoodRows(ALL_RICE, "Rice").map((r) => r.id);
    assert.equal(order[0], 101); // REAL "Rice, soaked, (Mpunga woviika)": nothing but the base food and one state
    assert.ok(order.indexOf(102) > order.indexOf(902), "pudding after plain rice rows");
    assert.ok(order.indexOf(103) > order.indexOf(902));
  });

  test("a state conflict ranks lower but is still listed", () => {
    const order = rankFoodRows(REAL_RICE_ROWS, "cooked rice").map((r) => r.id);
    assert.ok(order.includes(101));
    assert.equal(order[0], 101); // only plain-rice row there is; the dishes are worse
  });

  test("conflictsWithQuery flags a different state or variety, not an unqualified row", () => {
    assert.equal(conflictsWithQuery(REAL_RICE_ROWS[0], "cooked rice"), true);
    assert.equal(conflictsWithQuery(SYNTHETIC_RICE[1], "brown rice"), true);
    assert.equal(conflictsWithQuery(SYNTHETIC_RICE[0], "brown cooked rice"), false);
    assert.equal(conflictsWithQuery(REAL_RICE_ROWS[0], "rice"), false);
    assert.equal(conflictsWithQuery(REAL_RICE_ROWS[0], "soaked rice"), false);
  });

  test("Chichewa query with a state: 'mpunga wophika' reaches cooked rice, not the soaked row", () => {
    assert.ok([901, 902].includes(rankFoodRows(ALL_RICE, "mpunga wophika")[0].id));
  });
});

describe("retrieval: the database needs every word, so a state word must not hide rows", () => {
  test("hasStatedAttributes / retrievalTermFor", () => {
    assert.equal(hasStatedAttributes("brown cooked rice"), true);
    assert.equal(hasStatedAttributes("rice"), false);
    assert.equal(retrievalTermFor("Rice, Brown, Cooked"), "rice");
    assert.equal(retrievalTermFor("nsima ya galamilu"), "nsima galamilu");
    assert.equal(retrievalTermFor("cooked"), "cooked"); // never an empty term
  });

  test("'cooked rice' still reaches 'Rice, soaked' through the second, identity-words-only fetch", async () => {
    const db = fakeFuzzyDb(REAL_RICE_ROWS);
    assert.deepEqual(await db("cooked rice", 24), []); // what the database alone would return
    const rows = await searchFoodsRanked(db, "cooked rice", { maxResults: 8 });
    assert.equal(rows[0].id, 101);
  });

  test("a bare 'rice' is no longer led by 'Rice pudding' (database order put the pudding first)", async () => {
    const dbPudd = fakeFuzzyDb([REAL_RICE_ROWS[1], REAL_RICE_ROWS[2], REAL_RICE_ROWS[0]]);
    const rows = await searchFoodsRanked(dbPudd, "rice", { maxResults: 8 });
    assert.equal(rows[0].id, 101);
  });

  test("no second fetch when the query states nothing, or the first fetch was full", async () => {
    let calls = 0;
    const counting = async (t, w) => { calls++; return fakeFuzzyDb(ALL_RICE)(t, w); };
    await searchFoodsRanked(counting, "rice", { maxResults: 8 });
    assert.equal(calls, 1);
    calls = 0;
    await searchFoodsRanked(counting, "cooked rice", { maxResults: 1 }); // first fetch yields rows
    assert.equal(calls, 1);
  });

  test("result count and row identity are untouched: only the order changes", async () => {
    const rows = await searchFoodsRanked(fakeFuzzyDb(ALL_RICE), "rice", { maxResults: 50 });
    assert.deepEqual(rows.map((r) => r.id).sort(), ALL_RICE.map((r) => r.id).sort());
    for (const r of rows) assert.deepEqual(r, ALL_RICE.find((x) => x.id === r.id));
  });
});

describe("nsima stays distinct (real rows), including through the new search path", () => {
  const rowsDb = fakeFuzzyDb(LIVE_NSIMA_ROWS());
  function LIVE_NSIMA_ROWS() {
    return [
      { id: 9, food_name: "Cassava thick porridge, (Nsima ya kondowole)" },
      { id: 14, food_name: "Maize and soya thick porridge, (Nsima ya ufa wa chimanga ndi soya)" },
      { id: 12, food_name: "Maize thick porridge, white, whole flour, (Nsima ya mgaiwa)" },
      { id: 13, food_name: "Maize thick porridge, degermed- dehulled flour, (Nsima ya galamilu)" },
      { id: 10, food_name: "Maize thick porridge, refined flour, (Nsima ya ufa oyera)" },
      { id: 15, food_name: "Maize thick porridge, white, whole flour, (Nsima ya mgaiwa), Calculated" },
    ];
  }

  test("each named nsima reaches its own row", async () => {
    const top = async (q) => (await searchFoodsRanked(rowsDb, q, { maxResults: 8 }))[0].id;
    assert.equal(await top("nsima"), 10);
    assert.equal(await top("Nsima ya mgaiwa"), 12);
    assert.equal(await top("Sima ya mgayiwa"), 12); // spelling variants of the same words
    assert.equal(await top("nsima ya galamilu"), 13);
    assert.equal(await top("nsima ya kondowole"), 9);
  });

  test("a verified alias never pulls a row over a direct name match", () => {
    // 009's nsima group also lists maize/ufa/chimanga; those aliases must not outrank the row that names the word.
    const rows = LIVE_NSIMA_ROWS();
    const aliases = ["maize", "ufa", "chimanga", "maize flour", "cassava", "kondowole"];
    assert.equal(rankFoodRows(rows, "nsima ya kondowole", { aliases })[0].id, 9);
    assert.equal(rankFoodRows(rows, "nsima ya galamilu", { aliases })[0].id, 13);
  });

  test("an alias fills a gap only when no row carries the word", () => {
    const rows = [
      { id: 1, food_name: "Rice, soaked, (Mpunga woviika)" },
      { id: 2, food_name: "Beans, dried, (Nyemba zouma)" },
    ];
    // nobody names "chelani", so its verified alias (rice) is the only link
    assert.equal(rankFoodRows(rows, "chelani", { aliases: ["rice"] })[0].id, 1);
    // without an alias nothing is invented
    assert.ok(!scoreFoodCandidates(rows, "chelani")[0].reasons.includes("alias_match_in_base"));
  });
});
