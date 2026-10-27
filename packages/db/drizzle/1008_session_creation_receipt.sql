-- deployment-mode: rolling
-- Birth proof is written only by new authenticated creation code. No backfill.
-- Fork rule (2026-10-26 sync): first recorded as 0958. Each object is created when absent,
-- accepted when it is exactly this migration's post-image, and refused otherwise.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS creation_receipt jsonb;
DO $column_shape$
BEGIN
  IF (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'sessions'::regclass AND a.attname = 'creation_receipt' AND NOT a.attisdropped)
    IS DISTINCT FROM 'jsonb'
  THEN
    RAISE EXCEPTION 'SESSION_CREATION_RECEIPT_COLUMN_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$column_shape$;
DO $function_preimage$
BEGIN
  IF pg_catalog.to_regprocedure('fence_session_creation_receipt()') IS NOT NULL
    AND (SELECT pg_catalog.md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('fence_session_creation_receipt()'))
      IS DISTINCT FROM 'eedaff47e12b487a701867f5b06e0c59'
  THEN
    RAISE EXCEPTION 'SESSION_CREATION_RECEIPT_FENCE_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$function_preimage$;

CREATE OR REPLACE FUNCTION fence_session_creation_receipt()
RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.creation_receipt IS DISTINCT FROM OLD.creation_receipt THEN
      RAISE EXCEPTION 'session creation receipt is immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  IF NEW.creation_receipt IS NOT NULL THEN
    IF jsonb_typeof(NEW.creation_receipt) IS DISTINCT FROM 'object'
      OR NEW.creation_receipt->>'version' IS DISTINCT FROM '1'
      OR NEW.creation_receipt->>'accountId' IS DISTINCT FROM NEW.account_id::text
      OR NEW.creation_receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.creation_receipt->>'sessionId' IS DISTINCT FROM NEW.id::text
      OR NEW.creation_receipt->>'idempotencyKey' IS DISTINCT FROM NEW.create_idempotency_key
      OR NEW.create_idempotency_key IS NULL
      OR NEW.creation_receipt->>'creatorSubjectId' IS DISTINCT FROM NEW.created_by_subject_id
      OR coalesce(NEW.creation_receipt->>'authenticatedSubjectId','') = ''
      OR coalesce(NEW.creation_receipt->>'authenticatedPrincipalKind','') = ''
      OR coalesce(NEW.creation_receipt->>'requestSha256','') !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'session creation receipt binding mismatch' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION fence_session_creation_receipt() FROM PUBLIC;
DO $trigger_shape$
DECLARE trigger_row record;
BEGIN
  SELECT t.tgfoid, t.tgtype, t.tgattr::text AS tgattr, t.tgenabled INTO trigger_row
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'sessions'::regclass AND t.tgname = 'sessions_creation_receipt_immutable' AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER sessions_creation_receipt_immutable
    BEFORE INSERT OR UPDATE OF creation_receipt, id, account_id, workspace_id, created_by_subject_id, create_idempotency_key ON sessions
    FOR EACH ROW EXECUTE FUNCTION fence_session_creation_receipt();
  ELSIF trigger_row.tgfoid IS DISTINCT FROM 'fence_session_creation_receipt()'::regprocedure::oid
    OR trigger_row.tgtype <> 23 OR trigger_row.tgenabled <> 'O'
    OR trigger_row.tgattr IS DISTINCT FROM (
      SELECT pg_catalog.string_agg(a.attnum::text, ' ' ORDER BY u.ordinal)
      FROM unnest(ARRAY['creation_receipt','id','account_id','workspace_id','created_by_subject_id','create_idempotency_key']::name[]) WITH ORDINALITY u(attname, ordinal)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = 'sessions'::regclass AND a.attname = u.attname
    )
  THEN
    RAISE EXCEPTION 'SESSION_CREATION_RECEIPT_TRIGGER_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$trigger_shape$;
