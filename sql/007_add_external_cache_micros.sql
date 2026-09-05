-- Chakudya Nutrition Registry
-- Migration: add the same micronutrient panel public.foods already has to
-- public.external_foods_cache, so a cached external hit (USDA FDC / Open
-- Food Facts / FatSecret barcode) can carry fiber + vitamins/minerals
-- instead of just the 4 core macros. Field names match public.foods
-- exactly (see normalizeFood() in src/index.js) so downstream code can
-- treat a cached external row the same as a local one.
--
-- Note: this table isn't created anywhere in sql/ (it predates migration
-- tracking here) — this migration only adds columns to whatever already
-- exists, so it's safe regardless of the table's current shape.
-- Safe to re-run: every column uses IF NOT EXISTS.

alter table public.external_foods_cache
  add column if not exists fiber_g     numeric,
  add column if not exists vita_rae_mcg numeric,
  add column if not exists vitc_mg      numeric,
  add column if not exists vitd_mcg     numeric,
  add column if not exists vitb12_mcg   numeric,
  add column if not exists folate_mcg   numeric,
  add column if not exists calcium_mg   numeric,
  add column if not exists iron_mg      numeric,
  add column if not exists zinc_mg      numeric,
  add column if not exists magnesium_mg numeric,
  add column if not exists potassium_mg numeric,
  add column if not exists sodium_mg    numeric;

comment on column public.external_foods_cache.vita_rae_mcg is 'Vitamin A, RAE (mcg) per 100g/100ml — populated for usda_fdc and openfoodfacts sources; always null for fatsecret (see raw_data.vitamin_a_pct_dv instead)';
comment on column public.external_foods_cache.calcium_mg is 'Calcium (mg) per 100g/100ml — populated for usda_fdc and openfoodfacts sources; always null for fatsecret (see raw_data.calcium_pct_dv instead)';
comment on column public.external_foods_cache.iron_mg is 'Iron (mg) per 100g/100ml — populated for usda_fdc and openfoodfacts sources; always null for fatsecret (see raw_data.iron_pct_dv instead)';
comment on column public.external_foods_cache.vitc_mg is 'Vitamin C (mg) per 100g/100ml — populated for usda_fdc and openfoodfacts sources; always null for fatsecret (see raw_data.vitamin_c_pct_dv instead)';

-- Note on FatSecret: its classic serving object reports vitamin_a,
-- vitamin_c, calcium, and iron as %DV strings, not absolute mg/mcg — those
-- four stay null for fatsecret-sourced rows rather than storing a guessed
-- absolute value off an unstated reference DV. fiber_g/sodium_mg/
-- potassium_mg ARE absolute values from FatSecret and are populated
-- normally. See the comment above fetchFromFatSecretBarcode() in
-- src/index.js for the full reasoning.
