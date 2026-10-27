-- deployment-mode: rolling
-- An embedding host provisions an organization with bootstrapWorkspace for one
-- service subject and then runs its host commands and reads as that subject,
-- which the membership fences check like any administrator (an active owner
-- or admin). bootstrapWorkspace wrote only the subject's workspace grant, so
-- every host command and read of such an organization was refused.
--
-- opengeni_private.ensure_organization_host_owner() makes the calling subject
-- the active owner of the calling organization (both must equal the caller's
-- own account and subject context), once: when the subject already has a
-- membership there it changes nothing, and refuses (55000) unless that
-- membership is already an active owner, so it never promotes or reactivates
-- anyone. The subject must own one of the organization's workspaces, which is
-- what bootstrapWorkspace leaves for the subject it provisioned the
-- organization for; identity-backed subjects (user:, external_user:) are
-- refused, because their memberships come from invitations and external
-- identities. A new owner is written only for an organization with no
-- membership yet (bootstrapWorkspace, no operation id) or for a host command
-- already recorded in organization_host_command_attributions (1015) as
-- host_owner.ensure by this same service subject under the given operation
-- id, so every owner added to an existing organization is audited. Like every
-- active membership, the new one has its hidden Personal workspace, with no
-- runtime access. It touches no other membership.
--
-- opengeni_private.lookup_organization_host_identity() (1016) also answers,
-- for each membership, its authorization revision and its shared-workspace
-- grants (workspace, grant id, role, permissions and updated_at), the values
-- the change-role and workspace-access commands fence on. updated_at keeps the
-- database's full precision because those fences compare it exactly.
--
-- Both are SECURITY DEFINER, owned by their tables' owner, never PUBLIC. As
-- 0937 explains, the previous release rejects a runtime EXECUTE grant on a
-- definer it doesn't know, so this migration grants nothing: until a later
-- migration grants EXECUTE on the owner routine, bootstrapWorkspace writes no
-- owner and the host's ensure command answers that it is not available yet.
-- The lookup's EXECUTE stays as 1016 left it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.ensure_organization_host_owner(
  p_account_id uuid, p_subject_id text, p_operation_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  membership_row organization_memberships%ROWTYPE;
  personal_id uuid;
  personal_external_id text;
  created boolean := false;
  previous_marker text :=
    pg_catalog.current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_workspace text := pg_catalog.current_setting('opengeni.workspace_id', true);
BEGIN
  IF p_account_id IS NULL
    OR p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_subject_id <> pg_catalog.btrim(p_subject_id)
    OR pg_catalog.length(p_subject_id) NOT BETWEEN 1 AND 1024
    OR pg_catalog.starts_with(p_subject_id, 'user:')
    OR pg_catalog.starts_with(p_subject_id, 'external_user:')
  THEN
    RAISE EXCEPTION 'organization host owner authority is invalid' USING ERRCODE = '42501';
  END IF;
  -- The organization's membership lifecycle lock (0263, 0350, 0797), first.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || p_account_id::text, 0)
  );
  PERFORM 1 FROM managed_accounts account WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  -- The subject the host provisioned the organization for owns one of its
  -- workspaces; no other subject can become its owner here.
  IF NOT EXISTS (
    SELECT 1
    FROM workspace_memberships access
    JOIN workspaces workspace
      ON workspace.id = access.workspace_id
      AND workspace.account_id = access.account_id
    WHERE access.account_id = p_account_id
      AND access.subject_id = p_subject_id
      AND access.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'organization host owner authority is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );

  SELECT * INTO membership_row FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.subject_id = p_subject_id
  FOR UPDATE;
  IF FOUND THEN
    IF membership_row.status <> 'active' OR membership_row.role <> 'owner' THEN
      RAISE EXCEPTION 'organization host owner membership is not an active owner'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF p_operation_id IS NULL THEN
      -- bootstrapWorkspace: only the organization it has just created.
      IF EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
      ) THEN
        RAISE EXCEPTION 'organization host owner needs a recorded host command'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM organization_host_command_attributions attribution
      WHERE attribution.account_id = p_account_id
        AND attribution.operation_id = p_operation_id
        AND attribution.mutation = 'host_owner.ensure'
        AND attribution.service_subject_id = p_subject_id
    ) THEN
      RAISE EXCEPTION 'organization host owner needs a recorded host command'
        USING ERRCODE = '42501';
    END IF;
    personal_external_id := p_account_id::text || ':' || p_subject_id;
    PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
    SELECT workspace.id INTO personal_id FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.external_source = 'opengeni:organization-membership'
      AND workspace.external_id = personal_external_id
    FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO workspaces (account_id, name, external_source, external_id)
      VALUES (
        p_account_id, 'Personal workspace', 'opengeni:organization-membership',
        personal_external_id
      )
      RETURNING id INTO personal_id;
    ELSIF EXISTS (
      SELECT 1 FROM workspace_memberships access WHERE access.workspace_id = personal_id
    ) THEN
      RAISE EXCEPTION 'organization host owner personal workspace already has runtime access'
        USING ERRCODE = '42501';
    END IF;
    PERFORM pg_catalog.set_config('opengeni.workspace_id', personal_id::text, true);
    INSERT INTO workspace_inference_controls (workspace_id, account_id)
    VALUES (personal_id, p_account_id)
    ON CONFLICT DO NOTHING;
    INSERT INTO organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id
    ) VALUES (p_account_id, p_subject_id, 'owner', 'active', personal_id)
    RETURNING * INTO membership_row;
    created := true;
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true
  );
  PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(previous_workspace, ''), true);
  RETURN pg_catalog.jsonb_build_object(
    'membershipId', membership_row.id,
    'subjectId', membership_row.subject_id,
    'created', created
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true
  );
  PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(previous_workspace, ''), true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.ensure_organization_host_owner(uuid, text, uuid)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.lookup_organization_host_identity(
  p_account_id uuid, p_actor_subject_id text, p_identity_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  previous_identity_marker text :=
    pg_catalog.current_setting('opengeni.canonical_human_identity_lifecycle', true);
  previous_tenancy_marker text :=
    pg_catalog.current_setting('opengeni.organization_tenancy_lifecycle', true);
  result jsonb;
BEGIN
  IF p_account_id IS NULL
    OR p_identity_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization host identity lookup authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  PERFORM 1 FROM organization_memberships actor
  WHERE actor.account_id = p_account_id
    AND actor.subject_id = p_actor_subject_id
    AND actor.status = 'active'
    AND actor.role IN ('owner', 'admin');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);

  WITH member AS MATERIALIZED (
    SELECT membership.id, membership.subject_id, membership.status, membership.role,
      membership.authorization_revision, membership.created_at, subject_row.auth_user_id
    FROM canonical_human_identity_subjects subject_row
    JOIN organization_memberships membership
      ON membership.account_id = p_account_id
      AND membership.subject_id = 'user:' || subject_row.auth_user_id
    WHERE subject_row.identity_id = p_identity_id
      AND subject_row.status = 'active'
  ),
  identity_row AS (
    SELECT identity.id, identity.status, binding.id AS binding_id,
      binding.revision AS binding_revision, binding.provider_id, binding.provider_account_id
    FROM canonical_human_identities identity
    LEFT JOIN canonical_human_login_bindings binding
      ON binding.id = identity.active_login_binding_id
      AND binding.identity_id = identity.id
      AND binding.status = 'active'
    WHERE identity.id = p_identity_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'identityStatus', identity_row.status,
    'verifiedEmail', CASE
      WHEN identity_row.binding_id IS NOT NULL THEN (
        -- This organization's member account the active login binding signs
        -- in to: never an account of the identity the organization never had.
        SELECT account_user.email
        FROM member
        JOIN auth_identities account
          ON account.user_id = member.auth_user_id
          AND pg_catalog.lower(account.provider_id) = identity_row.provider_id
          AND account.account_id = identity_row.provider_account_id
        JOIN auth_users account_user ON account_user.id = account.user_id
        WHERE account_user.email_verified
        LIMIT 1
      )
      ELSE (
        -- No active binding: the account of the oldest active membership.
        SELECT account_user.email
        FROM member
        JOIN auth_users account_user ON account_user.id = member.auth_user_id
        WHERE member.status = 'active' AND account_user.email_verified
        ORDER BY member.created_at, member.id
        LIMIT 1
      )
    END,
    'activeLoginBinding', CASE WHEN identity_row.binding_id IS NULL THEN NULL
      ELSE pg_catalog.jsonb_build_object(
        'id', identity_row.binding_id, 'revision', identity_row.binding_revision
      )
    END,
    'memberships', (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', member.id, 'status', member.status, 'role', member.role,
          'authorizationRevision', member.authorization_revision,
          -- The member's grants in this organization's shared workspaces (its
          -- Personal workspaces excluded), as the administration listing and
          -- overview give them (0350).
          'sharedWorkspaceAccess', coalesce((
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'workspaceId', workspace.id,
                'membershipId', access.id,
                'role', opengeni_private.workspace_member_role(access.role, access.permissions),
                'permissions', access.permissions,
                'updatedAt', access.updated_at
              ) ORDER BY pg_catalog.lower(workspace.name), workspace.id
            )
            FROM workspace_memberships access
            JOIN workspaces workspace
              ON workspace.id = access.workspace_id
              AND workspace.account_id = p_account_id
            WHERE access.account_id = p_account_id
              AND access.subject_id = member.subject_id
              AND NOT EXISTS (
                SELECT 1 FROM organization_memberships personal_owner
                WHERE personal_owner.account_id = p_account_id
                  AND personal_owner.personal_workspace_id = workspace.id
              )
          ), '[]'::jsonb)
        )
        ORDER BY member.created_at, member.id
      )
      FROM member
    ),
    'acceptedInvitations', coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', invitation.id,
          'acceptedMembershipId', invitation.accepted_membership_id,
          'acceptedAt', pg_catalog.to_char(
            coalesce(invitation.accepted_at, invitation.updated_at) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        ) ORDER BY invitation.created_at DESC, invitation.id DESC
      )
      FROM member
      -- Acceptance requires the invitation's target to be the accepting
      -- subject, so target_subject_id leads to every accepted invitation.
      JOIN organization_membership_invitations invitation
        ON invitation.target_subject_id = member.subject_id
        AND invitation.account_id = p_account_id
        AND invitation.status = 'accepted'
        AND invitation.accepted_membership_id = member.id
    ), '[]'::jsonb)
  ) INTO result
  FROM identity_row
  WHERE EXISTS (SELECT 1 FROM member);

  PERFORM pg_catalog.set_config(
    'opengeni.canonical_human_identity_lifecycle', coalesce(previous_identity_marker, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_tenancy_marker, ''), true
  );
  RETURN result;
END
$$;
