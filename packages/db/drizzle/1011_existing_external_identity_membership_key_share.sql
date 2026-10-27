-- deployment-mode: rolling
-- Cendra fork. read_existing_external_identity (1005) fenced the caller's
-- organization membership with FOR UPDATE, the one row lock that conflicts with
-- the FOR KEY SHARE a session-owner foreign-key re-check takes. Upstream 0925
-- moved its own membership fences (including ensure_external_identity, the
-- first-use resolver) to FOR NO KEY UPDATE for exactly this 40P01 deadlock;
-- with first-use membership off, this existing-only resolver is the external
-- identity path on every request from a product's own user. Only the membership
-- row lock changes: the identity row keeps FOR UPDATE, and every check, the
-- lifecycle marker, signature, owner, ACL and settings stay as installed.
-- Pre-image -> patched; exact post-image -> accepted; anything else refuses.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $existing_identity_fence$
DECLARE
  target regprocedure := 'read_existing_external_identity(uuid,text,text)'::regprocedure;
  anchor constant text := E'SELECT * INTO membership_row FROM organization_memberships\n    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR UPDATE;';
  replacement constant text := E'SELECT * INTO membership_row FROM organization_memberships\n    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR NO KEY UPDATE;';
  source text;
  definition text;
  before_facts jsonb;
  after_facts jsonb;
BEGIN
  SELECT p.prosrc, pg_catalog.pg_get_functiondef(p.oid),
    jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'definer', p.prosecdef,
      'config', p.proconfig, 'volatility', p.provolatile)
  INTO source, definition, before_facts
  FROM pg_catalog.pg_proc p WHERE p.oid = target;
  IF pg_catalog.md5(source) = 'fa17db363b2ef1b28dd6c737a6c6aa01' THEN
    RETURN;
  END IF;
  IF pg_catalog.md5(source) IS DISTINCT FROM '64b9520714e4584f5361484f395baefd'
    OR (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
  THEN
    RAISE EXCEPTION 'EXISTING_EXTERNAL_IDENTITY_FENCE_PREIMAGE_DRIFT' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
  SELECT jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'definer', p.prosecdef,
      'config', p.proconfig, 'volatility', p.provolatile)
  INTO after_facts FROM pg_catalog.pg_proc p WHERE p.oid = target;
  IF after_facts IS DISTINCT FROM before_facts THEN
    RAISE EXCEPTION 'EXISTING_EXTERNAL_IDENTITY_FENCE_METADATA_DRIFT' USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = target)
      ~* 'from\s+organization_memberships\M[^;]*\mfor\s+update\M'
  THEN
    RAISE EXCEPTION 'EXISTING_EXTERNAL_IDENTITY_FENCE_STILL_BLOCKS_KEY_CHECKS' USING ERRCODE = '55000';
  END IF;
END
$existing_identity_fence$;
