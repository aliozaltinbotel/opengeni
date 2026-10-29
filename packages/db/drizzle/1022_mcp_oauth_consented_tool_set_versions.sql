-- deployment-mode: rolling
-- The tool-set version each embedding-host tool server published when a person
-- consented an MCP OAuth connection, keyed by server id. The workspace MCP
-- shows a client this beside each server's current version, so the client can
-- ask the person to consent again when a host publishes a changed tool set.
-- The tool identities frozen at consent already keep a changed set from
-- widening the connection; this only makes the change visible.
--
-- Additive only. NULL in every existing row, in rows of a consent made when no
-- host server published a version, and in rows an older binary writes; the API
-- reads NULL as "no consented version". Nothing is rewritten, and no routine
-- reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE mcp_oauth_authorization_requests
  ADD COLUMN tool_set_versions jsonb,
  ADD CONSTRAINT mcp_oauth_authorization_requests_tool_set_versions_check
    CHECK (jsonb_typeof(tool_set_versions) = 'object');

ALTER TABLE mcp_oauth_authorization_codes
  ADD COLUMN tool_set_versions jsonb,
  ADD CONSTRAINT mcp_oauth_authorization_codes_tool_set_versions_check
    CHECK (jsonb_typeof(tool_set_versions) = 'object');

ALTER TABLE mcp_oauth_refresh_tokens
  ADD COLUMN tool_set_versions jsonb,
  ADD CONSTRAINT mcp_oauth_refresh_tokens_tool_set_versions_check
    CHECK (jsonb_typeof(tool_set_versions) = 'object');

ALTER TABLE mcp_oauth_access_tokens
  ADD COLUMN tool_set_versions jsonb,
  ADD CONSTRAINT mcp_oauth_access_tokens_tool_set_versions_check
    CHECK (jsonb_typeof(tool_set_versions) = 'object');
