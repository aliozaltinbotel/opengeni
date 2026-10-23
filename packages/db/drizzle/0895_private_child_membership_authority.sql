-- deployment-mode: rolling
-- Private child creation must observe and lock the exact parent owner's active membership
-- under the installed FORCE-RLS lifecycle owner, including named external Personal owners.
-- No membership, role, policy, capability, actor or caller context is created or widened.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $private_child_owner$
DECLARE
  target regprocedure := 'open_private_child_session_create_capability(uuid,uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure;
  source text;
  definition text;
  before_facts jsonb;
  after_facts jsonb;
  membership_anchor text := $old$  SELECT membership.* INTO owner_membership
  FROM organization_memberships membership
  WHERE membership.id = parent_row.owner_organization_membership_id
    AND membership.account_id = p_account_id
    AND membership.subject_id = parent_row.owner_subject_id
    AND membership.status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'private child session owner authority is no longer active'
      USING ERRCODE = '42501';
  END IF;$old$;
  membership_replacement text := $new$  -- Read only the exact locked parent's owner; no caller-supplied identity is adopted.
  -- Existing lifecycle RLS supplies the protected owner's SELECT and row-lock window.
  DECLARE
    previous_owner_lifecycle text := pg_catalog.current_setting(
      'opengeni.organization_tenancy_lifecycle', true
    );
  BEGIN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', 'session_visibility_activation', true
    );
    SELECT membership.* INTO owner_membership
    FROM organization_memberships membership
    WHERE membership.id = parent_row.owner_organization_membership_id
      AND membership.account_id = p_account_id
      AND membership.subject_id = parent_row.owner_subject_id
      AND membership.status = 'active'
    FOR KEY SHARE;
    -- Check FOUND before restoring the marker: PERFORM changes FOUND.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private child session owner authority is no longer active'
        USING ERRCODE = '42501';
    END IF;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_owner_lifecycle, ''), true
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_owner_lifecycle, ''), true
    );
    RAISE;
  END;$new$;
  personal_anchor text := $old$  IF NOT (
    owner_membership.subject_id LIKE 'user:%'
    AND owner_membership.personal_workspace_id = p_workspace_id
  ) THEN$old$;
BEGIN
  SELECT p.prosrc, pg_catalog.pg_get_functiondef(p.oid),
    jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl)
    INTO source, definition, before_facts FROM pg_catalog.pg_proc p WHERE p.oid=target;
  IF before_facts->>'definer' IS DISTINCT FROM 'true'
    OR (before_facts->>'owner')::oid IS DISTINCT FROM
      (SELECT relowner FROM pg_catalog.pg_class WHERE oid='organization_memberships'::regclass) THEN
    RAISE EXCEPTION '0895 private child authority owner changed' USING ERRCODE='55000';
  END IF;
  IF (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid=target)
      IS DISTINCT FROM ARRAY[pg_catalog.format('search_path=pg_catalog, %I, pg_temp',pg_catalog.current_schema())]
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL
        pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) grant_row
      WHERE p.oid=target AND grant_row.grantee=0 AND grant_row.privilege_type='EXECUTE'
    ) THEN
    RAISE EXCEPTION '0895 private child authority metadata changed' USING ERRCODE='55000';
  END IF;
  IF md5(source)='ab9a765665fbeb27e0b0895a0577f404' THEN RETURN; END IF;
  IF md5(source) IS DISTINCT FROM '9835218483e121ce78bb177e35517b29'
    OR array_length(string_to_array(source,membership_anchor),1)<>2
    OR array_length(string_to_array(source,personal_anchor),1)<>2 THEN
    RAISE EXCEPTION '0895 private child authority pre-image changed' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(replace(definition,membership_anchor,membership_replacement),personal_anchor,
    '  IF owner_membership.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN');
  SELECT jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl)
    INTO after_facts FROM pg_catalog.pg_proc p WHERE p.oid=target;
  IF after_facts IS DISTINCT FROM before_facts
    OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=target) IS DISTINCT FROM 'ab9a765665fbeb27e0b0895a0577f404' THEN
    RAISE EXCEPTION '0895 private child authority post-image changed' USING ERRCODE='55000';
  END IF;
END
$private_child_owner$;
