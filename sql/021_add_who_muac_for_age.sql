-- Chakudya Nutrition Registry
-- Migration: WHO arm circumference-for-age (MUAC-for-age) standards, 3 to 60 months.
--
-- Source: WHO Child Growth Standards, arm circumference-for-age (cm), expanded
-- z-score tables, girls and boys. One row per sex per completed month, taken
-- from the daily table at day = round(months x 30.4375). Values in CENTIMETRES.
--
-- The -3 SD to +3 SD cut-offs are transcribed from the printed tables. The
-- L, M, S values are stored too, so the API can return an exact z-score and
-- percentile (x = M * (1 + L*S*z)^(1/L) reproduces the cut-offs within 0.001 cm).
--
-- Seed via POST /muac-for-age/bulk (admin) with scripts/muac_for_age_seed.json
-- (max 500 rows per request). The unique (sex, age_months) constraint rejects
-- re-seeding of months that are already present, so rows can be loaded in
-- several files (for example months 3-35 first, then 36-60).
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_muac_for_age (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  age_months integer not null check (age_months between 3 and 60),
  age_days integer not null,   -- day row of the WHO daily table this month was taken from
  lms_l numeric not null,
  lms_m numeric not null,
  lms_s numeric not null,
  sd_neg3 numeric not null,    -- arm circumference (cm) at -3 SD
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

comment on table public.who_muac_for_age is
  'WHO Child Growth Standards arm circumference-for-age (3-60 months), cm, with L/M/S. Used by GET /muac-for-age/classify. Screening aid only; not the fixed-cut-off MUAC tape.';
