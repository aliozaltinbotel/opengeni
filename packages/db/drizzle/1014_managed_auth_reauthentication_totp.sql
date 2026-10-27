-- deployment-mode: rolling
-- Re-authentication and TOTP for managed browser sessions
-- (OPENGENI_MANAGED_AUTH_TOTP_ENABLED and the host session token).
--
-- auth_users.two_factor_enabled and auth_two_factors are the storage of Better
-- Auth's twoFactor plugin, which runs only when TOTP is enabled. Secrets and
-- backup codes are stored encrypted with OPENGENI_BETTER_AUTH_SECRET.
-- auth_session_authentications records every authentication of a session: the
-- password or provider sign-in that created it, each successful
-- re-authentication, and, for a session created from another one (a native app
-- device approved by a browser), the approving session's latest authentication.
-- A session's creation time is not authentication evidence. The host session
-- token's auth_time and amr, and every freshness check, come from the latest
-- row. Rows are append-only and leave with their session.
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
  verified boolean NOT NULL DEFAULT false,
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
  -- Exactly one primary method (pwd or oauth), an optional otp, no repeats.
  amr text[] NOT NULL CHECK (
    array_ndims(amr) = 1
    AND amr <@ ARRAY['pwd', 'oauth', 'otp']::text[]
    AND ('pwd' = ANY (amr))::int + ('oauth' = ANY (amr))::int = 1
    AND cardinality(amr) = 1 + ('otp' = ANY (amr))::int
  ),
  authenticated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Orders events that share an authentication time (a second factor added to
  -- an earlier primary sign-in keeps that sign-in's time).
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_session_authentications_latest
  ON auth_session_authentications (auth_session_id, authenticated_at DESC, recorded_at DESC);
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

-- Sign-in method changes need a fresh authentication of the session (at most
-- five minutes old), read from auth_session_authentications instead of the
-- session's creation time: a session created from another session (a native
-- app device) is not a fresh authentication, and a re-authentication is. The
-- body is 0477's with only that check changed.
CREATE OR REPLACE FUNCTION managed_sign_in_method_authority(p_user text, p_session text, p_request jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE identity_row canonical_human_identities%ROWTYPE; stamp jsonb := p_request->'actorFence';
BEGIN
  IF stamp IS NOT NULL AND stamp <> 'null'::jsonb THEN
    IF coalesce((p_request->>'callback')::boolean, false) THEN
      PERFORM managed_auth_actor_mutation_lease_acquire(stamp->>'authorityHash', (stamp->>'actorEpoch')::bigint, (stamp->>'requestId')::uuid, 30);
    END IF;
    PERFORM managed_auth_actor_mutation_fence(stamp->>'authorityHash', (stamp->>'actorEpoch')::bigint, (stamp->>'requestId')::uuid);
  END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  SELECT i.* INTO identity_row FROM canonical_human_identities i
    JOIN canonical_human_identity_subjects s ON s.identity_id = i.id
    WHERE s.auth_user_id = p_user AND s.status = 'active' FOR UPDATE OF i;
  IF NOT FOUND OR identity_row.status <> 'active'
    OR NOT validate_canonical_human_session(p_session, p_user, false) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_AUTHENTICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF identity_row.id IS DISTINCT FROM (p_request->>'expectedIdentityId')::uuid THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_IDENTITY_CHANGED' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_users WHERE id = p_user AND email_verified) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_EMAIL_NOT_VERIFIED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_sessions s
    JOIN auth_session_authentications a ON a.auth_session_id = s.id
    WHERE s.id = p_session AND s.user_id = p_user
      AND a.authenticated_at > clock_timestamp() - interval '5 minutes'
      AND a.authenticated_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF identity_row.identity_revision IS DISTINCT FROM (p_request->>'expectedIdentityRevision')::bigint THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  RETURN identity_row.identity_revision;
END $body$;
REVOKE ALL ON FUNCTION managed_sign_in_method_authority(text,text,jsonb) FROM PUBLIC;
