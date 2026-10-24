-- 038: free water content of enteral formulas, for POST /enteral-nutrition/calculate.
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- The calculator subtracts the water in the formula from the patient's fluid needs to size the free water flush.
-- Without this column it estimates formula water from energy density and says so in the response notes.
-- Fill the column from the manufacturer's product sheet or your facility formulary card (ml of water per 1000 ml of formula).

alter table public.enteral_formulas add column if not exists water_ml_per_l numeric;
alter table public.enteral_formulas add column if not exists water_source text;

comment on column public.enteral_formulas.water_ml_per_l is 'Water content in ml per 1000 ml of formula, from the product sheet or formulary card.';
comment on column public.enteral_formulas.water_source is 'Where water_ml_per_l came from (for example "Abbott product sheet, Oct 2026").';

-- Make PostgREST pick up the new columns straight away.
notify pgrst, 'reload schema';
