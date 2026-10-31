-- deployment-mode: rolling
-- Additive host proposal/admission state on the existing short-lived OAuth request.
-- Older writers leave it NULL. Native governed issuance requires exact admission;
-- no credential, code, bearer, connection registry or additional grants are stored.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE mcp_oauth_authorization_requests
  ADD COLUMN host_proposal jsonb,
  ADD COLUMN host_proposal_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN host_proposal_digest text,
  ADD COLUMN host_operation_id uuid,
  ADD COLUMN host_admitted_at timestamptz;
