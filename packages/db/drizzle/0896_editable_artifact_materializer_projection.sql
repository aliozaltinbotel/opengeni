-- deployment-mode: rolling
-- The global materializer's definer must read the two source metadata tables
-- already joined by its claim capability. The login retains no table grants.
-- Keep the exact pinned-source checks; absent source facts fail with 23514,
-- rather than dereferencing a record that was never assigned.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $materializer_projection$
DECLARE
  target regprocedure := 'opengeni_private.validate_editable_artifact_projection()'::regprocedure;
  source text;
  definition text;
  before_facts jsonb;
  after_facts jsonb;
  data_schema name := current_schema();
  migration_owner name := current_user;
  table_name text;
  old_blob_read text := $old$    IF snapshot.id IS NOT NULL THEN
      SELECT * INTO blob FROM editable_artifact_blob_refs candidate
      WHERE candidate.account_id = snapshot.account_id
        AND candidate.workspace_id = snapshot.workspace_id
        AND candidate.artifact_id = snapshot.artifact_id
        AND candidate.id = snapshot.blob_ref_id;
    END IF;$old$;
  new_blob_read text := $new$    SELECT * INTO blob FROM editable_artifact_blob_refs candidate
    WHERE candidate.account_id = snapshot.account_id
      AND candidate.workspace_id = snapshot.workspace_id
      AND candidate.artifact_id = snapshot.artifact_id
      AND candidate.id = snapshot.blob_ref_id;$new$;
BEGIN
  SELECT p.prosrc, pg_catalog.pg_get_functiondef(p.oid),
    jsonb_build_object(
      'owner', p.proowner, 'definer', p.prosecdef,
      'config', p.proconfig, 'acl', p.proacl
    )
  INTO source, definition, before_facts
  FROM pg_catalog.pg_proc p WHERE p.oid = target;
  IF pg_catalog.md5(source) IS DISTINCT FROM 'f20eb83e91a1e0b3363fa928cee79d8a'
    OR before_facts->>'definer' IS DISTINCT FROM 'true'
    OR (before_facts->>'owner')::oid IS DISTINCT FROM
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = migration_owner)
    OR (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = target)
      IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(
          coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
        ) privilege
      WHERE p.oid = target AND privilege.grantee = 0
        AND privilege.privilege_type = 'EXECUTE'
    )
    OR source NOT LIKE '%' || old_blob_read || '%'
    OR (length(source) - length(replace(source, old_blob_read, '')))
      / length(old_blob_read) <> 1
  THEN
    RAISE EXCEPTION '0896 materializer projection preimage changed'
      USING ERRCODE = '55000';
  END IF;

  -- These are the two missing SELECT-only members of 0191's existing owner
  -- policy. No app/materializer login receives direct relation privileges.
  FOREACH table_name IN ARRAY ARRAY[
    'editable_artifacts', 'editable_artifact_snapshots'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = data_schema AND relation.relname = table_name
        AND relation.relowner = (before_facts->>'owner')::oid
        AND relation.relrowsecurity AND relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy policy
      JOIN pg_catalog.pg_class relation ON relation.oid = policy.polrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = data_schema AND relation.relname = table_name
        AND policy.polname = 'editable_artifact_materializer_owner'
    ) THEN
      RAISE EXCEPTION '0896 materializer source policy preimage changed'
        USING ERRCODE = '55000';
    END IF;
    EXECUTE pg_catalog.format(
      'CREATE POLICY editable_artifact_materializer_owner ON %I.%I FOR SELECT '
      || 'USING (current_user = %L)', data_schema, table_name, migration_owner
    );
  END LOOP;

  EXECUTE replace(definition, old_blob_read, new_blob_read);
  SELECT jsonb_build_object(
    'owner', p.proowner, 'definer', p.prosecdef,
    'config', p.proconfig, 'acl', p.proacl
  ) INTO after_facts FROM pg_catalog.pg_proc p WHERE p.oid = target;
  IF after_facts IS DISTINCT FROM before_facts THEN
    RAISE EXCEPTION '0896 materializer projection security metadata changed'
      USING ERRCODE = '55000';
  END IF;
END;
$materializer_projection$;
