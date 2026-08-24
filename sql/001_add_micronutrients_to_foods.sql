-- Chakudya Nutrition Registry
-- Migration: add the important micronutrients (not the full FCT panel) to
-- public.foods. Values are per 100g edible food, matching Malawi FCT 2019
-- convention. Safe to re-run: every column uses IF NOT EXISTS.

alter table public.foods
  add column if not exists fiber_g     numeric,  -- Fiber (g)

  -- vitamins that matter most for public health / deficiency tracking
  add column if not exists vita_rae_mcg numeric, -- Vitamin A, RAE (mcg)
  add column if not exists vitc_mg      numeric, -- Vitamin C (mg)
  add column if not exists vitd_mcg     numeric, -- Vitamin D (mcg)
  add column if not exists vitb12_mcg   numeric, -- Vitamin B12 (mcg)
  add column if not exists folate_mcg   numeric, -- Folate (mcg)

  -- minerals that matter most (iron/zinc/iodine are WHO priority
  -- micronutrients for Malawi specifically; calcium/potassium/sodium/
  -- magnesium are the other commonly-tracked ones)
  add column if not exists calcium_mg   numeric, -- Ca (mg)
  add column if not exists iron_mg      numeric, -- Fe (mg)
  add column if not exists zinc_mg      numeric, -- Zn (mg)
  add column if not exists magnesium_mg numeric, -- Mg (mg)
  add column if not exists potassium_mg numeric, -- K (mg)
  add column if not exists sodium_mg    numeric, -- Na (mg)
  add column if not exists iodine_mcg   numeric; -- I (mcg)

comment on column public.foods.vita_rae_mcg is 'Vitamin A, Retinol Activity Equivalents (mcg) per 100g';

-- Not included (available in the FCT but lower priority for most use
-- cases) — add later the same way if you need them:
--   Mois, Ash, N, Starch, CHO Total/avail, Total/Added Sugar,
--   SAFA/MUFA/PUFA, Cholesterol, Thiamin, Riboflavin, Niacin, Vit B6,
--   Pantothenic acid, Biotin, Vit E, Phosphorus, Copper, Manganese,
--   Selenium, Phytate
