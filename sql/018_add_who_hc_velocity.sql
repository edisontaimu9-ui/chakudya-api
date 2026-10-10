-- Chakudya Nutrition Registry
-- Migration: WHO 6-month head circumference increment standards (birth to 24 months).
--
-- Source: WHO Child Growth Standards, "Simplified field tables - 6-month head
-- circumference increments (cm)", boys and girls, z-scores -3 SD to +3 SD
-- (WHO Growth Velocity Standards). One row per sex per 6-month interval,
-- starting at month 0 (0-6 mo) through month 18 (18-24 mo). Values are
-- transcribed from the printed tables, not estimated.
--
-- Seed via POST /hc-velocity/bulk (admin) with scripts/who_hc_velocity_seed.json
-- (38 rows: 19 girls + 19 boys, under the 500-item bulk cap). The unique
-- (sex, interval_start_months) constraint means a second seed attempt is
-- rejected instead of duplicating rows.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.who_hc_velocity (
  id bigint generated always as identity primary key,
  sex text not null check (sex in ('girls', 'boys')),
  interval_start_months integer not null check (interval_start_months between 0 and 18),
  interval_end_months integer not null check (interval_end_months = interval_start_months + 6),
  sd_neg3 numeric not null,   -- 6-month HC increment (cm) at -3 SD
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

comment on table public.who_hc_velocity is
  'WHO 6-month head circumference increment standards (0-24 months), simplified field tables. Used by GET /hc-velocity/classify. Screening aid only.';
