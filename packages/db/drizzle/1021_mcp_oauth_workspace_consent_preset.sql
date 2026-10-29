-- deployment-mode: rolling
-- The access level a person chose when consenting a workspace MCP OAuth
-- connection: Read only, Full or Custom, as an organization connection's
-- access setting already records it. The level's effect is already in the
-- grant (its permissions are narrowed to the level and its tool identities
-- frozen accordingly); this column only names the level, so a host reading the
-- connection's consent scope sees the preset instead of having to infer it.
--
-- Additive only. NULL in every existing row, in every organization
-- connection's rows (their preset lives in organization_access) and in rows an
-- older binary writes; the API reads NULL as "no recorded level". Nothing is
-- rewritten, and no routine reads or writes it.
--
-- Ordinal 1019 belongs to a sibling change and 1020 is the session
-- recordings setting; this migration takes the next free ordinal.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Each check is added NOT VALID, so adding it scans no rows (every existing
-- row holds NULL); 1024 validates them in their own transaction.
ALTER TABLE mcp_oauth_authorization_requests
  ADD COLUMN consent_preset text,
  ADD CONSTRAINT mcp_oauth_authorization_requests_consent_preset_check
    CHECK (consent_preset IN ('read_only', 'full', 'custom')) NOT VALID;

ALTER TABLE mcp_oauth_authorization_codes
  ADD COLUMN consent_preset text,
  ADD CONSTRAINT mcp_oauth_authorization_codes_consent_preset_check
    CHECK (consent_preset IN ('read_only', 'full', 'custom')) NOT VALID;

ALTER TABLE mcp_oauth_refresh_tokens
  ADD COLUMN consent_preset text,
  ADD CONSTRAINT mcp_oauth_refresh_tokens_consent_preset_check
    CHECK (consent_preset IN ('read_only', 'full', 'custom')) NOT VALID;

ALTER TABLE mcp_oauth_access_tokens
  ADD COLUMN consent_preset text,
  ADD CONSTRAINT mcp_oauth_access_tokens_consent_preset_check
    CHECK (consent_preset IN ('read_only', 'full', 'custom')) NOT VALID;
