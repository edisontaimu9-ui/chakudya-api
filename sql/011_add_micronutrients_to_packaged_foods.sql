-- Chakudya Nutrition Registry
-- Migration: add the same micronutrient panel public.foods and
-- public.external_foods_cache already have to public.packaged_foods, so a
-- barcode/label scan (POST /packaged/scan) or manual submission (POST
-- /packaged/submit) can capture calcium/iron/zinc/etc, not just the 4 core
-- macros + fiber/sodium/salt. Field names match public.foods exactly (see
-- sql/001_add_micronutrients_to_foods.sql) so a packaged-food result can be
-- displayed and reasoned about the same way as a local FCT one.
-- Safe to re-run: every column uses IF NOT EXISTS.

alter table public.packaged_foods
  add column if not exists calcium_mg   numeric, -- Ca (mg) per 100g/100ml
  add column if not exists iron_mg      numeric, -- Fe (mg) per 100g/100ml
  add column if not exists zinc_mg      numeric, -- Zn (mg) per 100g/100ml
  add column if not exists magnesium_mg numeric, -- Mg (mg) per 100g/100ml
  add column if not exists potassium_mg numeric, -- K (mg) per 100g/100ml
  add column if not exists folate_mcg   numeric, -- Folate (mcg) per 100g/100ml
  add column if not exists vita_rae_mcg numeric, -- Vitamin A, RAE (mcg) per 100g/100ml
  add column if not exists vitc_mg      numeric, -- Vitamin C (mg) per 100g/100ml
  add column if not exists vitd_mcg     numeric, -- Vitamin D (mcg) per 100g/100ml
  add column if not exists vitb12_mcg   numeric, -- Vitamin B12 (mcg) per 100g/100ml
  add column if not exists iodine_mcg   numeric; -- I (mcg) per 100g/100ml

comment on column public.packaged_foods.vita_rae_mcg is 'Vitamin A, Retinol Activity Equivalents (mcg) per 100g/100ml — null if the label only printed a %DV/%NRV figure (see NUTRITION_LABEL_SCHEMA_PROMPT)';
