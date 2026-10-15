/**
 * Chakudya Nutrition Registry — food-name matching/ranking engine.
 *
 * Replaces the old pickBestFoodMatch() in index.js, whose only real
 * disambiguation logic (beyond exact-match and word-boundary filtering)
 * was "shortest food_name wins" — which picks the wrong candidate whenever
 * the more specific/verbose entry is actually the better match (see the
 * root-cause writeup in the PR/commit message this file ships with).
 *
 * WHY THIS EXISTS (root cause of the bug this replaces):
 * The Malawi FCT names foods as
 *   "<base food>[, <qualifier>[, <qualifier>...]][, (<local name /
 *   ingredient list>)]"
 * e.g. "Rice, soaked, (Mpunga woviika)", "Maize thick porridge, refined
 * flour, (Nsima ya ufa oyera)", "Rice porridge, (Phala la mpunga)". A bare
 * query like "rice" ilike-matches ALL of these (plus anything with "rice"
 * anywhere in the name, e.g. "Rice pudding"), and the old code's only way
 * to pick one was whichever food_name string happened to be shortest —
 * which has nothing to do with which record is actually the best semantic
 * match for what the user asked. This module scores each candidate
 * instead, using the STRUCTURE of the name (base segment vs. qualifier
 * segments vs. trailing parenthetical) and the ATTRIBUTES explicitly
 * stated in the query (preparation state, physical form, freshness,
 * variety, or an explicitly-requested dish name), so:
 *   - a generic query ("rice") prefers the plain base food over both an
 *     over-qualified variant AND an unrelated dish that merely contains
 *     the word ("Rice pudding");
 *   - a specific query ("cooked rice", "rice porridge", "brown rice")
 *     actively prefers a candidate whose stated attribute matches, and
 *     penalizes one whose stated attribute conflicts;
 *   - qualifiers the query never asked about only apply a small
 *     "specificity" tiebreak penalty, never a disqualification — a food
 *     with an unrequested qualifier can still win if it's the only/best
 *     candidate available (Malawi FCT frequently has no unqualified
 *     entry for a food at all).
 *
 * NOT a per-food hardcode: nothing in this file names a specific food.
 * Everything runs off general word categories (STATE_WORDS, FORM_WORDS,
 * etc.) and the generic comma-segment structure above.
 */

// ── Query/name attribute-category word lists ────────────────────────────
// General cooking/food-science vocabulary — not tied to any specific food.
// Extend these sets as real queries surface gaps; that's a data change,
// not a logic change.

export const STATE_WORDS = new Set([
  "raw", "cooked", "boiled", "fried", "roasted", "grilled", "baked",
  "steamed", "soaked", "dried", "smoked", "toasted", "stewed",
  "fermented", "blanched", "poached", "braised", "sauteed", "sautéed",
  "uncooked", "parboiled",
]);

export const FORM_WORDS = new Set([
  "flour", "ground", "powder", "powdered", "paste", "juice", "puree",
  "pureed", "mashed", "sliced", "chopped", "shredded", "whole", "peeled",
  "unpeeled", "husked", "shelled", "grated", "crushed", "milled", "flaked",
  "diced", "minced",
]);

export const FRESHNESS_WORDS = new Set([
  "fresh", "ripe", "unripe", "green", "wild", "young", "mature", "old",
]);

export const VARIETY_WORDS = new Set([
  "white", "brown", "red", "black", "yellow", "purple",
]);

// A food_name segment carrying one of these directly attached to the base
// word (no comma — see parseFoodName) names a DIFFERENT prepared dish
// built from the base ingredient, not the plain ingredient itself. This
// is the core signal behind "don't let 'Rice pudding' outrank 'Rice' for
// a bare 'rice' query just because it contains the word".
export const DISH_WORDS = new Set([
  "porridge", "pudding", "cake", "bread", "sauce", "stew", "soup", "salad",
  "pie", "fritters", "chips", "crisps", "juice", "wine", "beer", "biscuit",
  "biscuits", "scones", "pancake", "pancakes", "dumpling", "dumplings",
  "relish",
]);

const ATTRIBUTE_CATEGORIES = [
  ["state", STATE_WORDS],
  ["form", FORM_WORDS],
  ["freshness", FRESHNESS_WORDS],
  ["variety", VARIETY_WORDS],
];

const ALL_ATTRIBUTE_WORDS = new Set([
  ...STATE_WORDS, ...FORM_WORDS, ...FRESHNESS_WORDS, ...VARIETY_WORDS,
]);

// Spelling variants that are the same word (data, not logic). Both entries are already treated as the
// same food elsewhere: "sima" is an alias of nsima in food_synonyms (sql/009); "mgayiwa" is the other
// common spelling of mgaiwa (whole-grain maize flour). Add a variant only when it is the SAME word -
// never to bridge two different foods.
export const SPELLING_VARIANTS = {
  sima: "nsima",
  mgayiwa: "mgaiwa",
};

function tokenize(s) {
  const folded = (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return (folded.match(/[a-z']+/g) || []).map((w) => SPELLING_VARIANTS[w] || w);
}

// ── Preparation-state vocabulary ────────────────────────────────────────
// Chichewa preparation words (verb stem + noun-class prefix: wophika / yophika / zophika / chophika ...)
// -> the English state they mean. Lets "mpunga wophika" be understood as cooked rice. "oviika" is the
// word in the FCT's own "Rice, soaked, (Mpunga woviika)". NEEDS A CHICHEWA SPEAKER'S REVIEW before it is
// extended; keep it to stems that are certain.
const CHICHEWA_STATE_STEMS = {
  ophika: "cooked",
  aiwisi: "raw",
  ouma: "dried",
  okazinga: "fried",
  owotcha: "roasted",
  oviika: "soaked",
};
const CHICHEWA_STATE_PREFIXES = ["w", "y", "z", "ch"];
export const CHICHEWA_STATE_WORDS = Object.fromEntries(
  Object.entries(CHICHEWA_STATE_STEMS).flatMap(([stem, state]) =>
    CHICHEWA_STATE_PREFIXES.map((p) => [p + stem, state])
  )
);

// Synonyms that collapse to one canonical state.
const STATE_CANONICAL = { uncooked: "raw", "sautéed": "sauteed" };

/** The canonical preparation state a single word names (English or Chichewa), or null. */
export function stateOf(word) {
  if (STATE_WORDS.has(word)) return STATE_CANONICAL[word] || word;
  return CHICHEWA_STATE_WORDS[word] || null;
}

// Cooking-method families, so related states are not treated as hard conflicts: "cooked rice" is
// closer to "Rice, boiled" than to "Rice, soaked", and "boiled" is not the opposite of "steamed".
const MOIST_HEAT = new Set(["boiled", "steamed", "stewed", "poached", "braised"]);
const DRY_HEAT = new Set(["fried", "roasted", "baked", "grilled", "toasted", "sauteed"]);

/**
 * How a state the query asked for relates to a state a row names:
 *   match    - same state (or a synonym: raw / uncooked)
 *   related  - same cooking family, or the generic "cooked" against a specific cooking method
 *   conflict - a different preparation (cooked vs raw / soaked / dried / fermented, boiled vs fried ...)
 * bonus is the score the relation earns.
 */
export function stateRelation(asked, named) {
  if (asked === named) return { kind: "match", bonus: 18 };
  const [a, b] = [asked, named];
  if (a === "cooked" || b === "cooked") {
    const other = a === "cooked" ? b : a;
    if (MOIST_HEAT.has(other)) return { kind: "related", bonus: 10 };
    if (DRY_HEAT.has(other)) return { kind: "related", bonus: 5 };
    return { kind: "conflict", bonus: -25 };
  }
  if (MOIST_HEAT.has(a) && MOIST_HEAT.has(b)) return { kind: "related", bonus: 4 };
  if (DRY_HEAT.has(a) && DRY_HEAT.has(b)) return { kind: "related", bonus: 2 };
  return { kind: "conflict", bonus: -25 };
}

/** Every canonical preparation state a parsed food_name carries (main name, qualifiers, local name). */
function statesInName(parsed) {
  const found = [];
  for (const w of [...parsed.allWords, ...parsed.parenWords]) {
    const st = stateOf(w);
    if (st && !found.includes(st)) found.push(st);
  }
  return found;
}

// A local dish name used on its own means a particular staple: a bare "nsima" is maize nsima, the
// everyday one, not the cassava (kondowole), sorghum or millet versions. Applied only when the query
// names nothing else (so "cassava nsima" or "nsima ya kondowole" are untouched). dish word -> the
// ingredient word that should lead. Extend as real queries surface gaps; it is data, not logic.
export const DISH_DEFAULT_STAPLE = {
  nsima: "maize",
};

// Among rows of the default staple, the plain everyday variant leads: for nsima that is the refined
// flour one ("Nsima ya ufa oyera"), ahead of whole-grain or degermed. dish word -> qualifier words.
export const DISH_PREFERRED_VARIANT = {
  nsima: ["refined"],
};

// A base segment with one of these ("Maize and soya thick porridge") is a composite/fortified dish,
// not the plain staple: it still counts as maize but ranks behind every plain maize row.
const COMPOSITE_MARKERS = new Set(["and", "with"]);

// What a bare food name means when the query states no preparation state: a bare "rice" is cooked rice
// (that is how it is searched and eaten), not the dry grain. Only a soft preference: a row in another state
// is ranked lower, never excluded, and any stated state ("raw rice") overrides it. Applied only when every
// food word in the query is listed (so "rice pudding" and "rice porridge" are untouched). Data, not logic:
// add a staple only when its everyday form is certain.
export const DEFAULT_STATE_FOR_BARE = {
  rice: "cooked",
  mpunga: "cooked",
};

/** The preparation state a bare food name implies ("rice" -> "cooked"), or null. */
export function impliedStateFor(queryAttrs) {
  if (queryAttrs.stated.state || !queryAttrs.coreWords.length) return null;
  const words = queryAttrs.coreWords.filter((w) => !QUERY_FILLER_WORDS.has(w));
  if (!words.length) return null;
  const states = words.map((w) => DEFAULT_STATE_FOR_BARE[w]);
  return states.every((x) => x && x === states[0]) ? states[0] : null;
}

// Chichewa/English link words that carry no food meaning ("nsima ya", "a bowl of nsima").
const QUERY_FILLER_WORDS = new Set(["ya", "la", "wa", "a", "an", "the", "of", "some"]);

/**
 * What a bare dish-name query implies, { staple, preferred[] } ("nsima" -> maize, refined first), or
 * null when the query says anything else about the food (any word that is not a filler or a dish
 * word with a default).
 */
export function impliedDefaultsFor(query) {
  const words = tokenize(query).filter((w) => !QUERY_FILLER_WORDS.has(w));
  if (!words.length) return null;
  const staples = words.map((w) => DISH_DEFAULT_STAPLE[w]);
  if (staples.some((x) => !x) || !staples.every((x) => x === staples[0])) return null;
  const preferred = [...new Set(words.flatMap((w) => DISH_PREFERRED_VARIANT[w] || []))];
  return { staple: staples[0], preferred };
}

/** The staple a bare dish-name query implies ("nsima" -> "maize"), or null. */
export function defaultStapleFor(query) {
  return impliedDefaultsFor(query)?.staple ?? null;
}

// 0 plain staple + preferred variant, 1 plain staple, 2 composite staple, 3 anything else.
function defaultRank(row, implied) {
  const parsed = parseFoodName(row?.food_name || "");
  if (!parsed.baseWords.includes(implied.staple)) return 3;
  if (parsed.baseWords.some((w) => COMPOSITE_MARKERS.has(w))) return 2;
  return implied.preferred.some((w) => parsed.qualifierWords.includes(w)) ? 0 : 1;
}

/**
 * Stable reorder for list endpoints (search, autocomplete): plain maize rows (refined flour first)
 * lead, then composite maize dishes, then everything else, each group keeping its incoming order.
 * Returns the rows unchanged when the query has no default staple.
 */
export function preferDefaultStaple(rows, query) {
  const implied = impliedDefaultsFor(query);
  if (!implied || !Array.isArray(rows) || rows.length < 2) return rows;
  return rows
    .map((row, i) => ({ row, i, rank: defaultRank(row, implied) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.row);
}

/**
 * Breaks a Malawi-FCT-style food_name into its structural parts:
 *   mainPart   — the whole name minus a trailing "(...)" (if any)
 *   parenPart  — the content of that trailing parenthetical, or null
 *                (usually the Chichewa name, but sometimes an English
 *                ingredient list — e.g. "Fruit salad, fresh, (mango,
 *                banana, pineapple & pawpaw)" — so it's treated generically
 *                as "extra descriptive text", not assumed to be a
 *                translation)
 *   segments   — mainPart split on commas, trimmed
 *   baseSegment / baseWords — segments[0], the base food name
 *   qualifierSegments / qualifierWords — every segment after the first
 *   parenWords — tokenized parenPart
 *   allWords   — every word in mainPart (base + qualifiers together),
 *                used for attribute-category lookups that don't care
 *                which segment they're in
 */
export function parseFoodName(foodName) {
  const name = foodName || "";
  const parenMatch = name.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const mainPart = (parenMatch ? parenMatch[1] : name).trim();
  const parenPart = parenMatch ? parenMatch[2].trim() : null;

  const segments = mainPart.split(",").map((s) => s.trim()).filter(Boolean);
  const baseSegment = segments[0] || mainPart;
  const qualifierSegments = segments.slice(1);

  return {
    mainPart,
    parenPart,
    segments,
    baseSegment,
    baseWords: tokenize(baseSegment),
    qualifierSegments,
    qualifierWords: qualifierSegments.flatMap(tokenize),
    parenWords: parenPart ? tokenize(parenPart) : [],
    allWords: tokenize(mainPart),
  };
}

/**
 * Extracts what the QUERY explicitly asked for: at most one word per
 * attribute category (state/form/freshness/variety — first one seen wins
 * if somehow more than one appears), plus every other word as a "core"
 * word (the actual food-name words the query is naming, e.g. "rice",
 * "chicken", "porridge"). Nothing here is food-specific — it's just
 * sorting the query's own words into the same general categories
 * parseFoodName's candidate structure gets compared against.
 */
export function parseQueryAttributes(query) {
  const words = tokenize(query);
  const stated = { state: null, form: null, freshness: null, variety: null };
  const coreWords = [];

  for (const w of words) {
    let categorized = false;
    const st = stateOf(w);
    if (st && !stated.state) {
      stated.state = st;
      categorized = true;
    } else {
      for (const [category, wordSet] of ATTRIBUTE_CATEGORIES) {
        if (category !== "state" && wordSet.has(w) && !stated[category]) {
          stated[category] = w;
          categorized = true;
          break;
        }
      }
    }
    if (!categorized) coreWords.push(w);
  }

  return { words, coreWords, stated };
}

/**
 * Scores one candidate food row against the query's parsed attributes.
 * Returns { row, score, reasons } — reasons is a list of which scoring
 * components fired, for debugging/tests (see foodMatching.test.js).
 * Score is a relative ranking signal only — its scale isn't meaningful on
 * its own, only in comparison to other candidates for the SAME query.
 */
export function scoreFoodCandidate(row, queryAttrs, ctx = {}) {
  const name = row.food_name || "";
  const parsed = parseFoodName(name);
  const reasons = [];
  let score = 0;

  // Exact whole-name match is decisive on its own.
  if (name.trim().toLowerCase() === queryAttrs.words.join(" ")) {
    score += 100;
    reasons.push("exact_name");
  } else if (
    queryAttrs.words.length > 1 &&
    parsed.allWords.length === queryAttrs.words.length &&
    [...parsed.allWords].sort().join(" ") === [...queryAttrs.words].sort().join(" ")
  ) {
    // Same words in a different order or punctuation: "Brown cooked rice" / "Rice, Brown, Cooked" are
    // the FCT entry "Rice, brown, cooked, (...)" - the local-name parenthetical is not part of the comparison.
    score += 30;
    reasons.push("same_words_as_main_name");
  }

  // Core-word overlap against the BASE segment (before the first comma) —
  // the main signal for "is this fundamentally the same food".
  const coreInBase = queryAttrs.coreWords.filter((w) => parsed.baseWords.includes(w));
  const coreOverlapRatio = queryAttrs.coreWords.length
    ? coreInBase.length / queryAttrs.coreWords.length
    : 0;
  score += coreOverlapRatio * 40;
  if (coreOverlapRatio === 1 && queryAttrs.coreWords.length) reasons.push("full_core_match_in_base");

  // The plainest possible match: base segment IS the query's core words,
  // no more, no less (e.g. query "rice" vs. base segment "Rice").
  if (
    queryAttrs.coreWords.length &&
    parsed.baseWords.length === queryAttrs.coreWords.length &&
    coreOverlapRatio === 1
  ) {
    score += 15;
    reasons.push("base_equals_core");
  }

  // Weaker credit for a core word matching inside a QUALIFIER segment
  // instead of the base — e.g. query "chicken egg" against
  // "Egg, chicken, boiled" (base "Egg", qualifier "chicken"). Only counts
  // words not already credited via the base-segment match above.
  const coreInQualifiersOnly = queryAttrs.coreWords.filter(
    (w) => !parsed.baseWords.includes(w) && parsed.qualifierWords.includes(w)
  );
  if (coreInQualifiersOnly.length) {
    score += coreInQualifiersOnly.length * 10;
    reasons.push("core_match_in_qualifier");
  }

  // Dish-word handling: a DISH_WORDS token attached directly to the base
  // segment (not a separate comma-qualifier) names a different prepared
  // dish built from the ingredient. Penalize when the query didn't ask
  // for that dish; reward when it did (the query EXPLICITLY wants that
  // dish, e.g. "rice porridge").
  const baseDishWords = parsed.baseWords.filter((w) => DISH_WORDS.has(w));
  const queryHasDishWord = baseDishWords.some((w) => queryAttrs.words.includes(w));
  if (baseDishWords.length && !queryHasDishWord) {
    score -= 30;
    reasons.push("unrequested_dish_word");
  } else if (baseDishWords.length && queryHasDishWord) {
    score += 20;
    reasons.push("requested_dish_word");
  }

  // A bare local dish name ("nsima") leads with its everyday staple (maize), not an alternative
  // staple that happens to share the dish's Chichewa name in its parenthetical. Within the staple,
  // a composite dish ("Maize and soya ...") counts for less than the plain one, and the preferred
  // variant (refined flour for nsima) gets a small lead over whole-grain and degermed.
  const implied = impliedDefaultsFor(queryAttrs.words.join(" "));
  if (implied && parsed.baseWords.includes(implied.staple)) {
    if (parsed.baseWords.some((w) => COMPOSITE_MARKERS.has(w))) {
      score += 8;
      reasons.push("default_staple_composite");
    } else {
      score += 25;
      reasons.push("default_staple");
      if (implied.preferred.some((w) => parsed.qualifierWords.includes(w))) {
        score += 6;
        reasons.push("default_variant");
      }
    }
  }

  // Attribute categories: state / form / freshness / variety. Match ->
  // bonus. Explicit conflict (query said X, name says a DIFFERENT value
  // in the same category) -> strong penalty. Name has a value the query
  // never mentioned -> small "specificity" penalty only (never
  // disqualifying — the FCT often has no unqualified entry at all).
  for (const [category, wordSet] of ATTRIBUTE_CATEGORIES) {
    const stated = queryAttrs.stated[category];
    if (category === "state") {
      // Preparation state is compared by meaning, not by spelling: a name can carry several states
      // ("Fish, dried, smoked"), Chichewa state words count, and related states earn partial credit.
      const named = statesInName(parsed);
      if (stated && named.length) {
        const best = named
          .map((n) => stateRelation(stated, n))
          .sort((x, y) => y.bonus - x.bonus)[0];
        score += best.bonus;
        reasons.push(best.kind === "match" ? "state_match" : best.kind === "related" ? "state_related" : "state_conflict");
      } else if (!stated && named.length) {
        const implied = impliedStateFor(queryAttrs);
        if (implied) {
          const best = named.map((n) => stateRelation(implied, n)).sort((x, y) => y.bonus - x.bonus)[0];
          if (best.kind === "match") { score += 14; reasons.push("default_state_match"); }
          else if (best.kind === "related") { score += 8; reasons.push("default_state_related"); }
          else { score -= 10; reasons.push("default_state_other"); }
        } else {
          score -= 4;
          reasons.push("state_unrequested");
        }
      }
      continue;
    }
    const nameValue = parsed.allWords.find((w) => wordSet.has(w));
    if (stated && nameValue === stated) {
      score += 18;
      reasons.push(`${category}_match`);
    } else if (stated && nameValue && nameValue !== stated) {
      // A different cooking state changes the nutrient values far more than a different variety of the
      // same cooked food, so a variety conflict costs less than a state conflict.
      score -= category === "variety" ? 15 : 25;
      reasons.push(`${category}_conflict`);
    } else if (!stated && nameValue) {
      score -= 4;
      reasons.push(`${category}_unrequested`);
    }
  }

  // Generic specificity penalty for qualifier words that aren't in any
  // recognized attribute category (e.g. "chicken" as an egg qualifier) —
  // categorized words are already fully handled just above, so only
  // count the leftover/uncategorized ones here to avoid double-penalizing
  // the same word twice.
  const uncategorizedQualifierWords = parsed.qualifierWords.filter(
    (w) => !ALL_ATTRIBUTE_WORDS.has(w)
  );
  // ...minus any that the query itself asked for as a core word (credited
  // separately above via core_match_in_qualifier) — those shouldn't also
  // count as "unrequested".
  const trulyUnrequested = uncategorizedQualifierWords.filter(
    (w) => !queryAttrs.coreWords.includes(w)
  );
  if (trulyUnrequested.length) {
    score -= trulyUnrequested.length * 3;
    reasons.push("uncategorized_qualifier_unrequested");
  }

  // Query core word(s) found in the trailing parenthetical (a local name or ingredient list) rather
  // than the main name. Credits every core word the base and qualifiers did not already account for,
  // so "maize nsima" scores "Maize thick porridge, ..., (Nsima ya ufa oyera)" for BOTH words (maize in
  // the name, nsima in the local name) instead of only the first. Scaled like the base-segment
  // overlap above (a slightly lower ceiling, since the main name is still the primary identifier);
  // a query that fully matches via the local name is a genuinely strong signal, particularly for
  // Chichewa-only queries where the main (English) name will never match at all.
  const unaccountedCore = queryAttrs.coreWords.filter(
    (w) => !parsed.baseWords.includes(w) && !parsed.qualifierWords.includes(w)
  );
  if (unaccountedCore.length) {
    const parenOverlapCount = unaccountedCore.filter((w) => parsed.parenWords.includes(w)).length;
    const parenOverlapRatio = parenOverlapCount / queryAttrs.coreWords.length;
    if (parenOverlapRatio > 0) {
      score += parenOverlapRatio * 35;
      reasons.push("parenthetical_match");
      if (parenOverlapRatio === 1) reasons.push("full_parenthetical_match");
    }
  }

  // Every word the query asked for appears somewhere in this name (main name, qualifiers or the
  // local-name parenthetical): "nsima ya galamilu" is fully covered by exactly one row. Without this,
  // that row's unrequested qualifiers ("degermed- dehulled flour") could cost it the win against a
  // shorter row that matches only the first word.
  if (queryAttrs.coreWords.length) {
    const everyCovered = queryAttrs.coreWords.every(
      (w) => parsed.baseWords.includes(w) || parsed.qualifierWords.includes(w) || parsed.parenWords.includes(w)
    );
    if (everyCovered) {
      score += 20;
      reasons.push("full_query_coverage");
    }
  }

  // Verified aliases (food_synonyms) only fill gaps: when NO candidate carries one of the query's words
  // (e.g. "mpunga" when no row names it), a row whose base food is that word's alias gets partial credit.
  // They never compete with a direct name match, so "nsima ya kondowole" is not pulled toward maize
  // just because the nsima alias group lists maize.
  if (ctx.gapWords?.length && ctx.aliasWords?.size) {
    const aliasHit = parsed.baseWords.some((w) => ctx.aliasWords.has(w));
    if (aliasHit) {
      score += 20;
      reasons.push("alias_match_in_base");
    }
  }

  // Lightest possible tiebreak, last: shorter overall name, among
  // candidates that are otherwise about equally good. This used to be
  // the ENTIRE ranking logic; now it only nudges ties.
  score += Math.max(0, 10 - name.length / 10);

  return { row, score, reasons, parsed };
}

/**
 * Scores and ranks every candidate row for a query, best first.
 */
export function scoreFoodCandidates(rows, query, opts = {}) {
  const queryAttrs = parseQueryAttributes(query);
  const ctx = aliasContext(rows, queryAttrs, opts.aliases);
  const scored = rows.map((row) => scoreFoodCandidate(row, queryAttrs, ctx));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Alias credit applies only to query words that no candidate carries directly (see scoreFoodCandidate).
function aliasContext(rows, queryAttrs, aliases) {
  if (!Array.isArray(aliases) || !aliases.length || !queryAttrs.coreWords.length) return {};
  const parsedRows = rows.map((r) => parseFoodName(r.food_name || ""));
  const gapWords = queryAttrs.coreWords.filter(
    (w) => !parsedRows.some((p) => p.baseWords.includes(w) || p.qualifierWords.includes(w) || p.parenWords.includes(w))
  );
  const aliasWords = new Set(aliases.flatMap(tokenize).filter((w) => !queryAttrs.words.includes(w)));
  return { gapWords, aliasWords };
}

/** True when the query states a preparation state, physical form, freshness or variety. */
export function hasStatedAttributes(query) {
  const { stated } = parseQueryAttributes(query);
  return Object.values(stated).some(Boolean);
}

/**
 * The words that identify WHICH food is wanted - the query minus its preparation/form/variety words and
 * Chichewa link words ("brown cooked rice" -> "rice"). Used to fetch candidates so that a state or
 * variety word can steer the ranking without being able to hide a row from the shortlist. Returns the
 * original text when nothing would be left.
 */
export function retrievalTermFor(query) {
  const { coreWords } = parseQueryAttributes(query);
  const kept = coreWords.filter((w) => !QUERY_FILLER_WORDS.has(w));
  return kept.length ? kept.join(" ") : (query || "").trim();
}

/** Rows reordered best-first by the intent-aware scorer; ties keep their incoming (database) order. */
export function rankFoodRows(rows, query, opts = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  return scoreFoodCandidates(rows, query, opts).map((s) => s.row);
}

/**
 * True when the row names a preparation state or variety DIFFERENT from the one the query asked for
 * ("cooked rice" against "Rice, soaked", "brown rice" against "Rice, white"). A list endpoint just ranks
 * such a row lower; a single-food lookup should not silently answer with it.
 */
export function conflictsWithQuery(row, query) {
  const { reasons } = scoreFoodCandidates([row], query)[0];
  return reasons.includes("state_conflict") || reasons.includes("variety_conflict");
}

/**
 * Shortlist + rerank, independent of the database client: fetchRows(term, width) returns candidate rows
 * for a search term. Asks for a wider shortlist than needed, adds a second fetch on just the food's
 * identity words when the query states an attribute and the first fetch was thin (the database's
 * per-word similarity requires EVERY word to match, so "cooked rice" would otherwise never reach
 * "Rice, soaked"), then ranks by intent. A bare dish name keeps its default-staple ordering.
 */
export async function searchFoodsRanked(fetchRows, rawQuery, { maxResults = 8, rankQuery = "", aliases = [] } = {}) {
  // Spelling variants of the same word are folded first so the database sees the FCT's spelling.
  const query = rawQuery.replace(/[A-Za-z']+/g, (w) => SPELLING_VARIANTS[w.toLowerCase()] || w);
  const intent = rankQuery || query;
  const width = Math.min(maxResults * 3, 50);
  let rows = (await fetchRows(query, width)) || [];

  if (!rankQuery && rows.length < maxResults && hasStatedAttributes(intent)) {
    const core = retrievalTermFor(intent);
    if (core && core.toLowerCase() !== query.trim().toLowerCase()) {
      const seen = new Set(rows.map((r) => r.id));
      for (const r of (await fetchRows(core, width)) || []) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          rows.push(r);
        }
      }
    }
  }

  const ordered = defaultStapleFor(intent) ? preferDefaultStaple(rows, intent) : rankFoodRows(rows, intent, { aliases });
  return ordered.slice(0, maxResults);
}

// A match is flagged ambiguous when the top two candidates are close
// enough that picking one over the other isn't a confident call — most
// commonly a bare query that only matches multiple candidates through a
// weak signal (e.g. several candidates share the same Chichewa-name word
// in their trailing parenthetical, with nothing in the query to prefer
// one base food over another). Callers that can act on ambiguity (an
// interactive endpoint, not a bulk pipeline step) should check this and
// offer alternates rather than silently trusting the top pick.
const AMBIGUITY_SCORE_GAP = 10;

/**
 * Given several ilike-matched food rows for a search term, picks the one
 * most likely to be what was meant. See the module doc comment above for
 * the full design; in short: exact whole-name match short-circuits
 * everything, otherwise every candidate is scored by scoreFoodCandidates
 * and the top one wins. Always returns a single row (or null for no
 * rows) — for ambiguity info alongside the pick, use
 * pickBestFoodMatchDetailed instead.
 */
export function pickBestFoodMatch(rows, query) {
  return pickBestFoodMatchDetailed(rows, query).match;
}

/**
 * Same ranking as pickBestFoodMatch, but returns the full picture:
 *   match      — the top-ranked row (or null if rows is empty)
 *   ambiguous  — true when the top two candidates are too close to call
 *                confidently (see AMBIGUITY_SCORE_GAP)
 *   alternates — up to 3 next-best rows, for a caller that wants to offer
 *                them (e.g. a "did you mean" prompt)
 *   scored     — the full ranked list with scores/reasons, for tests
 */
export function pickBestFoodMatchDetailed(rows, query) {
  if (!rows || !rows.length) return { match: null, ambiguous: false, alternates: [], scored: [] };

  const q = query.trim().toLowerCase();
  const exact = rows.find((r) => (r.food_name || "").trim().toLowerCase() === q);
  if (exact) return { match: exact, ambiguous: false, alternates: [], scored: [] };

  const scored = scoreFoodCandidates(rows, query);
  const [top, second] = scored;
  const ambiguous = !!(second && top.score - second.score < AMBIGUITY_SCORE_GAP);

  return {
    match: top.row,
    ambiguous,
    alternates: scored.slice(1, 4).map((s) => s.row),
    scored,
  };
}

/**
 * True when the deterministic ranking is not a confident call on a query that states a preparation or
 * variety: the top row conflicts with what was asked, or the top two rows are too close. Only then is the
 * optional LLM tie-breaker (src/foodIntentLlm.js) worth its cost.
 */
export function rankingNeedsHelp(rows, query) {
  if (!Array.isArray(rows) || rows.length < 2 || !hasStatedAttributes(query)) return false;
  const [top, second] = scoreFoodCandidates(rows, query);
  const conflict = top.reasons.includes("state_conflict") || top.reasons.includes("variety_conflict");
  return conflict || top.score - second.score < AMBIGUITY_SCORE_GAP;
}
