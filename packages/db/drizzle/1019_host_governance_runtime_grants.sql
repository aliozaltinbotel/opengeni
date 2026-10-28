-- deployment-mode: rolling
-- Grants what 1016, 1017 and 1018 withheld, now that the previous release
-- knows these routines (its runtime posture accepts them granted or
-- withheld): runtime EXECUTE on the host's lookup of a native identity in its
-- organization, the host's ensure of its own owner membership and the host's
-- write of its organization's session policy. Readiness requires them from
-- this release on, and the "not yet" paths that answered while they were
-- withheld are gone. CREATE OR REPLACE in 1017 kept 1016's routine ungranted,
-- so all three are granted here.
--
-- It also grants the personal-machine owner lookup (0978) and the
-- connected-command re-arm (0984), which the previous release knows as well
-- (it withholds them too, and accepts them either way). Their callers keep
-- checking the grant first, as they run inside transactions a permission
-- error would abort.
--
-- Every configured application role gets them, as provisioning does.
DO $host_governance_runtime_grants$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.lookup_organization_host_identity(uuid, text, uuid), '
        || 'opengeni_private.ensure_organization_host_owner(uuid, text, uuid), '
        || 'opengeni_private.put_host_organization_session_policy('
        || 'uuid, text, uuid, text, text, text[], text, bigint), '
        || 'opengeni_private.session_machine_owner_subject_v1(uuid, uuid, uuid), '
        || 'opengeni_private.rearm_unanswered_connected_commands(uuid, uuid, text) TO %I',
      application_role
    );
  END LOOP;
END $host_governance_runtime_grants$;
