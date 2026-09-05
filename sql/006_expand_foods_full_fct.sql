-- Chakudya Nutrition Registry
-- Migration: expand public.foods to the FULL Malawi FCT panel, so a fresh
-- FCT reload (e.g. mfct.csv) doesn't have to drop any column to fit the
-- existing schema. Adds the source's provenance fields (code/reference),
-- the remaining macronutrient breakdown, and the rest of the vitamin/
-- mineral panel not already covered by 001 (priority micronutrients) or
-- 005 (Codex-mandatory safa_g/sugar_total_g).
--
-- Per 100g edible food, matching Malawi FCT 2019 convention, same as every
-- prior foods migration. Safe to re-run: every column uses IF NOT EXISTS.

alter table public.foods
  -- provenance (renamed off 'code'/'reference' to avoid ambiguity with
  -- other tables and reserved-word confusion)
  add column if not exists mfct_code      text,    -- FCT source code, e.g. "MW01_0001"
  add column if not exists mfct_reference text,    -- FCT source reference id, e.g. "R06"

  -- remaining proximate/macronutrient breakdown not already tracked
  add column if not exists moisture_g       numeric,
  add column if not exists nitrogen_g       numeric,
  add column if not exists mufa_g           numeric, -- Monounsaturated fatty acids (g)
  add column if not exists pufa_g           numeric, -- Polyunsaturated fatty acids (g)
  add column if not exists cholesterol_mg   numeric,
  add column if not exists carb_total_g     numeric, -- Total carbohydrate (g) — carbs_g already holds *available* carb
  add column if not exists sugar_added_g    numeric, -- Added sugar (g) — sugar_total_g (005) already holds total sugar
  add column if not exists starch_g         numeric,
  add column if not exists ash_g            numeric,

  -- remaining minerals
  add column if not exists phosphorus_mg    numeric,
  add column if not exists copper_mg        numeric,
  add column if not exists manganese_mcg    numeric,
  add column if not exists selenium_mcg     numeric,

  -- remaining vitamins
  add column if not exists vita_re_mcg          numeric, -- Vitamin A, RE (mcg) — distinct from vita_rae_mcg (001)
  add column if not exists thiamin_mg           numeric, -- Vitamin B1 (mg)
  add column if not exists riboflavin_mg        numeric, -- Vitamin B2 (mg)
  add column if not exists niacin_mg            numeric, -- Vitamin B3 (mg)
  add column if not exists vitb6_mg             numeric,
  add column if not exists pantothenic_acid_mg  numeric, -- Vitamin B5 (mg)
  add column if not exists biotin_mcg           numeric, -- Vitamin B7 (mcg)
  add column if not exists vite_mg              numeric,
  add column if not exists phytate_mg           numeric,

  -- source data-quality notes carried over verbatim from the FCT dataset
  add column if not exists data_quality_flags text;

comment on column public.foods.mfct_code is 'Malawi Food Composition Table source code (provenance, not a public id)';
comment on column public.foods.mfct_reference is 'Malawi Food Composition Table source reference id';
comment on column public.foods.carb_total_g is 'Total carbohydrate (g) per 100g — see carbs_g for available carbohydrate';
comment on column public.foods.sugar_added_g is 'Added sugar (g) per 100g — see sugar_total_g (005) for total sugars';
comment on column public.foods.data_quality_flags is 'Semicolon-separated per-field confidence/assumption notes from the source FCT, e.g. "added_sugar_g:low_confidence;vitamin_d_mcg:assumed"';

-- Nothing from the FCT panel is left uncovered after this migration:
-- proximates, full fat breakdown, full carb breakdown, full vitamin/
-- mineral panel, and source provenance are all now columns on public.foods.
