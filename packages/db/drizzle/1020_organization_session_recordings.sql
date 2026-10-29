-- deployment-mode: rolling
-- Whether people may record meetings and send recorded or dictated audio to a
-- transcription provider in an organization's workspaces. Recordings reach the
-- model as text, so for a governed organization they are a third entry path
-- beside uploads and message attachments, and the session policy (1018) now
-- carries a setting for them.
--
-- Additive only. `recordings` is NULL in every existing row and in every row
-- the runtime's governed default inserts (1018's INSERT policy names the
-- columns it allows; a NULL here keeps it valid). The API reads NULL as the
-- default for the row's source: a stored policy (governed default or host)
-- means `denied`, no row means `allowed`. Nothing existing is rewritten.
--
-- Who may write it: only a host, through
-- opengeni_private.set_host_organization_session_recordings(), SECURITY
-- DEFINER, right after 1018's put_host_organization_session_policy() in the
-- same host command: it sets the column on the row that this exact operation id
-- wrote (source host, last_operation_id), for an operation recorded in
-- organization_host_command_attributions (1015) as session_policy.update by the
-- same service subject. A command that does not name recordings never calls
-- it, and the stored setting stays as it was.
--
-- As 0937 explains, the previous release rejects a runtime EXECUTE grant on a
-- definer it doesn't know, so this migration grants nothing on the routine:
-- until a later migration grants it, a host command that names recordings
-- answers HOST_SESSION_POLICY_UNAVAILABLE and writes nothing, and every other
-- host command is unchanged.
--
-- Ordinal 1019 belongs to a sibling change (the grant release that follows
-- 1016-1018); this migration takes the next free ordinal.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_session_policies
  ADD COLUMN recordings text
    CHECK (recordings IS NULL OR recordings IN ('allowed', 'denied'));

CREATE FUNCTION opengeni_private.set_host_organization_session_recordings(
  p_account_id uuid,
  p_subject_id text,
  p_operation_id uuid,
  p_recordings text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  written_revision bigint;
BEGIN
  IF p_account_id IS NULL
    OR p_operation_id IS NULL
    OR p_subject_id IS NULL
    OR p_recordings IS NULL
    OR p_recordings NOT IN ('allowed', 'denied')
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization session recordings authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_host_command_attributions attribution
    WHERE attribution.account_id = p_account_id
      AND attribution.operation_id = p_operation_id
      AND attribution.mutation = 'session_policy.update'
      AND attribution.service_subject_id = p_subject_id
  ) THEN
    RAISE EXCEPTION 'organization session recordings need a recorded host command'
      USING ERRCODE = '42501';
  END IF;
  -- 1018's writer lock: the policy row this operation wrote cannot change
  -- under this update.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-session-policy:' || p_account_id::text, 0)
  );
  UPDATE organization_session_policies p SET recordings = p_recordings
  WHERE p.account_id = p_account_id
    AND p.source = 'host'
    AND p.last_operation_id = p_operation_id
  RETURNING p.revision INTO written_revision;
  IF written_revision IS NULL THEN
    RAISE EXCEPTION 'organization session policy was not written by this operation'
      USING ERRCODE = 'OGSP3';
  END IF;
  RETURN pg_catalog.jsonb_build_object('revision', written_revision);
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.set_host_organization_session_recordings(
  uuid, text, uuid, text
) FROM PUBLIC;
