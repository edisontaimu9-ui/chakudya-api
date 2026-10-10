-- Chakudya Nutrition Registry
-- Migration: WHO BMI-for-age standards, birth to 5 years (the under-5 companion
-- of the 5-19 year table bmi_for_age from sql/012).
--
-- Source: WHO Child Growth Standards 2006, BMI-for-age (kg/m2), monthly
-- z-score tables, birth to 2 years (length, lying) and 2 to 5 years (height,
-- standing). Month 24 appears in both tables, so uniqueness includes `measured`.
-- The tables' L, M, S are stored; the -3 SD to +3 SD cut-offs are recomputed
-- from them to 3 decimals (the printed ones are rounded to 1 decimal).
--
-- Seed via POST /bmi-for-age-under-5/bulk (admin) with
-- scripts/bmi_for_age_under5_seed.json (124 rows). A unique constraint rejects
-- a second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_bmi_for_age_under_5 (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  age_months integer not null check (age_months between 0 and 60),
  measured text not null check (measured in ('lying', 'standing')),
  lms_l numeric not null,
  lms_m numeric not null,
  lms_s numeric not null,
  sd_neg3 numeric not null,   -- BMI (kg/m2) at -3 SD
  sd_neg2 numeric not null,
  sd_neg1 numeric not null,
  median numeric not null,
  sd_pos1 numeric not null,
  sd_pos2 numeric not null,
  sd_pos3 numeric not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (sex, age_months, measured)
);

comment on table public.who_bmi_for_age_under_5 is
  'WHO BMI-for-age 0-60 months (kg/m2, with L/M/S). Used by GET /bmi-for-age-under-5/classify. Screening aid only. 5-19 years: bmi_for_age.';
