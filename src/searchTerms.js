// Caps the per-keyword food/packaged lookups in /rag/ask.
//
// multiKeywordFoodSearch() runs one Supabase call per keyword for `foods` and
// another per keyword for `packaged_foods`. Cloudflare limits how many outbound
// calls one Worker invocation may make (50 on the Free plan), so a long query
// can exhaust it before the answer is generated. Thanzi Coach appends a ~30-word
// instruction to any question containing "and", which turns a 5-keyword question
// into a 23-keyword one (about 46 calls just for these two lookups) and
// produced "LLM answer unavailable: Too many subrequests".
//
// Keeping the FIRST distinct keywords preserves the user's own words, because
// any appended instruction comes last. Semantic search still covers the rest.

export const MAX_FOOD_SEARCH_TERMS = 6;

export function capSearchTerms(keywords, max = MAX_FOOD_SEARCH_TERMS) {
  return [...new Set(keywords)].slice(0, max);
}
