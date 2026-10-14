-- 031: request_log - failed and slow API calls, for the admin monitor's "Errors and latency" view.
-- Only failures (5xx, 429 and 4xx other than 401/404) and slow requests are stored, one row each.
-- No query strings, bodies, tokens or IPs. Written by the Worker only when REQUEST_LOG_STORE=true.
-- Run in the Supabase SQL editor.

create table if not exists request_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  request_id  text,
  method      text not null,
  route       text not null,        -- path with ids replaced, e.g. /foods/:id
  status      integer not null,
  duration_ms integer not null,
  kind        text not null check (kind in ('error', 'slow', 'both')),
  cache       text
);

create index if not exists request_log_at_idx on request_log (at desc);
create index if not exists request_log_route_idx on request_log (route, at desc);

-- Optional housekeeping: keep 30 days.
-- delete from request_log where at < now() - interval '30 days';

alter table request_log enable row level security;
