-- deployment-mode: rolling
-- Birth proof is written only by new authenticated creation code. No backfill.
ALTER TABLE sessions ADD COLUMN creation_receipt jsonb;

CREATE FUNCTION fence_session_creation_receipt()
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
CREATE TRIGGER sessions_creation_receipt_immutable
BEFORE INSERT OR UPDATE OF creation_receipt, id, account_id, workspace_id, created_by_subject_id, create_idempotency_key ON sessions
FOR EACH ROW EXECUTE FUNCTION fence_session_creation_receipt();
