-- 030: OAuth 2.0 client_credentials was removed in v1.34.0 (POST /oauth/token,
-- GET /.well-known/oauth-authorization-server, /admin/oauth-clients).
-- Run in the Supabase SQL editor.
--
-- STEP 1. Check that nothing still uses it. last_used_at is bumped every time a
-- client exchanges its secret for a token, so a recent value means a live client
-- (an MCP server or app) will stop working once the new Worker is deployed. Move
-- that client to an API key first (POST /admin/keys for a server, or a consumer key
-- from the developer console), then deploy.
select client_id, label, role, created_at, last_used_at, revoked_at
from oauth_clients
order by last_used_at desc nulls last;

-- STEP 2. Only when step 1 shows no client you still need, drop the table.
-- This is permanent. It is commented out on purpose.
-- drop table if exists oauth_clients;
