-- Chakudya Nutrition Registry
-- Migration: WHO head circumference-for-age standards, birth to 5 years.
--
-- Source: WHO Child Growth Standards 2006, head circumference-for-age (cm),
-- monthly z-score tables, girls and boys, months 0-60. The tables' L, M, S are
-- stored; the -3 SD to +3 SD cut-offs are recomputed from them to 3 decimals
-- (the printed ones are rounded to 1 decimal). The 6-month INCREMENT standard
-- is a separate table: who_hc_velocity (sql/018).
--
-- Seed via POST /hc-for-age/bulk (admin) with scripts/hc_for_age_seed.json
-- (122 rows: 61 per sex). The unique (sex, age_months) constraint rejects a
-- second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_hc_for_age (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  age_months integer not null check (age_months between 0 and 60),
  lms_l numeric not null,
  lms_m numeric not null,
  lms_s numeric not null,
  sd_neg3 numeric not null,   -- head circumference (cm) at -3 SD
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

comment on table public.who_hc_for_age is
  'WHO head circumference-for-age 0-60 months (cm, with L/M/S). Used by GET /hc-for-age/classify. Screening aid only. Increments: who_hc_velocity.';
