-- deployment-mode: rolling
-- Re-authentication and TOTP for managed browser sessions
-- (OPENGENI_MANAGED_AUTH_TOTP_ENABLED and the host session token).
--
-- auth_users.two_factor_enabled and auth_two_factors are the storage of Better
-- Auth's twoFactor plugin, which runs only when TOTP is enabled. Secrets and
-- backup codes are stored encrypted with OPENGENI_BETTER_AUTH_SECRET.
-- auth_session_authentications records each successful re-authentication of a
-- session; the host session token's auth_time and amr come from its latest row,
-- or from the session's own sign-in when it has none. Rows are append-only and
-- leave with their session.
--
-- Previous binaries never read these tables or the new column. Both tables
-- enable and force RLS with one deployment-wide policy, like auth_jwks (1013),
-- so the previous binary's runtime-posture evaluator accepts them during the
-- rolling gap.
SET LOCAL lock_timeout = '5s';

ALTER TABLE auth_users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE auth_two_factors (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES auth_users (id) ON DELETE CASCADE,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  -- Product column, not the plugin's: the TOTP time step of the last accepted
  -- code, so one code is never accepted twice.
  last_used_counter bigint
);
ALTER TABLE auth_two_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_two_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_two_factors_deployment_factors ON auth_two_factors USING (true) WITH CHECK (true);
REVOKE ALL ON auth_two_factors FROM PUBLIC;

CREATE TABLE auth_session_authentications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_session_id text NOT NULL REFERENCES auth_sessions (id) ON DELETE CASCADE,
  amr text[] NOT NULL CHECK (
    cardinality(amr) BETWEEN 1 AND 3 AND amr <@ ARRAY['pwd', 'oauth', 'otp']::text[]
  ),
  authenticated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_session_authentications_latest
  ON auth_session_authentications (auth_session_id, authenticated_at DESC);
ALTER TABLE auth_session_authentications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session_authentications FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_session_authentications_deployment_events ON auth_session_authentications
  USING (true) WITH CHECK (true);
REVOKE ALL ON auth_session_authentications FROM PUBLIC;

DO $managed_auth_reauthentication_runtime_grant$
BEGIN
  -- Role provisioning grants every configured runtime role; this covers the
  -- default role during the rolling gap before provisioning runs.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_two_factors TO opengeni_app;
    GRANT SELECT, INSERT ON auth_session_authentications TO opengeni_app;
  END IF;
END
$managed_auth_reauthentication_runtime_grant$;
