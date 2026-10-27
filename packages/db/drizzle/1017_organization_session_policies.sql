-- deployment-mode: rolling
-- One session policy per organization: whether people may attach files in its
-- workspaces' sessions, and which generic tool families (shell, codemode,
-- browser, computerUse) its sessions never receive. An embedding host that
-- governs the organization writes it through a host command; the fork stores
-- the governed default the first time it sees a governed organization. No row
-- means no restriction, which is every stock organization.
--
-- Additive only. Previous binaries never read this table; it enables and
-- forces RLS with an organization policy, so the previous binary's
-- runtime-posture evaluator accepts it during the rolling gap. Ordinal 1016 is
-- held by a sibling branch of the same release bundle.
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
CREATE POLICY account_isolation ON organization_session_policies
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
REVOKE ALL ON organization_session_policies FROM PUBLIC;
DO $organization_session_policies_runtime_grant$
BEGIN
  -- Role provisioning grants every configured runtime role; this covers the
  -- default role during the rolling gap before provisioning runs.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON organization_session_policies TO opengeni_app;
  END IF;
END
$organization_session_policies_runtime_grant$;
