-- Chakudya Nutrition Registry
-- Migration: add saturated fat and total sugars to public.foods. Both are
-- mandatory on a Codex-compliant nutrition label (CODEX STAN 1-1985, as
-- amended — energy, protein, available carbohydrate, fat, saturated fat,
-- sodium, and total sugars) but weren't part of the 001 micronutrient pass.
-- Per 100g edible food, matching Malawi FCT 2019 convention (SAFA / Total
-- Sugar columns — see the FCT's Group tables, e.g. p.19). Safe to re-run:
-- both use IF NOT EXISTS.

alter table public.foods
  add column if not exists safa_g        numeric, -- Saturated fatty acids (g) — Codex-required
  add column if not exists sugar_total_g numeric; -- Total sugars (g) — Codex-required

comment on column public.foods.safa_g is 'Saturated fatty acids (g) per 100g — required on a Codex-compliant nutrition label';
comment on column public.foods.sugar_total_g is 'Total sugars (g) per 100g — required on a Codex-compliant nutrition label';

-- Still not tracked (available in the FCT but not needed for a Codex label
-- — see sql/001_add_micronutrients_to_foods.sql's own note for the rest):
--   Mois, Ash, N, Starch, CHO Total/avail (available carb IS carbs_g here),
--   Added Sugar, MUFA/PUFA, Cholesterol, Thiamin, Riboflavin, Niacin,
--   Vit B6, Pantothenic acid, Biotin, Vit E, Phosphorus, Copper, Manganese,
--   Selenium, Phytate
