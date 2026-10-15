-- Chakudya Nutrition Registry
-- Migration: physical activity energy expenditure, kcal per hour by body weight.
--
-- Source: Krause and Mahan's Food and the Nutrition Care Process, 16th ed., Appendix 10
-- (Physical Activity and Calories Expended Per Hour; copyright 2001 HealtheTech Inc.; from Hammond K,
-- Nurs Clin North Am 32(4):779-790, 1997). One row per activity and type, one column per printed body weight.
--
-- suspect_weights_lb lists printed cells that look like misprints in the source (they break the
-- kcal-per-lb pattern of the rest of the row, for example 133 kcal at 130 lb between 158 and 215). The values
-- are stored exactly as printed. The API leaves a suspect cell out when it interpolates, and says so.
--
-- Seed via POST /activity-energy/bulk (admin) with scripts/activity_energy_seed.json (130 rows).
-- A unique constraint on (activity, type) rejects a second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.activity_energy_expenditure (
  id bigint generated always as identity primary key,
  activity text not null,
  type text not null,
  kcal_110 integer not null check (kcal_110 > 0),
  kcal_130 integer not null check (kcal_130 > 0),
  kcal_150 integer not null check (kcal_150 > 0),
  kcal_170 integer not null check (kcal_170 > 0),
  kcal_190 integer not null check (kcal_190 > 0),
  kcal_210 integer not null check (kcal_210 > 0),
  kcal_230 integer not null check (kcal_230 > 0),
  kcal_250 integer not null check (kcal_250 > 0),
  suspect_weights_lb integer[] not null default '{}',
  source text not null default 'Krause and Mahan''s Food and the Nutrition Care Process, 16th ed., Appendix 10',
  created_at timestamptz not null default now(),
  unique (activity, type)
);

create index if not exists activity_energy_expenditure_activity_idx
  on public.activity_energy_expenditure (activity);

alter table public.activity_energy_expenditure enable row level security;
