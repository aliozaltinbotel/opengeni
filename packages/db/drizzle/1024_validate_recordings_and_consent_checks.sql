-- deployment-mode: rolling
-- Validate the checks that 1020, 1021 and 1022 added NOT VALID, in their own
-- transaction, as 1010 does for 1009's key. Each column was added in the same
-- statement as its check, so every row that existed then holds NULL, and
-- every row written since was checked on write; validation only proves this.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so reads and writes go on
-- while it scans. Validating an already valid check changes nothing, so a
-- second run is a no-op.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60min';

ALTER TABLE organization_session_policies
  VALIDATE CONSTRAINT organization_session_policies_recordings_check;

ALTER TABLE mcp_oauth_authorization_requests
  VALIDATE CONSTRAINT mcp_oauth_authorization_requests_consent_preset_check;
ALTER TABLE mcp_oauth_authorization_codes
  VALIDATE CONSTRAINT mcp_oauth_authorization_codes_consent_preset_check;
ALTER TABLE mcp_oauth_refresh_tokens
  VALIDATE CONSTRAINT mcp_oauth_refresh_tokens_consent_preset_check;
ALTER TABLE mcp_oauth_access_tokens
  VALIDATE CONSTRAINT mcp_oauth_access_tokens_consent_preset_check;

ALTER TABLE mcp_oauth_authorization_requests
  VALIDATE CONSTRAINT mcp_oauth_authorization_requests_tool_set_versions_check;
ALTER TABLE mcp_oauth_authorization_codes
  VALIDATE CONSTRAINT mcp_oauth_authorization_codes_tool_set_versions_check;
ALTER TABLE mcp_oauth_refresh_tokens
  VALIDATE CONSTRAINT mcp_oauth_refresh_tokens_tool_set_versions_check;
ALTER TABLE mcp_oauth_access_tokens
  VALIDATE CONSTRAINT mcp_oauth_access_tokens_tool_set_versions_check;

DO $recordings_and_consent_checks_postflight$
BEGIN
  IF (
    SELECT count(*) FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'c' AND c.convalidated
      AND (c.conrelid, c.conname) IN (
        ('organization_session_policies'::regclass, 'organization_session_policies_recordings_check'),
        ('mcp_oauth_authorization_requests'::regclass, 'mcp_oauth_authorization_requests_consent_preset_check'),
        ('mcp_oauth_authorization_codes'::regclass, 'mcp_oauth_authorization_codes_consent_preset_check'),
        ('mcp_oauth_refresh_tokens'::regclass, 'mcp_oauth_refresh_tokens_consent_preset_check'),
        ('mcp_oauth_access_tokens'::regclass, 'mcp_oauth_access_tokens_consent_preset_check'),
        ('mcp_oauth_authorization_requests'::regclass, 'mcp_oauth_authorization_requests_tool_set_versions_check'),
        ('mcp_oauth_authorization_codes'::regclass, 'mcp_oauth_authorization_codes_tool_set_versions_check'),
        ('mcp_oauth_refresh_tokens'::regclass, 'mcp_oauth_refresh_tokens_tool_set_versions_check'),
        ('mcp_oauth_access_tokens'::regclass, 'mcp_oauth_access_tokens_tool_set_versions_check')
      )
  ) <> 9 THEN
    RAISE EXCEPTION 'RECORDINGS_AND_CONSENT_CHECKS_NOT_VALIDATED' USING ERRCODE = '55000';
  END IF;
END
$recordings_and_consent_checks_postflight$;
