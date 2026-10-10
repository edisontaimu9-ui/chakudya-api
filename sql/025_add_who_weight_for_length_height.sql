-- Chakudya Nutrition Registry
-- Migration: WHO weight-for-length/height standards, birth to 5 years.
--
-- Source: WHO Child Growth Standards 2006, weight-for-length (birth to 2 years,
-- lying, 45.0-110.0 cm) and weight-for-height (2 to 5 years, standing,
-- 65.0-120.0 cm), expanded z-score tables in 0.1 cm steps. Weights in KILOGRAMS.
-- Rows are keyed by length/height, not age: the age decides which table applies.
--
-- The tables' L, M, S are stored with WHO's printed 3-decimal -3 SD to +3 SD
-- cut-offs. 2404 rows in total (girls 651 + 551, boys 651 + 551), seeded in
-- five parts of at most 500 rows via POST /weight-for-length-height/bulk with
-- scripts/weight_for_length_height_seed_1.json ... _5.json. The unique
-- (sex, measured, length_height_cm) constraint rejects a second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_weight_for_length_height (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  measured text not null check (measured in ('lying', 'standing')),
  length_height_cm numeric(4, 1) not null check (length_height_cm between 45 and 120),
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
  unique (sex, measured, length_height_cm)
);

comment on table public.who_weight_for_length_height is
  'WHO weight-for-length (0-2 y, lying) and weight-for-height (2-5 y, standing), kg, 0.1 cm steps, with L/M/S. Used by GET /weight-for-length-height/classify. Screening aid only.';
