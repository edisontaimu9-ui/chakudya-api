-- Chakudya Nutrition Registry
-- Migration: BMI-for-age reference table (children and adolescents, 5y 1m to 19y 0m).
--
-- Source: WHO 2007 BMI-for-age z-score tables as printed in Malawi Ministry of
-- Health, "Eat Well to Live Well" (2021), Annex 2. One row per sex per age in
-- completed months (years x 12 + months). Values are transcribed, not estimated.
--
-- Seed via POST /bmi-for-age/bulk (admin) with scripts/bmi_for_age_seed.json
-- (336 rows, under the 500-item bulk cap). The unique (sex, age_months)
-- constraint means a second seed attempt is rejected instead of duplicating rows.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.bmi_for_age (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  age_months integer not null check (age_months between 61 and 228),
  sd_neg3 numeric not null,   -- BMI at -3 SD (kg/m2)
  sd_neg2 numeric not null,
  sd_neg1 numeric not null,
  median numeric not null,
  sd_pos1 numeric not null,
  sd_pos2 numeric not null,
  sd_pos3 numeric not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (sex, age_months)
);

comment on table public.bmi_for_age is
  'WHO 2007 BMI-for-age reference (5-19 years) as printed in the Malawi MoH Eat Well to Live Well guide, Annex 2. Used by GET /bmi-for-age/classify. Screening aid only.';
