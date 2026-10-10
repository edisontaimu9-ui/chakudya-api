-- Chakudya Nutrition Registry
-- Migration: WHO length/height-for-age standards, birth to 60 months.
--
-- Source: WHO Child Growth Standards, length-for-age (birth to 2 years, lying)
-- and height-for-age (2 to 5 years, standing), monthly z-score tables, girls
-- and boys. Values in CENTIMETRES. Month 24 appears in both tables (lying and
-- standing rows differ by about 0.7 cm), so uniqueness includes `measured`.
--
-- The tables' L, M, S are stored; the -3 SD to +3 SD cut-offs are recomputed
-- from them to 3 decimals (the printed cut-offs are rounded to 1 decimal).
--
-- Seed via POST /length-height-for-age/bulk (admin) with
-- scripts/length_height_for_age_seed.json (124 rows: 25 lying + 37 standing
-- per sex). The unique constraint rejects a second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_length_height_for_age (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  age_months integer not null check (age_months between 0 and 60),
  measured text not null check (measured in ('lying', 'standing')),
  lms_l numeric not null,
  lms_m numeric not null,
  lms_s numeric not null,
  sd_neg3 numeric not null,   -- length/height (cm) at -3 SD
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

comment on table public.who_length_height_for_age is
  'WHO Child Growth Standards length/height-for-age (0-60 months), cm, with L/M/S. Used by GET /length-height-for-age/classify. Screening aid only.';
