-- deployment-mode: rolling
-- Restrictive authentication resolves current authority without provisioning or healing.
CREATE FUNCTION read_existing_external_identity(p_account_id uuid, p_source text, p_external_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
DECLARE
  identity_row external_identities%ROWTYPE;
  membership_row organization_memberships%ROWTYPE;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source IS NULL OR char_length(p_source) NOT BETWEEN 1 AND 200
    OR p_external_id IS NULL OR char_length(p_external_id) NOT BETWEEN 1 AND 1024
  THEN RAISE EXCEPTION 'invalid external identity scope' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  -- Match the organization lifecycle -> identity tuple -> row lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account_id::text, 0));
  -- Serialize a tuple without relying on delimiters in opaque host identifiers.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_account_id,p_source,p_external_id)::text, 0));
  SELECT * INTO identity_row FROM external_identities
    WHERE account_id = p_account_id AND source = p_source AND external_id = p_external_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'external identity is unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO membership_row FROM organization_memberships
    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR identity_row.status <> 'active' OR membership_row.status <> 'active'
    OR membership_row.subject_id IS DISTINCT FROM identity_row.subject_id
    OR membership_row.personal_workspace_id IS DISTINCT FROM identity_row.personal_workspace_id
  THEN RAISE EXCEPTION 'external identity is unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RETURN jsonb_build_object('id', identity_row.id, 'accountId', identity_row.account_id,
    'source', identity_row.source, 'externalId', identity_row.external_id,
    'subjectId', identity_row.subject_id, 'organizationMembershipId', identity_row.organization_membership_id,
    'personalWorkspaceId', identity_row.personal_workspace_id, 'status', identity_row.status,
    'authorizationRevision', identity_row.authorization_revision);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION read_existing_external_identity(uuid,text,text) FROM PUBLIC;
