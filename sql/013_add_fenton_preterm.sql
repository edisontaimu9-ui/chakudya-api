-- Chakudya Nutrition Registry
-- Migration: Fenton preterm growth chart LMS parameters (2013 and 2025 references).
--
-- Source: Fenton TR, Kim JH. BMC Pediatrics 2013;13:59 (2013 reference) and
-- Fenton TR, Elmrayed S, Alshaikh BN. Paediatric and Perinatal Epidemiology
-- 2025. PMID: 40534585 (2025 reference). LMS parameters provided directly by
-- Dr. Tanis Fenton (University of Calgary) by email, 2026-09-23.
--
-- LICENSE — READ BEFORE TOUCHING THIS TABLE OR ITS ROUTES:
-- Shared under CC BY-NC-ND 4.0 (https://creativecommons.org/licenses/by-nc-nd/4.0/)
-- for non-commercial use in this application ONLY, with two explicit extra
-- conditions from Dr. Fenton: (1) the underlying data must never be visible
-- to end users, and (2) it must never be shared with other hospitals or
-- organizations. Chakudya API is public, so:
--   - There is NO list/dump endpoint for this table. GET /fenton-preterm/classify
--     is the only route that touches it, and it returns a computed z-score/
--     percentile/status — never the raw L/M/S row.
--   - Do not add a GET /fenton-preterm list route, a /bulk seed response that
--     echoes rows back publicly, or include this table in any export/dump
--     tooling. If you need to change this, ask Edison first — this is a
--     condition of a specific data-sharing agreement, not a generic default.
--
-- One row per (reference_year, sex, metric, time_days). time_days is age in
-- days since 22 completed weeks gestation: (gestational_age_weeks - 22) * 7 + day,
-- matching Dr. Fenton's own calculator's lookup axis. Seed via multiple
-- POST /fenton-preterm/bulk (admin) calls — scripts/fenton_preterm_seed_*.json,
-- chunked to the 500-item bulk cap.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.fenton_preterm_lms (
  id bigint generated always as identity primary key,
  reference_year integer not null check (reference_year in (2013, 2025)),
  sex text not null check (sex in ('boys', 'girls')),
  metric text not null check (metric in ('weight', 'length', 'hc')),
  time_days numeric not null,
  l numeric not null,
  m numeric not null,
  s numeric not null,
  created_at timestamptz not null default now(),
  unique (reference_year, sex, metric, time_days)
);

create index if not exists idx_fenton_preterm_lookup
  on public.fenton_preterm_lms (reference_year, sex, metric, time_days);

comment on table public.fenton_preterm_lms is
  'Fenton preterm growth chart LMS parameters (2013 & 2025), from Dr. Tanis Fenton (Univ. of Calgary), CC BY-NC-ND 4.0, non-commercial, this app only. CONDITION: never expose raw rows to end users or other organizations - classify-only access via GET /fenton-preterm/classify. No list/dump route.';
