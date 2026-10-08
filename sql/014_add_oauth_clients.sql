-- 014 — OAuth 2.0 clients for the client_credentials grant (POST /oauth/token)
-- Run once in the Supabase SQL editor. Raw client secrets are never stored,
-- only their SHA-256 hash (same approach as api_keys).

create table if not exists oauth_clients (
  id bigint generated always as identity primary key,
  client_id text not null unique,
  secret_hash text not null,
  label text not null,
  role text not null default 'admin' check (role in ('admin', 'reviewer')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Only the Worker (service key) should read/write this table.
alter table oauth_clients enable row level security;
