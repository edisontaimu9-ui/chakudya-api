-- Chakudya Nutrition Registry
-- Migration: standalone glycaemic index / glycaemic load reference table.
--
-- Kept as its own table rather than columns on `foods`, because GI/GL is
-- measured per specific preparation/variety (e.g. "maize stiff porridge,
-- fermented maize grits" vs "maize stiff porridge, whole maize flour") —
-- that almost never lines up 1:1 with a single Malawi FCT `foods` row, and
-- a food can have zero, one, or several published values depending on how
-- many studies tested it. `match_keywords` bridges the two at query time
-- (see matchGlycaemicIndexRows in src/index.js) instead of forcing a
-- foreign key that would misrepresent the data.
--
-- No values are guessed or interpolated — every row here must trace to an
-- actual published source (see `source`). Seed via POST
-- /glycaemic-index/bulk (admin) using a JSON file in the same shape as
-- scripts/drug_nutrient_interactions_seed.json.

create table if not exists public.glycaemic_index_data (
  id bigint generated always as identity primary key,
  food_name text not null,        -- as described in the source study, e.g. "Maize stiff porridge (nsima), fermented maize grits"
  match_keywords text[] not null, -- lowercase keywords matched against foods.food_name / a compare request's food name
  gi_value numeric,               -- point estimate, glucose = 100 reference (null if only a range is known)
  gi_low numeric,                 -- low end of a reported range (use instead of/alongside gi_value when sources disagree)
  gi_high numeric,                -- high end of a reported range
  gi_category text,               -- 'low' (<55) | 'medium' (55-69) | 'high' (>=70) — per the study's own classification where given
  gl_value numeric,               -- glycaemic load for the study's own reference serving (not necessarily 100g)
  reference_carb_g numeric,       -- available carbohydrate (g) the test portion contained (usually 25 or 50g under ISO 26642:2010)
  population text,                -- e.g. 'Malawi', 'general/international average'
  method text,                    -- e.g. 'ISO 26642:2010', 'non-ISO / historical methodology'
  source text not null,           -- citation — author(s), year, publication
  notes text,                     -- caveats: variety, cooking method, regional variation, sample size, etc.
  created_at timestamptz not null default now()
);

create index if not exists glycaemic_index_data_keywords_idx
  on public.glycaemic_index_data using gin (match_keywords);

comment on table public.glycaemic_index_data is
  'Published glycaemic index / glycaemic load values. Not derived or estimated — every row cites a source. Matched to foods by keyword (see match_keywords), not a foreign key, because GI study food descriptions rarely match FCT naming exactly.';
