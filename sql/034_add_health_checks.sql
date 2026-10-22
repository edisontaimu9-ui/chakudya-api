-- 034: health_checks - one row per scheduled health probe, for uptime %, upstream status and an outage timeline.
-- The Worker's cron (every 5 minutes) runs the same checks as GET /health and stores the verdict here when
-- HEALTH_CHECK_STORE=true. Read it through GET /admin/health-history (root admin key only).
-- Stores statuses, probe latency and a short error detail per service. No keys, IPs, queries or bodies.
-- Run in the Supabase SQL editor.

create table if not exists health_checks (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  status      text not null check (status in ('healthy', 'degraded')),
  duration_ms integer not null default 0,
  services    jsonb not null default '{}'::jsonb   -- { "supabase": {"status":"ok","ms":120}, "groq": {"status":"error","ms":5003,"detail":"Timed out"} }
);

create index if not exists health_checks_at_idx on health_checks (at desc);

alter table health_checks enable row level security;

-- The Worker calls this once a day to keep 30 days of history (about 8,600 rows at one probe per 5 minutes).
create or replace function purge_health_checks(p_days integer default 30)
returns void
language sql
as $$
  delete from health_checks where at < now() - make_interval(days => greatest(p_days, 1));
$$;
