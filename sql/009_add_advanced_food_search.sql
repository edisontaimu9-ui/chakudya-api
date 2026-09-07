-- Chakudya Nutrition Registry
-- Migration: Advanced food search & autocomplete.
--
-- Builds on 008_add_fuzzy_food_search.sql. That migration made GET
-- /foods/search typo-tolerant over public.foods.food_name only. This one
-- rounds search out to what a real "search bar" needs:
--
--   1. category_filter added to fuzzy_food_search()      -> food-category search
--   2. fuzzy_food_search() search_term now optional       -> category-only browse
--   3. fuzzy_packaged_search()  (new)                     -> brand search,
--      product-name search, and ingredient search, all over packaged_foods
--   4. autocomplete_food_names() / autocomplete_packaged_names() (new)  ->
--      fast as-you-type prefix/substring suggestions, ranked so a
--      whole-name-prefix match ("Nsima") outranks a match buried inside a
--      longer name ("..., (Nsima ya kondowole)"), which in turn outranks
--      one further into the string.
--   5. food_synonyms table (new)                          -> Chichewa <->
--      English local-name mapping for terms that AREN'T already embedded
--      in food_name's "English, (Chichewa)" convention, or that are too
--      different in spelling for pg_trgm/levenshtein to bridge (e.g.
--      "ndiwo" for a relish/side dish, "chips" for fried Irish potato).
--
-- Safe to re-run: extension/table/index/function creation all use
-- IF NOT EXISTS or CREATE OR REPLACE. The seed insert uses ON CONFLICT DO
-- NOTHING against the (group_key, term) unique constraint.

create extension if not exists pg_trgm;
create extension if not exists fuzzystrmatch;

-- ─── 1-2. fuzzy_food_search(): add optional category filter, make the text
-- query itself optional so "browse category X" and "search term within
-- category X" both go through one function. ──────────────────────────────
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
    execute format('set local pg_trgm.word_similarity_threshold = %L', least(min_similarity, 0.3));
  end if;

  return query
    select f.*
    from public.foods f
    where (category_filter is null or f.category ilike category_filter)
      and (
        term is null
        or (
          term <% f.food_name
          and (
            select min(word_similarity(tok, f.food_name))
            from regexp_split_to_table(lower(term), '\s+') as tok
            where length(tok) > 0
          ) >= min_similarity
        )
      )
    order by
      case when term is null then null else (
        select min(word_similarity(tok, f.food_name))
        from regexp_split_to_table(lower(term), '\s+') as tok
        where length(tok) > 0
      ) end desc nulls last,
      case when term is null then null else levenshtein(lower(f.food_name), lower(term)) end asc nulls last,
      f.food_name asc
    limit max_results;
end;
$$;

comment on function public.fuzzy_food_search is
  'Typo-tolerant + category-filterable search over public.foods. search_term is now optional (null/blank = browse category_filter with no text match); category_filter is optional (null = search all categories). Used by GET /foods/search and GET /foods/by-category, and as a fallback tier in lookupFoodCascade.';

-- ─── 3. fuzzy_packaged_search(): same per-word similarity approach, over
-- packaged_foods. search_field narrows which column(s) count toward a
-- match — 'brand' for brand search, 'ingredients' for ingredient search,
-- 'product' for product-name search, 'all' (default) for any of the three.
-- Only approved rows are returned, matching searchPackagedExact()'s existing
-- status=approved convention. ─────────────────────────────────────────────
create index if not exists packaged_foods_product_name_trgm_idx
  on public.packaged_foods using gin (product_name gin_trgm_ops);
create index if not exists packaged_foods_brand_trgm_idx
  on public.packaged_foods using gin (brand gin_trgm_ops);
create index if not exists packaged_foods_ingredients_text_trgm_idx
  on public.packaged_foods using gin (ingredients_text gin_trgm_ops);

create or replace function public.fuzzy_packaged_search(
  search_term text,
  max_results int default 8,
  min_similarity real default 0.3,
  search_field text default 'all'
)
returns table (
  packaged_food public.packaged_foods,
  matched_field text,
  score real
)
language plpgsql
as $$
declare
  term text := lower(trim(coalesce(search_term, '')));
begin
  if term = '' then
    return;
  end if;
  -- No <% shortlist operator here (unlike fuzzy_food_search) since matches
  -- can land in any of three columns per row — word_similarity() is called
  -- directly per column instead, which the trigram indexes above don't
  -- accelerate on their own. Fine in practice: packaged_foods (community/
  -- OCR submissions) is expected to stay far smaller than the Malawi FCT
  -- `foods` table for the foreseeable future.

  return query
    select p, m.field, m.field_score
    from public.packaged_foods p
    cross join lateral (
      select field, field_score
      from (
        values
          (
            'product',
            case when search_field in ('product', 'all') and p.product_name is not null then (
              select min(word_similarity(tok, p.product_name))
              from regexp_split_to_table(term, '\s+') as tok
              where length(tok) > 0
            ) end
          ),
          (
            'brand',
            case when search_field in ('brand', 'all') and p.brand is not null then (
              select min(word_similarity(tok, p.brand))
              from regexp_split_to_table(term, '\s+') as tok
              where length(tok) > 0
            ) end
          ),
          (
            'ingredients',
            case when search_field in ('ingredients', 'all') and p.ingredients_text is not null then (
              select min(word_similarity(tok, p.ingredients_text))
              from regexp_split_to_table(term, '\s+') as tok
              where length(tok) > 0
            ) end
          )
      ) as candidates(field, field_score)
      where field_score is not null and field_score >= min_similarity
      order by field_score desc
      limit 1
    ) as m(field, field_score)
    where p.status = 'approved'
    order by m.field_score desc
    limit max_results;
end;
$$;

comment on function public.fuzzy_packaged_search is
  'Typo-tolerant search over public.packaged_foods (approved rows only). search_field = product|brand|ingredients|all picks which column(s) count. Returns each match with the field that matched (matched_field) and its similarity score, so callers can label brand vs product vs ingredient hits. Used by GET /foods/search (brand=/ingredient= params).';

-- ─── 4. Autocomplete: fast as-you-type suggestions. Plain substring ILIKE
-- (accelerated by the trigram GIN indexes above/from migration 008) rather
-- than the fuzzy_*_search per-word similarity check, because autocomplete
-- runs on every keystroke and needs to stay cheap; typo tolerance for
-- autocomplete is layered on the JS side by backfilling with
-- fuzzy_food_search when this returns too few rows (see autocompleteFoodsLocal
-- in src/index.js). Ranking: whole-name prefix match first, then earliest
-- substring position, then shortest name. ────────────────────────────────
create or replace function public.autocomplete_food_names(
  prefix text,
  max_results int default 8
)
returns setof public.foods
language sql
stable
as $$
  select f.*
  from public.foods f
  where f.food_name ilike '%' || trim(prefix) || '%'
  order by
    (lower(f.food_name) like lower(trim(prefix)) || '%') desc,
    position(lower(trim(prefix)) in lower(f.food_name)) asc,
    length(f.food_name) asc
  limit max_results;
$$;

comment on function public.autocomplete_food_names is
  'Fast as-you-type suggestions over public.foods.food_name: substring ILIKE (trigram-indexed) ranked by whole-name-prefix match, then earliest match position, then shortest name. Not typo-tolerant by itself — see autocompleteFoodsLocal() in src/index.js for the fuzzy_food_search backfill tier.';

create or replace function public.autocomplete_packaged_names(
  prefix text,
  max_results int default 8
)
returns table (
  packaged_food public.packaged_foods,
  matched_field text
)
language sql
stable
as $$
  select p, case when p.product_name ilike '%' || trim(prefix) || '%' then 'product' else 'brand' end
  from public.packaged_foods p
  where p.status = 'approved'
    and (
      p.product_name ilike '%' || trim(prefix) || '%'
      or p.brand ilike '%' || trim(prefix) || '%'
    )
  order by
    (lower(coalesce(p.brand, '')) like lower(trim(prefix)) || '%'
     or lower(coalesce(p.product_name, '')) like lower(trim(prefix)) || '%') desc,
    length(coalesce(p.product_name, '')) asc
  limit max_results;
$$;

comment on function public.autocomplete_packaged_names is
  'Fast as-you-type suggestions over packaged_foods.product_name/brand (approved rows only). Used for brand-name autocomplete alongside autocomplete_food_names().';

-- ─── 5. food_synonyms: local-name / Chichewa<->English alias groups.
-- This is deliberately a *query-expansion* table, not a foreign-key link to
-- specific foods rows: each row just says "these terms mean the same
-- kind of food". App code (expandSynonyms() in src/index.js) looks up which
-- group(s) a query term belongs to, then re-runs the normal fuzzy/substring
-- search for every other term in that group too, merging results. That
-- keeps this table simple to grow (anyone can INSERT a new row) without
-- ever needing to know or maintain real foods.id values, and a term that
-- happens to match nothing in `foods` is harmless — it just contributes no
-- extra results. ───────────────────────────────────────────────────────────
create table if not exists public.food_synonyms (
  id bigserial primary key,
  group_key text not null,
  term text not null,
  language text not null default 'en',
  created_at timestamptz not null default now(),
  constraint food_synonyms_group_term_unique unique (group_key, term)
);

create index if not exists food_synonyms_term_trgm_idx
  on public.food_synonyms using gin (term gin_trgm_ops);
create index if not exists food_synonyms_group_key_idx
  on public.food_synonyms (group_key);

comment on table public.food_synonyms is
  'Query-expansion pairs for cross-language/local-name search (Chichewa <-> English, common slang). Not linked to foods.id by design — see comment above. group_key clusters terms that should expand into each other; language is informational (ny = Chichewa, en = English) for future UI use (e.g. showing "also known as...").';

-- Starter seed. Deliberately conservative: staple/common Malawian foods
-- where the mapping is well-known, plus a few informal/slang terms that
-- fall outside food_name's "English, (Chichewa)" convention and outside
-- pg_trgm/levenshtein's reach (too few shared letters to score as similar).
-- Extend this table freely as real search logs surface more gaps — it's
-- just INSERT statements, no code change needed to add a term.
insert into public.food_synonyms (group_key, term, language) values
  ('nsima',       'nsima', 'ny'),
  ('nsima',       'sima', 'ny'),
  ('nsima',       'maize porridge', 'en'),
  ('nsima',       'chimanga', 'ny'),
  ('nsima',       'maize', 'en'),
  ('nsima',       'ufa', 'ny'),
  ('nsima',       'maize flour', 'en'),
  ('cassava',     'chinangwa', 'ny'),
  ('cassava',     'cassava', 'en'),
  ('cassava',     'kondowole', 'ny'),
  ('sweet_potato','mbatata', 'ny'),
  ('sweet_potato','sweet potato', 'en'),
  ('irish_potato','mbatata wa boma', 'ny'),
  ('irish_potato','irish potato', 'en'),
  ('irish_potato','chips', 'en'),
  ('beans',       'nyemba', 'ny'),
  ('beans',       'beans', 'en'),
  ('groundnuts',  'mtedza', 'ny'),
  ('groundnuts',  'groundnuts', 'en'),
  ('groundnuts',  'peanuts', 'en'),
  ('pigeon_peas', 'nandolo', 'ny'),
  ('pigeon_peas', 'pigeon peas', 'en'),
  ('bambara_nuts','nzama', 'ny'),
  ('bambara_nuts','bambara nuts', 'en'),
  ('rice',        'mpunga', 'ny'),
  ('rice',        'rice', 'en'),
  ('chicken',     'nkhuku', 'ny'),
  ('chicken',     'chicken', 'en'),
  ('beef',        'nyama ya ng''ombe', 'ny'),
  ('beef',        'beef', 'en'),
  ('goat_meat',   'nyama ya mbuzi', 'ny'),
  ('goat_meat',   'goat meat', 'en'),
  ('fish',        'nsomba', 'ny'),
  ('fish',        'fish', 'en'),
  ('fish',        'chambo', 'ny'),
  ('fish',        'usipa', 'ny'),
  ('fish',        'kapenta', 'ny'),
  ('dried_fish',  'usipa wouma', 'ny'),
  ('dried_fish',  'dried fish', 'en'),
  ('eggs',        'mazira', 'ny'),
  ('eggs',        'eggs', 'en'),
  ('milk',        'mkaka', 'ny'),
  ('milk',        'milk', 'en'),
  ('tomato',      'tomato', 'en'),
  ('tomato',      'tomato', 'ny'),
  ('onion',       'anyezi', 'ny'),
  ('onion',       'onion', 'en'),
  ('pumpkin_leaves','nkhwani', 'ny'),
  ('pumpkin_leaves','pumpkin leaves', 'en'),
  ('bean_leaves', 'khwanya', 'ny'),
  ('bean_leaves', 'bean leaves', 'en'),
  ('amaranth',    'bonongwe', 'ny'),
  ('amaranth',    'amaranth', 'en'),
  ('cassava_leaves','chigwada', 'ny'),
  ('cassava_leaves','cassava leaves', 'en'),
  ('okra',        'therere', 'ny'),
  ('okra',        'okra', 'en'),
  ('mustard_greens','mpiru', 'ny'),
  ('mustard_greens','mustard greens', 'en'),
  ('relish',      'ndiwo', 'ny'),
  ('relish',      'relish', 'en'),
  ('relish',      'side dish', 'en'),
  ('banana',      'nthochi', 'ny'),
  ('banana',      'banana', 'en'),
  ('mango',       'mango', 'ny'),
  ('mango',       'mango', 'en'),
  ('avocado',     'peya', 'ny'),
  ('avocado',     'avocado', 'en'),
  ('pumpkin',     'thabwa', 'ny'),
  ('pumpkin',     'pumpkin', 'en'),
  ('cooking_oil', 'mafuta', 'ny'),
  ('cooking_oil', 'cooking oil', 'en'),
  ('sugar',       'shuga', 'ny'),
  ('sugar',       'sugar', 'en'),
  ('salt',        'mchere', 'ny'),
  ('salt',        'salt', 'en'),
  ('tea',         'tiyi', 'ny'),
  ('tea',         'tea', 'en'),
  ('doughnut',    'mandasi', 'ny'),
  ('doughnut',    'doughnut', 'en'),
  ('fritters',    'zitumbuwa', 'ny'),
  ('fritters',    'fritters', 'en'),
  ('porridge',    'phala', 'ny'),
  ('porridge',    'porridge', 'en'),
  ('pumpkin_seeds','nyemba za thabwa', 'ny'),
  ('pumpkin_seeds','pumpkin seeds', 'en')
on conflict (group_key, term) do nothing;
