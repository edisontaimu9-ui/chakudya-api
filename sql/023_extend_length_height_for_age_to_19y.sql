-- Chakudya Nutrition Registry
-- Migration: widen who_length_height_for_age from 0-60 months to 0-228 months
-- (birth to 19 years) so the WHO 2007 growth reference (height-for-age,
-- 5y 1m to 19y 0m) can sit in the same table as the 0-5 year standards.
--
-- Run sql/022 first. Then run this once in the Supabase SQL editor, then seed
-- scripts/height_for_age_5_19_seed.json (336 rows: 168 girls + 168 boys,
-- months 61-228, measured = 'standing') via POST /length-height-for-age/bulk.
-- The bulk endpoint accepts at most 500 rows per request, so one file is fine.

alter table public.who_length_height_for_age
  drop constraint if exists who_length_height_for_age_age_months_check;

alter table public.who_length_height_for_age
  add constraint who_length_height_for_age_age_months_check
  check (age_months between 0 and 228);

comment on table public.who_length_height_for_age is
  'WHO length/height-for-age: 2006 standards (0-60 months, lying/standing) and 2007 reference (61-228 months, standing), cm, with L/M/S. Used by GET /length-height-for-age/classify. Screening aid only.';
