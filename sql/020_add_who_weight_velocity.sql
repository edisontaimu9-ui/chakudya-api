-- Chakudya Nutrition Registry
-- Migration: WHO 6-month weight increment standards (birth to 24 months).
--
-- Source: WHO Child Growth Standards, "Simplified field tables - 6-month
-- weight increments (g)", boys and girls (WHO Growth Velocity Standards).
-- One row per sex per 6-month interval, month 0 (0-6 mo) through month 18
-- (18-24 mo). Increments are in GRAMS.
--
-- Boys and girls: -3 SD to +3 SD cut-offs transcribed from the printed
-- z-score tables. The tables' L, M, S and Delta values are stored too, so the
-- API can return an exact z-score and percentile, not just a band
-- (x = M * (1 + L*S*z)^(1/L) - Delta reproduces the printed cut-offs within 1 g).
--
-- Seed via POST /weight-velocity/bulk (admin) with
-- scripts/who_weight_velocity_seed.json (38 rows: 19 girls + 19 boys). The
-- unique (sex, interval_start_months) constraint rejects a second seeding.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_weight_velocity (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  interval_start_months integer not null check (interval_start_months between 0 and 18),
  interval_end_months integer not null check (interval_end_months = interval_start_months + 6),
  delta_g numeric not null,   -- WHO shift so increments (which can be negative) fit the LMS transform
  lms_l numeric not null,
  lms_m numeric not null,
  lms_s numeric not null,
  sd_neg3 numeric not null,   -- 6-month weight increment (g) at -3 SD
  sd_neg2 numeric not null,
  sd_neg1 numeric not null,
  median numeric not null,
  sd_pos1 numeric not null,
  sd_pos2 numeric not null,
  sd_pos3 numeric not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (sex, interval_start_months)
);

comment on table public.who_weight_velocity is
  'WHO 6-month weight increment standards in grams (0-24 months), simplified field tables with L, M, S, Delta. Used by GET /weight-velocity/classify. Screening aid only.';

-- Make the new table visible to the API immediately.
notify pgrst, 'reload schema';
