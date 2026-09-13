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

function tokenize(s) {
  return (s || "").toLowerCase().match(/[a-z']+/g) || [];
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
    for (const [category, wordSet] of ATTRIBUTE_CATEGORIES) {
      if (wordSet.has(w) && !stated[category]) {
        stated[category] = w;
        categorized = true;
        break;
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
export function scoreFoodCandidate(row, queryAttrs) {
  const name = row.food_name || "";
  const parsed = parseFoodName(name);
  const reasons = [];
  let score = 0;

  // Exact whole-name match is decisive on its own.
  if (name.trim().toLowerCase() === queryAttrs.words.join(" ")) {
    score += 100;
    reasons.push("exact_name");
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

  // Attribute categories: state / form / freshness / variety. Match ->
  // bonus. Explicit conflict (query said X, name says a DIFFERENT value
  // in the same category) -> strong penalty. Name has a value the query
  // never mentioned -> small "specificity" penalty only (never
  // disqualifying — the FCT often has no unqualified entry at all).
  for (const [category, wordSet] of ATTRIBUTE_CATEGORIES) {
    const stated = queryAttrs.stated[category];
    const nameValue = parsed.allWords.find((w) => wordSet.has(w));
    if (stated && nameValue === stated) {
      score += 18;
      reasons.push(`${category}_match`);
    } else if (stated && nameValue && nameValue !== stated) {
      score -= 25;
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

  // Fallback: query core word(s) found in the trailing parenthetical (a
  // local name or ingredient list) rather than the main name. Scaled the
  // same way as the base-segment overlap above (just a slightly lower
  // ceiling, since the main name is still the primary identifier) — a
  // query that fully matches via the local name is a genuinely strong
  // signal, not a token afterthought, particularly for Chichewa-only
  // queries where the main (English) name will never match at all.
  if (coreOverlapRatio === 0 && !coreInQualifiersOnly.length && queryAttrs.coreWords.length) {
    const parenOverlapCount = queryAttrs.coreWords.filter((w) => parsed.parenWords.includes(w)).length;
    const parenOverlapRatio = parenOverlapCount / queryAttrs.coreWords.length;
    if (parenOverlapRatio > 0) {
      score += parenOverlapRatio * 35;
      reasons.push("parenthetical_match");
      if (parenOverlapRatio === 1) reasons.push("full_parenthetical_match");
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
export function scoreFoodCandidates(rows, query) {
  const queryAttrs = parseQueryAttributes(query);
  const scored = rows.map((row) => scoreFoodCandidate(row, queryAttrs));
  scored.sort((a, b) => b.score - a.score);
  return scored;
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
