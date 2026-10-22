-- 035: upstream_failures - daily count of failed calls to each outside service (cohere, groq, usda, fatsecret).
-- One row per UTC day and service. Counts only: no keys, queries, bodies or error text.
-- Written by the Worker through bump_upstream_failure() when UPSTREAM_FAILURES_STORE=true. Run in the Supabase SQL editor.
-- Read it with: select * from upstream_failures where day >= current_date - 7 order by day desc, service;

create table if not exists upstream_failures (
  day      date   not null,
  service  text   not null,
  failures bigint not null default 0,
  primary key (day, service)
);

create or replace function bump_upstream_failure(p_service text)
returns void
language sql
as $$
  insert into upstream_failures (day, service, failures)
  values ((now() at time zone 'utc')::date, p_service, 1)
  on conflict (day, service) do update
    set failures = upstream_failures.failures + 1;
$$;

alter table upstream_failures enable row level security;
