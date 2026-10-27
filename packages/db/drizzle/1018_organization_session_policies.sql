-- deployment-mode: rolling
-- One session policy per organization: whether people may attach files in its
-- workspaces' sessions, and which generic tool families (shell, codemode,
-- browser, computerUse) its sessions never receive. No row means no
-- restriction, which is every stock organization.
--
-- Who may write what:
-- - The runtime may read the policy and may insert exactly the governed
--   default (attachments disabled, all four families denied, revision 1,
--   source governed_default): the row-level INSERT policy refuses anything
--   else, and the runtime has no UPDATE or DELETE. So the runtime can store
--   the default the first time it sees a governed organization, but can never
--   widen, replace or remove a policy.
-- - A host's policy is written only by
--   opengeni_private.put_host_organization_session_policy(), SECURITY DEFINER,
--   for a host command already recorded in organization_host_command_attributions
--   (1015) as session_policy.update by the same service subject under the
--   same operation id. Each operation id keeps a receipt with the policy
--   body's digest: the same id and body replays, the same id with another body
--   is refused (OGSP1), and a write whose expected revision is not the stored
--   one is refused (OGSP2), so a delayed old command never overwrites a newer
--   revision. Expected revision 0 means no host policy yet: nothing stored, or
--   only the governed default.
--
-- As 0937 explains, the previous release rejects a runtime EXECUTE grant on a
-- definer it doesn't know, so this migration grants nothing on the routine:
-- until a later migration grants it, the host's command answers
-- HOST_SESSION_POLICY_UNAVAILABLE and every governed organization keeps the
-- governed default. The receipts table has no runtime privileges at all.
--
-- Additive only. Both tables enable and force RLS with organization policies,
-- so the previous binary's runtime-posture evaluator accepts them during the
-- rolling gap. Ordinals 1016 and 1017 belong to the host identity lookup and
-- host owner (sibling change of the same bundle).
SET LOCAL lock_timeout = '5s';

CREATE TABLE organization_session_policies (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts (id) ON DELETE CASCADE,
  attachments text NOT NULL CHECK (attachments IN ('enabled', 'disabled')),
  tool_family_mode text NOT NULL CHECK (tool_family_mode IN ('deny', 'allow')),
  tool_families text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (
      cardinality(tool_families) <= 4
      AND (cardinality(tool_families) = 0 OR array_ndims(tool_families) = 1)
      AND tool_families <@ ARRAY['shell', 'codemode', 'browser', 'computerUse']::text[]
    ),
  source text NOT NULL CHECK (source IN ('governed_default', 'host')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_operation_id uuid,
  updated_by_subject_id text
    CHECK (updated_by_subject_id IS NULL OR octet_length(updated_by_subject_id) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((source = 'host') = (last_operation_id IS NOT NULL))
);
ALTER TABLE organization_session_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_session_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY account_read ON organization_session_policies
  FOR SELECT
  USING (opengeni_private.account_rls_visible(account_id));
-- Only the governed default can be inserted, by anyone (the host routine
-- inserts it too, then updates it).
CREATE POLICY governed_default_insert ON organization_session_policies
  FOR INSERT
  WITH CHECK (
    opengeni_private.account_rls_visible(account_id)
    AND source = 'governed_default'
    AND attachments = 'disabled'
    AND tool_family_mode = 'deny'
    AND tool_families @> ARRAY['shell', 'codemode', 'browser', 'computerUse']::text[]
    AND revision = 1
    AND last_operation_id IS NULL
    AND updated_by_subject_id IS NULL
  );
-- Updates come from the owner's routine; the runtime has no UPDATE privilege.
CREATE POLICY account_update ON organization_session_policies
  FOR UPDATE
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
REVOKE ALL ON organization_session_policies FROM PUBLIC;
DO $organization_session_policies_runtime_grant$
BEGIN
  -- Role provisioning grants every configured runtime role; this covers the
  -- default role during the rolling gap before provisioning runs.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON organization_session_policies TO opengeni_app;
  END IF;
END
$organization_session_policies_runtime_grant$;

-- One receipt per host operation id: its body digest and the revision it wrote.
CREATE TABLE organization_session_policy_receipts (
  account_id uuid NOT NULL REFERENCES managed_accounts (id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL CHECK (revision >= 1),
  service_subject_id text NOT NULL CHECK (octet_length(service_subject_id) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, operation_id)
);
ALTER TABLE organization_session_policy_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_session_policy_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON organization_session_policy_receipts
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
REVOKE ALL ON organization_session_policy_receipts FROM PUBLIC;

CREATE FUNCTION opengeni_private.put_host_organization_session_policy(
  p_account_id uuid,
  p_subject_id text,
  p_operation_id uuid,
  p_attachments text,
  p_tool_family_mode text,
  p_tool_families text[],
  p_body_digest text,
  p_expected_revision bigint
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  receipt organization_session_policy_receipts%ROWTYPE;
  current_revision bigint;
  current_source text;
  written_revision bigint;
BEGIN
  IF p_account_id IS NULL
    OR p_operation_id IS NULL
    OR p_subject_id IS NULL
    OR p_expected_revision IS NULL
    OR p_expected_revision < 0
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization session policy authority is invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_host_command_attributions attribution
    WHERE attribution.account_id = p_account_id
      AND attribution.operation_id = p_operation_id
      AND attribution.mutation = 'session_policy.update'
      AND attribution.service_subject_id = p_subject_id
  ) THEN
    RAISE EXCEPTION 'organization session policy needs a recorded host command'
      USING ERRCODE = '42501';
  END IF;
  -- One writer per organization at a time.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-session-policy:' || p_account_id::text, 0)
  );
  SELECT * INTO receipt FROM organization_session_policy_receipts r
  WHERE r.account_id = p_account_id AND r.operation_id = p_operation_id;
  IF FOUND THEN
    IF receipt.body_digest <> p_body_digest THEN
      RAISE EXCEPTION 'organization session policy operation id was used for another policy'
        USING ERRCODE = 'OGSP1';
    END IF;
    RETURN pg_catalog.jsonb_build_object('replay', true, 'revision', receipt.revision);
  END IF;
  SELECT p.revision, p.source INTO current_revision, current_source
  FROM organization_session_policies p
  WHERE p.account_id = p_account_id
  FOR UPDATE;
  -- 0 means "no host policy yet": nothing stored, or only the governed
  -- default, which the fork stores on its own whenever it sees the
  -- organization governed (including just before this command).
  IF coalesce(current_revision, 0) <> p_expected_revision
    AND NOT (p_expected_revision = 0 AND current_source = 'governed_default')
  THEN
    RAISE EXCEPTION 'organization session policy revision is not the expected one'
      USING ERRCODE = 'OGSP2';
  END IF;
  IF current_revision IS NULL THEN
    INSERT INTO organization_session_policies (
      account_id, attachments, tool_family_mode, tool_families, source
    ) VALUES (
      p_account_id, 'disabled', 'deny',
      ARRAY['shell', 'codemode', 'browser', 'computerUse']::text[], 'governed_default'
    );
  END IF;
  UPDATE organization_session_policies p SET
    attachments = p_attachments,
    tool_family_mode = p_tool_family_mode,
    tool_families = p_tool_families,
    source = 'host',
    last_operation_id = p_operation_id,
    updated_by_subject_id = p_subject_id,
    revision = p.revision + 1,
    updated_at = pg_catalog.clock_timestamp()
  WHERE p.account_id = p_account_id
  RETURNING p.revision INTO written_revision;
  INSERT INTO organization_session_policy_receipts (
    account_id, operation_id, body_digest, revision, service_subject_id
  ) VALUES (p_account_id, p_operation_id, p_body_digest, written_revision, p_subject_id);
  RETURN pg_catalog.jsonb_build_object('replay', false, 'revision', written_revision);
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.put_host_organization_session_policy(
  uuid, text, uuid, text, text, text[], text, bigint
) FROM PUBLIC;
