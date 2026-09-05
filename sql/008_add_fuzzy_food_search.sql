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
-- Returns foods rows ranked by word similarity first, Levenshtein distance
-- as the tiebreaker, for a fast + intuitive "closest match" order.
--
-- Uses word_similarity()/the <% operator rather than plain similarity()/%.
-- food_name values here are full FCT descriptions, e.g.
-- "Cassava, tuber, raw, (Chinangwa chachiwisi)" — a short query like
-- "Chinagwa" is nowhere near similar to that WHOLE string (plain similarity
-- scores it ~0.19, below any sane threshold), even though it's a
-- near-perfect match for the "Chinangwa" part. word_similarity finds the
-- best-matching substring/extent within the longer string instead of
-- comparing the two strings as wholes, which is what this data actually
-- needs. min_similarity is pg_trgm's 0–1 score (higher = closer); 0.3 is a
-- permissive default that still tolerates a couple of typos/missing
-- letters in short Chichewa/English food names.
create or replace function public.fuzzy_food_search(
  search_term text,
  max_results int default 8,
  min_similarity real default 0.3
)
returns setof public.foods
language plpgsql
as $$
begin
  -- SET LOCAL scopes pg_trgm's word-similarity threshold to this
  -- transaction only, so the <% operator below (which is what lets the
  -- planner use the GIN trigram index instead of scanning the whole table)
  -- honours min_similarity instead of pg_trgm's default 0.6 cutoff. EXECUTE
  -- is required because SET doesn't accept a bound parameter directly.
  execute format('set local pg_trgm.word_similarity_threshold = %L', min_similarity);

  return query
    select f.*
    from public.foods f
    where search_term <% f.food_name
    order by
      word_similarity(search_term, f.food_name) desc,
      levenshtein(lower(f.food_name), lower(search_term)) asc
    limit max_results;
end;
$$;

comment on function public.fuzzy_food_search is
  'Typo-tolerant search over public.foods: pg_trgm similarity to shortlist (indexed), levenshtein() edit distance to rank. Used by GET /foods/search and as a fallback tier in lookupFoodCascade when the exact ilike match misses.';
