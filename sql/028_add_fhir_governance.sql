-- 028 — FHIR governance: audit trail + per-credential FHIR scopes
-- Run once in the Supabase SQL editor (idempotent).
--
-- 1. fhir_audit_events: one row per audited /fhir request, written only when
--    the Worker has FHIR_AUDIT_STORE=true. It holds an AuditEvent resource
--    (who, what route, when, outcome). It NEVER holds a request body, a query
--    string, or a patient identifier unless FHIR_AUDIT_INCLUDE_PATIENT=true.
--    IPs are truncated before they get here (a.b.c.0).
--    Rows are append-only from the API: there is no update or delete route.
--    Plan retention yourself, e.g.:
--      delete from fhir_audit_events where recorded < now() - interval '400 days';
--
-- 2. fhir_scopes on api_keys and oauth_clients: optional space-separated
--    scopes such as 'system/Bundle.write system/*.read'. When empty, the
--    credential's role decides: admin = system/*.*, reviewer = system/*.read.

create table if not exists fhir_audit_events (
  id text primary key,                       -- the request id (X-Request-Id)
  recorded timestamptz not null,
  outcome text not null check (outcome in ('0', '4', '8', '12')),
  action text not null check (action in ('C', 'R', 'U', 'D', 'E')),
  agent text,                                -- API key / OAuth client label, or 'anonymous'
  operation text not null,                   -- e.g. 'POST /fhir/Condition/$diagnose'
  event jsonb not null                       -- the AuditEvent resource
);

create index if not exists fhir_audit_events_recorded_idx on fhir_audit_events (recorded desc);
create index if not exists fhir_audit_events_outcome_idx on fhir_audit_events (outcome, recorded desc);
create index if not exists fhir_audit_events_agent_idx on fhir_audit_events (agent, recorded desc);

-- Only the Worker (service key) reads or writes this table.
alter table fhir_audit_events enable row level security;

alter table api_keys add column if not exists fhir_scopes text;
alter table oauth_clients add column if not exists fhir_scopes text;
