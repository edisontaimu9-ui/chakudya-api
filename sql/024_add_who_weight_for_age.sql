-- Chakudya Nutrition Registry
-- Migration: WHO weight-for-age (underweight), birth to 10 years.
--
-- Source: WHO Child Growth Standards 2006, weight-for-age monthly z-score
-- tables (0-60 months) and the WHO 2007 growth reference, weight-for-age
-- 5-10 years expanded tables (61-120 months). Values in KILOGRAMS. WHO does
-- not publish weight-for-age beyond 10 years (use BMI-for-age).
--
-- The tables' L, M, S are stored. 0-60 month cut-offs are recomputed from
-- them to 3 decimals; 61-120 month cut-offs are the printed 3-decimal values.
--
-- Seed via POST /weight-for-age/bulk (admin) with scripts/weight_for_age_seed.json
-- (242 rows: 121 per sex, under the 500-row bulk cap). The unique
-- (sex, age_months) constraint rejects a second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_weight_for_age (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  age_months integer not null check (age_months between 0 and 120),
  lms_l numeric not null,
  lms_m numeric not null,
  lms_s numeric not null,
  sd_neg3 numeric not null,   -- weight (kg) at -3 SD
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

comment on table public.who_weight_for_age is
  'WHO weight-for-age: 2006 standards (0-60 months) and 2007 reference (61-120 months), kg, with L/M/S. Used by GET /weight-for-age/classify. Screening aid only.';
