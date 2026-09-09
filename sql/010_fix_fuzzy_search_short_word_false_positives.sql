-- Chakudya Nutrition Registry
-- Migration: fix fuzzy_food_search() false positives on short query words.
--
-- Bug (reported Sept 2026): "Yams" and "Yam plant" return no real yam
-- entry (there isn't one in the Malawi FCT) but instead surface a
-- completely unrelated food with apparent confidence — e.g.
-- "Yams" -> "Beef, raw, (Nyama ya ng'ombe)", "Yam plant" -> "Plantain
-- and beef casserole". Root cause: food_name stores an "English,
-- (Chichewa)" pair in one string, and word_similarity() (used by
-- fuzzy_food_search since 008/009) scores a query word against the
-- BEST-MATCHING SUBSTRING of food_name, not a real word boundary.
-- "yam" is a literal substring of "nyama" (n-YAM-a, Chichewa for
-- "meat") purely by spelling coincidence, and with a short 3-4 letter
-- query word there are so few trigrams that one lucky substring hit
-- is enough to clear the 0.35 per-word floor. Same mechanism explains
-- "plant" scoring well against "Plantain".
--
-- Fix: switch from word_similarity()/<% to strict_word_similarity()/<<%.
-- Unlike word_similarity, strict_word_similarity requires the match to
-- extend to an actual word boundary in the target, so "yam" no longer
-- scores well against "nyama" unless the query word genuinely IS that
-- whole word (or a typo-distance variant of it) rather than a lucky
-- inner substring. This is the standard pg_trgm fix for this class of
-- short-word false positive, and doesn't change behavior for the
-- genuine typo-tolerance cases 008 was built for ("Chinagwa" ->
-- Cassava, "bananna" -> banana foods, etc. still match, since those
-- typos are still within word-boundary edit distance).
--
-- Safe to re-run: CREATE OR REPLACE.

create or replace function public.fuzzy_food_search(
  search_term text,
  max_results int default 8,
  min_similarity real default 0.35,
  category_filter text default null
)
returns setof public.foods
language plpgsql
as $$
declare
  term text := nullif(trim(coalesce(search_term, '')), '');
begin
  if term is not null then
    execute format('set local pg_trgm.strict_word_similarity_threshold = %L', least(min_similarity, 0.3));
  end if;

  return query
    select f.*
    from public.foods f
    where (category_filter is null or f.category ilike category_filter)
      and (
        term is null
        or (
          term <<% f.food_name
          and (
            select min(strict_word_similarity(tok, f.food_name))
            from regexp_split_to_table(lower(term), '\s+') as tok
            where length(tok) > 0
          ) >= min_similarity
        )
      )
    order by
      case when term is null then null else (
        select min(strict_word_similarity(tok, f.food_name))
        from regexp_split_to_table(lower(term), '\s+') as tok
        where length(tok) > 0
      ) end desc nulls last,
      case when term is null then null else levenshtein(lower(f.food_name), lower(term)) end asc nulls last,
      f.food_name asc
    limit max_results;
end;
$$;

comment on function public.fuzzy_food_search is
  'Typo-tolerant + category-filterable search over public.foods. Uses strict_word_similarity (word-boundary anchored, see sql/010) instead of word_similarity to avoid a short query word false-matching an unrelated word''s inner substring (e.g. "yam" inside "nyama"). search_term optional (null/blank = browse category_filter with no text match); category_filter optional. Used by GET /foods/search and GET /foods/by-category, and as a fallback tier in lookupFoodCascade.';
