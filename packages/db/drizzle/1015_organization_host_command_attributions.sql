-- deployment-mode: rolling
-- Who asked for each host command (organization governance port). A host
-- command runs an existing membership, invitation or workspace-access operation
-- with the service token's subject as the database actor, so the operation's own
-- receipt and lifecycle event stay byte-for-byte what they are today. This row,
-- keyed by the same (organization, operation id), names the host's acting
-- external user and the service principal next to that receipt.
--
-- Rows are append-only and written before the operation, so every host-made
-- receipt has one. A replay of the operation id must name the same command and
-- acting user. Previous binaries never read this table; it enables and forces
-- RLS with an organization policy, so the previous binary's runtime-posture
-- evaluator accepts it during the rolling gap.
SET LOCAL lock_timeout = '5s';

CREATE TABLE organization_host_command_attributions (
  account_id uuid NOT NULL REFERENCES managed_accounts (id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  mutation text NOT NULL CHECK (mutation ~ '^[a-z_]+(\.[a-z_]+)+$' AND char_length(mutation) <= 64),
  service_subject_id text NOT NULL CHECK (octet_length(service_subject_id) BETWEEN 1 AND 1024),
  service_initiator_subject_id text NOT NULL
    CHECK (octet_length(service_initiator_subject_id) BETWEEN 1 AND 1024),
  acting_external_source text NOT NULL
    CHECK (octet_length(acting_external_source) BETWEEN 1 AND 200),
  acting_external_id text NOT NULL CHECK (octet_length(acting_external_id) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, operation_id)
);
ALTER TABLE organization_host_command_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_host_command_attributions FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON organization_host_command_attributions
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
REVOKE ALL ON organization_host_command_attributions FROM PUBLIC;
DO $organization_host_command_attributions_runtime_grant$
BEGIN
  -- Role provisioning grants every configured runtime role; this covers the
  -- default role during the rolling gap before provisioning runs.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON organization_host_command_attributions TO opengeni_app;
  END IF;
END
$organization_host_command_attributions_runtime_grant$;
