-- deployment-mode: rolling
-- 1018's governed_default_insert policy lets the runtime insert exactly the
-- governed default, naming each column it allows. 1020 added `recordings`
-- after it, so the policy did not constrain the new column: a runtime insert
-- could store a governed default with `recordings = 'allowed'` for an
-- organization without a row, and the API reads a stored `allowed` as allowed.
-- The governed default never names recordings (NULL means `denied` for a
-- stored policy), so the policy now requires `recordings IS NULL` too.
--
-- Only narrows what the runtime may insert. Every runtime and routine insert
-- of the governed default (the runtime's ensure, bootstrapWorkspace, 1018's
-- backfill and put_host_organization_session_policy's first insert) leaves
-- `recordings` NULL, in this release and in the previous one, which does not
-- know the column. Recordings are set only by 1020's routine, as an update of
-- the row a host operation wrote. ALTER POLICY replaces the check in place,
-- in one statement, and running it again changes nothing. No existing row is
-- read or rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER POLICY governed_default_insert ON organization_session_policies
  WITH CHECK (
    opengeni_private.account_rls_visible(account_id)
    AND source = 'governed_default'
    AND attachments = 'disabled'
    AND tool_family_mode = 'deny'
    AND tool_families @> ARRAY['shell', 'codemode', 'browser', 'computerUse']::text[]
    AND revision = 1
    AND last_operation_id IS NULL
    AND updated_by_subject_id IS NULL
    AND recordings IS NULL
  );
