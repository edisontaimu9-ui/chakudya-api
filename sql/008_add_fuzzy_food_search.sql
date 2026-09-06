-- Chakudya Nutrition Registry
-- Migration: fuzzy, typo-tolerant search over public.foods (Malawi FCT).
--
-- Today, GET /foods/lookup and every other local food search does a plain
-- `ilike '%term%'` substring match. That only finds a food if the query is
-- an exact substring of its name — a misspelling like "Chinagwa" (missing
-- an n) or "Nsima ya Kondewole" (wrong vowel) returns nothing, even though
-- the real food exists, and the request then falls through to external
-- APIs (USDA/OFF/FatSecret) that don't know Chichewa food names either.
--
-- This adds a two-stage fuzzy match, both native to Postgres:
--   1. pg_trgm trigram similarity — fast and indexed (GIN), used to
--      shortlist candidates so this stays cheap even as the table grows.
--   2. fuzzystrmatch's levenshtein() — exact edit distance, used to
--      fine-rank the shortlist so the closest spelling wins.
-- Safe to re-run: extension/index/function creation all use IF NOT EXISTS
-- or CREATE OR REPLACE.

create extension if not exists pg_trgm;
create extension if not exists fuzzystrmatch;

-- Trigram GIN index on food_name — what makes stage 1 fast instead of a
-- sequential scan over every row.
create index if not exists foods_food_name_trgm_idx
  on public.foods using gin (food_name gin_trgm_ops);

-- fuzzy_food_search(search_term, max_results, min_similarity)
-- Returns foods rows ranked by per-word similarity, Levenshtein distance as
-- the tiebreaker, for a fast + intuitive "closest match" order.
--
-- Why per-word, not whole-query, similarity:
-- An earlier version scored the whole query against food_name with a
-- single word_similarity() call. That broke on multi-word queries where
-- one word is common across many foods — "Boiled rice" scored HIGHER
-- against "Beans, boiled, (Nyemba zowilitsa)" (0.58) than against any
-- actual rice entry (0.42), because "boiled" appears verbatim in dozens of
-- foods and dominated the score while "rice" (0 overlap with "Beans...")
-- was ignored. In production this meant the bot would confidently return
-- beans for a rice query instead of admitting it didn't have a good match.
--
-- Fix: split the query into words, score each word against food_name
-- independently, and require the WEAKEST word's score to still clear
-- min_similarity. A food only qualifies if every word in the query is
-- actually represented in it — "Boiled rice" then correctly matches
-- nothing (Malawi FCT says "Rice, ..., cooked", not "Boiled rice", so
-- there's no real match — the query falls through to the next tier
-- instead of guessing) while single-word typos and multi-word phrases
-- where every word genuinely belongs still resolve correctly:
--   "Chinagwa"            -> Cassava, tuber, raw, (Chinangwa chachiwisi)
--   "Rice poridge"        -> Rice porridge, (Phala la mpunga)
--   "Nsima ya Kondewole"  -> Cassava thick porridge, (Nsima ya kondowole)
--   "Ufa woera"           -> Flour, ..., (Ufa woyera)
--   "bananna"             -> Milkshake, banana / Banana fritters / ...
-- min_similarity is pg_trgm's 0–1 word_similarity score (higher = closer);
-- 0.35 tolerates a missing/swapped letter per word without letting an
-- unrelated word sneak through on a different word's high score.
create or replace function public.fuzzy_food_search(
  search_term text,
  max_results int default 8,
  min_similarity real default 0.35
)
returns setof public.foods
language plpgsql
as $$
begin
  -- SET LOCAL scopes pg_trgm's word-similarity threshold to this
  -- transaction only. It's set to (at most) min_similarity so the <%
  -- operator below — which is what lets the planner use the GIN trigram
  -- index instead of scanning the whole table — doesn't pre-filter out
  -- rows before the real per-word check runs. The per-word MIN check
  -- afterwards is what actually enforces min_similarity precisely.
  execute format('set local pg_trgm.word_similarity_threshold = %L', least(min_similarity, 0.3));

  return query
    select f.*
    from public.foods f
    where search_term <% f.food_name
      and (
        select min(word_similarity(tok, f.food_name))
        from regexp_split_to_table(lower(trim(search_term)), '\s+') as tok
        where length(tok) > 0
      ) >= min_similarity
    order by
      (
        select min(word_similarity(tok, f.food_name))
        from regexp_split_to_table(lower(trim(search_term)), '\s+') as tok
        where length(tok) > 0
      ) desc,
      levenshtein(lower(f.food_name), lower(search_term)) asc
    limit max_results;
end;
$$;

comment on function public.fuzzy_food_search is
  'Typo-tolerant search over public.foods: pg_trgm similarity to shortlist (indexed), levenshtein() edit distance to rank. Used by GET /foods/search and as a fallback tier in lookupFoodCascade when the exact ilike match misses.';
