-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: invitations hold one row per invitation, so the one-time accepted_at copy is small
-- The host identity lookup reads what one organization knows about a native
-- identity, by identity: its active identity subjects, their memberships in
-- the organization and the invitations those memberships accepted.
--
-- organization_membership_invitations.accepted_at records when an invitation
-- was accepted. A BEFORE UPDATE trigger sets it from the accepting write's
-- updated_at, so every writer, the previous release's included, fills it; the
-- copy below fills the invitations accepted before this migration, whose
-- updated_at is their acceptance time because an accepted invitation is never
-- written again (every later invitation write requires status pending). The
-- trigger function is SECURITY INVOKER: it only sets a column of the row it
-- fires for. The previous release never reads the column.
--
-- opengeni_private.lookup_organization_host_identity() is one read for an
-- organization administrator (active owner or admin, under the caller's own
-- account and subject context, like list_organization_members). It answers
-- NULL when no membership of the organization belongs to the identity,
-- whether the identity is unknown or belongs elsewhere. SECURITY DEFINER,
-- owned by its tables' owner, never PUBLIC. As 0937 explains, the previous
-- release rejects a runtime EXECUTE grant on a definer it doesn't know, so this
-- migration grants nothing: until a later migration grants EXECUTE, the
-- runtime resolves the identity through the organization's member list.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_membership_invitations ADD COLUMN accepted_at timestamptz;

ALTER TABLE organization_membership_invitations NO FORCE ROW LEVEL SECURITY;
UPDATE organization_membership_invitations
SET accepted_at = updated_at
WHERE status = 'accepted' AND accepted_at IS NULL;
ALTER TABLE organization_membership_invitations FORCE ROW LEVEL SECURITY;

CREATE FUNCTION opengeni_private.record_organization_invitation_acceptance()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.accepted_at := NEW.updated_at;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.record_organization_invitation_acceptance() FROM PUBLIC;

CREATE TRIGGER organization_invitation_acceptance_time
  BEFORE UPDATE OF status ON organization_membership_invitations
  FOR EACH ROW
  WHEN (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION opengeni_private.record_organization_invitation_acceptance();

CREATE FUNCTION opengeni_private.lookup_organization_host_identity(
  p_account_id uuid, p_actor_subject_id text, p_identity_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  previous_identity_marker text :=
    pg_catalog.current_setting('opengeni.canonical_human_identity_lifecycle', true);
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
      membership.created_at, subject_row.auth_user_id
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
        -- The account the active login binding signs in to.
        SELECT account_user.email
        FROM canonical_human_identity_subjects subject_row
        JOIN auth_identities account
          ON account.user_id = subject_row.auth_user_id
          AND pg_catalog.lower(account.provider_id) = identity_row.provider_id
          AND account.account_id = identity_row.provider_account_id
        JOIN auth_users account_user ON account_user.id = account.user_id
        WHERE subject_row.identity_id = p_identity_id
          AND subject_row.status = 'active'
          AND account_user.email_verified
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
        pg_catalog.jsonb_build_object('id', member.id, 'status', member.status, 'role', member.role)
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
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.lookup_organization_host_identity(uuid, text, uuid)
  FROM PUBLIC;
