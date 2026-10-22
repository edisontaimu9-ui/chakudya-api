-- 037: Nutrition Research & Surveillance Engine (anonymised screening records + aggregation functions).
-- Run in the Supabase SQL editor. Used by POST /surveillance/records and GET /surveillance/*.
--
-- Privacy by design (what is NOT stored): no names, phone numbers, addresses, facility names, patient or
-- device ids, exact dates, exact ages, or raw measurements. A row holds only: the calendar MONTH of the screen,
-- the DISTRICT (and its region), the population group, sex, a coarse AGE BAND, the setting (facility,
-- community, school ...), an optional app label, and the classified outcomes (e.g. {"stunting":"severe"}).
-- submission_id is a random token made by the client app, used only so a re-sent record is not counted twice.
-- The Worker is the only reader (RLS is on, no policies) and never returns rows, only aggregates.

create table if not exists surveillance_records (
  id               bigint generated always as identity primary key,
  submission_id    text        not null unique,
  observed_month   date        not null,                 -- first day of the month, never the exact date
  district         text        not null,
  region           text        not null,
  population_group text        not null
    check (population_group in ('under5', 'school_age', 'adolescent', 'adult', 'pregnant_lactating')),
  sex              text        not null default 'unknown'
    check (sex in ('female', 'male', 'unknown')),
  age_band         text        not null,
  setting          text,
  source           text,
  indicators       jsonb       not null default '{}'::jsonb,   -- {"stunting":"severe","anaemia_suspected":"no"}
  created_at       timestamptz not null default now()
);

create index if not exists surveillance_records_month_district_idx on surveillance_records (observed_month, district);
create index if not exists surveillance_records_group_month_idx    on surveillance_records (population_group, observed_month);

alter table surveillance_records enable row level security;

-- Insert a batch the Worker has already validated. A submission_id that already exists is skipped, so a
-- retry or a double send never double-counts. Returns how many rows were new.
create or replace function surveillance_ingest(p_records jsonb)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  insert into surveillance_records
    (submission_id, observed_month, district, region, population_group, sex, age_band, setting, source, indicators)
  select x.submission_id, x.observed_month, x.district, x.region, x.population_group, x.sex, x.age_band,
         x.setting, x.source, coalesce(x.indicators, '{}'::jsonb)
  from jsonb_to_recordset(p_records) as x(
    submission_id text, observed_month date, district text, region text, population_group text,
    sex text, age_band text, setting text, source text, indicators jsonb
  )
  on conflict (submission_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Status counts per indicator. Optional filters; optional breakdown by district and/or month.
-- One row per (month?, district?, population_group, indicator) with counts = {"normal": 120, "severe": 9, ...}.
create or replace function surveillance_counts(
  p_from        date,
  p_to          date,
  p_group       text    default null,
  p_indicator   text    default null,
  p_district    text    default null,
  p_by_district boolean default false,
  p_by_month    boolean default false
)
returns table (month date, district text, region text, population_group text, indicator text, counts jsonb)
language sql
stable
as $$
  select t.month, t.district, t.region, t.population_group, t.indicator,
         jsonb_object_agg(t.status, t.n) as counts
  from (
    select case when p_by_month    then r.observed_month end as month,
           case when p_by_district then r.district       end as district,
           case when p_by_district then r.region         end as region,
           r.population_group,
           e.key   as indicator,
           e.value as status,
           count(*) as n
    from surveillance_records r
    cross join lateral jsonb_each_text(r.indicators) e
    where r.observed_month >= p_from
      and r.observed_month <= p_to
      and (p_group     is null or r.population_group = p_group)
      and (p_indicator is null or e.key = p_indicator)
      and (p_district  is null or r.district = p_district)
    group by 1, 2, 3, 4, 5, 6
  ) t
  group by t.month, t.district, t.region, t.population_group, t.indicator;
$$;

-- How much data there is and where it comes from: records and reporting months per district, group and setting.
create or replace function surveillance_volume(
  p_from  date,
  p_to    date,
  p_group text default null
)
returns table (district text, region text, population_group text, setting text, n bigint, months_reporting bigint)
language sql
stable
as $$
  select r.district, r.region, r.population_group, coalesce(r.setting, 'unknown') as setting,
         count(*) as n, count(distinct r.observed_month) as months_reporting
  from surveillance_records r
  where r.observed_month >= p_from
    and r.observed_month <= p_to
    and (p_group is null or r.population_group = p_group)
  group by r.district, r.region, r.population_group, coalesce(r.setting, 'unknown');
$$;

-- Only the Worker (service role) may call these.
revoke all on function surveillance_ingest(jsonb)                                          from public, anon, authenticated;
revoke all on function surveillance_counts(date, date, text, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function surveillance_volume(date, date, text)                               from public, anon, authenticated;
grant execute on function surveillance_ingest(jsonb)                                          to service_role;
grant execute on function surveillance_counts(date, date, text, text, text, boolean, boolean) to service_role;
grant execute on function surveillance_volume(date, date, text)                               to service_role;
