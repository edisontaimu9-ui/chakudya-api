-- 029: self-service consumer API keys (developer portal on the docs site).
-- Consumer keys live in api_keys with role = 'consumer'; these columns record
-- who owns a key so a signed-in developer can list and revoke only their own.
-- Run in the Supabase SQL editor.

alter table api_keys add column if not exists owner_user_id uuid;
alter table api_keys add column if not exists owner_email text;
alter table api_keys add column if not exists key_prefix text;

-- Harmless if no such constraint exists. If role was restricted to admin/reviewer,
-- this lets 'consumer' through.
alter table api_keys drop constraint if exists api_keys_role_check;

create index if not exists api_keys_owner_idx
  on api_keys (owner_user_id)
  where owner_user_id is not null;
