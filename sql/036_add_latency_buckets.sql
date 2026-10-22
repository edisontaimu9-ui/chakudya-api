-- 036: latency buckets on route_usage, so GET /admin/usage can estimate p95 latency per endpoint and overall.
-- Each counted request also bumps one bucket (upper bounds in ms: 50, 100, 250, 500, 1000, 2500, 5000, and over 5000).
-- The Worker still calls bump_route_usage() with the same four arguments, so no code change is needed to start filling them.
-- Rows written before this migration have zero buckets; p95 only covers requests since you ran it. Run in the Supabase SQL editor.

alter table route_usage add column if not exists ms_le_50    bigint not null default 0;
alter table route_usage add column if not exists ms_le_100   bigint not null default 0;
alter table route_usage add column if not exists ms_le_250   bigint not null default 0;
alter table route_usage add column if not exists ms_le_500   bigint not null default 0;
alter table route_usage add column if not exists ms_le_1000  bigint not null default 0;
alter table route_usage add column if not exists ms_le_2500  bigint not null default 0;
alter table route_usage add column if not exists ms_le_5000  bigint not null default 0;
alter table route_usage add column if not exists ms_gt_5000  bigint not null default 0;

create or replace function bump_route_usage(p_method text, p_route text, p_error boolean, p_ms integer)
returns void
language sql
as $$
  insert into route_usage (day, method, route, calls, errors, total_ms,
                           ms_le_50, ms_le_100, ms_le_250, ms_le_500, ms_le_1000, ms_le_2500, ms_le_5000, ms_gt_5000)
  values ((now() at time zone 'utc')::date, p_method, p_route, 1,
          case when p_error then 1 else 0 end, greatest(p_ms, 0),
          case when p_ms <= 50 then 1 else 0 end,
          case when p_ms > 50   and p_ms <= 100  then 1 else 0 end,
          case when p_ms > 100  and p_ms <= 250  then 1 else 0 end,
          case when p_ms > 250  and p_ms <= 500  then 1 else 0 end,
          case when p_ms > 500  and p_ms <= 1000 then 1 else 0 end,
          case when p_ms > 1000 and p_ms <= 2500 then 1 else 0 end,
          case when p_ms > 2500 and p_ms <= 5000 then 1 else 0 end,
          case when p_ms > 5000 then 1 else 0 end)
  on conflict (day, method, route) do update
    set calls      = route_usage.calls + 1,
        errors     = route_usage.errors + case when p_error then 1 else 0 end,
        total_ms   = route_usage.total_ms + greatest(p_ms, 0),
        ms_le_50   = route_usage.ms_le_50   + excluded.ms_le_50,
        ms_le_100  = route_usage.ms_le_100  + excluded.ms_le_100,
        ms_le_250  = route_usage.ms_le_250  + excluded.ms_le_250,
        ms_le_500  = route_usage.ms_le_500  + excluded.ms_le_500,
        ms_le_1000 = route_usage.ms_le_1000 + excluded.ms_le_1000,
        ms_le_2500 = route_usage.ms_le_2500 + excluded.ms_le_2500,
        ms_le_5000 = route_usage.ms_le_5000 + excluded.ms_le_5000,
        ms_gt_5000 = route_usage.ms_gt_5000 + excluded.ms_gt_5000;
$$;
