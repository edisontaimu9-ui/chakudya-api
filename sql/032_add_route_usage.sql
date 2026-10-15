-- 032: route_usage - daily call counts per endpoint, for the admin monitor's "Usage by endpoint" view.
-- One row per UTC day, method and route (ids replaced, e.g. /foods/:id). Counts only: no keys, IPs, queries or bodies.
-- Written by the Worker through bump_route_usage() when ROUTE_USAGE_STORE=true. Run in the Supabase SQL editor.

create table if not exists route_usage (
  day      date    not null,
  method   text    not null,
  route    text    not null,
  calls    bigint  not null default 0,
  errors   bigint  not null default 0,   -- 5xx, 429 and 4xx other than 401/404
  total_ms bigint  not null default 0,   -- sum of durations, so average = total_ms / calls
  primary key (day, method, route)
);

create index if not exists route_usage_day_idx on route_usage (day desc);

create or replace function bump_route_usage(p_method text, p_route text, p_error boolean, p_ms integer)
returns void
language sql
as $$
  insert into route_usage (day, method, route, calls, errors, total_ms)
  values ((now() at time zone 'utc')::date, p_method, p_route, 1,
          case when p_error then 1 else 0 end, greatest(p_ms, 0))
  on conflict (day, method, route) do update
    set calls    = route_usage.calls + 1,
        errors   = route_usage.errors + case when p_error then 1 else 0 end,
        total_ms = route_usage.total_ms + greatest(p_ms, 0);
$$;

alter table route_usage enable row level security;
