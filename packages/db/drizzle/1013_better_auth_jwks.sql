-- deployment-mode: rolling
-- Signing keys of Better Auth's jwt plugin for the opt-in host session token
-- (OPENGENI_HOST_TOKEN_AUDIENCE). The plugin creates the first key on first use
-- and only reads and inserts rows; previous binaries never read this table.
-- Private keys are stored encrypted with OPENGENI_BETTER_AUTH_SECRET.
--
-- The keys are deployment-wide, like every other auth_* table. The table still
-- enables and forces RLS, with one deployment-wide policy, because a rolling
-- release must keep the previous binary's runtime-posture readiness green: that
-- evaluator accepts an unknown table with runtime DML only when it is securely
-- shaped (RLS enabled, forced and with a policy). A non-RLS table with runtime
-- DML would need a withheld-grant release first.
SET LOCAL lock_timeout = '5s';

CREATE TABLE auth_jwks (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);
ALTER TABLE auth_jwks ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_jwks FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_jwks_deployment_keys ON auth_jwks USING (true) WITH CHECK (true);
REVOKE ALL ON auth_jwks FROM PUBLIC;
DO $auth_jwks_runtime_grant$
BEGIN
  -- Role provisioning grants every configured runtime role; this covers the
  -- default role during the rolling gap before provisioning runs.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON auth_jwks TO opengeni_app;
  END IF;
END
$auth_jwks_runtime_grant$;
